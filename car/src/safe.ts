/**
 * One wrapper for every timer callback, signal handler and promise chain on the head unit: a failure
 * is logged and the app carries on. Nothing here ever throws or leaves a rejected promise behind.
 */

export interface Log { info(m: string): void; warn(m: string): void; error(m: string): void }

/** A label logs its first failure, then at most once per this many milliseconds. */
export const SAFE_LOG_INTERVAL_MS = 60_000;
/** Labels remembered at once (they are code literals; the cap only keeps the table bounded). */
const MAX_LABELS = 64;

/** label -> when its last failure was logged (epoch ms). Bounded by MAX_LABELS. */
let lastLogged: Record<string, number> = Object.create(null);
let labelCount = 0;

function describe(error: unknown): string {
  try {
    if (error instanceof Error) return error.stack || error.message || error.name;
    return String(error);
  } catch {
    return 'unprintable error';
  }
}

function report(log: Log, label: string, error: unknown): void {
  try {
    const now = Date.now();
    const last = lastLogged[label];
    if (last !== undefined && now >= last && now - last < SAFE_LOG_INTERVAL_MS) return;
    if (last === undefined) {
      if (labelCount >= MAX_LABELS) {
        lastLogged = Object.create(null);
        labelCount = 0;
      }
      labelCount++;
    }
    lastLogged[label] = now;
    log.error(label + ': ' + describe(error));
  } catch {
    // the log itself failed: nothing more can be done without risking a throw
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Wraps fn so that calling it never throws and never returns a rejected promise. A failure (a throw or
 * a rejection) is logged under `label`: the first one, then at most once a minute.
 */
export function safe<A extends unknown[]>(log: Log, label: string, fn: (...args: A) => unknown): (...args: A) => void {
  return (...args: A): void => {
    try {
      const result = fn(...args);
      if (isThenable(result)) {
        result.then(undefined, (error: unknown) => report(log, label, error));
      }
    } catch (error) {
      report(log, label, error);
    }
  };
}
