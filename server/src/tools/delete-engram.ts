import { z } from "zod";
import { unlinkSync } from "fs";
import { join } from "path";
import type { EngramChroma } from "../chroma.js";
import type { Vault } from "../vault.js";
import type { VaultIndex } from "../vault-index.js";

export const DeleteEngramInput = z.object({
  id: z.string().uuid().describe("Engram UUID to permanently delete (as returned by list_engrams or search_memory)"),
});

export type DeleteEngramInput = z.infer<typeof DeleteEngramInput>;

export async function deleteEngram(
  input: DeleteEngramInput,
  vault: Vault,
  vaultIndex: VaultIndex,
  chroma: EngramChroma
) {
  const location = await vaultIndex.resolveWithFallback(input.id, vault.root, chroma);
  if (!location) throw new Error(`Engram not found: ${input.id}`);

  // Delete the vault file.
  unlinkSync(join(vault.root, location.date, location.filename));

  // Remove from ChromaDB.
  await chroma.delete(input.id);

  // Remove from the in-memory index.
  vaultIndex.remove(input.id);

  return {
    id: input.id,
    date: location.date,
    filename: location.filename,
    message: `Deleted: ${location.date}/${location.filename} [${input.id}]`,
  };
}
