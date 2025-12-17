export class DedupingQueue<T> {
  private readonly items: T[] = [];
  private readonly set = new Set<T>();

  enqueue(item: T): void {
    if (this.set.has(item)) return;
    this.items.push(item);
    this.set.add(item);
  }

  dequeue(): T | null {
    const value = this.items.shift();
    if (value === undefined) return null;
    this.set.delete(value);
    return value;
  }

  get size(): number {
    return this.items.length;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

