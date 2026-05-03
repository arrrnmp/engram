import type { EngramChroma, SearchResult } from "./chroma.js";
import type { Vault } from "./vault.js";
import { updateEngramWikilinks } from "./vault.js";

const DEFAULT_THRESHOLD = 0.72;
const DEFAULT_MAX_LINKS = 5;

export async function generateAndApplyWikilinks(
  chromaId: string,
  wikiPath: string,
  embedding: number[],
  vault: Vault,
  chroma: EngramChroma,
  threshold = DEFAULT_THRESHOLD,
  maxLinks = DEFAULT_MAX_LINKS
): Promise<string[]> {
  const similar = await chroma.search(embedding, maxLinks + 1);
  const related = similar.filter(
    (r) => r.id !== chromaId && r.similarity >= threshold
  ).slice(0, maxLinks);

  if (related.length === 0) return [];

  const newLinks = related.map((r) => toWikiPath(r));

  await addBacklinks(wikiPath, related, vault);

  return newLinks;
}

export function toWikiPath(r: { relativePath?: string; date: string; filename: string }): string {
  if (r.relativePath) return r.relativePath.replace(/\.md$/, "");
  return `${r.date}/${r.filename.replace(/\.md$/, "")}`;
}

async function addBacklinks(
  wikiPath: string,
  related: SearchResult[],
  vault: Vault
): Promise<void> {
  for (const r of related) {
    try {
      const rp = r.relativePath || `${r.date}/${r.filename}`;
      const existing = vault.readEngram(rp);
      if (existing.includes(`[[${wikiPath}]]`)) continue;
      vault.updateEngram(rp, updateEngramWikilinks(existing, [wikiPath]));
    } catch {
      // Engram may have been moved or deleted; skip silently.
    }
  }
}
