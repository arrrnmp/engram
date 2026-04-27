import { z } from "zod";
import type { Vault } from "../vault.js";

export const ReadEngramInput = z.object({
  id: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}\/.+$/)
    .describe('Engram ID in the form "YYYY-MM-DD/slug" (as returned by list_engrams or search_memory)'),
});

export type ReadEngramInput = z.infer<typeof ReadEngramInput>;

export function readEngram(input: ReadEngramInput, vault: Vault) {
  const slash = input.id.indexOf("/");
  const date = input.id.slice(0, slash);
  const slug = input.id.slice(slash + 1);
  const filename = slug.endsWith(".md") ? slug : `${slug}.md`;

  try {
    const content = vault.readEngram(date, filename);
    return { id: input.id, content };
  } catch {
    throw new Error(`Engram not found: ${input.id}`);
  }
}
