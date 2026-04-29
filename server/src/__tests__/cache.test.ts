import { describe, test, expect } from "bun:test";
import { LRUEmbeddingCache } from "../embeddings/cache.js";

describe("LRUEmbeddingCache", () => {
  test("set and get", () => {
    const cache = new LRUEmbeddingCache(4);
    cache.set("a", [1, 2, 3]);
    const val = cache.get("a");
    expect(val).toEqual([1, 2, 3]);
  });

  test("get returns undefined for missing key", () => {
    const cache = new LRUEmbeddingCache(4);
    expect(cache.get("missing")).toBeUndefined();
  });

  test("evicts oldest entry when at capacity", () => {
    const cache = new LRUEmbeddingCache(2);
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.set("c", [3]); // evicts "a"

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual([2]);
    expect(cache.get("c")).toEqual([3]);
    expect(cache.size).toBe(2);
  });

  test("access refreshes recency", () => {
    const cache = new LRUEmbeddingCache(3);
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.set("c", [3]);

    cache.get("a"); // refresh "a" — now "b" is oldest
    cache.set("d", [4]); // evicts "b"

    expect(cache.get("a")).toEqual([1]); // survived
    expect(cache.get("b")).toBeUndefined(); // evicted
    expect(cache.get("c")).toEqual([3]);
    expect(cache.get("d")).toEqual([4]);
  });

  test("overwrite updates value without increasing size", () => {
    const cache = new LRUEmbeddingCache(4);
    cache.set("x", [1]);
    cache.set("x", [2]);

    expect(cache.get("x")).toEqual([2]);
    expect(cache.size).toBe(1);
  });

  test("clear empties the cache", () => {
    const cache = new LRUEmbeddingCache(4);
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  test("zero-size cache rejects all entries", () => {
    const cache = new LRUEmbeddingCache(0);
    cache.set("a", [1]);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("size tracks current entries", () => {
    const cache = new LRUEmbeddingCache(10);
    expect(cache.size).toBe(0);
    cache.set("a", [1]);
    expect(cache.size).toBe(1);
    cache.set("b", [2]);
    expect(cache.size).toBe(2);
    cache.get("a"); // doesn't change size
    expect(cache.size).toBe(2);
  });

  test("handles large vectors (4096 floats)", () => {
    const cache = new LRUEmbeddingCache(64);
    const bigVec = Array(4096).fill(0.5);
    cache.set("q", bigVec);
    const result = cache.get("q");
    expect(result!.length).toBe(4096);
    expect(result![0]).toBe(0.5);
  });
});
