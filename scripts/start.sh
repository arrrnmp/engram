#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── ChromaDB ──────────────────────────────────────────────────────────────────

CHROMA_PORT=8000

if ! command -v uv &>/dev/null; then
  echo "uv not found. Run: bun scripts/setup.ts"
  exit 1
fi

if ! [ -d "$ROOT/.venv" ]; then
  echo "[engram] .venv not found — running uv sync..."
  (cd "$ROOT" && uv sync)
fi

if lsof -ti:"$CHROMA_PORT" &>/dev/null; then
  echo "[engram] ChromaDB already running on port $CHROMA_PORT"
else
    echo "[engram] Starting ChromaDB on port $CHROMA_PORT..."
    (cd "$ROOT" && RUST_LOG=warn uv run chroma run --host 0.0.0.0 --port "$CHROMA_PORT" --path "$ROOT/.chroma-data") &
    CHROMA_PID=$!
    echo "[engram] ChromaDB PID: $CHROMA_PID"
    sleep 2
fi

# ── Engram MCP server ─────────────────────────────────────────────────────────

if ! command -v bun &>/dev/null; then
  echo "Bun not found. Install from https://bun.sh"
  exit 1
fi

echo "[engram] Installing server dependencies..."
cd "$ROOT/server"
bun install --frozen-lockfile 2>/dev/null || bun install

echo "[engram] Starting Engram MCP server..."
bun run src/index.ts
