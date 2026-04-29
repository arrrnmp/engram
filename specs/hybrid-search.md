# Spec: Hybrid Keyword + Semantic Search

## Background

Semantic search works by embedding both the query and all stored engrams into the same vector space, then ranking by cosine similarity. This is already what Engram does — searching "async runtime design decisions" finds engrams about concurrency and architecture even if those exact words don't appear.

The limitation: **the embedding model treats all tokens equally at the meaning level, but it flattens proper nouns, identifiers, and rare terms into the same dense space as common words**. A query like `"PROJ-4821"` or `"María"` or `"rack-01.homelab"` may embed to a vector that doesn't strongly resemble the engram containing it — especially if that term appears in a context-sparse sentence. The model learned statistical associations, not string matching.

Semantic search is the right default. Keyword search is the right complement for the minority of queries where the user knows the exact string they saved.

## Problem Statement

`search_memory` today:
1. Embeds the query → `number[]`
2. Queries ChromaDB → returns top-k by cosine similarity
3. Returns results

This misses cases where:
- The query contains a **proper noun** the model hasn't strongly associated with any semantic cluster (a name, a hostname, a ticket number)
- The query is **very short** (1–2 words) and the embedding loses nuance ("María" → generic female-name vector)
- The user remembers the **exact wording** they used when saving and wants to find it by that phrase rather than by meaning
- The relevant engram scores slightly below `n_results` in semantic rank but would score highest on exact match

## Solution: Two-Pass Ranked Merge

Run semantic and keyword passes in parallel, merge the result sets, deduplicate by UUID, and re-rank using a combined score.

### Pass 1 — Semantic (existing)

Unchanged. Embed the query, query ChromaDB, retrieve top `n_results × 2` candidates (extra headroom to account for merging). Returns similarity score ∈ [0, 1].

### Pass 2 — Keyword (new)

A pure in-process text scan of vault files — no ChromaDB involved. Steps:

1. Tokenize the query into terms: split on whitespace and common punctuation, lowercase, remove stop words shorter than 3 characters.
2. For each engram in `vault.listEngrams()`:
   - Check the title (already in memory from `listEngrams`)
   - If any term matches in the title → high signal, add to candidates with a title-match boost
   - For engrams whose title matched or whose abstract contains the term → read the full body via `vault.readEngram()`
   - Otherwise skip full body read (abstract is the cheap filter)
3. Score each candidate with a simple TF-style score: count of distinct query terms found in (title + body), normalized to [0, 1].

The key optimization: **the abstract filters out most engrams before the expensive full-body read**. Only engrams with a matching abstract (or title match) trigger a `readEngram` call.

### Merge & Re-rank

```
for each unique UUID across both result sets:
  semanticScore = result.similarity if found in semantic pass, else 0
  keywordScore  = result.termMatchScore if found in keyword pass, else 0
  finalScore    = (SEMANTIC_WEIGHT × semanticScore) + (KEYWORD_WEIGHT × keywordScore)

sort descending by finalScore
return top n_results
```

Default weights: `SEMANTIC_WEIGHT = 0.7`, `KEYWORD_WEIGHT = 0.3`. These are configurable (see Config section).

A result that ranks #3 semantically (similarity 0.82) and also has 2/3 query terms in its title will outscore a result that ranks #1 semantically (similarity 0.90) but has no keyword match. This is the desired behavior for proper-noun queries.

## API Change

### `search_memory` input — new optional field

```typescript
export const SearchMemoryInput = z.object({
  query: z.string().min(1),
  n_results: z.number().int().min(1).max(20).default(5),
  date_range: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
  type: z.string().optional(),
  mode: z.enum(["semantic", "keyword", "hybrid"]).default("semantic")
    .describe('Search mode. "semantic" (default): vector similarity only. "keyword": exact term matching only. "hybrid": combine both.'),
});
```

`mode` defaults to `"semantic"` — **no behavior change for existing callers**. Skills that know they're searching for a specific identifier can pass `"hybrid"` or `"keyword"` explicitly.

### Output — new field on each result

```typescript
{
  id: string,
  title: string,
  date: string,
  filename: string,
  excerpt: string,
  similarity: number,       // semantic component (0 if keyword-only result)
  keywordScore: number,     // keyword component (0 if semantic-only result)
  score: number,            // final combined score used for ranking
  abstract?: string,
  type?: string,
}
```

## Implementation

### New file: `server/src/search/keyword.ts`

```typescript
import type { Vault } from "../vault.js";

const STOP_WORDS = new Set(["the", "and", "for", "with", "this", "that", "are", "was", "has"]);

export interface KeywordResult {
  id: string;
  title: string;
  date: string;
  filename: string;
  score: number; // 0–1, fraction of query terms matched
  excerpt: string;
  abstract?: string;
  type?: string;
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s\-_.,;:!?()[\]{}]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

export function keywordSearch(
  query: string,
  vault: Vault,
  dateRange?: { from?: string; to?: string },
  type?: string,
  maxResults = 20
): KeywordResult[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const engrams = vault.listEngrams(dateRange);
  const candidates: KeywordResult[] = [];

  for (const e of engrams) {
    if (type && e.type !== type) continue;

    // Cheap first pass: check title and abstract without reading body.
    const titleLower = e.title.toLowerCase();
    const abstractLower = (e.abstract ?? "").toLowerCase();

    const titleMatches = terms.filter((t) => titleLower.includes(t));
    const abstractMatches = terms.filter((t) => abstractLower.includes(t));

    // Skip full body read if nothing matches in title or abstract.
    const cheapHit = titleMatches.length > 0 || abstractMatches.length > 0;
    if (!cheapHit) continue;

    // Full body read for candidates that passed the cheap filter.
    let bodyLower = "";
    try {
      const raw = vault.readEngram(e.date, e.filename);
      // Strip frontmatter for body search.
      const bodyStart = raw.indexOf("\n---\n");
      bodyLower = (bodyStart >= 0 ? raw.slice(bodyStart + 5) : raw).toLowerCase();
    } catch { continue; }

    const bodyMatches = terms.filter((t) => bodyLower.includes(t));
    const allMatched = new Set([...titleMatches, ...bodyMatches]);

    if (allMatched.size === 0) continue;

    // Score: title matches worth 2×, body matches worth 1×, normalized.
    const rawScore = (titleMatches.length * 2 + bodyMatches.length) /
                     (terms.length * 2); // max possible score = all terms in title
    const score = Math.min(rawScore, 1);

    // Build excerpt from first matching region in body.
    const firstTerm = terms.find((t) => bodyLower.includes(t)) ?? terms[0];
    const matchIdx = bodyLower.indexOf(firstTerm);
    const excerptStart = Math.max(0, matchIdx - 60);
    const raw = vault.readEngram(e.date, e.filename);
    const bodyStart = raw.indexOf("\n---\n");
    const body = bodyStart >= 0 ? raw.slice(bodyStart + 5) : raw;
    const excerpt = body.slice(excerptStart, excerptStart + 300).trim();

    candidates.push({
      id: e.id ?? "",
      title: e.title,
      date: e.date,
      filename: e.filename,
      score,
      excerpt: excerpt.length < body.length ? excerpt + "…" : excerpt,
      ...(e.abstract ? { abstract: e.abstract } : {}),
      ...(e.type ? { type: e.type } : {}),
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
```

### Modified `server/src/tools/search-memory.ts`

```typescript
import { keywordSearch } from "../search/keyword.js";

const SEMANTIC_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;

export async function searchMemory(input: SearchMemoryInput, chroma, embedder, vault) {
  const mode = input.mode ?? "semantic";

  // ── Semantic pass ─────────────────────────────────────────────────
  const semanticResults = (mode === "keyword") ? [] :
    await (async () => {
      const embedding = await embedder.embed(input.query);
      return chroma.search(embedding, input.n_results * 2, input.date_range, input.type);
    })();

  // ── Keyword pass ──────────────────────────────────────────────────
  const keywordResults = (mode === "semantic") ? [] :
    keywordSearch(input.query, vault, input.date_range, input.type, input.n_results * 2);

  if (mode === "semantic") {
    // Existing behavior — no change.
    return formatSemanticOnly(semanticResults, input.query, input.n_results);
  }

  if (mode === "keyword") {
    return formatKeywordOnly(keywordResults, input.query, input.n_results);
  }

  // ── Hybrid merge ──────────────────────────────────────────────────
  const byId = new Map<string, { semantic: number; keyword: number; meta: any }>();

  for (const r of semanticResults) {
    byId.set(r.id, { semantic: r.similarity, keyword: 0, meta: r });
  }
  for (const r of keywordResults) {
    if (!r.id) continue;
    const existing = byId.get(r.id);
    if (existing) {
      existing.keyword = r.score;
    } else {
      byId.set(r.id, { semantic: 0, keyword: r.score, meta: r });
    }
  }

  const merged = [...byId.entries()]
    .map(([id, { semantic, keyword, meta }]) => ({
      id,
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
    .slice(0, input.n_results);

  return { query: input.query, mode: "hybrid", results: merged, total: merged.length };
}
```

### `index.ts` — pass `vault` to `searchMemory`

`searchMemory` currently receives `(input, chroma, embedder)`. Add `vault` as a fourth parameter so the keyword pass can read files.

## Config (optional)

```json
{
  "search": {
    "semanticWeight": 0.7,
    "keywordWeight": 0.3
  }
}
```

Add to Zod schema in `config.ts`. If omitted, defaults to 0.7 / 0.3.

## Skill Update

`surface-memories` and `update-important-memory` should stay on `"semantic"` (default). The `"hybrid"` mode is most useful when a user explicitly names something specific. No skill changes required — the default is backward compatible.

If a user adds a skill or agent that does archive lookups by name/ID, it should explicitly pass `mode: "hybrid"`.

## Performance

**Keyword pass cost:**
- `vault.listEngrams()`: O(m) filesystem scan — already fast (reads frontmatter only)
- Abstract filter eliminates most files before `readEngram` is called
- Full body reads only for title/abstract hits — typically 10–20% of vault

At 500 engrams with a 15% hit rate on the abstract filter: ~75 `readEngram` calls, each a single `readFileSync`. On an SSD: ~3ms total. Negligible.

**Semantic pass** is unchanged.

**Merge step** is O(n_results × 2) — trivial.

## When to Implement

When a user explicitly asks for exact-string lookup and semantic search fails them. The `mode` parameter makes this purely additive — existing behavior is unchanged, new capability is opt-in per call.
