import type { ScenarioId } from '../index';
import { Available, Reading, Unit, available, unavailable } from '../reading';
import {
  CheckControlMessage, FaultCode, GearStage, ServiceItem, TyreSet, VehicleCondition, VehicleSnapshot,
} from '../snapshot';

/**
 * Scripted mock scenarios for running and testing everything without a car.
 *
 * EVERY NUMBER IN THIS FILE IS ILLUSTRATIVE DEMO DATA. None of them is a BMW value, a BMW limit or a
 * threshold of any kind, and nothing may treat them as one: they only make a believable picture for the
 * panel, the prompt and the tests. The Check Control ids and texts are the ones the implementation plan
 * prescribes for the demo, not decoded car messages.
 *
 * Each scenario is a pure function of the time elapsed since it started (no Date, no Math.random), so the
 * same elapsed time always gives the same snapshot. Units are metric. Every available reading has
 * source 'mock'. The diagnostic-only readings are never available from the mock.
 */
export interface Scenario { id: ScenarioId; title: string; build(elapsedMs: number, now: number): VehicleSnapshot }

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function mock<T>(value: T, unit: Unit | null, at: number): Available<T> {
  return available(value, unit, 'mock', at);
}

/** Linear progress 0..1 of `elapsedMs` through `durationMs`. */
function progress(elapsedMs: number, durationMs: number): number {
  if (elapsedMs <= 0) return 0;
  return elapsedMs >= durationMs ? 1 : elapsedMs / durationMs;
}

function tyres(fl: number, fr: number, rl: number, rr: number, at: number): TyreSet<Reading<number>> {
  return {
    frontLeft: mock(fl, 'bar', at), frontRight: mock(fr, 'bar', at),
    rearLeft: mock(rl, 'bar', at), rearRight: mock(rr, 'bar', at),
  };
}

function tyresUnavailable(reason: 'not-reported' | 'not-on-this-vehicle'): TyreSet<Reading<number>> {
  return {
    frontLeft: unavailable(reason), frontRight: unavailable(reason),
    rearLeft: unavailable(reason), rearRight: unavailable(reason),
  };
}

/** The car's own demo tyre targets (front 2.3, rear 2.4 bar). */
function demoTargets(at: number): TyreSet<Reading<number>> {
  return tyres(2.3, 2.3, 2.4, 2.4, at);
}

/**
 * Brake fluid due soon. CBS id 3 = brake fluid per the M-Copilot naming recorded in
 * .research/reports/telemetry.md (CBS section, "cBSIdentifier ... 3 Brake fluid"); demo item only.
 */
const BRAKE_FLUID_DUE_SOON: ServiceItem = { id: 3, name: 'Гальмівна рідина', status: 'due-soon', dueText: 'через 3 місяці' };

interface Drive {
  condition: VehicleCondition;
  speed: number; rpm: number; gear: string; gearStage: GearStage; driveMode: string;
  oil: number; coolant: number;
}

/**
 * A complete, fully available demo snapshot (the steady-cruise picture) with the given driving values.
 * The diagnostic-only readings are unavailable('diagnostics-disabled'); fault codes are not reported because
 * no fault read happened.
 */
function demoSnapshot(now: number, d: Drive): VehicleSnapshot {
  return {
    takenAt: now,
    condition: mock(d.condition, null, now),
    engineRpm: mock(d.rpm, 'rpm', now),
    speed: mock(d.speed, 'km/h', now),
    oilTemp: mock(d.oil, '°C', now),
    coolantTemp: mock(d.coolant, '°C', now),
    gear: mock(d.gear, null, now),
    gearStage: mock(d.gearStage, null, now),
    driveMode: mock(d.driveMode, null, now),
    fuelLevel: mock(41, 'l', now),
    range: mock(452, 'km', now),
    odometer: mock(48210, 'km', now),
    battery12vCharge: mock(84, '%', now),
    battery12vVoltage: unavailable('diagnostics-disabled'),
    intakeTemp: unavailable('diagnostics-disabled'),
    boostPressure: unavailable('diagnostics-disabled'),
    engineLoad: unavailable('diagnostics-disabled'),
    tyrePressure: tyres(2.3, 2.3, 2.4, 2.4, now),
    tyrePressureTarget: demoTargets(now),
    checkControl: mock<CheckControlMessage[]>([], null, now),
    serviceItems: mock<ServiceItem[]>([], null, now),
    faultCodes: unavailable('not-reported'),
  };
}

const CRUISE: Drive = {
  condition: 'driving', speed: 100, rpm: 1850, gear: 'D8', gearStage: 'D', driveMode: 'Comfort', oil: 92, coolant: 88,
};

const STANDING: Drive = {
  condition: 'parked', speed: 0, rpm: 0, gear: 'P', gearStage: 'P', driveMode: 'Comfort', oil: 20, coolant: 20,
};

function steadyCruise(_elapsedMs: number, now: number): VehicleSnapshot {
  const s = demoSnapshot(now, CRUISE);
  s.serviceItems = mock([Object.assign({}, BRAKE_FLUID_DUE_SOON)], null, now);
  return s;
}

/** Coolant 20 -> 88 °C and oil 18 -> 92 °C over 15 minutes; oil lags (slow start), coolant leads (fast start). */
function coldStart(elapsedMs: number, now: number): VehicleSnapshot {
  const p = progress(elapsedMs, 15 * MINUTE);
  const coolant = Math.round(20 + 68 * (1 - (1 - p) * (1 - p)));
  const oil = Math.round(18 + 74 * p * p);
  const idling = elapsedMs < 2 * MINUTE;
  return demoSnapshot(now, idling
    ? { condition: 'driving', speed: 0, rpm: 900, gear: 'P', gearStage: 'P', driveMode: 'Comfort', oil, coolant }
    : { condition: 'driving', speed: 50, rpm: 1400, gear: 'D3', gearStage: 'D', driveMode: 'Comfort', oil, coolant });
}

/** Speed and rpm swing on a 20 s cycle; oil rises 100 -> 118 °C over 5 minutes and stays there. */
function spirited(elapsedMs: number, now: number): VehicleSnapshot {
  const phase = (2 * Math.PI * (elapsedMs % (20 * SECOND))) / (20 * SECOND);
  const speed = Math.round(85 + 35 * Math.sin(phase));
  const rpm = Math.round(4000 + 1800 * Math.sin(phase + Math.PI / 4));
  const gearNumber = speed < 70 ? 3 : speed < 100 ? 4 : 5;
  const p = progress(elapsedMs, 5 * MINUTE);
  return demoSnapshot(now, {
    condition: 'driving', speed, rpm, gear: 'D' + gearNumber, gearStage: 'D', driveMode: 'Sport',
    oil: Math.round(100 + 18 * p), coolant: Math.round(95 + 7 * p),
  });
}

/** Coolant climbs 100 -> 120 °C (past 110 at 40 s); from 60 s a critical Check Control message is active. */
function overheat(elapsedMs: number, now: number): VehicleSnapshot {
  const coolant = Math.round(100 + 20 * progress(elapsedMs, 80 * SECOND));
  const oil = Math.round(104 + 11 * progress(elapsedMs, 120 * SECOND));
  const s = demoSnapshot(now, {
    condition: 'driving', speed: 60, rpm: 1600, gear: 'D5', gearStage: 'D', driveMode: 'Comfort', oil, coolant,
  });
  const at = 60 * SECOND;
  if (elapsedMs >= at) {
    s.checkControl = mock<CheckControlMessage[]>(
      [{ id: 39, text: 'Температура двигуна. Обережно зупиніться', severity: 'critical', since: now - (elapsedMs - at) }],
      null, now);
  }
  return s;
}

/**
 * Rear-left tyre 2.0 bar against a 2.4 bar target. From 30 s Check Control 63 is active with the car's text;
 * from 90 s the same message arrives as its id-only variant (text null) to exercise the id-only path.
 */
function lowTyre(elapsedMs: number, now: number): VehicleSnapshot {
  const s = demoSnapshot(now, CRUISE);
  s.tyrePressure = tyres(2.3, 2.3, 2.0, 2.4, now);
  const at = 30 * SECOND;
  if (elapsedMs >= at) {
    const text = elapsedMs >= 90 * SECOND ? null : 'Тиск у шинах: задня ліва';
    s.checkControl = mock<CheckControlMessage[]>(
      [{ id: 63, text, severity: 'warning', since: now - (elapsedMs - at) }], null, now);
  }
  return s;
}

/** Parked; the 12 V charge falls from 62 % to 48 % over 10 minutes, then stays at 48 %. */
function weakBattery(elapsedMs: number, now: number): VehicleSnapshot {
  const s = demoSnapshot(now, STANDING);
  s.battery12vCharge = mock(Math.round(62 - 14 * progress(elapsedMs, 10 * MINUTE)), '%', now);
  return s;
}

/** Standing with the ignition on after a fault read: two stored codes, one active with the warning lamp. */
function storedFaults(_elapsedMs: number, now: number): VehicleSnapshot {
  const s = demoSnapshot(now, { ...STANDING, condition: 'ignition-on', oil: 35, coolant: 32 });
  // Placeholder ECU names and codes: deliberately not real BMW identifiers.
  const faults: FaultCode[] = [
    { ecu: 'DEMO-ECU-A', code: 'DEMO-0001', text: null, activeNow: true, warningLamp: true },
    { ecu: 'DEMO-ECU-B', code: 'DEMO-0002', text: null, activeNow: false, warningLamp: false },
  ];
  s.faultCodes = mock(faults, null, now);
  return s;
}

/** Nothing reported at all; this vehicle has no tyre pressure monitoring. */
function signalsMissing(_elapsedMs: number, now: number): VehicleSnapshot {
  return {
    takenAt: now,
    condition: unavailable('not-reported'),
    engineRpm: unavailable('not-reported'),
    speed: unavailable('not-reported'),
    oilTemp: unavailable('not-reported'),
    coolantTemp: unavailable('not-reported'),
    gear: unavailable('not-reported'),
    gearStage: unavailable('not-reported'),
    driveMode: unavailable('not-reported'),
    fuelLevel: unavailable('not-reported'),
    range: unavailable('not-reported'),
    odometer: unavailable('not-reported'),
    battery12vCharge: unavailable('not-reported'),
    battery12vVoltage: unavailable('diagnostics-disabled'),
    intakeTemp: unavailable('diagnostics-disabled'),
    boostPressure: unavailable('diagnostics-disabled'),
    engineLoad: unavailable('diagnostics-disabled'),
    tyrePressure: tyresUnavailable('not-on-this-vehicle'),
    tyrePressureTarget: tyresUnavailable('not-on-this-vehicle'),
    checkControl: unavailable('not-reported'),
    serviceItems: unavailable('not-reported'),
    faultCodes: unavailable('not-reported'),
  };
}

/** Parked and asleep: the engine temperatures were last received 20 minutes ago. */
function parked(_elapsedMs: number, now: number): VehicleSnapshot {
  const s = demoSnapshot(now, STANDING);
  const lastHeard = now - 20 * MINUTE;
  s.oilTemp = mock(64, '°C', lastHeard);
  s.coolantTemp = mock(58, '°C', lastHeard);
  return s;
}

export const SCENARIOS: ReadonlyArray<Scenario> = [
  { id: 'cold-start', title: 'Холодний пуск і прогрів', build: coldStart },
  { id: 'steady-cruise', title: 'Рівномірний рух трасою', build: steadyCruise },
  { id: 'spirited', title: 'Динамічна їзда', build: spirited },
  { id: 'overheat-check-control', title: 'Перегрів і повідомлення Check Control', build: overheat },
  { id: 'low-tyre', title: 'Низький тиск у шині', build: lowTyre },
  { id: 'weak-battery', title: 'Слабкий акумулятор 12 В', build: weakBattery },
  { id: 'stored-faults', title: 'Збережені коди помилок', build: storedFaults },
  { id: 'signals-missing', title: 'Сигнали відсутні', build: signalsMissing },
  { id: 'parked', title: 'Авто на стоянці', build: parked },
];
