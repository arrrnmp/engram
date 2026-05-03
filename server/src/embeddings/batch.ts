import type { EmbeddingProvider, EmbedOptions } from "./types.js";
import { logger } from "../logger.js";

export interface BatchConfig {
  batchSize: number;
  batchMaxChars: number;
}

/**
 * Embeds an array of texts in memory-safe batches, respecting both item count
 * and total character limits per batch. Falls back to sequential single-embed
 * if a batch request fails.
 */
export async function batchEmbedTexts(
  embedder: EmbeddingProvider,
  texts: string[],
  options?: EmbedOptions,
  cfg: BatchConfig = { batchSize: 32, batchMaxChars: 100_000 }
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await embedder.embed(texts[0], options)];

  const results: number[][] = new Array(texts.length);
  let pos = 0;

  while (pos < texts.length) {
    let end = pos;
    let charCount = 0;

    while (
      end < texts.length &&
      end - pos < cfg.batchSize &&
      charCount + texts[end].length <= cfg.batchMaxChars
    ) {
      charCount += texts[end].length;
      end++;
    }
    if (end === pos) end = pos + 1; // ensure at least one item per batch

    const batch = texts.slice(pos, end);
    try {
      const embeddings = await embedder.embedBatch(batch, options);
      for (let i = 0; i < embeddings.length; i++) {
        results[pos + i] = embeddings[i];
      }
    } catch (err) {
      logger.warn(`[batch-embed] Batch of ${batch.length} failed, falling back to sequential`, { err });
      for (let i = 0; i < batch.length; i++) {
        results[pos + i] = await embedder.embed(batch[i], options);
      }
    }
    pos = end;
  }

  return results;
}
