export type Unit = 'rpm' | 'km/h' | '°C' | '°F' | 'l' | 'km' | 'mi' | '%' | 'bar' | 'psi' | 'kPa' | 'V';
export type ReadingSource = 'passive-signal' | 'polled-signal' | 'diagnostic-read' | 'mock';
export type UnavailableReason =
  | 'not-reported' | 'invalid-value' | 'not-on-this-vehicle' | 'diagnostics-disabled' | 'stale';

export interface Available<T> {
  readonly available: true; readonly value: T; readonly unit: Unit | null;
  readonly source: ReadingSource; readonly at: number;
}
export interface Unavailable { readonly available: false; readonly reason: UnavailableReason }

/** A vehicle value is either known (with unit, source and receive time) or unavailable with a reason. */
export type Reading<T> = Available<T> | Unavailable;

export function available<T>(value: T, unit: Unit | null, source: ReadingSource, at: number): Available<T> {
  return { available: true, value, unit, source, at };
}

export function unavailable(reason: UnavailableReason): Unavailable {
  return { available: false, reason };
}

/** Age of a reading in milliseconds: null when unavailable; never negative (head-unit clocks can jump backwards). */
export function ageMs(reading: Reading<unknown>, now: number): number | null {
  if (!reading.available) return null;
  const age = now - reading.at;
  return age > 0 ? age : 0;
}

/** The only "default" helper there is: a missing value becomes null, never a number. */
export function valueOr<T>(reading: Reading<T>, fallback: null): T | null {
  return reading.available ? reading.value : fallback;
}
