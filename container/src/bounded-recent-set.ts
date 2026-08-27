/**
 * A bounded FIFO set for collapsing stream/catch-up overlap. Durable duplicate
 * suppression remains in D1; this structure only protects one child lifetime.
 */
export class BoundedRecentSet {
  private readonly values = new Map<string, true>();

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('BoundedRecentSet capacity must be a positive integer');
    }
  }

  /** Returns true when already present; otherwise records the value. */
  checkAndAdd(value: string): boolean {
    if (this.values.has(value)) return true;
    this.values.set(value, true);
    if (this.values.size > this.capacity) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    return false;
  }

  has(value: string): boolean {
    return this.values.has(value);
  }

  get size(): number {
    return this.values.size;
  }
}
