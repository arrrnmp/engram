import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mock } from "bun:test";
import { isVllmHealthy, createEmbeddingProvider } from "../embeddings/index.js";
import type { Config } from "../config.js";
import type { HardwareInfo } from "../hardware/detect.js";

describe("isVllmHealthy", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns true when fetch returns 200 OK", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("OK", { status: 200 }))
    );
    const result = await isVllmHealthy("http://localhost:8001", 2000);
    expect(result).toBe(true);
  });

  test("returns false on non-OK status", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Service Unavailable", { status: 503 }))
    );
    const result = await isVllmHealthy("http://localhost:8001", 2000);
    expect(result).toBe(false);
  });

  test("returns true on 4xx status (<500)", async () => {
    // The implementation returns res.ok || res.status < 500
    // 404 is < 500, so it returns true
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 }))
    );
    const result = await isVllmHealthy("http://localhost:8001", 2000);
    expect(result).toBe(true);
  });

  test("returns false on network timeout", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("The operation timed out"))
    );
    const result = await isVllmHealthy("http://localhost:8001", 2000);
    expect(result).toBe(false);
  });

  test("returns false on fetch error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new TypeError("fetch failed"))
    );
    const result = await isVllmHealthy("http://localhost:8001", 2000);
    expect(result).toBe(false);
  });

  test("passes timeout via AbortSignal.timeout", async () => {
    let usedSignal: AbortSignal | undefined;
    globalThis.fetch = mock((_url, init) => {
      usedSignal = init?.signal as AbortSignal;
      return Promise.resolve(new Response("OK", { status: 200 }));
    });
    await isVllmHealthy("http://localhost:8001", 5000);
    expect(usedSignal).toBeDefined();
  });
});

describe("createEmbeddingProvider", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("OK", { status: 200 }))
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const baseConfig: Config = {
    vault: { path: "/tmp/v" },
    server: { port: 7384, https: false },
    chroma: { host: "http://localhost:8000", collection: "engrams" },
    wikilinks: { threshold: 0.72, maxLinks: 5 },
    embedding: {
      queryCacheSize: 64,
      overheadBuffer: 0.25,
      vllm: { host: "http://localhost:8001", healthTimeout: 2000 },
    },
    watcher: { enabled: true, libreOfficePath: "libreoffice" },
  };

  test("maps Apple Silicon → MLX", async () => {
    const hw: HardwareInfo = {
      platform: "apple-silicon",
      totalMemoryGB: 32,
      availableMemoryGB: 28,
    };
    const provider = await createEmbeddingProvider(baseConfig, hw);
    const info = provider.modelInfo();
    expect(info.provider).toBe("mlx");
    expect(info.model).toBe("Qwen/Qwen3-VL-Embedding-2B");
  });

  test("maps NVIDIA Blackwell → NVFP4", async () => {
    const hw: HardwareInfo = {
      platform: "nvidia-blackwell",
      totalMemoryGB: 48,
      availableMemoryGB: 48,
      gpuName: "RTX 5090",
      computeCapability: 12.0,
    };
    const provider = await createEmbeddingProvider(baseConfig, hw);
    const info = provider.modelInfo();
    expect(info.model).toBe("LifetimeMistake/Qwen3-VL-Embedding-2B-NVFP4");
  });

  test("maps older NVIDIA → GGUF cascade", async () => {
    const hw: HardwareInfo = {
      platform: "nvidia-cuda",
      totalMemoryGB: 24,
      availableMemoryGB: 24,
      gpuName: "RTX 4090",
      computeCapability: 8.9,
    };
    const provider = await createEmbeddingProvider(baseConfig, hw);
    const info = provider.modelInfo();
    // Should be a GGUF model from the cascade
    expect(info.model).toContain("GGUF");
  });

  test("maps CPU → fallback GGUF", async () => {
    const hw: HardwareInfo = {
      platform: "cpu",
      totalMemoryGB: 16,
      availableMemoryGB: 12,
    };
    const provider = await createEmbeddingProvider(baseConfig, hw);
    const info = provider.modelInfo();
    expect(info.provider).toBe("vllm");
    expect(info.model).toContain("GGUF");
  });

  test("throws when embedding server is unreachable", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Unavailable", { status: 503 }))
    );

    await expect(createEmbeddingProvider(baseConfig)).rejects.toThrow("Embedding server not reachable");
  });

  test("returns provider with expected interface", async () => {
    const hw: HardwareInfo = {
      platform: "cpu",
      totalMemoryGB: 16,
      availableMemoryGB: 12,
    };
    const provider = await createEmbeddingProvider(baseConfig, hw);
    expect(typeof provider.embed).toBe("function");
    expect(typeof provider.embedBatch).toBe("function");
    expect(typeof provider.expectedDimensions).toBe("function");
    expect(typeof provider.capabilities).toBe("function");
    expect(typeof provider.modelInfo).toBe("function");
    expect(provider.expectedDimensions()).toBe(2048);
  });
});
