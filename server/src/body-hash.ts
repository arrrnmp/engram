import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { logger } from "./logger.js";

export class BodyHashRegistry {
  private map = new Map<string, string>(); // hash → relativePath
  private path: string;

  constructor(vaultRoot: string) {
    this.path = join(vaultRoot, ".engram-body-hashes.json");
  }

  load(): void {
    if (!existsSync(this.path)) return;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf-8"));
      for (const [hash, rp] of Object.entries(data)) {
        this.map.set(hash, rp as string);
      }
      this.cleanupOrphanedHashes();
    } catch {}
  }

  save(): void {
    const obj: Record<string, string> = {};
    for (const [hash, rp] of this.map) obj[hash] = rp;
    writeFileSync(this.path, JSON.stringify(obj, null, 2), "utf-8");
  }

  cleanupOrphanedHashes(): void {
    const vaultRoot = join(this.path, "..");
    let cleanedCount = 0;
    for (const [hash, rp] of this.map) {
      const filePath = join(vaultRoot, rp);
      if (!existsSync(filePath)) {
        this.map.delete(hash);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      logger.info(`[body-hash] Cleaned ${cleanedCount} orphaned hash(es)`);
      this.save();
    }
  }

  static hashBody(body: string): string {
    return createHash("sha256").update(body).digest("hex");
  }

  check(hash: string, relativePath: string): { isDuplicate: boolean; canonicalPath?: string } {
    const existing = this.map.get(hash);
    if (existing && existing !== relativePath) {
      return { isDuplicate: true, canonicalPath: existing };
    }
    return { isDuplicate: false };
  }

  isRegisteredAt(hash: string, relativePath: string): boolean {
    return this.map.get(hash) === relativePath;
  }

  /**
   * Atomically checks and registers a hash for the given path.
   * Returns:
   * - 'skip' if already registered at this exact path (caller should skip)
   * - 'proceed' if not registered or registered at different path (caller should proceed)
   *
   * When registered at a different path, the path is updated atomically.
   * This eliminates the race condition between isRegisteredAt() and add().
   */
  registerIfAbsent(hash: string, relativePath: string): "skip" | "proceed" {
    const existing = this.map.get(hash);
    if (existing === relativePath) {
      // Already registered at this exact path - skip
      return "skip";
    }
    // Not registered or at different path - atomically update
    this.map.set(hash, relativePath);
    return "proceed";
  }

  add(hash: string, relativePath: string): void {
    if (!this.map.has(hash)) {
      this.map.set(hash, relativePath);
    }
  }

  removeByPath(relativePath: string): void {
    for (const [hash, rp] of this.map) {
      if (rp === relativePath) {
        this.map.delete(hash);
        return;
      }
    }
  }
}
