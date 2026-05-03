import { describe, test, expect } from "bun:test";
import { tokenize, keywordSearch } from "../search/keyword.js";
import type { Vault } from "../vault.js";

function createKeywordVault(
  entries: Array<{ relativePath: string; title: string; content: string; id?: string; type?: string; date?: string }>
): Vault {
  const byPath = Object.fromEntries(entries.map((e) => [e.relativePath, e.content]));
  return {
    root: "/tmp/test-vault",
    listEngrams: (_dateRange?) =>
      entries
        .filter((e) => {
          if (!_dateRange) return true;
          const d = e.date ?? e.relativePath.split("/")[0];
          if (_dateRange.from && d < _dateRange.from) return false;
          if (_dateRange.to && d > _dateRange.to) return false;
          return true;
        })
        .map((e) => ({
          id: e.id ?? e.relativePath.replace(".md", ""),
          date: e.date ?? e.relativePath.split("/")[0] ?? "2026-04-29",
          filename: e.relativePath.split("/").pop()!,
          title: e.title,
          relativePath: e.relativePath,
          type: e.type,
        })),
    readEngram: (path: string) => byPath[path] ?? "---\n---\n",
  } as unknown as Vault;
}

describe("tokenize", () => {
  test("lowercases and splits on punctuation", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
  });

  test("drops stop words", () => {
    expect(tokenize("the and for")).toEqual([]);
  });

  test("drops tokens shorter than 3 chars", () => {
    expect(tokenize("a bc def")).toEqual(["def"]);
  });

  test("handles empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  test("handles only stop words and short tokens", () => {
    expect(tokenize("the a")).toEqual([]);
  });

  test("splits on multiple delimiters", () => {
    expect(tokenize("foo-bar_baz.qux")).toEqual(["foo", "bar", "baz", "qux"]);
  });
});

describe("keywordSearch", () => {
  test("returns empty for empty query after tokenization", () => {
    const vault = createKeywordVault([
      { relativePath: "test.md", title: "Test", content: "---\ntitle: \"Test\"\n---\nbody" },
    ]);
    const results = keywordSearch("the a", vault);
    expect(results).toEqual([]);
  });

  test("finds matches in title", () => {
    const vault = createKeywordVault([
      { relativePath: "hello.md", title: "Hello World", content: "---\ntitle: \"Hello World\"\n---\nBody text" },
    ]);
    const results = keywordSearch("hello", vault);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("hello");
    expect(results[0].score).toBeGreaterThan(0);
  });

  test("finds matches in body when title also matches", () => {
    // keywordSearch has a cheap pass that requires title or abstract match before reading body
    const vault = createKeywordVault([
      { relativePath: "test.md", title: "Test keyword", content: "---\ntitle: \"Test keyword\"\n---\nThis contains the keyword" },
    ]);
    const results = keywordSearch("keyword", vault);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("test");
  });

  test("weights title matches higher than body", () => {
    const vault = createKeywordVault([
      { relativePath: "title-match.md", title: "alpha beta", content: "---\ntitle: \"alpha beta\"\n---\nirrelevant body" },
      { relativePath: "body-match.md", title: "other alpha", content: "---\ntitle: \"other alpha\"\n---\nalpha body" },
    ]);
    const results = keywordSearch("alpha beta", vault);
    expect(results).toHaveLength(2);
    expect(results[0].relativePath).toBe("title-match.md");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test("excerpt anchored at first body match", () => {
    const prefix = "Prefix text. ".repeat(20);
    const body = prefix + "needle in haystack. " + "Suffix text.".repeat(20);
    const vault = createKeywordVault([
      { relativePath: "excerpt.md", title: "Excerpt needle", content: `---\ntitle: "Excerpt needle"\n---\n${body}` },
    ]);
    const results = keywordSearch("needle", vault);
    expect(results).toHaveLength(1);
    expect(results[0].excerpt).toContain("needle");
    expect(results[0].excerpt.endsWith("…")).toBe(true);
  });

  test("returns body start as excerpt when no body match", () => {
    const vault = createKeywordVault([
      { relativePath: "a.md", title: "alpha match", content: "---\ntitle: \"alpha match\"\n---\nbody text here" },
    ]);
    const results = keywordSearch("alpha", vault);
    expect(results[0].excerpt).toContain("body text here");
  });

  test("filters by date range", () => {
    const vault = createKeywordVault([
      { relativePath: "2026-01-01/a.md", title: "January hello", content: "---\ntitle: \"January hello\"\ndate: \"2026-01-01\"\n---\nbody", date: "2026-01-01" },
      { relativePath: "2026-04-01/b.md", title: "April hello", content: "---\ntitle: \"April hello\"\ndate: \"2026-04-01\"\n---\nbody", date: "2026-04-01" },
    ]);
    const results = keywordSearch("hello", vault, { from: "2026-03-01", to: "2026-05-01" });
    expect(results).toHaveLength(1);
    expect(results[0].relativePath).toBe("2026-04-01/b.md");
  });

  test("filters by type", () => {
    const vault = createKeywordVault([
      { relativePath: "a.md", title: "A hello", content: "---\ntitle: \"A hello\"\ntype: \"idea\"\n---\nbody", type: "idea" },
      { relativePath: "b.md", title: "B hello", content: "---\ntitle: \"B hello\"\ntype: \"chat\"\n---\nbody", type: "chat" },
    ]);
    const results = keywordSearch("hello", vault, undefined, "idea");
    expect(results).toHaveLength(1);
    expect(results[0].relativePath).toBe("a.md");
  });

  test("respects maxResults", () => {
    const vault = createKeywordVault(
      Array.from({ length: 10 }, (_, i) => ({
        relativePath: `${i}.md`,
        title: `Title ${i} common`,
        content: `---\ntitle: "Title ${i} common"\n---\nbody`,
      }))
    );
    const results = keywordSearch("common", vault, undefined, undefined, 3);
    expect(results).toHaveLength(3);
  });

  test("skips engrams without id", () => {
    const vault = createKeywordVault([
      { relativePath: "a.md", title: "A hello", content: "---\ntitle: \"A hello\"\n---\nbody" },
    ]);
    // Mock listEngrams returns id from relativePath by default; override to undefined
    (vault as any).listEngrams = () => [
      { id: undefined, date: "2026-04-29", filename: "a.md", title: "A hello", relativePath: "a.md" },
    ];
    const results = keywordSearch("hello", vault);
    expect(results).toEqual([]);
  });

  test("sorts by score descending", () => {
    const vault = createKeywordVault([
      { relativePath: "low.md", title: "low match", content: "---\ntitle: \"low match\"\n---\none match" },
      { relativePath: "high.md", title: "high match", content: "---\ntitle: \"high match\"\n---\none match" },
    ]);
    const results = keywordSearch("high match", vault);
    expect(results[0].relativePath).toBe("high.md");
    expect(results[1].relativePath).toBe("low.md");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});
