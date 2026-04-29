import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";
import { parseEngram } from "./vault.js";
import type { EngramChroma } from "./chroma.js";

interface Location {
  date: string;
  filename: string;
}

export class VaultIndex {
  private map = new Map<string, Location>();

  build(vaultRoot: string): void {
    this.map.clear();
    if (!existsSync(vaultRoot)) return;

    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    for (const entry of readdirSync(vaultRoot)) {
      if (!DATE_RE.test(entry)) continue;
      const dirPath = join(vaultRoot, entry);
      if (!statSync(dirPath).isDirectory()) continue;
      for (const filename of readdirSync(dirPath).filter((f) => f.endsWith(".md"))) {
        try {
          const raw = readFileSync(join(dirPath, filename), "utf-8");
          const { id } = parseEngram(raw);
          if (id) this.map.set(id, { date: entry, filename });
        } catch {}
      }
    }
  }

  resolve(id: string): Location | undefined {
    return this.map.get(id);
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

  remove(id: string): void {
    this.map.delete(id);
  }

  entries(): IterableIterator<[string, Location]> {
    return this.map.entries();
  }

  size(): number {
    return this.map.size;
  }
}
