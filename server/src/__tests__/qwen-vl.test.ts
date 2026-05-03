import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { PNG } from "pngjs";
import { QwenVLProvider } from "../embeddings/qwen-vl.js";

function make1x1Png(): Buffer {
  const png = new PNG({ width: 1, height: 1 });
  png.data = Buffer.from([255, 255, 255, 255]);
  return PNG.sync.write(png);
}

const FAKE_EMBEDDING_RESPONSE = { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] };

let originalFetch: typeof globalThis.fetch;
let capturedBody: Record<string, unknown> | null = null;

beforeEach(() => {
  capturedBody = null;
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (_url: string, opts?: RequestInit) => {
    capturedBody = JSON.parse(opts?.body as string);
    return new Response(JSON.stringify(FAKE_EMBEDDING_RESPONSE));
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("QwenVLProvider.embed — multimodal content array", () => {
  const provider = new QwenVLProvider("http://localhost:8001", "test-model");

  test("image/png input produces a single image_url element", async () => {
    await provider.embed({ mimeType: "image/png", data: make1x1Png() });

    const input = capturedBody!.input as unknown[];
    expect(input).toHaveLength(1);
    expect((input[0] as any).type).toBe("image_url");
  });

  test("video/mp4 produces a video_url element", async () => {
    await provider.embed({ mimeType: "video/mp4", data: Buffer.from("fake-video") });

    const input = capturedBody!.input as unknown[];
    expect((input[0] as any).type).toBe("video_url");
  });

  test("application/pdf produces an image_url element", async () => {
    await provider.embed({ mimeType: "application/pdf", data: Buffer.from("fake-pdf") });

    const input = capturedBody!.input as unknown[];
    expect((input[0] as any).type).toBe("image_url");
    expect((input[0] as any).image_url.url).toMatch(/^data:application\/pdf;base64,/);
  });

  test("capabilities() includes documents:true", () => {
    expect(provider.capabilities().documents).toBe(true);
  });
});