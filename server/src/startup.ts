import { writeFileSync } from "fs";
import { basename as _basename, join as _join } from "path";
import _matter from "gray-matter";
import type { Vault } from "./vault.js";
import { parseEngram } from "./vault.js";
import type { EngramChroma } from "./chroma.js";
import type { EmbeddingProvider } from "./embeddings/types.js";
import { batchEmbedTexts } from "./embeddings/batch.js";
import type { VaultIndex } from "./vault-index.js";
import { BodyHashRegistry } from "./body-hash.js";
import { logger } from "./logger.js";

export function validateDimensions(
  actualDims: number | null,
  expectedDims: number,
  modelInfo: { provider: string; model: string }
): boolean {
  if (actualDims !== null && actualDims !== expectedDims) {
    logger.error(
      `[engram] ERROR: Embedding dimension mismatch.\n` +
      `  Collection has ${actualDims}-dim vectors, but ${modelInfo.provider}/${modelInfo.model} produces ${expectedDims}-dim vectors.\n` +
      `  This usually means the embedding model was changed after data was already stored.\n` +
      `  To fix this, run the migration script:\n` +
      `    bun scripts/migrate.ts\n` +
      `  This will re-embed all engrams with the current model.`
    );
    return false;
  }
  return true;
}

export async function runStartupReindex(
  vault: Vault,
  chroma: EngramChroma,
  embedder: EmbeddingProvider,
  vaultIndex: VaultIndex,
  batchLimits: { batchSize: number; batchMaxChars: number },
  forceReEmbedMd: boolean,
): Promise<void> {
  if (forceReEmbedMd) {
    logger.info("[engram] Forcing re-embed of all vault engrams.");
  }

  const chromaEntries = await chroma.getAll();
  const chromaById = new Map(chromaEntries.map((e) => [e.id, e]));
  const entries = vault.listEngrams();

  // Vault files with no UUID — watcher never touched them (e.g. bulk import, deep nesting missed by fs.watch).
  const noUUID = entries.filter((e) => !e.id);
  if (noUUID.length > 0) {
    logger.info(`[engram] Assigning UUIDs and indexing ${noUUID.length} new engram(s)...`);

    type PreparedNew = { id: string; body: string; title: string; date: string; filename: string; relativePath: string; abstract?: string; type?: string };
    const preparedNew: PreparedNew[] = [];
    for (const e of noUUID) {
      try {
        const filePath = _join(vault.root, e.relativePath);
        const raw = vault.readEngram(e.relativePath);
        const parsed = _matter(raw);
        const id = crypto.randomUUID();
        parsed.data.id = id;
        const updated = _matter.stringify(parsed.content, parsed.data);
        writeFileSync(filePath, updated, "utf-8");
        const { body } = parseEngram(updated);
        const title = typeof parsed.data.title === "string" ? parsed.data.title : e.title;
        preparedNew.push({ id, body, title, date: e.date, filename: e.filename, relativePath: e.relativePath, abstract: e.abstract, type: e.type });
      } catch (err) {
        logger.error(`[engram] Failed to prepare ${e.relativePath}`, { err });
      }
    }

    const newEmbeddings = await batchEmbedTexts(embedder, preparedNew.map((p) => p.body), { taskInstruction: "Represent the following document for retrieval: " }, batchLimits);

    for (let i = 0; i < preparedNew.length; i++) {
      try {
        const p = preparedNew[i];
        await chroma.upsert({ id: p.id, content: p.body, title: p.title, date: p.date, filename: p.filename, relativePath: p.relativePath, vaultPath: vault.root, abstract: p.abstract, type: p.type }, newEmbeddings[i]);
        vaultIndex.set(p.id, { relativePath: p.relativePath });
        logger.info(`[engram] Indexed new: ${p.relativePath} [${p.id}]`);
      } catch (err) {
        logger.error(`[engram] Failed to index ${preparedNew[i].relativePath}`, { err });
      }
    }
  }

  // Force re-embed: re-embed every engram that has a UUID.
  if (forceReEmbedMd) {
    const withIds = entries.filter((e) => e.id);
    logger.info(`[engram] Re-embedding all ${withIds.length} engram(s)...`);

    type PreparedReEmbed = { id: string; body: string; title: string; date: string; filename: string; relativePath: string; abstract?: string; type?: string };
    const preparedReEmbed: PreparedReEmbed[] = [];
    for (const e of withIds) {
      try {
        const raw = vault.readEngram(e.relativePath);
        const { body } = parseEngram(raw);
        preparedReEmbed.push({ id: e.id!, body, title: e.title, date: e.date, filename: e.filename, relativePath: e.relativePath, abstract: e.abstract, type: e.type });
      } catch (err) {
        logger.error(`[engram] Failed to read ${e.relativePath}`, { err });
      }
    }

    const reEmbedEmbeddings = await batchEmbedTexts(embedder, preparedReEmbed.map((p) => p.body), { taskInstruction: "Represent the following document for retrieval: " }, batchLimits);

    for (let i = 0; i < preparedReEmbed.length; i++) {
      try {
        const p = preparedReEmbed[i];
        await chroma.upsert({ id: p.id, content: p.body, title: p.title, date: p.date, filename: p.filename, relativePath: p.relativePath, vaultPath: vault.root, abstract: p.abstract, type: p.type }, reEmbedEmbeddings[i]);
        logger.info(`[engram] Re-embedded: ${p.relativePath} [${p.id}]`);
      } catch (err) {
        logger.error(`[engram] Failed to re-embed ${preparedReEmbed[i].relativePath}`, { err });
      }
    }
    logger.info("[engram] Full re-embed complete.");
  } else {
    // Normal startup: only re-index engrams missing from ChromaDB.
    const toReIndex = entries.filter((e) => e.id && !chromaById.has(e.id));

    // Engrams in ChromaDB but whose path or title drifted (e.g. renamed while server was down).
    const toSync = entries.flatMap((e) => {
      if (!e.id) return [];
      const stored = chromaById.get(e.id);
      if (!stored) return [];
      if (stored.relativePath !== e.relativePath || stored.title !== e.title) {
        return [{ entry: e, stored }];
      }
      return [];
    });

    if (toReIndex.length > 0) {
      logger.info(`[engram] Re-indexing ${toReIndex.length} engram(s) missing from ChromaDB...`);

      type PreparedReIndex = { id: string; body: string; title: string; date: string; filename: string; relativePath: string; abstract?: string; type?: string };
      const preparedReIndex: PreparedReIndex[] = [];
      for (const e of toReIndex) {
        try {
          const raw = vault.readEngram(e.relativePath);
          const { body } = parseEngram(raw);
          preparedReIndex.push({ id: e.id!, body, title: e.title, date: e.date, filename: e.filename, relativePath: e.relativePath, abstract: e.abstract, type: e.type });
        } catch (err) {
          logger.error(`[engram] Failed to read ${e.relativePath}`, { err });
        }
      }

      const reIndexEmbeddings = await batchEmbedTexts(embedder, preparedReIndex.map((p) => p.body), { taskInstruction: "Represent the following document for retrieval: " }, batchLimits);

      for (let i = 0; i < preparedReIndex.length; i++) {
        try {
          const p = preparedReIndex[i];
          await chroma.upsert({ id: p.id, content: p.body, title: p.title, date: p.date, filename: p.filename, relativePath: p.relativePath, vaultPath: vault.root, abstract: p.abstract, type: p.type }, reIndexEmbeddings[i]);
          logger.info(`[engram] Re-indexed: ${p.relativePath} [${p.id}]`);
        } catch (err) {
          logger.error(`[engram] Failed to re-index ${preparedReIndex[i].relativePath}`, { err });
        }
      }
      logger.info("[engram] Re-index complete.");
    }

    if (toSync.length > 0) {
      logger.info(`[engram] Syncing metadata for ${toSync.length} renamed/retitled engram(s)...`);
      for (const { entry, stored } of toSync) {
        try {
          let effectiveTitle = entry.title;
          const oldStem = _basename(stored.relativePath, ".md");
          const newStem = _basename(entry.relativePath, ".md");
          if (entry.title === oldStem && oldStem !== newStem) {
            // Title matched old filename stem — sync it to the new stem.
            effectiveTitle = newStem;
            const filePath = _join(vault.root, entry.relativePath);
            const raw = vault.readEngram(entry.relativePath);
            const parsed = _matter(raw);
            parsed.data.title = newStem;
            writeFileSync(filePath, _matter.stringify(parsed.content, parsed.data), "utf-8");
            logger.info(`[engram] Title synced: "${oldStem}" → "${newStem}" [${entry.id}]`);
          }
          await chroma.patchMetadata(entry.id!, {
            relativePath: entry.relativePath,
            filename: _basename(entry.relativePath),
            title: effectiveTitle,
          });
          logger.info(`[engram] Metadata synced: ${stored.relativePath} → ${entry.relativePath} [${entry.id}]`);
        } catch (err) {
          logger.error(`[engram] Failed to sync metadata for ${entry.relativePath}`, { err });
        }
      }
    }
  }
}

export function populateBodyHashRegistry(vault: Vault, bodyHashRegistry: BodyHashRegistry): void {
  for (const entry of vault.listEngrams()) {
    if (!entry.id || !entry.relativePath) continue;
    try {
      const raw = vault.readEngram(entry.relativePath);
      const { body } = parseEngram(raw);
      const hash = BodyHashRegistry.hashBody(body);
      bodyHashRegistry.add(hash, entry.relativePath);
    } catch {}
  }
}
