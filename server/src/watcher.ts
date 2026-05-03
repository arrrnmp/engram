import { watch } from "fs";
import { existsSync, readFileSync, statSync, writeFileSync, rmSync } from "fs";
import { join, extname, basename } from "path";
import { tmpdir } from "os";
import matter from "gray-matter";
import type { Vault } from "./vault.js";
import type { VaultIndex } from "./vault-index.js";
import type { EngramChroma } from "./chroma.js";
import type { EmbeddingProvider } from "./embeddings/types.js";
import type { Config } from "./config.js";
import { parseEngram } from "./vault.js";
import { BodyHashRegistry } from "./body-hash.js";
import { MediaCache } from "./media-cache.js";
import {
  getMimeType,
  isOfficeDoc,
  sha256hex,
  processPdf,
  convertOfficeToPdf,
  type PdfProcessorOpts,
} from "./media-processor.js";
import { batchEmbedTexts } from "./embeddings/batch.js";
import { chunkText } from "./tools/chunk-engram.js";
import { captionImage } from "./captioning.js";
import { logger } from "./logger.js";

// ── Exported media handlers (testable with explicit deps) ─────────────────────

function truncateCaptionForLog(caption: string): string {
  const normalized = caption.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

export async function upsertMediaFile(
  relativeFilename: string,
  filePath: string,
  mimeType: string,
  vaultRoot: string,
  chroma: EngramChroma,
  embedder: EmbeddingProvider,
  mediaCache: MediaCache,
  config: Config,
  batchLimits: { batchSize: number; batchMaxChars: number },
  forceReEmbed = false,
  pdfOpts?: PdfProcessorOpts,
): Promise<void> {
  const stat = statSync(filePath);
  const cached = mediaCache.get(relativeFilename);

  // Skip if size + mtime unchanged (unless force-re-embedding)
  if (!forceReEmbed && cached && cached.size === stat.size && cached.mtime === stat.mtimeMs.toString()) return;

  logger.info(`[watcher] Detected media: ${relativeFilename} (${mimeType})`);
  logger.info(`[watcher] Indexing media: ${relativeFilename}...`);

  let chromaIds: string[];
  let caption: string | null = null;

  if (mimeType === "text/plain") {
    const content = readFileSync(filePath, "utf-8");
    const hash = sha256hex(Buffer.from(content));

    // Chunk long text files (>500 chars) for better retrieval
    const chunks = content.length > 500
      ? chunkText(content, 500, 50, "paragraph")
      : null;

    if (chunks && chunks.length > 1) {
      const chunkEmbeddings = await batchEmbedTexts(
        embedder,
        chunks,
        { taskInstruction: "Represent the following document chunk for retrieval: " },
        batchLimits
      );
      chromaIds = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${hash}-chunk-${i}`;
        await chroma.upsert({
          id: chunkId,
          content: chunks[i],
          title: basename(filePath),
          date: "",
          filename: basename(filePath),
          relativePath: relativeFilename,
          vaultPath: vaultRoot,
          abstract: `Chunk ${i + 1} of ${chunks.length}: ${chunks[i].slice(0, 120).replace(/\s+/g, " ")}…`,
          type: mimeType,
        }, chunkEmbeddings[i]);
        chromaIds.push(chunkId);
      }
      logger.info(`[watcher] Chunked ${relativeFilename} into ${chunks.length} pieces`);
    } else {
      const embedding = await embedder.embed(content, {
        taskInstruction: "Represent the following document for retrieval: ",
      });
      await chroma.upsert({
        id: hash,
        content,
        title: basename(filePath),
        date: "",
        filename: basename(filePath),
        relativePath: relativeFilename,
        vaultPath: vaultRoot,
        type: mimeType,
      }, embedding);
      chromaIds = [hash];
    }
    mediaCache.set(relativeFilename, { hash, size: stat.size, mtime: stat.mtimeMs.toString(), chromaIds });

  } else if (mimeType === "application/pdf") {
    const hash = sha256hex(readFileSync(filePath));
    const pages = await processPdf(filePath, embedder, { ...pdfOpts, ...batchLimits });
    chromaIds = [];
    for (const page of pages) {
      const abstract = page.extractedText
        ? page.extractedText.slice(0, 200).replace(/\s+/g, " ").trim()
        : `Page ${page.pageIndex + 1} of ${page.pageTotal}`;
      const content = page.extractedText || relativeFilename;

      logger.info(`[watcher]   PDF page ${page.pageIndex + 1}/${page.pageTotal}: text="${page.extractedText.slice(0, 80) || "(empty)"}" imageEmbedding=${page.imageEmbedding ? "yes" : `no (${page.imageEmbeddingError ?? "unknown error"})`}`);

      // Text entry — always present
      const txtId = `${hash}-page-${page.pageIndex}-txt`;
      await chroma.upsert({
        id: txtId,
        content,
        title: basename(filePath),
        date: "",
        filename: basename(filePath),
        relativePath: relativeFilename,
        vaultPath: vaultRoot,
        abstract,
        type: mimeType,
      }, page.textEmbedding);
      chromaIds.push(txtId);

      // Image entry — only if image embedding succeeded
      if (page.imageEmbedding) {
        const imgId = `${hash}-page-${page.pageIndex}`;
        await chroma.upsert({
          id: imgId,
          content,
          title: basename(filePath),
          date: "",
          filename: basename(filePath),
          relativePath: relativeFilename,
          vaultPath: vaultRoot,
          abstract,
          type: mimeType,
        }, page.imageEmbedding);
        chromaIds.push(imgId);
      }
    }
    mediaCache.set(relativeFilename, { hash, size: stat.size, mtime: stat.mtimeMs.toString(), chromaIds });

  } else if (isOfficeDoc(mimeType)) {
    const hash = sha256hex(readFileSync(filePath));
    const pdfBuffer = await convertOfficeToPdf(filePath, config.watcher.libreOfficePath);
    const tmpPdfPath = join(tmpdir(), `engram-office-${process.pid}-${Date.now()}.pdf`);
    writeFileSync(tmpPdfPath, pdfBuffer);
    let pages: Awaited<ReturnType<typeof processPdf>>;
    try {
      pages = await processPdf(tmpPdfPath, embedder, { ...pdfOpts, ...batchLimits });
    } finally {
      rmSync(tmpPdfPath, { force: true });
    }
    chromaIds = [];
    for (const page of pages) {
      const abstract = page.extractedText
        ? page.extractedText.slice(0, 200).replace(/\s+/g, " ").trim()
        : `Page ${page.pageIndex + 1} of ${page.pageTotal}`;
      const content = page.extractedText || relativeFilename;

      const txtId = `${hash}-page-${page.pageIndex}-txt`;
      await chroma.upsert({
        id: txtId,
        content,
        title: basename(filePath),
        date: "",
        filename: basename(filePath),
        relativePath: relativeFilename,
        vaultPath: vaultRoot,
        abstract,
        type: mimeType,
      }, page.textEmbedding);
      chromaIds.push(txtId);

      if (page.imageEmbedding) {
        const imgId = `${hash}-page-${page.pageIndex}`;
        await chroma.upsert({
          id: imgId,
          content,
          title: basename(filePath),
          date: "",
          filename: basename(filePath),
          relativePath: relativeFilename,
          vaultPath: vaultRoot,
          abstract,
          type: mimeType,
        }, page.imageEmbedding);
        chromaIds.push(imgId);
      }
    }
    mediaCache.set(relativeFilename, { hash, size: stat.size, mtime: stat.mtimeMs.toString(), chromaIds });

  } else {
    // Image or video
    const fileBuffer = readFileSync(filePath);
    const hash = sha256hex(fileBuffer);
    const isVideo = mimeType.startsWith("video/");
    const canEmbed = isVideo ? embedder.capabilities().video : embedder.capabilities().images;

    let embedding: number[];
    const tryCaption = async (): Promise<string | null> => {
      if (isVideo || !config.captioning) return null;
      logger.info(`[watcher] Captioning media: ${relativeFilename}...`);
      const generatedCaption = await captionImage(filePath, mimeType, config.captioning);
      if (generatedCaption) {
        logger.info(`[watcher] Captioned media: ${relativeFilename} — "${truncateCaptionForLog(generatedCaption)}"`);
      } else {
        logger.warn(`[watcher] Captioning returned no caption for ${relativeFilename}`);
      }
      return generatedCaption;
    };

    if (canEmbed) {
      embedding = await embedder.embed({ mimeType, data: fileBuffer });
      caption = await tryCaption();
    } else if (!isVideo && config.captioning) {
      // Image embedding not supported (e.g. MLX) — fall back to caption-as-text
      caption = await tryCaption();
      if (!caption) {
        logger.warn(`[watcher] Skipping ${relativeFilename}: embedder does not support images and captioning returned null`);
        return;
      }
      embedding = await embedder.embed(caption, { taskInstruction: "Represent the following image for retrieval: " });
    } else {
      logger.warn(`[watcher] Skipping ${relativeFilename}: embedder does not support ${isVideo ? "video" : "image"} embedding`);
      return;
    }

    await chroma.upsert({
      id: hash,
      content: caption ?? relativeFilename,
      title: basename(filePath),
      date: "",
      filename: basename(filePath),
      relativePath: relativeFilename,
      vaultPath: vaultRoot,
      abstract: caption ?? undefined,
      type: mimeType,
    }, embedding);
    chromaIds = [hash];
    mediaCache.set(relativeFilename, { hash, size: stat.size, mtime: stat.mtimeMs.toString(), chromaIds });
  }

  mediaCache.save();
  const captionSuffix = caption ? ` — "${truncateCaptionForLog(caption)}"` : "";
  logger.info(`[watcher] Indexed media: ${relativeFilename} (${chromaIds.length} chunk(s))${captionSuffix}`);
}

export function deleteMediaFile(
  relativeFilename: string,
  chroma: EngramChroma,
  mediaCache: MediaCache,
): void {
  const cached = mediaCache.get(relativeFilename);
  if (!cached) return;
  for (const id of cached.chromaIds) {
    chroma.delete(id).catch((err) => logger.error(`[watcher] Failed to delete ${id}`, { err }));
  }
  mediaCache.delete(relativeFilename);
  mediaCache.save();
  logger.info(`[watcher] Deleted media: ${relativeFilename}`);
}

// ── Vault watcher ─────────────────────────────────────────────────────────────

export function startVaultWatcher(
  vault: Vault,
  vaultIndex: VaultIndex,
  chroma: EngramChroma,
  embedder: EmbeddingProvider,
  bodyHashRegistry: BodyHashRegistry,
  mediaCache: MediaCache,
  config: Config,
  batchLimits: { batchSize: number; batchMaxChars: number },
): void {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  function debounce(filePath: string, action: () => void, delay = 200): void {
    const existing = pending.get(filePath);
    if (existing) clearTimeout(existing);
    pending.set(filePath, setTimeout(() => {
      pending.delete(filePath);
      action();
    }, delay));
  }

  watch(vault.root, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const filePath = join(vault.root, filename);

    // Skip hidden files/dirs
    if (filename.split("/").some((s: string) => s.startsWith("."))) return;

    debounce(filePath, () => {
      if (!existsSync(filePath)) {
        handleDelete(filename);
      } else if (statSync(filePath).isFile()) {
        handleUpsert(filename, filePath);
      }
    });
  });

  function handleDelete(relativeFilename: string): void {
    const ext = extname(relativeFilename).toLowerCase();
    if (ext === ".md") {
      handleMdDelete(relativeFilename);
      return;
    }
    if (getMimeType(ext)) {
      deleteMediaFile(relativeFilename, chroma, mediaCache);
    }
  }

  function handleMdDelete(relativeFilename: string): void {
    const id = vaultIndex.resolveByPath(relativeFilename);
    if (!id) return;
    chroma.delete(id).catch((err) => logger.error(`[watcher] Failed to delete ${id} from ChromaDB`, { err }));
    vaultIndex.remove(id);
    bodyHashRegistry.removeByPath(relativeFilename);
    bodyHashRegistry.save();
    logger.info(`[watcher] Deleted: ${relativeFilename} [${id}]`);
  }

  function handleUpsert(relativeFilename: string, filePath: string): void {
    const ext = extname(relativeFilename).toLowerCase();
    if (ext === ".md") {
      handleMdUpsert(relativeFilename, filePath);
      return;
    }
    const mimeType = getMimeType(ext);
    if (mimeType) {
      upsertMediaFile(relativeFilename, filePath, mimeType, vault.root, chroma, embedder, mediaCache, config, batchLimits)
        .catch((err) => logger.error(`[watcher] Failed to index ${relativeFilename}`, { err }));
    }
  }

  async function handleMdUpsert(relativeFilename: string, filePath: string): Promise<void> {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = matter(raw);

      // Assign UUID if missing
      if (!parsed.data.id) {
        parsed.data.id = crypto.randomUUID();
        const updated = matter.stringify(parsed.content, parsed.data);
        writeFileSync(filePath, updated, "utf-8");
        const rewritten = matter(updated);
        parsed.data = rewritten.data;
      }

      const id = parsed.data.id as string;

      // Calculate body hash first — needed for both duplicate detection and UUID collision logic
      const { body } = parseEngram(raw);
      const hash = BodyHashRegistry.hashBody(body);

      // Check for duplicate content FIRST (same hash at a different path).
      // If same content exists elsewhere, skip indexing — it's a duplicate file.
      const dupCheck = bodyHashRegistry.check(hash, relativeFilename);
      if (dupCheck.isDuplicate) {
        // If the canonical path no longer exists the "duplicate" is a moved/renamed file — not a true copy.
        if (!existsSync(join(vault.root, dupCheck.canonicalPath!))) {
          bodyHashRegistry.removeByPath(dupCheck.canonicalPath!);
        } else {
          logger.warn(`[watcher] Duplicate body: ${relativeFilename} matches ${dupCheck.canonicalPath} — skipping indexing`);
          return;
        }
      }

      // Rename vs collision check (only happens if content is NOT duplicate)
      const existing = vaultIndex.resolve(id);
      if (existing && existing.relativePath !== relativeFilename) {
        const oldFilePath = join(vault.root, existing.relativePath);
        if (existsSync(oldFilePath)) {
          // True UUID collision — two different files share the same UUID with different content
          parsed.data.id = crypto.randomUUID();
          const rewritten = matter.stringify(parsed.content, parsed.data);
          writeFileSync(filePath, rewritten, "utf-8");
          logger.warn(`[watcher] UUID collision: reassigned ${relativeFilename}`);
          return handleMdUpsert(relativeFilename, filePath);
        }
        // Rename — old file gone. Sync title if it matched the old filename stem.
        const oldStem = basename(existing.relativePath, ".md");
        const newStem = basename(relativeFilename, ".md");
        if ((parsed.data.title as string | undefined) === oldStem) {
          parsed.data.title = newStem;
          const rewritten = matter.stringify(parsed.content, parsed.data);
          writeFileSync(filePath, rewritten, "utf-8");
          logger.info(`[watcher] Title synced on rename: "${oldStem}" → "${newStem}"`);
        }
        // Clear stale body hash so the duplicate check below doesn't false-positive.
        bodyHashRegistry.removeByPath(existing.relativePath);
      }

      // Atomically register the hash and check if we should proceed.
      // This eliminates race condition between isRegisteredAt() and add().
      const hashStatus = bodyHashRegistry.registerIfAbsent(hash, relativeFilename);

      if (hashStatus === "skip") {
        // Hash already registered at this path. Check if this is a self-trigger event
        // (watcher's own frontmatter write triggers another event) or a file rename.
        if (vaultIndex.resolve(id)?.relativePath === relativeFilename) {
          // Self-trigger - skip
          return;
        }
        // File was renamed/UUID reassigned - continue with re-embedding
      }
      if (dupCheck.isDuplicate) {
        // If the canonical path no longer exists the "duplicate" is a moved/renamed file — not a true copy.
        if (!existsSync(join(vault.root, dupCheck.canonicalPath!))) {
          bodyHashRegistry.removeByPath(dupCheck.canonicalPath!);
        } else {
          logger.warn(`[watcher] Duplicate body: ${relativeFilename} matches ${dupCheck.canonicalPath} — skipping indexing`);
          return;
        }
      }

      const embedding = await embedder.embed(body, { taskInstruction: "Represent the following document for retrieval: " });
      await chroma.upsert({
        id,
        content: body,
        title: (parsed.data.title as string) ?? "",
        date: (parsed.data.date as string) ?? "",
        filename: relativeFilename.split("/").pop() ?? "",
        relativePath: relativeFilename,
        vaultPath: vault.root,
        abstract: (parsed.data.abstract as string) ?? undefined,
        type: (parsed.data.type as string) ?? undefined,
      }, embedding);

      vaultIndex.set(id, { relativePath: relativeFilename });
      bodyHashRegistry.save();
      logger.info(`[watcher] Upserted: ${relativeFilename} [${id}]`);
    } catch (err) {
      logger.error(`[watcher] Failed to upsert ${relativeFilename}`, { err });
    }
  }

  logger.info("[engram] Vault watcher started.");
}
