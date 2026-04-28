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
});

export type ListEngramsInput = z.infer<typeof ListEngramsInput>;

export function listEngrams(input: ListEngramsInput, vault: Vault) {
  const all = vault.listEngrams(input.date_range);
  const limited = all.slice(0, input.limit);

  return {
    engrams: limited.map((e) => ({
      id: vault.engramId(e.date, e.filename),
      date: e.date,
      filename: e.filename,
      title: e.title,
      ...(e.type ? { type: e.type } : {}),
    })),
    total: all.length,
    returned: limited.length,
  };
}
