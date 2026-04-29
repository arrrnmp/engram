import { describe, test, expect } from "bun:test";
import { updateEngram } from "../tools/update-engram.js";
import { formatEngram } from "../vault.js";
import { mockChroma, mockEmbedder, mockVault, mockVaultIndex } from "./helpers/mocks.js";

const TEST_ID = "aaaaaaaa-1111-2222-3333-444444444444";

function makeEngramContent(overrides: Record<string, string> = {}) {
  return formatEngram(
    overrides.id ?? TEST_ID,
    overrides.abstract ?? "Original abstract",
    overrides.title ?? "Test Engram",
    overrides.date ?? "2026-04-29",
    overrides.body ?? "Original body content.",
    [],
    overrides.type
  );
}

function makeInput(overrides: Record<string, any> = {}) {
  return {
    id: TEST_ID,
    ...overrides,
  };
}

describe("updateEngram — setAbstract", () => {
  test("replaces abstract in frontmatter", async () => {
    const original = makeEngramContent();
    let writtenContent = "";
    const vault = mockVault({ readContent: original });
    (vault as any).updateEngram = (_date: string, _filename: string, content: string) => { writtenContent = content; };

    const resolutions = new Map([[TEST_ID, { date: "2026-04-29", filename: "test.md" }]]);
    const vaultIndex = mockVaultIndex({ resolutions });
    const chroma = mockChroma();

    const result = await updateEngram(makeInput({ setAbstract: "New abstract here" }), vault, vaultIndex, chroma, mockEmbedder());

    expect(result.abstractSet).toBe(true);
    expect(writtenContent).toContain('abstract: "New abstract here"');
    // Preserves other fields
    expect(writtenContent).toContain(TEST_ID);
    expect(writtenContent).toContain("Original body content.");
  });

  test("collapses newlines in abstract", async () => {
    const original = makeEngramContent();
    let writtenContent = "";
    const vault = mockVault({ readContent: original });
    (vault as any).updateEngram = (_d: string, _f: string, c: string) => { writtenContent = c; };

    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { date: "2026-04-29", filename: "test.md" }]]) });
    const chroma = mockChroma();

    await updateEngram(makeInput({ setAbstract: "line1\nline2\nline3" }), vault, vaultIndex, chroma, mockEmbedder());

    expect(writtenContent).toContain('abstract: "line1 line2 line3"');
    expect(writtenContent).not.toContain("abstract: \"line1\n");
  });

  test("syncs abstract to ChromaDB metadata", async () => {
    const original = makeEngramContent();
    const vault = mockVault({ readContent: original });
    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { date: "2026-04-29", filename: "test.md" }]]) });

    let patchedId = "";
    let patchedData: Record<string, string> = {};
    const chroma = mockChroma();
    (chroma as any).patchMetadata = async (id: string, patch: Record<string, string>) => {
      patchedId = id;
      patchedData = patch;
    };

    await updateEngram(makeInput({ setAbstract: "Synced" }), vault, vaultIndex, chroma, mockEmbedder());

    expect(patchedId).toBe(TEST_ID);
    expect(patchedData.abstract).toBe("Synced");
  });
});

describe("updateEngram — addTags", () => {
  test("adds new tags to empty tags array", async () => {
    const original = makeEngramContent();
    let writtenContent = "";
    const vault = mockVault({ readContent: original });
    (vault as any).updateEngram = (_d: string, _f: string, c: string) => { writtenContent = c; };

    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { date: "2026-04-29", filename: "test.md" }]]) });

    await updateEngram(makeInput({ addTags: ["alpha", "beta"] }), vault, vaultIndex, mockChroma(), mockEmbedder());

    expect(writtenContent).toContain('"alpha"');
    expect(writtenContent).toContain('"beta"');
  });

  test("merges with existing tags without duplicates", async () => {
    // Create engram with existing tags
    const original = formatEngram(TEST_ID, "abs", "Title", "2026-04-29", "body.", [], undefined);
    // Manually inject tags into the formatted output
    const withTags = original.replace('tags: []', 'tags: ["existing", "alpha"]');

    let writtenContent = "";
    const vault = mockVault({ readContent: withTags });
    (vault as any).updateEngram = (_d: string, _f: string, c: string) => { writtenContent = c; };

    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { date: "2026-04-29", filename: "test.md" }]]) });

    const result = await updateEngram(makeInput({ addTags: ["alpha", "new"] }), vault, vaultIndex, mockChroma(), mockEmbedder());

    expect(writtenContent).toContain('"existing"');
    expect(writtenContent).toContain('"alpha"');
    expect(writtenContent).toContain('"new"');
    expect(result.tagsAdded).toBe(1); // only "new" is actually added
  });
});

describe("updateEngram — setContent", () => {
  test("replaces body and re-embeds", async () => {
    const original = makeEngramContent();
    let writtenContent = "";
    const vault = mockVault({ readContent: original });
    (vault as any).updateEngram = (_d: string, _f: string, c: string) => { writtenContent = c; };

    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { date: "2026-04-29", filename: "test.md" }]]) });

    let upsertedContent = "";
    const chroma = mockChroma();
    (chroma as any).upsert = async (record: any) => { upsertedContent = record.content; };

    const result = await updateEngram(
      makeInput({ setContent: "Completely new body text." }),
      vault, vaultIndex, chroma, mockEmbedder()
    );

    expect(result.contentUpdated).toBe(true);
    expect(writtenContent).toContain("Completely new body text.");
    expect(writtenContent).not.toContain("Original body content.");
    expect(upsertedContent).toBe("Completely new body text.");
  });
});

describe("updateEngram — addWikilinks", () => {
  test("adds wikilinks by resolving target UUIDs", async () => {
    const original = makeEngramContent();
    let writtenContent = "";
    const vault = mockVault({ readContent: original });
    (vault as any).updateEngram = (_d: string, _f: string, c: string) => { writtenContent = c; };

    const targetId = "bbbbbbbb-5555-6666-7777-888888888888";
    const resolutions = new Map([
      [TEST_ID, { date: "2026-04-29", filename: "test.md" }],
      [targetId, { date: "2026-04-28", filename: "target.md" }],
    ]);
    const vaultIndex = mockVaultIndex({ resolutions });

    const result = await updateEngram(
      makeInput({ addWikilinks: [targetId] }),
      vault, vaultIndex, mockChroma(), mockEmbedder()
    );

    expect(result.wikilinksAdded).toBe(1);
    expect(writtenContent).toContain("[[2026-04-28/target]]");
  });

  test("skips already-linked targets", async () => {
    const original = formatEngram(
      TEST_ID, "abs", "Test", "2026-04-29", "body.",
      ["2026-04-28/target"]
    );

    let writtenContent = "";
    const vault = mockVault({ readContent: original });
    (vault as any).updateEngram = (_d: string, _f: string, c: string) => { writtenContent = c; };

    const targetId = "bbbbbbbb-5555-6666-7777-888888888888";
    const resolutions = new Map([
      [TEST_ID, { date: "2026-04-29", filename: "test.md" }],
      [targetId, { date: "2026-04-28", filename: "target.md" }],
    ]);
    const vaultIndex = mockVaultIndex({ resolutions });

    const result = await updateEngram(
      makeInput({ addWikilinks: [targetId] }),
      vault, vaultIndex, mockChroma(), mockEmbedder()
    );

    expect(result.wikilinksAdded).toBe(0); // already linked
  });
});

describe("updateEngram — combined operations", () => {
  test("applies setAbstract + addTags in one call", async () => {
    const original = makeEngramContent();
    let writtenContent = "";
    const vault = mockVault({ readContent: original });
    (vault as any).updateEngram = (_d: string, _f: string, c: string) => { writtenContent = c; };

    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { date: "2026-04-29", filename: "test.md" }]]) });

    const result = await updateEngram(
      makeInput({ setAbstract: "Updated", addTags: ["tag1"] }),
      vault, vaultIndex, mockChroma(), mockEmbedder()
    );

    expect(result.abstractSet).toBe(true);
    expect(result.tagsAdded).toBe(1);
    expect(writtenContent).toContain('abstract: "Updated"');
    expect(writtenContent).toContain('"tag1"');
  });
});

describe("updateEngram — errors", () => {
  test("throws when engram not found", async () => {
    const vaultIndex = mockVaultIndex({ resolutions: new Map() }); // empty — nothing resolves
    await expect(
      updateEngram(makeInput(), mockVault(), vaultIndex, mockChroma(), mockEmbedder())
    ).rejects.toThrow("Engram not found");
  });
});
