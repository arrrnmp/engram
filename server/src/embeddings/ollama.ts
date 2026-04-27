import type { EmbeddingProvider } from "./types.js";

interface OllamaEmbedResponse {
  embeddings: number[][];
}

export class OllamaProvider implements EmbeddingProvider {
  constructor(
    private host: string,
    private model: string
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.host}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as OllamaEmbedResponse;
    return data.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.host}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as OllamaEmbedResponse;
    return data.embeddings;
  }

  modelInfo() {
    return { provider: "ollama", model: this.model };
  }
}
