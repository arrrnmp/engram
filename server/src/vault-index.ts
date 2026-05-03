import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "fs";
import { join, relative } from "path";
import matter from "gray-matter";
import type { EngramChroma } from "./chroma.js";
import { logger } from "./logger.js";

export interface Location {
  relativePath: string;
}

export class VaultIndex {
  private map = new Map<string, Location>();
  private reverseMap = new Map<string, string>(); // relativePath → uuid

  build(vaultRoot: string): void {
    this.map.clear();
    this.reverseMap.clear();
    if (!existsSync(vaultRoot)) return;

    this.scanDir(vaultRoot, vaultRoot);
  }

  private scanDir(dir: string, vaultRoot: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "_chunks") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.scanDir(fullPath, vaultRoot);
      } else if (entry.name.endsWith(".md")) {
        const relativePath = relative(vaultRoot, fullPath);
        try {
          const raw = readFileSync(fullPath, "utf-8");
          const parsed = matter(raw);
          const id = typeof parsed.data.id === "string" ? parsed.data.id : undefined;
          if (id) {
            if (this.map.has(id)) {
              // UUID collision — reassign to the second file
              const newId = crypto.randomUUID();
              parsed.data.id = newId;
              const rewritten = matter.stringify(parsed.content, parsed.data);
              writeFileSync(fullPath, rewritten, "utf-8");
              this.map.set(newId, { relativePath });
              this.reverseMap.set(relativePath, newId);
              logger.warn(`[vault-index] UUID collision: reassigned ${relativePath} → ${newId}`);
            } else {
              this.map.set(id, { relativePath });
              this.reverseMap.set(relativePath, id);
            }
          }
        } catch {}
      }
    }
  }

  resolve(id: string): Location | undefined {
    return this.map.get(id);
  }

  resolveByPath(relativePath: string): string | undefined {
    return this.reverseMap.get(relativePath);
  }

  async resolveWithFallback(
    id: string,
    vaultRoot: string,
    chroma: EngramChroma
  ): Promise<Location | null> {
    const cached = this.map.get(id);
    if (cached) return cached;

    // Cache miss — Obsidian may have renamed the file while the server was running.
    this.build(vaultRoot);
    const rescanned = this.map.get(id);
    if (rescanned) return rescanned;

    // Still not found — file was deleted. Clean up the stale ChromaDB entry.
    await chroma.delete(id);
    return null;
  }

  set(id: string, location: Location): void {
    this.map.set(id, location);
    this.reverseMap.set(location.relativePath, id);
  }

  remove(id: string): void {
    const loc = this.map.get(id);
    if (loc) {
      this.reverseMap.delete(loc.relativePath);
    }
    this.map.delete(id);
  }

  entries(): IterableIterator<[string, Location]> {
    return this.map.entries();
  }

  size(): number {
    return this.map.size;
  }
}
