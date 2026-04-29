# Engram

Provider-agnostic AI memory database. Conversations are saved as dated markdown files in an Obsidian vault, embedded in a vector database, and retrieved via an MCP server that works with any MCP-compatible agent.

## Architecture

```
Obsidian Vault (YYYY-MM-DD/title.md)
       ↕ read/write
  Engram MCP Server (Bun, HTTP/HTTPS, port 7384)
       ↕ embed / search
    ChromaDB (port 8000)
       ↑
  Embedding Model (Qwen3-Embedding via Ollama / NVIDIA vLLM / OpenAI)
```

Each Engram carries a stable UUID in its frontmatter. At startup the server scans the vault to build an in-memory index (UUID → file path) and re-embeds any files that are missing from ChromaDB. This means files can be freely renamed in Obsidian without breaking the index — the UUID survives the rename.

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

The script checks every prerequisite, detects your hardware, recommends the right embedding model, sets up `config.json`, and offers to install missing pieces interactively. Works on macOS, Linux, and Windows.

| What it checks | What it does if missing |
|---|---|
| Ollama | Links to installer |
| Qwen3-Embedding model | Offers to `ollama pull` the right variant for your hardware |
| uv + chromadb | Offers to run `uv sync` (creates `.venv`, installs from `pyproject.toml`) |
| Server deps | Runs `bun install` automatically |
| `config.json` | Creates from defaults, asks for vault path |

### 3. Start

```bash
bun run start        # cross-platform (macOS, Linux, Windows)
# or
./scripts/start.sh   # macOS / Linux (direct shell invocation)
```

Run the test suite with:

```bash
cd server && bun test
```

### Manual configuration

Edit `config.json` for custom settings:

```json
{
  "vault": { "path": "~/Documents/my-engram-vault" }
}
```

For OpenAI embeddings (no local runtime needed):

```json
{
  "embedding": {
    "provider": "openai",
    "openai": { "apiKey": "sk-...", "model": "text-embedding-3-small" }
  }
}
```

To tune the query embedding cache (default 64 entries, set to 0 to disable):

```json
{
  "embedding": { "queryCacheSize": 128 }
}
```

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

## Skills

| Skill | Invoke | What it does |
|---|---|---|
| `save-memory` | `/save-memory` | Full extraction pass over the conversation → saves 2–5 focused Engrams with wikilinks |
| `prefill` | `/prefill` | Loads IMPORTANT.md into context at the start of a session |
| `update-important-memory` | `/update-important-memory` | Reviews all Engrams and rewrites the persistent user profile |
| `dilucidate` | `/dilucidate` | Weekly memory graph analysis: clusters related memories, flags contradictions, creates missing wikilinks, saves summaries, backfills tags, surfaces decaying memories — two-phase with approval gate |
| `surface-memories` | *(auto-triggered)* | Silently searches for relevant context when a conversation touches a known topic; incorporates findings without announcing them |

## MCP Tools

The server exposes these tools directly (used by skills internally):

| Tool | Description |
|---|---|
| `save_memory` | Write an Engram, embed it, generate wikilinks. Requires `title`, `abstract`, and `content`. Accepts optional `type` (`"chat"`, `"code"`, `"idea"`, `"decision"`, etc.) |
| `search_memory` | Semantic search across all Engrams. Returns `abstract` from ChromaDB metadata on each result (no extra file reads). Filterable by date range and type |
| `list_engrams` | List Engrams, filterable by date range. Supports `limit` and `offset` for pagination. Returns UUID, title, abstract, date, filename, type — without reading full file bodies |
| `read_engram` | Read the full content of a specific Engram by UUID |
| `update_engram` | Update an existing Engram in-place: `setAbstract` (synced to ChromaDB), `setContent` (replaces body and re-embeds), `addTags`, `addWikilinks` |
| `delete_engram` | Permanently delete an Engram — removes the vault file, ChromaDB entry, and index entry. Cannot be undone |
| `cluster_memories` | Compute semantic clusters across all Engrams — returns groups, avg similarity, and missing wikilinks within each cluster. Used by `/dilucidate` |
| `get_important_context` | Read IMPORTANT.md |
| `update_important_context` | Write IMPORTANT.md |
| `get_dilucidate_meta` | Read `.dilucidate-meta.json` (run history and early-exit state for `/dilucidate`) |
| `update_dilucidate_meta` | Write `.dilucidate-meta.json` after a `/dilucidate` run |

## Embedding Providers

The server auto-detects the best provider for your hardware:

| Hardware | Provider | Model |
|---|---|---|
| Apple Silicon | Ollama (Metal acceleration) | Qwen3-Embedding |
| NVIDIA Blackwell (CC ≥ 10.0) | vLLM NVFP4 → Ollama CUDA fallback | Qwen3-Embedding |
| NVIDIA older / CPU | Ollama | Qwen3-Embedding |
| Override | OpenAI API | text-embedding-3-small/large |

**Memory budget**: the server never loads a model that would exceed `availableMemory × (1 - overheadBuffer)`. It steps down through quantizations (q8_0 → q6_k → q4_k_m) and then from 8B to 4B. Minimum is 4-bit quantization; if nothing fits, it exits with a clear error suggesting OpenAI fallback.

## Vault Structure

```
~/Documents/my-engram-vault/
├── IMPORTANT.md                                   ← persistent user profile
├── .dilucidate-meta.json                          ← /dilucidate run history
├── 2026-04-29/
│   └── Rust Async Runtime — Design Decisions.md  ← human-readable filenames
├── 2026-04-28/
│   └── Homelab Network Architecture.md
└── ...
```

Each Engram is a standard markdown file with YAML frontmatter and `[[wikilinks]]` to related memories — fully readable in Obsidian, including graph view.

```yaml
---
id: "3f7a2c1d-..."         ← stable UUID; survives renames
abstract: "A 3–6 sentence summary of the engram's key content, written in
  English. Enables cheap full-vault scanning via list_engrams without
  reading every file body."
title: "Rust Async Runtime — Design Decisions"
date: "2026-04-29"
type: "decision"
tags: ["rust", "architecture"]
---

Engram content here.

## Related Memories
- [[2026-04-28/Homelab Network Architecture]]
```

Filenames preserve spaces, capitals, and symbols — anything valid on macOS and Windows. The UUID in frontmatter is the stable identity used by ChromaDB; the filename is purely for human readability. The `abstract` field lets skills scan the entire vault cheaply — `list_engrams` returns it without reading file bodies, so skills like `/update-important-memory` and `/dilucidate` can make a first-pass decision without calling `read_engram` on every file. Obsidian's built-in rename handling keeps `[[wikilinks]]` consistent when files are moved or renamed.
