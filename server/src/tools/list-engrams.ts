import { z } from "zod";
import type { Vault } from "../vault.js";

export const ListEngramsInput = z.object({
  date_range: z
    .object({
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0).describe("Number of engrams to skip (for pagination)"),
});

export type ListEngramsInput = z.infer<typeof ListEngramsInput>;

export function listEngrams(input: ListEngramsInput, vault: Vault) {
  const all = vault.listEngrams(input.date_range);
  const offset = input.offset ?? 0;
  const page = all.slice(offset, offset + input.limit);

  return {
    engrams: page.map((e) => ({
      ...(e.id ? { id: e.id } : {}),
      date: e.date,
      filename: e.filename,
      title: e.title,
      ...(e.abstract ? { abstract: e.abstract } : {}),
      ...(e.type ? { type: e.type } : {}),
    })),
    total: all.length,
    returned: page.length,
    offset,
  };
}
