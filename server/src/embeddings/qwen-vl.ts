import type { EmbeddingProvider, EmbedOptions, MultimodalInput } from "./types.js";

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

export class QwenVLProvider implements EmbeddingProvider {
  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey?: string,
    private provider: string = "vllm"
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async embed(input: string | MultimodalInput, options?: EmbedOptions): Promise<number[]> {
    let apiInput: string | Array<Record<string, unknown>>;

    if (typeof input === "string") {
      apiInput = options?.taskInstruction ? `${options.taskInstruction}${input}` : input;
    } else {
      // Multimodal input — build content array for vLLM
      const base64 = input.data.toString("base64");
      if (input.mimeType.startsWith("image/")) {
        apiInput = [
          { type: "image_url", image_url: { url: `data:${input.mimeType};base64,${base64}` } },
        ];
      } else if (input.mimeType.startsWith("video/")) {
        apiInput = [
          { type: "video_url", video_url: { url: `data:${input.mimeType};base64,${base64}` } },
        ];
      } else if (input.mimeType === "application/pdf") {
        apiInput = [
          { type: "image_url", image_url: { url: `data:application/pdf;base64,${base64}` } },
        ];
      } else {
        throw new Error(`Unsupported MIME type: ${input.mimeType}`);
      }
    }

    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: this.model, input: apiInput }),
    });
    if (!res.ok) {
      throw new Error(`${this.provider} embed failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as OpenAIEmbedResponse;
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    const inputs = options?.taskInstruction
      ? texts.map((t) => `${options.taskInstruction}${t}`)
      : texts;
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: this.model, input: inputs }),
    });
    if (!res.ok) {
      throw new Error(`${this.provider} embed batch failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as OpenAIEmbedResponse;
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  modelInfo() {
    return { provider: this.provider, model: this.model };
  }

  expectedDimensions(): number {
    return 2048;
  }

  capabilities() {
    return { text: true, images: true, video: true, pdf: true, documents: true };
  }
}
