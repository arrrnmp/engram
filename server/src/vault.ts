import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import matter from "gray-matter";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface EngramEntry {
  id?: string;
  abstract?: string;
  date: string;
  filename: string;
  title: string;
  path: string;
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

  writeEngram(date: string, title: string, content: string): string {
    const dir = join(this.root, date);
    mkdirSync(dir, { recursive: true });
    const filename = `${toSlug(title)}.md`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, content, "utf-8");
    return filepath;
  }

  readEngram(date: string, filename: string): string {
    return readFileSync(join(this.root, date, filename), "utf-8");
  }

  updateEngram(date: string, filename: string, content: string): void {
    writeFileSync(join(this.root, date, filename), content, "utf-8");
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

    const dirs = readdirSync(this.root)
      .filter((d) => DATE_RE.test(d))
      .filter((d) => {
        if (dateRange?.from && d < dateRange.from) return false;
        if (dateRange?.to && d > dateRange.to) return false;
        return true;
      })
      .sort();

    for (const date of dirs) {
      const dirPath = join(this.root, date);
      if (!statSync(dirPath).isDirectory()) continue;

    const files = readdirSync(dirPath).filter((f) => f.endsWith(".md"));
    for (const filename of files) {
      const entry: EngramEntry = {
        date,
        filename,
        title: filename.replace(/\.md$/, ""), // fallback: raw filename
        path: join(dirPath, filename),
      };
      try {
        const raw = readFileSync(join(dirPath, filename), "utf-8");
        const parsed = parseEngram(raw);
        if (parsed.id) entry.id = parsed.id;
        if (parsed.abstract) entry.abstract = parsed.abstract;
        if (parsed.title) entry.title = parsed.title;
        if (parsed.type) entry.type = parsed.type;
      } catch {}
      entries.push(entry);
    }
    }

    return entries;
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
