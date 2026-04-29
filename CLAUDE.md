# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Engram is a provider-agnostic AI memory database. Conversations are saved as dated markdown files in an Obsidian vault, embedded via Qwen3-Embedding into ChromaDB, and retrieved through an MCP server. The vault is fully readable in Obsidian including graph view via `[[wikilinks]]`.

## Commands

```bash
bun scripts/setup.ts      # Interactive onboarding — checks prerequisites, detects hardware, sets up config
bun run start              # Starts ChromaDB + Engram server (cross-platform)
./scripts/start.sh         # Same, macOS/Linux only
cd server && bun run dev   # Dev server with --watch
```

There are no tests in this project. There is no lint or typecheck command configured.

## Architecture

```
Obsidian Vault (YYYY-MM-DD/title.md)
      ↕ read/write
  Engram MCP Server (Bun, HTTP/HTTPS, default port 7384)
      ↕ embed / search
    ChromaDB (port 8000)
      ↑
  Embedding Model (Qwen3-Embedding via Ollama / NVIDIA vLLM / OpenAI)
```

### Server entry point

`server/src/index.ts` — Bun HTTP server with session-based MCP transport. Each MCP client gets its own `McpServer` + `WebStandardStreamableHTTPServerTransport` pair, keyed by session ID. The expensive singletons (embedder, ChromaDB client, vault) are shared across sessions. The server auto-starts Ollama if it's not running (when not using OpenAI).

### Key modules (all in `server/src/`)

| Module | Purpose |
|---|---|
| `config.ts` | Zod-validated config loading from `config.json` / `config.local.json` |
| `vault.ts` | Reads/writes markdown files in the Obsidian vault (`Vault` class, `formatEngram`, `updateEngramWikilinks`, `toSlug`) |
| `chroma.ts` | `EngramChroma` class — upsert, search, and list with date/type filtering |
| `wikilinks.ts` | Auto-generates bidirectional `[[wikilinks]]` between semantically similar engrams |
| `embeddings/index.ts` | Provider factory — `createEmbeddingProvider()` dispatches to Ollama, NVIDIA vLLM, or OpenAI based on config + hardware |
| `embeddings/ollama.ts` | Ollama `/api/embed` client |
| `embeddings/openai-compat.ts` | OpenAI `/v1/embeddings` client (also used for NVIDIA vLLM) |
| `hardware/detect.ts` | Detects Apple Silicon, NVIDIA (Blackwell vs older), or CPU |
| `hardware/memory.ts` | Steps through model variants (8B→4B, q8→q4) to fit available memory |
| `tools/` | One file per MCP tool — `save-memory.ts`, `search-memory.ts`, `context.ts`, `list-engrams.ts`, `read-engram.ts` |
| `logger.ts` | Winston logger → console + `logs/engram.log` + `logs/error.log` |

### Data flow for `save_memory`

1. `embedder.embed(content)` — single embedding
2. `generateAndApplyWikilinks()` — searches ChromaDB for similar engrams, writes backlinks into existing files
3. `vault.writeEngram()` — writes markdown with YAML frontmatter + `## Related Memories` section
4. `chroma.upsert()` — indexes embedding + metadata in ChromaDB

### Config resolution

`loadConfig()` searches in order: `config.local.json` (cwd), `config.json` (cwd), then parent directory. The server runs from `server/` so both `server/config.json` and root `config.json` work. All defaults are defined in the Zod schema in `config.ts`.

### Skills

Skills live in `skills/` — each is a directory with a `SKILL.md` defining the skill's behavior. They are symlinked into agent tool configs by `scripts/setup.ts`. Key constraint from the skill frontmatter:

- `save-memory`, `prefill`, `update-important-memory`: **user-invocable only** (`disable-model-invocation: true`). The model must never run these automatically.
- `surface-memories`: **agent-only, auto-triggered** (`user-invocable: false`). Silently searches for relevant context when a conversation touches a known topic.

### External dependencies

- **ChromaDB**: Python venv managed by `uv` (see `pyproject.toml`). Data stored in `.chroma-data/`.
- **Ollama**: Serves Qwen3-Embedding locally. The server auto-starts `ollama serve` if needed.
- **Bun**: Runtime for the MCP server. No Node.js dependency.

## Runtime: Bun, not Node

This project uses Bun exclusively. Use Bun APIs directly (`Bun.spawn`, `Bun.file`, `Bun.serve`, `import.meta.dir`). The tsconfig targets ESNext with `bun-types`.
