import { z } from "zod";
import type { EngramChroma } from "../chroma.js";
import type { Vault } from "../vault.js";
import type { VaultIndex } from "../vault-index.js";

export const ReadEngramInput = z.object({
  id: z
    .string()
    .uuid()
    .describe("Engram UUID (as returned by list_engrams or search_memory)"),
});

export type ReadEngramInput = z.infer<typeof ReadEngramInput>;

export async function readEngram(
  input: ReadEngramInput,
  vaultIndex: VaultIndex,
  vault: Vault,
  chroma: EngramChroma
) {
  const location = await vaultIndex.resolveWithFallback(input.id, vault.root, chroma);
  if (!location) throw new Error(`Engram not found: ${input.id}`);

  const content = vault.readEngram(location.date, location.filename);
  return { id: input.id, content };
}
