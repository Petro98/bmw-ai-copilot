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

/** Options of a claim. */
export interface ClaimOptions {
  /** ALLOW_VEHICLE_SOURCE_RESET: lets a demo start reset a database the car wrote. Off by default. */
  allowCarDataReset?: boolean;
}

/**
 * Thrown when a demo start meets a database the car wrote and ALLOW_VEHICLE_SOURCE_RESET is not set. Nothing in the
 * database has changed when it is thrown; the startup fails through the usual path (logged once, exit 1).
 */
export class VehicleSourceResetRefusedError extends Error {
  constructor() {
    super(
      'The database at DATABASE_PATH holds the car\'s data (VEHICLE_SOURCE=car), but this start uses the demo vehicle ' +
      '(VEHICLE_SOURCE=mock). Starting would delete the car\'s telemetry and clear its alerts, so nothing was changed. ' +
      'Start with VEHICLE_SOURCE=car, point DATABASE_PATH at another file for the demo, or set ' +
      'ALLOW_VEHICLE_SOURCE_RESET=1 to reset the car\'s data on purpose.',
    );
    this.name = 'VehicleSourceResetRefusedError';
  }
}

/**
 * Records which vehicle source the vehicle data in this database belongs to (migration 4) and, when the configured
 * source differs from the recorded one, resets what must not be mixed, in one transaction. The direction matters:
 * - demo -> car is automatic (demo data is worthless): every alert event is deleted, so no demonstration event ever
 *   appears in the car's history, and raw telemetry, daily roll-ups and the engine's saved state are deleted;
 * - car -> demo is refused with {@link VehicleSourceResetRefusedError} before anything changes, unless
 *   `allowCarDataReset` is set: then the car's active alerts are cleared at `now` (its history stays) and the
 *   telemetry, roll-ups and engine state are deleted.
 * Paired devices, settings, spend and dialog turns are kept; turns from before `since` are left out of the prompt by
 * the caller. Without this, demo alerts and demo trends would be presented as the real car's (or the reverse).
 */
export function claimVehicleSource(
  db: DatabaseSync, source: VehicleSource, now: number, options: ClaimOptions = {},
): SourceClaim {
  const row = db.prepare('SELECT source, since FROM vehicle_source WHERE id = 1').get() as
    { source: string; since: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO vehicle_source (id, source, since) VALUES (1, ?, ?)').run(source, now);
    return { source, previous: null, since: now, reset: false };
  }
  // A record other than 'car' (including the 'mock' one migration 4 writes for an older database) counts as demo.
  const previous: VehicleSource = row.source === 'car' ? 'car' : 'mock';
  if (previous === source) return { source, previous, since: Number(row.since), reset: false };
  if (previous === 'car' && options.allowCarDataReset !== true) throw new VehicleSourceResetRefusedError();

  db.exec('BEGIN');
  try {
    if (previous === 'mock') db.exec('DELETE FROM alert_events');
    else db.prepare('UPDATE alert_events SET active = 0, cleared_at = ? WHERE active = 1').run(now);
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
