import type { EngramChroma, SearchResult } from "./chroma.js";
import type { Vault } from "./vault.js";
import { updateEngramWikilinks } from "./vault.js";

const DEFAULT_THRESHOLD = 0.72;
const DEFAULT_MAX_LINKS = 5;

export async function generateAndApplyWikilinks(
  newId: string,
  embedding: number[],
  vault: Vault,
  chroma: EngramChroma,
  threshold = DEFAULT_THRESHOLD,
  maxLinks = DEFAULT_MAX_LINKS
): Promise<string[]> {
  // Find similar existing engrams (exclude the new one itself).
  const similar = await chroma.search(embedding, maxLinks + 1);
  const related = similar.filter(
    (r) => r.id !== newId && r.similarity >= threshold
  ).slice(0, maxLinks);

  if (related.length === 0) return [];

  const newLinks = related.map((r) => r.id); // e.g. "2026-04-25/project-goals"

  // Add backlinks to existing engrams pointing back at the new engram.
  await addBacklinks(newId, related, vault);

  return newLinks;
}

async function addBacklinks(
  newId: string,
  related: SearchResult[],
  vault: Vault
): Promise<void> {
  for (const r of related) {
    try {
      const existing = vault.readEngram(r.date, r.filename);
      if (existing.includes(`[[${newId}]]`)) continue;
      vault.updateEngram(r.date, r.filename, updateEngramWikilinks(existing, [newId]));
    } catch {
      // Engram may have been moved or deleted; skip silently.
    }
  }
}
