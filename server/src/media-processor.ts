import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, basename, extname } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import type { EmbeddingProvider } from "./embeddings/types.js";
import { batchEmbedTexts } from "./embeddings/batch.js";

// Stub DOMMatrix and Path2D before pdfjs loads. pdfjs tries to polyfill these
// via the optional `canvas` npm package, which we don't install. Text extraction
// doesn't render pages, so canvas is never needed.
if (!globalThis.DOMMatrix) (globalThis as any).DOMMatrix = class DOMMatrix {};
if (!globalThis.Path2D) (globalThis as any).Path2D = class Path2D {};

// pdfjs-dist legacy build — Node.js-compatible, no DOM/worker needed.
// Used only for text extraction (not rendering).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

// Path to bundled standard fonts — passed per-call to getDocument() to avoid fetch warnings.
const STANDARD_FONT_URL = join(require.resolve("pdfjs-dist/legacy/build/pdf.js"), "..", "..", "standard_fonts") + "/";

// ── MIME type map ─────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  ".txt": "text/plain",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heic",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
};

const OFFICE_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

export function getMimeType(ext: string): string | undefined {
  return MIME_MAP[ext.toLowerCase()];
}

export function isOfficeDoc(mimeType: string): boolean {
  return OFFICE_MIMES.has(mimeType);
}

export function sha256hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── Text file ─────────────────────────────────────────────────────────────────

export async function processTextFile(
  filePath: string,
  embedder: EmbeddingProvider,
): Promise<{ embedding: number[]; content: string }> {
  const content = readFileSync(filePath, "utf-8");
  const embedding = await embedder.embed(content, {
    taskInstruction: "Represent the following document for retrieval: ",
  });
  return { embedding, content };
}

// ── PDF: screenshot each page, extract text, embed both ─────────────────────────

export interface PdfProcessorOpts {
  /** Override page renderer — default: mutool draw */
  renderPage?: (pdfPath: string, pageNum: number) => Promise<Buffer>;
  /** Override page count — default: mutool info */
  countPages?: (pdfPath: string) => Promise<number>;
  /** Override text extraction — default: pdfjs */
  extractText?: (pdfPath: string, pageNum: number) => Promise<string>;
  /** Max pages per text embedding batch (default: 32) */
  batchSize?: number;
  /** Max total chars per text embedding batch (default: 100_000) */
  batchMaxChars?: number;
}

export interface PdfPageResult {
  pageIndex: number;
  pageTotal: number;
  imageEmbedding: number[] | null;
  imageEmbeddingError?: string;
  textEmbedding: number[];
  extractedText: string;
}

export async function processPdf(
  pdfPath: string,
  embedder: EmbeddingProvider,
  opts: PdfProcessorOpts = {},
): Promise<Array<PdfPageResult>> {
  const renderPage = opts.renderPage ?? renderPageScreenshot;
  const totalPages = opts.countPages ? await opts.countPages(pdfPath) : await countPdfPages(pdfPath);
  const extractText = opts.extractText ?? extractPageText;
  const supportsImages = embedder.capabilities().images;

  // Phase 1: extract text for all pages; render screenshots only if image embedding is supported
  const pageData: Array<{ screenshot: Buffer | null; text: string; rawText: string }> = [];
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const [screenshot, rawText] = await Promise.all([
      supportsImages ? renderPage(pdfPath, pageNum) : Promise.resolve(null),
      extractText(pdfPath, pageNum),
    ]);
    pageData.push({ screenshot, text: rawText || `Page ${pageNum} of ${totalPages}`, rawText });
  }

  // Phase 2: batch-embed all page texts (respects batchSize + batchMaxChars limits)
  const textEmbeddings = await batchEmbedTexts(
    embedder,
    pageData.map((p) => p.text),
    { taskInstruction: "Represent the following document for retrieval: " },
    { batchSize: opts.batchSize ?? 32, batchMaxChars: opts.batchMaxChars ?? 100_000 },
  );

  // Phase 3: image embeddings — only if supported, not batched (images stay sequential)
  const results: PdfPageResult[] = [];
  for (let i = 0; i < totalPages; i++) {
    let imageEmbedding: number[] | null = null;
    let imageEmbeddingError: string | undefined;
    if (supportsImages && pageData[i].screenshot) {
      try {
        imageEmbedding = await embedder.embed(
          { mimeType: "image/png", data: pageData[i].screenshot! },
          { taskInstruction: "Represent the following document for retrieval: " },
        );
      } catch (err) {
        imageEmbeddingError = err instanceof Error ? err.message : String(err);
      }
    }

    results.push({
      pageIndex: i,
      pageTotal: totalPages,
      imageEmbedding,
      imageEmbeddingError,
      textEmbedding: textEmbeddings[i],
      extractedText: pageData[i].rawText,
    });
  }

  return results;
}

// Count PDF pages using mutool
async function countPdfPages(pdfPath: string): Promise<number> {
  const proc = Bun.spawn(["mutool", "info", pdfPath], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`mutool info exited ${exitCode} for ${pdfPath}`);
  }
  const output = await new Response(proc.stdout).text();
  const match = output.match(/Pages:\s*(\d+)/);
  if (!match) throw new Error(`Could not determine page count for ${pdfPath}`);
  return parseInt(match[1], 10);
}

// Render a single PDF page to PNG using mutool draw (200 DPI for high quality)
async function renderPageScreenshot(pdfPath: string, pageNum: number): Promise<Buffer> {
  const outPath = join(tmpdir(), `engram-page-${process.pid}-${Date.now()}-${pageNum}.png`);
  try {
    const proc = Bun.spawn(
      ["mutool", "draw", "-F", "png", "-r", "200", "-o", outPath, pdfPath, String(pageNum)],
      { stdout: "ignore", stderr: "ignore" },
    );
    const code = await proc.exited;
    if (code !== 0) throw new Error(`mutool draw exited ${code} for page ${pageNum} of ${pdfPath}`);
    return readFileSync(outPath);
  } finally {
    rmSync(outPath, { force: true });
  }
}

// Extract text from a single PDF page using pdfjs
async function extractPageText(pdfPath: string, pageNum: number): Promise<string> {
  const pdfBuffer = readFileSync(pdfPath);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), standardFontDataUrl: STANDARD_FONT_URL }).promise;
  const page = await doc.getPage(pageNum);
  const textContent = await page.getTextContent();
  const text = (textContent.items as unknown[])
    .map((item) => (item !== null && typeof item === "object" && "str" in item ? (item as { str: string }).str : ""))
    .join(" ")
    .trim();
  return text;
}

// ── Office document → PDF via LibreOffice ────────────────────────────────────

export async function convertOfficeToPdf(
  filePath: string,
  libreOfficePath: string,
): Promise<Buffer> {
  const outDir = mkdtempSync(join(tmpdir(), "engram-lo-"));
  try {
    const proc = Bun.spawn(
      [libreOfficePath, "--headless", "--convert-to", "pdf", "--outdir", outDir, filePath],
      { stdout: "ignore", stderr: "ignore" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`LibreOffice exited with code ${exitCode}`);
    const base = basename(filePath, extname(filePath));
    return readFileSync(join(outDir, `${base}.pdf`));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// ── Startup checks ────────────────────────────────────────────────────────────

export async function checkMutool(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["mutool"], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    return true;
  } catch {
    return false;
  }
}

async function tryBinary(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Returns the first working LibreOffice binary from the candidate list, or null. */
export async function resolveLibreOffice(preferred: string): Promise<string | null> {
  const candidates = [...new Set([preferred, "soffice", "libreoffice"])];
  for (const bin of candidates) {
    if (await tryBinary(bin)) return bin;
  }
  return null;
}

export async function checkLibreOffice(libreOfficePath: string): Promise<boolean> {
  return (await resolveLibreOffice(libreOfficePath)) !== null;
}