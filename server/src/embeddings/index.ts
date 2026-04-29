import type { Config } from "../config.js";
import { detectHardware } from "../hardware/detect.js";
import { selectModel } from "../hardware/memory.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { EmbeddingProvider } from "./types.js";
import { logger } from "../logger.js";

export type { EmbeddingProvider };

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

export async function createEmbeddingProvider(
  config: Config
): Promise<EmbeddingProvider> {
  const { embedding } = config;

  // Explicit OpenAI override — no local runtime needed.
  if (embedding.provider === "openai") {
    if (!embedding.openai?.apiKey) {
      throw new Error(
        'embedding.provider is "openai" but embedding.openai.apiKey is not set in config.json'
      );
    }
    return new OpenAICompatProvider(
      "https://api.openai.com",
      embedding.openai.model,
      "openai",
      embedding.openai.apiKey
    );
  }

  const hw = detectHardware();
  const { variant, reason } = selectModel(
    hw.availableMemoryGB,
    embedding.overheadBuffer,
    embedding.model
  );
  logger.info(`[embeddings] ${reason}`);
  logger.info(`[embeddings] Hardware: ${hw.platform}${hw.gpuName ? ` (${hw.gpuName})` : ""}, ${hw.availableMemoryGB.toFixed(1)} GB available`);

  let effectiveProvider = embedding.provider;

  if (effectiveProvider === "auto") {
    if (hw.platform === "apple-silicon") effectiveProvider = "ollama";
    else if (hw.platform === "nvidia-blackwell") effectiveProvider = "nvidia";
    else effectiveProvider = "ollama";
  }

  if (effectiveProvider === "nvidia") {
    if (hw.platform !== "nvidia-blackwell") {
      logger.warn(`[embeddings] NVFP4 requires a Blackwell GPU (CC ≥ 10.0), detected ${hw.computeCapability ?? "unknown"}. Falling back to Ollama CUDA.`);
      effectiveProvider = "ollama";
    } else if (!variant.nvfp4Tag) {
      logger.warn(`[embeddings] No NVFP4 variant available for selected quant, falling back to Ollama.`);
      effectiveProvider = "ollama";
    } else {
      if (await isReachable(`${embedding.nvidia.host}/health`)) {
        logger.info(`[embeddings] Using NVIDIA/vLLM at ${embedding.nvidia.host}`);
        return new OpenAICompatProvider(
          embedding.nvidia.host,
          variant.nvfp4Tag,
          "nvidia"
        );
      }
      logger.warn(`[embeddings] NVIDIA/vLLM server not reachable at ${embedding.nvidia.host}, falling back to Ollama.`);
      effectiveProvider = "ollama";
    }
  }

  // Ollama — the universal fallback.
  logger.info(`[embeddings] Using Ollama at ${embedding.ollama.host} — model: ${variant.ollamaTag}`);
  return new OllamaProvider(embedding.ollama.host, variant.ollamaTag);
}
