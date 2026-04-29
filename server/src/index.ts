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
import { updateEngram, UpdateEngramInput } from "./tools/update-engram.js";
import { deleteEngram, DeleteEngramInput } from "./tools/delete-engram.js";
import { clusterMemoriesTool, ClusterMemoriesInput } from "./tools/dilucidate/cluster.js";
import { getDilucidateMeta, updateDilucidateMeta, UpdateDilucidateMetaInput } from "./tools/dilucidate-meta.js";
import { logger } from "./logger.js";

// ── Startup ───────────────────────────────────────────────────────────────────

const config = loadConfig();
const vault = new Vault(config.vault.path);
const chroma = new EngramChroma(config);
const vaultIndex = new VaultIndex();

// ── Ollama lifecycle ──────────────────────────────────────────────────────────

let ollamaProcess: ReturnType<typeof Bun.spawn> | null = null;

async function isOllamaRunning(host: string): Promise<boolean> {
  const candidates = host.includes("localhost")
    ? [host, host.replace("localhost", "127.0.0.1")]
    : [host];
  for (const h of candidates) {
    try {
      const res = await fetch(`${h}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

function shutdown() {
  if (ollamaProcess) {
    logger.info("[engram] Stopping Ollama...");
    ollamaProcess.kill();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (config.embedding.provider !== "openai") {
  const ollamaHost = config.embedding.ollama.host;
  if (!(await isOllamaRunning(ollamaHost))) {
    logger.info("[engram] Ollama not running — starting...");
    ollamaProcess = Bun.spawn(["ollama", "serve"], { stdout: "pipe", stderr: "pipe" });
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(500);
      if (await isOllamaRunning(ollamaHost)) { ready = true; break; }
    }
    if (!ready) {
      logger.error("[engram] Ollama failed to start within 10 seconds. Exiting.");
      process.exit(1);
    }
    logger.info("[engram] Ollama started.");
  }
}

// ── Embedding + ChromaDB ──────────────────────────────────────────────────────

logger.info("[engram] Loading embedding provider...");
const embedder = await createEmbeddingProvider(config);
logger.info(`[engram] Embedder ready: ${embedder.modelInfo().provider} / ${embedder.modelInfo().model}`);

const queryCache = new LRUEmbeddingCache(config.embedding.queryCacheSize);

logger.info("[engram] Connecting to ChromaDB...");
await chroma.init();
logger.info("[engram] ChromaDB ready.");

// ── Vault index + startup re-index ────────────────────────────────────────────

logger.info("[engram] Building vault index...");
vaultIndex.build(vault.root);
logger.info(`[engram] Vault index: ${vaultIndex.size()} engrams indexed.`);

{
  const chromaIds = new Set(await chroma.getAllIds());
  const entries = vault.listEngrams();
  const missing = entries.filter((e) => e.id && !chromaIds.has(e.id));

  if (missing.length > 0) {
    logger.info(`[engram] Re-indexing ${missing.length} engram(s) missing from ChromaDB...`);
    for (const e of missing) {
      try {
        const raw = vault.readEngram(e.date, e.filename);
        const { body } = parseEngram(raw);
        const embedding = await embedder.embed(body);
        await chroma.upsert(
          { id: e.id!, content: body, title: e.title, date: e.date, filename: e.filename, vaultPath: vault.root, abstract: e.abstract, type: e.type },
          embedding
        );
        logger.info(`[engram] Re-indexed: ${e.filename} [${e.id}]`);
      } catch (err) {
        logger.error(`[engram] Failed to re-index ${e.filename}`, { err });
      }
    }
    logger.info("[engram] Re-index complete.");
  }
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
        const result = await saveMemory(input as z.infer<typeof SaveMemoryInput>, vault, chroma, embedder, config);
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
    "Read the full content of a specific Engram by its UUID (as returned by list_engrams or search_memory).",
    ReadEngramInput.shape,
    async (input) => {
      const { id } = input as z.infer<typeof ReadEngramInput>;
      logger.info(`[tool] read_engram: ${id}`);
      try {
        const result = await readEngram(input as z.infer<typeof ReadEngramInput>, vaultIndex, vault, chroma);
        logger.info(`[tool] read_engram: ${result.content.length} chars`);
        return { content: [{ type: "text", text: result.content }] };
      } catch (err) {
        logger.error(`[tool] read_engram failed`, { err });
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
