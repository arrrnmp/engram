import { z } from "zod";
import type { EngramChroma } from "../chroma.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { LRUEmbeddingCache } from "../embeddings/cache.js";
import type { Vault } from "../vault.js";
import { keywordSearch } from "../search/keyword.js";

const SEMANTIC_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;

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
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date (YYYY-MM-DD)"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date (YYYY-MM-DD)"),
    })
    .optional(),
  type: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Filter results by memory type (e.g. "code", "chat", "idea", "decision")'),
  mode: z
    .enum(["semantic", "keyword", "hybrid"])
    .default("semantic")
    .describe(
      '"semantic" (default): vector similarity only. ' +
      '"keyword": exact term matching via vault scan — best for proper nouns, identifiers, hostnames. ' +
      '"hybrid": weighted merge of both passes (0.7 semantic + 0.3 keyword).'
    ),
});

export type SearchMemoryInput = z.infer<typeof SearchMemoryInput>;

export async function searchMemory(
  input: SearchMemoryInput,
  chroma: EngramChroma,
  embedder: EmbeddingProvider,
  vault: Vault,
  queryCache?: LRUEmbeddingCache
) {
  const mode = input.mode ?? "semantic";
  const n = input.n_results ?? 5;

  // ── Semantic pass (skipped for keyword-only mode) ─────────────────────────
  let semanticResults: Awaited<ReturnType<typeof chroma.search>> = [];
  if (mode !== "keyword") {
    const cached = queryCache?.get(input.query);
    const embedding = cached ?? await embedder.embed(input.query);
    if (!cached && queryCache) queryCache.set(input.query, embedding);
    // Fetch extra candidates to give the merge step room to work.
    semanticResults = await chroma.search(embedding, n * 2, input.date_range, input.type);
  }

  // ── Keyword pass (skipped for semantic-only mode) ─────────────────────────
  const keywordResults = mode !== "semantic"
    ? keywordSearch(input.query, vault, input.date_range, input.type, n * 2)
    : [];

  // ── Semantic-only (default — output identical to before this change) ───────
  if (mode === "semantic") {
    return {
      query: input.query,
      mode: "semantic",
      results: semanticResults.slice(0, n).map((r) => ({
        id: r.id,
        title: r.title,
        date: r.date,
        filename: r.filename,
        excerpt: r.excerpt,
        similarity: Math.round(r.similarity * 1000) / 1000,
        ...(r.abstract ? { abstract: r.abstract } : {}),
        ...(r.type ? { type: r.type } : {}),
      })),
      total: semanticResults.length,
    };
  }

  // ── Keyword-only ───────────────────────────────────────────────────────────
  if (mode === "keyword") {
    return {
      query: input.query,
      mode: "keyword",
      results: keywordResults.slice(0, n).map((r) => ({
        id: r.id,
        title: r.title,
        date: r.date,
        filename: r.filename,
        excerpt: r.excerpt,
        keywordScore: Math.round(r.score * 1000) / 1000,
        score: Math.round(r.score * 1000) / 1000,
        ...(r.abstract ? { abstract: r.abstract } : {}),
        ...(r.type ? { type: r.type } : {}),
      })),
      total: keywordResults.length,
    };
  }

  // ── Hybrid merge ───────────────────────────────────────────────────────────
  type Entry = { semantic: number; keyword: number; meta: typeof semanticResults[0] | KeywordResult };
  type KeywordResult = (typeof keywordResults)[0];

  const byId = new Map<string, Entry>();

  for (const r of semanticResults) {
    byId.set(r.id, { semantic: r.similarity, keyword: 0, meta: r });
  }
  for (const r of keywordResults) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.keyword = r.score;
    } else {
      byId.set(r.id, { semantic: 0, keyword: r.score, meta: r });
    }
  }

  const merged = [...byId.values()]
    .map(({ semantic, keyword, meta }) => ({
      id: meta.id,
      title: meta.title,
      date: meta.date,
      filename: meta.filename,
      excerpt: meta.excerpt,
      similarity: Math.round(semantic * 1000) / 1000,
      keywordScore: Math.round(keyword * 1000) / 1000,
      score: Math.round((SEMANTIC_WEIGHT * semantic + KEYWORD_WEIGHT * keyword) * 1000) / 1000,
      ...(meta.abstract ? { abstract: meta.abstract } : {}),
      ...(meta.type ? { type: meta.type } : {}),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);

  return {
    query: input.query,
    mode: "hybrid",
    results: merged,
    total: merged.length,
  };
}
