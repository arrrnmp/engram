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

  // Wikilinks use vault paths (date/filename), not ChromaDB UUIDs.
  const newLinks = related.map(
    (r) => `${r.date}/${r.filename.replace(/\.md$/, "")}`
  );

  await addBacklinks(wikiPath, related, vault);

  return newLinks;
}

async function addBacklinks(
  wikiPath: string,
  related: SearchResult[],
  vault: Vault
): Promise<void> {
  for (const r of related) {
    try {
      const existing = vault.readEngram(r.date, r.filename);
      if (existing.includes(`[[${wikiPath}]]`)) continue;
      vault.updateEngram(r.date, r.filename, updateEngramWikilinks(existing, [wikiPath]));
    } catch {
      // Engram may have been moved or deleted; skip silently.
    }
  }
}
