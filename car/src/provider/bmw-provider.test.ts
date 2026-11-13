import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { SIGNAL_CATALOGUE, type VehicleSnapshot } from '@copilot/vehicle-core';
import type { Log } from '../safe';
import { BmwMguVehicleDataProvider, type SignalsApi } from './bmw-provider';
import { RAW_INTERFACES } from './raw-decoders';

type FeedEntry = [string, string, unknown];
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../test/fixtures/raw-signals.json', import.meta.url)), 'utf8'),
) as { feed: FeedEntry[] };
const appJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../apps/p98_copilot/app.json', import.meta.url)), 'utf8'),
) as { signals: Record<string, Record<string, unknown>> };

const KOMBI = 'de.bmw.infotainment.KombiIF';
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const CDS = 'de.bmw.infotainment.vehicle.CDS';
const V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const CONDITION = 'de.bmw.infrastructure.VehicleCondition';

interface WatchCall { iface: string; instance: string | undefined; fields: string[]; opts: { pollMs?: number } | undefined }

/** A stand-in for the kit's signals.watch: records the calls and lets the test play the car. */
function fakeSignals() {
  const calls: WatchCall[] = [];
  const handlers: Record<string, Record<string, (value: unknown) => void>> = {};
  let shutdowns = 0;
  const signals: SignalsApi = {
    watch(iface, instance, h, _log, opts) {
      calls.push({ iface, instance, fields: Object.keys(h), opts });
      handlers[iface] = h;
      return Promise.resolve({ iface, available: true, error: null, shutdown: () => { shutdowns++; return Promise.resolve(); } });
    },
  };
  const send = (iface: string, field: string, value: unknown): void => {
    const h = handlers[iface];
    if (h && h[field]) h[field](value);
  };
  return { signals, calls, send, shutdowns: () => shutdowns };
}

/**
 * Like fakeSignals, but every watch resolves only when the test calls resolveAll(), the way the kit sets
 * watches up one after another through its serialised native chain (car/kit/runtime/signals.js:30-36).
 * Handlers are kept per watch() call so a test can send through the handlers of a given start().
 */
function lateSignals() {
  const calls: Array<{ iface: string; handlers: Record<string, (value: unknown) => void> }> = [];
  const waiting: Array<() => void> = [];
  const watches: Array<{ iface: string; down: boolean }> = [];
  let shutdowns = 0;
  const signals: SignalsApi = {
    watch(iface, _instance, h) {
      calls.push({ iface, handlers: h });
      return new Promise((resolve) => {
        waiting.push(() => {
          const w = { iface, down: false };
          watches.push(w);
          resolve({ iface, available: true, error: null, shutdown: () => { shutdowns++; w.down = true; return Promise.resolve(); } });
        });
      });
    },
  };
  const perStart = RAW_INTERFACES.length;
  return {
    signals,
    calls,
    resolveAll: () => { for (const r of waiting.splice(0)) r(); },
    shutdowns: () => shutdowns,
    live: () => watches.filter((w) => !w.down).length,
    liveFor: (iface: string) => watches.filter((w) => !w.down && w.iface === iface).length,
    /** send through the handlers registered by the n-th start() (0-based) */
    sendVia: (n: number, iface: string, field: string, value: unknown) => {
      const call = calls.slice(n * perStart, (n + 1) * perStart).find((c) => c.iface === iface);
      if (call && call.handlers[field]) call.handlers[field](value);
    },
  };
}

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, set: (v: number) => { t = v; }, advance: (ms: number) => { t += ms; } };
}

const quietLog: Log = { info() {}, warn() {}, error() {} };

async function started(missingInterfaces: string[] = []) {
  const car = fakeSignals();
  const clock = fakeClock();
  const provider = new BmwMguVehicleDataProvider({ signals: car.signals, clock, log: quietLog, missingInterfaces });
  await provider.start();
  return { car, clock, provider };
}

function playFixture(send: (iface: string, field: string, value: unknown) => void): void {
  for (const [iface, field, value] of fixture.feed) send(iface, field, value);
}

describe('BmwMguVehicleDataProvider', () => {
  test('one watch per interface, polled interfaces with pollMs 10000', async () => {
    const { car } = await started();
    const ifaces = car.calls.map((c) => c.iface);
    expect(new Set(ifaces).size).toBe(ifaces.length);
    expect(ifaces.sort()).toEqual(RAW_INTERFACES.map((r) => r.iface).sort());
    const polled = new Set(SIGNAL_CATALOGUE.filter((e) => e.transport === 'polled').map((e) => e.iface));
    expect([...polled].sort()).toEqual([KOMBI, TPMS]);
    for (const call of car.calls) {
      expect(call.instance).toBe('1');
      if (polled.has(call.iface)) expect(call.opts).toEqual({ pollMs: 10000 });
      else expect(call.opts).toBeUndefined();
    }
    // every catalogue field is watched on its interface
    for (const entry of SIGNAL_CATALOGUE) {
      const call = car.calls.find((c) => c.iface === entry.iface);
      expect(call && call.fields).toContain(entry.field);
    }
  });

  test('start() twice does not watch twice; stop() shuts every watch down and drops later values', async () => {
    const { car, provider, clock } = await started();
    await provider.start();
    expect(car.calls.length).toBe(RAW_INTERFACES.length);
    await provider.stop();
    expect(car.shutdowns()).toBe(RAW_INTERFACES.length);
    car.send(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 4000 });
    clock.advance(1000);
    expect(provider.refresh().engineRpm).toEqual({ available: false, reason: 'not-reported' });
  });

  test('a watch that resolves after stop() is shut down when it arrives', async () => {
    const car = lateSignals();
    const provider = new BmwMguVehicleDataProvider({ signals: car.signals, clock: fakeClock(), log: quietLog, missingInterfaces: [] });
    const starting = provider.start();
    await provider.stop();
    expect(car.shutdowns()).toBe(0);                  // nothing had arrived yet
    car.resolveAll();
    await starting;
    expect(car.shutdowns()).toBe(RAW_INTERFACES.length);
    expect(car.live()).toBe(0);
  });

  test('start-stop-start with late watches ends with exactly one live watch per interface', async () => {
    const car = lateSignals();
    const clock = fakeClock();
    const provider = new BmwMguVehicleDataProvider({ signals: car.signals, clock, log: quietLog, missingInterfaces: [] });
    const first = provider.start();
    void provider.stop();
    const second = provider.start();
    car.resolveAll();
    await Promise.all([first, second]);
    expect(car.calls.length).toBe(2 * RAW_INTERFACES.length);
    expect(car.live()).toBe(RAW_INTERFACES.length);
    for (const raw of RAW_INTERFACES) expect(car.liveFor(raw.iface)).toBe(1);
    // a value through the first start's handlers is dropped, one through the second start's is applied
    car.sendVia(0, V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 640 });
    expect(provider.refresh().speed).toEqual({ available: false, reason: 'not-reported' });
    car.sendVia(1, V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 6400 });
    expect(provider.refresh().speed).toMatchObject({ available: true, value: 100 });
    await provider.stop();
    expect(car.live()).toBe(0);
  });

  test('a watch that rejects does not break start()', async () => {
    const signals: SignalsApi = { watch: () => Promise.reject(new Error('no SOME/IP config')) };
    const errors: string[] = [];
    const provider = new BmwMguVehicleDataProvider({
      signals, clock: fakeClock(), log: { info() {}, warn: (m) => errors.push(m), error: (m) => errors.push(m) }, missingInterfaces: [],
    });
    await expect(provider.start()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  test('the fixture feed arrives in the snapshot', async () => {
    const { car, provider, clock } = await started();
    playFixture(car.send);
    clock.advance(1000);
    const s = provider.refresh();
    expect(s.takenAt).toBe(clock.now());
    expect(s.engineRpm).toMatchObject({ available: true, value: 1850 });
    expect(s.speed).toMatchObject({ available: true, value: 100 });
    expect(s.odometer).toMatchObject({ available: true, value: 23817 });
    expect(s.condition).toMatchObject({ available: true, value: 'driving' });
    expect(provider.snapshot()).toBe(s);
    expect(provider.capabilities().diagnosticsEnabled).toBe(false);
    expect(provider.capabilities().delivers).toEqual(expect.arrayContaining(['engineRpm', 'speed', 'tyrePressure', 'checkControl', 'serviceItems']));
    expect(provider.capabilities().delivers).not.toContain('faultCodes');
  });

  test('diagnostic-only readings are always diagnostics-disabled', async () => {
    const { car, provider, clock } = await started();
    playFixture(car.send);
    clock.advance(3_600_000);
    const s = provider.refresh();
    for (const key of ['battery12vVoltage', 'intakeTemp', 'boostPressure', 'engineLoad', 'faultCodes'] as const)
      expect(s[key]).toEqual({ available: false, reason: 'diagnostics-disabled' });
  });

  test('an interface the firmware lacks reports not-on-this-vehicle', async () => {
    const { car, provider, clock } = await started([TPMS, KOMBI, 'de.bmw.infotainment.checkcontrol.CheckControlMaster']);
    expect(car.calls.map((c) => c.iface)).not.toContain(TPMS);
    expect(car.calls.map((c) => c.iface)).not.toContain(KOMBI);
    playFixture(car.send);
    clock.advance(1000);
    const s = provider.refresh();
    expect(s.tyrePressure.frontLeft).toEqual({ available: false, reason: 'not-on-this-vehicle' });
    expect(s.tyrePressureTarget.rearRight).toEqual({ available: false, reason: 'not-on-this-vehicle' });
    expect(s.fuelLevel).toEqual({ available: false, reason: 'not-on-this-vehicle' });
    expect(s.odometer).toEqual({ available: false, reason: 'not-on-this-vehicle' });
    expect(s.checkControl).toEqual({ available: false, reason: 'not-on-this-vehicle' });
    expect(s.engineRpm).toMatchObject({ available: true, value: 1850 });
    expect(provider.capabilities().delivers).not.toContain('tyrePressure');
  });

  test('readings go stale after five minutes of silence but the odometer keeps its value', async () => {
    const { car, provider, clock } = await started();
    playFixture(car.send);
    const at = clock.now();
    clock.advance(299_999);
    expect(provider.refresh().engineRpm).toMatchObject({ available: true, value: 1850 });
    clock.advance(2);
    const s = provider.refresh();
    expect(s.engineRpm).toEqual({ available: false, reason: 'stale' });
    expect(s.speed).toEqual({ available: false, reason: 'stale' });
    expect(s.condition).toEqual({ available: false, reason: 'stale' });
    expect(s.tyrePressure.frontLeft).toEqual({ available: false, reason: 'stale' });
    expect(s.odometer).toMatchObject({ available: true, value: 23817, at });
    expect(s.checkControl).toMatchObject({ available: true, at });
    expect(s.serviceItems).toMatchObject({ available: true, at });
    // a fresh value makes it available again
    car.send(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 3200 });
    expect(provider.refresh().engineRpm).toMatchObject({ available: true, value: 800, at: clock.now() });
  });

  test('a custom staleAfterMs, and a clock jumping backwards does not make readings stale', async () => {
    const car = fakeSignals();
    const clock = fakeClock();
    const provider = new BmwMguVehicleDataProvider({ signals: car.signals, clock, log: quietLog, missingInterfaces: [], staleAfterMs: 1000 });
    await provider.start();
    car.send(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 6400 });
    clock.advance(-86_400_000);
    expect(provider.refresh().speed).toMatchObject({ available: true, value: 100 });
    clock.advance(86_400_000 + 1001);
    expect(provider.refresh().speed).toEqual({ available: false, reason: 'stale' });
  });

  test('signal handlers never notify; refresh() notifies once and only when something changed', async () => {
    const { car, provider, clock } = await started();
    const seen: VehicleSnapshot[] = [];
    const off = provider.onChange((s) => seen.push(s));
    playFixture(car.send);
    expect(seen.length).toBe(0);
    clock.advance(1000);
    provider.refresh();
    expect(seen.length).toBe(1);
    clock.advance(1000);
    provider.refresh();
    expect(seen.length).toBe(1);                      // nothing arrived, nothing went stale
    car.send(CONDITION, 'VehicleCondition', { statusConditionVehicle: 2 });
    car.send(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 0 });
    expect(seen.length).toBe(1);
    provider.refresh();
    expect(seen.length).toBe(2);
    expect(seen[1].condition).toMatchObject({ value: 'parked' });
    clock.advance(300_001);
    provider.refresh();                               // readings went stale: a change
    expect(seen.length).toBe(3);
    provider.refresh();
    expect(seen.length).toBe(3);
    off();
    car.send(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 640 });
    provider.refresh();
    expect(seen.length).toBe(3);
  });

  test('a listener that throws does not stop the others or the provider', async () => {
    const { car, provider } = await started();
    const seen: number[] = [];
    provider.onChange(() => { throw new Error('boom'); });
    provider.onChange((s) => seen.push(s.takenAt));
    car.send(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 640 });
    expect(() => provider.refresh()).not.toThrow();
    expect(seen.length).toBe(1);
  });

  test('a handler given junk never throws', async () => {
    const { car, provider } = await started();
    for (const [iface, field] of fixture.feed)
      for (const junk of [null, undefined, 42, 'x', {}, []]) expect(() => car.send(iface, field, junk)).not.toThrow();
    expect(() => provider.refresh()).not.toThrow();
  });

  test('every signal in app.json has only read/subscribe flags', () => {
    const signals = appJson.signals;
    expect(Object.keys(signals).sort()).toEqual(RAW_INTERFACES.map((r) => r.iface).sort());
    for (const raw of RAW_INTERFACES) {
      const entry = signals[raw.iface];
      const fields = Object.keys(entry).filter((k) => !k.startsWith('_'));
      expect(fields.sort()).toEqual([...raw.fields].sort());
      for (const f of fields) expect(entry[f]).toMatch(/^(r|s|rs)$/);
      // no methods, broadcasts or other instances: nothing that could call into the car
      for (const k of Object.keys(entry).filter((key) => key.startsWith('_'))) expect(k).toBe('_optional');
      if (raw.essential) expect(entry._optional).toBeUndefined();
      else expect(typeof entry._optional).toBe('string');
    }
    // engine speed, vehicle speed and vehicle condition are essential
    for (const iface of [CDS, V2, CONDITION]) expect(signals[iface]._optional).toBeUndefined();
    expect(JSON.stringify(signals)).not.toMatch(/"[rs]*w[rs]*"/);
  });
});
