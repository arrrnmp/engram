import { z } from "zod";
import type { Vault } from "../vault.js";
import type { VaultIndex } from "../vault-index.js";
import type { EngramContent } from "./read-engram.js";
import { extractEngramContent } from "./read-engram.js";
import { logger } from "../logger.js";

const MAX_RESPONSE_CHARS = 80_000;

// ── Input schema ──────────────────────────────────────────────────────────────

export const ReadEngramsInput = z.object({
  ids: z
    .array(z.string().uuid())
    .min(1)
    .max(20)
    .describe(
      "List of Engram UUIDs to read. Returns results in the same order as the input list."
    ),
});

export type ReadEngramsInput = z.infer<typeof ReadEngramsInput>;

// ── Handler ───────────────────────────────────────────────────────────────────

export function readEngrams(
  input: ReadEngramsInput,
  vaultIndex: VaultIndex,
  vault: Vault
): { results: Array<EngramContent | { id: string; error: string }> } {
  const results = input.ids.map((id) => {
    const location = vaultIndex.resolve(id);
    if (!location) {
      logger.warn(
        `[tool] read_engrams: UUID not found in vault index: ${id}`
      );
      return { id, error: "Engram not found" };
    }
    try {
      const raw = vault.readEngram(location.relativePath);
      return extractEngramContent(id, raw);
    } catch (err) {
      return { id, error: String(err) };
    }
  });

  return { results };
}

// ── Response truncation ───────────────────────────────────────────────────────

export function truncateBatchResponse(
  results: Array<EngramContent | { id: string; error: string }>
): {
  results: Array<EngramContent | { id: string; error: string }>;
  truncated: boolean;
} {
  const json = JSON.stringify({ results }, null, 2);
  if (json.length <= MAX_RESPONSE_CHARS)
    return { results, truncated: false };

  return {
    results: results.map((r) =>
      "error" in r
        ? r
        : { ...r, body: r.body.slice(0, 1000) + "\n...(truncated)" }
    ),
    truncated: true,
  };
}
