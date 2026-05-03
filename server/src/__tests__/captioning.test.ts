import { describe, test, expect } from "bun:test";
import { captionImage } from "../captioning.js";

describe("captionImage", () => {
  const config = {
    provider: "openai" as const,
    host: "http://localhost:11434/v1",
    model: "qwen3.5:4b",
    prompt: "Describe this image concisely for search and retrieval.",
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

  test("falls back to configured host when primary has no vision output", async () => {
    const { writeFileSync, rmSync } = await import("fs");
    const filePath = "/tmp/engram-test-caption-fallback.jpg";
    writeFileSync(filePath, Buffer.from("fake"));

    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return Response.json({
          choices: [{ message: { content: "", reasoning: "I cannot see the image." } }],
        });
      }
      return Response.json({
        choices: [{ message: { content: "A dashboard wireframe with navigation panels" } }],
      });
    };

    try {
      const result = await captionImage(filePath, "image/jpeg", {
        ...config,
        provider: "auto",
        fallbackHost: "http://localhost:8001",
        fallbackProvider: "openai",
      });
      expect(result).toBe("A dashboard wireframe with navigation panels");
      expect(calls[0]).toBe("http://localhost:11434/api/generate");
      expect(calls[1]).toBe("http://localhost:8001/v1/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(filePath, { force: true });
    }
  });
});
