import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { EngineState } from '@copilot/event-engine';
import {
  available, emptySnapshot,
  type TimerApi, type VehicleCapabilities, type VehicleDataProvider, type VehicleSnapshot,
} from '@copilot/vehicle-core';
import { openDatabase } from '../db/database';
import { start } from '../main';
import { AlertStore } from './alert-store';
import { EngineStateStore } from './engine-state-store';

const SECOND = 1000;
const START = Date.UTC(2026, 10, 13, 10, 0, 0);   // 2026-11-13T10:00:00Z

function state(keys: Array<Partial<EngineState['keys'][number]>>): EngineState {
  return {
    keys: keys.map((key, i) => ({
      dedupKey: `cc:${i}`, ruleId: 'check-control', firstSeenAt: 1000, lastRaisedAt: null, active: false, ...key,
    })),
  };
}

describe('EngineStateStore', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = openDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  function corrupt(text: string): void {
    db.prepare('UPDATE engine_state SET state = ? WHERE id = 1').run(text);
  }

  test('an empty database has no saved state', () => {
    expect(new EngineStateStore(db).load()).toBeNull();
  });

  test('a saved state round-trips, also through a new store on the same database', () => {
    const saved = state([{ active: true, lastRaisedAt: 5000 }, { dedupKey: 'svc:1', ruleId: 'service' }]);
    new EngineStateStore(db).save(saved);
    expect(new EngineStateStore(db).load()).toEqual(saved);
  });

  test.each(['not json', '42', 'null', '{"keys":"many"}', '[]'])('an unreadable row %j loads as null', (text) => {
    new EngineStateStore(db).save(state([{}]));
    corrupt(text);
    expect(new EngineStateStore(db).load()).toBeNull();
  });

  test('a state is written only when the set of keys or their active flags changed', () => {
    const store = new EngineStateStore(db);
    store.save(state([{ firstSeenAt: 1000 }]));
    corrupt('marker');   // shows whether the next save writes

    store.save(state([{ firstSeenAt: 2000 }]));                            // same key, same flag: skipped
    expect(store.load()).toBeNull();

    const raised = state([{ firstSeenAt: 2000, active: true, lastRaisedAt: 6000 }]);
    store.save(raised);                                                   // active flag changed: written
    expect(store.load()).toEqual(raised);

    corrupt('marker');
    const twoKeys = state([{ firstSeenAt: 2000, active: true, lastRaisedAt: 6000 }, { dedupKey: 'cc:9' }]);
    store.save(twoKeys);                                                  // a key appeared: written
    expect(store.load()).toEqual(twoKeys);
  });
});

/** A read-only fake vehicle with a standing BMW Check Control message, driven by `emit()`. */
class StandingCheckControl implements VehicleDataProvider {
  private listeners: Array<(snapshot: VehicleSnapshot) => void> = [];
  private current: VehicleSnapshot;
  constructor(private readonly clock: { now(): number }) { this.current = this.build(); }
  start(): Promise<void> { return Promise.resolve(); }
  stop(): Promise<void> { return Promise.resolve(); }
  snapshot(): VehicleSnapshot { return this.current; }
  onChange(listener: (snapshot: VehicleSnapshot) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }
  capabilities(): VehicleCapabilities { return { delivers: ['checkControl'], diagnosticsEnabled: false }; }
  emit(): void {
    this.current = this.build();
    for (const listener of this.listeners.slice()) listener(this.current);
  }
  private build(): VehicleSnapshot {
    const now = this.clock.now();
    return {
      ...emptySnapshot(now),
      checkControl: available([{ id: 39, text: 'Температура двигуна', severity: 'critical' as const, since: START }], null, 'mock', now),
    };
  }
}

describe('engine state across a backend restart', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'copilot-engine-state-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('a restart with a standing Check Control message keeps the same alert id and raises nothing new', async () => {
    const databasePath = join(dir, 'copilot.sqlite');
    const env = { DATABASE_PATH: databasePath, PORT: '0', LOG_LEVEL: 'silent' };
    const clock = { t: START, now(): number { return this.t; } };
    const timers: TimerApi = { setInterval: () => null, clearInterval: () => undefined };
    const run = (provider: StandingCheckControl, seconds: number): void => {
      for (let i = 0; i < seconds; i++) {
        clock.t += SECOND;
        provider.emit();
      }
    };

    const first = new StandingCheckControl(clock);
    const firstRun = await start(env, { clock, timers, provider: first });
    run(first, 10);   // past the rule's 4 s dwell
    await firstRun.close();

    const readAlerts = () => {
      const db = openDatabase(databasePath);
      try { return new AlertStore(db).recent(50); } finally { db.close(); }
    };
    const before = readAlerts();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ ruleId: 'check-control', dedupKey: 'cc:39', active: true });

    clock.t += 30 * SECOND;   // the backend was down for half a minute
    const second = new StandingCheckControl(clock);
    const secondRun = await start(env, { clock, timers, provider: second });
    run(second, 20);
    await secondRun.close();

    const after = readAlerts();
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before[0]);   // same id, still active
  });
});
