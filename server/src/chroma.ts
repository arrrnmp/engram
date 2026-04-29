import { ChromaClient, Collection, type Where } from "chromadb";
import type { Config } from "./config.js";

export interface EngramRecord {
  id: string;
  content: string;
  title: string;
  date: string;
  filename: string;
  vaultPath: string;
  abstract?: string;
  type?: string;
}

export interface SearchResult {
  id: string;
  title: string;
  date: string;
  filename: string;
  excerpt: string;
  similarity: number;
  abstract?: string;
  type?: string;
}

export class EngramChroma {
  private client: ChromaClient;
  private collection: Collection | null = null;
  private collectionName: string;

  constructor(config: Config) {
    this.client = new ChromaClient({ path: config.chroma.host });
    this.collectionName = config.chroma.collection;
  }

  async init(): Promise<void> {
    this.collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
      metadata: { "hnsw:space": "cosine" },
    });
  }

  private get col(): Collection {
    if (!this.collection) throw new Error("ChromaDB not initialized. Call init() first.");
    return this.collection;
  }

  async upsert(record: EngramRecord, embedding: number[]): Promise<void> {
    const metadata: Record<string, string> = {
      title: record.title,
      date: record.date,
      filename: record.filename,
      vaultPath: record.vaultPath,
    };
    if (record.abstract) metadata.abstract = record.abstract;
    if (record.type) metadata.type = record.type;

    await this.col.upsert({
      ids: [record.id],
      embeddings: [embedding],
      documents: [record.content],
      metadatas: [metadata],
    });
  }

  /** Merge `patch` into an existing document's metadata without touching its embedding. */
  async patchMetadata(id: string, patch: Record<string, string>): Promise<void> {
    const result = await this.col.get({ ids: [id], include: ["metadatas"] as any });
    if (!result.ids.length) return; // not in ChromaDB — skip silently
    const existing = (result.metadatas[0] ?? {}) as Record<string, string>;
    await this.col.update({
      ids: [id],
      metadatas: [{ ...existing, ...patch }],
    });
  }

  async search(
    queryEmbedding: number[],
    nResults: number = 5,
    dateRange?: { from?: string; to?: string },
    type?: string
  ): Promise<SearchResult[]> {
    const where = buildWhere(dateRange, type);

    const results = await this.col.query({
      queryEmbeddings: [queryEmbedding],
      nResults,
      ...(where ? { where } : {}),
    });

    const ids = results.ids[0] ?? [];
    const distances = results.distances?.[0] ?? [];
    const metadatas = results.metadatas[0] ?? [];
    const documents = results.documents[0] ?? [];

    return ids.map((id, i) => ({
      id,
      title: (metadatas[i]?.title as string) ?? id,
      date: (metadatas[i]?.date as string) ?? "",
      filename: (metadatas[i]?.filename as string) ?? "",
      excerpt: truncate(documents[i] ?? "", 300),
      similarity: 1 - (distances[i] ?? 1),
      abstract: (metadatas[i]?.abstract as string) ?? undefined,
      type: (metadatas[i]?.type as string) ?? undefined,
    }));
  }

  async getAll(dateRange?: { from?: string; to?: string }, type?: string): Promise<SearchResult[]> {
    const where = buildWhere(dateRange, type);

    const results = await this.col.get({
      ...(where ? { where } : {}),
    });

    return (results.ids ?? []).map((id, i) => ({
      id,
      title: (results.metadatas[i]?.title as string) ?? id,
      date: (results.metadatas[i]?.date as string) ?? "",
      filename: (results.metadatas[i]?.filename as string) ?? "",
      excerpt: truncate(results.documents[i] ?? "", 300),
      similarity: 1,
      abstract: (results.metadatas[i]?.abstract as string) ?? undefined,
      type: (results.metadatas[i]?.type as string) ?? undefined,
    }));
  }

  /** Search by a raw embedding vector, excluding `excludeId` from results. Used by clustering. */
  async searchByEmbedding(
    queryEmbedding: number[],
    nResults: number,
    excludeId: string,
    dateRange?: { from?: string; to?: string }
  ): Promise<Array<{ id: string; similarity: number; date: string; filename: string; title: string }>> {
    // Fetch one extra to account for the self-match being filtered out.
    const results = await this.search(queryEmbedding, nResults + 1, dateRange);
    return results
      .filter((r) => r.id !== excludeId)
      .slice(0, nResults)
      .map((r) => ({ id: r.id, similarity: r.similarity, date: r.date, filename: r.filename, title: r.title }));
  }

  async delete(id: string): Promise<void> {
    await this.col.delete({ ids: [id] });
  }

  async getAllIds(): Promise<string[]> {
    const result = await this.col.get({ include: [] as any });
    return result.ids ?? [];
  }

  async getAllWithEmbeddings(dateRange?: { from?: string; to?: string }): Promise<Array<{
    id: string;
    embedding: number[];
    date: string;
    filename: string;
    title: string;
  }>> {
    const where = buildWhere(dateRange);
    const results = await this.col.get({
      ...(where ? { where } : {}),
      include: ["embeddings", "metadatas"] as any,
    });

    const ids = results.ids ?? [];
    const embeddings: number[][] = (results as any).embeddings ?? [];
    const metadatas = results.metadatas ?? [];

    return ids
      .map((id, i) => ({
        id,
        embedding: embeddings[i] ?? [],
        date: (metadatas[i]?.date as string) ?? "",
        filename: (metadatas[i]?.filename as string) ?? "",
        title: (metadatas[i]?.title as string) ?? id,
      }))
      .filter((item) => item.embedding.length > 0);
  }
}

function buildWhere(
  dateRange?: { from?: string; to?: string },
  type?: string
): Where | undefined {
  const conditions: Where[] = [];

  if (dateRange?.from && dateRange?.to) {
    conditions.push({ $and: [{ date: { $gte: dateRange.from } }, { date: { $lte: dateRange.to } }] });
  } else if (dateRange?.from) {
    conditions.push({ date: { $gte: dateRange.from } });
  } else if (dateRange?.to) {
    conditions.push({ date: { $lte: dateRange.to! } });
  }

  if (type) {
    conditions.push({ type: { $eq: type } });
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { $and: conditions };
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}…`;
}
