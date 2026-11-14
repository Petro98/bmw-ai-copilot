import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Reading, VehicleSnapshot } from '@copilot/vehicle-core';

export type TelemetryKey = 'oilTemp' | 'coolantTemp' | 'battery12vCharge' | 'fuelLevel' | 'range' | 'odometer' | 'speed' | 'engineRpm';
export interface TelemetrySample { at: number; values: Partial<Record<TelemetryKey, number>> }
export interface DailySummary { day: string; values: Partial<Record<TelemetryKey, { min: number; max: number; avg: number }>> }

/** Column of `telemetry_samples` for each key. Fixed constants: the only identifiers ever placed into SQL text. */
const COLUMNS: Readonly<Record<TelemetryKey, string>> = {
  oilTemp: 'oil_temp',
  coolantTemp: 'coolant_temp',
  battery12vCharge: 'battery12v_charge',
  fuelLevel: 'fuel_level',
  range: 'range',
  odometer: 'odometer',
  speed: 'speed',
  engineRpm: 'engine_rpm',
};
const KEYS = Object.keys(COLUMNS) as TelemetryKey[];
const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A telemetry sample from a snapshot: only readings that are available and hold a finite number. Never a default. */
export function sampleFromSnapshot(snapshot: VehicleSnapshot): TelemetrySample {
  const values: Partial<Record<TelemetryKey, number>> = {};
  for (const key of KEYS) {
    const reading: Reading<number> = snapshot[key];
    if (reading.available && typeof reading.value === 'number' && Number.isFinite(reading.value)) values[key] = reading.value;
  }
  return { at: snapshot.takenAt, values };
}

/** Raw samples (pruned after the retention period) and per-day roll-ups (kept). Days are UTC 'YYYY-MM-DD'. */
export class TelemetryStore {
  private readonly insert: StatementSync;
  private readonly aggregate: StatementSync;
  private readonly upsertDaily: StatementSync;
  private readonly recentDays: StatementSync;
  private readonly dailyRows: StatementSync;
  private readonly deleteOlder: StatementSync;

  constructor(db: DatabaseSync) {
    const columns = KEYS.map((key) => COLUMNS[key]);
    this.insert = db.prepare(
      `INSERT INTO telemetry_samples (at, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`,
    );
    this.aggregate = db.prepare(
      `SELECT ${columns.map((c) => `MIN(${c}) AS ${c}_min, MAX(${c}) AS ${c}_max, AVG(${c}) AS ${c}_avg, COUNT(${c}) AS ${c}_count`).join(', ')}
       FROM telemetry_samples WHERE at >= ? AND at < ?`,
    );
    this.upsertDaily = db.prepare(
      `INSERT INTO telemetry_daily (day, key, min, max, avg, count) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, key) DO UPDATE SET
         min = excluded.min, max = excluded.max, avg = excluded.avg, count = excluded.count`,
    );
    this.recentDays = db.prepare('SELECT DISTINCT day FROM telemetry_daily ORDER BY day DESC LIMIT ?');
    this.dailyRows = db.prepare('SELECT day, key, min, max, avg FROM telemetry_daily WHERE day >= ? ORDER BY day ASC, key ASC');
    this.deleteOlder = db.prepare('DELETE FROM telemetry_samples WHERE at < ?');
  }

  addSample(sample: TelemetrySample): void {
    this.insert.run(sample.at, ...KEYS.map((key) => finiteOrNull(sample.values[key])));
  }

  /**
   * Min / max / avg / count per key over the raw samples of one UTC day, into `telemetry_daily`.
   * A key with no samples that day leaves an existing roll-up untouched (raw samples may already be pruned).
   */
  rollUpDay(day: string): void {
    const start = DAY_PATTERN.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
    if (!Number.isFinite(start)) throw new RangeError(`Not a UTC day (YYYY-MM-DD): ${day}`);
    const row = this.aggregate.get(start, start + DAY_MS) as Record<string, unknown>;
    for (const key of KEYS) {
      const c = COLUMNS[key];
      const count = Number(row[`${c}_count`]);
      if (count > 0) {
        this.upsertDaily.run(day, key, Number(row[`${c}_min`]), Number(row[`${c}_max`]), Number(row[`${c}_avg`]), count);
      }
    }
  }

  /** The most recent `days` rolled-up days, oldest first. */
  dailySummaries(days: number): DailySummary[] {
    const n = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
    if (n === 0) return [];
    const newest = this.recentDays.all(n);
    if (newest.length === 0) return [];
    const oldestDay = String(newest[newest.length - 1].day);
    const summaries: DailySummary[] = [];
    for (const row of this.dailyRows.all(oldestDay)) {
      const day = String(row.day);
      let summary = summaries[summaries.length - 1];
      if (!summary || summary.day !== day) {
        summary = { day, values: {} };
        summaries.push(summary);
      }
      summary.values[row.key as TelemetryKey] = { min: Number(row.min), max: Number(row.max), avg: Number(row.avg) };
    }
    return summaries;
  }

  /** Deletes raw samples taken before `now - olderThanDays` days; roll-ups are kept. Returns the rows deleted. */
  prune(olderThanDays: number, now: number): number {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0 || !Number.isFinite(now)) return 0;
    return Number(this.deleteOlder.run(now - olderThanDays * DAY_MS).changes);
  }
}
