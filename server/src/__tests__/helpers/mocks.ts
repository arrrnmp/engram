import type { EmbeddingProvider } from "../embeddings/types.js";
import type { Vault, EngramEntry } from "../vault.js";
import type { VaultIndex } from "../vault-index.js";
import type { EngramChroma, SearchResult } from "../chroma.js";

// ── EmbeddingProvider mock ──────────────────────────────────────────────────

export function mockEmbedder(overrides?: Partial<EmbeddingProvider>): EmbeddingProvider {
  return {
    embed: async (_text: string, _options?: { taskInstruction?: string }) => Array(4096).fill(0.01),
    embedBatch: async (texts: string[], _options?: { taskInstruction?: string }) => texts.map(() => Array(4096).fill(0.01)),
    modelInfo: () => ({ provider: "test", model: "test-model" }),
    expectedDimensions: () => 4096,
    capabilities: () => ({ text: true, images: false, video: false, pdf: false, documents: false }),
    ...overrides,
  };
}

/** Like mockEmbedder but with full multimodal capabilities (images, video, pdf). */
export function mockEmbedderWithImages(overrides?: Partial<EmbeddingProvider>): EmbeddingProvider {
  return mockEmbedder({
    capabilities: () => ({ text: true, images: true, video: true, pdf: true, documents: true }),
    ...overrides,
  });
}

// ── EngramChroma mock ───────────────────────────────────────────────────────

export interface MockChromaOptions {
  searchResults?: SearchResult[];
  allIds?: string[];
  allWithEmbeddings?: Array<{ id: string; embedding: number[]; date: string; filename: string; relativePath: string; title: string }>;
}

export function mockChroma(opts: MockChromaOptions = {}): EngramChroma {
  return {
    init: async () => {},
    upsert: async () => {},
    patchMetadata: async () => {},
    search: async () => opts.searchResults ?? [],
    getAll: async () => [],
    delete: async () => {},
    getAllIds: async () => opts.allIds ?? [],
    getAllWithEmbeddings: async () => opts.allWithEmbeddings ?? [],
  } as unknown as EngramChroma;
}

// ── Vault mock ──────────────────────────────────────────────────────────────

export interface MockVaultOptions {
  engrams?: EngramEntry[];
  readContent?: string;
}

export function mockVault(opts: MockVaultOptions = {}): Vault {
  return {
    root: "/tmp/test-vault",
    writeEngram: () => "/tmp/test-vault/2026-04-29/test.md",
    readEngram: () => opts.readContent ?? "---\nid: \"test\"\n---\nbody",
    updateEngram: () => {},
    readImportant: () => "",
    writeImportant: () => {},
    listEngrams: () => opts.engrams ?? [],
  } as unknown as Vault;
}

// ── VaultIndex mock ─────────────────────────────────────────────────────────

export interface MockVaultIndexOptions {
  resolutions?: Map<string, { relativePath: string }>;
}

export function mockVaultIndex(opts: MockVaultIndexOptions = {}): VaultIndex {
  const resolutions = opts.resolutions ?? new Map();
  return {
    build: () => {},
    size: () => resolutions.size,
    resolve: (id: string) => resolutions.get(id) ?? null,
    resolveWithFallback: async (id: string) => resolutions.get(id) ?? null,
    set: () => {},
    remove: () => {},
  } as unknown as VaultIndex;
}
