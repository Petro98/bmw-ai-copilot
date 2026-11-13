import type { StatusDto } from '@copilot/shared';
import type { VehicleSnapshot } from '@copilot/vehicle-core';

/**
 * Same values as `MOVING_ABOVE_KMH` and `MOTION_FRESH_MS` in packages/vehicle-core/src/snapshot.ts, repeated here
 * because the panel imports vehicle-core type-only. 3 km/h is the kit convention
 * (idrive7-apps@4a8deb7:kit/runtime/parked.js:18 `MAX_KMH = 3`); two minutes is a freshness window (one missed
 * once-a-minute upload from the head unit), not a vehicle limit.
 */
export const MOVING_ABOVE_KMH = 3;
export const MOTION_FRESH_MS = 120_000;

/**
 * Readings older than this are not shown as "now". Same value as `DEFAULT_OFFLINE_AFTER_MS` in
 * apps/backend/src/features/car-link/car-link-provider.ts: the window in which the backend counts the car as connected.
 */
export const CURRENT_FOR_MS = 180_000;

/**
 * The rule of `isMovingNow` (packages/vehicle-core/src/snapshot.ts) measured against the phone's clock: moving only
 * when the speed is available, no older than MOTION_FRESH_MS and above 3 km/h. A reading dated after `now` counts as
 * fresh. An unknown or stale speed counts as not moving here (isMovingNow returns null for it).
 */
export function movingNow(snapshot: VehicleSnapshot | null, now: number): boolean {
  const speed = snapshot?.speed;
  if (!speed || !speed.available) return false;
  if (now - speed.at > MOTION_FRESH_MS) return false;
  return speed.value > MOVING_ABOVE_KMH;
}

/** True when the backend reports that its vehicle data comes from the built-in simulation, not from a car. */
export function isDemo(status: StatusDto | null): boolean {
  return status?.vehicle.source === 'mock';
}

/** The mark for simulated data and its one-line explanation (Ukrainian, sentence case: docs/design/README.md). */
export const DEMO_LABEL = 'ДЕМО-ДАНІ';
export const DEMO_TEXT = 'Імітовані показники і сповіщення, а не дані вашого авто.';
