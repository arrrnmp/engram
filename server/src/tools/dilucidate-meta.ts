import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { Vault } from "../vault.js";

const META_FILENAME = ".dilucidate-meta.json";

export const UpdateDilucidateMetaInput = z.object({
  meta: z.string().describe("Full JSON content for .dilucidate-meta.json"),
});

export type UpdateDilucidateMetaInput = z.infer<typeof UpdateDilucidateMetaInput>;

export function getDilucidateMeta(vault: Vault): { meta: object | null } {
  const path = join(vault.root, META_FILENAME);
  if (!existsSync(path)) return { meta: null };
  try {
    return { meta: JSON.parse(readFileSync(path, "utf-8")) };
  } catch {
    return { meta: null };
  }
}

export function updateDilucidateMeta(
  input: UpdateDilucidateMetaInput,
  vault: Vault
): { message: string } {
  // Validate JSON before writing.
  JSON.parse(input.meta);
  writeFileSync(join(vault.root, META_FILENAME), input.meta, "utf-8");
  return { message: "Dilucidate metadata updated." };
}
