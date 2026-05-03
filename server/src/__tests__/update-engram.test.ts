import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { updateEngram } from "../tools/update-engram.js";
import { formatEngram } from "../vault.js";
import { chunkIndexPath } from "../tools/chunk-engram.js";
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
    (vault as any).updateEngram = (_relativePath: string, content: string) => { writtenContent = content; };

    const resolutions = new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]);
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
    (vault as any).updateEngram = (_rp: string, c: string) => { writtenContent = c; };

    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]) });
    const chroma = mockChroma();

    await updateEngram(makeInput({ setAbstract: "line1\nline2\nline3" }), vault, vaultIndex, chroma, mockEmbedder());

    expect(writtenContent).toContain('abstract: "line1 line2 line3"');
    expect(writtenContent).not.toContain("abstract: \"line1\n");
  });

  test("syncs abstract to ChromaDB metadata", async () => {
    const original = makeEngramContent();
    const vault = mockVault({ readContent: original });
    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]) });

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
    (vault as any).updateEngram = (_rp: string, c: string) => { writtenContent = c; };

    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]) });

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
    (vault as any).updateEngram = (_rp: string, c: string) => { writtenContent = c; };

    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]) });

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
    (vault as any).updateEngram = (_rp: string, c: string) => { writtenContent = c; };

    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]) });

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
    (vault as any).updateEngram = (_rp: string, c: string) => { writtenContent = c; };

    const targetId = "bbbbbbbb-5555-6666-7777-888888888888";
    const resolutions = new Map([
      [TEST_ID, { relativePath: "2026-04-29/test.md" }],
      [targetId, { relativePath: "2026-04-28/target.md" }],
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
    (vault as any).updateEngram = (_rp: string, c: string) => { writtenContent = c; };

    const targetId = "bbbbbbbb-5555-6666-7777-888888888888";
    const resolutions = new Map([
      [TEST_ID, { relativePath: "2026-04-29/test.md" }],
      [targetId, { relativePath: "2026-04-28/target.md" }],
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
    (vault as any).updateEngram = (_rp: string, c: string) => { writtenContent = c; };

    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]) });

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

describe("updateEngram — editContent", () => {
  test("patches body with targeted string replacement", async () => {
    const original = makeEngramContent({ body: "The quick brown fox jumps over the lazy dog." });
    let writtenContent = "";
    const vault = mockVault({ readContent: original });
    (vault as any).updateEngram = (_rp: string, c: string) => { writtenContent = c; };

    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]) });

    let upsertedContent = "";
    const chroma = mockChroma();
    (chroma as any).upsert = async (record: any) => { upsertedContent = record.content; };

    const result = await updateEngram(
      makeInput({ editContent: { old_string: "lazy dog", new_string: "sleepy cat" } }),
      vault, vaultIndex, chroma, mockEmbedder()
    );

    expect(result.contentUpdated).toBe(true);
    expect(writtenContent).toContain("sleepy cat");
    expect(writtenContent).not.toContain("lazy dog");
    expect(upsertedContent).toContain("sleepy cat");
  });

  test("throws when old_string not found", async () => {
    const original = makeEngramContent({ body: "Hello world." });
    const vault = mockVault({ readContent: original });
    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]) });

    await expect(
      updateEngram(
        makeInput({ editContent: { old_string: "nonexistent", new_string: "x" } }),
        vault, vaultIndex, mockChroma(), mockEmbedder()
      )
    ).rejects.toThrow("old_string not found");
  });

  test("throws when old_string is ambiguous (multiple matches)", async () => {
    const original = makeEngramContent({ body: "foo bar foo baz foo" });
    const vault = mockVault({ readContent: original });
    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]) });

    await expect(
      updateEngram(
        makeInput({ editContent: { old_string: "foo", new_string: "x" } }),
        vault, vaultIndex, mockChroma(), mockEmbedder()
      )
    ).rejects.toThrow("appears more than once");
  });

  test("throws when setContent and editContent used together", async () => {
    const original = makeEngramContent();
    const vault = mockVault({ readContent: original });
    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]) });

    await expect(
      updateEngram(
        makeInput({ setContent: "new body", editContent: { old_string: "x", new_string: "y" } }),
        vault, vaultIndex, mockChroma(), mockEmbedder()
      )
    ).rejects.toThrow("cannot be used together");
  });

  test("combined with addTags in one call", async () => {
    const original = makeEngramContent({ body: "Alpha beta gamma." });
    let writtenContent = "";
    const vault = mockVault({ readContent: original });
    (vault as any).updateEngram = (_rp: string, c: string) => { writtenContent = c; };

    const vaultIndex = mockVaultIndex({ resolutions: new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]) });

    const result = await updateEngram(
      makeInput({ editContent: { old_string: "beta", new_string: "BETA" }, addTags: ["edited"] }),
      vault, vaultIndex, mockChroma(), mockEmbedder()
    );

    expect(result.contentUpdated).toBe(true);
    expect(result.tagsAdded).toBe(1);
    expect(writtenContent).toContain("BETA");
    expect(writtenContent).toContain('"edited"');
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

describe("updateEngram — stale chunk warning", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "engram-test-update-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("appends warning when engram has chunks and content is updated", async () => {
    const original = makeEngramContent({ body: "Original body content." });
    let writtenContent = "";
    const vault = mockVault({ readContent: original });
    (vault as any).root = dir;
    (vault as any).updateEngram = (_rp: string, c: string) => { writtenContent = c; };

    const resolutions = new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]);
    const vaultIndex = mockVaultIndex({ resolutions });

    const indexPath = chunkIndexPath(dir, TEST_ID);
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, JSON.stringify([{ chunkId: "c1", chunkIndex: 0, charCount: 50 }]), "utf-8");

    const result = await updateEngram(
      makeInput({ setContent: "New body text." }),
      vault, vaultIndex, mockChroma(), mockEmbedder(),
    );

    expect(result.contentUpdated).toBe(true);
    expect(result.message).toContain("stale");
    expect(result.message).toContain("re-embed");
  });

  test("no warning when engram has no chunks", async () => {
    const original = makeEngramContent({ body: "Original body content." });
    const vault = mockVault({ readContent: original });
    (vault as any).root = dir;

    const resolutions = new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]);
    const vaultIndex = mockVaultIndex({ resolutions });

    const result = await updateEngram(
      makeInput({ setContent: "New body text." }),
      vault, vaultIndex, mockChroma(), mockEmbedder(),
    );

    expect(result.contentUpdated).toBe(true);
    expect(result.message).not.toContain("stale");
  });

  test("no warning when content is not updated even with chunks", async () => {
    const original = makeEngramContent({ body: "Original body content." });
    const vault = mockVault({ readContent: original });
    (vault as any).root = dir;

    const resolutions = new Map([[TEST_ID, { relativePath: "2026-04-29/test.md" }]]);
    const vaultIndex = mockVaultIndex({ resolutions });

    const indexPath = chunkIndexPath(dir, TEST_ID);
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, JSON.stringify([{ chunkId: "c1", chunkIndex: 0, charCount: 50 }]), "utf-8");

    const result = await updateEngram(
      makeInput({ addTags: ["test"] }),
      vault, vaultIndex, mockChroma(), mockEmbedder(),
    );

    expect(result.contentUpdated).toBe(false);
    expect(result.message).not.toContain("stale");
  });
});
