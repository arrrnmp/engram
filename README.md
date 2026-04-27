# Engram

Provider-agnostic AI memory database. Conversations are saved as dated markdown files in an Obsidian vault, embedded in a vector database, and retrieved via an MCP server that works with any MCP-compatible agent.

## Architecture

```
Obsidian Vault (YYYY-MM-DD/title.md)
       ↕ read/write
  Engram MCP Server (Bun, HTTP, port 7384)
       ↕ embed / search
    ChromaDB (port 8000)
       ↑
  Embedding Model (Qwen3-Embedding via Ollama / MLX / NVIDIA / OpenAI)
```

**Skills** (`/save-memory`, `/prefill`, `/update-important-memory`) are user-invokable only — the model never runs them automatically.

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
bun run start        # cross-platform
# or
./scripts/start.sh   # macOS / Linux
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

### 4. Connect your agent

Add to your MCP client config:

```json
{
  "mcpServers": {
    "engram": {
      "url": "http://localhost:7384/mcp"
    }
  }
}
```

### 5. Install skills

Copy the `skills/` directory to your agent's skills folder, or install via the agentskills registry.

## Skills

| Skill | Invoke | What it does |
|---|---|---|
| `save-memory` | `/save-memory` | Saves the conversation as an Engram with wikilinks |
| `prefill` | `/prefill` | Loads IMPORTANT.md into context |
| `update-important-memory` | `/update-important-memory` | Reviews all Engrams and rewrites IMPORTANT.md |

## MCP Tools

The server exposes these tools directly (used by skills internally):

| Tool | Description |
|---|---|
| `save_memory` | Write an Engram, embed it, generate wikilinks |
| `search_memory` | Semantic search across all Engrams |
| `get_important_context` | Read IMPORTANT.md |
| `update_important_context` | Write IMPORTANT.md |
| `list_engrams` | List Engrams by date range |

## Embedding Providers

The server auto-detects the best provider for your hardware:

| Hardware | Provider | Model |
|---|---|---|
| Apple Silicon | MLX server → Ollama+Metal fallback | Qwen3-Embedding |
| NVIDIA Blackwell (CC ≥ 10.0) | vLLM NVFP4 → Ollama CUDA fallback | Qwen3-Embedding |
| NVIDIA older / CPU | Ollama | Qwen3-Embedding |
| Override | OpenAI API | text-embedding-3-small/large |

**Memory budget**: the server never loads a model that would exceed `availableMemory × (1 - overheadBuffer)`. It steps down through quantizations (q8_0 → q6_k → q4_k_m) and then from 8B to 4B. Minimum is 4-bit quantization; if nothing fits, it exits with a clear error suggesting OpenAI fallback.

## Vault Structure

```
~/Documents/my-engram-vault/
├── IMPORTANT.md              ← persistent user profile
├── 2026-04-26/
│   └── engram-project-goals.md
├── 2026-04-25/
│   └── typescript-preferences.md
└── ...
```

Each Engram is a standard markdown file with YAML frontmatter and `[[wikilinks]]` to related memories — fully readable in Obsidian, including the graph view.
