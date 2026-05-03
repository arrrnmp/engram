import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Vault } from "../vault.js";

describe("Vault class", () => {
  let tempDir: string;
  let vault: Vault;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "engram-vault-class-"));
    vault = new Vault(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("constructor creates directory if needed", () => {
    const newDir = join(tempDir, "nested", "vault");
    expect(() => new Vault(newDir)).not.toThrow();
    const { existsSync } = require("fs");
    expect(existsSync(newDir)).toBe(true);
  });

  test("writeEngram creates directories and writes markdown", () => {
    const path = vault.writeEngram("projects/engram", "My Idea", "# Body\n\nText.");
    expect(path).toContain("projects/engram/My Idea.md");
    const { readFileSync } = require("fs");
    const content = readFileSync(path, "utf-8");
    expect(content).toBe("# Body\n\nText.");
  });

  test("readEngram reads existing engram", () => {
    vault.writeEngram("2026-04-29", "Test", "body content");
    const content = vault.readEngram("2026-04-29/Test.md");
    expect(content).toBe("body content");
  });

  test("readEngram throws for missing file", () => {
    expect(() => vault.readEngram("nonexistent.md")).toThrow();
  });

  test("updateEngram overwrites file content", () => {
    vault.writeEngram("2026-04-29", "Test", "original");
    vault.updateEngram("2026-04-29/Test.md", "updated");
    expect(vault.readEngram("2026-04-29/Test.md")).toBe("updated");
  });

  test("listEngrams lists files recursively", () => {
    mkdirSync(join(tempDir, "2026-04-28"), { recursive: true });
    mkdirSync(join(tempDir, "2026-04-29"), { recursive: true });
    writeFileSync(join(tempDir, "2026-04-28", "a.md"), "---\nid: a\n---\nA", "utf-8");
    writeFileSync(join(tempDir, "2026-04-29", "b.md"), "---\nid: b\n---\nB", "utf-8");

    const entries = vault.listEngrams();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.filename)).toContain("a.md");
    expect(entries.map((e) => e.filename)).toContain("b.md");
  });

  test("listEngrams skips hidden dirs", () => {
    mkdirSync(join(tempDir, ".hidden"), { recursive: true });
    mkdirSync(join(tempDir, "visible"), { recursive: true });
    writeFileSync(join(tempDir, ".hidden", "secret.md"), "secret", "utf-8");
    writeFileSync(join(tempDir, "visible", "open.md"), "open", "utf-8");

    const entries = vault.listEngrams();
    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe("open.md");
  });

  test("listEngrams parses frontmatter for titles and abstracts", () => {
    const content = `---
id: "test-id"
abstract: "Test abstract"
title: "Real Title"
date: "2026-04-29"
type: "idea"
---

Body.`;
    mkdirSync(join(tempDir, "2026-04-29"), { recursive: true });
    writeFileSync(join(tempDir, "2026-04-29", "test.md"), content, "utf-8");

    const entries = vault.listEngrams();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("test-id");
    expect(entries[0].abstract).toBe("Test abstract");
    expect(entries[0].title).toBe("Real Title");
    expect(entries[0].type).toBe("idea");
  });

  test("listEngrams applies date_range filtering", () => {
    mkdirSync(join(tempDir, "2026-01-15"), { recursive: true });
    mkdirSync(join(tempDir, "2026-03-20"), { recursive: true });
    mkdirSync(join(tempDir, "2026-05-01"), { recursive: true });
    writeFileSync(join(tempDir, "2026-01-15", "a.md"), "a", "utf-8");
    writeFileSync(join(tempDir, "2026-03-20", "b.md"), "b", "utf-8");
    writeFileSync(join(tempDir, "2026-05-01", "c.md"), "c", "utf-8");

    const entries = vault.listEngrams({ from: "2026-02-01", to: "2026-04-30" });
    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe("b.md");
  });

  test("listEngrams sorts by date descending", () => {
    mkdirSync(join(tempDir, "2026-01-01"), { recursive: true });
    mkdirSync(join(tempDir, "2026-03-01"), { recursive: true });
    writeFileSync(join(tempDir, "2026-01-01", "a.md"), "a", "utf-8");
    writeFileSync(join(tempDir, "2026-03-01", "b.md"), "b", "utf-8");

    const entries = vault.listEngrams();
    expect(entries[0].date).toBe("2026-03-01");
    expect(entries[1].date).toBe("2026-01-01");
  });

  test("scanEngrams returns UUID to path map", () => {
    mkdirSync(join(tempDir, "2026-04-29"), { recursive: true });
    writeFileSync(
      join(tempDir, "2026-04-29", "a.md"),
      '---\nid: "uuid-a"\n---\nA',
      "utf-8"
    );
    writeFileSync(
      join(tempDir, "2026-04-29", "b.md"),
      '---\nid: "uuid-b"\n---\nB',
      "utf-8"
    );

    // scanEngrams is private, but listEngrams uses it internally
    const entries = vault.listEngrams();
    const idMap = new Map(entries.map((e) => [e.id, e.relativePath]));
    expect(idMap.get("uuid-a")).toBe("2026-04-29/a.md");
    expect(idMap.get("uuid-b")).toBe("2026-04-29/b.md");
  });

  test("scanEngrams handles files without UUID", () => {
    mkdirSync(join(tempDir, "2026-04-29"), { recursive: true });
    writeFileSync(join(tempDir, "2026-04-29", "no-id.md"), "Just body.", "utf-8");

    const entries = vault.listEngrams();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBeUndefined();
    expect(entries[0].title).toBe("no-id");
  });

  test("listEngrams derives date from path when no frontmatter date", () => {
    mkdirSync(join(tempDir, "2026-04-29"), { recursive: true });
    writeFileSync(join(tempDir, "2026-04-29", "note.md"), "No frontmatter.", "utf-8");

    const entries = vault.listEngrams();
    expect(entries[0].date).toBe("2026-04-29");
  });

  test("listEngrams uses frontmatter date over path date", () => {
    mkdirSync(join(tempDir, "2026-04-29"), { recursive: true });
    writeFileSync(
      join(tempDir, "2026-04-29", "note.md"),
      '---\ndate: "2025-12-25"\n---\nBody.',
      "utf-8"
    );

    const entries = vault.listEngrams();
    expect(entries[0].date).toBe("2025-12-25");
  });

  test("readImportant returns empty string when file missing", () => {
    expect(vault.readImportant()).toBe("");
  });

  test("readImportant returns content when file exists", () => {
    writeFileSync(join(tempDir, "IMPORTANT.md"), "Important info", "utf-8");
    expect(vault.readImportant()).toBe("Important info");
  });

  test("writeImportant creates/overwrites IMPORTANT.md", () => {
    vault.writeImportant("New important content");
    expect(vault.readImportant()).toBe("New important content");
  });

  test("handles tilde expansion in constructor", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const homeVault = new Vault("~/test-vault");
    expect(homeVault.root).not.toContain("~");
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });
});
