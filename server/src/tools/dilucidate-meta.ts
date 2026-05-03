import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { Vault } from "../vault.js";

const META_FILENAME = ".dilucidate-meta.json";
const MAX_HISTORY = 50;

const DilucidateStatsSchema = z.object({
  wikilinksCreated: z.number().int().min(0),
  contradictionsFound: z.number().int().min(0),
  summariesWritten: z.number().int().min(0),
  tagsBackfilled: z.number().int().min(0),
  orphansFlagged: z.number().int().min(0),
});

export const UpdateDilucidateMetaInput = z.object({
  lastRun: z.string().describe("ISO 8601 timestamp of this run"),
  engramCountAtLastRun: z.number().int().min(0).describe("Total engram count at the time of this run"),
  stats: DilucidateStatsSchema.describe("Counts of actions taken during this run"),
  note: z.string().max(500).optional().describe("Optional free-text note about this run"),
});

export type UpdateDilucidateMetaInput = z.infer<typeof UpdateDilucidateMetaInput>;

interface HistoryEntry {
  timestamp: string;
  engramCount: number;
  stats: z.infer<typeof DilucidateStatsSchema>;
  note: string | null;
}

interface DilucidateMeta {
  lastRun: string;
  engramCountAtLastRun: number;
  stats: z.infer<typeof DilucidateStatsSchema>;
  history: HistoryEntry[];
}

function emptyStats(): z.infer<typeof DilucidateStatsSchema> {
  return {
    wikilinksCreated: 0,
    contradictionsFound: 0,
    summariesWritten: 0,
    tagsBackfilled: 0,
    orphansFlagged: 0,
  };
}

function emptyMeta(): DilucidateMeta {
  return {
    lastRun: "",
    engramCountAtLastRun: 0,
    stats: emptyStats(),
    history: [],
  };
}

function readMetaOrNull(vault: Vault): DilucidateMeta | null {
  const path = join(vault.root, META_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DilucidateMeta;
  } catch {
    return null;
  }
}

export function getDilucidateMeta(vault: Vault): { meta: object | null } {
  const path = join(vault.root, META_FILENAME);
  if (!existsSync(path)) return { meta: null };
  try {
    return { meta: JSON.parse(readFileSync(path, "utf-8")) };
  } catch {
    return { meta: null };
  }
}

export function updateDilucidateMeta(
  input: UpdateDilucidateMetaInput,
  vault: Vault
): { message: string } {
  let existing = readMetaOrNull(vault);

  if (!existing) {
    existing = emptyMeta();
  }

  // Validate that existing.history is an array (corrupted file guard)
  if (!Array.isArray(existing.history)) {
    existing.history = [];
  }

  const entry: HistoryEntry = {
    timestamp: input.lastRun,
    engramCount: input.engramCountAtLastRun,
    stats: input.stats,
    note: input.note ?? null,
  };

  existing.history.push(entry);

  // Cap at MAX_HISTORY, dropping oldest
  if (existing.history.length > MAX_HISTORY) {
    existing.history = existing.history.slice(-MAX_HISTORY);
  }

  // Update top-level convenience fields from latest entry
  existing.lastRun = entry.timestamp;
  existing.engramCountAtLastRun = entry.engramCount;
  existing.stats = entry.stats;

  writeFileSync(
    join(vault.root, META_FILENAME),
    JSON.stringify(existing, null, 2),
    "utf-8"
  );

  return { message: "Dilucidate metadata updated." };
}

export { DilucidateStatsSchema, MAX_HISTORY, META_FILENAME };
