import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import matter from "gray-matter";
import { handleMdUpsert, handleMdDelete } from "../watcher.js";
import { VaultIndex } from "../vault-index.js";
import { BodyHashRegistry } from "../body-hash.js";
import { mockChroma, mockEmbedder } from "./helpers/mocks.js";

describe("handleMdDelete", () => {
  let dir: string;
  let vaultIndex: VaultIndex;
  let chroma: ReturnType<typeof mockChroma>;
  let bodyHashRegistry: BodyHashRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-watcher-"));
    vaultIndex = new VaultIndex();
    chroma = mockChroma();
    bodyHashRegistry = new BodyHashRegistry(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("removes from vaultIndex, chroma, and bodyHashRegistry", () => {
    vaultIndex.set("id-1", { relativePath: "2026-04-29/test.md" });
    bodyHashRegistry.add("hash1", "2026-04-29/test.md");

    let deletedId: string | undefined;
    chroma.delete = async (id: string) => { deletedId = id; };

    handleMdDelete("2026-04-29/test.md", vaultIndex, chroma, bodyHashRegistry);

    expect(deletedId).toBe("id-1");
    expect(vaultIndex.resolve("id-1")).toBeUndefined();
    expect(bodyHashRegistry.check("hash1", "x.md").isDuplicate).toBe(false);
  });

  test("no-op when file not in vaultIndex", () => {
    let deleteCalled = false;
    chroma.delete = async () => { deleteCalled = true; };

    handleMdDelete("missing.md", vaultIndex, chroma, bodyHashRegistry);
    expect(deleteCalled).toBe(false);
  });
});

describe("handleMdUpsert", () => {
  let dir: string;
  let vaultIndex: VaultIndex;
  let chroma: ReturnType<typeof mockChroma>;
  let bodyHashRegistry: BodyHashRegistry;
  let embedder: ReturnType<typeof mockEmbedder>;
  let upsertCalls: Array<{ id: string; content: string; title: string; relativePath: string }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-watcher-"));
    vaultIndex = new VaultIndex();
    chroma = mockChroma();
    bodyHashRegistry = new BodyHashRegistry(dir);
    embedder = mockEmbedder();
    upsertCalls = [];
    chroma.upsert = async (meta, _embedding) => {
      upsertCalls.push({ id: meta.id, content: meta.content, title: meta.title, relativePath: meta.relativePath });
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMd(relativePath: string, content: string) {
    const fullPath = join(dir, relativePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
    return fullPath;
  }

  test("assigns UUID to new file without id and upserts", async () => {
    const filePath = writeMd("test.md", "---\ntitle: \"Test\"\n---\nHello world");
    await handleMdUpsert("test.md", filePath, dir, chroma, embedder, vaultIndex, bodyHashRegistry);

    const rewritten = readFileSync(filePath, "utf-8");
    const parsed = matter(rewritten);
    expect(parsed.data.id).toBeDefined();
    expect(parsed.data.id).toHaveLength(36); // UUID length

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].id).toBe(parsed.data.id);
    expect(upsertCalls[0].content).toBe("Hello world");
    expect(vaultIndex.resolve(parsed.data.id)?.relativePath).toBe("test.md");
  });

  test("skips duplicate body at different path", async () => {
    const content = "---\nid: \"original-id\"\ntitle: \"Original\"\n---\nSame body";
    const originalPath = writeMd("original.md", content);
    const dupPath = writeMd("duplicate.md", content.replace("original-id", "dup-id"));

    // First, index the original
    await handleMdUpsert("original.md", originalPath, dir, chroma, embedder, vaultIndex, bodyHashRegistry);

    // Now try the duplicate
    upsertCalls.length = 0;
    await handleMdUpsert("duplicate.md", dupPath, dir, chroma, embedder, vaultIndex, bodyHashRegistry);

    expect(upsertCalls).toHaveLength(0);
  });

  test("handles moved file when canonical path no longer exists", async () => {
    const content = "---\nid: \"shared-id\"\ntitle: \"Test\"\n---\nBody text";
    const oldPath = writeMd("old.md", content);
    await handleMdUpsert("old.md", oldPath, dir, chroma, embedder, vaultIndex, bodyHashRegistry);

    // Move file
    rmSync(oldPath);
    const newPath = writeMd("new.md", content);
    upsertCalls.length = 0;

    await handleMdUpsert("new.md", newPath, dir, chroma, embedder, vaultIndex, bodyHashRegistry);

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].id).toBe("shared-id");
    expect(vaultIndex.resolve("shared-id")?.relativePath).toBe("new.md");
  });

  test("reassigns UUID on collision when old file still exists", async () => {
    const contentA = "---\nid: \"collision-id\"\ntitle: \"A\"\n---\nBody A";
    const contentB = "---\nid: \"collision-id\"\ntitle: \"B\"\n---\nBody B";
    const pathA = writeMd("a.md", contentA);
    const pathB = writeMd("b.md", contentB);

    await handleMdUpsert("a.md", pathA, dir, chroma, embedder, vaultIndex, bodyHashRegistry);
    upsertCalls.length = 0;

    await handleMdUpsert("b.md", pathB, dir, chroma, embedder, vaultIndex, bodyHashRegistry);

    // b.md should have been rewritten with a new UUID
    const rewrittenB = matter(readFileSync(pathB, "utf-8"));
    expect(rewrittenB.data.id).not.toBe("collision-id");
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].id).toBe(rewrittenB.data.id);
  });

  test("syncs title on rename when title matched old stem", async () => {
    const content = "---\nid: \"rename-id\"\ntitle: \"old-name\"\n---\nBody";
    const oldPath = writeMd("old-name.md", content);
    await handleMdUpsert("old-name.md", oldPath, dir, chroma, embedder, vaultIndex, bodyHashRegistry);

    rmSync(oldPath);
    const newPath = writeMd("new-name.md", content);
    upsertCalls.length = 0;

    await handleMdUpsert("new-name.md", newPath, dir, chroma, embedder, vaultIndex, bodyHashRegistry);

    const rewritten = matter(readFileSync(newPath, "utf-8"));
    expect(rewritten.data.title).toBe("new-name");
    expect(upsertCalls[0].title).toBe("new-name");
  });

  test("skips self-trigger when hash already registered at same path", async () => {
    const content = "---\nid: \"self-id\"\ntitle: \"Self\"\n---\nBody";
    const path = writeMd("self.md", content);
    await handleMdUpsert("self.md", path, dir, chroma, embedder, vaultIndex, bodyHashRegistry);

    // Second call with same content and path should skip
    upsertCalls.length = 0;
    await handleMdUpsert("self.md", path, dir, chroma, embedder, vaultIndex, bodyHashRegistry);

    expect(upsertCalls).toHaveLength(0);
  });
});
