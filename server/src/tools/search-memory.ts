import { z } from "zod";
import type { EngramChroma } from "../chroma.js";
import type { EmbeddingProvider } from "../embeddings/types.js";

export const SearchMemoryInput = z.object({
  query: z.string().min(1).describe("Natural language search query"),
  n_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Number of results to return"),
  date_range: z
    .object({
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Start date (YYYY-MM-DD)"),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("End date (YYYY-MM-DD)"),
    })
    .optional(),
  type: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Filter results by memory type (e.g. "code", "chat", "idea", "decision")'),
});

export type SearchMemoryInput = z.infer<typeof SearchMemoryInput>;

export async function searchMemory(
  input: SearchMemoryInput,
  chroma: EngramChroma,
  embedder: EmbeddingProvider
) {
  const embedding = await embedder.embed(input.query);
  const results = await chroma.search(
    embedding,
    input.n_results,
    input.date_range,
    input.type
  );

  return {
    query: input.query,
    results: results.map((r) => ({
      id: r.id,
      title: r.title,
      date: r.date,
      filename: r.filename,
      excerpt: r.excerpt,
      similarity: Math.round(r.similarity * 1000) / 1000,
      ...(r.abstract ? { abstract: r.abstract } : {}),
      ...(r.type ? { type: r.type } : {}),
    })),
    total: results.length,
  };
}
