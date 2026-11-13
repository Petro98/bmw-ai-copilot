import { expect, test } from 'vitest';
import { SCENARIOS, ScenarioId, VehicleSnapshot, available } from '@copilot/vehicle-core';
import { EventEngine } from '../engine';
import { AlertEvent, NO_LIMITS, OwnerLimits } from '../types';
import { THIRTY_DAYS_MS, defaultEngineOptions, defaultRules } from './index';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const START = 1_000_000;

/** The pure scenario builder of the mock provider: snapshot at `elapsedMs` into the scenario. */
function scenario(id: ScenarioId): (elapsedMs: number) => VehicleSnapshot {
  const found = SCENARIOS.filter((s) => s.id === id)[0];
  if (!found) throw new Error('missing scenario ' + id);
  return (elapsedMs: number) => found.build(elapsedMs, START + elapsedMs);
}

function limits(overrides: Partial<OwnerLimits>): OwnerLimits {
  return { ...NO_LIMITS, ...overrides };
}

function newEngine(): EventEngine {
  return new EventEngine(defaultEngineOptions());
}

/** Evaluates the snapshot built for `elapsedMs`, at time START + elapsedMs. */
function step(engine: EventEngine, snapshot: VehicleSnapshot, elapsedMs: number, l: OwnerLimits = NO_LIMITS): AlertEvent[] {
  return engine.evaluate(snapshot, START + elapsedMs, l);
}

/** Runs a scenario from `fromMs` to `toMs` (inclusive) every `stepMs`; returns every event returned. */
function runScenario(
  engine: EventEngine, id: ScenarioId, fromMs: number, toMs: number, l: OwnerLimits = NO_LIMITS, stepMs = SECOND,
): AlertEvent[] {
  const build = scenario(id);
  const all: AlertEvent[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) all.push(...step(engine, build(t), t, l));
  return all;
}

function raised(events: AlertEvent[]): AlertEvent[] {
  return events.filter((e) => e.active);
}

/** A steady-cruise snapshot without its service item and with the oil temperature replaced. */
function withOil(elapsedMs: number, celsius: number): VehicleSnapshot {
  const s = scenario('steady-cruise')(elapsedMs);
  s.serviceItems = available([], null, 'mock', START + elapsedMs);
  s.oilTemp = available(celsius, '°C', 'mock', START + elapsedMs);
  return s;
}

test('defaultRules and defaultEngineOptions carry the planned timing and no thresholds', () => {
  const rules = defaultRules();
  expect(rules.map((r) => [r.id, r.provenance, r.dwellMs, r.cooldownMs])).toEqual([
    ['check-control', 'bmw-check-control', 4000, 600_000],
    ['service', 'bmw-service', 0, THIRTY_DAYS_MS],
    ['fault-status', 'bmw-fault-status', 0, 600_000],
    ['owner-limits', 'owner-configured', 5000, 600_000],
  ]);
  const options = defaultEngineOptions();
  expect(options.maxRaisedPerWindow).toBe(6);
  expect(options.windowMs).toBe(600_000);
  expect(options.historySize).toBe(200);
  expect(typeof options.suppress).toBe('function');
});

test('with no owner limits and a healthy car nothing is ever raised', () => {
  // steady-cruise carries one BMW service item due soon (Task 3); a healthy car here is that picture
  // without the service item, so only the absence of built-in thresholds is under test.
  const engine = newEngine();
  const build = scenario('steady-cruise');
  for (let t = 0; t <= 30 * MINUTE; t += SECOND) {
    const s = build(t);
    s.serviceItems = available([], null, 'mock', START + t);
    step(engine, s, t);
  }
  expect(engine.history()).toEqual([]);

  // Oil up to 118 °C and coolant up to 102 °C without owner limits: still nothing.
  const spirited = newEngine();
  runScenario(spirited, 'spirited', 0, 30 * MINUTE);
  expect(spirited.history()).toEqual([]);

  // The unmodified steady-cruise raises only its BMW service item, once.
  const cruise = newEngine();
  runScenario(cruise, 'steady-cruise', 0, 30 * MINUTE);
  expect(cruise.history().map((e) => [e.provenance, e.severity, e.title])).toEqual([
    ['bmw-service', 'info', 'Гальмівна рідина: через 3 місяці'],
  ]);
});

test('an all-unavailable snapshot raises nothing and does not throw', () => {
  const engine = newEngine();
  const all = limits({ oilTempMaxC: 115, coolantTempMaxC: 110, battery12vMinPercent: 50, tyrePressureDeviationBar: 0.3 });
  expect(() => runScenario(engine, 'signals-missing', 0, 10 * MINUTE, all)).not.toThrow();
  expect(engine.history()).toEqual([]);
  expect(engine.active()).toEqual([]);
});

test('Check Control uses the car text and its severity', () => {
  const engine = newEngine();
  const before = runScenario(engine, 'overheat-check-control', 0, 63 * SECOND);
  expect(raised(before)).toEqual([]);
  const at64 = runScenario(engine, 'overheat-check-control', 64 * SECOND, 64 * SECOND);
  expect(at64).toHaveLength(1);
  expect(at64[0]).toMatchObject({
    ruleId: 'check-control',
    dedupKey: 'cc:39',
    provenance: 'bmw-check-control',
    severity: 'critical',
    title: 'Температура двигуна. Обережно зупиніться',
    detail: null,
    active: true,
  });
  runScenario(engine, 'overheat-check-control', 65 * SECOND, 3 * MINUTE);
  expect(engine.history()).toHaveLength(1);
});

test('Check Control without text falls back to the id', () => {
  // From 90 s the low-tyre scenario reports message 63 without its text.
  const engine = newEngine();
  const events = raised(runScenario(engine, 'low-tyre', 90 * SECOND, 100 * SECOND));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    provenance: 'bmw-check-control', severity: 'warning', title: 'Повідомлення Check Control 63',
  });
});

test('owner oil limit: raised after 5 s above, cleared only 2 degrees below', () => {
  const engine = newEngine();
  const l = limits({ oilTempMaxC: 115 });
  for (let t = 0; t <= 4 * SECOND; t += SECOND) expect(step(engine, withOil(t, 116), t, l)).toEqual([]);
  const up = step(engine, withOil(5 * SECOND, 116), 5 * SECOND, l);
  expect(up).toHaveLength(1);
  expect(up[0]).toMatchObject({
    ruleId: 'owner-limits', dedupKey: 'limit:oilTempMaxC', provenance: 'owner-configured', severity: 'warning',
    title: 'Масло 116 °C — вище вашого ліміту 115 °C', active: true,
  });
  expect(step(engine, withOil(6 * SECOND, 114), 6 * SECOND, l)).toEqual([]);
  expect(engine.active()).toHaveLength(1);
  const down = step(engine, withOil(7 * SECOND, 113), 7 * SECOND, l);
  expect(down).toHaveLength(1);
  expect(down[0]).toMatchObject({ dedupKey: 'limit:oilTempMaxC', active: false, clearedAt: START + 7 * SECOND });
  expect(engine.active()).toEqual([]);
});

test('oil hovering 114.9–115.1 for ten minutes raises once', () => {
  const engine = newEngine();
  const l = limits({ oilTempMaxC: 115 });
  // Above the limit long enough to raise, then hovering around it for ten minutes.
  for (let t = 0; t <= 5 * SECOND; t += SECOND) step(engine, withOil(t, 115.1), t, l);
  for (let t = 6 * SECOND; t <= 10 * MINUTE; t += SECOND) {
    step(engine, withOil(t, (t / SECOND) % 2 === 0 ? 115.1 : 114.9), t, l);
  }
  expect(engine.history()).toHaveLength(1);
  expect(engine.history()[0]).toMatchObject({ title: 'Масло 115,1 °C — вище вашого ліміту 115 °C', active: true });

  // Hovering from the start never stays above long enough to pass the dwell time.
  const other = newEngine();
  for (let t = 0; t <= 10 * MINUTE; t += SECOND) {
    step(other, withOil(t, (t / SECOND) % 2 === 0 ? 115.1 : 114.9), t, l);
  }
  expect(other.history()).toEqual([]);
});

test('coolant and 12 V owner limits use their own titles and margins', () => {
  const engine = newEngine();
  const l = limits({ coolantTempMaxC: 110 });
  const coolant = raised(runScenario(engine, 'overheat-check-control', 0, 50 * SECOND, l));
  expect(coolant).toHaveLength(1);
  expect(coolant[0].title).toMatch(/^Охолоджувальна рідина \d+ °C — вище вашого ліміту 110 °C$/);

  const battery = newEngine();
  const b = limits({ battery12vMinPercent: 50 });
  // Charge falls 62 → 48 % over 10 minutes and stays at 48 %.
  const events = raised(runScenario(battery, 'weak-battery', 0, 12 * MINUTE, b));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ dedupKey: 'limit:battery12vMinPercent', title: 'Акумулятор 12 В 49 % — нижче вашого ліміту 50 %' });
});

test('tyre deviation names the wheel and both values', () => {
  const engine = newEngine();
  const events = raised(runScenario(engine, 'low-tyre', 0, 20 * SECOND, limits({ tyrePressureDeviationBar: 0.3 })));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    dedupKey: 'limit:tyre:rearLeft', provenance: 'owner-configured', severity: 'warning',
    title: 'Тиск у шині (задня ліва) 2,0 бар, ціль авто 2,4 бар',
  });
});

test('tyre deviation needs both values in bar', () => {
  const engine = newEngine();
  const build = scenario('low-tyre');
  for (let t = 0; t <= 20 * SECOND; t += SECOND) {
    const s = build(t);
    s.tyrePressure.rearLeft = available(29, 'psi', 'mock', START + t);
    s.tyrePressureTarget.frontLeft = available(2.3, null, 'mock', START + t);
    s.tyrePressure.frontLeft = available(1.5, 'bar', 'mock', START + t);
    step(engine, s, t, limits({ tyrePressureDeviationBar: 0.3 }));
  }
  expect(engine.history()).toEqual([]);
});

test('service item raises once per state and not again within 30 days', () => {
  const engine = newEngine();
  const build = scenario('steady-cruise');
  const first = raised(step(engine, build(0), 0));
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    ruleId: 'service', dedupKey: 'service:3:due-soon', provenance: 'bmw-service', severity: 'info',
    title: 'Гальмівна рідина: через 3 місяці',
  });
  expect(step(engine, build(SECOND), SECOND)).toEqual([]);

  // The item goes back to ok, then becomes due soon again within 30 days: silent.
  const ok = build(2 * SECOND);
  ok.serviceItems = available([{ id: 3, name: 'Гальмівна рідина', status: 'ok', dueText: null }], null, 'mock', START);
  expect(step(engine, ok, 2 * SECOND).filter((e) => !e.active)).toHaveLength(1);
  expect(step(engine, build(10 * 24 * 3600 * SECOND), 10 * 24 * 3600 * SECOND)).toEqual([]);
  expect(engine.active()).toHaveLength(1);

  // A new state (overdue) is a new key and raises as a warning.
  const overdue = build(11 * 24 * 3600 * SECOND);
  overdue.serviceItems = available([{ id: 3, name: null, status: 'overdue', dueText: null }], null, 'mock', START);
  const o = raised(step(engine, overdue, 11 * 24 * 3600 * SECOND));
  expect(o).toHaveLength(1);
  expect(o[0]).toMatchObject({ dedupKey: 'service:3:overdue', severity: 'warning', title: 'Сервіс 3' });

  // After 30 days the due-soon state raises again.
  const later = THIRTY_DAYS_MS + 2 * SECOND;
  step(engine, ok, later - SECOND);
  expect(raised(step(engine, build(later), later))).toHaveLength(1);
});

test('only faults that are active with the warning lamp are raised', () => {
  const engine = newEngine();
  runScenario(engine, 'stored-faults', 0, 2 * MINUTE);
  const history = engine.history();
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    ruleId: 'fault-status', dedupKey: 'fault:DEMO-ECU-A:DEMO-0001', provenance: 'bmw-fault-status',
    severity: 'warning', title: 'Помилка DEMO-0001 (DEMO-ECU-A)',
  });
});

test('nothing is raised while reversing; it is raised once the gear leaves R', () => {
  const engine = newEngine();
  const build = scenario('overheat-check-control');
  for (let t = 60 * SECOND; t <= 80 * SECOND; t += SECOND) {
    const s = build(t);
    s.gearStage = available('R', null, 'mock', START + t);
    s.gear = available('R', null, 'mock', START + t);
    expect(step(engine, s, t)).toEqual([]);
  }
  const out = raised(step(engine, build(81 * SECOND), 81 * SECOND));
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ dedupKey: 'cc:39', severity: 'critical' });
});
