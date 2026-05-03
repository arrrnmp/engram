import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { deleteEngram } from "../tools/delete-engram.js";
import { mockChroma, mockVault, mockVaultIndex } from "./helpers/mocks.js";

describe("deleteEngram", () => {
  let tempDir: string;
  let vault: ReturnType<typeof mockVault>;
  let chroma: ReturnType<typeof mockChroma>;
  let vaultIndex: ReturnType<typeof mockVaultIndex>;
  let removedId = "";
  let deletedChromaId = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "engram-delete-test-"));
    removedId = "";
    deletedChromaId = "";

    vault = mockVault();
    (vault as any).root = tempDir;

    chroma = mockChroma();
    (chroma as any).delete = async (id: string) => {
      deletedChromaId = id;
    };

    const resolutions = new Map<string, { relativePath: string }>();
    vaultIndex = mockVaultIndex({ resolutions });
    (vaultIndex as any).remove = (id: string) => {
      removedId = id;
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("resolves engram via vaultIndex.resolveWithFallback", async () => {
    const testId = "aaaaaaaa-1111-2222-3333-444444444444";
    const relativePath = "2026-04-29/test.md";
    (vaultIndex as any).resolveWithFallback = async () => ({ relativePath });

    mkdirSync(join(tempDir, "2026-04-29"), { recursive: true });
    writeFileSync(join(tempDir, relativePath), "test", "utf-8");

    const result = await deleteEngram({ id: testId }, vault, vaultIndex, chroma);
    expect(result.id).toBe(testId);
    expect(result.relativePath).toBe(relativePath);
  });

  test("unlinks vault file", async () => {
    const testId = "aaaaaaaa-1111-2222-3333-444444444444";
    const relativePath = "2026-04-29/test.md";
    (vaultIndex as any).resolveWithFallback = async () => ({ relativePath });

    mkdirSync(join(tempDir, "2026-04-29"), { recursive: true });
    writeFileSync(join(tempDir, relativePath), "test content", "utf-8");

    await deleteEngram({ id: testId }, vault, vaultIndex, chroma);
    expect(() => {
      const { readFileSync } = require("fs");
      readFileSync(join(tempDir, relativePath), "utf-8");
    }).toThrow();
  });

  test("deletes from ChromaDB", async () => {
    const testId = "aaaaaaaa-1111-2222-3333-444444444444";
    const relativePath = "2026-04-29/test.md";
    (vaultIndex as any).resolveWithFallback = async () => ({ relativePath });

    mkdirSync(join(tempDir, "2026-04-29"), { recursive: true });
    writeFileSync(join(tempDir, relativePath), "test", "utf-8");

    await deleteEngram({ id: testId }, vault, vaultIndex, chroma);
    expect(deletedChromaId).toBe(testId);
  });

  test("removes from vaultIndex", async () => {
    const testId = "aaaaaaaa-1111-2222-3333-444444444444";
    const relativePath = "2026-04-29/test.md";
    (vaultIndex as any).resolveWithFallback = async () => ({ relativePath });

    mkdirSync(join(tempDir, "2026-04-29"), { recursive: true });
    writeFileSync(join(tempDir, relativePath), "test", "utf-8");

    await deleteEngram({ id: testId }, vault, vaultIndex, chroma);
    expect(removedId).toBe(testId);
  });

  test("handles missing engram gracefully", async () => {
    (vaultIndex as any).resolveWithFallback = async () => null;

    await expect(
      deleteEngram({ id: "aaaaaaaa-1111-2222-3333-444444444444" }, vault, vaultIndex, chroma)
    ).rejects.toThrow("Engram not found");
  });

  test("throws when file is missing but ChromaDB entry exists", async () => {
    const testId = "aaaaaaaa-1111-2222-3333-444444444444";
    const relativePath = "2026-04-29/missing.md";
    (vaultIndex as any).resolveWithFallback = async () => ({ relativePath });

    // Do NOT create the file
    await expect(deleteEngram({ id: testId }, vault, vaultIndex, chroma)).rejects.toThrow();
    // ChromaDB delete should NOT have been called because unlinkSync threw first
    expect(deletedChromaId).toBe("");
    expect(removedId).toBe("");
  });

  test("returns correct message on success", async () => {
    const testId = "aaaaaaaa-1111-2222-3333-444444444444";
    const relativePath = "2026-04-29/test.md";
    (vaultIndex as any).resolveWithFallback = async () => ({ relativePath });

    mkdirSync(join(tempDir, "2026-04-29"), { recursive: true });
    writeFileSync(join(tempDir, relativePath), "test", "utf-8");

    const result = await deleteEngram({ id: testId }, vault, vaultIndex, chroma);
    expect(result.message).toContain(relativePath);
    expect(result.message).toContain(testId);
  });
});
