# Engram

Multimodal AI memory database. Memories are saved as markdown files in an Obsidian vault (at arbitrary folder depths), embedded via Qwen3-VL-Embedding-2B into ChromaDB, and retrieved through an MCP server that works with any MCP-compatible agent. A file watcher keeps ChromaDB in sync with Obsidian edits in real time.

## Architecture

```
Obsidian Vault (any/folder/path/title.md)
       ↕ read/write + file watcher
  Engram MCP Server (Bun, HTTP/HTTPS, port 7384)
       ↕ embed / search
    ChromaDB (port 8000)
       ↑
  Embedding server (vLLM/MLX, port 8001) — Qwen3-VL-Embedding-2B
```

Each Engram carries a stable UUID in its frontmatter. At startup the server scans the vault recursively to build an in-memory index (UUID → relative path), validates embedding dimensions, and re-embeds any files missing from ChromaDB. The file watcher then monitors for changes — new or modified `.md` files are automatically indexed. Files can be freely renamed or moved in Obsidian without breaking the index.

### Key architectural patterns

- **Session-based transport**: Per-client MCP server instances sharing expensive singletons (embedder, ChromaDB, vault, index)
- **UUID identity**: Stable frontmatter IDs survive renames; VaultIndex maintains bidirectional UUID↔path mapping
- **Dual storage**: Abstract stored in both vault and ChromaDB metadata for scalable listing/searching
- **Body hash dedup**: SHA256 registry prevents duplicate embeddings; handles file watcher self-triggering
- **Two-mode clustering**: O(n²) exact (≤300 engrams) or O(n·k) approximate (>300 engrams with K=15 neighbors)
- **Hybrid search**: Semantic, keyword, or hybrid (0.7×semantic + 0.3×keyword) modes with LRU query cache
- **Hardware-aware quant**: Auto-selects model variant by platform (Apple Silicon → MLX, Blackwell → NVFP4, older NVIDIA → GGUF)

**Skills** are agent instructions loaded by the harness:
- `/save-memory`, `/prefill`, `/update-important-memory`, `/dilucidate` — user-invocable only, never run automatically
- `surface-memories` — agent-only, auto-triggered when a conversation touches a known topic

All engram content, IMPORTANT.md, and search queries are enforced in **English** regardless of the conversation language, for consistent embedding alignment.

## Setup

### 1. Install Bun and uv (the only manual steps)

```bash
# Bun — macOS / Linux
curl -fsSL https://bun.sh/install | bash
# Bun — Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# uv — macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
# uv — Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

### 2. Run the onboarding script

```bash
bun scripts/setup.ts
```

The script checks every prerequisite, detects your hardware, recommends the right quantization, sets up `config.json`, and offers to install missing pieces interactively. Works on macOS, Linux, and Windows.

| What it checks | What it does if missing |
|---|---|
| Embedding backend (MLX/vLLM) | Verifies required runtime and shows how to proceed for your platform |
| uv + chromadb | Offers to run `uv sync` (creates `.venv`, installs from `pyproject.toml`) |
| Server deps | Runs `bun install` automatically |
| `config.json` | Creates from defaults, asks for vault path |

### 3. Start

```bash
bun run start        # starts ChromaDB, embedding server, caption server (if configured), and Engram
```

Optional re-embed modes:

```bash
bun run re-embed                  # re-embed markdown + media
bun scripts/start.ts --re-embed-md
bun scripts/start.ts --re-embed-pdf
bun scripts/migrate.ts            # re-embed all engrams after model/dimension changes
```

Dev server with hot reload:

```bash
cd server && bun run dev
```

Run the test suite:

```bash
cd server && bun test
```

### Manual configuration

Edit `config.json` for custom settings. See `server/src/config.ts` for the full Zod schema:

```json
{
  "vault": { "path": "~/Documents/my-engram-vault" },
  "chroma": { "host": "http://localhost:8000", "collection": "engrams" },
  "server": { "port": 7384 },
  "embedding": {
    "vllm": { "host": "http://localhost:8001" },
    "quant": "q4_k_m",
    "queryCacheSize": 64
  }
}
```

To tune the query embedding cache (default 64 entries, set to 0 to disable):

```json
{
  "embedding": { "queryCacheSize": 128 }
}
```

To use local captioning (auto-detected by platform):

```json
{
  "captioning": {
    "provider": "auto",
    "host": "http://localhost:8002/v1",
    "prompt": "Describe this image concisely for search and retrieval."
  }
}
```

- **macOS (Apple Silicon)**: `bun run start` launches an MLX-LM server with the configured model (default: `mlx-community/Qwen3.5-4B-MLX-4bit`).
- **Windows / Linux**: `bun run start` launches `llama-server` with the configured GGUF (default: `unsloth/Qwen3.5-4B-GGUF:Qwen3.5-4B-UD-Q4_K_XL.gguf`).

> **Note**: The default models (`Qwen3.5-4B`) are vision-capable foundation models. When using `bun run start`, the startup script verifies the caption server and exits if verification fails. If you start the server directly, it will warn and fall back to filenames instead.

### 4. Connect your agent

The setup script auto-registers Engram's MCP endpoint and installs skills for all detected agent tools. Supported:

| Agent | How it's registered |
|---|---|
| Claude Code | `~/.claude.json` (HTTP MCP) |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (stdio via `mcp-remote`) |
| Cursor | `~/.cursor/mcp.json` |
| OpenCode | `~/.config/opencode/opencode.json` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` |

For other MCP clients, add manually:

```json
{
  "mcpServers": {
    "engram": {
      "url": "http://localhost:7384/mcp"
    }
  }
}
```

Health endpoint: `http://localhost:7384/health` returns `{ status: "ok", embedder, sessions }`.

## Skills

| Skill | Invoke | What it does |
|---|---|---|
| `save-memory` | `/save-memory` | Full extraction pass over the conversation → saves 2–5 focused Engrams with wikilinks. Checks vault structure for folder placement. |
| `prefill` | `/prefill` | Loads IMPORTANT.md into context at the start of a session |
| `update-important-memory` | `/update-important-memory` | Reviews all Engrams and rewrites the persistent user profile |
| `dilucidate` | `/dilucidate` | Weekly memory graph analysis: clusters, contradictions, wikilinks, summaries, tags, decay — two-phase with approval gate |
| `surface-memories` | *(auto-triggered)* | Silently searches for relevant context when a conversation touches a known topic |

## Server Modules

| Module | Purpose |
|---|---|
| `config.ts` | Zod-validated config from `config.json` / `config.local.json` |
| `vault.ts` | Obsidian markdown I/O, frontmatter parsing, wikilink extraction |
| `vault-index.ts` | UUID↔relativePath bidirectional mapping with collision detection |
| `chroma.ts` | ChromaDB wrapper: upsert, search, metadata operations |
| `wikilinks.ts` | Bidirectional `[[wikilinks]]` between similar engrams |
| `embeddings/qwen-vl.ts` | Multimodal embedding provider via vLLM |
| `embeddings/cache.ts` | LRU cache for query embeddings |
| `embeddings/index.ts` | Provider factory with hardware-aware selection |
| `embeddings/batch.ts` | Batched text embedding with memory-safe chunking and sequential fallback |
| `hardware/detect.ts` | Cross-platform hardware detection (Apple/NVIDIA/CPU) |
| `startup.ts` | Startup orchestration: dimension validation, re-index, metadata sync, body-hash population |
| `hardware/memory.ts` | Quantization variant selection by available memory |
| `media-processor.ts` | PDF, Office, image, video processing pipeline |
| `media-cache.ts` | Media processing cache to avoid redundant work |
| `body-hash.ts` | SHA256 body hash deduplication registry |
| `watcher.ts` | Recursive file watcher with debounce and UUID assignment |
| `dilucidate/cluster.ts` | O(n²)/O(n·k) clustering with missing wikilink detection |
| `search/keyword.ts` | In-process keyword search with two-pass filtering |
| `logger.ts` | Winston logging to console + files |

## MCP Tools
| Tool | Purpose |
|---|---|
| `save_memory` | Write an Engram, embed it, generate wikilinks. Requires `title`, `abstract`, `content`. Optional `folder` for vault-relative placement, `type` for categorization |
| `search_memory` | Search by `mode`: `"semantic"` (default), `"keyword"` (exact terms), `"hybrid"` (0.7+0.3 merge). Filterable by date range, type. Returns `abstract` on each result |
| `list_engrams` | List Engrams, filterable by date range. Supports pagination (`limit`, `offset`) and returns `total` for full-count workflows |
| `read_engram` | Read a single Engram by UUID. Returns structured content: title, date, type, tags, body, wikilinks |
| `read_engrams` | Batch read up to 20 Engrams in one call. 80K char response guard. |
| `update_engram` | Update in-place: `setAbstract` (synced to ChromaDB), `setContent` (replaces body, re-embeds), `editContent` (targeted string replacement, re-embeds), `addTags`, `addWikilinks` |
| `delete_engram` | Permanently delete — removes vault file, ChromaDB entry, index entry, body hash. Cannot be undone |
| `chunk_engram` | Chunk a long Engram into individually indexed segments (`create` / `re-embed` modes) |
| `cluster_memories` | Compute semantic clusters — returns groups, avg similarity, missing wikilinks. Used by `/dilucidate` |
| `get_vault_structure` | Get the current vault directory tree. Call before `save_memory` to choose an appropriate folder |
| `get_important_context` | Read IMPORTANT.md |
| `update_important_context` | Write IMPORTANT.md |
| `get_dilucidate_meta` | Read `.dilucidate-meta.json` (run history and early-exit state) |
| `update_dilucidate_meta` | Write `.dilucidate-meta.json` after a dilucidate run. Server-side merge with 50-entry history cap |

## Embedding Model

Qwen3-VL-Embedding-2B via vLLM — single provider for text, images, video, and PDFs. 2048-dimensional output.

| Quant | Approx memory | Backend args | Notes |
|---|---|---|---|
| `q8_0` | ~3.5 GB | `--load-format gguf --gguf-file ...Q8_0.gguf` | Highest quality GGUF |
| `q6_k` | ~3.0 GB | `--load-format gguf --gguf-file ...Q6_K.gguf` | Balanced quality/cost |
| `q5_k_m` | ~2.5 GB | `--load-format gguf --gguf-file ...Q5_K_M.gguf` | Mid-tier fallback |
| `q4_k_m` | ~2.0 GB | `--load-format gguf --gguf-file ...Q4_K_M.gguf` | Lowest-memory GGUF fallback |
| `nvfp4` | GPU-dependent | `--quantization nvfp4` | Blackwell-specific checkpoint |

The server auto-selects the highest-quality quantization that fits your GPU memory (with 25% overhead buffer). Override with `"quant": "q4_k_m"` (or `q5_k_m` / `q6_k` / `q8_0`) in config.

If the embedding model changes after data is stored, run the migration script:
```bash
bun scripts/migrate.ts
```

## Vault Structure

```
~/Documents/my-engram-vault/
├── IMPORTANT.md                                   ← persistent user profile
├── .dilucidate-meta.json                          ← /dilucidate run history
├── .engram-body-hashes.json                       ← dedup registry
├── .engram-collection-meta.json                   ← embedding model/dimension metadata
├── .engram-media-cache.json                       ← media processing cache
├── .engram-chunks/                                ← chunk indices
├── 2026-04-29/
│   └── Rust Async Runtime — Design Decisions.md
├── 2026-04-28/
│   └── Homelab Network Architecture.md
├── projects/
│   └── Engram/
│       └── Architecture.md                        ← arbitrary folder depth
└── ...
```

Files at any depth are indexed. The file watcher detects new, modified, and deleted `.md` files in real time. Duplicate body content is detected via SHA256 hashes and skipped with a warning.

```yaml
---
id: "3f7a2c1d-..."         ← stable UUID; survives renames
abstract: "A 3–6 sentence summary of the engram's key content..."
title: "Rust Async Runtime — Design Decisions"
date: "2026-04-29"
type: "decision"
tags: ["rust", "architecture"]
---

Engram content here.

## Related Memories
- [[projects/Engram/Architecture]]
```

Wikilinks use vault-relative paths (without `.md`), so Obsidian's graph view stays human-readable and files can be freely moved between folders.

## Dilucidate Routine

The `routines/dilucidate.md` file contains the self-contained prompt for a weekly Claude Code desktop scheduled task. Configure as:
- **Schedule**: Weekly Sunday 10 AM
- **Model**: Sonnet 4.6
- **Permission**: Accept edits
- **Two-phase**: Phase 1 analyzes (read-only), Phase 2 executes writes

## Testing

Run the test suite with `cd server && bun test`.

**Well-covered**: LRU cache, clustering, search, media processing, keyword search

**Coverage gaps**: Concurrent access scenarios (file watcher + tool call race conditions), `tools/list-engrams.ts` and `tools/context.ts` basic handlers
