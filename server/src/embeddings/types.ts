export interface EmbedOptions {
  taskInstruction?: string;
}

export interface MultimodalInput {
  mimeType: string;
  data: Buffer;
}

export interface EmbeddingCapabilities {
  text: boolean;
  images: boolean;
  video: boolean;
  pdf: boolean;
  documents: boolean;
}

export interface EmbeddingProvider {
  embed(text: string | MultimodalInput, options?: EmbedOptions): Promise<number[]>;
  embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]>;
  modelInfo(): { provider: string; model: string };
  expectedDimensions(): number;
  capabilities(): EmbeddingCapabilities;
}
