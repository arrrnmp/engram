import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import matter from "gray-matter";
import { chunkEngram, chunkText, chunkByParagraph, chunkBySentence, chunkBySize, chunkIndexPath } from "../tools/chunk-engram.js";
import { formatEngram } from "../vault.js";
import { mockChroma, mockEmbedder, mockVault, mockVaultIndex } from "./helpers/mocks.js";

const TEST_ID = "aaaaaaaa-1111-2222-3333-444444444444";

function makeEngramContent(body: string = "Original body content."): string {
  return formatEngram(TEST_ID, "Test abstract", "Test Engram", "2026-04-29", body, [], undefined);
}

describe("chunkByParagraph", () => {
  test("splits on double newlines when content exceeds chunkSize", () => {
    const result = chunkByParagraph("Para 1\n\nPara 2\n\nPara 3", 10);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("Para 1");
    expect(result[1]).toBe("Para 2");
    expect(result[2]).toBe("Para 3");
  });

  test("merges short paragraphs up to chunkSize", () => {
    const result = chunkByParagraph("Short\n\nAlso short", 500);
    expect(result).toHaveLength(1);
  });

  test("splits when adding next paragraph exceeds chunkSize", () => {
    const text = "A\n\n" + "B".repeat(400) + "\n\n" + "C".repeat(400);
    const result = chunkByParagraph(text, 500);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test("handles empty paragraphs", () => {
    const result = chunkByParagraph("Para 1\n\n\n\nPara 2", 10);
    expect(result).toEqual(["Para 1", "Para 2"]);
  });
});

describe("chunkBySentence", () => {
  test("splits on sentence boundaries", () => {
    const result = chunkBySentence("First sentence. Second sentence. Third sentence.", 500);
    expect(result).toEqual(["First sentence. Second sentence. Third sentence."]);
  });

  test("splits when adding next sentence exceeds chunkSize", () => {
    const longSentence = "A".repeat(400) + ".";
    const text = `${longSentence} ${longSentence} ${longSentence}`;
    const result = chunkBySentence(text, 500);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test("handles text without sentence endings", () => {
    const result = chunkBySentence("no punctuation here", 500);
    expect(result).toEqual(["no punctuation here"]);
  });
});

describe("chunkBySize", () => {
  test("splits at fixed sizes", () => {
    const result = chunkBySize("abcdefghij", 5, 0);
    expect(result).toEqual(["abcde", "fghij"]);
  });

  test("overlaps by specified amount", () => {
    const result = chunkBySize("abcdefghij", 5, 2);
    expect(result).toEqual(["abcde", "defgh", "ghij"]);
  });

  test("handles text shorter than chunkSize", () => {
    const result = chunkBySize("abc", 10, 0);
    expect(result).toEqual(["abc"]);
  });
});

describe("chunkText", () => {
  test("dispatches to paragraph separator", () => {
    const result = chunkText("Para 1\n\nPara 2", 10, 50, "paragraph");
    expect(result).toEqual(["Para 1", "Para 2"]);
  });

  test("dispatches to sentence separator", () => {
    const result = chunkText("First sentence. Second sentence.", 500, 50, "sentence");
    expect(result).toHaveLength(1);
  });

  test("dispatches to none (fixed-size) separator", () => {
    const result = chunkText("abcdefghij", 5, 0, "none");
    expect(result).toEqual(["abcde", "fghij"]);
  });
});

describe("chunkIndexPath", () => {
  test("returns path under .engram-chunks", () => {
    expect(chunkIndexPath("/vault", "abc-123")).toBe("/vault/.engram-chunks/abc-123.json");
  });
});

describe("chunkEngram — create mode", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-test-chunk-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

test("creates chunks and writes index file", async () => {
    const body = "First paragraph about testing that is long enough to be a meaningful chunk of text for our retrieval system.\n\nSecond paragraph about chunking that should also be long enough to stand alone as a chunk when splitting.\n\nThird paragraph about retrieval precision and how chunking improves semantic search results.";
    const content = makeEngramContent(body);
    const vault = mockVault({ readContent: content });
    (vault as any).root = dir;

    const resolutions = new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]);
    const vaultIndex = mockVaultIndex({ resolutions });

    const upsertedChunks: unknown[] = [];
    const chroma = mockChroma();
    (chroma as any).upsert = async (record: unknown) => { upsertedChunks.push(record); };

    const result = await chunkEngram(
      { id: TEST_ID, mode: "create", chunkSize: 100, overlap: 20, separator: "none" },
      vault, vaultIndex, chroma, mockEmbedder(),
    );

    expect(result.mode).toBe("create");
    expect(result.totalChunks).toBeGreaterThanOrEqual(3);
    expect(result.chunks.length).toBe(result.totalChunks);
    expect(result.message).toContain("chunks");

    for (const chunk of upsertedChunks as any[]) {
      expect(chunk.type).toBe("chunk");
      expect(chunk.parentEngramId).toBe(TEST_ID);
      expect(chunk.relativePath).toMatch(/^_chunks\//);
    }

    const indexPath = chunkIndexPath(dir, TEST_ID);
    expect(() => readFileSync(indexPath, "utf-8")).not.toThrow();
    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    expect(index).toHaveLength(result.totalChunks);
  });

  test("errors if chunks already exist", async () => {
    const content = makeEngramContent();
    const vault = mockVault({ readContent: content });
    (vault as any).root = dir;

    const resolutions = new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]);
    const vaultIndex = mockVaultIndex({ resolutions });

    const indexPath = chunkIndexPath(dir, TEST_ID);
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, "[]", "utf-8");

    await expect(
      chunkEngram({ id: TEST_ID, mode: "create", chunkSize: 500, overlap: 50, separator: "paragraph" }, vault, vaultIndex, mockChroma(), mockEmbedder()),
    ).rejects.toThrow("Chunks already exist");
  });

  test("errors if engram not found in vault index", async () => {
    const vault = mockVault();
    (vault as any).root = dir;
    const vaultIndex = mockVaultIndex({ resolutions: new Map() });

    await expect(
      chunkEngram({ id: TEST_ID, mode: "create", chunkSize: 500, overlap: 50, separator: "paragraph" }, vault, vaultIndex, mockChroma(), mockEmbedder()),
    ).rejects.toThrow("not found");
  });

  test("respects maxChunks parameter", async () => {
    const body = "A".repeat(200) + "\n\n" + "B".repeat(200) + "\n\n" + "C".repeat(200) + "\n\n" + "D".repeat(200) + "\n\n" + "E".repeat(200);
    const content = makeEngramContent(body);
    const vault = mockVault({ readContent: content });
    (vault as any).root = dir;

    const resolutions = new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]);
    const vaultIndex = mockVaultIndex({ resolutions });

    const result = await chunkEngram(
      { id: TEST_ID, mode: "create", chunkSize: 100, overlap: 20, separator: "none", maxChunks: 2 },
      vault, vaultIndex, mockChroma(), mockEmbedder(),
    );

    expect(result.totalChunks).toBe(2);
  });

  test("errors on empty body", async () => {
    const content = makeEngramContent("");
    const vault = mockVault({ readContent: content });
    (vault as any).root = dir;

    const resolutions = new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]);
    const vaultIndex = mockVaultIndex({ resolutions });

    await expect(
      chunkEngram({ id: TEST_ID, mode: "create", chunkSize: 500, overlap: 50, separator: "paragraph" }, vault, vaultIndex, mockChroma(), mockEmbedder()),
    ).rejects.toThrow("no content to chunk");
  });
});

describe("chunkEngram — re-embed mode", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-test-chunk-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("deletes existing chunks and recreates", async () => {
    const body = "First paragraph long enough that it exceeds the chunk size limit we are setting for this test run.\n\nSecond paragraph also long enough to exceed the chunk size limit we are setting for this test run.";
    const content = makeEngramContent(body);
    const vault = mockVault({ readContent: content });
    (vault as any).root = dir;

    const resolutions = new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]);
    const vaultIndex = mockVaultIndex({ resolutions });

    const indexPath = chunkIndexPath(dir, TEST_ID);
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, JSON.stringify([
      { chunkId: "old-chunk-1", chunkIndex: 0, charCount: 100 },
      { chunkId: "old-chunk-2", chunkIndex: 1, charCount: 100 },
    ]), "utf-8");

    const deletedIds: string[] = [];
    const chroma = mockChroma();
    (chroma as any).delete = async (id: string) => { deletedIds.push(id); };
    (chroma as any).upsert = async () => {};

    const result = await chunkEngram(
      { id: TEST_ID, mode: "re-embed", chunkSize: 80, overlap: 20, separator: "paragraph" },
      vault, vaultIndex, chroma, mockEmbedder(),
    );

    expect(result.mode).toBe("re-embed");
    expect(result.totalChunks).toBeGreaterThanOrEqual(2);
    expect(deletedIds).toContain("old-chunk-1");
    expect(deletedIds).toContain("old-chunk-2");
  });

  test("errors if no existing chunks", async () => {
    const vault = mockVault();
    (vault as any).root = dir;

    await expect(
      chunkEngram({ id: TEST_ID, mode: "re-embed", chunkSize: 500, overlap: 50, separator: "paragraph" }, vault, mockVaultIndex(), mockChroma(), mockEmbedder()),
    ).rejects.toThrow("Use mode \"create\" first");
  });
});