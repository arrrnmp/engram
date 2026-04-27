export interface ModelVariant {
  modelSize: "8b" | "4b";
  quant: "q8_0" | "q6_k" | "q4_k_m";
  bits: number;
  vramGB: number;
  ollamaTag: string;
  mlxTag: string;
  nvfp4Tag?: string;
}

// Ordered highest-quality first. Hard floor: q4_k_m (~4.5 bits effective).
export const MODEL_VARIANTS: ModelVariant[] = [
  {
    modelSize: "8b",
    quant: "q8_0",
    bits: 8,
    vramGB: 8.5,
    ollamaTag: "qwen3-embedding:8b-q8_0",
    mlxTag: "mlx-community/Qwen3-Embedding-8B-8bit",
  },
  {
    modelSize: "8b",
    quant: "q6_k",
    bits: 6,
    vramGB: 6.5,
    ollamaTag: "qwen3-embedding:8b-q6_k",
    mlxTag: "mlx-community/Qwen3-Embedding-8B-6bit",
  },
  {
    modelSize: "8b",
    quant: "q4_k_m",
    bits: 4.5,
    vramGB: 4.7,
    ollamaTag: "qwen3-embedding:8b-q4_k_m",
    mlxTag: "mlx-community/Qwen3-Embedding-8B-4bit",
    nvfp4Tag: "Qwen/Qwen3-Embedding-8B-NVFP4",
  },
  {
    modelSize: "4b",
    quant: "q8_0",
    bits: 8,
    vramGB: 4.5,
    ollamaTag: "qwen3-embedding:4b-q8_0",
    mlxTag: "mlx-community/Qwen3-Embedding-4B-8bit",
  },
  {
    modelSize: "4b",
    quant: "q6_k",
    bits: 6,
    vramGB: 3.5,
    ollamaTag: "qwen3-embedding:4b-q6_k",
    mlxTag: "mlx-community/Qwen3-Embedding-4B-6bit",
  },
  {
    modelSize: "4b",
    quant: "q4_k_m",
    bits: 4.5,
    vramGB: 2.5,
    ollamaTag: "qwen3-embedding:4b-q4_k_m",
    mlxTag: "mlx-community/Qwen3-Embedding-4B-4bit",
    nvfp4Tag: "Qwen/Qwen3-Embedding-4B-NVFP4",
  },
];

const MIN_BITS = 4.0;

export interface ModelSelection {
  variant: ModelVariant;
  safeMemoryGB: number;
  reason: string;
}

export function selectModel(
  availableGB: number,
  overheadBuffer: number,
  preferredSize?: "8b" | "4b"
): ModelSelection {
  const safeGB = availableGB * (1 - overheadBuffer);

  const candidates = preferredSize
    ? MODEL_VARIANTS.filter((v) => v.modelSize === preferredSize)
    : MODEL_VARIANTS;

  const suitable = candidates.filter(
    (v) => v.vramGB <= safeGB && v.bits >= MIN_BITS
  );

  if (suitable.length === 0) {
    const floor = MODEL_VARIANTS[MODEL_VARIANTS.length - 1];
    throw new Error(
      `Insufficient memory for any supported model variant.\n` +
        `Available (after ${(overheadBuffer * 100).toFixed(0)}% overhead reserve): ${safeGB.toFixed(1)} GB\n` +
        `Minimum required (${floor.modelSize} ${floor.quant}): ${floor.vramGB} GB\n` +
        `Consider setting embedding.provider = "openai" in config.json.`
    );
  }

  const variant = suitable[0];
  const steppedDown =
    preferredSize && variant.modelSize !== preferredSize
      ? ` (stepped down from ${preferredSize} — insufficient memory)`
      : "";

  return {
    variant,
    safeMemoryGB: safeGB,
    reason: `Selected ${variant.modelSize} ${variant.quant} (${variant.bits}-bit, ${variant.vramGB} GB)${steppedDown}`,
  };
}
