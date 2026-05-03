import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import matter from "gray-matter";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface EngramEntry {
  id?: string;
  abstract?: string;
  date: string;
  filename: string;
  title: string;
  relativePath: string;
  type?: string;
}

export class Vault {
  readonly root: string;

  constructor(vaultPath: string) {
    this.root = vaultPath.startsWith("~")
      ? join(homedir(), vaultPath.slice(1))
      : vaultPath;
    mkdirSync(this.root, { recursive: true });
  }

  writeEngram(dir: string, title: string, content: string): string {
    const fullDir = join(this.root, dir);
    mkdirSync(fullDir, { recursive: true });
    const filename = `${toSlug(title)}.md`;
    const filepath = join(fullDir, filename);
    writeFileSync(filepath, content, "utf-8");
    return filepath;
  }

  readEngram(relativePath: string): string {
    return readFileSync(join(this.root, relativePath), "utf-8");
  }

  updateEngram(relativePath: string, content: string): void {
    writeFileSync(join(this.root, relativePath), content, "utf-8");
  }

  readImportant(): string {
    const p = join(this.root, "IMPORTANT.md");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  writeImportant(content: string): void {
    writeFileSync(join(this.root, "IMPORTANT.md"), content, "utf-8");
  }

  listEngrams(dateRange?: { from?: string; to?: string }): EngramEntry[] {
    const entries: EngramEntry[] = [];
    if (!existsSync(this.root)) return entries;
    this.scanEngrams(this.root, entries, dateRange);
    entries.sort((a, b) => b.date.localeCompare(a.date));
    return entries;
  }

  private scanEngrams(
    dir: string,
    entries: EngramEntry[],
    dateRange?: { from?: string; to?: string }
  ): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.scanEngrams(fullPath, entries, dateRange);
      } else if (entry.name.endsWith(".md")) {
        const relativePath = fullPath.slice(this.root.length + 1);
        const filename = entry.name;

        // Derive date from frontmatter or from the path if it starts with a date dir.
        const firstDir = relativePath.split("/")[0] ?? "";
        const pathDate = DATE_RE.test(firstDir) ? firstDir : "";

        const engEntry: EngramEntry = {
          date: pathDate,
          filename,
          title: filename.replace(/\.md$/, ""),
          relativePath,
        };
        try {
          const raw = readFileSync(fullPath, "utf-8");
          const parsed = parseEngram(raw);
          if (parsed.id) engEntry.id = parsed.id;
          if (parsed.abstract) engEntry.abstract = parsed.abstract;
          if (parsed.title) engEntry.title = parsed.title;
          if (parsed.type) engEntry.type = parsed.type;
          // Use frontmatter date if available, otherwise keep path-derived date.
          if (parsed.date) engEntry.date = parsed.date;
        } catch {}

        // Apply date range filter on the engram's date.
        if (dateRange?.from && engEntry.date < dateRange.from) continue;
        if (dateRange?.to && engEntry.date > dateRange.to) continue;

        entries.push(engEntry);
      }
    }
  }

}

/** Convert a title to a safe filename (preserves spaces, case, and most symbols). */
export function toSlug(title: string): string {
  return title
    // Strip characters forbidden in filenames on macOS and Windows
    .replace(/[/\\:*?"<>|]/g, "")
    .trim()
    // Collapse runs of whitespace to a single space
    .replace(/\s+/g, " ");
}

export function formatEngram(
  id: string,
  abstract: string,
  title: string,
  date: string,
  content: string,
  wikilinks: string[],
  type?: string,
  tags: string[] = []
): string {
  const typeLine = type ? `\ntype: "${type}"` : "";
  // Normalize abstract to a single line for clean frontmatter storage.
  const abstractEscaped = abstract.replace(/\n/g, " ").replace(/"/g, '\\"').trim();
  const tagsLine = tags.length > 0
    ? `tags: [${tags.map((t) => `"${t}"`).join(", ")}]`
    : `tags: []`;
  const frontmatter = [
    "---",
    `id: "${id}"`,
    `abstract: "${abstractEscaped}"`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    `date: "${date}"${typeLine}`,
    tagsLine,
    "---",
    "",
  ].join("\n");

  const body = content.trim();

  const linksSection =
    wikilinks.length > 0
      ? ["\n\n## Related Memories", ...wikilinks.map((l) => `- [[${l}]]`)].join("\n")
      : "";

  return `${frontmatter}${body}${linksSection}\n`;
}

export interface ParsedEngram {
  id?: string;
  abstract?: string;
  title?: string;
  date?: string;
  type?: string;
  body: string;
}

export function parseEngram(raw: string): ParsedEngram {
  let data: Record<string, unknown>;
  let content: string;

  try {
    const parsed = matter(raw);
    data = parsed.data as Record<string, unknown>;
    content = parsed.content;
  } catch {
    return { body: raw.trim() };
  }

  const relIdx = content.indexOf("\n\n## Related Memories");
  const body = (relIdx >= 0 ? content.slice(0, relIdx) : content).trim();

  return {
    id: typeof data.id === "string" ? data.id : undefined,
    abstract: typeof data.abstract === "string" ? data.abstract : undefined,
    title: typeof data.title === "string" ? data.title : undefined,
    date: typeof data.date === "string" ? data.date : (data.date instanceof Date ? data.date.toISOString().slice(0, 10) : undefined),
    type: typeof data.type === "string" ? data.type : undefined,
    body,
  };
}

/** Extract vault paths from the ## Related Memories section (e.g. ["2026-04-28/Some Title"]). */
export function extractWikilinks(raw: string): string[] {
  const idx = raw.indexOf("## Related Memories");
  if (idx < 0) return [];
  const section = raw.slice(idx);
  return [...section.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
}

export function updateEngramWikilinks(
  existing: string,
  newLinks: string[]
): string {
  if (newLinks.length === 0) return existing;

  const SECTION_MARKER = "## Related Memories";
  const idx = existing.indexOf(SECTION_MARKER);

  const base = idx >= 0 ? existing.slice(0, idx).trimEnd() : existing.trimEnd();
  const newSection = [
    "",
    "",
    SECTION_MARKER,
    ...newLinks.map((l) => `- [[${l}]]`),
    "",
  ].join("\n");

  return base + newSection;
}
