import { z } from "zod";
import matter from "gray-matter";
import type { EngramChroma } from "../chroma.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { Vault } from "../vault.js";
import type { VaultIndex } from "../vault-index.js";
import { parseEngram, formatEngram, extractWikilinks, updateEngramWikilinks } from "../vault.js";

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

export async function updateEngram(
  input: UpdateEngramInput,
  vault: Vault,
  vaultIndex: VaultIndex,
  chroma: EngramChroma,
  embedder: EmbeddingProvider
) {
  const location = await vaultIndex.resolveWithFallback(input.id, vault.root, chroma);
  if (!location) throw new Error(`Engram not found: ${input.id}`);

  let content = vault.readEngram(location.date, location.filename);
  let tagsAdded = 0;
  let wikilinksAdded = 0;
  let abstractSet = false;
  let contentUpdated = false;

  // ── setAbstract ────────────────────────────────────────────────────────────
  if (input.setAbstract) {
    const parsed = matter(content);
    const escaped = input.setAbstract.replace(/\n/g, " ").trim();
    parsed.data.abstract = escaped;

    const wikilinks = extractWikilinks(content);
    const tags = tagsArray(parsed.data as Record<string, unknown>);
    content = formatEngram(
      stringField(parsed.data.id) ?? input.id,
      escaped,
      stringField(parsed.data.title) ?? "",
      stringField(parsed.data.date) ?? new Date().toISOString().slice(0, 10),
      parsed.content.trim(),
      wikilinks,
      stringField(parsed.data.type),
      tags
    );

    await chroma.patchMetadata(input.id, { abstract: escaped });
    abstractSet = true;
  }

  // ── setContent ─────────────────────────────────────────────────────────────
  if (input.setContent) {
    const parsed = matter(content);
    const existingWikilinks = extractWikilinks(content);
    const tags = tagsArray(parsed.data as Record<string, unknown>);

    content = formatEngram(
      input.id,
      stringField(parsed.data.abstract) ?? "",
      stringField(parsed.data.title) ?? "",
      stringField(parsed.data.date) ?? new Date().toISOString().slice(0, 10),
      input.setContent,
      existingWikilinks,
      stringField(parsed.data.type),
      tags
    );

    const newEmbedding = await embedder.embed(input.setContent);
    await chroma.upsert(
      {
        id: input.id,
        content: input.setContent,
        title: stringField(parsed.data.title) ?? "",
        date: stringField(parsed.data.date) ?? "",
        filename: location.filename,
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
      const wikiPath = `${loc.date}/${loc.filename.replace(/\.md$/, "")}`;
      if (content.includes(`[[${wikiPath}]]`)) continue;
      newPaths.push(wikiPath);
      wikilinksAdded++;
    }
    if (newPaths.length > 0) {
      content = updateEngramWikilinks(content, newPaths);
    }
  }

  vault.updateEngram(location.date, location.filename, content);

  return {
    id: input.id,
    abstractSet,
    contentUpdated,
    tagsAdded,
    wikilinksAdded,
    message: [
      abstractSet ? "abstract set" : null,
      contentUpdated ? "content updated and re-embedded" : null,
      `${tagsAdded} tag(s) added`,
      `${wikilinksAdded} wikilink(s) added`,
    ].filter(Boolean).join(", "),
  };
}
