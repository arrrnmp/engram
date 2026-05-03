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
  quant: string;
  vramGB: number;
  bits: number;
}

const VARIANTS: Variant[] = [
  { label: "Qwen3-VL-Embedding-2B Q8",   quant: "q8",    vramGB: 4, bits: 8 },
  { label: "Qwen3-VL-Embedding-2B Q6",   quant: "q6",    vramGB: 3,  bits: 6 },
  { label: "Qwen3-VL-Embedding-2B Q4",   quant: "q4",    vramGB: 2,  bits: 4 },
  { label: "Qwen3-VL-Embedding-2B NVFP4", quant: "nvfp4", vramGB: 2,  bits: 4 },
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

function vllmInVenv(): boolean {
  const r = spawnSync("uv", ["run", "--frozen", "python", "-c", "import vllm"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  return r.status === 0;
}

function vllmVersion(): string | null {
  return runCapture("uv", ["run", "--frozen", "python", "-c", "import vllm; print(vllm.__version__)"]);
}

function mlxInVenv(): boolean {
  const r = spawnSync("uv", ["run", "--frozen", "python", "-c", "import mlx_embeddings"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  return r.status === 0;
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
      // NODE_OPTIONS=--use-system-ca makes Node.js 24+ trust the macOS/Windows
      // system keychain, so mkcert certificates validate without extra flags.
      servers.engram = {
        command: "npx",
        args: ["mcp-remote", mcpUrl],
        env: { NODE_OPTIONS: "--use-system-ca" },
      };
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
const SKILLS_ONLY = process.argv.includes("--skills-only");

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

// ── Skills & MCP only (used by --skills-only) ────────────────────────────────

function installSkillsAndMcp(): string[] {
  const issues: string[] = [];

  const cfgRaw = loadRawConfig() as any;
  const mcpPort: number = cfgRaw?.server?.port ?? 7384;
  const httpsEnabled = cfgRaw?.server?.https
    && existsSync(CERT_FILE)
    && existsSync(KEY_FILE);
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

  // Skill packages
  const DIST_DIR = join(ROOT, "dist");
  mkdirSync(DIST_DIR, { recursive: true });

  if (IS_WIN) {
    row(warn, "Skill packaging requires the zip command — skipping on Windows");
    row(arrow, `Manually zip each folder in ${SKILLS_SRC} and rename to .skill`);
  } else {
    const skillDirs = readdirSync(SKILLS_SRC).filter((s) =>
      statSync(join(SKILLS_SRC, s)).isDirectory()
    );

    let packaged = 0;
    for (const skill of skillDirs) {
      const outFile = join(DIST_DIR, `${skill}.skill`);
      const result = spawnSync("zip", ["-r", outFile, skill], {
        cwd: SKILLS_SRC,
        stdio: "pipe",
      });
      if (result.status === 0) {
        row(ok, `${skill}.skill`);
        packaged++;
      } else {
        row(fail, `Failed to package ${skill}`);
      }
    }

    if (packaged > 0) {
      row(arrow, `Skill files written to: ${c.bold}${DIST_DIR}${c.reset}`);
      row(arrow, `Double-click a ${c.bold}.skill${c.reset} file to install it in Claude Desktop or Claude.ai`);
    }
  }

  return issues;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // ── --skills-only: fast path ────────────────────────────────────────────────
  if (SKILLS_ONLY) {
    console.log(
      `\n${c.bold}${c.cyan}Engram — Skills & MCP Reinstall${c.reset}\n`
    );
    const issues = installSkillsAndMcp();
    rl.close();
    if (issues.length === 0) {
      console.log(`\n  ${ok} ${c.bold}${c.green}Done.${c.reset}\n`);
    } else {
      console.log(`\n  ${warn} ${issues.length} issue(s):`);
      issues.forEach((issue, i) => console.log(`  ${i + 1}. ${issue}`));
      console.log();
      process.exitCode = 1;
    }
    return;
  }

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
      `${recommended.vramGB} GB · ${recommended.bits}-bit`
    );
  } else {
    row(
      warn,
      "Insufficient memory for any 4-bit+ model",
      "Consider a machine with at least 8 GB GPU memory"
    );
    issues.push(
      `Not enough memory for local embeddings. Need at least 7 GB available GPU memory.`
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
      embedding: { overheadBuffer: 0.25, vllm: { host: "http://localhost:8001" } },
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

  // ── 4. Embedding server ────────────────────────────────────────────────────
  section("Embedding server");

  const cfg2 = loadRawConfig() as any;
  const embedHost: string = cfg2?.embedding?.vllm?.host ?? "http://localhost:8001";

  async function isEmbedServerRunning(host: string): Promise<boolean> {
    try {
      const res = await fetch(`${host}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok || res.status < 500;
    } catch {
      return false;
    }
  }

  if (await isEmbedServerRunning(embedHost)) {
    row(ok, `Embedding server running at ${embedHost}`);
  } else if (IS_MAC) {
    // macOS: MLX embedding server (mlx-embeddings + FastAPI)
    if (mlxInVenv()) {
      row(ok, `mlx-embeddings installed (venv) — will load Qwen3-VL-Embedding-2B nvfp4`);
      row(arrow, "Will auto-start when you run: bun run start");
    } else {
      row(warn, "mlx-embeddings not installed");
      const doInstall = await confirm(
        "Install mlx-embeddings + server deps via uv? (first run will download model weights)"
      );
      if (doInstall) {
        console.log();
        const success = runInherit("uv", ["sync", "--group", "mlx"]);
        if (success) {
          row(ok, "mlx-embeddings installed into .venv");
        } else {
          row(fail, "uv sync --group mlx failed");
          issues.push("Run `uv sync --group mlx` from the repo root to install mlx-embeddings");
        }
      } else {
        issues.push("Run `uv sync --group mlx` from the repo root to install mlx-embeddings");
      }
    }
  } else if (IS_WIN) {
    // Windows: vllm-windows (pre-built NVIDIA wheel, installed manually)
    const hasNvidia =
      spawnSync("nvidia-smi", [], { stdio: "ignore" }).status === 0 ||
      spawnSync("powershell", ["-NoProfile", "-Command",
        "(Get-CimInstance Win32_VideoController).Name -match 'NVIDIA'"],
        { stdio: "ignore" }).status === 0;
    if (hasNvidia) {
      row(warn, "vllm-windows not running");
      row(arrow, "Download the wheel from: https://github.com/SystemPanic/vllm-windows/releases");
      row(arrow, "Install into venv:  uv pip install <path-to-wheel.whl>");
      row(arrow, "Then start Engram:  bun run start");
      issues.push("Install vllm-windows: https://github.com/SystemPanic/vllm-windows/releases");
    } else {
      row(warn, "No NVIDIA GPU detected — vLLM requires NVIDIA GPU on Windows");
      issues.push("vLLM on Windows requires an NVIDIA GPU");
    }
  } else {
    // Linux: vLLM via uv
    if (vllmInVenv()) {
      const ver = vllmVersion();
      row(ok, `vllm ${ver ?? ""} (venv, not running)`);
      row(arrow, "Will auto-start when you run: bun run start");
    } else {
      row(warn, "vllm not installed in venv");
      const doInstall = await confirm("Install vllm via uv? (may take several minutes)");
      if (doInstall) {
        console.log();
        const success = runInherit("uv", ["sync", "--group", "vllm"]);
        if (success) {
          const ver = vllmVersion();
          row(ok, `vllm ${ver ?? ""} installed into .venv`);
        } else {
          row(fail, "uv sync --group vllm failed");
          issues.push("Run `uv sync --group vllm` manually from the repo root");
        }
      } else {
        issues.push("Run `uv sync --group vllm` from the repo root to install vllm");
      }
    }
  }

  // ── 5. Image captioning (Ollama) ─────────────────────────────────────────────
  section("Image captioning (optional)");

  const captioningEnabled = Boolean((cfg2 as any)?.captioning?.host);
  const captionHost = (cfg2 as any)?.captioning?.host ?? "http://localhost:11434/v1";
  const captionProvider = (cfg2 as any)?.captioning?.provider ?? "auto";
  const captionLooksOllama = (() => {
    try {
      const url = new URL(captionHost);
      return url.port === "11434" || /ollama/i.test(url.hostname);
    } catch {
      return false;
    }
  })();
  const useOllama = captionProvider === "ollama" || (captionProvider === "auto" && captionLooksOllama);

  if (captioningEnabled) {
    if (useOllama) {
      try {
        const res = await fetch(captionHost.replace(/\/v1$/, ""), { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          row(ok, `Ollama running at ${captionHost.replace(/\/v1$/, "")}`);
        } else {
          row(warn, `Ollama at ${captionHost.replace(/\/v1$/, "")} returned status ${res.status}`);
        }
      } catch {
        row(warn, `Ollama not reachable at ${captionHost.replace(/\/v1$/, "")} — image captions will fall back to filenames`);
        row(arrow, "Start Ollama with: ollama serve");
      }
    } else {
      row(ok, `Captioning provider: ${captionProvider} (${captionHost})`);
    }
    const captionModel = (cfg2 as any)?.captioning?.model ?? "engram-caption";
    row(arrow, `Caption model: ${c.bold}${captionModel}${c.reset}`);
    if (useOllama) {
      row(arrow, `First run will auto-download ${c.bold}Qwen3-VL-4B-Instruct-UD-Q4_K_XL.gguf${c.reset}`);
      row(arrow, `Then it creates a local source model and aliases it to ${c.bold}${captionModel}${c.reset}`);
      row(arrow, `If your Ollama build can't load that GGUF, it falls back to ${c.bold}qwen2.5vl:3b${c.reset}`);
    }
  } else {
    const ollamaInstalled = cmdExists("ollama");
    if (ollamaInstalled) {
      row(arrow, `Ollama installed — captioning is ${c.dim}disabled${c.reset}`);
      row(arrow, `Enable by adding to config.json:`);
      console.log(`    ${c.cyan}"captioning": { "host": "http://localhost:11434/v1" }${c.reset}`);
      console.log(`    ${c.dim}Then run: bun run start (auto-downloads Qwen3-VL-4B-Instruct-UD-Q4_K_XL.gguf)${c.reset}`);
    } else {
      row(arrow, `Ollama not installed — image captions disabled (filenames used instead)`);
      row(arrow, `Install from: ${c.bold}https://ollama.com${c.reset}`);
    }
  }

  // ── 6. ChromaDB (via uv + venv) ──────────────────────────────────────────────
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

  // ── 7. mutool (required for PDF rendering) ───────────────────────────────────
  section("mutool (PDF renderer)");

  const mutoolFound = cmdExists("mutool");
  if (mutoolFound) {
    const mutoolVersion = runCapture("mutool", ["-v"]) ?? "found";
    row(ok, `mutool ${mutoolVersion}`);
  } else {
    row(fail, "mutool not found — PDF and Office document indexing will not work");
    if (IS_MAC) {
      row(arrow, "Install with: brew install mupdf-tools");
    } else if (IS_LINUX) {
      row(arrow, "Install with: sudo apt install mupdf-tools");
    } else if (IS_WIN) {
      row(arrow, "Download from: https://mupdf.com/releases/");
    }
    issues.push("Install mutool (mupdf-tools) to enable PDF and Office document indexing");
  }

  // ── 9. LibreOffice (optional, for .docx/.pptx/.xlsx indexing) ───────────────
  section("LibreOffice (optional)");

  const loFound = cmdExists("libreoffice") || cmdExists("soffice");
  if (loFound) {
    const loVersion = runCapture("libreoffice", ["--version"]) ?? runCapture("soffice", ["--version"]);
    row(ok, `LibreOffice found${loVersion ? `: ${loVersion}` : ""}`);
  } else {
    row(warn, "LibreOffice not found — .docx/.pptx/.xlsx files will be skipped by the watcher");
    if (IS_MAC) {
      row(arrow, "Install with: brew install --cask libreoffice");
    } else if (IS_LINUX) {
      row(arrow, "Install with: sudo apt install libreoffice  (or your distro's package manager)");
    } else if (IS_WIN) {
      row(arrow, "Download from: https://www.libreoffice.org/download/download/");
    }
    row(arrow, "Or set watcher.libreOfficePath in config.json to a custom path");
  }

  // ── 10. HTTPS (required for Claude Code Desktop connector UI) ─────────────────
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

  // ── 11. Tool integration (skills + MCP) ───────────────────────────────────────
  section("Agent tool integration");
  issues.push(...installSkillsAndMcp());

  // ── Summary ──────────────────────────────────────────────────────────────────
  rl.close();
  console.log(
    `\n${c.bold}${c.cyan}══════════════════════════════════════${c.reset}`
  );

  if (issues.length === 0) {
    console.log(`  ${ok} ${c.bold}${c.green}All checks passed!${c.reset}`);
    console.log(`\n  Start Engram with:`);
    const startCmd = "bun run start";
    console.log(`  ${c.bold}${c.cyan}${startCmd}${c.reset}`);
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
