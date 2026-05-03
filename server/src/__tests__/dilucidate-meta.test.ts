import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getDilucidateMeta,
  updateDilucidateMeta,
  META_FILENAME,
  MAX_HISTORY,
} from "../tools/dilucidate-meta.js";
import type { Vault } from "../vault.js";

function makeVault(root: string): Vault {
  return { root } as Vault;
}

function metaPath(root: string) {
  return join(root, META_FILENAME);
}

function readMetaFile(root: string) {
  return JSON.parse(readFileSync(metaPath(root), "utf-8"));
}

describe("dilucidate-meta", () => {
  let tempDir: string;
  let vault: Vault;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "engram-test-"));
    vault = makeVault(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── getDilucidateMeta ──────────────────────────────────────────────────────

  test("getDilucidateMeta returns null when file doesn't exist", () => {
    const result = getDilucidateMeta(vault);
    expect(result.meta).toBeNull();
  });

  test("getDilucidateMeta returns parsed JSON when file exists", () => {
    const data = { lastRun: "2026-01-01T00:00:00Z", history: [] };
    writeFileSync(metaPath(tempDir), JSON.stringify(data), "utf-8");

    const result = getDilucidateMeta(vault);
    expect(result.meta).toEqual(data);
  });

  test("getDilucidateMeta returns null for corrupted file", () => {
    writeFileSync(metaPath(tempDir), "NOT JSON{{{", "utf-8");

    const result = getDilucidateMeta(vault);
    expect(result.meta).toBeNull();
  });

  // ── updateDilucidateMeta ───────────────────────────────────────────────────

  test("fresh state — creates new file with first history entry", () => {
    const result = updateDilucidateMeta(
      {
        lastRun: "2026-04-30T15:02:17.000Z",
        engramCountAtLastRun: 30,
        stats: {
          wikilinksCreated: 7,
          contradictionsFound: 0,
          summariesWritten: 1,
          tagsBackfilled: 11,
          orphansFlagged: 2,
        },
      },
      vault
    );

    expect(result.message).toBe("Dilucidate metadata updated.");
    expect(existsSync(metaPath(tempDir))).toBe(true);

    const written = readMetaFile(tempDir);
    expect(written.lastRun).toBe("2026-04-30T15:02:17.000Z");
    expect(written.engramCountAtLastRun).toBe(30);
    expect(written.stats.wikilinksCreated).toBe(7);
    expect(written.stats.tagsBackfilled).toBe(11);
    expect(written.history).toHaveLength(1);
    expect(written.history[0].timestamp).toBe("2026-04-30T15:02:17.000Z");
    expect(written.history[0].engramCount).toBe(30);
    expect(written.history[0].note).toBeNull();
  });

  test("merge into existing history — appends entry", () => {
    // Write existing file with one entry
    const existing = {
      lastRun: "2026-04-20T10:00:00Z",
      engramCountAtLastRun: 18,
      stats: {
        wikilinksCreated: 3,
        contradictionsFound: 1,
        summariesWritten: 0,
        tagsBackfilled: 5,
        orphansFlagged: 0,
      },
      history: [
        {
          timestamp: "2026-04-20T10:00:00Z",
          engramCount: 18,
          stats: {
            wikilinksCreated: 3,
            contradictionsFound: 1,
            summariesWritten: 0,
            tagsBackfilled: 5,
            orphansFlagged: 0,
          },
          note: null,
        },
      ],
    };
    writeFileSync(metaPath(tempDir), JSON.stringify(existing), "utf-8");

    updateDilucidateMeta(
      {
        lastRun: "2026-04-30T15:02:17.000Z",
        engramCountAtLastRun: 30,
        stats: {
          wikilinksCreated: 7,
          contradictionsFound: 0,
          summariesWritten: 1,
          tagsBackfilled: 11,
          orphansFlagged: 2,
        },
      },
      vault
    );

    const written = readMetaFile(tempDir);
    expect(written.lastRun).toBe("2026-04-30T15:02:17.000Z");
    expect(written.engramCountAtLastRun).toBe(30);
    expect(written.history).toHaveLength(2);
    expect(written.history[0].timestamp).toBe("2026-04-20T10:00:00Z");
    expect(written.history[1].timestamp).toBe("2026-04-30T15:02:17.000Z");
  });

  test("history cap at MAX_HISTORY — oldest entry dropped", () => {
    // Pre-fill with MAX_HISTORY entries
    const history = [];
    for (let i = 0; i < MAX_HISTORY; i++) {
      history.push({
        timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        engramCount: i * 10,
        stats: {
          wikilinksCreated: i,
          contradictionsFound: 0,
          summariesWritten: 0,
          tagsBackfilled: 0,
          orphansFlagged: 0,
        },
        note: null,
      });
    }
    const existing = {
      lastRun: history[history.length - 1].timestamp,
      engramCountAtLastRun: history[history.length - 1].engramCount,
      stats: history[history.length - 1].stats,
      history,
    };
    writeFileSync(metaPath(tempDir), JSON.stringify(existing), "utf-8");

    // Add one more entry — should cap at MAX_HISTORY
    updateDilucidateMeta(
      {
        lastRun: "2026-04-30T23:59:59.000Z",
        engramCountAtLastRun: 999,
        stats: {
          wikilinksCreated: 42,
          contradictionsFound: 1,
          summariesWritten: 3,
          tagsBackfilled: 7,
          orphansFlagged: 0,
        },
      },
      vault
    );

    const written = readMetaFile(tempDir);
    expect(written.history).toHaveLength(MAX_HISTORY);
    // The oldest entry (2026-01-01) should have been dropped
    expect(written.history[0].timestamp).toBe("2026-01-02T00:00:00Z");
    // The newest entry should be the one we just added
    expect(written.history[MAX_HISTORY - 1].timestamp).toBe("2026-04-30T23:59:59.000Z");
    expect(written.lastRun).toBe("2026-04-30T23:59:59.000Z");
    expect(written.engramCountAtLastRun).toBe(999);
  });

  test("corrupted file — starts fresh", () => {
    writeFileSync(metaPath(tempDir), "BROKEN JSON {{{", "utf-8");

    updateDilucidateMeta(
      {
        lastRun: "2026-04-30T15:02:17.000Z",
        engramCountAtLastRun: 10,
        stats: {
          wikilinksCreated: 1,
          contradictionsFound: 0,
          summariesWritten: 0,
          tagsBackfilled: 2,
          orphansFlagged: 0,
        },
      },
      vault
    );

    const written = readMetaFile(tempDir);
    expect(written.history).toHaveLength(1);
    expect(written.history[0].timestamp).toBe("2026-04-30T15:02:17.000Z");
    expect(written.lastRun).toBe("2026-04-30T15:02:17.000Z");
  });

  test("optional note is stored in history entry", () => {
    updateDilucidateMeta(
      {
        lastRun: "2026-04-30T15:02:17.000Z",
        engramCountAtLastRun: 5,
        stats: {
          wikilinksCreated: 0,
          contradictionsFound: 0,
          summariesWritten: 0,
          tagsBackfilled: 0,
          orphansFlagged: 0,
        },
        note: "Early exit due to low count",
      },
      vault
    );

    const written = readMetaFile(tempDir);
    expect(written.history[0].note).toBe("Early exit due to low count");
  });

  test("top-level fields mirror the latest entry", () => {
    updateDilucidateMeta(
      {
        lastRun: "2026-04-30T15:02:17.000Z",
        engramCountAtLastRun: 42,
        stats: {
          wikilinksCreated: 5,
          contradictionsFound: 2,
          summariesWritten: 1,
          tagsBackfilled: 8,
          orphansFlagged: 3,
        },
      },
      vault
    );

    const written = readMetaFile(tempDir);
    const latest = written.history[written.history.length - 1];
    expect(written.lastRun).toBe(latest.timestamp);
    expect(written.engramCountAtLastRun).toBe(latest.engramCount);
    expect(written.stats).toEqual(latest.stats);
  });
});
