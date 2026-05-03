import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BodyHashRegistry } from "../body-hash.js";

describe("BodyHashRegistry", () => {
  let dir: string;
  let registry: BodyHashRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-body-hash-"));
    registry = new BodyHashRegistry(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── load / save ────────────────────────────────────────────────────────────

  test("load() returns early when file does not exist", () => {
    expect(() => registry.load()).not.toThrow();
    expect(registry.size()).toBe(0);
  });

  test("save() writes JSON to vault root", () => {
    registry.add("hash1", "2026-04-29/test.md");
    registry.save();

    const path = join(dir, ".engram-body-hashes.json");
    expect(existsSync(path)).toBe(true);

    const data = JSON.parse(readFileSync(path, "utf-8"));
    expect(data).toEqual({ hash1: "2026-04-29/test.md" });
  });

  test("load() restores saved state", () => {
    writeFileSync(join(dir, "a.md"), "body a", "utf-8");
    writeFileSync(join(dir, "b.md"), "body b", "utf-8");
    registry.add("hash1", "a.md");
    registry.add("hash2", "b.md");
    registry.save();

    const fresh = new BodyHashRegistry(dir);
    fresh.load();

    expect(fresh.check("hash1", "other.md").isDuplicate).toBe(true);
    expect(fresh.check("hash2", "other.md").isDuplicate).toBe(true);
  });

  // ── hashBody ───────────────────────────────────────────────────────────────

  test("hashBody() returns deterministic SHA256 hex", () => {
    const h1 = BodyHashRegistry.hashBody("hello world");
    const h2 = BodyHashRegistry.hashBody("hello world");
    const h3 = BodyHashRegistry.hashBody("hello world!");

    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toHaveLength(64); // SHA256 hex length
  });

  // ── check ──────────────────────────────────────────────────────────────────

  test("check() detects duplicate at different path", () => {
    registry.add("hash1", "canonical.md");
    const result = registry.check("hash1", "duplicate.md");

    expect(result.isDuplicate).toBe(true);
    expect(result.canonicalPath).toBe("canonical.md");
  });

  test("check() returns non-duplicate for new hash", () => {
    const result = registry.check("new-hash", "file.md");
    expect(result.isDuplicate).toBe(false);
    expect(result.canonicalPath).toBeUndefined();
  });

  test("check() returns non-duplicate for same path", () => {
    registry.add("hash1", "file.md");
    const result = registry.check("hash1", "file.md");
    expect(result.isDuplicate).toBe(false);
  });

  // ── registerIfAbsent ───────────────────────────────────────────────────────

  test("registerIfAbsent returns 'proceed' for new hash", () => {
    expect(registry.registerIfAbsent("hash1", "file.md")).toBe("proceed");
  });

  test("registerIfAbsent returns 'skip' for already-registered same path", () => {
    registry.registerIfAbsent("hash1", "file.md");
    expect(registry.registerIfAbsent("hash1", "file.md")).toBe("skip");
  });

  test("registerIfAbsent atomically updates path for existing hash at different path", () => {
    registry.registerIfAbsent("hash1", "old.md");
    expect(registry.registerIfAbsent("hash1", "new.md")).toBe("proceed");
    expect(registry.check("hash1", "old.md").isDuplicate).toBe(true);
    expect(registry.check("hash1", "old.md").canonicalPath).toBe("new.md");
  });

  // ── removeByPath ───────────────────────────────────────────────────────────

  test("removeByPath removes first hash matching path", () => {
    registry.add("hash1", "file.md");
    registry.add("hash2", "other.md");

    registry.removeByPath("file.md");

    expect(registry.check("hash1", "x.md").isDuplicate).toBe(false);
    expect(registry.check("hash2", "x.md").isDuplicate).toBe(true);
  });

  test("removeByPath is no-op when path not found", () => {
    registry.add("hash1", "file.md");
    registry.removeByPath("nonexistent.md");
    expect(registry.check("hash1", "x.md").isDuplicate).toBe(true);
  });

  // ── cleanupOrphanedHashes ──────────────────────────────────────────────────

  test("cleanupOrphanedHashes removes hashes whose files no longer exist", () => {
    // Create a dummy file so one hash is valid
    writeFileSync(join(dir, "exists.md"), "body");

    registry.add("hash1", "exists.md");
    registry.add("hash2", "deleted.md");
    registry.save();

    registry.cleanupOrphanedHashes();

    expect(registry.check("hash1", "x.md").isDuplicate).toBe(true);
    expect(registry.check("hash2", "x.md").isDuplicate).toBe(false);
  });

  test("load() auto-runs cleanupOrphanedHashes", () => {
    writeFileSync(join(dir, "exists.md"), "body");

    const oldRegistry = new BodyHashRegistry(dir);
    oldRegistry.add("hash1", "exists.md");
    oldRegistry.add("hash2", "deleted.md");
    oldRegistry.save();

    const fresh = new BodyHashRegistry(dir);
    fresh.load();

    expect(fresh.check("hash1", "x.md").isDuplicate).toBe(true);
    expect(fresh.check("hash2", "x.md").isDuplicate).toBe(false);
  });

  // ── add (non-atomic) ───────────────────────────────────────────────────────

  test("add() ignores duplicate hash", () => {
    registry.add("hash1", "first.md");
    registry.add("hash1", "second.md"); // should be ignored

    expect(registry.check("hash1", "x.md").canonicalPath).toBe("first.md");
  });
});

function readFileSync(path: string, encoding: BufferEncoding): string {
  return require("fs").readFileSync(path, encoding);
}
