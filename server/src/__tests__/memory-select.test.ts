import { describe, test, expect } from "bun:test";
import { selectModel, deriveBatchLimits, MODEL_VARIANTS } from "../hardware/memory.js";

describe("selectModel", () => {
  test("selects q8_0 with plenty of memory", () => {
    const result = selectModel(20, 0.25);
    expect(result.variant.quant).toBe("q8_0");
    expect(result.safeMemoryGB).toBe(15); // 20 * 0.75
  });

  test("falls back to q6_k when q8_0 doesn't fit", () => {
    // q8_0 needs 3.5 GB → safe = 4*0.75 = 3.0 → q8_0 (3.5) no, q6_k (3.0) yes
    const result = selectModel(4, 0.25);
    expect(result.variant.quant).toBe("q6_k");
  });

  test("falls back to q5_k_m when q6_k doesn't fit", () => {
    // safe = 3.5*0.75 = 2.625 → q8_0 no, q6_k (3.0) no, q5_k_m (2.5) yes
    const result = selectModel(3.5, 0.25);
    expect(result.variant.quant).toBe("q5_k_m");
  });

  test("falls back to q4_k_m when q5_k_m doesn't fit", () => {
    // safe = 3*0.75 = 2.25 → q8_0 no, q6_k no, q5_k_m (2.5) no, q4_k_m (2.0) yes
    const result = selectModel(3, 0.25);
    expect(result.variant.quant).toBe("q4_k_m");
  });

  test("throws when memory is insufficient for any model", () => {
    // All models need at least 2 GB → 1*0.75 = 0.75 → nothing fits
    expect(() => selectModel(1, 0.25)).toThrow("Insufficient memory");
  });

  test("throws when memory is zero", () => {
    expect(() => selectModel(0, 0.25)).toThrow("Insufficient memory");
  });

  test("respects preferredQuant override", () => {
    const result = selectModel(20, 0.25, "q4_k_m");
    expect(result.variant.quant).toBe("q4_k_m");
    expect(result.reason).toContain("user override");
  });

  test("falls back to auto when preferredQuant doesn't fit", () => {
    // q8_0 needs 3.5 GB → safe = 3*0.75 = 2.25 → q8_0 won't fit, falls to q4_k_m
    const result = selectModel(3, 0.25, "q8_0");
    expect(result.variant.quant).not.toBe("q8_0");
  });

  test("applies overhead buffer correctly", () => {
    // q8_0 needs 3.5 GB. With 6 GB and 0.25 buffer, safe = 4.5 GB → fits.
    const fits = selectModel(6, 0.25);
    expect(fits.variant.quant).toBe("q8_0");

    // With 6 GB and 0.5 buffer, safe = 3.0 GB → too small for q8_0 (3.5), fits q6_k (3.0).
    const stepped = selectModel(6, 0.5);
    expect(stepped.variant.quant).toBe("q6_k");
  });

  test("MODEL_VARIANTS is ordered from highest to lowest quality", () => {
    for (let i = 1; i < MODEL_VARIANTS.length; i++) {
      expect(MODEL_VARIANTS[i - 1].bits).toBeGreaterThanOrEqual(MODEL_VARIANTS[i].bits);
    }
  });

  test("zero overhead buffer allows maximum usage", () => {
    const result = selectModel(4, 0);
    expect(result.variant.quant).toBe("q8_0");
    expect(result.safeMemoryGB).toBe(4);
  });

  test("large overhead buffer can prevent any selection", () => {
    expect(() => selectModel(2, 0.9)).toThrow("Insufficient memory");
  });
});

describe("deriveBatchLimits", () => {
  test("scales up with more memory", () => {
    const small = deriveBatchLimits(4);
    const large = deriveBatchLimits(16);
    expect(large.batchMaxChars).toBeGreaterThan(small.batchMaxChars);
    expect(large.batchSize).toBeGreaterThan(small.batchSize);
  });

  test("batchSize is always between 1 and 256", () => {
    for (const gb of [1, 4, 8, 16, 32, 64]) {
      const { batchSize } = deriveBatchLimits(gb);
      expect(batchSize).toBeGreaterThanOrEqual(1);
      expect(batchSize).toBeLessThanOrEqual(256);
    }
  });

  test("batchMaxChars is always positive", () => {
    expect(deriveBatchLimits(0).batchMaxChars).toBeGreaterThan(0);
    expect(deriveBatchLimits(0.5).batchMaxChars).toBeGreaterThan(0);
  });

  test("batchSize is consistent with batchMaxChars (size ≈ chars / 2000)", () => {
    const { batchSize, batchMaxChars } = deriveBatchLimits(8);
    // batchSize should be roughly batchMaxChars / 2000, capped at 256
    const expected = Math.min(256, Math.round(batchMaxChars / 2_000));
    expect(batchSize).toBe(expected);
  });

  test("caps batchSize at 256 for very large memory", () => {
    expect(deriveBatchLimits(128).batchSize).toBe(256);
  });

  test("floors budget at 0.5 GB for tiny available memory", () => {
    const tiny = deriveBatchLimits(1);   // 1 - 3 = -2 → clamped to 0.5
    const floor = deriveBatchLimits(3.5); // 3.5 - 3 = 0.5 → same floor
    expect(tiny.batchMaxChars).toBe(floor.batchMaxChars);
  });
});
