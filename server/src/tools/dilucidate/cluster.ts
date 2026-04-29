import { z } from "zod";
import type { EngramChroma } from "../../chroma.js";
import type { Vault } from "../../vault.js";
import type { VaultIndex } from "../../vault-index.js";
import { clusterMemories } from "../../dilucidate/cluster.js";

export const ClusterMemoriesInput = z.object({
  threshold: z.number().min(0).max(1).default(0.72)
    .describe("Minimum cosine similarity to consider two engrams related (default 0.72)"),
  minSize: z.number().int().min(2).max(50).default(3)
    .describe("Minimum number of engrams to form a cluster (default 3)"),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Only include engrams created on or after this date (YYYY-MM-DD)"),
});

export type ClusterMemoriesInput = z.infer<typeof ClusterMemoriesInput>;

export async function clusterMemoriesTool(
  input: ClusterMemoriesInput,
  chroma: EngramChroma,
  vault: Vault,
  vaultIndex: VaultIndex
) {
  const { clusters, totalEngrams } = await clusterMemories(
    chroma,
    vault,
    vaultIndex,
    input.threshold,
    input.minSize,
    input.since
  );

  return {
    clusters,
    totalEngrams,
    totalClusters: clusters.length,
  };
}
