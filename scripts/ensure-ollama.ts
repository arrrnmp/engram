import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const CAPTION_MODEL_NAME = "engram-caption";
const CAPTION_GGUF_URL =
  "https://huggingface.co/unsloth/Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen3-VL-4B-Instruct-UD-Q4_K_XL.gguf";
const CAPTION_GGUF_FILENAME = "Qwen3-VL-4B-Instruct-UD-Q4_K_XL.gguf";
const SOURCE_MODEL_NAME = "engram-caption-source-qwen3-vl-4b";
const FALLBACK_SOURCE_MODEL_NAME = "qwen2.5vl:3b";

interface OllamaModelTag {
  name: string;
  digest?: string;
}

function normalizeModelName(name: string): string {
  return name.replace(/:latest$/i, "");
}

function hasNoVisionSignal(text: string): boolean {
  return /(cannot (see|view).{0,30}image|unable to (see|view).{0,30}image|only text-based|please upload.{0,30}image|image (is )?(missing|not provided))/i.test(text);
}

function looksLikeOllamaHost(host: string): boolean {
  try {
    const url = new URL(host);
    return url.port === "11434" || /ollama/i.test(url.hostname);
  } catch {
    return false;
  }
}

function loadConfig(root: string): { captionHost?: string; captionModel?: string } {
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

function isOllamaRunning(host: string): Promise<boolean> {
  const baseUrl = host.replace(/\/v1$/, "");
  try {
    return fetch(`${baseUrl}`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.ok || r.status < 500)
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

async function listModels(baseUrl: string): Promise<OllamaModelTag[] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: OllamaModelTag[] };
    return data.models ?? [];
  } catch {
    return null;
  }
}

async function validateVisionModel(baseUrl: string, modelName: string): Promise<{ ok: boolean; detail?: string }> {
  // 1x1 transparent PNG
  const tinyPngB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlH7x8AAAAASUVORK5CYII=";
  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        prompt: "Describe this image concisely for search and retrieval.",
        images: [tinyPngB64],
        stream: false,
      }),
    });

    if (!res.ok) {
      return { ok: false, detail: `${res.status} ${res.statusText}` };
    }

    const json = await res.json() as { response?: unknown; error?: unknown };
    if (typeof json.error === "string" && json.error.trim().length > 0) {
      return { ok: false, detail: json.error };
    }
    const response = typeof json.response === "string" ? json.response.trim() : "";
    if (!response) {
      return { ok: false, detail: "empty response" };
    }
    if (hasNoVisionSignal(response)) {
      return { ok: false, detail: "non-vision refusal response" };
    }
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail };
  }
}

function repointAlias(targetModel: string, sourceModelName: string): boolean {
  console.log(`[engram] Updating alias '${targetModel}' to ${sourceModelName}...`);
  const rm = Bun.spawnSync(["ollama", "rm", targetModel], { stdout: "inherit", stderr: "inherit" });
  if (rm.exitCode !== 0) {
    console.warn(`[engram] Failed to remove old '${targetModel}' alias — run manually:`);
    console.warn(`[engram]   ollama rm ${targetModel}`);
    return false;
  }
  const cp = Bun.spawnSync(["ollama", "cp", sourceModelName, targetModel], { stdout: "inherit", stderr: "inherit" });
  if (cp.exitCode !== 0) {
    console.warn(`[engram] Failed to create alias — run manually:`);
    console.warn(`[engram]   ollama cp ${sourceModelName} ${targetModel}`);
    return false;
  }
  return true;
}

async function ensurePulledModel(baseUrl: string, modelName: string): Promise<OllamaModelTag | null> {
  const findModel = (models: OllamaModelTag[], name: string): OllamaModelTag | undefined => {
    const normalized = normalizeModelName(name);
    return models.find((m) => normalizeModelName(m.name) === normalized);
  };

  let models = await listModels(baseUrl);
  if (!models) return null;

  let model = findModel(models, modelName);
  if (model) return model;

  console.log(`[engram] Pulling fallback vision model ${modelName} from Ollama registry...`);
  const pull = Bun.spawnSync(["ollama", "pull", modelName], { stdout: "inherit", stderr: "inherit" });
  if (pull.exitCode !== 0) {
    console.warn(`[engram] Failed to pull fallback model ${modelName} — run manually:`);
    console.warn(`[engram]   ollama pull ${modelName}`);
    return null;
  }

  models = await listModels(baseUrl);
  if (!models) return null;
  model = findModel(models, modelName);
  return model ?? null;
}

async function downloadGGUF(destDir: string): Promise<string> {
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, CAPTION_GGUF_FILENAME);
  if (existsSync(dest)) {
    console.log(`[engram] Caption GGUF already exists at ${dest}`);
    return dest;
  }

  console.log(`[engram] Downloading ${CAPTION_GGUF_URL}`);
  console.log("[engram] This may take a while (~2-3 GB)...");

  const res = await fetch(CAPTION_GGUF_URL, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download GGUF: HTTP ${res.status}`);
  }

  const contentLength = res.headers.get("content-length");
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
  let downloaded = 0;
  let lastPct = -1;

  const file = Bun.file(dest);
  const writer = file.writer();
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(value);
    downloaded += value.length;
    if (totalBytes > 0) {
      const pct = Math.floor((downloaded / totalBytes) * 100);
      if (pct > lastPct && pct % 10 === 0) {
        console.log(`[engram] Download progress: ${pct}%`);
        lastPct = pct;
      }
    }
  }
  writer.end();

  console.log(`[engram] Downloaded caption GGUF to ${dest}`);
  return dest;
}

async function ensureModel(baseUrl: string, root: string, targetModel: string): Promise<boolean> {
  const findModel = (models: OllamaModelTag[], name: string): OllamaModelTag | undefined => {
    const normalized = normalizeModelName(name);
    return models.find((m) => normalizeModelName(m.name) === normalized);
  };

  let models = await listModels(baseUrl);
  if (!models) {
    console.warn("[engram] Could not read Ollama model list; skipping caption model verification.");
    return false;
  }

  let source = findModel(models, SOURCE_MODEL_NAME);
  let sourceModelName = SOURCE_MODEL_NAME;
  if (!source) {
    const ggufDir = join(root, ".ollama-models");
    let ggufPath: string;
    try {
      ggufPath = await downloadGGUF(ggufDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[engram] Failed to download caption GGUF: ${msg}`);
      return false;
    }

    const modelfilePath = join(ggufDir, "Modelfile.engram-caption-source");
    writeFileSync(modelfilePath, `FROM ${ggufPath}\n`);

    console.log(`[engram] Creating source caption model '${SOURCE_MODEL_NAME}' from GGUF...`);
    const create = Bun.spawnSync(["ollama", "create", SOURCE_MODEL_NAME, "-f", modelfilePath], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (create.exitCode !== 0) {
      console.warn(`[engram] Failed to create source model '${SOURCE_MODEL_NAME}' from GGUF.`);
      console.warn(`[engram] This Ollama build may not support this VL GGUF; falling back to '${FALLBACK_SOURCE_MODEL_NAME}'.`);
      const fallback = await ensurePulledModel(baseUrl, FALLBACK_SOURCE_MODEL_NAME);
      if (!fallback) return false;
      source = fallback;
      sourceModelName = FALLBACK_SOURCE_MODEL_NAME;
    }
    if (!source) {
      models = await listModels(baseUrl);
      if (!models) return false;
      source = findModel(models, SOURCE_MODEL_NAME);
      if (!source) {
        console.warn(`[engram] Source model '${SOURCE_MODEL_NAME}' is not visible in ollama list after create.`);
        const fallback = await ensurePulledModel(baseUrl, FALLBACK_SOURCE_MODEL_NAME);
        if (!fallback) return false;
        source = fallback;
        sourceModelName = FALLBACK_SOURCE_MODEL_NAME;
      }
    }
  }

  const normalizedTarget = normalizeModelName(targetModel);
  const normalizedSource = normalizeModelName(sourceModelName);
  if (normalizedTarget !== normalizedSource) {
    models = await listModels(baseUrl);
    if (!models) return false;
    const target = findModel(models, targetModel);
    if (target?.digest && source.digest && target.digest === source.digest) {
      console.log(`[engram] Caption model '${targetModel}' already points to ${sourceModelName}.`);
    } else {
      if (target) {
        if (!repointAlias(targetModel, sourceModelName)) return false;
      } else {
        console.log(`[engram] Creating alias '${targetModel}' -> '${sourceModelName}'...`);
        const cp = Bun.spawnSync(["ollama", "cp", sourceModelName, targetModel], { stdout: "inherit", stderr: "inherit" });
        if (cp.exitCode !== 0) {
          console.warn(`[engram] Failed to create alias — run manually:`);
          console.warn(`[engram]   ollama cp ${sourceModelName} ${targetModel}`);
          return false;
        }
      }
    }
  }

  const validation = await validateVisionModel(baseUrl, targetModel);
  if (!validation.ok) {
    console.warn(`[engram] Caption model '${targetModel}' failed vision validation (${validation.detail ?? "unknown error"}).`);
    if (normalizeModelName(sourceModelName) !== normalizeModelName(FALLBACK_SOURCE_MODEL_NAME)) {
      const fallback = await ensurePulledModel(baseUrl, FALLBACK_SOURCE_MODEL_NAME);
      if (!fallback) return false;
      if (!repointAlias(targetModel, FALLBACK_SOURCE_MODEL_NAME)) return false;
      const fallbackValidation = await validateVisionModel(baseUrl, targetModel);
      if (!fallbackValidation.ok) {
        console.warn(`[engram] Fallback model '${FALLBACK_SOURCE_MODEL_NAME}' validation was inconclusive (${fallbackValidation.detail ?? "unknown error"}).`);
        console.warn("[engram] Continuing with fallback alias — runtime caption requests will decide final behavior.");
      }
      console.log(`[engram] Caption model '${targetModel}' ready via fallback '${FALLBACK_SOURCE_MODEL_NAME}'.`);
      return true;
    }
    return false;
  }

  console.log(`[engram] Caption model '${targetModel}' ready.`);
  return true;
}

export async function ensureOllama(root: string): Promise<Bun.Subprocess | null> {
  const cfg = loadConfig(root);
  const captioning = (cfg as any)?.captioning;

  if (!captioning) {
    return null;
  }

  const host: string = captioning.host ?? "http://localhost:11434/v1";
  const provider: "auto" | "ollama" | "openai" = captioning.provider ?? "auto";
  if (provider === "openai" || (provider === "auto" && !looksLikeOllamaHost(host))) {
    return null;
  }
  const model: string = captioning.model ?? CAPTION_MODEL_NAME;
  const baseUrl = host.replace(/\/v1$/, "");

  if (await isOllamaRunning(host)) {
    console.log(`[engram] Ollama already running at ${baseUrl}`);
  } else {
    const ollamaBin = process.platform === "win32" ? "ollama.exe" : "ollama";
    const which = process.platform === "win32" ? "where" : "which";

    const check = Bun.spawnSync([which, ollamaBin], { stderr: "pipe" });
    if (check.exitCode !== 0) {
      console.log(`[engram] Captioning enabled but Ollama not found — image captions will fall back to filenames.`);
      console.log(`[engram] Install Ollama from https://ollama.com to enable captioning.`);
      return null;
    }

    console.log(`[engram] Starting Ollama server at ${baseUrl}...`);
    const proc = Bun.spawn(["ollama", "serve"], {
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });

    for (let i = 0; i < 12; i++) {
      await Bun.sleep(2500);
      if (await isOllamaRunning(host)) {
        console.log("[engram] Ollama ready.");
        break;
      }
      if (i === 5) {
        console.log("[engram] Still waiting for Ollama...");
      }
    }

    if (!(await isOllamaRunning(host))) {
      console.error("[engram] ERROR: Ollama failed to start within 30s. Image captions will fall back to filenames.");
      return proc;
    }
  }

  await ensureModel(baseUrl, root, model);

  return null;
}
