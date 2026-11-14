import { expect, test } from 'vitest';
import { SCENARIOS, ScenarioId, VehicleSnapshot, available, unavailable } from '@copilot/vehicle-core';
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
  expect(engine.state().keys).toEqual([]); // nothing is held either
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

test('a service item the car marks due now raises once as a warning, worded as due now, with only the due text the car sent', () => {
  const engine = newEngine();
  const build = scenario('steady-cruise');
  const dueNow = (t: number, dueText: string | null) => {
    const s = build(t);
    s.serviceItems = available([{ id: 3, name: 'Гальмівна рідина', status: 'due-now', dueText }], null, 'mock', START + t);
    return s;
  };
  const first = raised(step(engine, dueNow(0, '01/2027'), 0));
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    ruleId: 'service', dedupKey: 'service:3:due-now', provenance: 'bmw-service', severity: 'warning',
    title: 'Гальмівна рідина: 01/2027', detail: 'Сервіс потрібен зараз',
  });
  expect(step(engine, dueNow(SECOND, '01/2027'), SECOND)).toEqual([]);
  expect(step(engine, dueNow(10 * MINUTE, '01/2027'), 10 * MINUTE)).toEqual([]);
  expect(engine.history()).toHaveLength(1);

  // Without a due text from the car the title is the name alone: nothing is made up.
  const other = newEngine();
  const bare = raised(step(other, dueNow(0, null), 0));
  expect(bare).toHaveLength(1);
  expect(bare[0]).toMatchObject({ title: 'Гальмівна рідина', detail: 'Сервіс потрібен зараз', severity: 'warning' });
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

/** The overheat scenario at `elapsedMs` with its Check Control list unavailable (provider start, resume, stale). */
function overheatWithoutCheckControl(elapsedMs: number): VehicleSnapshot {
  const s = scenario('overheat-check-control')(elapsedMs);
  s.checkControl = unavailable('not-reported');
  return s;
}

test('an active Check Control alert survives the list becoming unavailable and stays the same alert', () => {
  const engine = newEngine();
  const build = scenario('overheat-check-control');
  const up = raised(runScenario(engine, 'overheat-check-control', 0, 64 * SECOND));
  expect(up.map((e) => e.dedupKey)).toEqual(['cc:39']);
  const id = up[0].id;

  // Unknown for 20 minutes, twice the cooldown: nothing is cleared or raised.
  for (let t = 65 * SECOND; t <= 20 * MINUTE; t += SECOND) {
    expect(step(engine, overheatWithoutCheckControl(t), t)).toEqual([]);
  }
  expect(engine.active().map((e) => e.id)).toEqual([id]);

  // The car reports the same standing message again: the same alert, no new event, no pop-up.
  for (let t = 20 * MINUTE + SECOND; t <= 21 * MINUTE; t += SECOND) expect(step(engine, build(t), t)).toEqual([]);
  expect(engine.active().map((e) => e.id)).toEqual([id]);
  expect(engine.history()).toHaveLength(1);
  expect(engine.state().keys).toHaveLength(1);

  // The list is known again and no longer has the message: cleared.
  const gone = build(21 * MINUTE + SECOND);
  gone.checkControl = available([], null, 'mock', START + 21 * MINUTE + SECOND);
  const cleared = step(engine, gone, 21 * MINUTE + SECOND);
  expect(cleared).toEqual([expect.objectContaining({ id, active: false, clearedAt: START + 21 * MINUTE + SECOND })]);
  expect(engine.active()).toEqual([]);
});

test('a dwelling Check Control message neither raises nor restarts while the list is unavailable', () => {
  // Message 39 first appears at 60 s; dwell 4 s.
  const engine = newEngine();
  const build = scenario('overheat-check-control');
  expect(runScenario(engine, 'overheat-check-control', 0, 61 * SECOND)).toEqual([]); // 1 s of dwell
  for (let t = 62 * SECOND; t <= 200 * SECOND; t += SECOND) {
    expect(step(engine, overheatWithoutCheckControl(t), t)).toEqual([]);
  }
  expect(step(engine, build(201 * SECOND), 201 * SECOND)).toEqual([]); // 2 s
  expect(step(engine, build(202 * SECOND), 202 * SECOND)).toEqual([]); // 3 s
  expect(raised(step(engine, build(203 * SECOND), 203 * SECOND)).map((e) => e.dedupKey)).toEqual(['cc:39']);
});

test('service and fault alerts are held while their lists are unavailable', () => {
  const service = newEngine();
  const cruise = scenario('steady-cruise');
  expect(raised(step(service, cruise(0), 0))).toHaveLength(1);
  for (let t = SECOND; t <= 10 * SECOND; t += SECOND) {
    const s = cruise(t);
    s.serviceItems = unavailable('stale');
    expect(step(service, s, t)).toEqual([]);
  }
  expect(service.active().map((e) => e.dedupKey)).toEqual(['service:3:due-soon']);
  const none = cruise(11 * SECOND);
  none.serviceItems = available([], null, 'mock', START + 11 * SECOND);
  expect(step(service, none, 11 * SECOND)).toEqual([expect.objectContaining({ dedupKey: 'service:3:due-soon', active: false })]);

  const faults = newEngine();
  const stored = scenario('stored-faults');
  expect(raised(runScenario(faults, 'stored-faults', 0, 5 * SECOND))).toHaveLength(1);
  for (let t = 6 * SECOND; t <= 15 * MINUTE; t += 10 * SECOND) {
    const s = stored(t);
    s.faultCodes = unavailable('diagnostics-disabled');
    expect(step(faults, s, t)).toEqual([]);
  }
  expect(faults.active().map((e) => e.dedupKey)).toEqual(['fault:DEMO-ECU-A:DEMO-0001']);
  expect(runScenario(faults, 'stored-faults', 15 * MINUTE + SECOND, 16 * MINUTE)).toEqual([]);
  expect(faults.history()).toHaveLength(1);
});

test('an owner oil alert is held while the reading is unavailable and clears once it is back below the margin', () => {
  const engine = newEngine();
  const l = limits({ oilTempMaxC: 115 });
  for (let t = 0; t <= 5 * SECOND; t += SECOND) step(engine, withOil(t, 117), t, l);
  expect(engine.active().map((e) => e.dedupKey)).toEqual(['limit:oilTempMaxC']);

  for (let t = 6 * SECOND; t <= 20 * MINUTE; t += SECOND) {
    const s = withOil(t, 0);
    s.oilTemp = unavailable('stale');
    expect(step(engine, s, t, l)).toEqual([]);
  }
  expect(engine.active().map((e) => e.dedupKey)).toEqual(['limit:oilTempMaxC']);
  expect(engine.history()).toHaveLength(1);

  // Known again, still within the margin: the same alert; below the margin: cleared.
  const back = 20 * MINUTE + SECOND;
  expect(step(engine, withOil(back, 114), back, l)).toEqual([]);
  expect(engine.history()).toHaveLength(1);
  const cleared = step(engine, withOil(back + SECOND, 112), back + SECOND, l);
  expect(cleared).toEqual([expect.objectContaining({ dedupKey: 'limit:oilTempMaxC', active: false })]);
});

test('removing the owner limit clears its alert even while the reading is unavailable', () => {
  const engine = newEngine();
  const l = limits({ oilTempMaxC: 115 });
  for (let t = 0; t <= 5 * SECOND; t += SECOND) step(engine, withOil(t, 117), t, l);
  const s = withOil(6 * SECOND, 0);
  s.oilTemp = unavailable('not-reported');
  expect(step(engine, s, 6 * SECOND, l)).toEqual([]);
  const cleared = step(engine, s, 7 * SECOND, NO_LIMITS);
  expect(cleared).toEqual([expect.objectContaining({ dedupKey: 'limit:oilTempMaxC', active: false })]);
  expect(engine.active()).toEqual([]);
});

test('tyre alerts: known wheels are evaluated, unknown wheels are held', () => {
  const engine = newEngine();
  const l = limits({ tyrePressureDeviationBar: 0.3 });
  const lowTyre = scenario('low-tyre');
  /** The low-tyre picture without its own Check Control message, so only the tyre rule is under test. */
  const build = (t: number): VehicleSnapshot => {
    const s = lowTyre(t);
    s.checkControl = available([], null, 'mock', START + t);
    return s;
  };
  /** The low-tyre picture with the front right wheel also off its target by 0.5 bar. */
  const both = (t: number): VehicleSnapshot => {
    const s = build(t);
    const target = s.tyrePressureTarget.frontRight;
    if (!target.available) throw new Error('low-tyre has a front right target');
    s.tyrePressure.frontRight = available(target.value - 0.5, 'bar', 'mock', START + t);
    return s;
  };
  for (let t = 0; t <= 20 * SECOND; t += SECOND) step(engine, both(t), t, l);
  expect(engine.active().map((e) => e.dedupKey).sort()).toEqual(['limit:tyre:frontRight', 'limit:tyre:rearLeft']);

  // Rear left unknown (its pressure, then its target); front right back on target: only front right clears.
  const t1 = 21 * SECOND;
  const s1 = build(t1);
  s1.tyrePressure.rearLeft = unavailable('stale');
  expect(step(engine, s1, t1, l)).toEqual([expect.objectContaining({ dedupKey: 'limit:tyre:frontRight', active: false })]);
  for (let t = 22 * SECOND; t <= 15 * MINUTE; t += SECOND) {
    const s = build(t);
    s.tyrePressureTarget.rearLeft = unavailable('not-reported');
    expect(step(engine, s, t, l)).toEqual([]);
  }
  expect(engine.active().map((e) => e.dedupKey)).toEqual(['limit:tyre:rearLeft']);

  // Rear left known again and back on its target: cleared.
  const t2 = 15 * MINUTE + SECOND;
  const s2 = build(t2);
  const target = s2.tyrePressureTarget.rearLeft;
  if (!target.available) throw new Error('low-tyre has a rear left target');
  s2.tyrePressure.rearLeft = available(target.value, 'bar', 'mock', START + t2);
  expect(step(engine, s2, t2, l)).toEqual([expect.objectContaining({ dedupKey: 'limit:tyre:rearLeft', active: false })]);
  expect(engine.history()).toHaveLength(2);
});
