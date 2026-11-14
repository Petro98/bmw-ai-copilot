import { Unit } from './reading';

/**
 * Signal catalogue: the single place that knows how a raw head-unit value becomes a reading.
 *
 * Every interface, field, member, scaling, invalid marker and unit below was read from the MIT-licensed
 * reference repository idrive7-apps at commit 4a8deb7 (local research copy, never shipped); the `source`
 * of each entry names the file and line. Research record: `.research/reports/telemetry.md` F1-F3.
 *
 * Nothing here talks to a vehicle: this module only describes and decodes values another component received.
 */

/** 'passive' = notified SOME/IP field, 'polled' = field read through its getter, 'diagnostic' = UDS read. */
export type Transport = 'passive' | 'polled' | 'diagnostic';

export interface SignalEntry {
  key: string;                     // e.g. 'engineRpm', 'tyrePressure.rearLeft'
  iface: string; field: string; member: string | null;
  transport: Transport;
  factor: number; offset: number;  // value = raw * factor + offset
  invalidFrom: number | null;      // raw >= invalidFrom is invalid
  unit: Unit | null;               // null when the unit follows the car's display setting
  verified: boolean; source: string;   // '<repo>@<commit>:<path>:<line>'
}

const REPO = 'idrive7-apps@4a8deb7';

const CDS = 'de.bmw.infotainment.vehicle.CDS';
const VEHICLE2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const KOMBI = 'de.bmw.infotainment.KombiIF';
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';

type Corner = 'frontLeft' | 'frontRight' | 'rearLeft' | 'rearRight';
// BMW member suffixes per corner: apps/live_data/signals.js:127 and :131 (FLH / FRH / RLH / RRH).
const CORNERS: ReadonlyArray<[Corner, string]> = [
  ['frontLeft', 'FLH'], ['frontRight', 'FRH'], ['rearLeft', 'RLH'], ['rearRight', 'RRH'],
];

/**
 * Tyre pressures: 0.1 x raw in the car's own pressure unit (bar, kPa or psi, taken from
 * Vehicle.statusNewCurrentUnitsStatusExt), 65532 and up = no value (BMW x_call's converter):
 * apps/redline/tyres.js:9-13, apps/car_vitals/main.js:357. Hence `unit: null`.
 * TPMS may never notify, so it is read every 10 s: apps/live_data/signals.js:27-28.
 */
function tyreEntries(
  prefix: 'tyrePressure' | 'tyrePressureTarget', field: string, memberPrefix: string, sourceLine: number,
): SignalEntry[] {
  return CORNERS.map(([corner, suffix]) => ({
    key: `${prefix}.${corner}`,
    iface: TPMS, field, member: memberPrefix + suffix,
    transport: 'polled' as Transport,
    factor: 0.1, offset: 0, invalidFrom: 65532, unit: null,
    verified: true, source: `${REPO}:apps/redline/tyres.js:${sourceLine}`,
  }));
}

const ENTRIES: SignalEntry[] = [
  // CDS.statusEngineSpeed2.actualValueRPMEngineCrankshaft, k 0.25, 65535 = no value (also kit/runtime/car.js:22).
  {
    key: 'engineRpm', iface: CDS, field: 'statusEngineSpeed2', member: 'actualValueRPMEngineCrankshaft',
    transport: 'passive', factor: 0.25, offset: 0, invalidFrom: 65535, unit: 'rpm',
    verified: true, source: `${REPO}:apps/live_data/signals.js:63`,
  },
  // Vehicle2.statusCarSpeed2.speedVehicleCentreOfGravity, k 0.015625, 65535 = no value (also kit/runtime/car.js:23).
  {
    key: 'speed', iface: VEHICLE2, field: 'statusCarSpeed2', member: 'speedVehicleCentreOfGravity',
    transport: 'passive', factor: 0.015625, offset: 0, invalidFrom: 65535, unit: 'km/h',
    verified: true, source: `${REPO}:apps/live_data/signals.js:108`,
  },
  // CDS.statusEngineTemperature.temperatureEngineOilDrive, factor 1 (k omitted, signals.js:180), offset -48,
  // 255 = no value (also kit/runtime/car.js:25).
  {
    key: 'oilTemp', iface: CDS, field: 'statusEngineTemperature', member: 'temperatureEngineOilDrive',
    transport: 'passive', factor: 1, offset: -48, invalidFrom: 255, unit: '°C',
    verified: true, source: `${REPO}:apps/live_data/signals.js:75`,
  },
  // CDS.statusEngineTemperature.temperatureEngineDrive, factor 1, offset -48, 255 = no value.
  {
    key: 'coolantTemp', iface: CDS, field: 'statusEngineTemperature', member: 'temperatureEngineDrive',
    transport: 'passive', factor: 1, offset: -48, invalidFrom: 255, unit: '°C',
    verified: true, source: `${REPO}:apps/live_data/signals.js:74`,
  },
  // KombiIF.statusRangeTankStatus.fluidLevelFuelTank, litres, factor 1, 255 and up = no value.
  // KombiIF may never notify, so it is read every 10 s: apps/live_data/signals.js:27-28.
  {
    key: 'fuelLevel', iface: KOMBI, field: 'statusRangeTankStatus', member: 'fluidLevelFuelTank',
    transport: 'polled', factor: 1, offset: 0, invalidFrom: 255, unit: 'l',
    verified: true, source: `${REPO}:apps/live_data/signals.js:81`,
  },
  // Same field, member range, km, 4095 and up = no value.
  {
    key: 'range', iface: KOMBI, field: 'statusRangeTankStatus', member: 'range',
    transport: 'polled', factor: 1, offset: 0, invalidFrom: 4095, unit: 'km',
    verified: true, source: `${REPO}:apps/live_data/signals.js:84`,
  },
  // Same field, member mileageKilometre, km, 16777215 and up = no value.
  {
    key: 'odometer', iface: KOMBI, field: 'statusRangeTankStatus', member: 'mileageKilometre',
    transport: 'polled', factor: 1, offset: 0, invalidFrom: 16777215, unit: 'km',
    verified: true, source: `${REPO}:apps/live_data/signals.js:85`,
  },
  // CDS.statusBattery2.conditionBatteryChargingCondition, a charge percentage (not volts). Redline and eDrive
  // accept only 0..100 (apps/redline/electrical.js:102, apps/edrive/main.js:338), so 101 and up = no value.
  // Live Data is looser (151 and up = no value, apps/live_data/signals.js:120); the stricter bound is kept.
  {
    key: 'battery12vCharge', iface: CDS, field: 'statusBattery2', member: 'conditionBatteryChargingCondition',
    transport: 'passive', factor: 1, offset: 0, invalidFrom: 101, unit: '%',
    verified: true, source: `${REPO}:apps/redline/electrical.js:102`,
  },
  // TPMS.statusTyrePressure.actualValuePressureTyre{FLH,FRH,RLH,RRH}: apps/redline/tyres.js:9.
  ...tyreEntries('tyrePressure', 'statusTyrePressure', 'actualValuePressureTyre', 9),
  // TPMS.statusTargetTyrePressure.targetPressureTyre{FLH,FRH,RLH,RRH}, the same scaling: apps/redline/tyres.js:11.
  ...tyreEntries('tyrePressureTarget', 'statusTargetTyrePressure', 'targetPressureTyre', 11),
];

export const SIGNAL_CATALOGUE: ReadonlyArray<SignalEntry> = Object.freeze(ENTRIES.map((e) => Object.freeze(e)));

export function findSignal(key: string): SignalEntry | undefined {
  for (const entry of SIGNAL_CATALOGUE) {
    if (entry.key === key) return entry;
  }
  return undefined;
}

/** value = raw * factor + offset; null for NaN, non-finite input or a raw value at or above the invalid marker. */
export function decodeRaw(entry: SignalEntry, raw: number): number | null {
  if (typeof raw !== 'number' || !isFinite(raw)) return null;
  if (entry.invalidFrom !== null && raw >= entry.invalidFrom) return null;
  return raw * entry.factor + entry.offset;
}
