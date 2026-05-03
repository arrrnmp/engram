# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Engram is a multimodal AI memory database. Memories are saved as markdown files in an Obsidian vault (at arbitrary folder depths), embedded via Qwen3-VL-Embedding-2B into ChromaDB, and retrieved through an MCP server. The vault is fully readable in Obsidian including graph view via `[[wikilinks]]`. The file watcher enables bidirectional sync — edits in Obsidian are automatically re-indexed.

## Commands

```bash
bun scripts/setup.ts                  # Interactive onboarding — checks prerequisites, detects hardware, sets up config
bun scripts/migrate.ts                # Re-embed all engrams after model/dimension changes
bun run start                          # Starts ChromaDB + embedding server + caption server (if configured) + Engram server
bun run re-embed                       # Same, but forces re-embedding of ALL vault files (markdown + media)
bun scripts/start.ts --re-embed        # Direct invocation with full re-embed flag
bun scripts/start.ts --re-embed-md     # Re-embed markdown files only
bun scripts/start.ts --re-embed-pdf    # Re-embed PDF/Office files only
cd server && bun run dev               # Dev server with --watch
cd server && bun test                  # Run test suite
```

There is no lint or typecheck command configured.

## Architecture

```
Obsidian Vault (any/folder/path/title.md)
      ↕ read/write + file watcher
  Engram MCP Server (Bun, HTTP/HTTPS, default port 7384)
      ↕ embed / search
    ChromaDB (port 8000)
      ↑
  vLLM / MLX server (port 8001) — Qwen3-VL-Embedding-2B (text, images, video, PDFs)
      ↑ (optional, for captioning)
  Caption server (port 8002) — MLX-LM (macOS) or llama.cpp (Windows/Linux) with vision model
```

### Server entry point

`server/src/index.ts` — Bun HTTP server with session-based MCP transport. Each MCP client gets its own `McpServer` + `WebStandardStreamableHTTPServerTransport` pair, keyed by session ID. The expensive singletons (embedder, ChromaDB client, vault, vaultIndex, bodyHashRegistry, mediaCache) are shared across sessions. The server expects a healthy embedding endpoint; `bun run start` bootstraps this automatically.

On startup, after ChromaDB is ready, the server builds the `VaultIndex`, runs a dimension validation check, loads the body hash registry, and runs a re-index pass: any engram present in the vault but missing from ChromaDB is re-embedded and upserted. After re-index, the file watcher starts monitoring vault changes.

### Key modules (all in `server/src/`)

| Module | Purpose |
|---|---|
| `config.ts` | Zod-validated config loading from `config.json` / `config.local.json`. Embedding config includes `vllm.host`, optional quant override, batch controls, and query cache size. Optional `captioning` block supports provider/host/model/prompt, generation params (temperature, topP, topK, minP, presencePenalty, repetitionPenalty, think, extraBody), and fallback settings. |
| `vault.ts` | Reads/writes markdown files (`Vault` class, `formatEngram`, `parseEngram`, `updateEngramWikilinks`, `toSlug`). Uses `gray-matter` for YAML frontmatter parsing — no raw regex. `formatEngram` accepts optional `tags` parameter. All file operations use vault-relative paths. |
| `vault-index.ts` | `VaultIndex` — recursive scan builds UUID→relativePath map with reverse lookup. UUID collision detection reassigns duplicates via `matter.stringify`. `resolveWithFallback` handles mid-session renames. Skips `.` hidden dirs and `_chunks/` sentinel path. |
| `chroma.ts` | `EngramChroma` class — upsert, search, list, delete, `getAllIds`, `getAllWithEmbeddings`, `patchMetadata`, `searchByEmbedding`, `getDimensions`. Metadata includes `relativePath` and optional `parentEngramId` (for chunk entries). |
| `wikilinks.ts` | Bidirectional `[[wikilinks]]` between semantically similar engrams. Wiki paths derived from `relativePath`. |
| `embeddings/index.ts` | Provider factory — `createEmbeddingProvider()` connects to vLLM with health check and hardware-aware quantization selection |
| `embeddings/qwen-vl.ts` | `QwenVLProvider` — multimodal embedding via vLLM `/v1/embeddings`. Supports text, images, video, PDFs. 2048-dim output. |
| `embeddings/cache.ts` | `LRUEmbeddingCache` — in-process LRU cache for query embeddings. Size configurable via `embedding.queryCacheSize` |
| `embeddings/batch.ts` | `batchEmbedTexts()` — shared batched text embedding helper used by startup re-indexing, watcher, and media processing |
| `embeddings/types.ts` | `EmbeddingProvider` interface with `embed(string | MultimodalInput)`, `capabilities()`, `expectedDimensions()` |
| `hardware/detect.ts` | Detects Apple Silicon, NVIDIA (Blackwell vs older), or CPU |
| `hardware/memory.ts` | GGUF memory planner and selector (`q8_0` → `q6_k` → `q5_k_m` → `q4_k_m`) plus derived embedding batch limits |
| `body-hash.ts` | `BodyHashRegistry` — SHA256 body hash dedup. Stored in `.engram-body-hashes.json` at vault root. |
| `media-processor.ts` | Multimodal file processing (PDF, Office, images, video). PDF: mutool screenshot per page (200 DPI) + pdfjs text extraction; each page produces two embeddings — image (visual) and text (semantic). `imageEmbedding` may be null if embedding server doesn't support multimodal input. Office: LibreOffice → PDF → same pipeline. `PdfPageResult` has `imageEmbedding` (nullable), `textEmbedding`, and `extractedText`. |
| `media-cache.ts` | `MediaCache` — in-process cache for media processing to avoid redundant work. Persists to `.engram-media-cache.json`. |
| `captioning.ts` | `captionImage()` — caption generation via OpenAI-compatible `/v1/chat/completions` to the local caption server. Configurable generation params (temperature, topP, topK, etc.). Returns caption or `null` on failure. |
| `scripts/ensure-chroma.ts` | Ensures ChromaDB is reachable on port 8000; starts detached `uv run chroma run` when absent. |
| `scripts/ensure-embed-server.ts` | Ensures embedding server is reachable on port 8001; launches MLX server on Apple Silicon or vLLM with hardware-aware model args elsewhere. |
| `scripts/ensure-caption-server.ts` | Ensures captioning backend: launches MLX-LM server on macOS or llama.cpp server on Windows/Linux. Verifies the server responds correctly on startup; exits with error if port 8002 is occupied by a stale process. |
| `startup.ts` | Startup orchestration — `validateDimensions`, `runStartupReindex`, `populateBodyHashRegistry`. Extracted from `index.ts` for testability. Handles UUID assignment for new files, metadata sync for renames, force re-embed, and body-hash registry population. |
| `watcher.ts` | `startVaultWatcher()` — Bun `fs.watch` recursive with 200ms debounce. Handles `.md` upsert/delete with UUID assignment, collision detection, body hash dedup. Media file support via media cache. Image captioning when `config.captioning` is set. |
| `search/keyword.ts` | In-process keyword search with two-pass filtering (cheap title/abstract pass + full body read). Tokenizes with stop-word removal, scores with title weighting (2×), anchors excerpt at first body match. |
| `dilucidate/cluster.ts` | Core clustering algorithm. ≤300 engrams: exact O(n²) pairwise cosine similarity. >300 engrams: O(n·k) neighbor search. Connected-components BFS + missing wikilink detection |
| `tools/save-memory.ts` | Generates UUID, embeds content, writes engram to configurable folder, upserts to ChromaDB. Optional `folder` parameter for vault-relative path. |
| `tools/search-memory.ts` | Search with `mode`: `"semantic"`, `"keyword"`, `"hybrid"`. LRU cache skips re-embedding repeated queries. `caller` param for reranker integration. Surfaces `isChunk`/`parentEngramId` for chunk results. |
| `tools/read-engram.ts` | Returns structured `EngramContent { id, title, date, type?, tags, body, wikilinks }` via `extractEngramContent` helper |
| `tools/read-engrams.ts` | Batch read tool — up to 20 UUIDs in one call. 80K char response size guard with truncation. |
| `tools/update-engram.ts` | Updates in-place: `setAbstract`, `setContent` (re-embeds), `editContent` (targeted string replacement, re-embeds), `addTags`, `addWikilinks`. Shared `reformatEngram` helper. Warns about stale chunks when content is updated. |
| `tools/delete-engram.ts` | Permanently deletes — removes vault file, ChromaDB entry, VaultIndex entry, body hash |
| `tools/list-engrams.ts` | Lists from vault with frontmatter-parsed titles, IDs, abstracts, types, relativePaths |
| `tools/vault-structure.ts` | `getVaultStructure()` — directory tree with depth limiting. `sanitizeFolderPath()` with path traversal protection. |
| `tools/chunk-engram.ts` | `chunk_engram` MCP tool — splits long engrams into individually-embedded segments. Modes: `create` (errors if chunks exist), `re-embed` (deletes old + recreates). Separators: `paragraph`, `sentence`, `none` (fixed-size). Stores chunk index in `.engram-chunks/{id}.json`. Each chunk has `type: "chunk"` and `parentEngramId` in ChromaDB. |
| `tools/context.ts` | Read/write IMPORTANT.md |
| `tools/dilucidate/cluster.ts` | `cluster_memories` MCP tool — wraps the clustering algorithm |
| `tools/dilucidate-meta.ts` | Structured read/write `.dilucidate-meta.json` — server-side merge with 50-entry history cap |
| `logger.ts` | Winston logger → console + `logs/engram.log` + `logs/error.log` |

### Architectural patterns

- **Session-based MCP transport**: Each client gets isolated `McpServer` + `WebStandardStreamableHTTPServerTransport` pairs, sharing expensive singletons (embedder, ChromaDB, vault, vaultIndex, bodyHashRegistry)
- **UUID-based identity**: Stable IDs in frontmatter survive renames; VaultIndex maintains UUID↔relativePath bidirectional mapping
- **Dual storage strategy**: Abstract stored in both vault frontmatter and ChromaDB metadata for scalability (no body reads needed for list/search)
- **Body hash deduplication**: SHA256 registry prevents duplicate embeddings; handles file watcher self-triggering
- **Two-mode clustering**: O(n²) exact for ≤300 engrams, O(n·k) approximate (K=15 neighbors) for larger vaults
- **Hybrid search**: Semantic (vector), keyword (exact terms), or hybrid (0.7×semantic + 0.3×keyword merge) with LRU cache on query embeddings
- **Hardware-aware quantization**: Auto-selects model variant based on platform (Apple Silicon → MLX, NVIDIA Blackwell → NVFP4, older NVIDIA → GGUF cascade, CPU fallback)
- **Wikilink backlink generation**: When linking A→B, also writes B→A backlink to both files

### Complexity hotspots

1. **Startup re-indexing** (`startup.ts` — `runStartupReindex`): Multi-phase orchestration handling UUID assignment, missing files, and path/title drift. Multiple code paths interacting with vault, ChromaDB, vaultIndex.
2. **File watcher upsert** (`watcher.ts` handleMdUpsert): Implicit state machine with branches for UUID assignment, rename detection, collision, and dedup.
3. **PDF processing** (`media-processor.ts` processPdf): Two embeddings per page — text (pdfjs extraction, always present) and image (mutool draw at 200 DPI, may be null if embedding server doesn't support multimodal). ChromaDB gets two entries per page: `{hash}-page-{N}-txt` (text embedding) and `{hash}-page-{N}` (image embedding, only if `imageEmbedding` succeeded). Both entries store `extractedText` in `content`/`abstract` for keyword search and readable excerpts.
4. **Clustering wikilink detection** (`dilucidate/cluster.ts`): Combines BFS, similarity thresholding, and vault file reads. Vault read for every pair in cluster is performance-sensitive.

### Data flow for `save_memory`

1. `crypto.randomUUID()` — generates a stable ID stored in frontmatter
2. `embedder.embed(content, { taskInstruction })` — single embedding of the body text with retrieval prefix
3. `generateAndApplyWikilinks(chromaId, wikiPath, ...)` — searches ChromaDB for similar engrams, writes backlinks
4. `vault.writeEngram(dir, title, content)` — writes markdown with YAML frontmatter + `## Related Memories` section. `dir` is either the `folder` param or today's date.
5. `vaultIndex.set(id, { relativePath })` — registers in the vault index
6. `chroma.upsert()` — indexes embedding + metadata (including `relativePath`) in ChromaDB

### Engram identity

Each engram has a **UUID** stored in its frontmatter (`id: "..."`). This is the stable identity used by ChromaDB and all MCP tools. The **relativePath** (vault-relative file path) is the canonical location reference used by all tools. Wikilinks use vault paths (`[[folder/filename]]`) so Obsidian's graph view stays human-readable.

Each engram carries an **abstract** in frontmatter — a required paragraph summarising the key content. Stored in both vault and ChromaDB metadata. `list_engrams` returns it from the vault; `search_memory` returns it from ChromaDB. This dual storage is the primary scalability mechanism.

### Config resolution

`loadConfig()` searches in order: `config.local.json` (cwd), `config.json` (cwd), then parent directory. The server runs from `server/` so both `server/config.json` and root `config.json` work. Copy `config.example.json` to `config.json` to start. All defaults are defined in the Zod schema in `config.ts`.

The Zod schema also defines `server` (port, HTTPS certs), `chroma` (host, collection name), `wikilinks` (similarity threshold, max links), `watcher` (enabled toggle, LibreOffice path), and `embedding` batch controls (`batchSize`, `batchMaxChars`, `overheadBuffer`).

### Skills

Skills live in `skills/` — each is a directory with a `SKILL.md` defining the skill's behavior. They are symlinked into agent tool configs by `scripts/setup.ts`. Key constraints from the skill frontmatter:

- `save-memory`, `prefill`, `update-important-memory`, `dilucidate`: **user-invocable only** (`disable-model-invocation: true`). The model must never run these automatically.
- `surface-memories`: **agent-only, auto-triggered** (`user-invocable: false`). Silently searches for relevant context when a conversation touches a known topic.

All skill output — engram content, IMPORTANT.md, search queries — is enforced in **English** regardless of conversation language, for consistent embedding alignment.

### External dependencies

- **ChromaDB**: Python venv managed by `uv` (see `pyproject.toml`). Data stored in `.chroma-data/`.
- **Embedding server**: Qwen3-VL-Embedding-2B (2048-dim, multimodal) served via MLX on Apple Silicon or vLLM elsewhere. `bun run start` bootstraps it; direct `server/src/index.ts` runs require it to already be reachable.
- **Caption server**: MLX-LM (`python -m mlx_lm.server`) on macOS or `llama-server` on Windows/Linux. Serves vision models for image captioning via OpenAI-compatible API on port 8002. Optional — when absent, image filenames are used as fallback content.
- **Bun**: Runtime for the MCP server. No Node.js dependency.

## Runtime: Bun, not Node

This project uses Bun exclusively. Use Bun APIs directly (`Bun.spawn`, `Bun.file`, `Bun.serve`, `import.meta.dir`). The tsconfig targets ESNext with `bun-types`.

## Testing

Tests use Bun's built-in test runner (`bun:test`) — no additional framework. Run `cd server && bun test`.

- **`server/src/__tests__/helpers/mocks.ts`** — mock factories for `EmbeddingProvider`, `EngramChroma`, `Vault`, `VaultIndex`. Tool handler tests pass these as deps via the existing DI pattern.
- **`server/src/__tests__/fixtures/`** — sample engram markdown files for parsing tests.
- Test files are co-located in `server/src/__tests__/` — one file per module under test.

**What to test:** Pure functions (`vault.ts` parsing/formatting, `cache.ts`, `cluster.ts` math, `memory.ts` model selection), tool handlers with mocked deps, config schema validation, edge cases.

**What not to test:** `index.ts` (wiring), embedding provider HTTP clients, `hardware/detect.ts` (platform-specific). These are thin wrappers where unit tests add no confidence.

### Test coverage

**Strengths**: LRU cache, clustering algorithm, search-memory, media processing, keyword search

**Gaps**:
- Error recovery: Network errors, file corruption
- Concurrent access: File watcher + tool call race conditions
- Media processing: PDF/Office conversion edge cases
- `tools/list-engrams.ts` and `tools/context.ts`: Basic read/list handlers without dedicated tests
