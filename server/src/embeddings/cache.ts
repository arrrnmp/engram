export class LRUEmbeddingCache {
  private map = new Map<string, number[]>();
  private readonly maxSize: number;

  constructor(maxSize = 64) {
    this.maxSize = maxSize;
  }

  get(key: string): number[] | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: number[]): void {
    if (this.maxSize === 0) return;
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxSize) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
