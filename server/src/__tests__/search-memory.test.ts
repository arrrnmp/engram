import { describe, test, expect } from "bun:test";
import { searchMemory, SearchMemoryInput } from "../tools/search-memory.js";
import { LRUEmbeddingCache } from "../embeddings/cache.js";
import { mockChroma, mockEmbedder, mockVault } from "./helpers/mocks.js";

function makeInput(overrides: Partial<z.infer<typeof SearchMemoryInput>> = {}) {
  return {
    query: "test query",
    n_results: 5,
    ...overrides,
  };
}

describe("searchMemory", () => {
  const embedVec = Array(4096).fill(0.01);

  test("returns results from chroma search", async () => {
    const chroma = mockChroma({
      searchResults: [
        {
          id: "abc",
          title: "Test Result",
          date: "2026-04-29",
          filename: "test.md",
          excerpt: "Some excerpt",
          similarity: 0.92,
          abstract: "An abstract",
          type: "idea",
        },
      ],
    });

    const result = await searchMemory(makeInput(), chroma, mockEmbedder());
    expect(result.results.length).toBe(1);
    expect(result.results[0].id).toBe("abc");
    expect(result.results[0].similarity).toBe(0.92);
    expect(result.query).toBe("test query");
  });

  test("returns empty results when chroma finds nothing", async () => {
    const chroma = mockChroma({ searchResults: [] });
    const result = await searchMemory(makeInput(), chroma, mockEmbedder());
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  test("passes date_range and type to chroma", async () => {
    let capturedArgs: any = {};
    const chroma = mockChroma();
    chroma.search = async (emb, n, dateRange, type) => {
      capturedArgs = { emb, n, dateRange, type };
      return [];
    };

    await searchMemory(
      makeInput({ date_range: { from: "2026-01-01", to: "2026-04-29" }, type: "idea" }),
      chroma,
      mockEmbedder()
    );

    expect(capturedArgs.dateRange).toEqual({ from: "2026-01-01", to: "2026-04-29" });
    expect(capturedArgs.type).toBe("idea");
  });

  test("passes n_results to chroma.search", async () => {
    let capturedN: number | undefined;
    const chroma = mockChroma();
    chroma.search = async (_emb, n, _dateRange?, _type?) => {
      capturedN = n;
      return [];
    };

    await searchMemory(makeInput({ n_results: 3 }), chroma, mockEmbedder());
    expect(capturedN).toBe(3);
  });

  test("rounds similarity to 3 decimal places", async () => {
    const chroma = mockChroma({
      searchResults: [
        { id: "x", title: "T", date: "2026-04-29", filename: "t.md", excerpt: "E", similarity: 0.923456 },
      ],
    });

    const result = await searchMemory(makeInput(), chroma, mockEmbedder());
    expect(result.results[0].similarity).toBe(0.923);
  });

  // ── Cache integration ────────────────────────────────────────────────────

  test("uses query cache on repeated queries", async () => {
    let embedCallCount = 0;
    const embedder = mockEmbedder({
      embed: async () => {
        embedCallCount++;
        return embedVec;
      },
    });

    const cache = new LRUEmbeddingCache(64);
    const chroma = mockChroma({ searchResults: [] });

    await searchMemory(makeInput({ query: "same query" }), chroma, embedder, cache);
    expect(embedCallCount).toBe(1);

    await searchMemory(makeInput({ query: "same query" }), chroma, embedder, cache);
    expect(embedCallCount).toBe(1); // cache hit — no second embed call
  });

  test("does not cache when no cache provided", async () => {
    let embedCallCount = 0;
    const embedder = mockEmbedder({
      embed: async () => {
        embedCallCount++;
        return embedVec;
      },
    });

    const chroma = mockChroma({ searchResults: [] });

    await searchMemory(makeInput({ query: "q" }), chroma, embedder);
    await searchMemory(makeInput({ query: "q" }), chroma, embedder);
    expect(embedCallCount).toBe(2); // no cache — embed called twice
  });

  test("different queries both embed and cache separately", async () => {
    let embedCallCount = 0;
    const embedder = mockEmbedder({
      embed: async (text) => {
        embedCallCount++;
        return Array(4096).fill(text.length * 0.001);
      },
    });

    const cache = new LRUEmbeddingCache(64);
    const chroma = mockChroma({ searchResults: [] });

    await searchMemory(makeInput({ query: "alpha" }), chroma, embedder, cache);
    await searchMemory(makeInput({ query: "beta" }), chroma, embedder, cache);
    expect(embedCallCount).toBe(2);

    // Both should be cached now
    await searchMemory(makeInput({ query: "alpha" }), chroma, embedder, cache);
    await searchMemory(makeInput({ query: "beta" }), chroma, embedder, cache);
    expect(embedCallCount).toBe(2); // no new embed calls
  });

  test("includes abstract and type when present", async () => {
    const chroma = mockChroma({
      searchResults: [
        { id: "x", title: "T", date: "2026-04-29", filename: "t.md", excerpt: "E", similarity: 0.9, abstract: "abs", type: "chat" },
      ],
    });

    const result = await searchMemory(makeInput(), chroma, mockEmbedder());
    expect(result.results[0].abstract).toBe("abs");
    expect(result.results[0].type).toBe("chat");
  });

  test("omits abstract and type when absent", async () => {
    const chroma = mockChroma({
      searchResults: [
        { id: "x", title: "T", date: "2026-04-29", filename: "t.md", excerpt: "E", similarity: 0.9 },
      ],
    });

    const result = await searchMemory(makeInput(), chroma, mockEmbedder());
    expect("abstract" in result.results[0]).toBe(false);
    expect("type" in result.results[0]).toBe(false);
  });
});
