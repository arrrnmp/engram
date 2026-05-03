import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { upsertMediaFile, deleteMediaFile } from "../watcher.js";
import { MediaCache } from "../media-cache.js";
import { sha256hex } from "../media-processor.js";
import { mockChroma, mockEmbedder, mockEmbedderWithImages } from "./helpers/mocks.js";
import type { Config } from "../config.js";
import { logger } from "../logger.js";

const VAULT_ROOT = "/tmp/test-vault";

const config: Config = {
  watcher: { enabled: true, libreOfficePath: "libreoffice" },
  vault: { path: VAULT_ROOT },
  server: { port: 7384 },
  chroma: { host: "http://localhost:8000" },
  wikilinks: {},
  embedding: {},
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "engram-test-watcher-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ── upsertMediaFile — cache hit ───────────────────────────────────────────────

describe("upsertMediaFile — cache hit", () => {
  test("skips embed when size + mtime match cached entry", async () => {
    const filePath = join(dir, "photo.jpg");
    writeFileSync(filePath, Buffer.from("fake-image-data"));
    const stat = statSync(filePath);

    const cache = new MediaCache(dir);
    cache.set("photo.jpg", {
      hash: "somehash",
      size: stat.size,
      mtime: stat.mtimeMs.toString(),
      chromaIds: ["somehash"],
    });

    let embedCalled = false;
    const embedder = mockEmbedder({ embed: async () => { embedCalled = true; return [0.1]; } });
    const chroma = mockChroma();

    await upsertMediaFile("photo.jpg", filePath, "image/jpeg", VAULT_ROOT, chroma, embedder, cache, config);

    expect(embedCalled).toBe(false);
  });
});

// ── upsertMediaFile — text/plain ──────────────────────────────────────────────

describe("upsertMediaFile — text/plain", () => {
  test("embeds file content as string (not MultimodalInput)", async () => {
    const filePath = join(dir, "note.txt");
    writeFileSync(filePath, "Some important notes here.");

    let capturedEmbedInput: unknown = null;
    const embedder = mockEmbedder({
      embed: async (input) => { capturedEmbedInput = input; return [0.1]; },
    });
    const chroma = mockChroma();
    const cache = new MediaCache(dir);

    await upsertMediaFile("note.txt", filePath, "text/plain", VAULT_ROOT, chroma, embedder, cache, config);

    expect(typeof capturedEmbedInput).toBe("string");
    expect(capturedEmbedInput).toBe("Some important notes here.");
  });

  test("upserts to chroma with text content and correct id", async () => {
    const filePath = join(dir, "note.txt");
    const content = "Notes content.";
    writeFileSync(filePath, content);

    const upsertedRecords: unknown[] = [];
    const chroma = mockChroma();
    (chroma as any).upsert = async (record: unknown) => { upsertedRecords.push(record); };

    const cache = new MediaCache(dir);
    await upsertMediaFile("note.txt", filePath, "text/plain", VAULT_ROOT, chroma, mockEmbedder(), cache, config);

    expect(upsertedRecords).toHaveLength(1);
    const record = upsertedRecords[0] as any;
    expect(record.content).toBe(content);
    expect(record.type).toBe("text/plain");
    expect(record.id).toHaveLength(64); // sha256hex
  });

  test("saves entry to cache after successful upsert", async () => {
    const filePath = join(dir, "note.txt");
    writeFileSync(filePath, "content");

    const cache = new MediaCache(dir);
    await upsertMediaFile("note.txt", filePath, "text/plain", VAULT_ROOT, mockChroma(), mockEmbedder(), cache, config);

    const entry = cache.get("note.txt");
    expect(entry).toBeDefined();
    expect(entry!.chromaIds).toHaveLength(1);
    expect(entry!.size).toBeGreaterThan(0);
    expect(entry!.hash).toHaveLength(64);
  });
});

// ── upsertMediaFile — image / video ───────────────────────────────────────────

describe("upsertMediaFile — image", () => {
  test("embeds with MultimodalInput containing correct mimeType", async () => {
    const filePath = join(dir, "photo.png");
    writeFileSync(filePath, Buffer.from([137, 80, 78, 71])); // PNG magic bytes

    let capturedInput: unknown = null;
    const embedder = mockEmbedderWithImages({
      embed: async (input) => { capturedInput = input; return [0.1]; },
    });

    const cache = new MediaCache(dir);
    await upsertMediaFile("photo.png", filePath, "image/png", VAULT_ROOT, mockChroma(), embedder, cache, config);

    expect(typeof capturedInput).toBe("object");
    expect((capturedInput as any).mimeType).toBe("image/png");
    expect((capturedInput as any).data).toBeInstanceOf(Buffer);
  });

  test("id is sha256 of file bytes", async () => {
    const filePath = join(dir, "img.jpg");
    const bytes = Buffer.from("fake-jpeg");
    writeFileSync(filePath, bytes);
    const expectedId = sha256hex(bytes);

    const upserted: unknown[] = [];
    const chroma = mockChroma();
    (chroma as any).upsert = async (record: unknown) => { upserted.push(record); };

    const cache = new MediaCache(dir);
    await upsertMediaFile("img.jpg", filePath, "image/jpeg", VAULT_ROOT, chroma, mockEmbedderWithImages(), cache, config);

    expect((upserted[0] as any).id).toBe(expectedId);
  });

  test("cache entry chromaIds has exactly one id", async () => {
    const filePath = join(dir, "img.webp");
    writeFileSync(filePath, Buffer.from("webp data"));

    const cache = new MediaCache(dir);
    await upsertMediaFile("img.webp", filePath, "image/webp", VAULT_ROOT, mockChroma(), mockEmbedderWithImages(), cache, config);

    expect(cache.get("img.webp")?.chromaIds).toHaveLength(1);
  });

  test("uses caption as content and abstract when captioning is configured", async () => {
    const filePath = join(dir, "captioned.jpg");
    writeFileSync(filePath, Buffer.from("fake-jpeg"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { content: "A cat sitting on a windowsill" } }],
    });

    try {
      const upserted: unknown[] = [];
      const chroma = mockChroma();
      (chroma as any).upsert = async (record: unknown) => { upserted.push(record); };

      const captionConfig: Config = {
        ...config,
        captioning: { provider: "openai", host: "http://localhost:11434/v1", model: "test-model", prompt: "Describe this image." },
      };

      const cache = new MediaCache(dir);
      await upsertMediaFile("captioned.jpg", filePath, "image/jpeg", VAULT_ROOT, chroma, mockEmbedder(), cache, captionConfig);

      expect((upserted[0] as any).content).toBe("A cat sitting on a windowsill");
      expect((upserted[0] as any).abstract).toBe("A cat sitting on a windowsill");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("logs detected and indexed events around captioning", async () => {
    const filePath = join(dir, "caption-log.jpg");
    writeFileSync(filePath, Buffer.from("fake-jpeg"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { content: "A cat sitting on a windowsill" } }],
    });

    const infoSpy = spyOn(logger, "info").mockImplementation(() => logger);
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => logger);

    try {
      const captionConfig: Config = {
        ...config,
        captioning: { provider: "openai", host: "http://localhost:11434/v1", model: "test-model", prompt: "Describe this image." },
      };
      const cache = new MediaCache(dir);

      await upsertMediaFile("caption-log.jpg", filePath, "image/jpeg", VAULT_ROOT, mockChroma(), mockEmbedderWithImages(), cache, captionConfig);

      const messages = infoSpy.mock.calls.map((call) => String(call[0]));
      const detectedIdx = messages.findIndex((msg) => msg.includes("[watcher] Detected media: caption-log.jpg"));
      const indexedIdx = messages.findIndex((msg) => msg.includes("[watcher] Indexed media: caption-log.jpg"));

      expect(detectedIdx).toBeGreaterThanOrEqual(0);
      expect(indexedIdx).toBeGreaterThan(detectedIdx);
      expect(messages.some((msg) => msg.includes("[watcher] Captioned media: caption-log.jpg"))).toBe(true);
      expect(messages.some((msg) => msg.includes('Indexed media: caption-log.jpg (1 chunk(s)) — "A cat sitting on a windowsill"'))).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("falls back to filename when captioning fails", async () => {
    const filePath = join(dir, "no-caption.jpg");
    writeFileSync(filePath, Buffer.from("fake-jpeg"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Error", { status: 500 });

    try {
      const upserted: unknown[] = [];
      const chroma = mockChroma();
      (chroma as any).upsert = async (record: unknown) => { upserted.push(record); };

      const captionConfig: Config = {
        ...config,
        captioning: { provider: "openai", host: "http://localhost:11434/v1", model: "test-model", prompt: "Describe this image." },
      };

      const cache = new MediaCache(dir);
      await upsertMediaFile("no-caption.jpg", filePath, "image/jpeg", VAULT_ROOT, chroma, mockEmbedderWithImages(), cache, captionConfig);

      expect((upserted[0] as any).content).toBe("no-caption.jpg");
      expect((upserted[0] as any).abstract).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("skips captioning for video files", async () => {
    const filePath = join(dir, "video.mp4");
    writeFileSync(filePath, Buffer.from("fake-video"));

    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalled = true; return Response.json({}); };

    try {
      const captionConfig: Config = {
        ...config,
        captioning: { provider: "openai", host: "http://localhost:11434/v1", model: "test-model", prompt: "Describe this image." },
      };

      const cache = new MediaCache(dir);
      await upsertMediaFile("video.mp4", filePath, "video/mp4", VAULT_ROOT, mockChroma(), mockEmbedder(), cache, captionConfig);

      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── upsertMediaFile — application/pdf ────────────────────────────────────────

describe("upsertMediaFile — application/pdf", () => {
  test("creates two ChromaDB entries per page (image + text)", async () => {
    const filePath = join(dir, "doc.pdf");
    writeFileSync(filePath, Buffer.from("%PDF fake"));

    const fakePng = Buffer.from([1, 2, 3, 4]);
    const upserted: unknown[] = [];
    const chroma = mockChroma();
    (chroma as any).upsert = async (record: unknown) => { upserted.push(record); };

    const cache = new MediaCache(dir);
    await upsertMediaFile("doc.pdf", filePath, "application/pdf", VAULT_ROOT, chroma, mockEmbedderWithImages(), cache, config, { batchSize: 32, batchMaxChars: 100_000 }, false, {
      renderPage: async () => fakePng,
      countPages: async () => 3,
      extractText: async (_path, pageNum) => `Page ${pageNum} text`,
    });

    // 3 pages × 2 entries per page = 6
    expect(upserted).toHaveLength(6);
    const ids = (upserted as any[]).map((r) => r.id);
    expect(ids[0]).toMatch(/-page-0-txt$/);
    expect(ids[1]).toMatch(/-page-0$/);
    expect(ids[2]).toMatch(/-page-1-txt$/);
    expect(ids[3]).toMatch(/-page-1$/);
    expect(ids[4]).toMatch(/-page-2-txt$/);
    expect(ids[5]).toMatch(/-page-2$/);
  });

  test("content and abstract use extracted text when available", async () => {
    const filePath = join(dir, "two.pdf");
    writeFileSync(filePath, Buffer.from("%PDF fake"));

    const upserted: unknown[] = [];
    const chroma = mockChroma();
    (chroma as any).upsert = async (record: unknown) => { upserted.push(record); };

    const cache = new MediaCache(dir);
    await upsertMediaFile("two.pdf", filePath, "application/pdf", VAULT_ROOT, chroma, mockEmbedderWithImages(), cache, config, { batchSize: 32, batchMaxChars: 100_000 }, false, {
      renderPage: async () => Buffer.alloc(4),
      countPages: async () => 2,
      extractText: async (_path, pageNum) => `Important contract terms from page ${pageNum}`,
    });

    // Both entries per page share the same content/abstract
    expect((upserted[0] as any).content).toBe("Important contract terms from page 1");
    expect((upserted[0] as any).abstract).toBe("Important contract terms from page 1");
    expect((upserted[1] as any).content).toBe("Important contract terms from page 1");
    expect((upserted[2] as any).content).toBe("Important contract terms from page 2");
    expect((upserted[3] as any).content).toBe("Important contract terms from page 2");
  });

  test("abstract field falls back to page position when no text", async () => {
    const filePath = join(dir, "two.pdf");
    writeFileSync(filePath, Buffer.from("%PDF fake"));

    const upserted: unknown[] = [];
    const chroma = mockChroma();
    (chroma as any).upsert = async (record: unknown) => { upserted.push(record); };

    const cache = new MediaCache(dir);
    await upsertMediaFile("two.pdf", filePath, "application/pdf", VAULT_ROOT, chroma, mockEmbedderWithImages(), cache, config, { batchSize: 32, batchMaxChars: 100_000 }, false, {
      renderPage: async () => Buffer.alloc(4),
      countPages: async () => 2,
      extractText: async () => "",
    });

    expect((upserted[0] as any).content).toBe("two.pdf");
    expect((upserted[0] as any).abstract).toBe("Page 1 of 2");
    expect((upserted[1] as any).abstract).toBe("Page 1 of 2");
    expect((upserted[2] as any).content).toBe("two.pdf");
    expect((upserted[3] as any).abstract).toBe("Page 2 of 2");
  });

  test("cache entry has chromaIds for both entries per page", async () => {
    const filePath = join(dir, "pages.pdf");
    writeFileSync(filePath, Buffer.from("%PDF fake"));

    const cache = new MediaCache(dir);
    await upsertMediaFile("pages.pdf", filePath, "application/pdf", VAULT_ROOT, mockChroma(), mockEmbedderWithImages(), cache, config, { batchSize: 32, batchMaxChars: 100_000 }, false, {
      renderPage: async () => Buffer.alloc(4),
      countPages: async () => 4,
      extractText: async () => "text",
    });

    // 4 pages × 2 = 8 chromaIds
    expect(cache.get("pages.pdf")?.chromaIds).toHaveLength(8);
  });

  test("creates only text entry when image embedding fails", async () => {
    const filePath = join(dir, "img-fail.pdf");
    writeFileSync(filePath, Buffer.from("%PDF fake"));

    // Embedder that supports images but throws when attempting image embed
    const embedder = mockEmbedderWithImages({
      embed: async (input) => {
        if (typeof input !== "string") throw new Error("image not supported");
        return [0.1];
      },
    });

    const upserted: unknown[] = [];
    const chroma = mockChroma();
    (chroma as any).upsert = async (record: unknown) => { upserted.push(record); };

    const cache = new MediaCache(dir);
    await upsertMediaFile("img-fail.pdf", filePath, "application/pdf", VAULT_ROOT, chroma, embedder, cache, config, { batchSize: 32, batchMaxChars: 100_000 }, false, {
      renderPage: async () => Buffer.alloc(4),
      countPages: async () => 2,
      extractText: async (_path, pageNum) => `Page ${pageNum} content`,
    });

    // Only text entries (2 pages × 1 = 2), no image entries
    expect(upserted).toHaveLength(2);
    expect((upserted as any[]).every((r) => r.id.endsWith("-txt"))).toBe(true);
  });
});

// ── deleteMediaFile ───────────────────────────────────────────────────────────

describe("deleteMediaFile", () => {
  test("calls chroma.delete for every chromaId", () => {
    const deletedIds: string[] = [];
    const chroma = mockChroma();
    (chroma as any).delete = async (id: string) => { deletedIds.push(id); };

    const cache = new MediaCache(dir);
    cache.set("report.pdf", {
      hash: "hh",
      size: 100,
      mtime: "999",
      chromaIds: ["hh-page-0", "hh-page-1", "hh-page-2"],
    });

    deleteMediaFile("report.pdf", chroma, cache);

    // deletions are async — wait a tick
    return new Promise((resolve) => setTimeout(() => {
      expect(deletedIds).toEqual(["hh-page-0", "hh-page-1", "hh-page-2"]);
      resolve(undefined);
    }, 10));
  });

  test("removes entry from cache", () => {
    const cache = new MediaCache(dir);
    cache.set("img.jpg", { hash: "ab", size: 1, mtime: "1", chromaIds: ["ab"] });

    deleteMediaFile("img.jpg", mockChroma(), cache);

    expect(cache.get("img.jpg")).toBeUndefined();
  });

  test("no-op when entry not in cache", () => {
    const cache = new MediaCache(dir);
    const deletedIds: string[] = [];
    const chroma = mockChroma();
    (chroma as any).delete = async (id: string) => { deletedIds.push(id); };

    deleteMediaFile("nonexistent.jpg", chroma, cache);

    return new Promise((resolve) => setTimeout(() => {
      expect(deletedIds).toHaveLength(0);
      resolve(undefined);
    }, 10));
  });
});
