import { z } from "zod";
import type { EngramChroma } from "../chroma.js";
import type { Config } from "../config.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { formatEngram, toSlug, Vault } from "../vault.js";
import { generateAndApplyWikilinks } from "../wikilinks.js";

export const SaveMemoryInput = z.object({
  title: z.string().min(1).max(128).describe("Short title for this memory"),
  content: z.string().min(1).describe("The memory content in markdown"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("ISO date (YYYY-MM-DD). Defaults to today."),
});

export type SaveMemoryInput = z.infer<typeof SaveMemoryInput>;

export async function saveMemory(
  input: SaveMemoryInput,
  vault: Vault,
  chroma: EngramChroma,
  embedder: EmbeddingProvider,
  config: Config
) {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const filename = `${toSlug(input.title)}.md`;
  const id = vault.engramId(date, filename);

  // Embed once — reused for wikilink search and ChromaDB indexing.
  const embedding = await embedder.embed(input.content);
  const wikilinks = await generateAndApplyWikilinks(
    id, embedding, vault, chroma,
    config.wikilinks.threshold,
    config.wikilinks.maxLinks
  );

  vault.writeEngram(date, input.title, formatEngram(input.title, date, input.content, wikilinks));

  // Index in ChromaDB.
  await chroma.upsert(
    {
      id,
      content: input.content,
      title: input.title,
      date,
      filename,
      vaultPath: vault.root,
    },
    embedding
  );

  return {
    id,
    date,
    filename,
    wikilinks,
    message: `Engram saved: ${date}/${filename}${wikilinks.length > 0 ? ` (${wikilinks.length} related memories linked)` : ""}`,
  };
}
