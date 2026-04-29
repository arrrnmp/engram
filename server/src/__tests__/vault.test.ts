import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseEngram,
  formatEngram,
  toSlug,
  extractWikilinks,
  updateEngramWikilinks,
} from "../vault.js";

const fixtures = join(import.meta.dir, "fixtures");

// ── toSlug ──────────────────────────────────────────────────────────────────

describe("toSlug", () => {
  test("preserves spaces and case", () => {
    expect(toSlug("Hello World")).toBe("Hello World");
  });

  test("strips filesystem-invalid characters", () => {
    expect(toSlug('file/with\\bad:chars?"<|>name')).toBe("filewithbadcharsname");
  });

  test("collapses whitespace runs", () => {
    expect(toSlug("hello   world\t\nnow")).toBe("hello world now");
  });

  test("trims leading/trailing whitespace", () => {
    expect(toSlug("  hello  ")).toBe("hello");
  });

  test("handles empty string", () => {
    expect(toSlug("")).toBe("");
  });

  test("preserves unicode", () => {
    expect(toSlug("Söledad — Rage Letter")).toBe("Söledad — Rage Letter");
  });
});

// ── parseEngram ─────────────────────────────────────────────────────────────

describe("parseEngram", () => {
  test("parses well-formed engram from fixture", () => {
    const raw = readFileSync(join(fixtures, "sample-engram.md"), "utf-8");
    const parsed = parseEngram(raw);

    expect(parsed.id).toBe("aaaaaaaa-1111-2222-3333-444444444444");
    expect(parsed.abstract).toBe('A test engram with "escaped quotes" and multiple sentences for coverage.');
    expect(parsed.title).toBe("Test Engram — Basic");
    expect(parsed.date).toBe("2026-04-29");
    expect(parsed.type).toBe("idea");
    expect(parsed.body).toBe("This is the body of the test engram.\n\nIt has multiple paragraphs.");
  });

  test("parses minimal engram without type", () => {
    const raw = readFileSync(join(fixtures, "no-type-engram.md"), "utf-8");
    const parsed = parseEngram(raw);

    expect(parsed.id).toBe("bbbbbbbb-5555-6666-7777-888888888888");
    expect(parsed.abstract).toBe("Minimal engram with no type and no related memories.");
    expect(parsed.title).toBe("Minimal Engram");
    expect(parsed.type).toBeUndefined();
    expect(parsed.body).toBe("Just body text, nothing else.");
  });

  test("coerces bare YAML date to string", () => {
    const raw = readFileSync(join(fixtures, "bare-date-engram.md"), "utf-8");
    const parsed = parseEngram(raw);

    expect(parsed.date).toBe("2026-04-29");
    expect(parsed.id).toBe("cccccccc-9999-aaaa-bbbb-cccccccccccc");
  });

  test("returns body for text with no frontmatter", () => {
    const parsed = parseEngram("Just plain text, no frontmatter.");
    expect(parsed.body).toBe("Just plain text, no frontmatter.");
    expect(parsed.id).toBeUndefined();
    expect(parsed.title).toBeUndefined();
  });

  test("returns body for malformed frontmatter (missing closing ---)", () => {
    const parsed = parseEngram("---\nid: \"broken\"\ntitle: \"No close\"\n\nBody text.");
    expect(parsed.body.length).toBeGreaterThan(0);
    expect(parsed.id).toBeUndefined();
  });

  test("handles empty frontmatter fields gracefully", () => {
    const raw = `---
---

Body only.`;
    const parsed = parseEngram(raw);
    expect(parsed.body).toBe("Body only.");
    expect(parsed.id).toBeUndefined();
    expect(parsed.title).toBeUndefined();
  });

  test("unescapes double quotes in abstract", () => {
    const raw = `---
id: "q-test"
abstract: "She said \\"hello\\" loudly"
title: "Quote Test"
date: "2026-04-29"
---

Body.`;
    const parsed = parseEngram(raw);
    expect(parsed.abstract).toBe('She said "hello" loudly');
  });

  test("unescapes double quotes in title", () => {
    const raw = `---
id: "qt"
abstract: "x"
title: "The \\"Great\\" Gatsby"
date: "2026-04-29"
---

Body.`;
    const parsed = parseEngram(raw);
    expect(parsed.title).toBe('The "Great" Gatsby');
  });
});

// ── formatEngram ────────────────────────────────────────────────────────────

describe("formatEngram", () => {
  test("produces valid YAML with all fields", () => {
    const result = formatEngram(
      "uuid-1",
      "Test abstract",
      "Test Title",
      "2026-04-29",
      "Body content here.",
      ["2026-04-28/Linked Engram"],
      "idea"
    );

    expect(result).toContain('id: "uuid-1"');
    expect(result).toContain('abstract: "Test abstract"');
    expect(result).toContain('title: "Test Title"');
    expect(result).toContain('date: "2026-04-29"');
    expect(result).toContain('type: "idea"');
    expect(result).toContain("Body content here.");
    expect(result).toContain("- [[2026-04-28/Linked Engram]]");
    expect(result).toContain("## Related Memories");
  });

  test("omits type line when type is undefined", () => {
    const result = formatEngram("uuid-2", "abs", "Title", "2026-04-29", "Body.", []);
    expect(result).not.toContain("type:");
  });

  test("omits Related Memories section when no wikilinks", () => {
    const result = formatEngram("uuid-3", "abs", "Title", "2026-04-29", "Body.", []);
    expect(result).not.toContain("## Related Memories");
  });

  test("escapes quotes in abstract and title", () => {
    const result = formatEngram('uuid-4', 'She said "hi"', 'The "End"', '2026-04-29', 'Body.', []);
    expect(result).toContain('abstract: "She said \\"hi\\""');
    expect(result).toContain('title: "The \\"End\\""');
  });

  test("collapses newlines in abstract to spaces", () => {
    const result = formatEngram("uuid-5", "line1\nline2\nline3", "T", "2026-04-29", "B.", []);
    expect(result).toContain('abstract: "line1 line2 line3"');
  });

  test("trims body content", () => {
    const result = formatEngram("uuid-6", "a", "T", "2026-04-29", "  Body.  ", []);
    expect(result).toContain("Body.");
    expect(result).not.toContain("  Body.  ");
  });

  test("ends with newline", () => {
    const result = formatEngram("uuid-7", "a", "T", "2026-04-29", "B.", []);
    expect(result.endsWith("\n")).toBe(true);
  });
});

// ── Round-trip: formatEngram → parseEngram ──────────────────────────────────

describe("round-trip", () => {
  test("preserves all fields through format → parse", () => {
    const id = "rt-uuid-1234";
    const abstract = "A round-trip test with some content.";
    const title = "Round Trip";
    const date = "2026-03-15";
    const body = "This is the body.\n\nWith paragraphs.";
    const type = "decision";

    const formatted = formatEngram(id, abstract, title, date, body, [], type);
    const parsed = parseEngram(formatted);

    expect(parsed.id).toBe(id);
    expect(parsed.abstract).toBe(abstract);
    expect(parsed.title).toBe(title);
    expect(parsed.date).toBe(date);
    expect(parsed.type).toBe(type);
    expect(parsed.body).toBe(body);
  });

  test("round-trip preserves wikilinks section", () => {
    const formatted = formatEngram(
      "rt-2", "abs", "T", "2026-04-29", "Body.",
      ["2026-04-28/A", "2026-04-28/B"]
    );
    const links = extractWikilinks(formatted);
    expect(links).toEqual(["2026-04-28/A", "2026-04-28/B"]);
  });
});

// ── extractWikilinks ────────────────────────────────────────────────────────

describe("extractWikilinks", () => {
  test("extracts wikilinks from Related Memories section", () => {
    const raw = `---
id: "x"
---

Body.

## Related Memories
- [[2026-04-28/Alpha]]
- [[2026-04-28/Beta]]
`;
    expect(extractWikilinks(raw)).toEqual(["2026-04-28/Alpha", "2026-04-28/Beta"]);
  });

  test("returns empty array when no Related Memories section", () => {
    const raw = `---
id: "x"
---

Just body.`;
    expect(extractWikilinks(raw)).toEqual([]);
  });

  test("returns empty array for plain text", () => {
    expect(extractWikilinks("No frontmatter at all.")).toEqual([]);
  });
});

// ── updateEngramWikilinks ───────────────────────────────────────────────────

describe("updateEngramWikilinks", () => {
  test("replaces existing section with new links", () => {
    const raw = `---
id: "x"
---

Body.

## Related Memories
- [[2026-04-28/Alpha]]
`;
    const result = updateEngramWikilinks(raw, ["2026-04-28/Beta"]);
    expect(result).toContain("[[2026-04-28/Beta]]");
    // Existing links are replaced — callers must merge old + new themselves
    expect(result).not.toContain("[[2026-04-28/Alpha]]");
  });

  test("creates Related Memories section when none exists", () => {
    const raw = `---
id: "x"
---

Body.`;
    const result = updateEngramWikilinks(raw, ["2026-04-28/NewLink"]);
    expect(result).toContain("## Related Memories");
    expect(result).toContain("[[2026-04-28/NewLink]]");
  });

  test("returns unchanged when no new links", () => {
    const raw = "---\nid: \"x\"\n---\n\nBody.";
    expect(updateEngramWikilinks(raw, [])).toBe(raw);
  });
});
