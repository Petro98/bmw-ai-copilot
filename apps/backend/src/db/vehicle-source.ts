import type { DatabaseSync } from 'node:sqlite';

export type VehicleSource = 'mock' | 'car';

/** The outcome of claiming the database for a vehicle source at startup. */
export interface SourceClaim {
  source: VehicleSource;
  /** The source recorded before this claim; null when none was recorded. */
  previous: VehicleSource | null;
  /** When the current source began writing vehicle data here. Dialog turns before it are left out of the prompt. */
  since: number;
  /** True when the source changed and the vehicle data of the previous one was reset. */
  reset: boolean;
}

/**
 * Records which vehicle source the vehicle data in this database belongs to (migration 4) and, when the configured
 * source differs from the recorded one, resets what must not be mixed, in one transaction: active alerts are cleared
 * at `now`, raw telemetry, daily roll-ups and the engine's saved state are deleted. Paired devices, settings, spend
 * and dialog turns are kept; turns from before `since` are left out of the prompt by the caller.
 * Without this, demo alerts and demo trends would be presented as the real car's (or the reverse).
 */
export function claimVehicleSource(db: DatabaseSync, source: VehicleSource, now: number): SourceClaim {
  const row = db.prepare('SELECT source, since FROM vehicle_source WHERE id = 1').get() as
    { source: string; since: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO vehicle_source (id, source, since) VALUES (1, ?, ?)').run(source, now);
    return { source, previous: null, since: now, reset: false };
  }
  const previous: VehicleSource = row.source === 'car' ? 'car' : 'mock';
  if (row.source === source) return { source, previous, since: Number(row.since), reset: false };

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE alert_events SET active = 0, cleared_at = ? WHERE active = 1').run(now);
    db.exec('DELETE FROM telemetry_samples');
    db.exec('DELETE FROM telemetry_daily');
    db.exec('DELETE FROM engine_state');
    db.prepare('UPDATE vehicle_source SET source = ?, since = ? WHERE id = 1').run(source, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { source, previous, since: now, reset: true };
}
