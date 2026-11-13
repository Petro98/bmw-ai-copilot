import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NO_LIMITS, type AlertEvent } from '@copilot/event-engine';
import type { DialogTurn, SettingsDto } from '@copilot/shared';
import { available, emptySnapshot, unavailable } from '@copilot/vehicle-core';
import { openDatabase } from '../db/database';
import { applyMigrations } from '../db/migrations';
import { AlertStore } from './alert-store';
import { DialogStore } from './dialog-store';
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
});
