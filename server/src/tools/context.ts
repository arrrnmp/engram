import { z } from "zod";
import type { Vault } from "../vault.js";

export const UpdateContextInput = z.object({
  content: z.string().min(1).describe("New content for IMPORTANT.md"),
});

export type UpdateContextInput = z.infer<typeof UpdateContextInput>;

export function getImportantContext(vault: Vault) {
  const content = vault.readImportant();
  return {
    content: content || "(IMPORTANT.md is empty — run /update-important-memory to populate it)",
    exists: content.length > 0,
  };
}

export function updateImportantContext(input: UpdateContextInput, vault: Vault) {
  vault.writeImportant(input.content);
  return { success: true, message: "IMPORTANT.md updated." };
}
