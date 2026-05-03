import { existsSync } from "fs";
import { join } from "path";

const EMBED_PORT = 8001;

async function isEmbedServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${EMBED_PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok || res.status < 500;
  } catch { return false; }
}

async function waitForEmbedServer(label: string, maxSeconds: number): Promise<void> {
  const TICK_MS = 5000;
  for (let i = 0; i < maxSeconds / (TICK_MS / 1000); i++) {
    await Bun.sleep(TICK_MS);
    if (await isEmbedServerRunning()) return;
    const elapsed = (i + 1) * (TICK_MS / 1000);
    if (elapsed % 30 === 0) console.log(`[engram] Still waiting for ${label}... (${elapsed}s)`);
  }
  console.error(`[engram] ERROR: ${label} failed to start within ${maxSeconds / 60} minutes.`);
  process.exit(1);
}

const GGUF_REPO = "DevQuasar/Qwen.Qwen3-VL-Embedding-2B-GGUF";
const GGUF_BASE = "Qwen.Qwen3-VL-Embedding-2B";

function selectGgufFile(freeGB: number): string {
  if (freeGB >= 3.5) return `${GGUF_BASE}.Q8_0.gguf`;
  if (freeGB >= 3.0) return `${GGUF_BASE}.Q6_K.gguf`;
  if (freeGB >= 2.5) return `${GGUF_BASE}.Q5_K_M.gguf`;
  return `${GGUF_BASE}.Q4_K_M.gguf`;
}

interface VllmLaunchConfig { modelTag: string; extraArgs: string[] }
function selectVllmConfig(): VllmLaunchConfig {
  const nvOut = Bun.spawnSync(
    ["nvidia-smi", "--query-gpu=memory.free,compute_cap", "--format=csv,noheader,nounits"],
    { stderr: "pipe" }
  );
  if (nvOut.exitCode === 0) {
    const parts = nvOut.stdout.toString().trim().split(", ");
    const freeGB = parseInt(parts[0]) / 1024;
    const cc = parseFloat(parts[1]);
    if (cc >= 10.0) return { modelTag: "LifetimeMistake/Qwen3-VL-Embedding-2B-NVFP4", extraArgs: ["--quantization", "nvfp4"] };
    const ggufFile = selectGgufFile(freeGB);
    return { modelTag: GGUF_REPO, extraArgs: ["--load-format", "gguf", "--gguf-file", ggufFile] };
  }
  return { modelTag: GGUF_REPO, extraArgs: ["--load-format", "gguf", "--gguf-file", `${GGUF_BASE}.Q4_K_M.gguf`] };
}

export async function ensureEmbedServer(root: string): Promise<Bun.Subprocess | null> {
  if (await isEmbedServerRunning()) {
    console.log(`[engram] Embedding server already running on port ${EMBED_PORT}`);
    return null;
  }

  const IS_MAC = process.platform === "darwin";
  const IS_WINDOWS = process.platform === "win32";

  if (IS_MAC) {
    const uvicornBin = join(root, ".venv", "bin", "uvicorn");
    if (!existsSync(uvicornBin)) {
      console.error("[engram] ERROR: mlx-embeddings not installed — run: bun scripts/setup.ts");
      process.exit(1);
    }
    console.log(`[engram] Starting MLX embedding server on port ${EMBED_PORT} — Qwen3-VL-Embedding-2B nvfp4 (first run downloads model weights)...`);
    const proc = Bun.spawn(
      ["uv", "run", "python", join(root, "mlx_server.py"), "--port", String(EMBED_PORT), "--q-mode", "nvfp4"],
      { cwd: root, stdout: "ignore", stderr: "ignore", detached: true }
    );
    await waitForEmbedServer("MLX embedding server", 600);
    console.log("[engram] MLX embedding server ready.");
    return proc;
  } else {
    const vllmBin = IS_WINDOWS
      ? join(root, ".venv", "Scripts", "vllm.exe")
      : join(root, ".venv", "bin", "vllm");
    if (!existsSync(vllmBin)) {
      console.error("[engram] ERROR: vLLM not installed — run: bun scripts/setup.ts");
      if (IS_WINDOWS) console.error("[engram] Windows: install vllm-windows — https://github.com/SystemPanic/vllm-windows/releases");
      process.exit(1);
    }
    const { modelTag, extraArgs } = selectVllmConfig();
    const ggufFile = extraArgs.find(a => a.endsWith(".gguf"));
    const label = ggufFile ? `${modelTag} (${ggufFile})` : modelTag;
    console.log(`[engram] Starting vLLM on port ${EMBED_PORT} — ${label} ...`);
    const proc = Bun.spawn(
      ["uv", "run", "vllm", "serve", modelTag, "--runner", "pooling", "--port", String(EMBED_PORT), ...extraArgs],
      { cwd: root, stdout: "ignore", stderr: "ignore", detached: true }
    );
    await waitForEmbedServer("vLLM", 600);
    console.log("[engram] vLLM ready.");
    return proc;
  }
}
