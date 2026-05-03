import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MediaCache } from "../media-cache.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "engram-test-cache-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("MediaCache — load", () => {
  test("empty map when cache file does not exist", () => {
    const cache = new MediaCache(dir);
    expect(cache.get("anything")).toBeUndefined();
  });

  test("loads existing entries from disk", () => {
    const entry = { hash: "aabbcc", size: 1024, mtime: "1000000", chromaIds: ["aabbcc"] };
    writeFileSync(join(dir, ".engram-media-cache.json"), JSON.stringify({ "doc.pdf": entry }));
    const cache = new MediaCache(dir);
    expect(cache.get("doc.pdf")).toEqual(entry);
  });

  test("corrupt JSON falls back to empty map", () => {
    writeFileSync(join(dir, ".engram-media-cache.json"), "{ broken json");
    const cache = new MediaCache(dir);
    expect(cache.get("anything")).toBeUndefined();
  });
});

describe("MediaCache — get / set / delete", () => {
  test("set and get round-trip", () => {
    const cache = new MediaCache(dir);
    cache.set("img.png", { hash: "ff00", size: 512, mtime: "9999", chromaIds: ["ff00"] });
    expect(cache.get("img.png")).toEqual({ hash: "ff00", size: 512, mtime: "9999", chromaIds: ["ff00"] });
  });

  test("get returns undefined for unknown key", () => {
    const cache = new MediaCache(dir);
    expect(cache.get("missing.jpg")).toBeUndefined();
  });

  test("delete removes the entry", () => {
    const cache = new MediaCache(dir);
    cache.set("a.png", { hash: "aa", size: 1, mtime: "1", chromaIds: ["aa"] });
    cache.delete("a.png");
    expect(cache.get("a.png")).toBeUndefined();
  });

  test("delete on missing key is a no-op", () => {
    const cache = new MediaCache(dir);
    expect(() => cache.delete("nope.pdf")).not.toThrow();
  });
});

describe("MediaCache — save / load round-trip", () => {
  test("persists multiple entries across instances", () => {
    const a = { hash: "aa", size: 100, mtime: "111", chromaIds: ["aa-page-0", "aa-page-1"] };
    const b = { hash: "bb", size: 200, mtime: "222", chromaIds: ["bb"] };

    const c1 = new MediaCache(dir);
    c1.set("report.pdf", a);
    c1.set("photo.jpg", b);
    c1.save();

    const c2 = new MediaCache(dir);
    expect(c2.get("report.pdf")).toEqual(a);
    expect(c2.get("photo.jpg")).toEqual(b);
  });

  test("atomic write: .tmp file is removed after save", () => {
    const cache = new MediaCache(dir);
    cache.set("x.png", { hash: "xx", size: 1, mtime: "1", chromaIds: ["xx"] });
    cache.save();
    expect(existsSync(join(dir, ".engram-media-cache.json.tmp"))).toBe(false);
    expect(existsSync(join(dir, ".engram-media-cache.json"))).toBe(true);
  });

  test("save overwrites stale entries", () => {
    const c1 = new MediaCache(dir);
    c1.set("file.txt", { hash: "old", size: 10, mtime: "1", chromaIds: ["old"] });
    c1.save();

    const c2 = new MediaCache(dir);
    c2.set("file.txt", { hash: "new", size: 20, mtime: "2", chromaIds: ["new"] });
    c2.save();

    const c3 = new MediaCache(dir);
    expect(c3.get("file.txt")?.hash).toBe("new");
  });

  test("delete + save removes entry from disk", () => {
    const c1 = new MediaCache(dir);
    c1.set("gone.pdf", { hash: "zz", size: 1, mtime: "1", chromaIds: ["zz"] });
    c1.save();

    const c2 = new MediaCache(dir);
    c2.delete("gone.pdf");
    c2.save();

    const c3 = new MediaCache(dir);
    expect(c3.get("gone.pdf")).toBeUndefined();
  });
});
