# Spec: O(n²) Clustering Mitigation

## Problem

`dilucidate/cluster.ts` fetches all embeddings from ChromaDB and computes cosine similarity between every pair:

```typescript
for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) {
    const sim = cosineSimilarity(items[i].embedding, items[j].embedding);
    if (sim >= threshold) edges.set(edgeKey(i, j), sim);
  }
}
```

**Complexity:** O(n²) pairs × O(d) per similarity = O(n²d), where d = embedding dimension (4096 for Qwen3).

| Engrams (n) | Pairs | Time (est. @200ns/pair) |
|-------------|-------|------------------------|
| 100 | 4,950 | < 1ms |
| 500 | 124,750 | ~25ms |
| 1,000 | 499,500 | ~100ms |
| 5,000 | 12,497,500 | ~2.5s |
| 10,000 | 49,995,000 | ~10s |

Additionally, `getAllWithEmbeddings()` pulls the full embedding matrix from ChromaDB — at 5,000 engrams × 4096 floats × 4 bytes = **80 MB** transferred over the local socket.

The problem is not critical today (most vaults stay under 1,000 engrams for years) but the combination of data transfer + compute makes `/dilucidate` noticeably slow at scale.

## Solution: Neighbor-List Graph Construction

Instead of fetching all embeddings and computing all pairs, use ChromaDB's own HNSW index to find each engram's nearest neighbors. This converts O(n²) pairwise computation into O(n × k) individual searches, where k is a fixed small constant (e.g. 15).

### Algorithm

```
for each engram E in the vault:
  neighbors = chroma.search(E.embedding, k=15, exclude_self=true)
  for each neighbor N where similarity >= threshold:
    add edge (E, N, similarity) to adjacency graph

Run BFS connected-components on the adjacency graph.
```

The graph construction and BFS are identical to the current approach — only the edge-finding step changes.

### Why This Works

Cosine similarity at threshold 0.72 means two engrams are meaningfully related. At this threshold, the relevant neighborhood of any engram is small and well-contained. In practice:
- A highly connected engram might have 5–10 similar neighbors above 0.72.
- ChromaDB's HNSW index finds all of them in the top-15 results with very high recall (~99% at k=15 for typical embedding distributions).
- Engrams further than 15th-nearest are almost certainly below threshold.

The result is an **approximate** graph — a tiny fraction of edges at the threshold boundary may be missed — but cluster quality is unaffected for any reasonable threshold ≥ 0.65.

## Implementation

### New method in `EngramChroma`: `searchByEmbedding()`

The existing `search()` method takes a query embedding. We can reuse it directly — each engram's stored embedding is passed as the query.

```typescript
// In chroma.ts
async searchByEmbedding(
  queryEmbedding: number[],
  nResults: number,
  excludeId: string,
  dateRange?: { from?: string; to?: string }
): Promise<Array<{ id: string; similarity: number; date: string; filename: string; title: string }>> {
  const results = await this.search(queryEmbedding, nResults + 1, dateRange); // +1 to account for self
  return results
    .filter((r) => r.id !== excludeId)
    .slice(0, nResults)
    .map((r) => ({ id: r.id, similarity: r.similarity, date: r.date, filename: r.filename, title: r.title }));
}
```

### Modified `clusterMemories()` in `dilucidate/cluster.ts`

**Current approach (fetch all embeddings):**
```typescript
const items = await chroma.getAllWithEmbeddings(dateRange);
// pairwise loop...
```

**New approach (neighbor search per engram):**
```typescript
// Step 1: Get all engram IDs and their embeddings (still needed for BFS input).
// But instead of pairwise, do per-engram neighbor search.
const items = await chroma.getAllWithEmbeddings(dateRange); // still needed for IDs

const edges = new Map<string, number>(); // edgeKey → similarity

for (const item of items) {
  const neighbors = await chroma.searchByEmbedding(
    item.embedding,
    K_NEIGHBORS,   // e.g. 15
    item.id,
    dateRange
  );
  for (const neighbor of neighbors) {
    if (neighbor.similarity < threshold) continue;
    const key = edgeKey(item.id, neighbor.id);
    if (!edges.has(key)) {
      edges.set(key, neighbor.similarity);
    }
  }
}

// BFS connected-components — identical to current code.
```

### Hybrid Threshold

To avoid the overhead of n individual ChromaDB queries for small vaults (where O(n²) is trivial), apply the new approach only above a crossover point:

```typescript
const CROSSOVER = 300; // engrams

if (items.length <= CROSSOVER) {
  // Current O(n²) approach — fast enough, exact.
} else {
  // Neighbor-search approach — approximate, scalable.
}
```

At 300 engrams: 44,850 pairs ≈ 9ms. The crossover adds no complexity for users and avoids n=300 × k=15 = 4,500 ChromaDB round-trips for vaults where the pairwise approach is already negligible.

## Data Transfer Improvement

The current approach pulls full embeddings (4096 floats each) for all engrams in one call. The neighbor-search approach still needs embeddings to use as search queries — so the same data is transferred, just used differently.

The real win on data transfer comes from a separate optimization: **store embeddings in a local SQLite cache** so the re-fetch on each `/dilucidate` run is eliminated. This is out of scope for this spec.

## Missing Links Detection

The current `missingLinks` detection checks all pairs within a cluster for:
1. Pairs that are directly similar (above threshold) but lack a wikilink

With the neighbor-search approach, "directly similar" is now defined as "appeared in each other's top-k results above threshold" rather than "pairwise similarity above threshold." The meaning is equivalent for all practical purposes.

The `hasWikilink()` check and BFS logic remain unchanged.

## Performance Estimate (New Approach)

| Engrams | ChromaDB searches | Time (est.) |
|---------|------------------|-------------|
| 300 | 300 × k=15 | ~150ms |
| 1,000 | 1,000 × k=15 | ~500ms |
| 5,000 | 5,000 × k=15 | ~2.5s |
| 10,000 | 10,000 × k=15 | ~5s |

ChromaDB HNSW search is sub-linear (O(log n) per query), so real times are better than the linear estimate above.

## When to Implement

When the vault approaches 1,000 engrams and `/dilucidate` runtime becomes noticeable. The crossover flag makes this safe to ship early — small vaults use the exact O(n²) path, large vaults get the approximate neighbor-search path automatically.
