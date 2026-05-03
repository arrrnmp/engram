import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PNG } from "pngjs";
import {
  getMimeType,
  isOfficeDoc,
  sha256hex,
  processTextFile,
  processPdf,
  convertOfficeToPdf,
} from "../media-processor.js";
import { mockEmbedder, mockEmbedderWithImages } from "./helpers/mocks.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function make1x1Png(): Buffer {
  const png = new PNG({ width: 1, height: 1 });
  png.data = Buffer.from([255, 0, 0, 255]); // red pixel RGBA
  return PNG.sync.write(png);
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "engram-test-proc-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ── getMimeType ───────────────────────────────────────────────────────────────

describe("getMimeType", () => {
  test("returns MIME for known image extensions", () => {
    expect(getMimeType(".jpg")).toBe("image/jpeg");
    expect(getMimeType(".jpeg")).toBe("image/jpeg");
    expect(getMimeType(".png")).toBe("image/png");
    expect(getMimeType(".webp")).toBe("image/webp");
    expect(getMimeType(".heic")).toBe("image/heic");
    expect(getMimeType(".heif")).toBe("image/heic");
    expect(getMimeType(".tiff")).toBe("image/tiff");
    expect(getMimeType(".tif")).toBe("image/tiff");
  });

  test("returns MIME for video extensions", () => {
    expect(getMimeType(".mp4")).toBe("video/mp4");
    expect(getMimeType(".mov")).toBe("video/quicktime");
    expect(getMimeType(".webm")).toBe("video/webm");
    expect(getMimeType(".mpeg")).toBe("video/mpeg");
    expect(getMimeType(".mpg")).toBe("video/mpeg");
  });

  test("returns MIME for document types", () => {
    expect(getMimeType(".txt")).toBe("text/plain");
    expect(getMimeType(".pdf")).toBe("application/pdf");
    expect(getMimeType(".docx")).toContain("wordprocessingml");
    expect(getMimeType(".pptx")).toContain("presentationml");
    expect(getMimeType(".xlsx")).toContain("spreadsheetml");
    expect(getMimeType(".xls")).toBe("application/vnd.ms-excel");
  });

  test("is case-insensitive", () => {
    expect(getMimeType(".JPG")).toBe("image/jpeg");
    expect(getMimeType(".PDF")).toBe("application/pdf");
  });

  test("returns undefined for unknown extensions", () => {
    expect(getMimeType(".exe")).toBeUndefined();
    expect(getMimeType(".xyz")).toBeUndefined();
    expect(getMimeType("")).toBeUndefined();
  });
});

// ── isOfficeDoc ───────────────────────────────────────────────────────────────

describe("isOfficeDoc", () => {
  test("returns true for Office MIME types", () => {
    expect(isOfficeDoc("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    expect(isOfficeDoc("application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe(true);
    expect(isOfficeDoc("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
    expect(isOfficeDoc("application/vnd.ms-excel")).toBe(true);
  });

  test("returns false for non-Office types", () => {
    expect(isOfficeDoc("image/png")).toBe(false);
    expect(isOfficeDoc("application/pdf")).toBe(false);
    expect(isOfficeDoc("text/plain")).toBe(false);
  });
});

// ── sha256hex ─────────────────────────────────────────────────────────────────

describe("sha256hex", () => {
  test("produces deterministic 64-char hex", () => {
    const buf = Buffer.from("hello");
    const hash = sha256hex(buf);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(sha256hex(buf)).toBe(hash);
  });

  test("different content produces different hash", () => {
    expect(sha256hex(Buffer.from("a"))).not.toBe(sha256hex(Buffer.from("b")));
  });
});

// ── processTextFile ───────────────────────────────────────────────────────────

describe("processTextFile", () => {
  test("calls embedder with raw string content, not MultimodalInput", async () => {
    const filePath = join(dir, "note.txt");
    writeFileSync(filePath, "Hello from the text file.");

    let capturedInput: unknown = null;
    const embedder = mockEmbedder({
      embed: async (input) => { capturedInput = input; return [0.1]; },
    });

    const { content } = await processTextFile(filePath, embedder);

    expect(typeof capturedInput).toBe("string");
    expect(capturedInput).toBe("Hello from the text file.");
    expect(content).toBe("Hello from the text file.");
  });

  test("passes taskInstruction to embedder", async () => {
    const filePath = join(dir, "note.txt");
    writeFileSync(filePath, "content");

    let capturedOptions: unknown = null;
    const embedder = mockEmbedder({
      embed: async (_input, opts) => { capturedOptions = opts; return [0.1]; },
    });

    await processTextFile(filePath, embedder);

    expect((capturedOptions as any)?.taskInstruction).toContain("retrieval");
  });
});

// ── processPdf ────────────────────────────────────────────────────────────────

describe("processPdf", () => {
  const fakePng = make1x1Png();

  test("1-page document produces 1 result with correct indexes and both embeddings", async () => {
    const filePath = join(dir, "one.pdf");
    writeFileSync(filePath, Buffer.alloc(4));

    const results = await processPdf(filePath, mockEmbedderWithImages(), {
      renderPage: async () => fakePng,
      countPages: async () => 1,
      extractText: async () => "Hello world",
    });

    expect(results).toHaveLength(1);
    expect(results[0].pageIndex).toBe(0);
    expect(results[0].pageTotal).toBe(1);
    expect(results[0].extractedText).toBe("Hello world");
    expect(results[0].imageEmbedding).toBeDefined();
    expect(results[0].textEmbedding).toBeDefined();
  });

  test("3-page document produces 3 results", async () => {
    const filePath = join(dir, "three.pdf");
    writeFileSync(filePath, Buffer.alloc(4));

    const results = await processPdf(filePath, mockEmbedder(), {
      renderPage: async () => fakePng,
      countPages: async () => 3,
      extractText: async (_path, pageNum) => `Page ${pageNum} text`,
    });

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.pageIndex)).toEqual([0, 1, 2]);
    expect(results.every((r) => r.pageTotal === 3)).toBe(true);
  });

  test("batch-embeds page texts and individually embeds images", async () => {
    const filePath = join(dir, "doc.pdf");
    writeFileSync(filePath, Buffer.alloc(4));

    const batchCalls: string[][] = [];
    const embedCalls: unknown[] = [];
    const embedder = mockEmbedderWithImages({
      embedBatch: async (texts) => { batchCalls.push(texts); return texts.map(() => [0.1]); },
      embed: async (input) => { embedCalls.push(input); return [0.1]; },
    });

    await processPdf(filePath, embedder, {
      renderPage: async () => fakePng,
      countPages: async () => 2,
      extractText: async () => "Some text",
    });

    // Text embeddings go through a single embedBatch call for all pages
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(2);
    // Image embeddings are individual embed calls (not batched)
    expect(embedCalls).toHaveLength(2);
    expect((embedCalls[0] as any).mimeType).toBe("image/png");
    expect((embedCalls[1] as any).mimeType).toBe("image/png");
  });

  test("screenshot buffer from renderPage is passed as data for image embedding", async () => {
    const filePath = join(dir, "scr.pdf");
    writeFileSync(filePath, Buffer.alloc(4));

    const customPng = Buffer.from([1, 2, 3, 4]);
    const embedCalls: unknown[] = [];
    // 2 pages so texts go through embedBatch; embed is only called for images
    const embedder = mockEmbedderWithImages({ embed: async (input) => { embedCalls.push(input); return [0.1]; } });

    await processPdf(filePath, embedder, {
      renderPage: async () => customPng,
      countPages: async () => 2,
      extractText: async () => "text",
    });

    expect((embedCalls[0] as any).data).toEqual(customPng);
    expect((embedCalls[1] as any).data).toEqual(customPng);
  });

  test("extractedText fallback when page has no text", async () => {
    const filePath = join(dir, "blank.pdf");
    writeFileSync(filePath, Buffer.alloc(4));

    const results = await processPdf(filePath, mockEmbedder(), {
      renderPage: async () => fakePng,
      countPages: async () => 1,
      extractText: async () => "",
    });

    expect(results[0].extractedText).toBe("");
  });

  test("imageEmbedding is null when embedder fails on image input", async () => {
    const filePath = join(dir, "fail-img.pdf");
    writeFileSync(filePath, Buffer.alloc(4));

    let callCount = 0;
    const embedder = mockEmbedder({
      embed: async (input) => {
        callCount++;
        // First call per page is text (string), second is image (MultimodalInput)
        if (typeof input !== "string") throw new Error("image not supported");
        return [0.1];
      },
    });

    const results = await processPdf(filePath, embedder, {
      renderPage: async () => fakePng,
      countPages: async () => 1,
      extractText: async () => "Some text",
    });

    expect(results[0].imageEmbedding).toBeNull();
    expect(results[0].textEmbedding).toBeDefined();
    expect(results[0].extractedText).toBe("Some text");
  });
});

// ── convertOfficeToPdf ────────────────────────────────────────────────────────

describe("convertOfficeToPdf", () => {
  test("throws when LibreOffice exits non-zero", async () => {
    const fakeProc = { exited: Promise.resolve(1) };
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(fakeProc as ReturnType<typeof Bun.spawn>);

    try {
      await expect(
        convertOfficeToPdf("/fake/doc.docx", "libreoffice")
      ).rejects.toThrow("LibreOffice exited with code 1");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("passes correct arguments to LibreOffice", async () => {
    let capturedArgs: string[] | undefined;
    const fakeProc = { exited: Promise.resolve(1) }; // non-zero — we just want to capture args
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      capturedArgs = args;
      return fakeProc as ReturnType<typeof Bun.spawn>;
    });

    try {
      await convertOfficeToPdf("/my/file.docx", "/usr/bin/libreoffice").catch(() => {});
      expect(capturedArgs).toContain("--headless");
      expect(capturedArgs).toContain("--convert-to");
      expect(capturedArgs).toContain("pdf");
      expect(capturedArgs).toContain("/my/file.docx");
    } finally {
      spawnSpy.mockRestore();
    }
  });
});