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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface EngramEntry {
  date: string;
  filename: string;
  title: string;
  path: string;
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
        entries.push({
          date,
          filename,
          title: slugToTitle(filename.replace(/\.md$/, "")),
          path: join(dirPath, filename),
        });
      }
    }

    return entries;
  }

  engramId(date: string, filename: string): string {
    return `${date}/${filename.replace(/\.md$/, "")}`;
  }
}

export function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function formatEngram(
  title: string,
  date: string,
  content: string,
  wikilinks: string[]
): string {
  const frontmatter = [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `date: "${date}"`,
    `tags: []`,
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
