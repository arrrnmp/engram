import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { logger } from "./logger.js";

interface MediaCacheEntry {
  hash: string;
  size: number;
  mtime: string;
  chromaIds: string[];
}

export class MediaCache {
  private data: Map<string, MediaCacheEntry>;
  private cachePath: string;

  constructor(vaultRoot: string) {
    this.cachePath = join(vaultRoot, ".engram-media-cache.json");
    this.cleanupTempFiles(vaultRoot);
    this.data = this.load();
  }

  private cleanupTempFiles(vaultRoot: string): void {
    const tmpPath = `${this.cachePath}.tmp`;
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
        logger.info(`[media-cache] Cleaned orphaned temp file: ${tmpPath}`);
      } catch (e) {
        logger.warn(`[media-cache] Failed to clean temp file ${tmpPath}: ${e}`);
      }
    }
  }

  get(relativePath: string): MediaCacheEntry | undefined {
    return this.data.get(relativePath);
  }

  set(relativePath: string, entry: MediaCacheEntry): void {
    this.data.set(relativePath, entry);
  }

  delete(relativePath: string): void {
    this.data.delete(relativePath);
  }

  save(): void {
    const tmp = `${this.cachePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data), null, 2), "utf-8");
    renameSync(tmp, this.cachePath);
  }

  private load(): Map<string, MediaCacheEntry> {
    if (!existsSync(this.cachePath)) return new Map();
    try {
      return new Map(Object.entries(JSON.parse(readFileSync(this.cachePath, "utf-8"))));
    } catch {
      return new Map();
    }
  }
}
