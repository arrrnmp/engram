import { ChromaClient, Collection, type Where } from "chromadb";
import type { Config } from "./config.js";

export interface EngramRecord {
  id: string;
  content: string;
  title: string;
  date: string;
  filename: string;
  vaultPath: string;
  type?: string;
}

export interface SearchResult {
  id: string;
  title: string;
  date: string;
  filename: string;
  excerpt: string;
  similarity: number;
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
    if (record.type) metadata.type = record.type;

    await this.col.upsert({
      ids: [record.id],
      embeddings: [embedding],
      documents: [record.content],
      metadatas: [metadata],
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
      type: (results.metadatas[i]?.type as string) ?? undefined,
    }));
  }

  async delete(id: string): Promise<void> {
    await this.col.delete({ ids: [id] });
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
