#!/usr/bin/env bun
/**
 * Cross-platform start script for Engram (macOS, Linux, Windows).
 * Equivalent to scripts/start.sh but runs via Bun on all platforms.
 *
 * Flags:
 *   --re-embed      / -r    Force re-embedding of all vault files (markdown + media)
 *   --re-embed-md           Force re-embedding of markdown files only
 *   --re-embed-pdf          Force re-embedding of PDF/Office files only
 */
import { existsSync } from "fs";
import { join } from "path";
import { ensureChromaRunning } from "./ensure-chroma.js";
import { ensureEmbedServer } from "./ensure-embed-server.js";
import { ensureOllama } from "./ensure-ollama.js";

const ROOT = join(import.meta.dir, "..");

function log(msg: string) { console.log(`[engram] ${msg}`); }
function die(msg: string): never { console.error(`[engram] ERROR: ${msg}`); process.exit(1); }

const args = process.argv.slice(2);
const reEmbed = args.includes("--re-embed") || args.includes("-r");
const reEmbedMd = reEmbed || args.includes("--re-embed-md");
const reEmbedPdf = reEmbed || args.includes("--re-embed-pdf");

if (reEmbed) log("--re-embed flag set: will force re-embed all vault files on startup.");
else if (reEmbedMd) log("--re-embed-md flag set: will force re-embed markdown files on startup.");
else if (reEmbedPdf) log("--re-embed-pdf flag set: will force re-embed PDF/Office files on startup.");

// ── uv ────────────────────────────────────────────────────────────────────────

const uvCheck = Bun.spawnSync(["uv", "--version"], { stderr: "pipe" });
if (uvCheck.exitCode !== 0) die("uv not found. Run: bun scripts/setup.ts");

// ── .venv ─────────────────────────────────────────────────────────────────────

if (!existsSync(join(ROOT, ".venv"))) {
  log(".venv not found — running uv sync...");
  const sync = Bun.spawnSync(["uv", "sync"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (sync.exitCode !== 0) die("uv sync failed");
}

// ── ChromaDB ──────────────────────────────────────────────────────────────────

const chromaProc = await ensureChromaRunning(ROOT);

// ── Embedding server ──────────┐────────────────────────────────────────────────

const embedProc = await ensureEmbedServer(ROOT);

// ── Ollama (captioning) ─────────────────────────────────────────────────────────

const ollamaProc = await ensureOllama(ROOT);

// ── Server deps ───────────────────────────────────────────────────────────────

const serverDir = join(ROOT, "server");
if (!existsSync(join(serverDir, "node_modules"))) {
  log("Installing server dependencies...");
  const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
    cwd: serverDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (install.exitCode !== 0) {
    Bun.spawnSync(["bun", "install"], { cwd: serverDir, stdout: "inherit", stderr: "inherit" });
  }
}

// ── Engram MCP server (blocking) ──────────────────────────────────────────────

log("Starting Engram MCP server...");
const server = Bun.spawn(["bun", "run", "src/index.ts"], {
  cwd: serverDir,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    ENGRAM_RE_EMBED_MD: reEmbedMd ? "1" : undefined,
    ENGRAM_RE_EMBED_PDF: reEmbedPdf ? "1" : undefined,
  },
});

function shutdown() {
  server.kill();
  embedProc?.kill();
  ollamaProc?.kill();
  chromaProc?.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);;

const code = await server.exited;
process.exit(code ?? 0);
