import { DestroyRef, InjectionToken, Signal, inject, signal } from '@angular/core';

/** The phone's clock; specs supply their own. */
export const CLOCK = new InjectionToken<() => number>('CLOCK', {
  providedIn: 'root',
  factory: () => () => Date.now(),
});

/**
 * The phone's current time as a signal, read again every `everyMs` until the caller is destroyed, so a view that
 * compares data with "now" changes as time passes and not only when new data arrives. Call in an injection context.
 */
export function currentTime(everyMs: number): Signal<number> {
  const read = inject(CLOCK);
  const time = signal(read());
  const timer = setInterval(() => time.set(read()), everyMs);
  inject(DestroyRef).onDestroy(() => clearInterval(timer));
  return time.asReadonly();
}
