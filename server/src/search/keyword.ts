import type { Vault } from "../vault.js";

const STOP_WORDS = new Set(["the", "and", "for", "with", "this", "that", "are", "was", "has"]);

export interface KeywordResult {
  id: string;
  title: string;
  date: string;
  filename: string;
  score: number; // 0–1
  excerpt: string;
  abstract?: string;
  type?: string;
}

/** Lowercase, split on whitespace/punctuation, drop stop words and tokens < 3 chars. */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s\-_.,;:!?()[\]{}]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

export function keywordSearch(
  query: string,
  vault: Vault,
  dateRange?: { from?: string; to?: string },
  type?: string,
  maxResults = 20
): KeywordResult[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const engrams = vault.listEngrams(dateRange);
  const candidates: KeywordResult[] = [];

  for (const e of engrams) {
    if (!e.id) continue;
    if (type && e.type !== type) continue;

    // ── Cheap pass: title + abstract (already in memory from listEngrams) ──
    const titleLower = e.title.toLowerCase();
    const abstractLower = (e.abstract ?? "").toLowerCase();
    const titleMatches = terms.filter((t) => titleLower.includes(t));
    const abstractMatches = terms.filter((t) => abstractLower.includes(t));

    if (titleMatches.length === 0 && abstractMatches.length === 0) continue;

    // ── Full body read (single read, used for both scoring and excerpt) ──────
    let raw: string;
    try { raw = vault.readEngram(e.date, e.filename); } catch { continue; }

    // Strip frontmatter: find the closing "---" after the opening fence.
    const fmEnd = raw.indexOf("\n---\n", 4);
    const body = fmEnd >= 0 ? raw.slice(fmEnd + 5) : raw;
    const bodyLower = body.toLowerCase();

    const bodyMatches = terms.filter((t) => bodyLower.includes(t));
    if (titleMatches.length === 0 && bodyMatches.length === 0) continue;

    // Title matches weighted 2× (more signal than body hits).
    const score = Math.min(
      (titleMatches.length * 2 + bodyMatches.length) / (terms.length * 2),
      1
    );

    // Excerpt anchored at first matching term in body.
    const firstBodyTerm = terms.find((t) => bodyLower.includes(t));
    let excerpt: string;
    if (firstBodyTerm) {
      const matchIdx = bodyLower.indexOf(firstBodyTerm);
      const start = Math.max(0, matchIdx - 60);
      const slice = body.slice(start, start + 300).trim();
      excerpt = (start > 0 || slice.length < body.trimEnd().length) ? slice + "…" : slice;
    } else {
      const slice = body.slice(0, 300).trim();
      excerpt = slice.length < body.trimEnd().length ? slice + "…" : slice;
    }

    candidates.push({
      id: e.id,
      title: e.title,
      date: e.date,
      filename: e.filename,
      score,
      excerpt,
      ...(e.abstract ? { abstract: e.abstract } : {}),
      ...(e.type ? { type: e.type } : {}),
    });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, maxResults);
}
