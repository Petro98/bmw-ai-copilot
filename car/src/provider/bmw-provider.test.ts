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
const CCM = 'de.bmw.infotainment.checkcontrol.CheckControlMaster';
const KOMBI2 = 'de.bmw.infotainment.KombiInterface_2';

const NOT_REPORTED = { available: false, reason: 'not-reported' };
const STALE = { available: false, reason: 'stale' };
/** the passive fields a car notifies only when they change (the fixture sends each once) */
const STEADY_KEYS = ['coolantTemp', 'oilTemp', 'battery12vCharge', 'gear', 'gearStage', 'driveMode', 'condition'] as const;

interface WatchCall { iface: string; instance: string | undefined; fields: string[]; opts: { pollMs?: number } | undefined }

interface FakeWatch { iface: string; polled: boolean; available: boolean; down: boolean }

/**
 * A stand-in for the kit's signals.watch: records the calls and lets the test play the car. Like the kit
 * (car/kit/runtime/signals.js, local edit 4) a shut-down watch reports available false.
 */
function fakeSignals() {
  const calls: WatchCall[] = [];
  const handlers: Record<string, Record<string, (value: unknown) => void>> = {};
  const watches: FakeWatch[] = [];
  let shutdowns = 0;
  const signals: SignalsApi = {
    watch(iface, instance, h, _log, opts) {
      calls.push({ iface, instance, fields: Object.keys(h), opts });
      handlers[iface] = h;
      const w = { iface, polled: !!(opts && opts.pollMs), available: true, down: false, error: null,
        shutdown: () => { shutdowns++; w.down = true; w.available = false; return Promise.resolve(); } };
      watches.push(w);
      return Promise.resolve(w);
    },
  };
  const send = (iface: string, field: string, value: unknown): void => {
    const h = handlers[iface];
    if (h && h[field]) h[field](value);
  };
  const live = () => watches.filter((w) => !w.down);
  /** the live watch the provider holds for an interface */
  const watchOf = (iface: string) => live().find((w) => w.iface === iface);
  return { signals, calls, send, shutdowns: () => shutdowns, live, watchOf };
}

/** lets promise chains (watch set-up, shutdowns, a deferred refresh) run */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
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

  test('a Check Control message does not survive a stop/start: nothing until the car sends its list again', async () => {
    const { car, provider, clock } = await started();
    car.send(KOMBI2, 'ccList', [{ cCIdentifer: 901, cCShortName: 'Synthetic message one', cCColor: 'YELLOW' }]);
    car.send(CCM, 'basicList', [{ ccmId: 901, activeState: 'AKTIV' }]);
    car.send(KOMBI2, 'cbsDataServiceList', fixture.feed.find((e) => e[1] === 'cbsDataServiceList')![2]);
    clock.advance(1000);
    expect(provider.refresh().checkControl).toMatchObject({ available: true, value: [{ id: 901, text: 'Synthetic message one' }] });
    expect(provider.snapshot().serviceItems).toMatchObject({ available: true });
    await provider.stop();
    await provider.start();
    clock.advance(1000);
    let s = provider.refresh();
    expect(s.checkControl).toEqual(NOT_REPORTED);
    expect(s.serviceItems).toEqual(NOT_REPORTED);
    car.send(KOMBI2, 'ccList', [{ cCIdentifer: 901, cCShortName: 'Synthetic message one' }]);   // a text alone is not the list
    expect(provider.refresh().checkControl).toEqual(NOT_REPORTED);
    car.send(CCM, 'basicList', []);                    // the car's list, without the message it cleared meanwhile
    s = provider.refresh();
    expect(s.checkControl).toMatchObject({ available: true, value: [] });
  });

  test('values from before a stop do not come back as current after the next start', async () => {
    const { car, provider, clock } = await started();
    playFixture(car.send);
    clock.advance(1000);
    provider.refresh();
    await provider.stop();
    await provider.start();
    car.send(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 3200 });
    clock.advance(1000);
    const s = provider.refresh();
    expect(s.engineRpm).toMatchObject({ available: true, value: 800 });
    expect(s.coolantTemp).toEqual(NOT_REPORTED);
    expect(s.condition).toEqual(NOT_REPORTED);
  });

  test('a steady ten-minute drive keeps fields that only notify on change available', async () => {
    const { car, provider, clock } = await started();
    playFixture(car.send);
    for (let second = 1; second <= 600; second++) {
      clock.advance(1000);
      car.send(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 7000 + (second % 40) * 4 });
      car.send(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 6000 + (second % 30) * 16 });
      const s = provider.refresh();
      for (const key of STEADY_KEYS) expect(s[key]).toMatchObject({ available: true, at: clock.now() });
    }
    const s = provider.snapshot();
    expect(s.coolantTemp).toMatchObject({ value: 88 });
    expect(s.battery12vCharge).toMatchObject({ value: 84 });
    expect(s.gear).toMatchObject({ value: 'D4' });
    expect(s.driveMode).toMatchObject({ value: 'Sport' });
    expect(s.condition).toMatchObject({ value: 'driving' });
    // a polled reading is judged by its own last poll result (this fake never polls); the odometer is exempt
    expect(s.fuelLevel).toEqual(STALE);
    expect(s.tyrePressure.frontLeft).toEqual(STALE);
    expect(s.odometer).toMatchObject({ available: true, value: 23817 });
  });

  test('when the whole car goes quiet for longer than the window the steady fields turn stale', async () => {
    const { car, provider, clock } = await started();
    playFixture(car.send);
    clock.advance(120_000);
    car.send(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 3200 });
    provider.refresh();
    clock.advance(300_000);
    let s = provider.refresh();
    for (const key of STEADY_KEYS) expect(s[key]).toMatchObject({ available: true });
    clock.advance(1);
    s = provider.refresh();
    for (const key of STEADY_KEYS) expect(s[key]).toEqual(STALE);
    expect(s.engineRpm).toEqual(STALE);
    expect(s.speed).toEqual(STALE);
  });

  test('after a forward clock jump one notification brings the steady fields back', async () => {
    const { car, provider, clock } = await started();
    playFixture(car.send);
    clock.advance(1000);
    provider.refresh();
    clock.advance(3_600_000);
    let s = provider.refresh();
    for (const key of STEADY_KEYS) expect(s[key]).toEqual(STALE);
    car.send(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 6400 });
    s = provider.refresh();
    for (const key of STEADY_KEYS) expect(s[key]).toMatchObject({ available: true, at: clock.now() });
    expect(s.coolantTemp).toMatchObject({ value: 88 });
  });

  test('after a backward clock jump no reading is dated in the future and quiet still ages', async () => {
    const { car, provider, clock } = await started();
    playFixture(car.send);
    clock.advance(-600_000);
    let s: VehicleSnapshot;
    expect(() => { s = provider.refresh(); }).not.toThrow();
    s = provider.snapshot();
    const readings: Array<{ available: boolean; at?: number }> = [];
    for (const key of Object.keys(s)) {
      const v = (s as unknown as Record<string, unknown>)[key] as Record<string, unknown>;
      if (key === 'takenAt') continue;
      if ('available' in v) readings.push(v as { available: boolean; at?: number });
      else for (const wheel of Object.keys(v)) readings.push(v[wheel] as { available: boolean; at?: number });
    }
    for (const r of readings) if (r.available) expect(r.at).toBeLessThanOrEqual(clock.now());
    expect(s.coolantTemp).toMatchObject({ available: true, at: clock.now() });
    clock.advance(300_001);
    expect(provider.refresh().coolantTemp).toEqual(STALE);   // not frozen fresh until the old time comes round
  });

  test('a reading whose interface reports unavailable is unavailable at once and stays so until it arrives again', async () => {
    const { car, provider, clock } = await started();
    playFixture(car.send);
    clock.advance(1000);
    provider.refresh();
    car.watchOf(CDS)!.available = false;
    car.send(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 6400 });   // the rest of the car still notifies
    clock.advance(1000);
    let s = provider.refresh();
    expect(s.engineRpm).toEqual(NOT_REPORTED);
    expect(s.coolantTemp).toEqual(NOT_REPORTED);
    expect(s.battery12vCharge).toEqual(NOT_REPORTED);
    expect(s.speed).toMatchObject({ available: true, value: 100 });
    car.watchOf(CDS)!.available = true;
    clock.advance(1000);
    expect(provider.refresh().coolantTemp).toEqual(NOT_REPORTED);   // the old value does not come back
    car.send(CDS, 'statusEngineTemperature', { temperatureEngineDrive: 136, temperatureEngineOilDrive: 140 });
    s = provider.refresh();
    expect(s.coolantTemp).toMatchObject({ available: true, value: 88 });
  });

  test('a watch that never said it was available (an older native binding) does not hide its values', async () => {
    const { car, provider, clock } = await started();
    car.watchOf(CDS)!.available = false;
    car.send(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 3200 });
    clock.advance(1000);
    expect(provider.refresh().engineRpm).toMatchObject({ available: true, value: 800 });
  });

  test('suspend() keeps only the vehicle-condition watch, no polled watch, and marks the rest not-reported', async () => {
    const { car, provider, clock } = await started();
    playFixture(car.send);
    clock.advance(1000);
    provider.refresh();
    provider.suspend();
    await flush();
    expect(car.live().map((w) => w.iface)).toEqual([CONDITION]);
    expect(car.live().filter((w) => w.polled)).toEqual([]);
    let s = provider.snapshot();
    expect(s.condition).toMatchObject({ available: true, value: 'driving' });
    for (const key of ['engineRpm', 'speed', 'coolantTemp', 'gear', 'driveMode', 'fuelLevel', 'odometer', 'checkControl', 'serviceItems'] as const)
      expect(s[key]).toEqual(NOT_REPORTED);
    expect(s.tyrePressure.frontLeft).toEqual(NOT_REPORTED);
    expect(s.faultCodes).toEqual({ available: false, reason: 'diagnostics-disabled' });
    // values through the handlers of the watches that were shut down are dropped
    car.send(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 3200 });
    clock.advance(1000);
    s = provider.refresh();
    expect(s.engineRpm).toEqual(NOT_REPORTED);
  });

  test('a condition change while suspended reaches onChange without a tick', async () => {
    const { car, provider } = await started();
    car.send(CONDITION, 'VehicleCondition', { statusConditionVehicle: 'FAHREN' });
    provider.refresh();
    provider.suspend();
    const seen: VehicleSnapshot['condition'][] = [];
    provider.onChange((s) => seen.push(s.condition));
    car.send(CONDITION, 'VehicleCondition', { statusConditionVehicle: 2 });
    expect(seen.length).toBe(0);                       // not from inside the signal handler
    await flush();
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ available: true, value: 'parked' });
    car.send(CONDITION, 'VehicleCondition', { statusConditionVehicle: 5 });
    car.send(CONDITION, 'VehicleCondition', { statusConditionVehicle: 7 });
    await flush();
    expect(seen.length).toBe(2);                       // a burst is one notification
    expect(seen[1]).toMatchObject({ value: 'ignition-on' });
  });

  test('resume() re-creates the other watches and resets Check Control; it does nothing unless suspended', async () => {
    const { car, provider, clock } = await started();
    car.send(CCM, 'basicList', [{ ccmId: 901, activeState: 'AKTIV' }]);
    provider.refresh();
    provider.resume();
    await flush();
    expect(car.calls.length).toBe(RAW_INTERFACES.length);
    provider.suspend();
    provider.suspend();
    await flush();
    expect(car.live().length).toBe(1);
    provider.resume();
    await flush();
    expect(car.calls.length).toBe(2 * RAW_INTERFACES.length - 1);
    expect(car.live().length).toBe(RAW_INTERFACES.length);
    for (const raw of RAW_INTERFACES) expect(car.live().filter((w) => w.iface === raw.iface).length).toBe(1);
    clock.advance(1000);
    expect(provider.refresh().checkControl).toEqual(NOT_REPORTED);
    car.send(CCM, 'basicList', []);
    car.send(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 3200 });
    const s = provider.refresh();
    expect(s.checkControl).toMatchObject({ available: true, value: [] });
    expect(s.engineRpm).toMatchObject({ available: true, value: 800 });
  });

  test('suspend/resume repeated 50 times leaves a constant number of live watches', async () => {
    const { car, provider } = await started();
    for (let i = 0; i < 50; i++) { provider.suspend(); provider.resume(); }
    await flush();
    expect(car.live().length).toBe(RAW_INTERFACES.length);
    for (let i = 0; i < 50; i++) {
      provider.suspend();
      await flush();
      expect(car.live().length).toBe(1);
      provider.resume();
      await flush();
      expect(car.live().length).toBe(RAW_INTERFACES.length);
    }
    for (const raw of RAW_INTERFACES) expect(car.live().filter((w) => w.iface === raw.iface).length).toBe(1);
    provider.suspend();
    await provider.stop();
    await flush();
    expect(car.live().length).toBe(0);
    provider.suspend();                                // stopped: nothing to suspend
    provider.resume();
    await flush();
    expect(car.live().length).toBe(0);
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
