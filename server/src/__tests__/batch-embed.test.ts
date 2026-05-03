import { describe, test, expect } from "bun:test";
import { batchEmbedTexts } from "../embeddings/batch.js";
import { mockEmbedder } from "./helpers/mocks.js";

describe("batchEmbedTexts", () => {
  test("returns empty array for empty input", async () => {
    const embedder = mockEmbedder();
    const result = await batchEmbedTexts(embedder, []);
    expect(result).toEqual([]);
  });

  test("embeds single text directly", async () => {
    let called = false;
    const embedder = mockEmbedder({
      embed: async (text) => {
        expect(text).toBe("hello");
        called = true;
        return Array(4096).fill(0.1);
      },
    });
    const result = await batchEmbedTexts(embedder, ["hello"]);
    expect(called).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(Array(4096).fill(0.1));
  });

  test("places all items in single batch when under limits", async () => {
    let batchCallCount = 0;
    const embedder = mockEmbedder({
      embedBatch: async (texts) => {
        batchCallCount++;
        expect(texts).toEqual(["a", "b", "c"]);
        return texts.map((_, i) => Array(4096).fill(i * 0.1));
      },
    });
    const result = await batchEmbedTexts(embedder, ["a", "b", "c"], undefined, {
      batchSize: 10,
      batchMaxChars: 100_000,
    });
    expect(batchCallCount).toBe(1);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(Array(4096).fill(0));
    expect(result[1]).toEqual(Array(4096).fill(0.1));
    expect(result[2]).toEqual(Array(4096).fill(0.2));
  });

  test("splits into multiple batches when over item count limit", async () => {
    const batches: string[][] = [];
    const embedder = mockEmbedder({
      embedBatch: async (texts) => {
        batches.push(texts);
        return texts.map((_, i) => Array(4096).fill(i * 0.1));
      },
    });
    const result = await batchEmbedTexts(embedder, ["a", "b", "c", "d"], undefined, {
      batchSize: 2,
      batchMaxChars: 100_000,
    });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(["a", "b"]);
    expect(batches[1]).toEqual(["c", "d"]);
    expect(result).toHaveLength(4);
  });

  test("splits into multiple batches when over character count limit", async () => {
    const batches: string[][] = [];
    const embedder = mockEmbedder({
      embedBatch: async (texts) => {
        batches.push(texts);
        return texts.map(() => Array(4096).fill(0.1));
      },
    });
    const texts = ["a".repeat(60), "b".repeat(60), "c".repeat(60)];
    const result = await batchEmbedTexts(embedder, texts, undefined, {
      batchSize: 10,
      batchMaxChars: 100,
    });
    expect(batches.length).toBeGreaterThan(1);
    expect(result).toHaveLength(3);
  });

  test("falls back to sequential embed when batch fails", async () => {
    let embedCallCount = 0;
    const embedder = mockEmbedder({
      embedBatch: async () => {
        throw new Error("Batch failed");
      },
      embed: async (text) => {
        embedCallCount++;
        return Array(4096).fill(text.length * 0.01);
      },
    });
    const result = await batchEmbedTexts(embedder, ["hello", "world"], undefined, {
      batchSize: 10,
      batchMaxChars: 100_000,
    });
    expect(embedCallCount).toBe(2);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(Array(4096).fill(0.05));
    expect(result[1]).toEqual(Array(4096).fill(0.05));
  });

  test("all items are embedded even when fallback is needed for middle batch", async () => {
    let batchCount = 0;
    const embedder = mockEmbedder({
      embedBatch: async (texts) => {
        batchCount++;
        if (batchCount === 2) throw new Error("Second batch failed");
        return texts.map((_, i) => Array(4096).fill(i * 0.1));
      },
      embed: async (text) => {
        return Array(4096).fill(text === "c" || text === "d" ? 0.99 : 0.88);
      },
    });
    const result = await batchEmbedTexts(embedder, ["a", "b", "c", "d"], undefined, {
      batchSize: 2,
      batchMaxChars: 100_000,
    });
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual(Array(4096).fill(0));
    expect(result[1]).toEqual(Array(4096).fill(0.1));
    expect(result[2]).toEqual(Array(4096).fill(0.99));
    expect(result[3]).toEqual(Array(4096).fill(0.99));
  });

  test("preserves order of results across multiple batches", async () => {
    const embedder = mockEmbedder({
      embedBatch: async (texts) => {
        return texts.map((t) => Array(4096).fill(t.charCodeAt(0) * 0.001));
      },
    });
    const texts = ["a", "b", "c", "d", "e"];
    const result = await batchEmbedTexts(embedder, texts, undefined, {
      batchSize: 2,
      batchMaxChars: 100_000,
    });
    expect(result).toHaveLength(5);
    expect(result[0][0]).toBeCloseTo("a".charCodeAt(0) * 0.001);
    expect(result[1][0]).toBeCloseTo("b".charCodeAt(0) * 0.001);
    expect(result[2][0]).toBeCloseTo("c".charCodeAt(0) * 0.001);
    expect(result[3][0]).toBeCloseTo("d".charCodeAt(0) * 0.001);
    expect(result[4][0]).toBeCloseTo("e".charCodeAt(0) * 0.001);
  });

  test("ensures at least one item per batch even when first item exceeds char limit", async () => {
    const batches: string[][] = [];
    const embedder = mockEmbedder({
      embedBatch: async (texts) => {
        batches.push(texts);
        return texts.map(() => Array(4096).fill(0.1));
      },
    });
    const texts = ["a".repeat(200), "b"];
    const result = await batchEmbedTexts(embedder, texts, undefined, {
      batchSize: 10,
      batchMaxChars: 100,
    });
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(result).toHaveLength(2);
  });

  test("passes options through to embed and embedBatch", async () => {
    let batchOptions: any;
    let singleOptions: any;
    const embedder = mockEmbedder({
      embedBatch: async (_texts, options) => {
        batchOptions = options;
        return [Array(4096).fill(0.1)];
      },
      embed: async (_text, options) => {
        singleOptions = options;
        return Array(4096).fill(0.2);
      },
    });
    const options = { taskInstruction: "test instruction" };
    await batchEmbedTexts(embedder, ["a", "b"], options, {
      batchSize: 10,
      batchMaxChars: 100_000,
    });
    expect(batchOptions).toEqual(options);
    // Single items bypass batch path; test with batch failure fallback
    const embedder2 = mockEmbedder({
      embedBatch: async () => {
        throw new Error("fail");
      },
      embed: async (_text, options) => {
        singleOptions = options;
        return Array(4096).fill(0.2);
      },
    });
    await batchEmbedTexts(embedder2, ["a"], options, {
      batchSize: 10,
      batchMaxChars: 100_000,
    });
    expect(singleOptions).toEqual(options);
  });
});
