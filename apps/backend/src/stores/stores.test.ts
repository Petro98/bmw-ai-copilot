import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NO_LIMITS, type AlertEvent } from '@copilot/event-engine';
import type { DialogTurn, SettingsDto } from '@copilot/shared';
import { available, emptySnapshot, unavailable } from '@copilot/vehicle-core';
import { DATABASE_BUSY_TIMEOUT_MS, openDatabase } from '../db/database';
import { MIGRATIONS, applyMigrations } from '../db/migrations';
import { claimVehicleSource } from '../db/vehicle-source';
import { AlertStore, MAX_CLEARED_ALERTS } from './alert-store';
import { DialogStore, MAX_DIALOG_TURNS } from './dialog-store';
import { SettingsStore } from './settings-store';
import { sampleFromSnapshot, TelemetryStore } from './telemetry-store';
import { SqliteUsageStore } from './usage-store';

const DAY_MS = 86_400_000;
const NOV_12 = Date.UTC(2026, 10, 12);   // 2026-11-12T00:00:00Z
const NOV_13 = Date.UTC(2026, 10, 13);

function turn(id: string, at: number): DialogTurn {
  return {
    id, at, question: `q-${id}`, answer: `a-${id}`,
    style: 'full', source: 'panel', model: 'mock', snapshotAt: at - 1,
  };
}

function alert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'oil-temp:oil:1000', ruleId: 'oil-temp', dedupKey: 'oil', provenance: 'owner-configured',
    severity: 'warning', title: 'Oil temperature above your limit', detail: null,
    at: 1000, active: true, clearedAt: null,
    ...overrides,
  };
}

describe('stores (in-memory database)', () => {
  let db: DatabaseSync;

  beforeEach(() => { db = openDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  test('settings default to no limits, pop-ups on, diagnostics off', () => {
    expect(new SettingsStore(db).get()).toEqual({ ownerLimits: NO_LIMITS, popupsEnabled: true, diagnosticsEnabled: false });
  });

  test('settings round-trip and reject nothing they did not validate (validation lives in the HTTP layer)', () => {
    const store = new SettingsStore(db);
    const next: SettingsDto = {
      ownerLimits: { oilTempMaxC: 125.5, coolantTempMaxC: null, battery12vMinPercent: 40, tyrePressureDeviationBar: 0.3 },
      popupsEnabled: false,
      diagnosticsEnabled: true,
    };
    expect(store.set(next)).toEqual(next);
    expect(new SettingsStore(db).get()).toEqual(next);

    const back: SettingsDto = { ownerLimits: { ...NO_LIMITS }, popupsEnabled: true, diagnosticsEnabled: false };
    expect(store.set(back)).toEqual(back);
    expect(store.get()).toEqual(back);
  });

  test('dialog turns come back newest first; lastTurns is oldest first', () => {
    const store = new DialogStore(db);
    store.add(turn('a', 100));
    store.add(turn('b', 200));
    store.add(turn('c', 300));
    expect(store.recent(2).map((t) => t.id)).toEqual(['c', 'b']);
    expect(store.recent(10)).toEqual([turn('c', 300), turn('b', 200), turn('a', 100)]);
    expect(store.lastTurns(2).map((t) => t.id)).toEqual(['b', 'c']);
    expect(store.recent(0)).toEqual([]);
    expect(store.lastTurns(-1)).toEqual([]);
    expect(store.recent(Number.NaN)).toEqual([]);
  });

  test('lastTurns with a start time leaves out older turns and still returns up to n', () => {
    const store = new DialogStore(db);
    for (const [id, at] of [['a', 100], ['b', 200], ['c', 300], ['d', 400]] as const) store.add(turn(id, at));
    expect(store.lastTurns(2, 300).map((t) => t.id)).toEqual(['c', 'd']);
    expect(store.lastTurns(10, 250).map((t) => t.id)).toEqual(['c', 'd']);
    expect(store.lastTurns(10, 500)).toEqual([]);
    expect(store.lastTurns(10).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  test(`the dialog keeps at most ${MAX_DIALOG_TURNS} turns, dropping the oldest`, () => {
    const store = new DialogStore(db);
    for (let i = 0; i < MAX_DIALOG_TURNS + 5; i++) store.add(turn(`t${i}`, 1000 + i));
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM dialog_turns').get()?.n)).toBe(MAX_DIALOG_TURNS);
    expect(store.recent(1)[0].id).toBe(`t${MAX_DIALOG_TURNS + 4}`);
    expect(store.lastTurns(MAX_DIALOG_TURNS)[0].id).toBe('t5');
  });

  test('clearActive clears every active alert at the given time and returns them; cleared ones stay as they were', () => {
    const store = new AlertStore(db);
    store.upsert(alert({ id: 'a', at: 1000 }));
    store.upsert(alert({ id: 'b', at: 2000, dedupKey: 'b' }));
    store.upsert(alert({ id: 'c', at: 500, active: false, clearedAt: 900 }));
    const cleared = store.clearActive(5000);
    expect(cleared.map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect(cleared.every((e) => !e.active && e.clearedAt === 5000)).toBe(true);
    expect(store.active()).toEqual([]);
    expect(store.get('c')).toEqual(alert({ id: 'c', at: 500, active: false, clearedAt: 900 }));
    expect(store.clearActive(6000)).toEqual([]);
  });

  test(`alert history keeps at most ${MAX_CLEARED_ALERTS} cleared events; active ones are never dropped`, () => {
    const store = new AlertStore(db);
    store.upsert(alert({ id: 'standing', at: 1 }));
    for (let i = 0; i < MAX_CLEARED_ALERTS + 3; i++) {
      store.upsert(alert({ id: `x${i}`, dedupKey: `k${i}`, at: 10 + i, active: false, clearedAt: 20 + i }));
    }
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM alert_events WHERE active = 0').get()?.n)).toBe(MAX_CLEARED_ALERTS);
    expect(store.get('x0')).toBeNull();
    expect(store.get('x3')).not.toBeNull();
    expect(store.active().map((e) => e.id)).toEqual(['standing']);
  });

  test('usage keeps the current and the previous month only', () => {
    const store = new SqliteUsageStore(db);
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    store.add('2026-09-30', 'm', usage, 1);
    store.add('2026-10-01', 'm', usage, 2);
    store.add('2026-11-13', 'm', usage, 4);
    expect(store.usdForMonth('2026-09')).toBe(0);
    expect(store.usdForMonth('2026-10')).toBe(2);
    expect(store.usdForMonth('2026-11')).toBe(4);
    store.add('2027-01-02', 'm', usage, 8);   // across a year: December and January stay
    expect(store.usdForMonth('2026-11')).toBe(0);
    expect(store.usdForMonth('2027-01')).toBe(8);
  });

  test('upsert stores a raised event and then its cleared state under the same id', () => {
    const store = new AlertStore(db);
    const raised = alert();
    store.upsert(raised);
    expect(store.recent(10)).toEqual([raised]);
    expect(store.active()).toEqual([raised]);

    const cleared = { ...raised, active: false, clearedAt: 5000 };
    store.upsert(cleared);
    expect(store.recent(10)).toEqual([cleared]);
    expect(store.active()).toEqual([]);

    const later = alert({ id: 'cc:7:9000', ruleId: 'cc', dedupKey: '7', provenance: 'bmw-check-control', severity: 'critical', detail: 'detail', at: 9000 });
    store.upsert(later);
    expect(store.recent(10).map((e) => e.id)).toEqual(['cc:7:9000', 'oil-temp:oil:1000']);
    expect(store.recent(1)).toEqual([later]);
    expect(store.active()).toEqual([later]);
  });

  test('get finds an alert by id, however many newer alerts there are', () => {
    const store = new AlertStore(db);
    const old = alert({ active: false, clearedAt: 2000 });
    store.upsert(old);
    for (let i = 0; i < 250; i++) store.upsert(alert({ id: `cc:${i}:${10_000 + i}`, at: 10_000 + i, active: false, clearedAt: 20_000 }));
    expect(store.recent(200).some((e) => e.id === old.id)).toBe(false);
    expect(store.get(old.id)).toEqual(old);
    expect(store.get('cc:7:10007')).toEqual(alert({ id: 'cc:7:10007', at: 10_007, active: false, clearedAt: 20_000 }));
    expect(store.get('unknown')).toBeNull();
    expect(store.get('')).toBeNull();
    // The id is the primary key: the lookup is a key search, not a table scan.
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM alert_events WHERE id = ?').all('x')
      .map((row) => String((row as { detail: unknown }).detail));
    expect(plan.some((detail) => /USING (INDEX sqlite_autoindex_alert_events_1|PRIMARY KEY)/.test(detail))).toBe(true);
  });

  test('a sample keeps only available readings', () => {
    expect(sampleFromSnapshot(emptySnapshot(5)).values).toEqual({});
    const snapshot = {
      ...emptySnapshot(5),
      oilTemp: available(92, '°C', 'mock', 5),
      speed: available(0, 'km/h', 'mock', 5),
      coolantTemp: unavailable('stale'),
      fuelLevel: available(Number.NaN, 'l', 'mock', 5),
    };
    expect(sampleFromSnapshot(snapshot)).toEqual({ at: 5, values: { oilTemp: 92, speed: 0 } });
  });

  test('daily roll-up computes min, max and average and survives pruning of raw samples', () => {
    const store = new TelemetryStore(db);
    store.addSample({ at: NOV_12 + 1000, values: { oilTemp: 80, speed: 50 } });
    store.addSample({ at: NOV_12 + 2000, values: { oilTemp: 100 } });
    store.addSample({ at: NOV_12 + 3000, values: { oilTemp: 90, speed: 70 } });
    store.addSample({ at: NOV_13 + 1000, values: { oilTemp: 200 } });   // next day: not part of the roll-up

    store.rollUpDay('2026-11-12');
    const expected = [{ day: '2026-11-12', values: { oilTemp: { min: 80, max: 100, avg: 90 }, speed: { min: 50, max: 70, avg: 60 } } }];
    expect(store.dailySummaries(30)).toEqual(expected);

    expect(store.prune(0, NOV_13 + 5000)).toBe(4);
    expect(store.dailySummaries(30)).toEqual(expected);
    store.rollUpDay('2026-11-12');                                       // nothing left to roll up: the summary stays
    expect(store.dailySummaries(30)).toEqual(expected);
  });

  test('daily summaries are oldest first and limited to the most recent days', () => {
    const store = new TelemetryStore(db);
    for (let i = 0; i < 3; i++) store.addSample({ at: NOV_12 - (2 - i) * DAY_MS + 1, values: { range: 400 - i } });
    store.rollUpDay('2026-11-10');
    store.rollUpDay('2026-11-11');
    store.rollUpDay('2026-11-12');
    expect(store.dailySummaries(2).map((d) => d.day)).toEqual(['2026-11-11', '2026-11-12']);
    expect(store.dailySummaries(0)).toEqual([]);
  });

  test('prune deletes raw samples older than the retention and nothing newer', () => {
    const store = new TelemetryStore(db);
    const now = NOV_13;
    store.addSample({ at: now - 31 * DAY_MS, values: { odometer: 1 } });
    store.addSample({ at: now - 30 * DAY_MS - 1, values: { odometer: 2 } });
    store.addSample({ at: now - 30 * DAY_MS, values: { odometer: 3 } });
    store.addSample({ at: now - DAY_MS, values: { odometer: 4 } });
    expect(store.prune(30, now)).toBe(2);
    expect(store.prune(30, now)).toBe(0);
    store.rollUpDay('2026-10-14');                                       // the sample exactly at the cutoff is still there
    expect(store.dailySummaries(30)).toEqual([{ day: '2026-10-14', values: { odometer: { min: 3, max: 3, avg: 3 } } }]);
  });

  test('usage sums per UTC day and per month', () => {
    const store = new SqliteUsageStore(db);
    const usage = { inputTokens: 500, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0 };
    store.add('2026-11-12', 'claude-opus-5-5', usage, 0.25);
    store.add('2026-11-12', 'claude-haiku-5-5', usage, 0.5);
    store.add('2026-11-13', 'claude-opus-5-5', usage, 1);
    store.add('2026-10-31', 'claude-opus-5-5', usage, 4);
    expect(store.usdForDay('2026-11-12')).toBeCloseTo(0.75, 10);
    expect(store.usdForDay('2026-11-14')).toBe(0);
    expect(store.usdForMonth('2026-11')).toBeCloseTo(1.75, 10);
    expect(store.usdForMonth('2026-10')).toBeCloseTo(4, 10);
    expect(store.usdForMonth('2026-12')).toBe(0);
  });
});

describe('file database', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'copilot-stores-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('reopening a file database keeps the data and re-running migrations is harmless', () => {
    const path = join(dir, 'copilot.db');
    const first = openDatabase(path);
    expect(first.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    new DialogStore(first).add(turn('a', 100));
    new SettingsStore(first).set({ ownerLimits: { ...NO_LIMITS, oilTempMaxC: 120 }, popupsEnabled: false, diagnosticsEnabled: false });
    first.close();

    const second = openDatabase(path);
    applyMigrations(second);
    applyMigrations(second);
    expect(new DialogStore(second).recent(10)).toEqual([turn('a', 100)]);
    expect(new SettingsStore(second).get().ownerLimits.oilTempMaxC).toBe(120);
    second.close();
  });

  test('the database file is readable by its owner only and waits for a lock instead of failing at once', () => {
    const path = join(dir, 'copilot.db');
    const db = openDatabase(path);
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(Number(db.prepare('PRAGMA busy_timeout').get()?.timeout)).toBe(DATABASE_BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });
});

describe('vehicle source record (migration 4)', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'copilot-source-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** A database as the backend left it before migration 4. */
  function oldDatabase(path: string, fill: (db: DatabaseSync) => void): void {
    const db = new DatabaseSync(path);
    for (const sql of MIGRATIONS.slice(0, 3)) db.exec(sql);
    db.exec('PRAGMA user_version = 3');
    fill(db);
    db.close();
  }

  test('a database from before the migration that holds alerts or telemetry is recorded as mock since 0', () => {
    const path = join(dir, 'old.db');
    oldDatabase(path, (db) => { db.exec("INSERT INTO telemetry_daily VALUES ('2026-11-12', 'odometer', 1, 1, 1, 1)"); });
    const db = openDatabase(path);
    expect(db.prepare('SELECT source, since FROM vehicle_source').all()).toEqual([{ source: 'mock', since: 0 }]);
    db.close();
  });

  test('an empty database from before the migration has no record yet', () => {
    const path = join(dir, 'empty.db');
    oldDatabase(path, (db) => { db.exec("INSERT INTO devices VALUES ('d', 'l', 'h', 1, NULL)"); });
    const db = openDatabase(path);
    expect(db.prepare('SELECT * FROM vehicle_source').all()).toEqual([]);
    db.close();
  });

  test('claiming: the first claim records the source; the same source keeps its start; a change resets the vehicle data', () => {
    const db = openDatabase(':memory:');
    try {
      expect(claimVehicleSource(db, 'mock', 1000)).toEqual({ source: 'mock', previous: null, since: 1000, reset: false });
      expect(claimVehicleSource(db, 'mock', 2000)).toEqual({ source: 'mock', previous: 'mock', since: 1000, reset: false });

      const alerts = new AlertStore(db);
      alerts.upsert(alert({ id: 'active' }));
      alerts.upsert(alert({ id: 'old', dedupKey: 'old', active: false, clearedAt: 1500 }));
      const telemetry = new TelemetryStore(db);
      telemetry.addSample({ at: NOV_12, values: { odometer: 1 } });
      telemetry.rollUpDay('2026-11-12');
      db.exec(`INSERT INTO engine_state (id, state) VALUES (1, '{"keys":[]}')`);
      new DialogStore(db).add(turn('demo', 1500));
      new SettingsStore(db).set({ ownerLimits: { ...NO_LIMITS, oilTempMaxC: 120 }, popupsEnabled: false, diagnosticsEnabled: false });
      new SqliteUsageStore(db).add('2026-11-13', 'm', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0.5);
      db.exec("INSERT INTO devices VALUES ('d', 'l', 'h', 1, NULL)");

      expect(claimVehicleSource(db, 'car', 3000)).toEqual({ source: 'car', previous: 'mock', since: 3000, reset: true });
      expect(alerts.active()).toEqual([]);
      expect(alerts.get('active')).toEqual(alert({ id: 'active', active: false, clearedAt: 3000 }));
      expect(alerts.get('old')?.clearedAt).toBe(1500);
      expect(telemetry.dailySummaries(30)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM telemetry_samples').get()?.n).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM engine_state').get()?.n).toBe(0);
      // Kept: the dialog (left out of the prompt by its time), the owner's settings, the spend and the paired devices.
      expect(new DialogStore(db).recent(5).map((t) => t.id)).toEqual(['demo']);
      expect(new SettingsStore(db).get().ownerLimits.oilTempMaxC).toBe(120);
      expect(new SqliteUsageStore(db).usdForDay('2026-11-13')).toBe(0.5);
      expect(db.prepare('SELECT COUNT(*) AS n FROM devices').get()?.n).toBe(1);

      expect(claimVehicleSource(db, 'car', 4000)).toEqual({ source: 'car', previous: 'car', since: 3000, reset: false });
    } finally {
      db.close();
    }
  });
});
