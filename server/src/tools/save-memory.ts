import { z } from "zod";
import type { EngramChroma } from "../chroma.js";
import type { Config } from "../config.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { formatEngram, toSlug, Vault } from "../vault.js";
import { generateAndApplyWikilinks } from "../wikilinks.js";
import type { VaultIndex } from "../vault-index.js";
import { sanitizeFolderPath } from "./vault-structure.js";

export const SaveMemoryInput = z.object({
  title: z.string().min(1).max(128).describe("Short title for this memory"),
  abstract: z.string().min(1).describe("A paragraph summarising the engram's key content — enough for a future model to understand what it contains without reading the full body. Should go well beyond the title: include the core facts, decisions, context, and why it matters."),
  content: z.string().min(1).describe("The memory content in markdown"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("ISO date (YYYY-MM-DD). Defaults to today."),
  type: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Category of memory (e.g. "code", "chat", "idea", "decision"). Optional — omit for uncategorized.'),
  folder: z
    .string()
    .max(256)
    .optional()
    .describe(
      "Vault-relative folder path to save this memory in (e.g. \"projects/Engram\" or \"personal\"). " +
      "If omitted, defaults to YYYY-MM-DD/ (today's date). " +
      "The folder is created if it does not exist. " +
      "Call get_vault_structure first to see existing folders."
    ),
});

export type SaveMemoryInput = z.infer<typeof SaveMemoryInput>;

export async function saveMemory(
  input: SaveMemoryInput,
  vault: Vault,
  chroma: EngramChroma,
  embedder: EmbeddingProvider,
  config: Config,
  vaultIndex?: VaultIndex
) {
  const id = crypto.randomUUID();
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const dir = input.folder
    ? sanitizeFolderPath(input.folder, vault.root)
    : date;
  const filename = `${toSlug(input.title)}.md`;
  const relativePath = `${dir}/${filename}`;
  const wikiPath = `${dir}/${toSlug(input.title)}`;

  // Embed once — reused for wikilink search and ChromaDB indexing.
  const embedding = await embedder.embed(input.content, { taskInstruction: "Represent the following document for retrieval: " });
  const wikilinks = await generateAndApplyWikilinks(
    id, wikiPath, embedding, vault, chroma,
    config.wikilinks.threshold,
    config.wikilinks.maxLinks
  );

  vault.writeEngram(dir, input.title, formatEngram(id, input.abstract, input.title, date, input.content, wikilinks, input.type));

  // Register in the vault index immediately to avoid race with save path.
  if (vaultIndex) {
    vaultIndex.set(id, { relativePath });
  }

  // Index in ChromaDB.
  await chroma.upsert(
    {
      id,
      content: input.content,
      title: input.title,
      date,
      filename,
      relativePath,
      vaultPath: vault.root,
      abstract: input.abstract,
      type: input.type,
    },
    embedding
  );

  return {
    id,
    date,
    filename,
    relativePath,
    type: input.type,
    wikilinks,
    message: `Engram saved: ${relativePath} [${id}]${input.type ? ` (type: ${input.type})` : ""}${wikilinks.length > 0 ? ` (${wikilinks.length} related memories linked)` : ""}`,
  };
}
