import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NO_LIMITS, type AlertEvent } from '@copilot/event-engine';
import { AlertStore } from '../stores/alert-store';
import { DialogStore } from '../stores/dialog-store';
import { SettingsStore } from '../stores/settings-store';
import { TelemetryStore } from '../stores/telemetry-store';
import { SqliteUsageStore } from '../stores/usage-store';
import { openDatabase } from './database';
import { MIGRATIONS } from './migrations';
import { VehicleSourceResetRefusedError, claimVehicleSource } from './vehicle-source';

const NOV_12 = Date.UTC(2026, 10, 12);   // 2026-11-12T00:00:00Z

function alert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'oil-temp:oil:1000', ruleId: 'oil-temp', dedupKey: 'oil', provenance: 'owner-configured',
    severity: 'warning', title: 'Oil temperature above your limit', detail: null,
    at: 1000, active: true, clearedAt: null,
    ...overrides,
  };
}

/** Vehicle data and owner data as a run of either source leaves them. */
function fill(db: DatabaseSync): void {
  const alerts = new AlertStore(db);
  alerts.upsert(alert({ id: 'active' }));
  alerts.upsert(alert({ id: 'old', dedupKey: 'old', active: false, clearedAt: 1500 }));
  const telemetry = new TelemetryStore(db);
  telemetry.addSample({ at: NOV_12, values: { odometer: 1 } });
  telemetry.rollUpDay('2026-11-12');
  db.exec(`INSERT INTO engine_state (id, state) VALUES (1, '{"keys":[]}')`);
  new DialogStore(db).add({
    id: 'turn', at: 1500, question: 'q', answer: 'a', style: 'full', source: 'panel', model: 'mock', snapshotAt: 1499,
  });
  new SettingsStore(db).set({ ownerLimits: { ...NO_LIMITS, oilTempMaxC: 120 }, popupsEnabled: false, diagnosticsEnabled: false });
  new SqliteUsageStore(db).add('2026-11-13', 'm', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0.5);
  db.exec("INSERT INTO devices VALUES ('d', 'l', 'h', 1, NULL)");
}

/** Every row of every table, to prove that nothing changed. */
function everything(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
}

/** Paired devices, settings, spend and dialog turns survive every switch. */
function expectOwnerDataKept(db: DatabaseSync): void {
  expect(new DialogStore(db).recent(5).map((t) => t.id)).toEqual(['turn']);
  expect(new SettingsStore(db).get().ownerLimits.oilTempMaxC).toBe(120);
  expect(new SqliteUsageStore(db).usdForDay('2026-11-13')).toBe(0.5);
  expect(count(db, 'devices')).toBe(1);
}

describe('claimVehicleSource', () => {
  let db: DatabaseSync;

  beforeEach(() => { db = openDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  test('the same source twice changes nothing', () => {
    expect(claimVehicleSource(db, 'car', 1000)).toEqual({ source: 'car', previous: null, since: 1000, reset: false });
    fill(db);
    const before = everything(db);
    expect(claimVehicleSource(db, 'car', 2000)).toEqual({ source: 'car', previous: 'car', since: 1000, reset: false });
    expect(everything(db)).toEqual(before);
  });

  test('demo -> car deletes every alert event, the telemetry and the engine state, and keeps the owner data', () => {
    claimVehicleSource(db, 'mock', 1000);
    fill(db);
    expect(claimVehicleSource(db, 'car', 3000)).toEqual({ source: 'car', previous: 'mock', since: 3000, reset: true });
    // Demo events never reach the car's history, not even as cleared ones.
    expect(count(db, 'alert_events')).toBe(0);
    expect(count(db, 'telemetry_samples')).toBe(0);
    expect(count(db, 'telemetry_daily')).toBe(0);
    expect(count(db, 'engine_state')).toBe(0);
    expectOwnerDataKept(db);
    expect(db.prepare('SELECT source, since FROM vehicle_source').all()).toEqual([{ source: 'car', since: 3000 }]);
  });

  test("car -> demo is refused without ALLOW_VEHICLE_SOURCE_RESET and leaves every table untouched", () => {
    claimVehicleSource(db, 'car', 1000);
    fill(db);
    const before = everything(db);
    let error: unknown = null;
    try {
      claimVehicleSource(db, 'mock', 2000);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(VehicleSourceResetRefusedError);
    expect((error as Error).message).toMatch(/DATABASE_PATH/);
    expect((error as Error).message).toMatch(/ALLOW_VEHICLE_SOURCE_RESET=1/);
    expect((error as Error).message).toMatch(/VEHICLE_SOURCE=car/);
    expect(everything(db)).toEqual(before);
    expect(() => claimVehicleSource(db, 'mock', 2000, { allowCarDataReset: false })).toThrow(VehicleSourceResetRefusedError);
    expect(everything(db)).toEqual(before);
  });

  test("car -> demo with the reset allowed clears the car's active alerts, keeps its history and deletes its telemetry", () => {
    claimVehicleSource(db, 'car', 1000);
    fill(db);
    expect(claimVehicleSource(db, 'mock', 3000, { allowCarDataReset: true }))
      .toEqual({ source: 'mock', previous: 'car', since: 3000, reset: true });
    const alerts = new AlertStore(db);
    expect(alerts.active()).toEqual([]);
    expect(alerts.get('active')).toEqual(alert({ id: 'active', active: false, clearedAt: 3000 }));
    expect(alerts.get('old')?.clearedAt).toBe(1500);
    expect(count(db, 'telemetry_samples')).toBe(0);
    expect(count(db, 'telemetry_daily')).toBe(0);
    expect(count(db, 'engine_state')).toBe(0);
    expectOwnerDataKept(db);
  });
});

describe('claimVehicleSource on a database from before the source record', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'copilot-source-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('one that already holds rows counts as demo: the car takes it over without asking and removes the demo events', () => {
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    for (const sql of MIGRATIONS.slice(0, 3)) old.exec(sql);
    old.exec('PRAGMA user_version = 3');
    old.exec(`INSERT INTO alert_events VALUES ('cc:39:1', 'check-control', 'cc:39', 'bmw-check-control', 'critical',
      'demo', NULL, 1000, 1, NULL)`);
    old.close();

    const db = openDatabase(path);
    try {
      expect(claimVehicleSource(db, 'car', 2000)).toEqual({ source: 'car', previous: 'mock', since: 2000, reset: true });
      expect(count(db, 'alert_events')).toBe(0);
    } finally {
      db.close();
    }
  });
});
