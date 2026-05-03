import { describe, it, expect } from "bun:test";
import { mockEmbedder } from "./helpers/mocks.js";

describe("task instruction", () => {
  it("embed accepts taskInstruction option without error", async () => {
    const embedder = mockEmbedder();
    const result = await embedder.embed("hello", { taskInstruction: "Represent the following document for retrieval: " });
    expect(result).toHaveLength(4096);
    expect(result[0]).toBe(0.01);
  });

  it("embed works without taskInstruction option", async () => {
    const embedder = mockEmbedder();
    const result = await embedder.embed("hello");
    expect(result).toHaveLength(4096);
  });

  it("embed works with empty options object", async () => {
    const embedder = mockEmbedder();
    const result = await embedder.embed("hello", {});
    expect(result).toHaveLength(4096);
  });
});
