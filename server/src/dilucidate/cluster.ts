import type { EngramChroma } from "../chroma.js";
import type { Vault } from "../vault.js";
import type { VaultIndex } from "../vault-index.js";

export interface Cluster {
  id: string;
  engramIds: string[];     // UUIDs
  avgSimilarity: number;
  missingLinks: MissingLink[];
}

export interface MissingLink {
  from: string;   // UUID
  to: string;     // UUID
  similarity: number;
}

// Below this count use exact O(n²) pairwise; above it switch to O(n·k) neighbor search.
const CROSSOVER = 300;
// Number of neighbors to fetch per engram in the scalable path.
const K_NEIGHBORS = 15;

export async function clusterMemories(
  chroma: EngramChroma,
  vault: Vault,
  vaultIndex: VaultIndex,
  threshold = 0.72,
  minSize = 3,
  since?: string
): Promise<{ clusters: Cluster[]; totalEngrams: number }> {
  const dateRange = since ? { from: since } : undefined;
  const items = await chroma.getAllWithEmbeddings(dateRange);
  const totalEngrams = items.length;

  if (totalEngrams < minSize) {
    return { clusters: [], totalEngrams };
  }

  const adj = new Map<string, Set<string>>();
  const similarities = new Map<string, number>(); // edgeKey → similarity

  if (items.length <= CROSSOVER) {
    // ── Exact O(n²) pairwise — fast enough for small vaults ─────────────────
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const sim = cosineSimilarity(items[i].embedding, items[j].embedding);
        if (sim >= threshold) {
          const a = items[i].id;
          const b = items[j].id;
          if (!adj.has(a)) adj.set(a, new Set());
          if (!adj.has(b)) adj.set(b, new Set());
          adj.get(a)!.add(b);
          adj.get(b)!.add(a);
          similarities.set(edgeKey(a, b), sim);
        }
      }
    }
  } else {
    // ── Approximate O(n·k) neighbor search — scalable for large vaults ───────
    // Each engram queries ChromaDB for its K_NEIGHBORS nearest neighbors.
    // Edges are only added when similarity >= threshold.
    for (const item of items) {
      const neighbors = await chroma.searchByEmbedding(
        item.embedding,
        K_NEIGHBORS,
        item.id,
        dateRange
      );
      for (const neighbor of neighbors) {
        if (neighbor.similarity < threshold) continue;
        const key = edgeKey(item.id, neighbor.id);
        if (similarities.has(key)) continue; // already seen from the other direction
        if (!adj.has(item.id)) adj.set(item.id, new Set());
        if (!adj.has(neighbor.id)) adj.set(neighbor.id, new Set());
        adj.get(item.id)!.add(neighbor.id);
        adj.get(neighbor.id)!.add(item.id);
        similarities.set(key, neighbor.similarity);
      }
    }
  }

  // ── Connected components via BFS (identical in both paths) ────────────────
  const visited = new Set<string>();
  const clusters: Cluster[] = [];
  let clusterIdx = 0;

  for (const item of items) {
    if (visited.has(item.id)) continue;

    const component: string[] = [];
    const queue = [item.id];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }

    if (component.length < minSize) continue;

    let totalSim = 0;
    let pairCount = 0;
    const missingLinks: MissingLink[] = [];

    // Only check directly-similar pairs (edges above threshold).
    // Transitive members without a direct edge are related via a third engram
    // and are not candidates for wikilinks.
    for (let i = 0; i < component.length; i++) {
      for (let j = i + 1; j < component.length; j++) {
        const sim = similarities.get(edgeKey(component[i], component[j]));
        if (sim === undefined) continue;

        totalSim += sim;
        pairCount++;

        if (!hasWikilink(vault, vaultIndex, component[i], component[j])) {
          missingLinks.push({ from: component[i], to: component[j], similarity: sim });
        }
      }
    }

    clusters.push({
      id: `cluster-${clusterIdx++}`,
      engramIds: component,
      avgSimilarity: pairCount > 0 ? totalSim / pairCount : 0,
      missingLinks,
    });
  }

  return { clusters, totalEngrams };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function hasWikilink(
  vault: Vault,
  vaultIndex: VaultIndex,
  idA: string,
  idB: string
): boolean {
  return isLinked(vault, vaultIndex, idA, idB) || isLinked(vault, vaultIndex, idB, idA);
}

function isLinked(
  vault: Vault,
  vaultIndex: VaultIndex,
  fromId: string,
  toId: string
): boolean {
  const fromLoc = vaultIndex.resolve(fromId);
  const toLoc = vaultIndex.resolve(toId);
  // If we can't resolve a location, assume linked to avoid false-positive noise.
  if (!fromLoc || !toLoc) return true;
  const wikiPath = `${toLoc.date}/${toLoc.filename.replace(/\.md$/, "")}`;
  try {
    return vault.readEngram(fromLoc.date, fromLoc.filename).includes(`[[${wikiPath}]]`);
  } catch {
    return true;
  }
}
