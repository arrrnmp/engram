#!/usr/bin/env bun
/**
 * Cross-platform start script for Engram (macOS, Linux, Windows).
 * Equivalent to scripts/start.sh but runs via Bun on all platforms.
 */
import { existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const CHROMA_PORT = 8000;

function log(msg: string) { console.log(`[engram] ${msg}`); }
function die(msg: string): never { console.error(`[engram] ERROR: ${msg}`); process.exit(1); }

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

async function isChromaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${CHROMA_PORT}/api/v2/heartbeat`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch { return false; }
}

if (await isChromaRunning()) {
  log(`ChromaDB already running on port ${CHROMA_PORT}`);
} else {
  log(`Starting ChromaDB on port ${CHROMA_PORT}...`);
  Bun.spawn(
    ["uv", "run", "chroma", "run", "--host", "0.0.0.0", "--port", String(CHROMA_PORT), "--path", join(ROOT, ".chroma-data")],
    {
      cwd: ROOT,
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, RUST_LOG: "warn" },
    }
  );

  let ready = false;
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(500);
    if (await isChromaRunning()) { ready = true; break; }
  }
  if (!ready) die("ChromaDB failed to start within 10 seconds.");
  log("ChromaDB ready.");
}

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
});

process.on("SIGINT", () => { server.kill(); process.exit(0); });
process.on("SIGTERM", () => { server.kill(); process.exit(0); });

const code = await server.exited;
process.exit(code ?? 0);
