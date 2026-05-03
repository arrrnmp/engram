import { describe, test, expect } from "bun:test";
import { EngramChroma, buildWhere, truncate } from "../chroma.js";
import type { Config } from "../config.js";

describe("buildWhere", () => {
  test("returns undefined when no filters", () => {
    expect(buildWhere()).toBeUndefined();
  });

  test("open date range with $gte only", () => {
    expect(buildWhere({ from: "2026-01-01" })).toEqual({ date: { $gte: "2026-01-01" } });
  });

  test("open date range with $lte only", () => {
    expect(buildWhere({ to: "2026-12-31" })).toEqual({ date: { $lte: "2026-12-31" } });
  });

  test("closed date range wraps in $and", () => {
    expect(buildWhere({ from: "2026-01-01", to: "2026-12-31" })).toEqual({
      $and: [{ date: { $gte: "2026-01-01" } }, { date: { $lte: "2026-12-31" } }],
    });
  });

  test("type filter uses $eq", () => {
    expect(buildWhere(undefined, "idea")).toEqual({ type: { $eq: "idea" } });
  });

  test("combined date + type wraps in $and", () => {
    expect(buildWhere({ from: "2026-01-01" }, "idea")).toEqual({
      $and: [{ date: { $gte: "2026-01-01" } }, { type: { $eq: "idea" } }],
    });
  });

  test("closed date + type wraps in $and", () => {
    expect(buildWhere({ from: "2026-01-01", to: "2026-12-31" }, "chat")).toEqual({
      $and: [
        { $and: [{ date: { $gte: "2026-01-01" } }, { date: { $lte: "2026-12-31" } }] },
        { type: { $eq: "chat" } },
      ],
    });
  });
});

describe("truncate", () => {
  test("returns text unchanged when within limit", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  test("truncates and appends ellipsis when over limit", () => {
    expect(truncate("hello world", 5)).toBe("hello…");
  });

  test("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });

  test("handles exact limit length", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });
});

describe("EngramChroma", () => {
  const config: Config = {
    chroma: { host: "http://localhost:8000", collection: "test-engrams" },
    vault: { path: "/tmp/test-vault" },
    server: { port: 7384 },
    watcher: { enabled: true, libreOfficePath: "libreoffice" },
    embedding: {},
    wikilinks: {},
  };

  function createChromaWithMockCollection(mockCollection: any): EngramChroma {
    const chroma = new EngramChroma(config);
    (chroma as any).collection = mockCollection;
    return chroma;
  }

  // ── patchMetadata ──────────────────────────────────────────────────────────

  test("patchMetadata merges patch into existing metadata", async () => {
    const mockCollection = {
      get: async () => ({
        ids: ["abc"],
        metadatas: [{ title: "Old", relativePath: "old.md" }],
      }),
      update: async (args: any) => {
        expect(args.ids).toEqual(["abc"]);
        expect(args.metadatas[0]).toEqual({ title: "New", relativePath: "new.md", filename: "new.md" });
      },
    };

    const chroma = createChromaWithMockCollection(mockCollection);
    await chroma.patchMetadata("abc", { relativePath: "new.md", filename: "new.md", title: "New" });
  });

  test("patchMetadata skips when id not in collection", async () => {
    let updateCalled = false;
    const mockCollection = {
      get: async () => ({ ids: [], metadatas: [] }),
      update: async () => { updateCalled = true; },
    };

    const chroma = createChromaWithMockCollection(mockCollection);
    await chroma.patchMetadata("missing", { title: "x" });
    expect(updateCalled).toBe(false);
  });

  // ── search ─────────────────────────────────────────────────────────────────

  test("search converts cosine distance to similarity", async () => {
    const mockCollection = {
      query: async () => ({
        ids: [["abc"]],
        distances: [[0.2]],
        metadatas: [[{ title: "T", date: "2026-04-29", filename: "t.md", relativePath: "2026-04-29/t.md" }]],
        documents: [["content"]],
      }),
    };

    const chroma = createChromaWithMockCollection(mockCollection);
    const results = await chroma.search(Array(10).fill(0.1), 5);

    expect(results).toHaveLength(1);
    expect(results[0].similarity).toBe(0.8); // 1 - 0.2
  });

  test("search provides fallbacks for missing fields", async () => {
    const mockCollection = {
      query: async () => ({
        ids: [["abc"]],
        distances: [[0]],
        metadatas: [[{}]],
        documents: [[""]],
      }),
    };

    const chroma = createChromaWithMockCollection(mockCollection);
    const results = await chroma.search(Array(10).fill(0.1), 5);

    expect(results[0].title).toBe("abc");
    expect(results[0].date).toBe("");
    expect(results[0].filename).toBe("");
    expect(results[0].relativePath).toBe("/");
    expect(results[0].similarity).toBe(1);
  });

  test("search passes where clause for date range and type", async () => {
    let capturedQuery: any;
    const mockCollection = {
      query: async (args: any) => {
        capturedQuery = args;
        return { ids: [[]], distances: [[]], metadatas: [[]], documents: [[]] };
      },
    };

    const chroma = createChromaWithMockCollection(mockCollection);
    await chroma.search(Array(10).fill(0.1), 5, { from: "2026-01-01", to: "2026-12-31" }, "idea");

    expect(capturedQuery.where).toBeDefined();
    expect(capturedQuery.nResults).toBe(5);
  });

  // ── getAllWithEmbeddings ───────────────────────────────────────────────────

  test("getAllWithEmbeddings filters out empty embeddings", async () => {
    const mockCollection = {
      get: async () => ({
        ids: ["a", "b", "c"],
        embeddings: [[0.1], [], [0.2]],
        metadatas: [
          { title: "A", date: "2026-04-29", filename: "a.md", relativePath: "a.md" },
          { title: "B", date: "2026-04-29", filename: "b.md", relativePath: "b.md" },
          { title: "C", date: "2026-04-29", filename: "c.md", relativePath: "c.md" },
        ],
      }),
    };

    const chroma = createChromaWithMockCollection(mockCollection);
    const results = await chroma.getAllWithEmbeddings();

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id)).toEqual(["a", "c"]);
  });

  test("getAllWithEmbeddings filters out null embeddings", async () => {
    const mockCollection = {
      get: async () => ({
        ids: ["a", "b"],
        embeddings: [null, [0.1]],
        metadatas: [
          { title: "A", date: "2026-04-29", filename: "a.md", relativePath: "a.md" },
          { title: "B", date: "2026-04-29", filename: "b.md", relativePath: "b.md" },
        ],
      }),
    };

    const chroma = createChromaWithMockCollection(mockCollection);
    const results = await chroma.getAllWithEmbeddings();

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("b");
  });

  // ── getAll ─────────────────────────────────────────────────────────────────

  test("getAll returns all entries with fallbacks", async () => {
    const mockCollection = {
      get: async () => ({
        ids: ["abc"],
        metadatas: [{ title: "T", date: "2026-04-29", filename: "t.md", relativePath: "t.md" }],
        documents: ["document content"],
      }),
    };

    const chroma = createChromaWithMockCollection(mockCollection);
    const results = await chroma.getAll();

    expect(results).toHaveLength(1);
    expect(results[0].excerpt).toBe("document content");
    expect(results[0].similarity).toBe(1);
  });

  // ── delete ─────────────────────────────────────────────────────────────────

  test("delete calls collection.delete with id", async () => {
    let deletedId: string | undefined;
    const mockCollection = {
      delete: async (args: any) => { deletedId = args.ids[0]; },
    };

    const chroma = createChromaWithMockCollection(mockCollection);
    await chroma.delete("abc");
    expect(deletedId).toBe("abc");
  });

  // ── getDimensions ──────────────────────────────────────────────────────────

  test("getDimensions returns embedding length when present", async () => {
    const mockCollection = {
      get: async () => ({
        ids: ["abc"],
        embeddings: [Array(2048).fill(0.1)],
      }),
    };

    const chroma = createChromaWithMockCollection(mockCollection);
    const dims = await chroma.getDimensions();
    expect(dims).toBe(2048);
  });

  test("getDimensions returns null for empty collection", async () => {
    const mockCollection = {
      get: async () => ({ ids: [], embeddings: [] }),
    };

    const chroma = createChromaWithMockCollection(mockCollection);
    const dims = await chroma.getDimensions();
    expect(dims).toBeNull();
  });
});
