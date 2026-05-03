export interface ModelVariant {
  quant: "q8_0" | "q6_k" | "q5_k_m" | "q4_k_m";
  bits: number;
  vramGB: number;
  modelTag: string;
  vllmArgs: string[];
}

const GGUF_REPO = "DevQuasar/Qwen.Qwen3-VL-Embedding-2B-GGUF";
const GGUF_BASE = "Qwen.Qwen3-VL-Embedding-2B";

// Pre-quantized GGUF checkpoints, highest-quality first. Blackwell uses a
// separate NVFP4 checkpoint handled in embeddings/index.ts.
export const MODEL_VARIANTS: ModelVariant[] = [
  {
    quant: "q8_0",
    bits: 8,
    vramGB: 3.5,
    modelTag: GGUF_REPO,
    vllmArgs: ["--load-format", "gguf", "--gguf-file", `${GGUF_BASE}.Q8_0.gguf`],
  },
  {
    quant: "q6_k",
    bits: 6,
    vramGB: 3.0,
    modelTag: GGUF_REPO,
    vllmArgs: ["--load-format", "gguf", "--gguf-file", `${GGUF_BASE}.Q6_K.gguf`],
  },
  {
    quant: "q5_k_m",
    bits: 5,
    vramGB: 2.5,
    modelTag: GGUF_REPO,
    vllmArgs: ["--load-format", "gguf", "--gguf-file", `${GGUF_BASE}.Q5_K_M.gguf`],
  },
  {
    quant: "q4_k_m",
    bits: 4,
    vramGB: 2.0,
    modelTag: GGUF_REPO,
    vllmArgs: ["--load-format", "gguf", "--gguf-file", `${GGUF_BASE}.Q4_K_M.gguf`],
  },
];

const MIN_BITS = 4;

// KV cache for Qwen3-VL-Embedding-2B (fp16): 28 layers × 2 (K+V) × 8 kv_heads × 128 head_dim × 2 bytes
// ≈ 114,688 bytes per token → ~9,100 tokens per GB → ~36,000 chars per GB (at ~4 chars/token).
// MODEL_OVERHEAD_GB is the midpoint of Q4 (2 GB) … Q8 (3.5 GB) loaded footprints.
const MODEL_OVERHEAD_GB = 3;
const KV_CHARS_PER_GB = 36_000;
const AVG_ITEM_CHARS = 2_000;

export function deriveBatchLimits(availableMemoryGB: number): { batchSize: number; batchMaxChars: number } {
  const budgetGB = Math.max(0.5, availableMemoryGB - MODEL_OVERHEAD_GB);
  const batchMaxChars = Math.round(budgetGB * KV_CHARS_PER_GB);
  const batchSize = Math.min(256, Math.max(1, Math.round(batchMaxChars / AVG_ITEM_CHARS)));
  return { batchSize, batchMaxChars };
}

export interface ModelSelection {
  variant: ModelVariant;
  safeMemoryGB: number;
  reason: string;
}

export function selectModel(
  availableGB: number,
  overheadBuffer: number,
  preferredQuant?: "q8_0" | "q6_k" | "q5_k_m" | "q4_k_m"
): ModelSelection {
  const safeGB = availableGB * (1 - overheadBuffer);

  let candidates = MODEL_VARIANTS.filter(
    (v) => v.vramGB <= safeGB && v.bits >= MIN_BITS
  );

  if (preferredQuant) {
    const preferred = candidates.find((v) => v.quant === preferredQuant);
    if (preferred) {
      return {
        variant: preferred,
        safeMemoryGB: safeGB,
        reason: `Selected GGUF ${preferred.quant} (${preferred.bits}-bit, ${preferred.vramGB} GB) — user override`,
      };
    }
    // Preferred quant doesn't fit — fall through to auto-selection
  }

  if (candidates.length === 0) {
    const floor = MODEL_VARIANTS[MODEL_VARIANTS.length - 1];
    throw new Error(
      `Insufficient memory for any supported GGUF variant.\n` +
        `Available (after ${(overheadBuffer * 100).toFixed(0)}% overhead reserve): ${safeGB.toFixed(1)} GB\n` +
        `Minimum required (${floor.quant}): ${floor.vramGB} GB\n` +
        `Consider a machine with more GPU memory.`
    );
  }

  const variant = candidates[0];
  return {
    variant,
    safeMemoryGB: safeGB,
    reason: `Selected GGUF ${variant.quant} (${variant.bits}-bit, ${variant.vramGB} GB)`,
  };
}
