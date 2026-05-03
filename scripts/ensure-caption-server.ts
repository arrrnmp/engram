import { existsSync, readFileSync } from "fs";
import { join } from "path";

const CAPTION_PORT = 8002;
const DEFAULT_MLX_MODEL = "mlx-community/Qwen3.5-4B-MLX-4bit";
const DEFAULT_LLAMA_MODEL = "unsloth/Qwen3.5-4B-GGUF:Qwen3.5-4B-UD-Q4_K_XL.gguf";

function loadConfig(root: string): Record<string, unknown> {
  for (const name of ["config.local.json", "config.json"]) {
    const p = join(root, "server", name);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8"));
      } catch {}
    }
    const pp = join(root, name);
    if (existsSync(pp)) {
      try {
        return JSON.parse(readFileSync(pp, "utf-8"));
      } catch {}
    }
  }
  return {};
}

async function isCaptionServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${CAPTION_PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    try {
      const res = await fetch(`http://localhost:${CAPTION_PORT}`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

async function waitForCaptionServer(label: string, maxSeconds: number): Promise<void> {
  const TICK_MS = 5000;
  for (let i = 0; i < maxSeconds / (TICK_MS / 1000); i++) {
    await Bun.sleep(TICK_MS);
    if (await isCaptionServerRunning()) return;
    const elapsed = (i + 1) * (TICK_MS / 1000);
    if (elapsed % 30 === 0) console.log(`[engram] Still waiting for ${label}... (${elapsed}s)`);
  }
  console.error(`[engram] ERROR: ${label} failed to start within ${maxSeconds / 60} minutes.`);
  process.exit(1);
}

const TINY_IMAGE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function verifyCaptionServer(host: string, modelName: string): Promise<{ ok: boolean; detail?: string; visionOk?: boolean }> {
  const endpoint = `${host.replace(/\/+$/, "").replace(/\/v1$/i, "")}/v1/chat/completions`;

  // Step 1: verify basic text chat works
  try {
    const textRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: "user", content: [{ type: "text", text: "Say 'ok'." }] }],
        max_tokens: 8,
      }),
    });

    if (!textRes.ok) {
      return { ok: false, detail: `${textRes.status} ${textRes.statusText}` };
    }

    const textJson = (await textRes.json()) as { choices?: Array<{ message?: { content?: unknown } }>; error?: unknown };
    if (typeof textJson.error === "string" && textJson.error.trim().length > 0) {
      return { ok: false, detail: textJson.error };
    }
    if (!textJson.choices || textJson.choices.length === 0) {
      return { ok: false, detail: "empty choices" };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail };
  }

  // Step 2: verify vision (image_url) is accepted — captioning is useless without this
  try {
    const imgRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_IMAGE_B64}` } },
            { type: "text", text: "What is this?" },
          ],
        }],
        max_tokens: 8,
      }),
    });

    if (!imgRes.ok) {
      const imgJson = (await imgRes.json().catch(() => ({}))) as { error?: unknown };
      const errorText = typeof imgJson.error === "string" ? imgJson.error : `${imgRes.status} ${imgRes.statusText}`;
      return { ok: false, detail: `vision not supported: ${errorText}`, visionOk: false };
    }

    const imgJson = (await imgRes.json()) as { choices?: Array<{ message?: { content?: unknown } }>; error?: unknown };
    if (typeof imgJson.error === "string" && imgJson.error.trim().length > 0) {
      return { ok: false, detail: `vision not supported: ${imgJson.error}`, visionOk: false };
    }
    if (!imgJson.choices || imgJson.choices.length === 0) {
      return { ok: false, detail: "vision not supported: empty choices", visionOk: false };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `vision not supported: ${detail}`, visionOk: false };
  }

  return { ok: true, visionOk: true };
}

async function ensureMlxServer(root: string, model: string): Promise<Bun.Subprocess | null> {
  const uvicornBin = join(root, ".venv", "bin", "uvicorn");
  if (!existsSync(uvicornBin)) {
    console.error("[engram] ERROR: Python venv not found — run: bun scripts/setup.ts");
    process.exit(1);
  }

  console.log(`[engram] Starting MLX caption server on port ${CAPTION_PORT} — ${model} (first run downloads model weights)...`);
  // Cap KV cache at 4K tokens and quantize to 4-bit to keep memory reasonable.
  // Captioning needs ~2K context; without limits mlx_vlm.server balloons to 10GB+.
  const proc = Bun.spawn(
    ["uv", "run", "python", "-m", "mlx_vlm.server", "--model", model, "--port", String(CAPTION_PORT), "--max-kv-size", "4096", "--kv-bits", "4"],
    { cwd: root, stdout: "ignore", stderr: "ignore", detached: true }
  );
  await waitForCaptionServer("MLX caption server", 600);
  console.log("[engram] MLX caption server ready.");
  return proc;
}

async function ensureLlamaServer(root: string, model: string): Promise<Bun.Subprocess | null> {
  const IS_WIN = process.platform === "win32";
  const llamaServerBin = IS_WIN ? "llama-server.exe" : "llama-server";
  const which = IS_WIN ? "where" : "which";

  const check = Bun.spawnSync([which, llamaServerBin], { stderr: "pipe" });
  if (check.exitCode !== 0) {
    console.error("[engram] ERROR: llama-server not found. Install llama.cpp:");
    if (process.platform === "darwin") {
      console.error("  brew install llama.cpp");
    } else if (process.platform === "linux") {
      console.error("  See https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md");
    } else if (IS_WIN) {
      console.error("  Download from https://github.com/ggml-org/llama.cpp/releases");
    }
    process.exit(1);
  }

  console.log(`[engram] Starting llama.cpp caption server on port ${CAPTION_PORT} — ${model} ...`);
  const proc = Bun.spawn(
    [llamaServerBin, "-hf", model, "--port", String(CAPTION_PORT), "--ctx-size", "16384"],
    { cwd: root, stdout: "ignore", stderr: "ignore", detached: true }
  );
  await waitForCaptionServer("llama.cpp caption server", 600);
  console.log("[engram] llama.cpp caption server ready.");
  return proc;
}

export async function ensureCaptionServer(root: string): Promise<Bun.Subprocess | null> {
  const cfg = loadConfig(root);
  const captioning = (cfg as any)?.captioning;

  if (!captioning) {
    return null;
  }

  const host: string = captioning.host ?? "http://localhost:8002/v1";
  let provider: string = captioning.provider ?? "auto";
  const IS_MAC = process.platform === "darwin" && process.arch === "arm64";

  if (provider === "auto") {
    provider = IS_MAC ? "mlx" : "llama";
  }

  let model: string = captioning.model;
  if (!model) {
    model = provider === "mlx" ? DEFAULT_MLX_MODEL : DEFAULT_LLAMA_MODEL;
  }

  // Validate provider/platform compatibility
  if (provider === "mlx" && !IS_MAC) {
    console.error("[engram] ERROR: captioning.provider='mlx' is only supported on Apple Silicon.");
    console.error(`[engram] This system is ${process.platform} (${process.arch}). Set captioning.provider to 'llama'.`);
    process.exit(1);
  }

  const alreadyRunning = await isCaptionServerRunning();

  if (alreadyRunning) {
    console.log(`[engram] Caption server already running on port ${CAPTION_PORT}`);
    const check = await verifyCaptionServer(host, model);
    if (!check.ok) {
      console.error(`[engram] ERROR: Caption server on port ${CAPTION_PORT} is running but does not respond correctly.`);
      console.error(`[engram]   (${check.detail ?? "unknown error"})`);
      console.error(`[engram] This usually means a stale server from a previous run is still running.`);
      console.error(`[engram] Kill the process on port ${CAPTION_PORT} and retry.`);
      process.exit(1);
    }
    return null;
  }

  // Port is free — launch the server
  let proc: Bun.Subprocess | null = null;
  if (provider === "mlx") {
    proc = await ensureMlxServer(root, model);
  } else {
    proc = await ensureLlamaServer(root, model);
  }

  // Final verification
  const finalCheck = await verifyCaptionServer(host, model);
  if (!finalCheck.ok) {
    console.error(`[engram] ERROR: Caption server started but verification failed.`);
    console.error(`[engram]   (${finalCheck.detail ?? "unknown error"})`);
    proc?.kill();
    process.exit(1);
  }

  return proc;
}
