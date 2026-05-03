import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { validateDimensions, runStartupReindex, populateBodyHashRegistry } from "../startup.js";
import { Vault } from "../vault.js";
import { VaultIndex } from "../vault-index.js";
import { BodyHashRegistry } from "../body-hash.js";
import { mockChroma, mockEmbedder } from "./helpers/mocks.js";

describe("validateDimensions", () => {
  test("returns true when actual matches expected", () => {
    expect(validateDimensions(2048, 2048, { provider: "test", model: "test" })).toBe(true);
  });

  test("returns true when actual is null", () => {
    expect(validateDimensions(null, 2048, { provider: "test", model: "test" })).toBe(true);
  });

  test("returns false when dimensions mismatch", () => {
    expect(validateDimensions(1024, 2048, { provider: "test", model: "test" })).toBe(false);
  });
});

describe("runStartupReindex", () => {
  let dir: string;
  let vault: Vault;
  let vaultIndex: VaultIndex;
  let chroma: ReturnType<typeof mockChroma>;
  let embedder: ReturnType<typeof mockEmbedder>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-startup-"));
    vault = new Vault(dir);
    vaultIndex = new VaultIndex();
    chroma = mockChroma();
    embedder = mockEmbedder();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMd(relativePath: string, content: string) {
    const fullPath = join(dir, relativePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }

  test("assigns UUIDs to files without id", async () => {
    writeMd("no-id.md", "---\ntitle: \"No ID\"\n---\nBody");
    const allEntries: any[] = [];
    chroma.getAll = async () => [];
    chroma.upsert = async (meta, _emb) => { allEntries.push(meta); };

    await runStartupReindex(vault, chroma, embedder, vaultIndex, { batchSize: 10, batchMaxChars: 10000 }, false);

    expect(allEntries).toHaveLength(1);
    expect(allEntries[0].id).toBeDefined();
    expect(allEntries[0].id).toHaveLength(36);
  });

  test("re-indexes files missing from ChromaDB", async () => {
    writeMd("missing.md", "---\nid: \"existing-id\"\ntitle: \"Missing\"\n---\nBody");
    const upserts: any[] = [];
    chroma.getAll = async () => [];
    chroma.upsert = async (meta, _emb) => { upserts.push(meta); };

    await runStartupReindex(vault, chroma, embedder, vaultIndex, { batchSize: 10, batchMaxChars: 10000 }, false);

    expect(upserts).toHaveLength(1);
    expect(upserts[0].id).toBe("existing-id");
  });

  test("force re-embed re-embeds all engrams", async () => {
    writeMd("a.md", "---\nid: \"id-a\"\ntitle: \"A\"\n---\nBody A");
    writeMd("b.md", "---\nid: \"id-b\"\ntitle: \"B\"\n---\nBody B");
    const upserts: any[] = [];
    chroma.getAll = async () => [{ id: "id-a", title: "A", date: "", filename: "a.md", relativePath: "a.md", excerpt: "E", similarity: 1 }];
    chroma.upsert = async (meta, _emb) => { upserts.push(meta); };

    await runStartupReindex(vault, chroma, embedder, vaultIndex, { batchSize: 10, batchMaxChars: 10000 }, true);

    expect(upserts).toHaveLength(2);
    expect(upserts.map((u) => u.id).sort()).toEqual(["id-a", "id-b"]);
  });

  test("syncs metadata for renamed files", async () => {
    writeMd("new-name.md", "---\nid: \"id-a\"\ntitle: \"old-name\"\n---\nBody");
    let patched: any;
    chroma.getAll = async () => [{ id: "id-a", title: "old-name", date: "", filename: "old-name.md", relativePath: "old-name.md", excerpt: "E", similarity: 1 }];
    chroma.patchMetadata = async (id, meta) => { patched = { id, meta }; };

    await runStartupReindex(vault, chroma, embedder, vaultIndex, { batchSize: 10, batchMaxChars: 10000 }, false);

    expect(patched).toBeDefined();
    expect(patched.meta.relativePath).toBe("new-name.md");
    expect(patched.meta.title).toBe("new-name");
  });

  test("does nothing when all files are up to date", async () => {
    writeMd("a.md", "---\nid: \"id-a\"\ntitle: \"A\"\n---\nBody");
    chroma.getAll = async () => [{ id: "id-a", title: "A", date: "", filename: "a.md", relativePath: "a.md", excerpt: "E", similarity: 1 }];
    let upsertCalled = false;
    chroma.upsert = async () => { upsertCalled = true; };

    await runStartupReindex(vault, chroma, embedder, vaultIndex, { batchSize: 10, batchMaxChars: 10000 }, false);
    expect(upsertCalled).toBe(false);
  });
});

describe("populateBodyHashRegistry", () => {
  let dir: string;
  let vault: Vault;
  let registry: BodyHashRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-hash-"));
    vault = new Vault(dir);
    registry = new BodyHashRegistry(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("populates hashes from existing vault entries", () => {
    const content = "---\nid: \"id-1\"\n---\nHello world";
    mkdirSync(join(dir, "2026-04-29"), { recursive: true });
    writeFileSync(join(dir, "2026-04-29", "test.md"), content, "utf-8");

    populateBodyHashRegistry(vault, registry);

    expect(registry.check(BodyHashRegistry.hashBody("Hello world"), "other.md").isDuplicate).toBe(true);
  });

  test("ignores entries without id", () => {
    const content = "---\ntitle: \"No ID\"\n---\nHello";
    mkdirSync(join(dir, "2026-04-29"), { recursive: true });
    writeFileSync(join(dir, "2026-04-29", "test.md"), content, "utf-8");

    populateBodyHashRegistry(vault, registry);
    expect(registry.size()).toBe(0);
  });
});
