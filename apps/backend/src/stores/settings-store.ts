import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { NO_LIMITS } from '@copilot/event-engine';
import type { SettingsDto } from '@copilot/shared';

type Row = Record<string, unknown>;

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * The owner's settings, one row. Validation lives in the HTTP layer (Task 13): this store keeps what it is given.
 * An empty database means no limits (every rule inert), pop-ups on, diagnostics off.
 */
export class SettingsStore {
  private readonly select: StatementSync;
  private readonly upsert: StatementSync;

  constructor(db: DatabaseSync) {
    this.select = db.prepare('SELECT * FROM settings WHERE id = 1');
    this.upsert = db.prepare(
      `INSERT INTO settings (id, oil_temp_max_c, coolant_temp_max_c, battery12v_min_percent, tyre_pressure_deviation_bar,
                             popups_enabled, diagnostics_enabled)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         oil_temp_max_c = excluded.oil_temp_max_c, coolant_temp_max_c = excluded.coolant_temp_max_c,
         battery12v_min_percent = excluded.battery12v_min_percent,
         tyre_pressure_deviation_bar = excluded.tyre_pressure_deviation_bar,
         popups_enabled = excluded.popups_enabled, diagnostics_enabled = excluded.diagnostics_enabled`,
    );
  }

  get(): SettingsDto {
    const row = this.select.get() as Row | undefined;
    if (!row) return { ownerLimits: { ...NO_LIMITS }, popupsEnabled: true, diagnosticsEnabled: false };
    return {
      ownerLimits: {
        oilTempMaxC: numberOrNull(row.oil_temp_max_c),
        coolantTempMaxC: numberOrNull(row.coolant_temp_max_c),
        battery12vMinPercent: numberOrNull(row.battery12v_min_percent),
        tyrePressureDeviationBar: numberOrNull(row.tyre_pressure_deviation_bar),
      },
      popupsEnabled: Number(row.popups_enabled) === 1,
      diagnosticsEnabled: Number(row.diagnostics_enabled) === 1,
    };
  }

  set(next: SettingsDto): SettingsDto {
    const limits = next.ownerLimits;
    this.upsert.run(
      limits.oilTempMaxC, limits.coolantTempMaxC, limits.battery12vMinPercent, limits.tyrePressureDeviationBar,
      next.popupsEnabled ? 1 : 0, next.diagnosticsEnabled ? 1 : 0,
    );
    return this.get();
  }
}
