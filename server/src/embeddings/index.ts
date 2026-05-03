import type { Config } from "../config.js";
import { detectHardware } from "../hardware/detect.js";
import { selectModel } from "../hardware/memory.js";
import { QwenVLProvider } from "./qwen-vl.js";
import type { EmbeddingProvider } from "./types.js";
import { logger } from "../logger.js";

export type { EmbeddingProvider };

async function isVllmHealthy(host: string, timeout: number): Promise<boolean> {
  try {
    const res = await fetch(`${host}/health`, { signal: AbortSignal.timeout(timeout) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

export async function createEmbeddingProvider(
  config: Config
): Promise<EmbeddingProvider> {
  const { embedding } = config;
  const vllmHost = embedding.vllm.host;
  const vllmTimeout = embedding.vllm.healthTimeout;

  // Check vLLM health
  if (!(await isVllmHealthy(vllmHost, vllmTimeout))) {
    throw new Error(
      `Embedding server not reachable at ${vllmHost}. Start it with:\n` +
      `  bun run start  (or see scripts/start.ts for manual launch)`
    );
  }

  const hw = detectHardware();
  logger.info(`[embeddings] Hardware: ${hw.platform}${hw.gpuName ? ` (${hw.gpuName})` : ""}, ${hw.availableMemoryGB.toFixed(1)} GB available`);
  logger.info(`[embeddings] server at ${vllmHost}`);

  if (hw.platform === "apple-silicon") {
    logger.info("[embeddings] Apple Silicon — MLX server");
    return new QwenVLProvider(vllmHost, "Qwen/Qwen3-VL-Embedding-2B", undefined, "mlx");
  }

  if (hw.platform === "nvidia-blackwell") {
    logger.info("[embeddings] Blackwell — NVFP4 checkpoint");
    return new QwenVLProvider(vllmHost, "LifetimeMistake/Qwen3-VL-Embedding-2B-NVFP4");
  }

  const { variant, reason } = selectModel(
    hw.availableMemoryGB,
    embedding.overheadBuffer,
    embedding.quant
  );
  logger.info(`[embeddings] ${reason}`);
  return new QwenVLProvider(vllmHost, variant.modelTag);
}
