import { describe, test, expect } from "bun:test";
import { captionImage, preprocessImageForCaption } from "../captioning.js";
import sharp from "sharp";

describe("captionImage", () => {
  const config = {
    host: "http://localhost:8002/v1",
    model: "qwen3.5:4b",
    prompt: "Describe this image concisely for search and retrieval.",
    maxTokens: 256,
    temperature: 0.7,
    topP: 0.8,
    topK: 20,
    minP: 0.0,
    presencePenalty: 1.5,
    repetitionPenalty: 1.0,
    think: false,
  };

  test("returns null on network error", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const filePath = join(tmpdir(), `engram-test-caption-${Date.now()}.jpg`);
    writeFileSync(filePath, Buffer.from("fake"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("Network error"); };

    try {
      const result = await captionImage(filePath, "image/jpeg", config);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(filePath, { force: true });
    }
  });

  test("returns null on non-OK response", async () => {
    const filePath = "/tmp/engram-test-caption-nonexist.jpg";
    const { writeFileSync } = await import("fs");
    writeFileSync(filePath, Buffer.from("fake"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Error", { status: 500 });

    try {
      const result = await captionImage(filePath, "image/jpeg", config);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      const { rmSync } = await import("fs");
      rmSync(filePath, { force: true });
    }
  });

  test("returns caption on successful response", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const filePath = "/tmp/engram-test-caption-ok.jpg";
    writeFileSync(filePath, Buffer.from("fake-jpeg-data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { content: "A sunset over the ocean with orange and purple clouds." } }],
    });

    try {
      const result = await captionImage(filePath, "image/jpeg", config);
      expect(result).toBe("A sunset over the ocean with orange and purple clouds.");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(filePath, { force: true });
    }
  });

  test("returns caption when response content is a text-part array", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const filePath = "/tmp/engram-test-caption-parts.jpg";
    writeFileSync(filePath, Buffer.from("fake-jpeg-data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      choices: [{
        message: {
          content: [
            { type: "text", text: "A mountain lake" },
            { type: "text", text: "at sunrise" },
          ],
        },
      }],
    });

    try {
      const result = await captionImage(filePath, "image/jpeg", config);
      expect(result).toBe("A mountain lake at sunrise");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(filePath, { force: true });
    }
  });

  test("returns caption when response content is a text object", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const filePath = "/tmp/engram-test-caption-object.jpg";
    writeFileSync(filePath, Buffer.from("fake-jpeg-data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      choices: [{
        message: {
          content: { type: "text", text: "A hand-drawn UI wireframe with notes" },
        },
      }],
    });

    try {
      const result = await captionImage(filePath, "image/jpeg", config);
      expect(result).toBe("A hand-drawn UI wireframe with notes");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(filePath, { force: true });
    }
  });

  test("returns caption from top-level response field", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const filePath = "/tmp/engram-test-caption-response.jpg";
    writeFileSync(filePath, Buffer.from("fake-jpeg-data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      response: "A screenshot of a dashboard with a left sidebar",
    });

    try {
      const result = await captionImage(filePath, "image/jpeg", config);
      expect(result).toBe("A screenshot of a dashboard with a left sidebar");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(filePath, { force: true });
    }
  });

  test("returns null when model responds with non-vision refusal text", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const filePath = "/tmp/engram-test-caption-refusal.jpg";
    writeFileSync(filePath, Buffer.from("fake-jpeg-data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      choices: [{
        message: {
          content: "I am unable to view images. Please provide a description or upload an image so I can assist.",
        },
      }],
    });

    try {
      const result = await captionImage(filePath, "image/jpeg", config);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(filePath, { force: true });
    }
  });

  test("trims whitespace from caption", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const filePath = "/tmp/engram-test-caption-trim.png";
    writeFileSync(filePath, Buffer.from("fake-png-data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { content: "  A beautiful landscape  \n" } }],
    });

    try {
      const result = await captionImage(filePath, "image/png", config);
      expect(result).toBe("A beautiful landscape");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(filePath, { force: true });
    }
  });

  test("returns null when response has no choices", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const filePath = "/tmp/engram-test-caption-empty.gif";
    writeFileSync(filePath, Buffer.from("fake-gif-data"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ choices: [] });

    try {
      const result = await captionImage(filePath, "image/gif", config);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(filePath, { force: true });
    }
  });

  test("sends model and prompt in request body", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const filePath = "/tmp/engram-test-caption-req.webp";
    writeFileSync(filePath, Buffer.from("fake"));

    let capturedBody: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return Response.json({
        choices: [{ message: { content: "caption" } }],
      });
    };

    try {
      await captionImage(filePath, "image/webp", config);
      expect(capturedBody.model).toBe("qwen3.5:4b");
      expect(capturedBody.messages[0].content[1].text).toBe("Describe this image concisely for search and retrieval.");
      expect(capturedBody.messages[0].content[0].type).toBe("image_url");
      expect(capturedBody.max_tokens).toBe(256);
      expect(capturedBody.temperature).toBe(0.7);
      expect(capturedBody.top_p).toBe(0.8);
      expect(capturedBody.top_k).toBe(20);
      expect(capturedBody.min_p).toBe(0.0);
      expect(capturedBody.presence_penalty).toBe(1.5);
      expect(capturedBody.repetition_penalty).toBe(1.0);
      expect(capturedBody.think).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(filePath, { force: true });
    }
  });

  test("merges extraBody into request body", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const filePath = "/tmp/engram-test-caption-extra.webp";
    writeFileSync(filePath, Buffer.from("fake"));

    let capturedBody: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return Response.json({
        choices: [{ message: { content: "caption" } }],
      });
    };

    try {
      await captionImage(filePath, "image/webp", { ...config, extraBody: { custom_param: 42 } });
      expect(capturedBody.custom_param).toBe(42);
      expect(capturedBody.temperature).toBe(0.7);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(filePath, { force: true });
    }
  });

  test("normalizes OpenAI host without /v1", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const filePath = "/tmp/engram-test-caption-host.jpg";
    writeFileSync(filePath, Buffer.from("fake"));

    let capturedUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL) => {
      capturedUrl = String(url);
      return Response.json({
        choices: [{ message: { content: "caption" } }],
      });
    };

    try {
      await captionImage(filePath, "image/jpeg", { ...config, host: "http://localhost:8001" });
      expect(capturedUrl).toBe("http://localhost:8001/v1/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(filePath, { force: true });
    }
  });
});

describe("preprocessImageForCaption", () => {
  test("small image passes through unchanged", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const filePath = join(tmpdir(), `engram-test-preprocess-small-${Date.now()}.png`);
    const original = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .png()
      .toBuffer();
    writeFileSync(filePath, original);

    try {
      const result = await preprocessImageForCaption(filePath, "image/png");
      // Should return the exact original file since it's under 1536px
      expect(result.length).toBe(original.length);
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  test("large landscape image is resized to 1536px width", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const filePath = join(tmpdir(), `engram-test-preprocess-landscape-${Date.now()}.jpg`);
    await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 0, g: 255, b: 0 } } })
      .jpeg({ quality: 95 })
      .toFile(filePath);

    try {
      const result = await preprocessImageForCaption(filePath, "image/jpeg");
      const metadata = await sharp(result).metadata();
      expect(metadata.width).toBe(1536);
      // Height should be scaled proportionally: 2000 * (1536/3000) = 1024
      expect(metadata.height).toBe(1024);
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  test("large portrait image is resized to 1536px height", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const filePath = join(tmpdir(), `engram-test-preprocess-portrait-${Date.now()}.jpg`);
    await sharp({ create: { width: 2000, height: 3000, channels: 3, background: { r: 0, g: 0, b: 255 } } })
      .jpeg({ quality: 95 })
      .toFile(filePath);

    try {
      const result = await preprocessImageForCaption(filePath, "image/jpeg");
      const metadata = await sharp(result).metadata();
      // Width should be scaled proportionally: 2000 * (1536/3000) = 1024
      expect(metadata.width).toBe(1024);
      expect(metadata.height).toBe(1536);
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  test("non-image mime type passes through unchanged", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const filePath = join(tmpdir(), `engram-test-preprocess-text-${Date.now()}.txt`);
    const original = Buffer.from("Hello, world!");
    writeFileSync(filePath, original);

    try {
      const result = await preprocessImageForCaption(filePath, "text/plain");
      expect(result.toString()).toBe("Hello, world!");
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  test("corrupted image falls back to original", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const filePath = join(tmpdir(), `engram-test-preprocess-corrupt-${Date.now()}.jpg`);
    const original = Buffer.from("not-a-valid-jpeg");
    writeFileSync(filePath, original);

    try {
      const result = await preprocessImageForCaption(filePath, "image/jpeg");
      expect(result.toString()).toBe("not-a-valid-jpeg");
    } finally {
      rmSync(filePath, { force: true });
    }
  });
});
