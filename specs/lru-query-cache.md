# Spec: LRU Query Embedding Cache

## Problem

Every `search_memory` call embeds the query from scratch — a round-trip to Ollama that costs 50–200ms. The `surface-memories` skill fires 2–3 queries per conversation turn. If the same topic recurs (which it does — that's the point of memory), those embeddings are recomputed identically each time.

There is no semantic deduplication needed here. The cache key is the **exact query string**: same string → same embedding model → same vector, guaranteed. No staleness is possible unless the embedding model changes, which doesn't happen at runtime.

## Solution

An in-memory LRU (Least Recently Used) cache wrapping `EmbeddingProvider.embed()`. On each call:

1. Check the cache for the exact query string.
2. **Hit** → return the cached `number[]` immediately. Zero latency.
3. **Miss** → call `embedder.embed(query)`, store result, evict the oldest entry if at capacity.

## Implementation

### New file: `server/src/embeddings/cache.ts`

```typescript
export class LRUEmbeddingCache {
  private map = new Map<string, number[]>();
  private readonly maxSize: number;

  constructor(maxSize = 64) {
    this.maxSize = maxSize;
  }

  get(key: string): number[] | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Move to end (most recently used).
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: number[]): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxSize) {
      // Evict the oldest entry (first key in insertion order).
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, value);
  }

  get size(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
}
```

`Map` in JS/V8 preserves insertion order. Delete + re-insert on get moves the entry to the tail, making the head always the LRU entry. No external dependency.

### Integration in `server/src/index.ts`

```typescript
import { LRUEmbeddingCache } from "./embeddings/cache.js";

const queryCache = new LRUEmbeddingCache(config.embedding.queryCacheSize ?? 64);

// Wrap embed calls for search only (save_memory embeds content, not queries — no caching there).
async function embedQuery(text: string): Promise<number[]> {
  const cached = queryCache.get(text);
  if (cached) return cached;
  const embedding = await embedder.embed(text);
  queryCache.set(text, embedding);
  return embedding;
}
```

Pass `embedQuery` instead of `embedder` to `searchMemory`. The `saveMemory` and clustering paths continue using `embedder.embed()` directly — content embeddings are never repeated, so caching them wastes memory.

### Config (optional)

```json
{
  "embedding": {
    "queryCacheSize": 64
  }
}
```

Add `queryCacheSize?: number` to the Zod schema in `config.ts`. Omitting it defaults to 64.

## Cache Sizing

| Size | Memory (approx.) | Use case |
|------|-----------------|----------|
| 32 | ~1 MB | Minimal footprint |
| 64 | ~2 MB | Default — covers a full session's queries |
| 128 | ~4 MB | High-traffic / many concurrent sessions |

Qwen3-Embedding produces 4096-float vectors = 16 KB per entry. 64 entries = ~1 MB. Negligible.

## What Is Not Cached

- `embedder.embed(content)` in `saveMemory` — each save has unique content.
- `embedder.embed(body)` in the re-index pass — one-time startup work.
- `embedder.embedBatch()` — not used in the hot path.

## Invalidation

None needed. The cache is in-process and dies with the server. A server restart (which happens when the model changes) clears it automatically. The embedding model is fixed at startup by hardware detection and config — it cannot change while the server is running.
