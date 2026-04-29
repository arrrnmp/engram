import { z } from "zod";
import type { EngramChroma } from "../chroma.js";
import type { Config } from "../config.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { formatEngram, toSlug, Vault } from "../vault.js";
import { generateAndApplyWikilinks } from "../wikilinks.js";

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
});

export type SaveMemoryInput = z.infer<typeof SaveMemoryInput>;

export async function saveMemory(
  input: SaveMemoryInput,
  vault: Vault,
  chroma: EngramChroma,
  embedder: EmbeddingProvider,
  config: Config
) {
  const id = crypto.randomUUID();
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const filename = `${toSlug(input.title)}.md`;
  const wikiPath = `${date}/${toSlug(input.title)}`;

  // Embed once — reused for wikilink search and ChromaDB indexing.
  const embedding = await embedder.embed(input.content);
  const wikilinks = await generateAndApplyWikilinks(
    id, wikiPath, embedding, vault, chroma,
    config.wikilinks.threshold,
    config.wikilinks.maxLinks
  );

  vault.writeEngram(date, input.title, formatEngram(id, input.abstract, input.title, date, input.content, wikilinks, input.type));

  // Index in ChromaDB.
  await chroma.upsert(
    {
      id,
      content: input.content,
      title: input.title,
      date,
      filename,
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
    type: input.type,
    wikilinks,
    message: `Engram saved: ${filename} [${id}]${input.type ? ` (type: ${input.type})` : ""}${wikilinks.length > 0 ? ` (${wikilinks.length} related memories linked)` : ""}`,
  };
}
