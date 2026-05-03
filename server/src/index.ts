import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { EngramChroma } from "./chroma.js";
import { createEmbeddingProvider } from "./embeddings/index.js";
import { LRUEmbeddingCache } from "./embeddings/cache.js";
import { Vault, parseEngram } from "./vault.js";
import { VaultIndex } from "./vault-index.js";
import { saveMemory, SaveMemoryInput } from "./tools/save-memory.js";
import { searchMemory, SearchMemoryInput } from "./tools/search-memory.js";
import { getImportantContext, updateImportantContext, UpdateContextInput } from "./tools/context.js";
import { listEngrams, ListEngramsInput } from "./tools/list-engrams.js";
import { readEngram, ReadEngramInput } from "./tools/read-engram.js";
import { readEngrams, ReadEngramsInput, truncateBatchResponse } from "./tools/read-engrams.js";
import { updateEngram, UpdateEngramInput } from "./tools/update-engram.js";
import { deleteEngram, DeleteEngramInput } from "./tools/delete-engram.js";
import { clusterMemoriesTool, ClusterMemoriesInput } from "./tools/dilucidate/cluster.js";
import { getDilucidateMeta, updateDilucidateMeta, UpdateDilucidateMetaInput } from "./tools/dilucidate-meta.js";
import { getVaultStructure, GetVaultStructureInput } from "./tools/vault-structure.js";
import { chunkEngram, ChunkEngramInput } from "./tools/chunk-engram.js";
import { startVaultWatcher } from "./watcher.js";
import { batchEmbedTexts } from "./embeddings/batch.js";
import { BodyHashRegistry } from "./body-hash.js";
import { MediaCache } from "./media-cache.js";
import { resolveLibreOffice, checkMutool } from "./media-processor.js";
import { detectHardware } from "./hardware/detect.js";
import { deriveBatchLimits } from "./hardware/memory.js";
import { logger } from "./logger.js";

// ── Startup ───────────────────────────────────────────────────────────────────

const config = loadConfig();
const vault = new Vault(config.vault.path);
const chroma = new EngramChroma(config);
const vaultIndex = new VaultIndex();

// ── Process lifecycle ──────────────────────────────────────────────────────────

function shutdown() {
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Embedding + ChromaDB ──────────────────────────────────────────────────────

logger.info("[engram] Loading embedding provider...");
const embedder = await createEmbeddingProvider(config);
logger.info(`[engram] Embedder ready: ${embedder.modelInfo().provider} / ${embedder.modelInfo().model}`);

const _hw = detectHardware();
const _derived = deriveBatchLimits(_hw.availableMemoryGB);
const batchLimits = {
  batchSize: config.embedding.batchSize ?? _derived.batchSize,
  batchMaxChars: config.embedding.batchMaxChars ?? _derived.batchMaxChars,
};
logger.info(
  `[engram] Batch limits: ${batchLimits.batchSize} items / ${batchLimits.batchMaxChars.toLocaleString()} chars` +
  (config.embedding.batchSize !== undefined ? " (config override)" : ` (derived from ${_hw.availableMemoryGB.toFixed(1)} GB available)`)
);

const queryCache = new LRUEmbeddingCache(config.embedding.queryCacheSize);

logger.info("[engram] Connecting to ChromaDB...");
await chroma.init();
logger.info("[engram] ChromaDB ready.");

// ── Dimension validation ───────────────────────────────────────────────────────

const actualDims = await chroma.getDimensions();
const expectedDims = embedder.expectedDimensions();

if (actualDims !== null && actualDims !== expectedDims) {
  const { provider, model } = embedder.modelInfo();
  logger.error(
    `[engram] ERROR: Embedding dimension mismatch.\n` +
    `  Collection has ${actualDims}-dim vectors, but ${provider}/${model} produces ${expectedDims}-dim vectors.\n` +
    `  This usually means the embedding model was changed after data was already stored.\n` +
    `  To fix this, run the migration script:\n` +
    `    bun scripts/migrate.ts\n` +
    `  This will re-embed all engrams with the current model.`
  );
  process.exit(1);
}

// Write / update .engram-collection-meta.json
{
  const { writeFileSync, existsSync, readFileSync } = await import("fs");
  const { join } = await import("path");
  const metaPath = join(vault.root, ".engram-collection-meta.json");
  const { provider, model } = embedder.modelInfo();
  const existingMeta = existsSync(metaPath)
    ? JSON.parse(readFileSync(metaPath, "utf-8"))
    : {};
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        ...existingMeta,
        provider,
        model,
        dimensions: actualDims ?? expectedDims,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf-8"
  );
  logger.info(`[engram] Collection meta: ${provider}/${model} (${actualDims ?? expectedDims} dims)`);
}

// ── Vault index + startup re-index ────────────────────────────────────────────

logger.info("[engram] Building vault index...");
vaultIndex.build(vault.root);
logger.info(`[engram] Vault index: ${vaultIndex.size()} engrams indexed.`);

{
  const { writeFileSync } = await import("fs");
  const { basename: _basename, join: _join } = await import("path");
  const _matter = (await import("gray-matter")).default;

  const forceReEmbedMd = !!(process.env.ENGRAM_RE_EMBED_MD);
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

// ── Body hash registry ──────────────────────────────────────────────────────────

const bodyHashRegistry = new BodyHashRegistry(vault.root);
bodyHashRegistry.load();
// Populate from existing vault entries
for (const entry of vault.listEngrams()) {
  if (!entry.id || !entry.relativePath) continue;
  try {
    const raw = vault.readEngram(entry.relativePath);
    const { body } = parseEngram(raw);
    const hash = BodyHashRegistry.hashBody(body);
    bodyHashRegistry.add(hash, entry.relativePath);
  } catch {}
}
bodyHashRegistry.save();

// ── Media cache + LibreOffice check ───────────────────────────────────────────

const mediaCache = new MediaCache(vault.root);

if (config.watcher.enabled) {
  const mutoolAvailable = await checkMutool();
  if (!mutoolAvailable) {
    logger.warn("[engram] mutool not found — PDF and Office document indexing will not work. Install mupdf-tools (brew install mupdf-tools / apt install mupdf-tools).");
  }

  const resolvedLo = await resolveLibreOffice(config.watcher.libreOfficePath);
  if (!resolvedLo) {
    logger.warn("[engram] LibreOffice not found — .docx/.pptx/.xlsx files will be skipped. Install LibreOffice to enable Office document indexing.");
  } else {
    config.watcher.libreOfficePath = resolvedLo;
  }
}

// ── Startup media scan ────────────────────────────────────────────────────────
// Index media files missed by the watcher during bulk imports or deep nesting.
// With --re-embed, re-process ALL media files (ignore cache).

if (config.watcher.enabled) {
  const { readdirSync: _readdirSync } = await import("fs");
  const { join: _joinMedia, extname: _extname } = await import("path");
  const { getMimeType, isOfficeDoc } = await import("./media-processor.js");
  const { upsertMediaFile } = await import("./watcher.js");

  const reEmbedPdf = !!(process.env.ENGRAM_RE_EMBED_PDF);

  function scanMediaFiles(dir: string, vaultRoot: string): string[] {
    const results: string[] = [];
    for (const entry of _readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = _joinMedia(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanMediaFiles(fullPath, vaultRoot));
      } else {
        const ext = _extname(entry.name).toLowerCase();
        if (ext !== ".md" && getMimeType(ext)) {
          results.push(fullPath.slice(vaultRoot.length + 1));
        }
      }
    }
    return results;
  }

  function isPdfOrOffice(rel: string): boolean {
    const mime = getMimeType(_extname(rel).toLowerCase());
    return !!mime && (mime === "application/pdf" || isOfficeDoc(mime));
  }

  const allMediaFiles = scanMediaFiles(vault.root, vault.root);
  const uncachedMedia = allMediaFiles.filter((rel) => {
    if (!mediaCache.get(rel)) return true;
    if (reEmbedPdf && isPdfOrOffice(rel)) return true;
    return false;
  });

  if (uncachedMedia.length > 0) {
    logger.info(`[engram] Indexing ${uncachedMedia.length} media file(s)...`);
    for (const rel of uncachedMedia) {
      const fullPath = _joinMedia(vault.root, rel);
      const ext = _extname(rel).toLowerCase();
      const mimeType = getMimeType(ext)!;
      const forceThis = reEmbedPdf && isPdfOrOffice(rel);
      try {
        await upsertMediaFile(rel, fullPath, mimeType, vault.root, chroma, embedder, mediaCache, config, batchLimits, forceThis);
      } catch (err) {
        logger.error(`[engram] Failed to index media: ${rel}`, { err });
      }
    }
    logger.info("[engram] Media scan complete.");
  }
}

// ── File watcher ────────────────────────────────────────────────────────────────

if (config.watcher.enabled) {
  startVaultWatcher(vault, vaultIndex, chroma, embedder, bodyHashRegistry, mediaCache, config, batchLimits);
}

// ── Session management ────────────────────────────────────────────────────────
//
// Each MCP client gets its own transport+server pair, keyed by session ID.
// Bun's HTTP server is single-process so sessions share the embedder/chroma
// singletons above (the expensive shared state).

interface Session {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

const sessions = new Map<string, Session>();

function createSession(): Session {
  const server = new McpServer({
    name: "engram",
    version: "0.1.0",
  });

  // ── Tool: save_memory ───────────────────────────────────────────────────────
  server.tool(
    "save_memory",
    "Save a memory as an Engram. Writes a dated markdown file to the Obsidian vault, embeds it in the vector database, and auto-generates wikilinks to related memories. Optionally specify a type (e.g. \"code\", \"chat\", \"idea\", \"decision\") to categorize the memory.",
    SaveMemoryInput.shape,
    async (input) => {
      const { title } = input as z.infer<typeof SaveMemoryInput>;
      logger.info(`[tool] save_memory: "${title}"`);
      try {
        const result = await saveMemory(input as z.infer<typeof SaveMemoryInput>, vault, chroma, embedder, config, vaultIndex);
        logger.info(`[tool] save_memory: saved → ${result.id}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logger.error(`[tool] save_memory failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: search_memory ─────────────────────────────────────────────────────
  server.tool(
    "search_memory",
    "Search saved Engrams. mode=\"semantic\" (default): vector similarity. mode=\"keyword\": exact term scan — best for proper nouns, hostnames, IDs. mode=\"hybrid\": weighted merge of both (0.7 semantic + 0.3 keyword).",
    SearchMemoryInput.shape,
    async (input) => {
      const { query, n_results, mode } = input as z.infer<typeof SearchMemoryInput>;
      logger.info(`[tool] search_memory: "${query}" (n=${n_results ?? 5}, mode=${mode ?? "semantic"})`);
      try {
        const result = await searchMemory(input as z.infer<typeof SearchMemoryInput>, chroma, embedder, vault, queryCache);
        logger.info(`[tool] search_memory: ${result.results.length} results`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logger.error(`[tool] search_memory failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: get_important_context ─────────────────────────────────────────────
  server.tool(
    "get_important_context",
    "Read IMPORTANT.md — the persistent user profile and key facts that should inform every conversation.",
    {},
    async () => {
      logger.info(`[tool] get_important_context`);
      try {
        const result = getImportantContext(vault);
        logger.info(`[tool] get_important_context: ${result.content.length} chars`);
        return { content: [{ type: "text", text: result.content }] };
      } catch (err) {
        logger.error(`[tool] get_important_context failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: update_important_context ──────────────────────────────────────────
  server.tool(
    "update_important_context",
    "Overwrite IMPORTANT.md with new content. Used by the /update-important-memory skill after reviewing all engrams.",
    UpdateContextInput.shape,
    async (input) => {
      const { content } = input as z.infer<typeof UpdateContextInput>;
      logger.info(`[tool] update_important_context: ${content.length} chars`);
      try {
        const result = updateImportantContext(input as z.infer<typeof UpdateContextInput>, vault);
        logger.info(`[tool] update_important_context: done`);
        return { content: [{ type: "text", text: result.message }] };
      } catch (err) {
        logger.error(`[tool] update_important_context failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: list_engrams ──────────────────────────────────────────────────────
  server.tool(
    "list_engrams",
    "List all saved Engrams, optionally filtered by date range.",
    ListEngramsInput.shape,
    async (input) => {
      const { date_range } = input as z.infer<typeof ListEngramsInput>;
      logger.info(`[tool] list_engrams: from=${date_range?.from ?? "*"} to=${date_range?.to ?? "*"}`);
      try {
        const result = listEngrams(input as z.infer<typeof ListEngramsInput>, vault);
        logger.info(`[tool] list_engrams: ${result.engrams.length} engrams`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logger.error(`[tool] list_engrams failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: read_engram ───────────────────────────────────────────────────────
  server.tool(
    "read_engram",
    "Read the full content of a specific Engram by its UUID. Returns structured content: title, date, type, tags, body, and wikilinks.",
    ReadEngramInput.shape,
    async (input) => {
      const { id } = input as z.infer<typeof ReadEngramInput>;
      logger.info(`[tool] read_engram: ${id}`);
      try {
        const result = await readEngram(input as z.infer<typeof ReadEngramInput>, vaultIndex, vault, chroma);
        logger.info(`[tool] read_engram: ${result.body.length} chars`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logger.error(`[tool] read_engram failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: read_engrams ──────────────────────────────────────────────────────
  server.tool(
    "read_engrams",
    "Read multiple Engrams by UUID in a single call. Returns structured content for each: title, date, type, tags, body, and wikilinks. Abstract is omitted (already available from list_engrams or search_memory). Results are in the same order as the input list. Use instead of multiple read_engram calls when reading 2 or more engrams.",
    ReadEngramsInput.shape,
    async (input) => {
      const { ids } = input as z.infer<typeof ReadEngramsInput>;
      logger.info(`[tool] read_engrams: ${ids.length} ids`);
      try {
        const { results } = readEngrams({ ids }, vaultIndex, vault);
        const { results: finalResults, truncated } = truncateBatchResponse(results);
        const errors = finalResults.filter((r) => "error" in r).length;
        logger.info(`[tool] read_engrams: ${finalResults.length - errors} ok, ${errors} errors${truncated ? " (truncated)" : ""}`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              results: finalResults,
              ...(truncated ? { _warning: `Response exceeded 80,000 chars. Bodies truncated. Use read_engram for full content.` } : {}),
            }, null, 2),
          }],
        };
      } catch (err) {
        logger.error(`[tool] read_engrams failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: update_engram ─────────────────────────────────────────────────────
  server.tool(
    "update_engram",
    "Update an existing Engram in-place. Supports: setAbstract (replace abstract in frontmatter, synced to ChromaDB), setContent (replace body and re-embed), addTags (merge with existing), addWikilinks (add by UUID).",
    UpdateEngramInput.shape,
    async (input) => {
      const { id } = input as z.infer<typeof UpdateEngramInput>;
      logger.info(`[tool] update_engram: ${id}`);
      try {
        const result = await updateEngram(input as z.infer<typeof UpdateEngramInput>, vault, vaultIndex, chroma, embedder);
        logger.info(`[tool] update_engram: ${result.message}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logger.error(`[tool] update_engram failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: delete_engram ─────────────────────────────────────────────────────
  server.tool(
    "delete_engram",
    "Permanently delete an Engram — removes the vault file and its ChromaDB entry. This cannot be undone.",
    DeleteEngramInput.shape,
    async (input) => {
      const { id } = input as z.infer<typeof DeleteEngramInput>;
      logger.info(`[tool] delete_engram: ${id}`);
      try {
        const result = await deleteEngram(input as z.infer<typeof DeleteEngramInput>, vault, vaultIndex, chroma);
        logger.info(`[tool] delete_engram: ${result.message}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logger.error(`[tool] delete_engram failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: cluster_memories ──────────────────────────────────────────────────
  server.tool(
    "cluster_memories",
    "Compute semantic clusters across all saved Engrams. Returns groups of related memories, missing wikilinks within each cluster, and average similarity scores. Used by /dilucidate for graph analysis.",
    ClusterMemoriesInput.shape,
    async (input) => {
      logger.info(`[tool] cluster_memories: threshold=${(input as any).threshold ?? 0.72}, minSize=${(input as any).minSize ?? 3}`);
      try {
        const result = await clusterMemoriesTool(input as z.infer<typeof ClusterMemoriesInput>, chroma, vault, vaultIndex);
        logger.info(`[tool] cluster_memories: ${result.totalClusters} clusters, ${result.totalEngrams} engrams`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logger.error(`[tool] cluster_memories failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: get_dilucidate_meta ───────────────────────────────────────────────
  server.tool(
    "get_dilucidate_meta",
    "Read .dilucidate-meta.json from the vault root. Returns null if no dilucidate run has been recorded yet.",
    {},
    async () => {
      logger.info(`[tool] get_dilucidate_meta`);
      try {
        const result = getDilucidateMeta(vault);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logger.error(`[tool] get_dilucidate_meta failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: get_vault_structure ──────────────────────────────────────────────
  server.tool(
    "get_vault_structure",
    "Get the current directory structure of the Engram vault. Call this before save_memory to understand the existing organization and choose an appropriate folder for new memories.",
    {},
    async () => {
      logger.info(`[tool] get_vault_structure`);
      try {
        const result = getVaultStructure(vault);
        logger.info(`[tool] get_vault_structure: ${result.summary}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logger.error(`[tool] get_vault_structure failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: chunk_engram ──────────────────────────────────────────────────────
  server.tool(
    "chunk_engram",
    "Split a long engram into individually-embedded segments for more precise retrieval. 'create' mode errors if chunks already exist; 're-embed' deletes existing chunks first.",
    ChunkEngramInput.shape,
    async (input) => {
      const { id, mode } = input as z.infer<typeof ChunkEngramInput>;
      logger.info(`[tool] chunk_engram: ${id} (mode=${mode})`);
      try {
        const result = await chunkEngram(input as z.infer<typeof ChunkEngramInput>, vault, vaultIndex, chroma, embedder);
        logger.info(`[tool] chunk_engram: ${result.message}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logger.error(`[tool] chunk_engram failed`, { err });
        throw err;
      }
    }
  );

  // ── Tool: update_dilucidate_meta ────────────────────────────────────────────
  server.tool(
    "update_dilucidate_meta",
    "Write updated .dilucidate-meta.json to the vault root. Used by /dilucidate to record run timestamps and stats.",
    UpdateDilucidateMetaInput.shape,
    async (input) => {
      logger.info(`[tool] update_dilucidate_meta`);
      try {
        const result = updateDilucidateMeta(input as z.infer<typeof UpdateDilucidateMetaInput>, vault);
        return { content: [{ type: "text", text: result.message }] };
      } catch (err) {
        logger.error(`[tool] update_dilucidate_meta failed`, { err });
        throw err;
      }
    }
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      logger.info(`[engram] Session opened: ${id}`);
    },
    onsessionclosed: (id) => {
      logger.info(`[engram] Session closed: ${id}`);
      sessions.delete(id);
    },
  });

  server.connect(transport);
  return { server, transport };
}

// ── HTTP / HTTPS server ───────────────────────────────────────────────────────

const port = config.server.port;
const useHttps = config.server.https && config.server.certFile && config.server.keyFile;

if (config.server.https && !useHttps) {
  logger.warn("[engram] HTTPS is enabled but certFile/keyFile are not set. Run `bun scripts/setup.ts` to generate certificates. Falling back to HTTP.");
}

Bun.serve({
  port,
  ...(useHttps ? {
    tls: {
      cert: Bun.file(config.server.certFile!),
      key: Bun.file(config.server.keyFile!),
    },
  } : {}),
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        embedder: embedder.modelInfo(),
        sessions: sessions.size,
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    // Route to existing session or create a new one.
    const sessionId = req.headers.get("mcp-session-id");

    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId)!;
      return transport.handleRequest(req);
    }

    // New session — only allow on POST (initialization).
    if (req.method !== "POST") {
      return new Response("Session not found", { status: 404 });
    }

    const session = createSession();

    // Register session after transport emits its ID.
    const response = await session.transport.handleRequest(req);
    const newId = session.transport.sessionId;
    if (newId) sessions.set(newId, session);

    return response;
  },
});

const scheme = useHttps ? "https" : "http";
logger.info(`[engram] MCP server listening on ${scheme}://localhost:${port}/mcp`);
logger.info(`[engram] Health: ${scheme}://localhost:${port}/health`);
logger.info(`[engram] Vault: ${vault.root}`);
