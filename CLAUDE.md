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
cd server && bun test      # Run test suite
```

There is no lint or typecheck command configured.

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

`server/src/index.ts` — Bun HTTP server with session-based MCP transport. Each MCP client gets its own `McpServer` + `WebStandardStreamableHTTPServerTransport` pair, keyed by session ID. The expensive singletons (embedder, ChromaDB client, vault, vaultIndex) are shared across sessions. The server auto-starts Ollama if it's not running (when not using OpenAI).

On startup, after ChromaDB is ready, the server builds the `VaultIndex` and runs a re-index pass: any engram present in the vault but missing from ChromaDB is re-embedded and upserted. This makes the system self-healing after renames, fresh clones, or partial data loss.

### Key modules (all in `server/src/`)

| Module | Purpose |
|---|---|
| `config.ts` | Zod-validated config loading from `config.json` / `config.local.json` |
| `vault.ts` | Reads/writes markdown files (`Vault` class, `formatEngram`, `parseEngram`, `updateEngramWikilinks`, `toSlug`). Uses `gray-matter` for YAML frontmatter parsing — no raw regex. `formatEngram` accepts optional `tags` parameter. |
| `vault-index.ts` | `VaultIndex` — scans vault frontmatter at startup to build a UUID→filepath map; `resolveWithFallback` handles mid-session renames and deletes stale ChromaDB entries for missing files |
| `chroma.ts` | `EngramChroma` class — upsert, search, list, delete, `getAllIds`, `getAllWithEmbeddings` |
| `wikilinks.ts` | Bidirectional `[[wikilinks]]` between semantically similar engrams. Takes `chromaId` (UUID, for self-exclusion) and `wikiPath` (date/filename, for link text) as separate params |
| `embeddings/index.ts` | Provider factory — `createEmbeddingProvider()` dispatches to Ollama, NVIDIA vLLM, or OpenAI based on config + hardware |
| `embeddings/cache.ts` | `LRUEmbeddingCache` — in-process LRU cache for query embeddings. Used by `search_memory` to skip re-embedding repeated queries. Size configurable via `embedding.queryCacheSize` |
| `embeddings/ollama.ts` | Ollama `/api/embed` client |
| `embeddings/openai-compat.ts` | OpenAI `/v1/embeddings` client (also used for NVIDIA vLLM) |
| `hardware/detect.ts` | Detects Apple Silicon, NVIDIA (Blackwell vs older), or CPU |
| `hardware/memory.ts` | Steps through model variants (8B→4B, q8→q4) to fit available memory |
| `dilucidate/cluster.ts` | Core clustering algorithm — pairwise cosine similarity, connected-components BFS, missing wikilink detection |
| `tools/save-memory.ts` | Generates UUID, embeds content, writes engram, upserts to ChromaDB |
| `tools/search-memory.ts` | Semantic search with optional date/type filter. Accepts optional `LRUEmbeddingCache` to skip re-embedding repeated queries |
| `tools/read-engram.ts` | Resolves UUID via VaultIndex, reads file |
| `tools/list-engrams.ts` | Lists engrams from vault with frontmatter-parsed titles, IDs, and abstracts — no file body reads |
| `tools/update-engram.ts` | Updates an existing engram in-place: `setAbstract`, `addTags`, `setContent` (re-embeds), `addWikilinks`. Uses `gray-matter` for parse→mutate→reformat via `formatEngram` |
| `tools/context.ts` | Read/write IMPORTANT.md |
| `tools/dilucidate/cluster.ts` | `cluster_memories` MCP tool — wraps the clustering algorithm |
| `tools/dilucidate-meta.ts` | Read/write `.dilucidate-meta.json` for `/dilucidate` run state |
| `logger.ts` | Winston logger → console + `logs/engram.log` + `logs/error.log` |

### Data flow for `save_memory`

1. `crypto.randomUUID()` — generates a stable ID stored in frontmatter
2. `embedder.embed(content)` — single embedding of the body text
3. `generateAndApplyWikilinks(chromaId, wikiPath, ...)` — searches ChromaDB for similar engrams, writes backlinks into existing vault files using vault paths (not UUIDs)
4. `vault.writeEngram()` — writes markdown with YAML frontmatter (`id`, `abstract`, `title`, `date`, `type`, `tags`) + `## Related Memories` section
5. `chroma.upsert()` — indexes embedding + metadata in ChromaDB, keyed by UUID

Note: `abstract` lives only in the vault frontmatter, not in ChromaDB. It is returned by `list_engrams` from a direct file scan, enabling cheap full-vault passes without `read_engram` calls.

### Engram identity

Each engram has a **UUID** stored in its frontmatter (`id: "..."`). This is the stable identity used by ChromaDB and all MCP tools. Filenames use the title as-is (spaces, capitals, and symbols preserved — only filesystem-invalid characters stripped). Wikilinks use vault paths (`[[date/filename]]`) so Obsidian's graph view stays human-readable. Because the UUID lives inside the file, Obsidian can rename files freely without breaking the index.

Each engram also carries an **abstract** in frontmatter — a required paragraph (3–6 sentences) summarising the key content. The abstract is returned by `list_engrams` from a direct frontmatter scan, allowing skills to do a full-vault first pass without calling `read_engram` on every file. This is the primary scalability mechanism for skills like `/update-important-memory` and `/dilucidate`.

### Config resolution

`loadConfig()` searches in order: `config.local.json` (cwd), `config.json` (cwd), then parent directory. The server runs from `server/` so both `server/config.json` and root `config.json` work. Copy `config.example.json` to `config.json` to start. All defaults are defined in the Zod schema in `config.ts`.

### Skills

Skills live in `skills/` — each is a directory with a `SKILL.md` defining the skill's behavior. They are symlinked into agent tool configs by `scripts/setup.ts`. Key constraints from the skill frontmatter:

- `save-memory`, `prefill`, `update-important-memory`, `dilucidate`: **user-invocable only** (`disable-model-invocation: true`). The model must never run these automatically.
- `surface-memories`: **agent-only, auto-triggered** (`user-invocable: false`). Silently searches for relevant context when a conversation touches a known topic.

All skill output — engram content, IMPORTANT.md, search queries — is enforced in **English** regardless of conversation language, for consistent embedding alignment.

### External dependencies

- **ChromaDB**: Python venv managed by `uv` (see `pyproject.toml`). Data stored in `.chroma-data/`.
- **Ollama**: Serves Qwen3-Embedding locally. The server auto-starts `ollama serve` if needed.
- **Bun**: Runtime for the MCP server. No Node.js dependency.

## Runtime: Bun, not Node

This project uses Bun exclusively. Use Bun APIs directly (`Bun.spawn`, `Bun.file`, `Bun.serve`, `import.meta.dir`). The tsconfig targets ESNext with `bun-types`.

## Testing

Tests use Bun's built-in test runner (`bun:test`) — no additional framework. Run `cd server && bun test`.

- **`server/src/__tests__/helpers/mocks.ts`** — mock factories for `EmbeddingProvider`, `EngramChroma`, `Vault`, `VaultIndex`. Tool handler tests pass these as deps via the existing DI pattern.
- **`server/src/__tests__/fixtures/`** — sample engram markdown files for parsing tests.
- Test files are co-located in `server/src/__tests__/` — one file per module under test.

**What to test:** Pure functions (`vault.ts` parsing/formatting, `cache.ts`, `cluster.ts` math, `memory.ts` model selection), tool handlers with mocked deps, config schema validation, edge cases.

**What not to test:** `index.ts` (wiring), embedding provider HTTP clients (`ollama.ts`, `openai-compat.ts`), `hardware/detect.ts` (platform-specific). These are thin wrappers where unit tests add no confidence.
