import { Reading, Unavailable, unavailable } from './reading';

export type VehicleCondition =
  | 'parked' | 'standby' | 'living' | 'ignition-on' | 'starting' | 'driving' | 'stopping';
export type GearStage = 'P' | 'R' | 'N' | 'D';
export type Severity = 'info' | 'warning' | 'critical';
export interface CheckControlMessage { id: number; text: string | null; severity: Severity; since: number }
/**
 * A BMW service (CBS) item's state. 'due-now' is what the car reports for its most urgent colour (car/src/provider/
 * raw-decoders.ts); the car has no distinct overdue state, so 'overdue' never comes from the car (mock and future use).
 */
export type ServiceStatus = 'ok' | 'due-soon' | 'due-now' | 'overdue' | 'unknown';
export interface ServiceItem { id: number; name: string | null; status: ServiceStatus; dueText: string | null }
export interface FaultCode { ecu: string; code: string; text: string | null; activeNow: boolean; warningLamp: boolean }
export interface TyreSet<T> { frontLeft: T; frontRight: T; rearLeft: T; rearRight: T }

export interface VehicleSnapshot {
  takenAt: number;
  condition: Reading<VehicleCondition>;
  engineRpm: Reading<number>;
  speed: Reading<number>;
  oilTemp: Reading<number>;
  coolantTemp: Reading<number>;
  gear: Reading<string>;                 // 'D4', 'R', 'N', 'P'
  gearStage: Reading<GearStage>;
  driveMode: Reading<string>;
  fuelLevel: Reading<number>;
  range: Reading<number>;
  odometer: Reading<number>;
  battery12vCharge: Reading<number>;     // percent
  battery12vVoltage: Reading<number>;    // diagnostic read only
  intakeTemp: Reading<number>;           // diagnostic read only
  boostPressure: Reading<number>;        // diagnostic read only
  engineLoad: Reading<number>;           // diagnostic read only
  tyrePressure: TyreSet<Reading<number>>;
  tyrePressureTarget: TyreSet<Reading<number>>;
  checkControl: Reading<CheckControlMessage[]>;
  serviceItems: Reading<ServiceItem[]>;
  faultCodes: Reading<FaultCode[]>;
}

export type SnapshotKey = Exclude<keyof VehicleSnapshot, 'takenAt'>;

/**
 * Above this speed the car counts as moving.
 * Kit convention: idrive7-apps kit/runtime/parked.js
 * (idrive7-apps@4a8deb7:kit/runtime/parked.js:18 `MAX_KMH = 3`, :29 `speed > MAX_KMH`).
 */
export const MOVING_ABOVE_KMH = 3;

function notReported(): Unavailable {
  return unavailable('not-reported');
}

function notReportedTyres(): TyreSet<Reading<number>> {
  return { frontLeft: notReported(), frontRight: notReported(), rearLeft: notReported(), rearRight: notReported() };
}

/** Every reading unavailable('not-reported'). Each call returns fresh objects. */
export function emptySnapshot(now: number): VehicleSnapshot {
  return {
    takenAt: now,
    condition: notReported(),
    engineRpm: notReported(),
    speed: notReported(),
    oilTemp: notReported(),
    coolantTemp: notReported(),
    gear: notReported(),
    gearStage: notReported(),
    driveMode: notReported(),
    fuelLevel: notReported(),
    range: notReported(),
    odometer: notReported(),
    battery12vCharge: notReported(),
    battery12vVoltage: notReported(),
    intakeTemp: notReported(),
    boostPressure: notReported(),
    engineLoad: notReported(),
    tyrePressure: notReportedTyres(),
    tyrePressureTarget: notReportedTyres(),
    checkControl: notReported(),
    serviceItems: notReported(),
    faultCodes: notReported(),
  };
}

/** null when speed is unavailable. */
export function isMoving(s: VehicleSnapshot): boolean | null {
  if (!s.speed.available) return null;
  return s.speed.value > MOVING_ABOVE_KMH;
}

/**
 * How old a speed reading may be and still say whether the car is moving. The head unit uploads a snapshot once a
 * minute while driving, so two minutes covers one missed upload; this is a freshness window, not a vehicle limit.
 */
export const MOTION_FRESH_MS = 120000;

/**
 * Whether the car is moving right now, as far as `now` can tell: null when the speed is unavailable or its reading
 * is older than MOTION_FRESH_MS (a car that stopped reporting is not "still moving"). A reading dated after `now`
 * (clock went backwards) counts as fresh.
 */
export function isMovingNow(s: VehicleSnapshot, now: number): boolean | null {
  if (!s.speed.available) return null;
  if (now - s.speed.at > MOTION_FRESH_MS) return null;
  return s.speed.value > MOVING_ABOVE_KMH;
}

/** True only when the gear stage is available and 'R'. */
export function isReversing(s: VehicleSnapshot): boolean {
  return s.gearStage.available && s.gearStage.value === 'R';
}
