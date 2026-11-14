import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEngine, NO_LIMITS, defaultEngineOptions, type AlertEvent } from '@copilot/event-engine';
import type { LiveEvent } from '@copilot/shared';
import { MockVehicleDataProvider, emptySnapshot, type ScenarioId, type TimerApi } from '@copilot/vehicle-core';
import { openDatabase } from '../db/database';
import { AlertStore } from '../stores/alert-store';
import { SettingsStore } from '../stores/settings-store';
import { TelemetryStore } from '../stores/telemetry-store';
import { LiveBus } from './live-bus';
import { VehicleHub } from './vehicle-hub';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 10, 13, 10, 0, 0);   // 2026-11-13T10:00:00Z

/** Timers that never fire: the tests drive the mock provider with tick() and setScenario(). */
const NO_TIMERS: TimerApi = { setInterval: () => null, clearInterval: () => undefined };

interface Rig {
  db: DatabaseSync;
  clock: { t: number; now(): number };
  provider: MockVehicleDataProvider;
  engine: EventEngine | null;
  alerts: AlertStore;
  telemetry: TelemetryStore;
  settings: SettingsStore;
  bus: LiveBus;
  events: LiveEvent[];
  hub: VehicleHub;
  /** Moves the clock forward by `ms` in steps of `stepMs`, ticking the provider after each step. */
  advance(ms: number, stepMs?: number): void;
  alertEvents(): AlertEvent[];
  snapshotEvents(): LiveEvent[];
  sampleCount(): number;
}

interface RigOptions {
  scenario?: ScenarioId; engine?: EventEngine | null; start?: number; db?: DatabaseSync;
  sampleIntervalMs?: number; retentionDays?: number;
}

function rig(options: RigOptions = {}): Rig {
  const db = options.db ?? openDatabase(':memory:');
  const clock = { t: options.start ?? START, now(): number { return this.t; } };
  const provider = new MockVehicleDataProvider({ clock, timers: NO_TIMERS, scenario: options.scenario ?? 'steady-cruise' });
  const engine = options.engine === undefined ? new EventEngine(defaultEngineOptions()) : options.engine;
  const alerts = new AlertStore(db);
  const telemetry = new TelemetryStore(db);
  const settings = new SettingsStore(db);
  const bus = new LiveBus();
  const events: LiveEvent[] = [];
  bus.subscribe((event) => { events.push(event); });
  const hub = new VehicleHub({
    provider, engine, alerts, telemetry, settings, bus, clock,
    sampleIntervalMs: options.sampleIntervalMs ?? MINUTE,
    retentionDays: options.retentionDays ?? 90,
  });
  return {
    db, clock, provider, engine, alerts, telemetry, settings, bus, events, hub,
    advance(ms: number, stepMs = SECOND): void {
      const end = clock.t + ms;
      while (clock.t < end) {
        clock.t = Math.min(end, clock.t + stepMs);
        provider.tick();
      }
    },
    alertEvents: () => events.flatMap((e) => (e.type === 'alert' ? [e.alert] : [])),
    snapshotEvents: () => events.filter((e) => e.type === 'snapshot'),
    sampleCount: () => Number((db.prepare('SELECT COUNT(*) AS n FROM telemetry_samples').get() as { n: number }).n),
  };
}

describe('LiveBus', () => {
  test('delivers to every listener, counts them and unsubscribes', () => {
    const bus = new LiveBus();
    const a: LiveEvent[] = [];
    const b: LiveEvent[] = [];
    const offA = bus.subscribe((e) => { a.push(e); });
    bus.subscribe((e) => { b.push(e); });
    expect(bus.listenerCount()).toBe(2);
    const event: LiveEvent = { type: 'snapshot', snapshot: emptySnapshot(START) };
    bus.publish(event);
    offA();
    offA();   // a second call is harmless
    expect(bus.listenerCount()).toBe(1);
    bus.publish(event);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });
});

describe('VehicleHub', () => {
  let r: Rig;

  afterEach(async () => {
    await r.hub.stop();
    r.db.close();
  });

  describe('with the default engine', () => {
    beforeEach(() => { r = rig({ scenario: 'overheat-check-control' }); });

    test('an overheating scenario ends as one stored and one published critical alert', async () => {
      await r.hub.start();
      r.advance(3 * MINUTE);
      const stored = r.alerts.recent(50);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ severity: 'critical', provenance: 'bmw-check-control', active: true, clearedAt: null });
      const published = r.alertEvents();
      expect(published).toHaveLength(1);
      expect(published[0]).toEqual(stored[0]);
      expect(r.alerts.active().map((a) => a.id)).toEqual([stored[0].id]);
    });

    test('snapshot events are throttled to one per second while alerts are published immediately', async () => {
      await r.hub.start();
      r.clock.t = START + 63 * SECOND;   // Check Control 39 is on from 60 s; dwell 4 s
      const perTick: LiveEvent[][] = [];
      for (let i = 0; i < 30; i++) {
        const before = r.events.length;
        r.clock.t += 300;
        r.provider.tick();
        perTick.push(r.events.slice(before));
      }
      const alertTick = perTick.findIndex((tick) => tick.some((e) => e.type === 'alert'));
      expect(alertTick).toBeGreaterThanOrEqual(0);
      // Raised at 67.5 s, half a second after the last snapshot event: the alert did not wait for the throttle.
      expect(perTick[alertTick].some((e) => e.type === 'snapshot')).toBe(false);
      expect(r.engine?.active()).toHaveLength(1);
      expect(r.alertEvents()).toHaveLength(1);
      const snapshots = r.snapshotEvents().map((e) => (e.type === 'snapshot' ? e.snapshot.takenAt : 0));
      // 30 changes over 9 s: at most one snapshot event per second.
      expect(snapshots.length).toBeLessThanOrEqual(10);
      expect(snapshots.length).toBeGreaterThanOrEqual(8);
      for (let i = 1; i < snapshots.length; i++) expect(snapshots[i] - snapshots[i - 1]).toBeGreaterThanOrEqual(SECOND);
      expect(r.hub.lastSnapshotAt()).toBe(r.clock.t);
    });

    test('changed owner limits apply to the very next evaluation', async () => {
      const evaluate = vi.spyOn(r.engine as EventEngine, 'evaluate');
      await r.hub.start();
      r.advance(SECOND);
      expect(evaluate.mock.lastCall?.[2]).toEqual(NO_LIMITS);
      const limits = { ...NO_LIMITS, coolantTempMaxC: 105 };
      r.settings.set({ ownerLimits: limits, popupsEnabled: true, diagnosticsEnabled: false });
      r.advance(SECOND);
      expect(evaluate.mock.lastCall?.[2]).toEqual(limits);
      expect(evaluate).toHaveBeenCalledTimes(2);
    });

    test('stop() unsubscribes: later provider changes have no effect', async () => {
      await r.hub.start();
      r.advance(2 * SECOND);
      const last = r.hub.lastSnapshotAt();
      const published = r.events.length;
      const samples = r.sampleCount();
      await r.hub.stop();
      r.advance(3 * MINUTE);
      expect(r.events).toHaveLength(published);
      expect(r.sampleCount()).toBe(samples);
      expect(r.hub.lastSnapshotAt()).toBe(last);
      expect(r.alerts.recent(50)).toEqual([]);
    });

    test('a listener that throws does not break the hub or other listeners', async () => {
      const others: LiveEvent[] = [];
      r.bus.subscribe(() => { throw new Error('listener failed'); });
      r.bus.subscribe((e) => { others.push(e); });
      await r.hub.start();
      r.advance(3 * MINUTE);
      expect(others.filter((e) => e.type === 'alert')).toHaveLength(1);
      expect(others.filter((e) => e.type === 'snapshot').length).toBeGreaterThan(100);
      expect(r.alerts.recent(50)).toHaveLength(1);
      expect(r.sampleCount()).toBe(3);
    });
  });

  test('telemetry is sampled once per interval, not once per change', async () => {
    r = rig({ sampleIntervalMs: MINUTE });
    await r.hub.start();
    r.advance(3 * MINUTE);   // 180 changes over 3 minutes
    expect(r.sampleCount()).toBe(3);
  });

  test('a day change rolls up yesterday and prunes old samples', async () => {
    const lateEvening = Date.UTC(2026, 10, 12, 23, 58, 0);
    r = rig({ start: lateEvening, retentionDays: 90 });
    await r.hub.start();
    r.advance(30 * SECOND, 30 * SECOND);   // 23:58:30: the run's first sample (and its once-per-run prune)
    r.telemetry.addSample({ at: lateEvening - 91 * DAY_MS, values: { oilTemp: 50 } });   // left for the day change
    r.advance(MINUTE, MINUTE);             // 23:59:30, same UTC day: sampled, nothing rolled up
    expect(r.telemetry.dailySummaries(5)).toEqual([]);
    expect(r.sampleCount()).toBe(3);
    r.advance(MINUTE, MINUTE);
    // 00:00:30 opened the new UTC day: 2026-11-12 is rolled up and the 91-day-old sample is gone.
    const days = r.telemetry.dailySummaries(5);
    expect(days.map((d) => d.day)).toEqual(['2026-11-12']);
    expect(days[0].values.oilTemp).toEqual({ min: 92, max: 92, avg: 92 });
    expect(r.sampleCount()).toBe(3);
  });

  describe('a day is rolled up even when a restart falls between its last sample and the next day', () => {
    const evening = Date.UTC(2026, 10, 12, 18, 0, 0);   // 2026-11-12T18:00:00Z
    const morning = Date.UTC(2026, 10, 13, 8, 0, 0);    // 2026-11-13T08:00:00Z

    test('stop() rolls up the day of the last sample', async () => {
      r = rig({ start: evening });
      await r.hub.start();
      r.advance(5 * MINUTE, MINUTE);
      expect(r.telemetry.dailySummaries(5)).toEqual([]);
      await r.hub.stop();
      const days = r.telemetry.dailySummaries(5);
      expect(days.map((d) => d.day)).toEqual(['2026-11-12']);
      expect(days[0].values.oilTemp).toEqual({ min: 92, max: 92, avg: 92 });
    });

    test('after a crash the first sample of the next day rolls up the day before it', async () => {
      const db = openDatabase(':memory:');
      const first = rig({ db, start: evening });
      await first.hub.start();
      first.advance(5 * MINUTE, MINUTE);   // never stopped: the process died

      r = rig({ db, start: morning });
      await r.hub.start();
      r.advance(MINUTE, MINUTE);
      const days = r.telemetry.dailySummaries(5);
      expect(days.map((d) => d.day)).toEqual(['2026-11-12']);
      expect(days[0].values.oilTemp).toEqual({ min: 92, max: 92, avg: 92 });
    });

    test('the restart roll-up leaves a day alone whose raw samples may already be pruned', async () => {
      const db = openDatabase(':memory:');
      const telemetry = new TelemetryStore(db);
      telemetry.addSample({ at: evening, values: { oilTemp: 80 } });
      telemetry.addSample({ at: evening + 4 * 3600 * SECOND, values: { oilTemp: 100 } });
      telemetry.rollUpDay('2026-11-12');
      telemetry.prune(1, morning + 12 * 3600 * SECOND);   // a previous run kept 1 day: the 18:00 sample is gone

      r = rig({ db, start: morning + 13 * 3600 * SECOND, retentionDays: 1 });
      await r.hub.start();
      r.advance(MINUTE, MINUTE);
      expect(r.telemetry.dailySummaries(5)[0]).toEqual({ day: '2026-11-12', values: { oilTemp: { min: 80, max: 100, avg: 90 } } });
    });

    test('runs that each last less than a day still prune samples older than the retention', async () => {
      const db = openDatabase(':memory:');
      const firstDay = Date.UTC(2026, 10, 1, 10, 0, 0);   // 2026-11-01T10:00:00Z
      for (let i = 0; i < 6; i++) {
        if (i > 0) await r.hub.stop();                  // a clean stop every day: no run sees a day change
        r = rig({ db, start: firstDay + i * DAY_MS, retentionDays: 2 });
        await r.hub.start();
        r.advance(10 * MINUTE, MINUTE);                 // 10 samples, 10:01 to 10:10
      }
      // The last run's first sample (2026-11-06T10:01Z) pruned everything before 2026-11-04T10:01Z.
      const oldest = Number((db.prepare('SELECT MIN(at) AS at FROM telemetry_samples').get() as { at: number }).at);
      expect(oldest).toBe(firstDay + 3 * DAY_MS + MINUTE);
      expect(r.sampleCount()).toBe(30);
      await r.hub.stop();
      // Roll-ups are kept for every day, including those whose raw samples are gone.
      expect(r.telemetry.dailySummaries(10).map((d) => d.day))
        .toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
    });
  });

  test('with engine null nothing is evaluated and ingestAlert persists and publishes', async () => {
    r = rig({ scenario: 'overheat-check-control', engine: null });
    await r.hub.start();
    r.advance(3 * MINUTE);
    expect(r.alerts.recent(50)).toEqual([]);
    expect(r.alertEvents()).toEqual([]);
    expect(r.snapshotEvents().length).toBeGreaterThan(100);
    const event: AlertEvent = {
      id: 'check-control:cc:39:1000', ruleId: 'check-control', dedupKey: 'cc:39', provenance: 'bmw-check-control',
      severity: 'critical', title: 'Температура двигуна. Обережно зупиніться', detail: null,
      at: 1000, active: true, clearedAt: null,
    };
    r.hub.ingestAlert(event);
    expect(r.alerts.recent(50)).toEqual([event]);
    expect(r.alertEvents()).toEqual([event]);
    r.hub.ingestAlert({ ...event, active: false, clearedAt: 2000 });
    expect(r.alerts.recent(50)).toEqual([{ ...event, active: false, clearedAt: 2000 }]);
    expect(r.alertEvents()).toHaveLength(2);
  });

  test('ingestAlert applies only the state of a known id, keeps its content and skips repeats', async () => {
    r = rig({ engine: null });
    await r.hub.start();
    const event: AlertEvent = {
      id: 'owner-limit:oil:1000', ruleId: 'owner-limit', dedupKey: 'oil', provenance: 'owner-configured',
      severity: 'warning', title: 'Температура масла вище вашого ліміту', detail: null,
      at: 1000, active: true, clearedAt: null,
    };
    expect(r.hub.ingestAlert(event)).toBe(true);
    expect(r.hub.ingestAlert(event)).toBe(false);
    // A clearing rebuilt by a restarted car: no content of its own.
    const rebuilt = { ...event, severity: 'info' as const, title: '', active: false, clearedAt: 2000 };
    expect(r.hub.ingestAlert(rebuilt)).toBe(true);
    expect(r.hub.ingestAlert({ ...rebuilt, clearedAt: 2500 })).toBe(false);
    expect(r.alerts.recent(10)).toEqual([{ ...event, active: false, clearedAt: 2000 }]);
    // Re-opened under the same id.
    expect(r.hub.ingestAlert({ ...event, at: 3000 })).toBe(true);
    expect(r.alerts.recent(10)).toEqual([event]);
    expect(r.alertEvents()).toEqual([event, { ...event, active: false, clearedAt: 2000 }, event]);
  });

  test('ingestAlert ignores what it cannot show: a clearing for an unknown id and a raise without a title', async () => {
    r = rig({ engine: null });
    await r.hub.start();
    const raise: AlertEvent = {
      id: 'owner-limit:oil:1000', ruleId: 'owner-limit', dedupKey: 'oil', provenance: 'owner-configured',
      severity: 'warning', title: 'Температура масла вище вашого ліміту', detail: null,
      at: 1000, active: true, clearedAt: null,
    };
    // A clearing a restarted car rebuilt for an alert whose raise it never uploaded.
    expect(r.hub.ingestAlert({ ...raise, severity: 'info', title: '', active: false, clearedAt: 2000 })).toBe(false);
    // A clearing with content for an unknown id is not stored either.
    expect(r.hub.ingestAlert({ ...raise, active: false, clearedAt: 2000 })).toBe(false);
    expect(r.hub.ingestAlert({ ...raise, title: '' })).toBe(false);
    expect(r.hub.ingestAlert({ ...raise, title: '  ' })).toBe(false);
    expect(r.alerts.recent(10)).toEqual([]);
    expect(r.alertEvents()).toEqual([]);
  });

  test('ingestAlert knows an alert older than the 200 most recent ones', async () => {
    r = rig({ engine: null });
    await r.hub.start();
    const old: AlertEvent = {
      id: 'service:3:due-soon:1000', ruleId: 'service', dedupKey: 'service:3:due-soon', provenance: 'bmw-service',
      severity: 'warning', title: 'Гальмівна рідина', detail: null, at: 1000, active: true, clearedAt: null,
    };
    expect(r.hub.ingestAlert(old)).toBe(true);
    expect(r.hub.ingestAlert({ ...old, active: false, clearedAt: 2000 })).toBe(true);
    for (let i = 0; i < 250; i++) {
      r.alerts.upsert({ ...old, id: `cc:${i}:${10_000 + i}`, ruleId: 'check-control', dedupKey: `cc:${i}`, at: 10_000 + i, active: false, clearedAt: 20_000 });
    }
    expect(r.alerts.recent(200).some((a) => a.id === old.id)).toBe(false);
    const published = r.alertEvents().length;

    // A rebuilt clearing of the old, already cleared alert is a repeat: its empty content does not overwrite the row.
    expect(r.hub.ingestAlert({ ...old, severity: 'info', title: '', active: false, clearedAt: 30_000 })).toBe(false);
    expect(r.alerts.get(old.id)).toEqual({ ...old, active: false, clearedAt: 2000 });
    // Re-opened under the old id: active again with the stored content, not the incoming one.
    expect(r.hub.ingestAlert({ ...old, title: 'інше', at: 40_000 })).toBe(true);
    expect(r.alerts.get(old.id)).toEqual(old);
    expect(r.alertEvents().slice(published)).toEqual([old]);
  });

  test('snapshot() is the provider snapshot and lastSnapshotAt is null before the first change', async () => {
    r = rig();
    expect(r.hub.lastSnapshotAt()).toBeNull();
    expect(r.hub.snapshot()).toBe(r.provider.snapshot());
    await r.hub.start();
    r.advance(SECOND);
    expect(r.hub.snapshot()).toBe(r.provider.snapshot());
    expect(r.hub.lastSnapshotAt()).toBe(START + SECOND);
  });

  test('a clock jumping backwards neither throws nor bursts', async () => {
    r = rig({ scenario: 'overheat-check-control' });
    await r.hub.start();
    r.advance(3 * MINUTE);
    const samples = r.sampleCount();
    const snapshots = r.snapshotEvents().length;
    r.clock.t -= 3 * DAY_MS;
    expect(() => r.advance(10 * SECOND)).not.toThrow();
    // One snapshot and one sample at the jump, then the normal pace resumes from the new time.
    expect(r.snapshotEvents().length - snapshots).toBeLessThanOrEqual(11);
    expect(r.sampleCount() - samples).toBe(1);
    // The mock holds the scenario at its start, so the Check Control message is gone: one clear, no new raise.
    expect(r.alertEvents().filter((a) => a.active)).toHaveLength(1);
    expect(r.alertEvents().length).toBeLessThanOrEqual(2);
  });

  describe('stored alert state agrees with the engine', () => {
    test('after a restart an alert whose condition is gone is cleared and published', async () => {
      const db = openDatabase(':memory:');
      const first = rig({ db, scenario: 'overheat-check-control' });
      await first.hub.start();
      first.advance(3 * MINUTE);
      const raised = first.alerts.active();
      expect(raised).toHaveLength(1);
      const saved = (first.engine as EventEngine).state();
      await first.hub.stop();

      const engine = new EventEngine(defaultEngineOptions());
      engine.restore(saved);
      r = rig({ db, engine, scenario: 'parked', start: first.clock.t + 10 * MINUTE });
      await r.hub.start();
      r.advance(SECOND);
      expect(r.alerts.active()).toEqual([]);
      const cleared = { ...raised[0], active: false, clearedAt: r.clock.t };
      expect(r.alerts.recent(50)).toEqual([cleared]);
      expect(r.alertEvents()).toEqual([cleared]);
      r.advance(10 * SECOND);
      expect(r.alertEvents()).toHaveLength(1);   // cleared once, not on every change
    });

    test('after a restart an alert whose reading is unknown stays active until the reading says it is gone', async () => {
      const db = openDatabase(':memory:');
      const first = rig({ db, scenario: 'overheat-check-control' });
      await first.hub.start();
      first.advance(3 * MINUTE);
      const raised = first.alerts.active();
      expect(raised).toHaveLength(1);
      const saved = (first.engine as EventEngine).state();
      await first.hub.stop();

      const engine = new EventEngine(defaultEngineOptions());
      engine.restore(saved);
      r = rig({ db, engine, scenario: 'signals-missing', start: first.clock.t + 15 * MINUTE });
      await r.hub.start();
      r.advance(5 * SECOND);
      // Unknown is not gone: the engine still holds the key, so the store keeps the same alert active.
      expect(engine.state().keys.filter((k) => k.active).map((k) => k.dedupKey)).toEqual([raised[0].dedupKey]);
      expect(r.alerts.recent(50)).toEqual(raised);
      expect(r.alertEvents()).toEqual([]);

      r.advance(11 * MINUTE, 10 * SECOND);   // still unknown, well past the 10 min cooldown
      expect(r.alerts.recent(50)).toEqual(raised);
      expect(r.alertEvents()).toEqual([]);

      r.provider.setScenario('parked');   // the list is available again and no longer holds the message
      const cleared = { ...raised[0], active: false, clearedAt: r.clock.t };
      expect(r.alerts.recent(50)).toEqual([cleared]);
      expect(r.alertEvents()).toEqual([cleared]);
      r.advance(10 * SECOND);
      expect(r.alertEvents()).toHaveLength(1);
    });

    test('after a restart an alert whose condition is still present stays active and is not raised again', async () => {
      const db = openDatabase(':memory:');
      const first = rig({ db, scenario: 'overheat-check-control' });
      await first.hub.start();
      first.advance(3 * MINUTE);
      const raised = first.alerts.active();
      const saved = (first.engine as EventEngine).state();
      await first.hub.stop();

      const engine = new EventEngine(defaultEngineOptions());
      engine.restore(saved);
      r = rig({ db, engine, scenario: 'overheat-check-control', start: first.clock.t });
      await r.hub.start();
      r.clock.t += 61 * SECOND;   // the first change already carries Check Control 39 (on from 60 s)
      r.provider.tick();
      r.advance(10 * SECOND);
      expect(r.alerts.recent(50)).toEqual(raised);
      expect(r.alertEvents()).toEqual([]);
    });

    test('a condition back inside its cooldown re-opens the same stored alert and its later end clears it', async () => {
      r = rig({ scenario: 'overheat-check-control' });
      await r.hub.start();
      r.advance(70 * SECOND);
      const [raised] = r.alerts.active();
      expect(raised).toBeDefined();

      r.provider.setScenario('parked');
      expect(r.alerts.active()).toEqual([]);
      expect(r.alertEvents().map((a) => a.active)).toEqual([true, false]);

      r.advance(10 * SECOND);
      r.provider.setScenario('overheat-check-control');
      r.advance(70 * SECOND);   // Check Control 39 is back for longer than its dwell, well inside the 10 min cooldown
      expect(r.engine?.active().map((a) => a.id)).toEqual([raised.id]);
      const reopened = r.alerts.recent(50);
      expect(reopened).toHaveLength(1);
      expect(reopened[0]).toMatchObject({ id: raised.id, active: true, clearedAt: null });
      expect(r.alertEvents().map((a) => [a.id, a.active])).toEqual([[raised.id, true], [raised.id, false], [raised.id, true]]);

      r.advance(10 * SECOND);
      expect(r.alertEvents()).toHaveLength(3);   // re-opened once, not on every change

      r.provider.setScenario('parked');   // the engine clears a re-activated key without returning an event
      expect(r.alerts.active()).toEqual([]);
      expect(r.alerts.recent(50)).toEqual([{ ...reopened[0], active: false, clearedAt: r.clock.t }]);
      expect(r.alertEvents().map((a) => [a.id, a.active])).toEqual([
        [raised.id, true], [raised.id, false], [raised.id, true], [raised.id, false],
      ]);
    });
  });
});
