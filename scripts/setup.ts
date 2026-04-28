#!/usr/bin/env bun
/**
 * Engram onboarding & prerequisite check.
 * Run with: bun scripts/setup.ts
 *
 * Self-contained — no imports from server/ so it works before deps are installed.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync,
  symlinkSync, cpSync, readdirSync, statSync, lstatSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { homedir, platform, arch, totalmem } from "os";
import { createInterface } from "readline";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";
const IS_LINUX = platform() === "linux";

// ── ANSI colours ─────────────────────────────────────────────────────────────
// Windows Terminal / PowerShell 7+ / all Unix TTYs understand ANSI.
// Fall back to plain text when not a TTY (CI pipes, etc.).
const tty = Boolean(process.stdout.isTTY);
const c = {
  reset: tty ? "\x1b[0m" : "",
  bold: tty ? "\x1b[1m" : "",
  dim: tty ? "\x1b[2m" : "",
  green: tty ? "\x1b[32m" : "",
  yellow: tty ? "\x1b[33m" : "",
  red: tty ? "\x1b[31m" : "",
  cyan: tty ? "\x1b[36m" : "",
  blue: tty ? "\x1b[34m" : "",
  gray: tty ? "\x1b[90m" : "",
};

const ok = `${c.green}✓${c.reset}`;
const fail = `${c.red}✗${c.reset}`;
const warn = `${c.yellow}!${c.reset}`;
const arrow = `${c.cyan}→${c.reset}`;

// ── readline helper ───────────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((res) => rl.question(q, res));

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await ask(`  ${c.cyan}?${c.reset} ${question} ${c.dim}${hint}${c.reset} `))
    .trim()
    .toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

// ── Platform helpers ──────────────────────────────────────────────────────────
function cmdExists(cmd: string): boolean {
  const check = IS_WIN ? "where" : "which";
  return spawnSync(check, [cmd], { stdio: "ignore" }).status === 0;
}

function runCapture(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function runInherit(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return r.status === 0;
}

// ── Hardware detection (inline — no server imports) ───────────────────────────
interface HW {
  label: string;
  availableGB: number;
  isAppleSilicon: boolean;
  isBlackwell: boolean;
  gpuName?: string;
  cc?: number;
}

function detectHW(): HW {
  // Apple Silicon
  if (IS_MAC && arch() === "arm64") {
    let totalGB = 8;
    const out = runCapture("sysctl", ["-n", "hw.memsize"]);
    if (out) totalGB = parseInt(out) / 1024 ** 3;
    return {
      label: `Apple Silicon (${totalGB.toFixed(0)} GB unified memory)`,
      availableGB: totalGB * 0.85,
      isAppleSilicon: true,
      isBlackwell: false,
    };
  }

  // NVIDIA
  const nvOut = runCapture("nvidia-smi", [
    "--query-gpu=name,memory.total,compute_cap",
    "--format=csv,noheader,nounits",
  ]);
  if (nvOut) {
    const [name, vramMB, ccStr] = nvOut.split(", ").map((s) => s.trim());
    const vramGB = parseInt(vramMB) / 1024;
    const cc = parseFloat(ccStr);
    return {
      label: `${name} (${vramGB.toFixed(1)} GB VRAM, CC ${cc})`,
      availableGB: vramGB,
      isAppleSilicon: false,
      isBlackwell: cc >= 10.0,
      gpuName: name,
      cc,
    };
  }

  // CPU / system RAM
  const ramGB = totalmem() / 1024 ** 3;
  return {
    label: `CPU (${ramGB.toFixed(0)} GB RAM)`,
    availableGB: ramGB * 0.7,
    isAppleSilicon: false,
    isBlackwell: false,
  };
}

// ── Model selection (mirrors server/src/hardware/memory.ts) ──────────────────
interface Variant {
  label: string;
  ollamaTag: string;
  vramGB: number;
  bits: number;
}

const VARIANTS: Variant[] = [
  { label: "8B q8_0",   ollamaTag: "qwen3-embedding:8b-q8_0",   vramGB: 8.5, bits: 8   },
  { label: "8B q6_k",   ollamaTag: "qwen3-embedding:8b-q6_k",   vramGB: 6.5, bits: 6   },
  { label: "8B q4_k_m", ollamaTag: "qwen3-embedding:8b-q4_k_m", vramGB: 4.7, bits: 4.5 },
  { label: "4B q8_0",   ollamaTag: "qwen3-embedding:4b-q8_0",   vramGB: 4.5, bits: 8   },
  { label: "4B q6_k",   ollamaTag: "qwen3-embedding:4b-q6_k",   vramGB: 3.5, bits: 6   },
  { label: "4B q4_k_m", ollamaTag: "qwen3-embedding:4b-q4_k_m", vramGB: 2.5, bits: 4.5 },
];

const OVERHEAD = 0.25;

function recommendModel(availableGB: number): Variant | null {
  const safeGB = availableGB * (1 - OVERHEAD);
  return VARIANTS.find((v) => v.vramGB <= safeGB && v.bits >= 4.0) ?? null;
}

// ── Config helpers ────────────────────────────────────────────────────────────
const CONFIG_PATH = join(ROOT, "config.json");

function loadRawConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

function getVaultPath(cfg: Record<string, unknown>): string | null {
  const v = (cfg as any)?.vault?.path;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function resolveVault(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(p);
}

// ── Ollama model check ────────────────────────────────────────────────────────
// Returns the model list on success, null if the server is unreachable.
// Tries 127.0.0.1 as a fallback when host uses "localhost", because Ollama
// binds to 127.0.0.1 only and Bun's fetch may resolve localhost → ::1 (IPv6).
async function getOllamaModels(host: string): Promise<string[] | null> {
  const candidates = host.includes("localhost")
    ? [host, host.replace("localhost", "127.0.0.1")]
    : [host];

  for (const h of candidates) {
    try {
      const res = await fetch(`${h}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { models: Array<{ name: string }> };
      return data.models.map((m) => m.name);
    } catch {
      continue;
    }
  }
  return null;
}

function normaliseTag(tag: string): string {
  return tag.includes(":") ? tag : `${tag}:latest`;
}

function modelPresent(models: string[], tag: string): boolean {
  const norm = normaliseTag(tag);
  return models.some(
    (m) => normaliseTag(m) === norm || m === tag || m.startsWith(`${tag}:`)
  );
}

// ── uv detection ─────────────────────────────────────────────────────────────
function uvInstallInstructions(): string {
  if (IS_WIN) return "powershell -c \"irm https://astral.sh/uv/install.ps1 | iex\"";
  return "curl -LsSf https://astral.sh/uv/install.sh | sh";
}

function chromaInVenv(): boolean {
  const r = spawnSync("uv", ["run", "--frozen", "python", "-c", "import chromadb"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  return r.status === 0;
}

function chromaVersion(): string | null {
  return runCapture("uv", ["run", "--frozen", "python", "-c", "import chromadb; print(chromadb.__version__)"]);
}

// ── HTTPS / mkcert helpers ────────────────────────────────────────────────────
const CERTS_DIR = join(ROOT, "certs");
const CERT_FILE = join(CERTS_DIR, "localhost.pem");
const KEY_FILE  = join(CERTS_DIR, "localhost-key.pem");

function mkcertInstallHint(): string {
  if (IS_MAC)   return "brew install mkcert";
  if (IS_WIN)   return "scoop install mkcert   (or: winget install FiloSottile.mkcert)";
  return "See https://github.com/FiloSottile/mkcert#linux";
}

function certsExist(): boolean {
  return existsSync(CERT_FILE) && existsSync(KEY_FILE);
}

// ── Tool integration helpers ──────────────────────────────────────────────────
const HOME        = homedir();
const SKILLS_SRC  = join(ROOT, "skills");

/** Platform-aware path to Claude Desktop's MCP config file. */
const CLAUDE_DESKTOP_CONFIG = (() => {
  if (IS_WIN) {
    const appData = process.env.APPDATA ?? join(HOME, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  if (IS_MAC) {
    return join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  // Linux
  return join(HOME, ".config", "Claude", "claude_desktop_config.json");
})();

interface ToolDef {
  id: string;
  label: string;
  installed(): boolean;
  skillsDir: string | null;
  mcpConfig: string | null;
  /** Override the default upsertMcpConfig when a tool uses a non-standard format. */
  upsertMcp?(mcpUrl: string): "added" | "updated" | "unchanged";
}

const TOOLS: ToolDef[] = [
  {
    id: "claude",
    label: "Claude Code",
    installed: () => cmdExists("claude"),
    skillsDir: join(HOME, ".claude", "skills"),
    // User-level MCP servers live in ~/.claude.json (top-level mcpServers key)
    mcpConfig: join(HOME, ".claude.json"),
    upsertMcp(mcpUrl) {
      const configPath = this.mcpConfig!;
      mkdirSync(dirname(configPath), { recursive: true });
      let existing: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        try { existing = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
      }
      const servers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
      const current = (servers.engram as { url?: string } | undefined)?.url;
      if (current === mcpUrl) return "unchanged";
      const wasPresent = current !== undefined;
      servers.engram = { type: "http", url: mcpUrl };
      existing.mcpServers = servers;
      writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
      return wasPresent ? "updated" : "added";
    },
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    // Detect by config dir presence (created on first launch) or app bundle on macOS.
    installed: () =>
      existsSync(dirname(CLAUDE_DESKTOP_CONFIG)) ||
      (IS_MAC && existsSync("/Applications/Claude.app")),
    // Claude Desktop is a chat app, not an agent CLI — no skills directory.
    skillsDir: null,
    mcpConfig: CLAUDE_DESKTOP_CONFIG,
    upsertMcp(mcpUrl) {
      // Claude Desktop only supports stdio servers. mcp-remote bridges the gap
      // by spawning as a stdio child process that proxies to the HTTP MCP endpoint.
      const configPath = this.mcpConfig!;
      mkdirSync(dirname(configPath), { recursive: true });
      let existing: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        try { existing = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
      }
      const servers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
      const entry = servers.engram as { args?: string[] } | undefined;
      const currentUrl = entry?.args?.[1];
      if (currentUrl === mcpUrl) return "unchanged";
      const wasPresent = currentUrl !== undefined;
      servers.engram = { command: "npx", args: ["mcp-remote", mcpUrl] };
      existing.mcpServers = servers;
      writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
      return wasPresent ? "updated" : "added";
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    installed: () => cmdExists("cursor") || existsSync(join(HOME, ".cursor")),
    skillsDir: join(HOME, ".cursor", "skills"),
    mcpConfig: join(HOME, ".cursor", "mcp.json"),
  },
  {
    id: "opencode",
    label: "OpenCode",
    installed: () => cmdExists("opencode"),
    skillsDir: join(HOME, ".opencode", "skills"),
    // OpenCode config lives at ~/.config/opencode/opencode.json, uses "mcp" key
    mcpConfig: join(HOME, ".config", "opencode", "opencode.json"),
    upsertMcp(mcpUrl) {
      const configPath = this.mcpConfig!;
      mkdirSync(dirname(configPath), { recursive: true });
      let existing: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        try { existing = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
      }
      const mcp = (existing.mcp as Record<string, unknown> | undefined) ?? {};
      const current = (mcp.engram as { url?: string } | undefined)?.url;
      if (current === mcpUrl) return "unchanged";
      const wasPresent = current !== undefined;
      mcp.engram = { type: "remote", url: mcpUrl, enabled: true };
      existing.mcp = mcp;
      writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
      return wasPresent ? "updated" : "added";
    },
  },
  {
    id: "gh-copilot",
    label: "GitHub Copilot CLI",
    installed: () => cmdExists("copilot"),
    // Copilot CLI uses a plugin system for skills, not a directory
    skillsDir: null,
    // Copilot CLI MCP config lives at ~/.copilot/mcp-config.json
    mcpConfig: join(HOME, ".copilot", "mcp-config.json"),
    upsertMcp(mcpUrl) {
      const configPath = this.mcpConfig!;
      mkdirSync(dirname(configPath), { recursive: true });
      let existing: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        try { existing = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
      }
      const servers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
      const current = (servers.engram as { url?: string } | undefined)?.url;
      if (current === mcpUrl) return "unchanged";
      const wasPresent = current !== undefined;
      servers.engram = { type: "http", url: mcpUrl, headers: {}, tools: ["*"] };
      existing.mcpServers = servers;
      writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
      return wasPresent ? "updated" : "added";
    },
  },
];

const RERUN = process.argv.includes("--rerun");

function installSkills(destDir: string): { installed: string[]; skipped: string[] } {
  mkdirSync(destDir, { recursive: true });
  const installed: string[] = [];
  const skipped: string[] = [];

  const skillNames = readdirSync(SKILLS_SRC).filter((s) =>
    statSync(join(SKILLS_SRC, s)).isDirectory()
  );

  for (const skill of skillNames) {
    const src  = resolve(join(SKILLS_SRC, skill));
    const dest = join(destDir, skill);

    if (existsSync(dest)) {
      if (!RERUN) {
        skipped.push(skill);
        continue;
      }
      // --rerun: remove existing entry so we can re-create it below
      rmSync(dest, { recursive: true, force: true });
    }

    try {
      if (IS_WIN) {
        // Symlinks require elevated rights on Windows — copy instead.
        cpSync(src, dest, { recursive: true });
      } else {
        symlinkSync(src, dest);
      }
      installed.push(skill);
    } catch {
      skipped.push(skill);
    }
  }
  return { installed, skipped };
}

function upsertMcpConfig(
  configPath: string,
  mcpUrl: string
): "added" | "updated" | "unchanged" {
  mkdirSync(dirname(configPath), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try { existing = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
  }

  const servers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
  const current = (servers.engram as { url?: string } | undefined)?.url;

  if (current === mcpUrl) return "unchanged";
  const wasPresent = current !== undefined;
  servers.engram = { url: mcpUrl };
  existing.mcpServers = servers;
  writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  return wasPresent ? "updated" : "added";
}

// ── Section printer ───────────────────────────────────────────────────────────
function section(title: string): void {
  console.log(`\n${c.bold}${c.blue}${title}${c.reset}`);
}

function row(icon: string, msg: string, detail?: string): void {
  const d = detail ? `  ${c.gray}${detail}${c.reset}` : "";
  console.log(`  ${icon} ${msg}${d}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(
    `\n${c.bold}${c.cyan}╔══════════════════════════════════╗${c.reset}`
  );
  console.log(
    `${c.bold}${c.cyan}║        Engram Setup Check        ║${c.reset}`
  );
  console.log(
    `${c.bold}${c.cyan}╚══════════════════════════════════╝${c.reset}\n`
  );

  const issues: string[] = [];

  // ── 1. Bun ──────────────────────────────────────────────────────────────────
  section("Runtime");
  const bunVersion = runCapture("bun", ["--version"]);
  if (bunVersion) {
    row(ok, `Bun ${bunVersion}`);
  } else {
    row(fail, "Bun not found");
    issues.push("Install Bun from https://bun.sh");
  }

  // ── 2. Platform & hardware ──────────────────────────────────────────────────
  section("Hardware");
  const platformLabel = IS_MAC ? "macOS" : IS_WIN ? "Windows" : "Linux";
  row(ok, `${platformLabel} ${arch()}`);

  const hw = detectHW();
  row(ok, hw.label);

  const recommended = recommendModel(hw.availableGB);
  if (recommended) {
    row(
      arrow,
      `Recommended model: ${c.bold}${recommended.label}${c.reset}`,
      `${recommended.vramGB} GB · ${recommended.bits}-bit · tag: ${recommended.ollamaTag}`
    );
  } else {
    row(
      warn,
      "Insufficient memory for any 4-bit+ model",
      "Consider setting embedding.provider = \"openai\" in config.json"
    );
    issues.push(
      `Not enough memory for local embeddings. Add OpenAI API key to config.json.`
    );
  }

  // ── 3. config.json ──────────────────────────────────────────────────────────
  section("Configuration");
  let cfg = loadRawConfig();

  if (!existsSync(CONFIG_PATH)) {
    row(warn, "config.json not found — creating from defaults");
    cfg = {
      vault: { path: "~/Documents/engram-vault" },
      server: { port: 7384 },
      chroma: { host: "http://localhost:8000", collection: "engrams" },
      embedding: { provider: "auto", overheadBuffer: 0.25 },
    };
  } else {
    row(ok, "config.json found");
  }

  let vaultPath = getVaultPath(cfg);
  const defaultVault = `~/Documents/engram-vault`;

  if (!vaultPath || vaultPath === defaultVault) {
    const input = await ask(
      `  ${c.cyan}?${c.reset} Vault path ${c.dim}[${defaultVault}]${c.reset} `
    );
    vaultPath = input.trim() || defaultVault;

    // Deep-merge vault path into config
    if (typeof cfg !== "object" || cfg === null) cfg = {};
    (cfg as any).vault = { ...((cfg as any).vault ?? {}), path: vaultPath };

    // Ensure vault directory exists
    try {
      mkdirSync(resolveVault(vaultPath), { recursive: true });
    } catch {
      // Ignore — might already exist or path has env vars
    }

    saveConfig(cfg as Record<string, unknown>);
    row(ok, `Vault path set: ${c.bold}${vaultPath}${c.reset}`);
  } else {
    row(ok, `Vault path: ${c.bold}${vaultPath}${c.reset}`);
    const resolved = resolveVault(vaultPath);
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true });
      row(arrow, `Created vault directory: ${resolved}`);
    }
  }

  // ── 4. Ollama ───────────────────────────────────────────────────────────────
  section("Ollama (local embeddings)");

  const cfg2 = loadRawConfig() as any;
  const ollamaHost: string = cfg2?.embedding?.ollama?.host ?? "http://localhost:11434";

  if (!cmdExists("ollama")) {
    row(fail, "Ollama not installed");
    const installUrl = IS_WIN
      ? "https://ollama.com/download/windows"
      : IS_MAC
      ? "https://ollama.com/download/mac"
      : "https://ollama.com/download/linux";
    issues.push(`Install Ollama from ${installUrl}`);

    if (recommended) {
      issues.push(
        `Then pull the embedding model:\n    ollama pull ${recommended.ollamaTag}`
      );
    }
  } else {
    row(ok, "Ollama installed");

    const models = await getOllamaModels(ollamaHost);

    if (models === null) {
      row(warn, `Ollama server not reachable at ${ollamaHost}`);
      row(arrow, "Start Ollama and re-run, or start it now in a separate terminal:");
      console.log(`      ${c.dim}ollama serve${c.reset}`);
      issues.push("Start Ollama before running Engram: `ollama serve`");
    } else {
      row(ok, `Ollama running at ${ollamaHost}`);

      if (recommended) {
        if (modelPresent(models, recommended.ollamaTag)) {
          row(ok, `Model present: ${recommended.ollamaTag}`);
        } else {
          row(warn, `Model not found: ${recommended.ollamaTag}`);
          console.log(
            `     ${c.gray}(${recommended.vramGB} GB download)${c.reset}`
          );

          const doPull = await confirm(
            `Pull ${c.bold}${recommended.ollamaTag}${c.reset} now?`
          );
          if (doPull) {
            console.log();
            const success = runInherit("ollama", ["pull", recommended.ollamaTag]);
            if (success) {
              row(ok, `Model pulled: ${recommended.ollamaTag}`);
            } else {
              row(fail, `Pull failed`);
              issues.push(
                `Manually pull the model: ollama pull ${recommended.ollamaTag}`
              );
            }
          } else {
            issues.push(
              `Pull the embedding model before starting:\n    ollama pull ${recommended.ollamaTag}`
            );
          }
        }
      } else {
        row(
          warn,
          "No recommended model (memory too low) — skipping model check"
        );
      }
    }
  }

  // ── 5. ChromaDB (via uv + venv) ──────────────────────────────────────────────
  section("ChromaDB");

  if (!cmdExists("uv")) {
    row(fail, "uv not found");
    issues.push(
      `Install uv (fast Python package manager):\n    ${uvInstallInstructions()}`
    );
  } else {
    const uvVersion = runCapture("uv", ["--version"]);
    row(ok, `uv ${uvVersion ?? ""}`);

    const venvExists = existsSync(join(ROOT, ".venv"));

    if (venvExists && chromaInVenv()) {
      const ver = chromaVersion();
      row(ok, `chromadb ${ver ?? ""} (venv)`);
    } else {
      if (!venvExists) {
        row(warn, ".venv not found");
      } else {
        row(warn, "chromadb not installed in venv");
      }
      const doSync = await confirm("Run uv sync to create venv and install deps?");
      if (doSync) {
        console.log();
        const success = runInherit("uv", ["sync"]);
        if (success) {
          const ver = chromaVersion();
          row(ok, `chromadb ${ver ?? ""} installed into .venv`);
        } else {
          row(fail, "uv sync failed");
          issues.push("Run `uv sync` manually from the repo root");
        }
      } else {
        issues.push("Run `uv sync` from the repo root to set up ChromaDB");
      }
    }
  }

  // ── 6. Server dependencies ───────────────────────────────────────────────────
  section("Server dependencies");

  const serverDir = join(ROOT, "server");
  const nodeModules = join(serverDir, "node_modules");

  if (existsSync(nodeModules)) {
    row(ok, "server/node_modules present");
  } else {
    row(arrow, "Running bun install in server/...");
    const success = spawnSync("bun", ["install"], {
      cwd: serverDir,
      stdio: "inherit",
    }).status === 0;
    if (success) {
      row(ok, "Dependencies installed");
    } else {
      row(fail, "bun install failed");
      issues.push("Run `cd server && bun install` manually");
    }
  }

  // ── 7. HTTPS (required for Claude Code Desktop connector UI) ─────────────────
  section("HTTPS");

  let httpsEnabled = certsExist();

  if (httpsEnabled) {
    row(ok, "TLS certificates found");
  } else {
    row(warn, "No TLS certificates — Claude Code Desktop connector UI requires HTTPS");
    row(arrow, `JSON config file works with plain HTTP (see README)`);

    if (!cmdExists("mkcert")) {
      row(fail, "mkcert not installed");
      issues.push(`Install mkcert to enable HTTPS:\n    ${mkcertInstallHint()}`);
    } else {
      row(ok, "mkcert installed");
      const doHttps = await confirm("Generate trusted local certificates now?");
      if (doHttps) {
        mkdirSync(CERTS_DIR, { recursive: true });
        // Install local CA (idempotent — safe to run multiple times)
        runInherit("mkcert", ["-install"]);
        const success = runInherit("mkcert", [
          `-cert-file`, CERT_FILE,
          `-key-file`,  KEY_FILE,
          "localhost", "127.0.0.1",
        ]);
        if (success) {
          httpsEnabled = true;
          row(ok, "Certificates generated");
          // Persist to config.json
          const cfg3 = loadRawConfig() as Record<string, unknown>;
          (cfg3 as any).server = {
            ...((cfg3 as any).server ?? {}),
            https: true,
            certFile: CERT_FILE,
            keyFile: KEY_FILE,
          };
          saveConfig(cfg3);
          row(ok, "config.json updated with HTTPS settings");
        } else {
          row(fail, "mkcert failed");
          issues.push("Run `mkcert -install && mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 127.0.0.1` manually");
        }
      } else {
        row(arrow, "Skipped — you can run setup again to add HTTPS later");
      }
    }
  }

  // ── 8. Tool integration (skills + MCP) ───────────────────────────────────────
  section("Agent tool integration");

  const cfgFinal = loadRawConfig() as any;
  const mcpPort: number = cfgFinal?.server?.port ?? 7384;
  const mcpUrl = httpsEnabled
    ? `https://localhost:${mcpPort}/mcp`
    : `http://localhost:${mcpPort}/mcp`;

  row(arrow, `MCP endpoint: ${c.bold}${mcpUrl}${c.reset}`);

  for (const tool of TOOLS) {
    if (!tool.installed()) {
      row(c.dim + "–" + c.reset, `${tool.label} — not installed, skipping`);
      continue;
    }

    const toolLabel = `${c.bold}${tool.label}${c.reset}`;
    let toolOk = true;

    // Skills
    if (tool.skillsDir) {
      try {
        const { installed, skipped } = installSkills(tool.skillsDir);
        if (installed.length > 0) {
          row(ok, `${toolLabel} — skills installed: ${installed.join(", ")}`);
        } else if (skipped.length > 0) {
          row(ok, `${toolLabel} — skills already present`);
        }
      } catch (e) {
        row(fail, `${toolLabel} — skills install failed: ${(e as Error).message}`);
        toolOk = false;
      }
    }

    // MCP config
    if (tool.mcpConfig) {
      try {
        const result = tool.upsertMcp
          ? tool.upsertMcp(mcpUrl)
          : upsertMcpConfig(tool.mcpConfig, mcpUrl);
        if (result === "added") {
          row(ok, `${toolLabel} — MCP registered in ${tool.mcpConfig}`);
        } else if (result === "updated") {
          row(ok, `${toolLabel} — MCP URL updated in ${tool.mcpConfig}`);
        } else {
          row(ok, `${toolLabel} — MCP already configured`);
        }
      } catch (e) {
        row(fail, `${toolLabel} — MCP config failed: ${(e as Error).message}`);
        toolOk = false;
      }
    }

    if (!toolOk) {
      issues.push(`Manually configure ${tool.label} — see README for MCP and skills paths`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  rl.close();
  console.log(
    `\n${c.bold}${c.cyan}══════════════════════════════════════${c.reset}`
  );

  if (issues.length === 0) {
    console.log(`  ${ok} ${c.bold}${c.green}All checks passed!${c.reset}`);
    console.log(`\n  Start Engram with:`);
    const startCmd = IS_WIN
      ? "bun scripts/setup.ts && bun server/src/index.ts"
      : "./scripts/start.sh";
    console.log(`  ${c.bold}${c.cyan}${startCmd}${c.reset}`);
    console.log(`\n  MCP endpoint: ${c.bold}${mcpUrl}${c.reset}`);
    console.log(`  ${c.dim}(registered in all detected agent tool configs)${c.reset}`);
  } else {
    console.log(
      `  ${warn} ${c.bold}${c.yellow}${issues.length} issue${issues.length > 1 ? "s" : ""} to resolve:${c.reset}`
    );
    issues.forEach((issue, i) => {
      console.log(`\n  ${c.bold}${i + 1}.${c.reset} ${issue}`);
    });
    console.log(
      `\n  Re-run ${c.bold}bun scripts/setup.ts${c.reset} after fixing these.`
    );
    process.exitCode = 1;
  }

  console.log(
    `${c.bold}${c.cyan}══════════════════════════════════════${c.reset}\n`
  );
}

main().catch((err) => {
  console.error(`\n${fail} Setup failed unexpectedly: ${err.message}`);
  process.exit(1);
});
