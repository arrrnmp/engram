import { z } from "zod";
import matter from "gray-matter";
import type { EngramChroma } from "../chroma.js";
import type { Vault } from "../vault.js";
import { parseEngram, extractWikilinks } from "../vault.js";
import type { VaultIndex } from "../vault-index.js";

// ── Structured response type ─────────────────────────────────────────────────

export interface EngramContent {
  id: string;
  title: string;
  date: string;
  type?: string;
  tags: string[];
  body: string;
  wikilinks: string[];
}

export function extractEngramContent(
  id: string,
  raw: string
): EngramContent | { id: string; error: string } {
  try {
    const { title, date, type, body } = parseEngram(raw);
    const parsed = matter(raw);
    const tags = Array.isArray(parsed.data.tags)
      ? (parsed.data.tags as unknown[]).map(String)
      : [];
    const wikilinks = extractWikilinks(raw);
    return {
      id,
      title: title ?? "",
      date: date ?? "",
      ...(type ? { type } : {}),
      tags,
      body,
      wikilinks,
    };
  } catch (err) {
    return { id, error: String(err) };
  }
}

// ── Input schema ──────────────────────────────────────────────────────────────

export const ReadEngramInput = z.object({
  id: z
    .string()
    .uuid()
    .describe("Engram UUID (as returned by list_engrams or search_memory)"),
});

export type ReadEngramInput = z.infer<typeof ReadEngramInput>;

// ── Handler ───────────────────────────────────────────────────────────────────

export async function readEngram(
  input: ReadEngramInput,
  vaultIndex: VaultIndex,
  vault: Vault,
  chroma: EngramChroma
): Promise<EngramContent> {
  const location = await vaultIndex.resolveWithFallback(input.id, vault.root, chroma);
  if (!location) throw new Error(`Engram not found: ${input.id}`);

  const raw = vault.readEngram(location.relativePath);
  const result = extractEngramContent(input.id, raw);
  if ("error" in result) throw new Error(result.error);
  return result;
}
