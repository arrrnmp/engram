import { describe, test, expect, beforeEach } from "bun:test";
import { saveMemory } from "../tools/save-memory.js";
import { mockChroma, mockEmbedder, mockVault, mockVaultIndex } from "./helpers/mocks.js";
import type { Config } from "../config.js";

describe("saveMemory", () => {
  let writtenPath = "";
  let writtenContent = "";
  let upsertedRecord: any = null;
  let upsertedEmbedding: any = null;
  let indexSetId = "";
  let indexSetPath = "";
  let vault: ReturnType<typeof mockVault>;
  let chroma: ReturnType<typeof mockChroma>;
  let embedder: ReturnType<typeof mockEmbedder>;
  let vaultIndex: ReturnType<typeof mockVaultIndex>;
  let config: Config;

  beforeEach(() => {
    writtenPath = "";
    writtenContent = "";
    upsertedRecord = null;
    upsertedEmbedding = null;
    indexSetId = "";
    indexSetPath = "";

    vault = mockVault();
    (vault as any).writeEngram = (dir: string, title: string, content: string) => {
      writtenPath = `${vault.root}/${dir}/${title}.md`;
      writtenContent = content;
      return writtenPath;
    };

    chroma = mockChroma();
    (chroma as any).upsert = async (record: any, embedding: any) => {
      upsertedRecord = record;
      upsertedEmbedding = embedding;
    };
    (chroma as any).search = async () => []; // no wikilinks by default

    embedder = mockEmbedder({
      embed: async (text: string, options?: { taskInstruction?: string }) => {
        return Array(4096).fill(text.length * 0.001);
      },
    });

    const resolutions = new Map<string, { relativePath: string }>();
    vaultIndex = mockVaultIndex({ resolutions });
    (vaultIndex as any).set = (id: string, loc: { relativePath: string }) => {
      indexSetId = id;
      indexSetPath = loc.relativePath;
    };

    config = {
      vault: { path: vault.root },
      server: { port: 7384, https: false },
      chroma: { host: "http://localhost:8000", collection: "engrams" },
      wikilinks: { threshold: 0.72, maxLinks: 5 },
      embedding: {
        queryCacheSize: 64,
        overheadBuffer: 0.25,
        vllm: { host: "http://localhost:8001", healthTimeout: 2000 },
      },
      watcher: { enabled: true, libreOfficePath: "libreoffice" },
    };
  });

  test("generates UUID if not provided", async () => {
    const result = await saveMemory(
      { title: "Test", abstract: "Abstract", content: "Body" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test("defaults date to today if not provided", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = await saveMemory(
      { title: "Test", abstract: "Abstract", content: "Body" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(result.date).toBe(today);
  });

  test("uses provided date when given", async () => {
    const result = await saveMemory(
      { title: "Test", abstract: "Abstract", content: "Body", date: "2025-01-15" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(result.date).toBe("2025-01-15");
  });

  test("sanitizes folder path via sanitizeFolderPath", async () => {
    const result = await saveMemory(
      { title: "Test", abstract: "Abstract", content: "Body", folder: "/projects/Engram/" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(result.relativePath).toMatch(/^projects\/Engram\//);
    expect(writtenContent).toContain("Body");
  });

  test("generates slug from title for filename", async () => {
    const result = await saveMemory(
      { title: "My Great Idea", abstract: "Abstract", content: "Body" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(result.filename).toBe("My Great Idea.md");
    expect(result.relativePath).toContain("My Great Idea.md");
  });

  test("embeds content with retrieval prefix", async () => {
    let embeddedText = "";
    const customEmbedder = mockEmbedder({
      embed: async (text: string, options?: { taskInstruction?: string }) => {
        embeddedText = text;
        expect(options?.taskInstruction).toContain("retrieval");
        return Array(4096).fill(0.1);
      },
    });

    await saveMemory(
      { title: "Test", abstract: "Abstract", content: "Body content here" },
      vault,
      chroma,
      customEmbedder,
      config,
      vaultIndex
    );
    expect(embeddedText).toBe("Body content here");
  });

  test("calls generateAndApplyWikilinks for backlink generation", async () => {
    let searchCalled = false;
    (chroma as any).search = async () => {
      searchCalled = true;
      return [
        {
          id: "other-id",
          title: "Other",
          date: "2026-04-28",
          filename: "other.md",
          relativePath: "2026-04-28/other.md",
          similarity: 0.95,
        },
      ];
    };

    const result = await saveMemory(
      { title: "Test", abstract: "Abstract", content: "Body" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(searchCalled).toBe(true);
    expect(result.wikilinks.length).toBeGreaterThan(0);
    expect(writtenContent).toContain("## Related Memories");
  });

  test("writes vault file with correct frontmatter and body", async () => {
    await saveMemory(
      { title: "Test Title", abstract: "Test abstract", content: "Test body", date: "2026-05-01", type: "idea" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(writtenContent).toContain('id: "');
    expect(writtenContent).toContain('abstract: "Test abstract"');
    expect(writtenContent).toContain('title: "Test Title"');
    expect(writtenContent).toContain('date: "2026-05-01"');
    expect(writtenContent).toContain('type: "idea"');
    expect(writtenContent).toContain("Test body");
  });

  test("registers in vaultIndex", async () => {
    const result = await saveMemory(
      { title: "Test", abstract: "Abstract", content: "Body" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(indexSetId).toBe(result.id);
    expect(indexSetPath).toBe(result.relativePath);
  });

  test("upserts to ChromaDB with correct metadata", async () => {
    await saveMemory(
      { title: "Test", abstract: "Abstract", content: "Body", date: "2026-05-01", type: "decision" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(upsertedRecord).not.toBeNull();
    expect(upsertedRecord.title).toBe("Test");
    expect(upsertedRecord.content).toBe("Body");
    expect(upsertedRecord.date).toBe("2026-05-01");
    expect(upsertedRecord.abstract).toBe("Abstract");
    expect(upsertedRecord.type).toBe("decision");
    expect(upsertedRecord.relativePath).toContain("Test.md");
    expect(upsertedRecord.vaultPath).toBe(vault.root);
    expect(upsertedEmbedding).toBeDefined();
  });

  test("folder fallback: uses folder param if provided, else today's date", async () => {
    const today = new Date().toISOString().slice(0, 10);

    const resultWithFolder = await saveMemory(
      { title: "A", abstract: "Abstract", content: "Body", folder: "projects" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(resultWithFolder.relativePath.startsWith("projects/")).toBe(true);

    const resultWithoutFolder = await saveMemory(
      { title: "B", abstract: "Abstract", content: "Body" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(resultWithoutFolder.relativePath.startsWith(`${today}/`)).toBe(true);
  });

  test("works without vaultIndex", async () => {
    const result = await saveMemory(
      { title: "Test", abstract: "Abstract", content: "Body" },
      vault,
      chroma,
      embedder,
      config,
      undefined
    );
    expect(result.id).toBeDefined();
    expect(writtenContent).toContain("Body");
  });

  test("omits type from frontmatter when not provided", async () => {
    await saveMemory(
      { title: "Test", abstract: "Abstract", content: "Body" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(writtenContent).not.toContain("type:");
  });

  test("returns correct message with type and wikilinks info", async () => {
    (chroma as any).search = async () => [
      {
        id: "other-id",
        title: "Other",
        date: "2026-04-28",
        filename: "other.md",
        relativePath: "2026-04-28/other.md",
        similarity: 0.95,
      },
    ];

    const result = await saveMemory(
      { title: "Test", abstract: "Abstract", content: "Body", type: "chat" },
      vault,
      chroma,
      embedder,
      config,
      vaultIndex
    );
    expect(result.message).toContain("type: chat");
    expect(result.message).toContain("1 related memories linked");
  });
});
