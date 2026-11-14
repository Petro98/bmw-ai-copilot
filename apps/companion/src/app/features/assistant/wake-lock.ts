/** The part of `WakeLockSentinel` this helper uses. */
export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
}

/** The part of `navigator` this helper uses (Screen Wake Lock API). */
export interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

/** The part of `document` this helper uses. */
export interface WakeLockDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Keeps the phone's screen on while the assistant page is visible (the phone sits in a mount while driving). The
 * browser drops the lock whenever the page is hidden, so it is requested again on `visibilitychange`. A browser
 * without the API, or one that refuses the request, is ignored silently.
 */
export class ScreenWakeLock {
  private active = false;
  private requesting = false;
  private sentinel: WakeLockSentinelLike | null = null;
  private readonly onVisibility = () => this.request();

  constructor(private readonly doc: WakeLockDocument, private readonly nav: WakeLockNavigator | undefined) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    try {
      this.doc.addEventListener('visibilitychange', this.onVisibility);
    } catch {
      // Without the event the lock is requested once only.
    }
    this.request();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    try {
      this.doc.removeEventListener('visibilitychange', this.onVisibility);
    } catch {
      // Nothing to remove.
    }
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel && !sentinel.released) sentinel.release().catch(() => undefined);
  }

  private request(): void {
    const wakeLock = this.nav?.wakeLock;
    if (!this.active || !wakeLock || this.requesting || this.doc.visibilityState !== 'visible') return;
    if (this.sentinel && !this.sentinel.released) return;
    this.requesting = true;
    let pending: Promise<WakeLockSentinelLike>;
    try {
      pending = wakeLock.request('screen');
    } catch {
      this.requesting = false;
      return;
    }
    pending.then(
      (sentinel) => {
        this.requesting = false;
        if (this.active) this.sentinel = sentinel;
        else sentinel.release().catch(() => undefined);
      },
      () => { this.requesting = false; },
    );
  }
}
