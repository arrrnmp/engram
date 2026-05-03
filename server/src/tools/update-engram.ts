import { z } from "zod";
import { existsSync } from "fs";
import matter from "gray-matter";
import type { EngramChroma } from "../chroma.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { Vault } from "../vault.js";
import type { VaultIndex } from "../vault-index.js";
import { parseEngram, formatEngram, extractWikilinks, updateEngramWikilinks } from "../vault.js";
import { toWikiPath } from "../wikilinks.js";
import { chunkIndexPath } from "./chunk-engram.js";

export const UpdateEngramInput = z.object({
  id: z.string().uuid().describe("Engram UUID (as returned by list_engrams or search_memory)"),
  setAbstract: z
    .string()
    .min(1)
    .optional()
    .describe("Replace the abstract field in frontmatter with this value"),
  setContent: z
    .string()
    .min(1)
    .optional()
    .describe("Replace the body content of the engram and re-embed it in ChromaDB"),
  editContent: z
    .object({
      old_string: z.string().min(1).describe("Exact string to replace. Must appear exactly once in the engram body."),
      new_string: z.string().describe("Replacement string. May be empty to delete old_string."),
    })
    .optional()
    .describe(
      "Patch the engram body with a targeted string replacement. " +
      "old_string must match exactly once. " +
      "Prefer this over setContent when making small edits to a large engram."
    ),
  addTags: z
    .array(z.string().min(1).max(64))
    .optional()
    .describe("Tags to add to frontmatter — merged with any existing tags"),
  addWikilinks: z
    .array(z.string().uuid())
    .optional()
    .describe("UUIDs of other engrams to link to in the Related Memories section"),
});

export type UpdateEngramInput = z.infer<typeof UpdateEngramInput>;

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function tagsArray(data: Record<string, unknown>): string[] {
  return Array.isArray(data.tags) ? data.tags.map(String) : [];
}

function reformatEngram(id: string, raw: string, newBody: string): string {
  const parsed = matter(raw);
  const wikilinks = extractWikilinks(raw);
  const tags = tagsArray(parsed.data as Record<string, unknown>);
  return formatEngram(
    id,
    stringField(parsed.data.abstract) ?? "",
    stringField(parsed.data.title) ?? "",
    stringField(parsed.data.date) ?? new Date().toISOString().slice(0, 10),
    newBody,
    wikilinks,
    stringField(parsed.data.type),
    tags
  );
}

export async function updateEngram(
  input: UpdateEngramInput,
  vault: Vault,
  vaultIndex: VaultIndex,
  chroma: EngramChroma,
  embedder: EmbeddingProvider
) {
  const location = await vaultIndex.resolveWithFallback(input.id, vault.root, chroma);
  if (!location) throw new Error(`Engram not found: ${input.id}`);

  let content = vault.readEngram(location.relativePath);
  let tagsAdded = 0;
  let wikilinksAdded = 0;
  let abstractSet = false;
  let contentUpdated = false;

  // ── setAbstract ────────────────────────────────────────────────────────────
  if (input.setAbstract) {
    const parsed = matter(content);
    const escaped = input.setAbstract.replace(/\n/g, " ").trim();
    parsed.data.abstract = escaped;

    content = reformatEngram(input.id, content, parsed.content.trim());

    await chroma.patchMetadata(input.id, { abstract: escaped });
    abstractSet = true;
  }

  // ── Mutual exclusion ───────────────────────────────────────────────────────
  if (input.setContent && input.editContent) {
    throw new Error("setContent and editContent cannot be used together in the same call.");
  }

  // ── setContent ─────────────────────────────────────────────────────────────
  if (input.setContent) {
    content = reformatEngram(input.id, content, input.setContent);

    const newEmbedding = await embedder.embed(input.setContent, { taskInstruction: "Represent the following document for retrieval: " });
    const parsed = matter(content);
    await chroma.upsert(
      {
        id: input.id,
        content: input.setContent,
        title: stringField(parsed.data.title) ?? "",
        date: stringField(parsed.data.date) ?? "",
        filename: location.relativePath.split("/").pop() ?? "",
        relativePath: location.relativePath,
        vaultPath: vault.root,
        abstract: stringField(parsed.data.abstract),
        type: stringField(parsed.data.type),
      },
      newEmbedding
    );
    contentUpdated = true;
  }

  // ── editContent ────────────────────────────────────────────────────────────
  if (input.editContent) {
    const { body: currentBody } = parseEngram(content);
    const { old_string, new_string } = input.editContent;

    if (!currentBody.includes(old_string)) {
      throw new Error(
        `editContent: old_string not found in engram body. ` +
        `Check for whitespace differences or use read_engram to verify the current content.`
      );
    }

    const firstIdx = currentBody.indexOf(old_string);
    const lastIdx = currentBody.lastIndexOf(old_string);
    if (firstIdx !== lastIdx) {
      throw new Error(
        `editContent: old_string appears more than once in the engram body. ` +
        `Provide more surrounding context to make the match unique.`
      );
    }

    const newBody = currentBody.slice(0, firstIdx) + new_string + currentBody.slice(firstIdx + old_string.length);
    content = reformatEngram(input.id, content, newBody);

    const newEmbedding = await embedder.embed(newBody, { taskInstruction: "Represent the following document for retrieval: " });
    const parsed = matter(content);
    await chroma.upsert(
      {
        id: input.id,
        content: newBody,
        title: stringField(parsed.data.title) ?? "",
        date: stringField(parsed.data.date) ?? "",
        filename: location.relativePath.split("/").pop() ?? "",
        relativePath: location.relativePath,
        vaultPath: vault.root,
        abstract: stringField(parsed.data.abstract),
        type: stringField(parsed.data.type),
      },
      newEmbedding
    );
    contentUpdated = true;
  }

  // ── addTags ────────────────────────────────────────────────────────────────
  if (input.addTags && input.addTags.length > 0) {
    const parsed = matter(content);
    const existing = tagsArray(parsed.data as Record<string, unknown>);
    const merged = Array.from(new Set([...existing, ...input.addTags]));

    const wikilinks = extractWikilinks(content);
    content = formatEngram(
      stringField(parsed.data.id) ?? input.id,
      stringField(parsed.data.abstract) ?? "",
      stringField(parsed.data.title) ?? "",
      stringField(parsed.data.date) ?? new Date().toISOString().slice(0, 10),
      parsed.content.trim(),
      wikilinks,
      stringField(parsed.data.type),
      merged
    );
    tagsAdded = merged.length - existing.length;
  }

  // ── addWikilinks ───────────────────────────────────────────────────────────
  if (input.addWikilinks && input.addWikilinks.length > 0) {
    const newPaths: string[] = [];
    for (const targetId of input.addWikilinks) {
      const loc = vaultIndex.resolve(targetId);
      if (!loc) continue;
      const wikiPath = loc.relativePath.replace(/\.md$/, "");
      if (content.includes(`[[${wikiPath}]]`)) continue;
      newPaths.push(wikiPath);
      wikilinksAdded++;
    }
    if (newPaths.length > 0) {
      content = updateEngramWikilinks(content, newPaths);
    }
  }

  vault.updateEngram(location.relativePath, content);

  const chunksExist = contentUpdated && existsSync(chunkIndexPath(vault.root, input.id));
  const baseMessage = [
    abstractSet ? "abstract set" : null,
    contentUpdated ? "content updated and re-embedded" : null,
    `${tagsAdded} tag(s) added`,
    `${wikilinksAdded} wikilink(s) added`,
  ].filter(Boolean).join(", ");

  return {
    id: input.id,
    abstractSet,
    contentUpdated,
    tagsAdded,
    wikilinksAdded,
    message: chunksExist
      ? `${baseMessage}. Warning: this engram has chunks that are now stale — call chunk_engram with mode "re-embed" to refresh them.`
      : baseMessage,
  };
}
