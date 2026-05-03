import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join, dirname, basename } from "path";
import matter from "gray-matter";
import type { EngramChroma } from "../chroma.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { Vault } from "../vault.js";
import type { VaultIndex } from "../vault-index.js";
import { parseEngram } from "../vault.js";

export const ChunkEngramInput = z.object({
  id: z.string().uuid().describe("UUID of the parent engram to chunk"),
  mode: z.enum(["create", "re-embed"])
    .default("create")
    .describe(
      '"create": chunk and embed. Errors if chunks already exist. ' +
      '"re-embed": delete existing chunks, re-chunk with current params.'
    ),
  chunkSize: z.number().int().min(100).max(2000).default(500)
    .describe("Target character count per chunk (chars, not tokens). ~4 chars ≈ 1 token."),
  overlap: z.number().int().min(0).max(200).default(50)
    .describe("Character overlap between consecutive chunks for fixed-size splitting."),
  maxChunks: z.number().int().min(2).max(100).optional()
    .describe("Cap on chunks generated. Excess content is dropped."),
  separator: z.enum(["paragraph", "sentence", "none"])
    .default("paragraph")
    .describe(
      '"paragraph": split on double newlines. ' +
      '"sentence": split on sentence boundaries, respecting chunkSize. ' +
      '"none": fixed-size split with overlap.'
    ),
});

export type ChunkEngramInput = z.infer<typeof ChunkEngramInput>;

interface ChunkRecord {
  chunkId: string;
  chunkIndex: number;
  charCount: number;
}

function chunkIndexPath(vaultRoot: string, engramId: string): string {
  return join(vaultRoot, ".engram-chunks", `${engramId}.json`);
}

function chunkByParagraph(text: string, chunkSize: number): string[] {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > chunkSize) {
      chunks.push(current.trim());
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function chunkBySentence(text: string, chunkSize: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current && current.length + s.length > chunkSize) {
      chunks.push(current.trim());
      current = s.trim();
    } else {
      current = current ? `${current} ${s.trim()}` : s.trim();
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function chunkBySize(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}

function chunkText(
  text: string,
  chunkSize: number,
  overlap: number,
  separator: "paragraph" | "sentence" | "none",
): string[] {
  switch (separator) {
    case "paragraph":
      return chunkByParagraph(text, chunkSize);
    case "sentence":
      return chunkBySentence(text, chunkSize);
    case "none":
      return chunkBySize(text, chunkSize, overlap);
  }
}

export { chunkText, chunkByParagraph, chunkBySentence, chunkBySize, chunkIndexPath, ChunkRecord };

export async function chunkEngram(
  input: ChunkEngramInput,
  vault: Vault,
  vaultIndex: VaultIndex,
  chroma: EngramChroma,
  embedder: EmbeddingProvider,
): Promise<{
  id: string;
  mode: string;
  totalChunks: number;
  chunks: Array<{ chunkId: string; chunkIndex: number; charCount: number; preview: string }>;
  message: string;
}> {
  const indexPath = chunkIndexPath(vault.root, input.id);

  if (input.mode === "create") {
    if (existsSync(indexPath)) {
      throw new Error(`Chunks already exist for ${input.id}. Use mode "re-embed" to replace them.`);
    }
  } else if (input.mode === "re-embed") {
    if (!existsSync(indexPath)) {
      throw new Error(`No chunks found for ${input.id}. Use mode "create" first.`);
    }
    const existing: ChunkRecord[] = JSON.parse(readFileSync(indexPath, "utf-8"));
    await Promise.all(existing.map((r) => chroma.delete(r.chunkId)));
    rmSync(indexPath);
  }

  const location = vaultIndex.resolve(input.id);
  if (!location) throw new Error(`Engram ${input.id} not found in vault index.`);

  const raw = vault.readEngram(location.relativePath);
  const { body } = parseEngram(raw);
  const parsed = matter(raw);

  let chunks = chunkText(body, input.chunkSize, input.overlap, input.separator);
  if (input.maxChunks) chunks = chunks.slice(0, input.maxChunks);

  if (chunks.length === 0) {
    throw new Error(`Engram ${input.id} has no content to chunk.`);
  }

  const records: ChunkRecord[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkId = crypto.randomUUID();
    const embedding = await embedder.embed(chunks[i], {
      taskInstruction: "Represent the following document chunk for retrieval: ",
    });
    await chroma.upsert(
      {
        id: chunkId,
        content: chunks[i],
        title: (parsed.data.title as string) ?? "",
        date: (parsed.data.date as string) ?? "",
        filename: basename(location.relativePath),
        relativePath: `_chunks/${input.id}/${i}`,
        vaultPath: vault.root,
        abstract: `Chunk ${i + 1} of ${chunks.length}: ${chunks[i].slice(0, 120).replace(/\s+/g, " ")}…`,
        type: "chunk",
        parentEngramId: input.id,
      },
      embedding,
    );
    records.push({ chunkId, chunkIndex: i, charCount: chunks[i].length });
  }

  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, JSON.stringify(records, null, 2), "utf-8");

  return {
    id: input.id,
    mode: input.mode,
    totalChunks: records.length,
    chunks: records.map((r) => ({
      chunkId: r.chunkId,
      chunkIndex: r.chunkIndex,
      charCount: r.charCount,
      preview: chunks[r.chunkIndex].slice(0, 80),
    })),
    message: `${input.mode === "create" ? "Created" : "Re-embedded"} ${records.length} chunks (separator: ${input.separator})`,
  };
}