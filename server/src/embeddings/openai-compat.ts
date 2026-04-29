/**
 * OpenAI-compatible embedding provider.
 * Used for NVIDIA (vLLM) and OpenAI — both expose the same
 * /v1/embeddings endpoint shape.
 */
import type { EmbeddingProvider } from "./types.js";

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

export class OpenAICompatProvider implements EmbeddingProvider {
  constructor(
    private baseUrl: string,
    private model: string,
    private providerName: string,
    private apiKey?: string
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      throw new Error(
        `${this.providerName} embed failed (${res.status}): ${await res.text()}`
      );
    }
    const data = (await res.json()) as OpenAIEmbedResponse;
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(
        `${this.providerName} embed failed (${res.status}): ${await res.text()}`
      );
    }
    const data = (await res.json()) as OpenAIEmbedResponse;
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  modelInfo() {
    return { provider: this.providerName, model: this.model };
  }
}
