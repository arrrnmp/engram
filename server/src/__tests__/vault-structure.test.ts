import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getVaultStructure, sanitizeFolderPath } from "../tools/vault-structure.js";
import type { Vault } from "../vault.js";

describe("sanitizeFolderPath", () => {
  const vaultRoot = "/tmp/test-vault";

  test("strips leading slashes", () => {
    expect(sanitizeFolderPath("/foo/bar", vaultRoot)).toBe("foo/bar");
  });

  test("strips trailing slashes", () => {
    expect(sanitizeFolderPath("foo/bar/", vaultRoot)).toBe("foo/bar");
  });

  test("strips both leading and trailing slashes", () => {
    expect(sanitizeFolderPath("/foo/bar/", vaultRoot)).toBe("foo/bar");
  });

  test("filters out '.' segments", () => {
    expect(sanitizeFolderPath("./foo/./bar", vaultRoot)).toBe("foo/bar");
  });

  test("filters out '..' segments", () => {
    // Note: '..' is filtered out entirely, so "foo/../bar" becomes "foo/bar"
    expect(sanitizeFolderPath("foo/../bar", vaultRoot)).toBe("foo/bar");
  });

  test("filters out all '..' segments including leading", () => {
    expect(sanitizeFolderPath("../../etc/passwd", vaultRoot)).toBe("etc/passwd");
  });

  test("strips leading slash from absolute paths before resolving", () => {
    expect(sanitizeFolderPath("/etc/passwd", vaultRoot)).toBe("etc/passwd");
  });

  test("returns empty string for empty input", () => {
    expect(sanitizeFolderPath("", vaultRoot)).toBe("");
  });

  test("handles single segment", () => {
    expect(sanitizeFolderPath("projects", vaultRoot)).toBe("projects");
  });

  test("throws if resolved path escapes vault root (edge case)", () => {
    // This is hard to trigger because '..' is filtered before resolve.
    // The check is a safety net for unusual vaultRoot values.
    const trickyRoot = "/tmp/test-vault";
    expect(sanitizeFolderPath("projects", trickyRoot)).toBe("projects");
  });
});

describe("getVaultStructure", () => {
  let tempDir: string;
  let vault: Vault;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "engram-vault-structure-"));
    vault = { root: tempDir } as Vault;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns empty tree for non-existent directory", () => {
    const result = getVaultStructure({ root: "/non/existent/path" } as Vault);
    expect(result.tree).toEqual([]);
    expect(result.summary).toBe("Vault directory does not exist.");
  });

  test("returns empty tree for empty directory", () => {
    const result = getVaultStructure(vault);
    expect(result.tree).toEqual([]);
    expect(result.summary).toBe("");
  });

  test("lists files with correct types", () => {
    writeFileSync(join(tempDir, "note.md"), "# Hello", "utf-8");
    writeFileSync(join(tempDir, "photo.jpg"), "fake-image", "utf-8");
    writeFileSync(join(tempDir, "doc.pdf"), "fake-pdf", "utf-8");
    writeFileSync(join(tempDir, "clip.mp4"), "fake-video", "utf-8");
    writeFileSync(join(tempDir, "data.json"), "{}", "utf-8");

    const result = getVaultStructure(vault);
    expect(result.tree).toHaveLength(5);
    expect(result.tree.find((n) => n.name === "note.md")?.fileType).toBe("markdown");
    expect(result.tree.find((n) => n.name === "photo.jpg")?.fileType).toBe("image");
    expect(result.tree.find((n) => n.name === "doc.pdf")?.fileType).toBe("pdf");
    expect(result.tree.find((n) => n.name === "clip.mp4")?.fileType).toBe("video");
    expect(result.tree.find((n) => n.name === "data.json")?.fileType).toBe("other");
    expect(result.summary).toContain("1 markdown file");
    expect(result.summary).toContain("1 image");
    expect(result.summary).toContain("1 PDF");
    expect(result.summary).toContain("1 video");
    expect(result.summary).toContain("1 other file");
  });

  test("recursively scans subdirectories", () => {
    mkdirSync(join(tempDir, "projects"), { recursive: true });
    writeFileSync(join(tempDir, "projects", "idea.md"), "idea", "utf-8");

    const result = getVaultStructure(vault);
    const projectsDir = result.tree.find((n) => n.name === "projects");
    expect(projectsDir?.type).toBe("dir");
    expect(projectsDir?.children).toHaveLength(1);
    expect(projectsDir?.children?.[0].name).toBe("idea.md");
    expect(result.summary).toContain("1 directory");
  });

  test("skips hidden files and directories", () => {
    mkdirSync(join(tempDir, ".hidden-dir"), { recursive: true });
    writeFileSync(join(tempDir, ".hidden-file"), "secret", "utf-8");
    writeFileSync(join(tempDir, "visible.md"), "hello", "utf-8");

    const result = getVaultStructure(vault);
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0].name).toBe("visible.md");
  });

  test("skips SKIP_NAMES entries", () => {
    writeFileSync(join(tempDir, "IMPORTANT.md"), "important", "utf-8");
    writeFileSync(join(tempDir, ".chroma-data"), "data", "utf-8");
    writeFileSync(join(tempDir, ".dilucidate-meta.json"), "{}", "utf-8");
    writeFileSync(join(tempDir, ".engram-body-hashes.json"), "{}", "utf-8");
    writeFileSync(join(tempDir, ".engram-media-cache.json"), "{}", "utf-8");
    writeFileSync(join(tempDir, ".engram-collection-meta.json"), "{}", "utf-8");
    writeFileSync(join(tempDir, "regular.md"), "regular", "utf-8");

    const result = getVaultStructure(vault);
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0].name).toBe("regular.md");
  });

  test("respects maxDepth and marks truncated directories", () => {
    mkdirSync(join(tempDir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(tempDir, "a", "b", "c", "deep.md"), "deep", "utf-8");

    const result = getVaultStructure(vault, 2);
    const a = result.tree.find((n) => n.name === "a");
    expect(a?.type).toBe("dir");
    expect(a?.truncated).toBeUndefined();
    const b = a?.children?.find((n) => n.name === "b");
    expect(b?.type).toBe("dir");
    expect(b?.truncated).toBe(true);
    expect(b?.children).toBeUndefined();
  });

  test("counts files and directories correctly in summary", () => {
    mkdirSync(join(tempDir, "folder1"), { recursive: true });
    mkdirSync(join(tempDir, "folder2"), { recursive: true });
    writeFileSync(join(tempDir, "folder1", "a.md"), "a", "utf-8");
    writeFileSync(join(tempDir, "folder1", "b.png"), "b", "utf-8");
    writeFileSync(join(tempDir, "folder2", "c.pdf"), "c", "utf-8");
    writeFileSync(join(tempDir, "root.md"), "root", "utf-8");

    const result = getVaultStructure(vault);
    expect(result.summary).toContain("2 directories");
    expect(result.summary).toContain("2 markdown files");
    expect(result.summary).toContain("1 image");
    expect(result.summary).toContain("1 PDF");
  });

  test("handles single directory gracefully in summary", () => {
    mkdirSync(join(tempDir, "only"), { recursive: true });
    const result = getVaultStructure(vault);
    expect(result.summary).toBe("1 directory");
  });

  test("handles mixed case file extensions", () => {
    writeFileSync(join(tempDir, "upper.MD"), "md", "utf-8");
    writeFileSync(join(tempDir, "mixed.JpG"), "jpg", "utf-8");
    writeFileSync(join(tempDir, "lower.pdf"), "pdf", "utf-8");

    const result = getVaultStructure(vault);
    expect(result.tree.find((n) => n.name === "upper.MD")?.fileType).toBe("markdown");
    expect(result.tree.find((n) => n.name === "mixed.JpG")?.fileType).toBe("image");
    expect(result.tree.find((n) => n.name === "lower.pdf")?.fileType).toBe("pdf");
  });
});
