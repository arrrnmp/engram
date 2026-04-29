# Spec: gray-matter Frontmatter Parser

## Problem

`parseEngram()` in `vault.ts` uses regex to extract YAML frontmatter fields:

```typescript
id: fm.match(/^id:\s*"([^"]+)"/m)?.[1],
abstract: fm.match(/^abstract:\s*"((?:[^"\\]|\\.)*)"/m)?.[1]?.replace(/\\"/g, '"'),
```

`updateEngram()` in `update-engram.ts` uses regex to replace fields in-place:

```typescript
content = content.replace(/^abstract:\s*".*"$/m, `abstract: "${escaped}"`);
```

These work only because `formatEngram()` writes an exact, controlled format. They silently break on:

- A value with a newline that didn't get collapsed before writing
- A quote character that was double-escaped (e.g. `\\"` inside an already-escaped string)
- Future frontmatter keys added without updating the regex list
- Any file hand-edited in Obsidian with a trailing space or different quote style
- Tags written as `["a", "b"]` vs `[ "a" , "b" ]` (whitespace variation)

There is no error thrown — `parseEngram` returns `undefined` for any field it can't match, and `listEngrams` silently swallows parse failures. A corrupted file disappears from the index.

## Solution

Replace regex parsing and in-place regex replacement with [`gray-matter`](https://github.com/jonschlinkert/gray-matter) — a battle-tested frontmatter library used by Hugo, Jekyll, and Gatsby.

`gray-matter` parses YAML frontmatter into a plain JS object and gives back the body separately. For writes, we define a **custom serializer** that produces the exact same format `formatEngram()` already writes — so the on-disk format doesn't change at all, and existing files remain fully valid.

## Dependency

```bash
cd server && bun add gray-matter
```

`gray-matter` has zero runtime dependencies and is ~14 KB. It uses `js-yaml` internally, which handles the full YAML 1.2 spec.

## Implementation

### Parsing — `vault.ts: parseEngram()`

**Before:**
```typescript
export function parseEngram(raw: string): ParsedEngram {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return { body: raw.trim() };
  const fm = fmMatch[1];
  // ... one regex per field
}
```

**After:**
```typescript
import matter from "gray-matter";

export function parseEngram(raw: string): ParsedEngram {
  const { data, content } = matter(raw);

  const relIdx = content.indexOf("\n\n## Related Memories");
  const body = (relIdx >= 0 ? content.slice(0, relIdx) : content).trim();

  return {
    id: typeof data.id === "string" ? data.id : undefined,
    abstract: typeof data.abstract === "string" ? data.abstract : undefined,
    title: typeof data.title === "string" ? data.title : undefined,
    date: typeof data.date === "string" ? data.date : undefined,
    type: typeof data.type === "string" ? data.type : undefined,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    body,
  };
}
```

The `typeof` guards prevent YAML type coercion surprises (e.g. a bare `date: 2026-04-29` that js-yaml parses as a `Date` object).

### Writing — `vault.ts: formatEngram()`

`formatEngram()` already constructs frontmatter as a hand-built string. This does not need to change — it writes valid YAML that gray-matter will parse correctly.

If we ever want to use `matter.stringify()` for writes, we would pass a custom `engines` option to control quoting. For now, keeping `formatEngram()` as-is is safer and preserves the exact format.

### In-place Updates — `update-engram.ts`

The `setAbstract` and `addTags` operations currently do regex replacement on the raw string. After this change, the approach becomes parse → mutate → reformat:

```typescript
import matter from "gray-matter";

if (input.setAbstract || input.addTags) {
  const parsed = matter(content);

  if (input.setAbstract) {
    parsed.data.abstract = input.setAbstract.replace(/\n/g, " ").trim();
  }

  if (input.addTags?.length) {
    const existing: string[] = Array.isArray(parsed.data.tags) ? parsed.data.tags.map(String) : [];
    parsed.data.tags = Array.from(new Set([...existing, ...input.addTags]));
  }

  // Reserialize using formatEngram to guarantee exact format.
  const { extractWikilinks, formatEngram } = await import("../vault.js");
  const wikilinks = extractWikilinks(content);
  content = formatEngram(
    parsed.data.id,
    parsed.data.abstract ?? "",
    parsed.data.title ?? "",
    parsed.data.date ?? "",
    parsed.content.trim(),
    wikilinks,
    parsed.data.type
  );
}
```

This is slightly more expensive (full file reformat vs. a one-line regex replace) but correct for all inputs.

## Migration

No migration needed. Existing vault files are already valid YAML (they were written by `formatEngram`). gray-matter will parse them correctly on first read. No file format change on disk.

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| gray-matter parses `date:` field as a JS `Date` object | Medium | `typeof` guard in `parseEngram` converts to string |
| Serialization changes key order | Low | We use `formatEngram` for writes, not `matter.stringify` |
| Bundle size increase | Very low | gray-matter + js-yaml ≈ 120 KB; Bun bundles it efficiently |
| Breaking change to existing files | None | gray-matter is a superset of the current regex parser |

## When to Implement

After the core feature set is stable. This is a reliability improvement, not a new capability. The current regex approach is adequate while the vault is small and `formatEngram` is the only writer. Implement when:
- The frontmatter schema has stabilized (no more new fields expected soon)
- OR a real parse failure is observed in the wild
