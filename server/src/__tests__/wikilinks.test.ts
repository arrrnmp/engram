import { describe, test, expect } from "bun:test";
import { generateAndApplyWikilinks, toWikiPath } from "../wikilinks.js";
import { mockChroma, mockVault } from "./helpers/mocks.js";

describe("toWikiPath", () => {
  test("uses relativePath when available", () => {
    expect(toWikiPath({ relativePath: "2026-04-29/Test.md", date: "2026-04-29", filename: "Test.md" }))
      .toBe("2026-04-29/Test");
  });

  test("falls back to date/filename when relativePath missing", () => {
    expect(toWikiPath({ date: "2026-04-29", filename: "Test.md" }))
      .toBe("2026-04-29/Test");
  });

  test("strips .md extension", () => {
    expect(toWikiPath({ relativePath: "folder/note.md", date: "2026-04-29", filename: "note.md" }))
      .toBe("folder/note");
  });
});

describe("generateAndApplyWikilinks", () => {
  test("returns empty array when no related engrams above threshold", async () => {
    const chroma = mockChroma({ searchResults: [] });
    const vault = mockVault();
    const links = await generateAndApplyWikilinks("id-1", "2026-04-29/A", [0.1], vault, chroma, 0.72, 5);
    expect(links).toEqual([]);
  });

  test("filters out self and below-threshold results", async () => {
    const chroma = mockChroma({
      searchResults: [
        { id: "id-1", title: "Self", date: "2026-04-29", filename: "a.md", relativePath: "2026-04-29/a.md", excerpt: "E", similarity: 0.9 },
        { id: "id-2", title: "B", date: "2026-04-29", filename: "b.md", relativePath: "2026-04-29/b.md", excerpt: "E", similarity: 0.8 },
        { id: "id-3", title: "C", date: "2026-04-29", filename: "c.md", relativePath: "2026-04-29/c.md", excerpt: "E", similarity: 0.5 },
      ],
    });
    const vault = mockVault();
    const links = await generateAndApplyWikilinks("id-1", "2026-04-29/A", [0.1], vault, chroma, 0.72, 5);
    expect(links).toEqual(["2026-04-29/b"]);
  });

  test("writes bidirectional backlinks to related engrams", async () => {
    const chroma = mockChroma({
      searchResults: [
        { id: "id-2", title: "B", date: "2026-04-29", filename: "b.md", relativePath: "2026-04-29/b.md", excerpt: "E", similarity: 0.9 },
      ],
    });

    let updatedPath: string | undefined;
    let updatedContent: string | undefined;
    const vault = mockVault({
      readContent: "---\nid: \"id-2\"\n---\nBody of B",
    });
    vault.updateEngram = (path: string, content: string) => {
      updatedPath = path;
      updatedContent = content;
    };

    await generateAndApplyWikilinks("id-1", "2026-04-29/A", [0.1], vault, chroma, 0.72, 5);
    expect(updatedPath).toBe("2026-04-29/b.md");
    expect(updatedContent).toContain("[[2026-04-29/A]]");
  });

  test("skips backlink when already present", async () => {
    const chroma = mockChroma({
      searchResults: [
        { id: "id-2", title: "B", date: "2026-04-29", filename: "b.md", relativePath: "2026-04-29/b.md", excerpt: "E", similarity: 0.9 },
      ],
    });

    let updateCalled = false;
    const vault = mockVault({
      readContent: "---\nid: \"id-2\"\n---\nBody\n\n## Related Memories\n- [[2026-04-29/A]]\n",
    });
    vault.updateEngram = () => { updateCalled = true; };

    await generateAndApplyWikilinks("id-1", "2026-04-29/A", [0.1], vault, chroma, 0.72, 5);
    expect(updateCalled).toBe(false);
  });

  test("silently skips when related engram cannot be read", async () => {
    const chroma = mockChroma({
      searchResults: [
        { id: "id-2", title: "B", date: "2026-04-29", filename: "b.md", relativePath: "2026-04-29/b.md", excerpt: "E", similarity: 0.9 },
      ],
    });

    const vault = mockVault();
    vault.readEngram = () => { throw new Error("ENOENT"); };

    const links = await generateAndApplyWikilinks("id-1", "2026-04-29/A", [0.1], vault, chroma, 0.72, 5);
    expect(links).toEqual(["2026-04-29/b"]);
  });

  test("respects maxLinks limit", async () => {
    const searchResults = Array.from({ length: 10 }, (_, i) => ({
      id: `id-${i + 2}`,
      title: `T${i}`,
      date: "2026-04-29",
      filename: `${i}.md`,
      relativePath: `2026-04-29/${i}.md`,
      excerpt: "E",
      similarity: 0.9,
    }));
    const chroma = mockChroma({ searchResults });
    const vault = mockVault();

    const links = await generateAndApplyWikilinks("id-1", "2026-04-29/A", [0.1], vault, chroma, 0.72, 2);
    expect(links).toHaveLength(2);
  });
});
