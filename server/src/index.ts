import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { EngramChroma } from "./chroma.js";
import { createEmbeddingProvider } from "./embeddings/index.js";
import { Vault } from "./vault.js";
import { saveMemory, SaveMemoryInput } from "./tools/save-memory.js";
import { searchMemory, SearchMemoryInput } from "./tools/search-memory.js";
import { getImportantContext, updateImportantContext, UpdateContextInput } from "./tools/context.js";
import { listEngrams, ListEngramsInput } from "./tools/list-engrams.js";
import { readEngram, ReadEngramInput } from "./tools/read-engram.js";
import { logger } from "./logger.js";

// ── Startup ───────────────────────────────────────────────────────────────────

const config = loadConfig();
const vault = new Vault(config.vault.path);
const chroma = new EngramChroma(config);

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

logger.info("[engram] Connecting to ChromaDB...");
await chroma.init();
logger.info("[engram] ChromaDB ready.");

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
    "Save a memory as an Engram. Writes a dated markdown file to the Obsidian vault, embeds it in the vector database, and auto-generates wikilinks to related memories.",
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
    "Semantic search across all saved Engrams using a natural language query.",
    SearchMemoryInput.shape,
    async (input) => {
      const { query, n_results } = input as z.infer<typeof SearchMemoryInput>;
      logger.info(`[tool] search_memory: "${query}" (n=${n_results ?? 5})`);
      try {
        const result = await searchMemory(input as z.infer<typeof SearchMemoryInput>, chroma, embedder);
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
      const { from, to } = input as z.infer<typeof ListEngramsInput>;
      logger.info(`[tool] list_engrams: from=${from ?? "*"} to=${to ?? "*"}`);
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
    "Read the full content of a specific Engram by its ID (YYYY-MM-DD/slug). Use after list_engrams or search_memory to fetch the complete text.",
    ReadEngramInput.shape,
    async (input) => {
      const { id } = input as z.infer<typeof ReadEngramInput>;
      logger.info(`[tool] read_engram: ${id}`);
      try {
        const result = readEngram(input as z.infer<typeof ReadEngramInput>, vault);
        logger.info(`[tool] read_engram: ${result.content.length} chars`);
        return { content: [{ type: "text", text: result.content }] };
      } catch (err) {
        logger.error(`[tool] read_engram failed`, { err });
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
