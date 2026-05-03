import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { VaultIndex } from "../vault-index.js";
import { mockChroma } from "./helpers/mocks.js";

describe("VaultIndex", () => {
  let dir: string;
  let index: VaultIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-vault-index-"));
    index = new VaultIndex();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMd(relativePath: string, content: string) {
    const fullPath = join(dir, relativePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }

  test("build scans directories recursively", () => {
    writeMd("a.md", "---\nid: \"id-a\"\n---\nbody");
    writeMd("sub/b.md", "---\nid: \"id-b\"\n---\nbody");

    index.build(dir);
    expect(index.size()).toBe(2);
    expect(index.resolve("id-a")?.relativePath).toBe("a.md");
    expect(index.resolve("id-b")?.relativePath).toBe("sub/b.md");
  });

  test("build skips hidden dirs and _chunks", () => {
    mkdirSync(join(dir, ".hidden"), { recursive: true });
    mkdirSync(join(dir, "_chunks"), { recursive: true });
    writeMd(".hidden/a.md", "---\nid: \"id-hidden\"\n---\nbody");
    writeMd("_chunks/b.md", "---\nid: \"id-chunk\"\n---\nbody");

    index.build(dir);
    expect(index.size()).toBe(0);
  });

  test("build detects and resolves UUID collisions", () => {
    writeMd("a.md", "---\nid: \"same-id\"\n---\nbody A");
    writeMd("b.md", "---\nid: \"same-id\"\n---\nbody B");

    index.build(dir);
    expect(index.size()).toBe(2);
    // One of them should have been reassigned
    const ids = [...index.entries()].map(([id]) => id);
    expect(ids[0]).not.toBe(ids[1]);
    // One of the files should contain the reassigned ID
    const rawA = readFileSync(join(dir, "a.md"), "utf-8");
    const rawB = readFileSync(join(dir, "b.md"), "utf-8");
    const reassignedId = ids.find((id) => id !== "same-id")!;
    expect(rawA.includes(reassignedId) || rawB.includes(reassignedId)).toBe(true);
  });

  test("resolveWithFallback returns cached location", async () => {
    writeMd("a.md", "---\nid: \"id-a\"\n---\nbody");
    index.build(dir);

    const chroma = mockChroma();
    let deleted = false;
    chroma.delete = async () => { deleted = true; };

    const loc = await index.resolveWithFallback("id-a", dir, chroma);
    expect(loc?.relativePath).toBe("a.md");
    expect(deleted).toBe(false);
  });

  test("resolveWithFallback rebuilds and rescans on cache miss", async () => {
    writeMd("a.md", "---\nid: \"id-a\"\n---\nbody");
    // Don't build yet
    const chroma = mockChroma();
    const loc = await index.resolveWithFallback("id-a", dir, chroma);
    expect(loc?.relativePath).toBe("a.md");
  });

  test("resolveWithFallback deletes stale ChromaDB entry when not found", async () => {
    const chroma = mockChroma();
    let deletedId: string | undefined;
    chroma.delete = async (id: string) => { deletedId = id; };

    const loc = await index.resolveWithFallback("missing-id", dir, chroma);
    expect(loc).toBeNull();
    expect(deletedId).toBe("missing-id");
  });

  test("set and remove update bidirectional maps", () => {
    index.set("id-1", { relativePath: "a.md" });
    expect(index.resolve("id-1")?.relativePath).toBe("a.md");
    expect(index.resolveByPath("a.md")).toBe("id-1");

    index.remove("id-1");
    expect(index.resolve("id-1")).toBeUndefined();
    expect(index.resolveByPath("a.md")).toBeUndefined();
  });

  test("resolveByPath returns undefined for unknown path", () => {
    expect(index.resolveByPath("unknown.md")).toBeUndefined();
  });
});
