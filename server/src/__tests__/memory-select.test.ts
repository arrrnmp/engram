import { describe, test, expect } from "bun:test";
import { selectModel, MODEL_VARIANTS } from "../hardware/memory.js";

describe("selectModel", () => {
  test("selects 8b q8_0 with plenty of memory", () => {
    const result = selectModel(20, 0.25);
    expect(result.variant.modelSize).toBe("8b");
    expect(result.variant.quant).toBe("q8_0");
    expect(result.safeMemoryGB).toBe(15); // 20 * 0.75
  });

  test("falls back to 8b q6_k when q8_0 doesn't fit", () => {
    const result = selectModel(9, 0.25);
    expect(result.variant.modelSize).toBe("8b");
    expect(result.variant.quant).toBe("q6_k");
  });

  test("falls back to 4b when 8b models don't fit", () => {
    const result = selectModel(5.5, 0.25);
    expect(result.variant.modelSize).toBe("4b");
  });

  test("selects smallest model with tight memory", () => {
    const result = selectModel(4, 0.25);
    expect(result.variant.modelSize).toBe("4b");
    expect(result.variant.quant).toBe("q4_k_m");
  });

  test("throws when memory is insufficient for any model", () => {
    expect(() => selectModel(1, 0.25)).toThrow("Insufficient memory");
  });

  test("throws when memory is zero", () => {
    expect(() => selectModel(0, 0.25)).toThrow("Insufficient memory");
  });

  test("respects preferredSize = 4b", () => {
    const result = selectModel(20, 0.25, "4b");
    expect(result.variant.modelSize).toBe("4b");
    expect(result.variant.quant).toBe("q8_0");
  });

  test("throws when preferred 8b doesn't fit and no alternatives allowed", () => {
    // preferredSize filters to only 8b variants — if none fit, it throws
    expect(() => selectModel(5, 0.25, "8b")).toThrow("Insufficient memory");
  });

  test("applies overhead buffer correctly", () => {
    // 8b q8_0 needs 8.5 GB. With 12 GB and 0.25 buffer, safe = 9 GB → fits.
    const fits = selectModel(12, 0.25);
    expect(fits.variant.modelSize).toBe("8b");
    expect(fits.variant.quant).toBe("q8_0");

    // With 12 GB and 0.35 buffer, safe = 7.8 GB → too small for 8b q8_0.
    const stepped = selectModel(12, 0.35);
    expect(stepped.variant.quant).toBe("q6_k"); // 6.5 GB fits in 7.8
  });

  test("MODEL_VARIANTS is ordered from highest to lowest quality", () => {
    for (let i = 1; i < MODEL_VARIANTS.length; i++) {
      const prev = MODEL_VARIANTS[i - 1];
      const curr = MODEL_VARIANTS[i];
      // Each variant should have lower or equal bits, or same bits but smaller model
      const prevScore = prev.bits * (prev.modelSize === "8b" ? 2 : 1);
      const currScore = curr.bits * (curr.modelSize === "8b" ? 2 : 1);
      expect(prevScore).toBeGreaterThanOrEqual(currScore);
    }
  });

  test("zero overhead buffer allows maximum usage", () => {
    const result = selectModel(8.5, 0);
    expect(result.variant.modelSize).toBe("8b");
    expect(result.variant.quant).toBe("q8_0");
    expect(result.safeMemoryGB).toBe(8.5);
  });

  test("large overhead buffer can prevent any selection", () => {
    expect(() => selectModel(8, 0.9)).toThrow("Insufficient memory");
  });
});
