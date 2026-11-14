import type { LiveEvent } from '@copilot/shared';

type Listener = (event: LiveEvent) => void;

/**
 * In-process fan-out of live events (snapshots, alerts, status) to SSE subscribers.
 * Holds no history: only the current listeners, each removed by the function `subscribe` returns.
 */
export class LiveBus {
  private listeners: Listener[] = [];

  /** Returns the unsubscribe function; calling it more than once is harmless. */
  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.push(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** Delivers to every current listener. A listener that throws is skipped; the others still receive the event. */
  publish(event: LiveEvent): void {
    for (const listener of this.listeners.slice()) {
      try {
        listener(event);
      } catch {
        // One failing subscriber (e.g. a broken SSE stream) must not stop the hub or the other subscribers.
      }
    }
  }

  listenerCount(): number {
    return this.listeners.length;
  }
}
