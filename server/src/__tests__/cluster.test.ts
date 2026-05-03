import { describe, test, expect } from "bun:test";
import { clusterMemories } from "../dilucidate/cluster.js";
import { mockChroma, mockVault, mockVaultIndex } from "./helpers/mocks.js";

// ── cosineSimilarity (tested indirectly) ────────────────────────────────────

describe("cosineSimilarity (via clustering)", () => {
  test("identical vectors produce similarity ~1.0", async () => {
    const vec = [1, 0, 0, 0];
    const chroma = mockChroma({
      allWithEmbeddings: [
        { id: "a", embedding: vec, date: "2026-04-29", filename: "a.md", relativePath: "2026-04-29/a.md", title: "A" },
        { id: "b", embedding: vec, date: "2026-04-29", filename: "b.md", relativePath: "2026-04-29/b.md", title: "B" },
      ],
    });

    // threshold 0.99 — identical vectors should cluster together
    const result = await clusterMemories(chroma, mockVault(), mockVaultIndex(), 0.99, 2);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].engramIds).toContain("a");
    expect(result.clusters[0].engramIds).toContain("b");
  });

  test("orthogonal vectors do not cluster", async () => {
    const chroma = mockChroma({
      allWithEmbeddings: [
        { id: "a", embedding: [1, 0, 0], date: "2026-04-29", filename: "a.md", relativePath: "2026-04-29/a.md", title: "A" },
        { id: "b", embedding: [0, 1, 0], date: "2026-04-29", filename: "b.md", relativePath: "2026-04-29/b.md", title: "B" },
      ],
    });

    const result = await clusterMemories(chroma, mockVault(), mockVaultIndex(), 0.72, 2);
    expect(result.clusters.length).toBe(0); // orthogonal = 0 similarity, no cluster
  });

  test("opposite vectors produce similarity ~-1.0", async () => {
    const chroma = mockChroma({
      allWithEmbeddings: [
        { id: "a", embedding: [1, 0, 0], date: "2026-04-29", filename: "a.md", relativePath: "2026-04-29/a.md", title: "A" },
        { id: "b", embedding: [-1, 0, 0], date: "2026-04-29", filename: "b.md", relativePath: "2026-04-29/b.md", title: "B" },
      ],
    });

    // threshold 0.72 — opposite vectors have similarity -1, should not cluster
    const result = await clusterMemories(chroma, mockVault(), mockVaultIndex(), 0.72, 2);
    expect(result.clusters.length).toBe(0);
  });
});

// ── clusterMemories ─────────────────────────────────────────────────────────

describe("clusterMemories", () => {
  test("returns empty for vault below minSize", async () => {
    const chroma = mockChroma({
      allWithEmbeddings: [
        { id: "a", embedding: [1, 0], date: "2026-04-29", filename: "a.md", relativePath: "2026-04-29/a.md", title: "A" },
      ],
    });

    const result = await clusterMemories(chroma, mockVault(), mockVaultIndex(), 0.72, 3);
    expect(result.clusters).toEqual([]);
    expect(result.totalEngrams).toBe(1);
  });

  test("returns empty for no engrams", async () => {
    const chroma = mockChroma({ allWithEmbeddings: [] });
    const result = await clusterMemories(chroma, mockVault(), mockVaultIndex());
    expect(result.clusters).toEqual([]);
    expect(result.totalEngrams).toBe(0);
  });

  test("forms a single cluster from highly similar engrams", async () => {
    // Three vectors pointing in roughly the same direction
    const base = [0.9, 0.1, 0.0];
    const chroma = mockChroma({
      allWithEmbeddings: [
        { id: "a", embedding: base, date: "2026-04-29", filename: "a.md", relativePath: "2026-04-29/a.md", title: "A" },
        { id: "b", embedding: [0.85, 0.15, 0.0], date: "2026-04-29", filename: "b.md", relativePath: "2026-04-29/b.md", title: "B" },
        { id: "c", embedding: [0.88, 0.12, 0.0], date: "2026-04-29", filename: "c.md", relativePath: "2026-04-29/c.md", title: "C" },
      ],
    });

    const result = await clusterMemories(chroma, mockVault(), mockVaultIndex(), 0.5, 3);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].engramIds.sort()).toEqual(["a", "b", "c"]);
  });

  test("forms separate clusters for dissimilar groups", async () => {
    const chroma = mockChroma({
      allWithEmbeddings: [
        // Group 1: pointing along x-axis
        { id: "a", embedding: [1, 0, 0], date: "2026-04-29", filename: "a.md", relativePath: "2026-04-29/a.md", title: "A" },
        { id: "b", embedding: [0.95, 0.05, 0], date: "2026-04-29", filename: "b.md", relativePath: "2026-04-29/b.md", title: "B" },
        { id: "c", embedding: [0.9, 0.1, 0], date: "2026-04-29", filename: "c.md", relativePath: "2026-04-29/c.md", title: "C" },
        // Group 2: pointing along y-axis
        { id: "d", embedding: [0, 1, 0], date: "2026-04-29", filename: "d.md", relativePath: "2026-04-29/d.md", title: "D" },
        { id: "e", embedding: [0, 0.95, 0.05], date: "2026-04-29", filename: "e.md", relativePath: "2026-04-29/e.md", title: "E" },
        { id: "f", embedding: [0, 0.9, 0.1], date: "2026-04-29", filename: "f.md", relativePath: "2026-04-29/f.md", title: "F" },
      ],
    });

    const result = await clusterMemories(chroma, mockVault(), mockVaultIndex(), 0.72, 3);
    expect(result.clusters.length).toBe(2);

    const ids1 = result.clusters[0].engramIds.sort();
    const ids2 = result.clusters[1].engramIds.sort();
    expect([ids1, ids2].sort()).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });

  test("filters clusters below minSize", async () => {
    // Two similar pairs but each only has 2 members — minSize=3 filters both
    const chroma = mockChroma({
      allWithEmbeddings: [
        { id: "a", embedding: [1, 0], date: "2026-04-29", filename: "a.md", relativePath: "2026-04-29/a.md", title: "A" },
        { id: "b", embedding: [0.95, 0.05], date: "2026-04-29", filename: "b.md", relativePath: "2026-04-29/b.md", title: "B" },
      ],
    });

    const result = await clusterMemories(chroma, mockVault(), mockVaultIndex(), 0.72, 3);
    expect(result.clusters.length).toBe(0);
  });

  test("detects missing wikilinks between cluster members", async () => {
    const base = [0.9, 0.1, 0.0];

    // Mock vault returns content WITHOUT wikilinks — so they'll all be "missing"
    const vault = mockVault({
      readContent: "---\nid: \"x\"\n---\n\nBody with no wikilinks.",
    });

    const resolutions = new Map();
    resolutions.set("a", { relativePath: "2026-04-29/a.md" });
    resolutions.set("b", { relativePath: "2026-04-29/b.md" });
    resolutions.set("c", { relativePath: "2026-04-29/c.md" });
    const vaultIndex = mockVaultIndex({ resolutions });

    const chroma = mockChroma({
      allWithEmbeddings: [
        { id: "a", embedding: base, date: "2026-04-29", filename: "a.md", relativePath: "2026-04-29/a.md", title: "A" },
        { id: "b", embedding: [0.85, 0.15, 0.0], date: "2026-04-29", filename: "b.md", relativePath: "2026-04-29/b.md", title: "B" },
        { id: "c", embedding: [0.88, 0.12, 0.0], date: "2026-04-29", filename: "c.md", relativePath: "2026-04-29/c.md", title: "C" },
      ],
    });

    const result = await clusterMemories(chroma, vault, vaultIndex, 0.5, 3);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].missingLinks.length).toBeGreaterThan(0);
  });

  test("passes date range to chroma.getAllWithEmbeddings", async () => {
    let capturedDateRange: any;
    const chroma = mockChroma();
    chroma.getAllWithEmbeddings = async (dateRange?) => {
      capturedDateRange = dateRange;
      return [];
    };

    await clusterMemories(chroma, mockVault(), mockVaultIndex(), 0.72, 3, "2026-04-01");
    expect(capturedDateRange).toEqual({ from: "2026-04-01" });
  });
});
