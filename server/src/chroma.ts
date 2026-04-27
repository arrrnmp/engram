import { ChromaClient, Collection, type Where } from "chromadb";
import type { Config } from "./config.js";

export interface EngramRecord {
  id: string;
  content: string;
  title: string;
  date: string;
  filename: string;
  vaultPath: string;
}

export interface SearchResult {
  id: string;
  title: string;
  date: string;
  filename: string;
  excerpt: string;
  similarity: number;
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
    await this.col.upsert({
      ids: [record.id],
      embeddings: [embedding],
      documents: [record.content],
      metadatas: [
        {
          title: record.title,
          date: record.date,
          filename: record.filename,
          vaultPath: record.vaultPath,
        },
      ],
    });
  }

  async search(
    queryEmbedding: number[],
    nResults: number = 5,
    dateRange?: { from?: string; to?: string }
  ): Promise<SearchResult[]> {
    const where = buildDateWhere(dateRange);

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
      // ChromaDB returns cosine distance (0 = identical, 2 = opposite)
      similarity: 1 - (distances[i] ?? 1),
    }));
  }

  async getAll(dateRange?: { from?: string; to?: string }): Promise<SearchResult[]> {
    const where = buildDateWhere(dateRange);

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
    }));
  }

  async delete(id: string): Promise<void> {
    await this.col.delete({ ids: [id] });
  }
}

function buildDateWhere(
  dateRange?: { from?: string; to?: string }
): Where | undefined {
  if (!dateRange?.from && !dateRange?.to) return undefined;
  if (dateRange.from && dateRange.to) {
    return { $and: [{ date: { $gte: dateRange.from } }, { date: { $lte: dateRange.to } }] };
  }
  if (dateRange.from) return { date: { $gte: dateRange.from } };
  return { date: { $lte: dateRange.to! } };
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}…`;
}
