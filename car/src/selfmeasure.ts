/**
 * The app's own resource figures (spec §9 "Self-measurement: the app logs process.memoryUsage() and
 * process.cpuUsage() deltas at a low rate"): one log line at most every ten minutes, from the app's 1 Hz tick,
 * so nothing runs while the car is parked. Pure: the caller passes the time and the two readers.
 *
 *   self: rss=41MB heap=12MB cpu=0.6%
 *
 * rss and heap are now; cpu is the process's user + system CPU time over the window since the previous line, as
 * a share of one core's wall-clock time.
 */

/** The baseline of a measuring window: when it started and the CPU counters then (microseconds). */
export interface Sample { at: number; user: number; system: number }

/** At most one line per this long. */
export const SELF_MEASURE_INTERVAL_MS = 600_000;

const MB = 1024 * 1024;

function wholeMb(bytes: number): string {
  return typeof bytes === 'number' && isFinite(bytes) ? String(Math.round(bytes / MB)) : '?';
}

/**
 * The next sample and, at most once per SELF_MEASURE_INTERVAL_MS, the line to log. The first call (prev null)
 * and a clock that went back only take a new baseline; between lines neither reader is called.
 */
export function measure(
  prev: Sample | null,
  now: number,
  mem: () => { rss: number; heapUsed: number },
  cpu: () => { user: number; system: number },
): { sample: Sample; line: string | null } {
  if (prev === null || now < prev.at) {
    const c = cpu();
    return { sample: { at: now, user: c.user, system: c.system }, line: null };
  }
  if (now - prev.at < SELF_MEASURE_INTERVAL_MS) return { sample: prev, line: null };
  const c = cpu();
  const m = mem();
  const spentUs = (c.user - prev.user) + (c.system - prev.system);
  let share = (spentUs / 1000 / (now - prev.at)) * 100;
  if (!isFinite(share) || share < 0) share = 0;
  return {
    sample: { at: now, user: c.user, system: c.system },
    line: 'self: rss=' + wholeMb(m.rss) + 'MB heap=' + wholeMb(m.heapUsed) + 'MB cpu=' + share.toFixed(1) + '%',
  };
}
