import { expect, test } from 'vitest';
import { valueOr } from '../reading';
import { VehicleSnapshot } from '../snapshot';
import { MockVehicleDataProvider } from './mock-provider';
import { SCENARIOS } from './scenarios';

interface FakeInterval { fn: () => void; ms: number; cleared: boolean }

/** Records setInterval / clearInterval calls and can fire the live intervals by hand. */
function fakeTimers() {
  const intervals: FakeInterval[] = [];
  const clears: unknown[] = [];
  return {
    intervals,
    clears,
    setInterval(fn: () => void, ms: number): unknown {
      const handle: FakeInterval = { fn, ms, cleared: false };
      intervals.push(handle);
      return handle;
    },
    clearInterval(handle: unknown): void {
      clears.push(handle);
      (handle as FakeInterval).cleared = true;
    },
    fire(): void {
      for (const i of intervals) if (!i.cleared) i.fn();
    },
  };
}

const clock = { t: 1_000_000, now() { return this.t; } };
const timers = fakeTimers();

test('is deterministic: same elapsed time, same snapshot', () => {
  const a = new MockVehicleDataProvider({ clock, timers, scenario: 'cold-start' });
  const b = new MockVehicleDataProvider({ clock, timers, scenario: 'cold-start' });
  clock.t += 300_000; a.tick(); b.tick();
  expect(a.snapshot()).toEqual(b.snapshot());
});

test('cold-start warms up and oil lags coolant', () => {
  const p = new MockVehicleDataProvider({ clock, timers, scenario: 'cold-start' });
  clock.t += 180_000; p.tick();
  const s = p.snapshot();
  expect(valueOr(s.coolantTemp, null)!).toBeGreaterThan(valueOr(s.oilTemp, null)!);
  clock.t += 900_000; p.tick();
  expect(valueOr(p.snapshot().oilTemp, null)).toBe(92);
});

test('overheat scenario raises a critical Check Control message after 60 s', () => {
  const p = new MockVehicleDataProvider({ clock, timers, scenario: 'overheat-check-control' });
  clock.t += 59_000; p.tick();
  expect(valueOr(p.snapshot().checkControl, null)).toEqual([]);
  clock.t += 2_000; p.tick();
  expect(valueOr(p.snapshot().checkControl, null)![0]).toMatchObject({ id: 39, severity: 'critical' });
});

test('signals-missing has no available reading at all', () => {
  const p = new MockVehicleDataProvider({ clock, timers, scenario: 'signals-missing' });
  p.tick();
  const s = p.snapshot();
  expect(s.oilTemp.available || s.speed.available || s.checkControl.available).toBe(false);
  expect(s.tyrePressure.rearLeft).toEqual({ available: false, reason: 'not-on-this-vehicle' });
  expect(p.capabilities().delivers).toEqual([]);
});

test('diagnostic-only readings are never available from the mock', () => {
  for (const sc of SCENARIOS) {
    const s = sc.build(120_000, 0);
    expect(s.intakeTemp).toEqual({ available: false, reason: 'diagnostics-disabled' });
    expect(s.battery12vVoltage).toEqual({ available: false, reason: 'diagnostics-disabled' });
    expect(s.boostPressure).toEqual({ available: false, reason: 'diagnostics-disabled' });
    expect(s.engineLoad).toEqual({ available: false, reason: 'diagnostics-disabled' });
  }
});

test('SCENARIOS covers all nine scenario ids once, each with a title', () => {
  const ids = SCENARIOS.map((s) => s.id).sort();
  expect(ids).toEqual([
    'cold-start', 'low-tyre', 'overheat-check-control', 'parked', 'signals-missing',
    'spirited', 'steady-cruise', 'stored-faults', 'weak-battery',
  ]);
  for (const s of SCENARIOS) expect(s.title.length).toBeGreaterThan(0);
});

test('steady-cruise carries the documented demo values', () => {
  const p = new MockVehicleDataProvider({ clock, timers });
  expect(p.scenarioId()).toBe('steady-cruise');
  const s = p.snapshot();
  expect(valueOr(s.speed, null)).toBe(100);
  expect(valueOr(s.engineRpm, null)).toBe(1850);
  expect(valueOr(s.gear, null)).toBe('D8');
  expect(valueOr(s.condition, null)).toBe('driving');
  expect(valueOr(s.tyrePressure.rearLeft, null)).toBe(valueOr(s.tyrePressureTarget.rearLeft, null));
  expect(valueOr(s.serviceItems, null)).toEqual([
    expect.objectContaining({ name: 'Гальмівна рідина', status: 'due-soon', dueText: 'через 3 місяці' }),
  ]);
  expect(valueOr(s.checkControl, null)).toEqual([]);
});

test('low-tyre: car text after 30 s, id-only variant from 90 s', () => {
  const p = new MockVehicleDataProvider({ clock, timers, scenario: 'low-tyre' });
  expect(valueOr(p.snapshot().tyrePressure.rearLeft, null)).toBe(2.0);
  expect(valueOr(p.snapshot().tyrePressureTarget.rearLeft, null)).toBe(2.4);
  expect(valueOr(p.snapshot().checkControl, null)).toEqual([]);
  clock.t += 30_000; p.tick();
  expect(valueOr(p.snapshot().checkControl, null)).toEqual([
    expect.objectContaining({ id: 63, text: 'Тиск у шинах: задня ліва', severity: 'warning' }),
  ]);
  clock.t += 60_000; p.tick();
  expect(valueOr(p.snapshot().checkControl, null)).toEqual([
    expect.objectContaining({ id: 63, text: null, severity: 'warning' }),
  ]);
});

test('stored-faults has two fault codes, one active with the warning lamp', () => {
  const faults = valueOr(SCENARIOS.find((s) => s.id === 'stored-faults')!.build(0, 0).faultCodes, null)!;
  expect(faults).toHaveLength(2);
  expect(faults.filter((f) => f.activeNow && f.warningLamp)).toHaveLength(1);
});

test('weak-battery is parked and the 12 V charge falls from 62 % to 48 %', () => {
  const sc = SCENARIOS.find((s) => s.id === 'weak-battery')!;
  expect(valueOr(sc.build(0, 0).condition, null)).toBe('parked');
  expect(valueOr(sc.build(0, 0).battery12vCharge, null)).toBe(62);
  expect(valueOr(sc.build(3_600_000, 0).battery12vCharge, null)).toBe(48);
});

test('parked: standing still, temperatures 20 minutes old', () => {
  const now = 50_000_000;
  const s = SCENARIOS.find((sc) => sc.id === 'parked')!.build(10_000, now);
  expect(valueOr(s.condition, null)).toBe('parked');
  expect(valueOr(s.speed, null)).toBe(0);
  expect(valueOr(s.engineRpm, null)).toBe(0);
  expect(s.oilTemp.available && s.oilTemp.at).toBe(now - 20 * 60_000);
  expect(s.coolantTemp.available && s.coolantTemp.at).toBe(now - 20 * 60_000);
});

test('start schedules one interval, stop clears it, listeners can unsubscribe', async () => {
  const t = fakeTimers();
  const p = new MockVehicleDataProvider({ clock, timers: t });
  const seen: VehicleSnapshot[] = [];
  const dropped: VehicleSnapshot[] = [];
  p.onChange((s) => seen.push(s));
  const unsubscribe = p.onChange((s) => dropped.push(s));
  await p.start();
  await p.start();
  expect(t.intervals).toHaveLength(1);
  expect(t.intervals[0]!.ms).toBe(1000);
  unsubscribe();
  clock.t += 1000; t.fire();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.takenAt).toBe(clock.t);
  expect(dropped).toHaveLength(0);
  await p.stop();
  expect(t.clears).toEqual([t.intervals[0]]);
  t.fire();
  expect(seen).toHaveLength(1);
});

test('tickMs option sets the interval', async () => {
  const t = fakeTimers();
  const p = new MockVehicleDataProvider({ clock, timers: t, tickMs: 250 });
  await p.start();
  expect(t.intervals[0]!.ms).toBe(250);
  await p.stop();
});

test('setScenario notifies listeners immediately and resets elapsed time', () => {
  const p = new MockVehicleDataProvider({ clock, timers, scenario: 'steady-cruise' });
  const seen: VehicleSnapshot[] = [];
  p.onChange((s) => seen.push(s));
  clock.t += 120_000; p.tick();
  p.setScenario('overheat-check-control');
  expect(p.scenarioId()).toBe('overheat-check-control');
  expect(seen).toHaveLength(2);
  expect(seen[1]).toBe(p.snapshot());
  // Elapsed restarted: the Check Control message (60 s into the scenario) is not there yet.
  expect(valueOr(p.snapshot().checkControl, null)).toEqual([]);
  clock.t += 61_000; p.tick();
  expect(valueOr(p.snapshot().checkControl, null)).toHaveLength(1);
});

test('a throwing listener does not escape tick, the timer or setScenario, and the others still run', async () => {
  const t = fakeTimers();
  const p = new MockVehicleDataProvider({ clock, timers: t });
  const seen: VehicleSnapshot[] = [];
  p.onChange(() => { throw new Error('listener failure'); });
  p.onChange((s) => seen.push(s));
  expect(() => p.tick()).not.toThrow();
  expect(seen).toHaveLength(1);
  await p.start();
  expect(() => t.fire()).not.toThrow();
  expect(seen).toHaveLength(2);
  expect(() => p.setScenario('parked')).not.toThrow();
  expect(p.scenarioId()).toBe('parked');
  expect(seen).toHaveLength(3);
  await p.stop();
});

test('a clock that jumps backwards does not throw and does not rewind before the scenario start', () => {
  const p = new MockVehicleDataProvider({ clock, timers, scenario: 'cold-start' });
  const atStart = p.snapshot();
  clock.t -= 86_400_000; p.tick();
  expect(valueOr(p.snapshot().coolantTemp, null)).toBe(valueOr(atStart.coolantTemp, null));
  clock.t += 86_400_000;
});

test('capabilities list the delivered keys and diagnostics stay off', () => {
  const p = new MockVehicleDataProvider({ clock, timers, scenario: 'steady-cruise' });
  const caps = p.capabilities();
  expect(caps.diagnosticsEnabled).toBe(false);
  expect(caps.delivers).toContain('oilTemp');
  expect(caps.delivers).toContain('tyrePressure');
  expect(caps.delivers).not.toContain('intakeTemp');
  expect(caps.delivers).not.toContain('faultCodes');
});
