/** A fixed-capacity FIFO: pushing onto a full buffer drops the oldest item. Never grows past capacity. */
export class RingBuffer<T> {
  private readonly items: Array<T | undefined>;
  private readonly capacity: number;
  private head = 0; // index of the oldest item
  private count = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity) || 1);
    this.items = new Array<T | undefined>(this.capacity);
  }

  push(item: T): void {
    const tail = (this.head + this.count) % this.capacity;
    this.items[tail] = item;
    if (this.count < this.capacity) this.count++;
    else this.head = (this.head + 1) % this.capacity; // overwrote the oldest
  }

  /** Removes and returns up to `max` items, oldest first. */
  drain(max: number): T[] {
    const n = Math.min(this.count, Math.max(0, Math.floor(max) || 0));
    const out: T[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.items[this.head] as T);
      this.items[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }
    return out;
  }

  /**
   * Puts items (oldest first) back in front of what the buffer holds, e.g. a batch that failed to send.
   * When that exceeds the capacity the oldest are dropped, so the newest `capacity` items remain.
   */
  pushFront(items: ReadonlyArray<T>): void {
    for (let i = items.length - 1; i >= 0; i--) {
      if (this.count >= this.capacity) return; // everything older than this is dropped
      this.head = (this.head - 1 + this.capacity) % this.capacity;
      this.items[this.head] = items[i];
      this.count++;
    }
  }

  size(): number {
    return this.count;
  }
}
