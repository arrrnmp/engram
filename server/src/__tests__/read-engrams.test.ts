import { describe, test, expect } from "bun:test";
import { readEngrams, truncateBatchResponse } from "../tools/read-engrams.js";
import { mockVault, mockVaultIndex } from "./helpers/mocks.js";

describe("readEngrams", () => {
  test("maps over IDs and resolves each individually", () => {
    const vault = mockVault({
      readContent: `---
id: "aaaaaaaa-1111-2222-3333-444444444444"
title: "Test"
date: "2026-04-29"
---

Body content.`,
    });
    const resolutions = new Map([
      ["aaaaaaaa-1111-2222-3333-444444444444", { relativePath: "2026-04-29/test.md" }],
      ["bbbbbbbb-5555-6666-7777-888888888888", { relativePath: "2026-04-28/other.md" }],
    ]);
    const vaultIndex = mockVaultIndex({ resolutions });

    const result = readEngrams(
      { ids: ["aaaaaaaa-1111-2222-3333-444444444444", "bbbbbbbb-5555-6666-7777-888888888888"] },
      vaultIndex,
      vault
    );

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      title: "Test",
      body: "Body content.",
    });
    expect(result.results[1]).toMatchObject({
      id: "bbbbbbbb-5555-6666-7777-888888888888",
      title: "Test",
      body: "Body content.",
    });
  });

  test("returns error for missing engram", () => {
    const vault = mockVault();
    const vaultIndex = mockVaultIndex({ resolutions: new Map() });

    const result = readEngrams({ ids: ["aaaaaaaa-1111-2222-3333-444444444444"] }, vaultIndex, vault);

    expect(result.results[0]).toEqual({
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      error: "Engram not found",
    });
  });

  test("catches per-item errors and includes them in results", () => {
    const vault = mockVault({
      readContent: `---
id: "aaaaaaaa-1111-2222-3333-444444444444"
title: "Test"
date: "2026-04-29"
---

Body.`,
    });
    // Make readEngram throw for the second item by overriding the mock
    const badVault = {
      ...vault,
      readEngram: (path: string) => {
        if (path.includes("bad")) throw new Error("Read failed");
        return vault.readEngram(path);
      },
    };

    const resolutions = new Map([
      ["aaaaaaaa-1111-2222-3333-444444444444", { relativePath: "2026-04-29/good.md" }],
      ["bbbbbbbb-5555-6666-7777-888888888888", { relativePath: "2026-04-29/bad.md" }],
    ]);
    const vaultIndex = mockVaultIndex({ resolutions });

    const result = readEngrams(
      { ids: ["aaaaaaaa-1111-2222-3333-444444444444", "bbbbbbbb-5555-6666-7777-888888888888"] },
      vaultIndex,
      badVault as any
    );

    expect(result.results[0]).toMatchObject({ id: "aaaaaaaa-1111-2222-3333-444444444444", title: "Test" });
    // String(err) prepends "Error: " to the message
    expect(result.results[1]).toEqual({ id: "bbbbbbbb-5555-6666-7777-888888888888", error: "Error: Read failed" });
  });
});

describe("truncateBatchResponse", () => {
  function makeResult(bodyLength: number, id = "test-id") {
    return {
      id,
      title: "Test",
      date: "2026-04-29",
      tags: [],
      body: "x".repeat(bodyLength),
      wikilinks: [],
    };
  }

  test("leaves bodies intact when total JSON length <= 80K", () => {
    const results = [makeResult(100), makeResult(200)];
    const truncated = truncateBatchResponse(results);
    expect(truncated.truncated).toBe(false);
    expect(truncated.results[0].body).toBe("x".repeat(100));
    expect(truncated.results[1].body).toBe("x".repeat(200));
  });

  test("truncates all bodies when total JSON length > 80K", () => {
    // Each body is ~30K, three bodies plus overhead should exceed 80K
    const results = [makeResult(30_000, "a"), makeResult(30_000, "b"), makeResult(30_000, "c")];
    const truncated = truncateBatchResponse(results);
    expect(truncated.truncated).toBe(true);
    expect(truncated.results[0].body).toBe("x".repeat(1000) + "\n...(truncated)");
    expect(truncated.results[1].body).toBe("x".repeat(1000) + "\n...(truncated)");
    expect(truncated.results[2].body).toBe("x".repeat(1000) + "\n...(truncated)");
  });

  test("does not truncate error entries", () => {
    const results = [
      makeResult(30_000, "a"),
      { id: "b", error: "x".repeat(30_000) },
      makeResult(30_000, "c"),
    ];
    const truncated = truncateBatchResponse(results);
    expect(truncated.truncated).toBe(true);
    expect(truncated.results[0].body).toBe("x".repeat(1000) + "\n...(truncated)");
    expect(truncated.results[1]).toEqual({ id: "b", error: "x".repeat(30_000) });
    expect(truncated.results[2].body).toBe("x".repeat(1000) + "\n...(truncated)");
  });

  test("handles exactly at 80K boundary", () => {
    // Create a single result with body size that puts JSON exactly at ~80K
    // The wrapper JSON is about 80 chars, so body should be ~79_920
    const results = [makeResult(79_920, "a")];
    const json = JSON.stringify({ results }, null, 2);
    expect(json.length).toBeGreaterThan(80_000);

    const truncated = truncateBatchResponse(results);
    expect(truncated.truncated).toBe(true);
    expect(truncated.results[0].body).toBe("x".repeat(1000) + "\n...(truncated)");
  });

  test("handles single very large body", () => {
    const results = [makeResult(100_000, "a")];
    const truncated = truncateBatchResponse(results);
    expect(truncated.truncated).toBe(true);
    expect(truncated.results[0].body).toBe("x".repeat(1000) + "\n...(truncated)");
  });

  test("handles many small bodies that sum to >80K", () => {
    // 100 bodies of 900 chars each = 90K chars, plus JSON overhead > 80K
    const results = Array.from({ length: 100 }, (_, i) => makeResult(900, `id-${i}`));
    const truncated = truncateBatchResponse(results);
    expect(truncated.truncated).toBe(true);
    // After truncation, each body is sliced to 1000 chars + ellipsis
    // Since original is 900 chars, slice(0,1000) returns all 900, then appends ellipsis
    expect(truncated.results[0].body).toBe("x".repeat(900) + "\n...(truncated)");
  });

  test("does not truncate when many small bodies sum to <=80K", () => {
    const results = Array.from({ length: 10 }, (_, i) => makeResult(100, `id-${i}`));
    const truncated = truncateBatchResponse(results);
    expect(truncated.truncated).toBe(false);
    expect(truncated.results[0].body).toBe("x".repeat(100));
  });
});
