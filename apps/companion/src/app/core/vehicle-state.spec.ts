import type { StatusDto } from '@copilot/shared';
import { available, emptySnapshot, unavailable } from '@copilot/vehicle-core';
import type { VehicleSnapshot } from '@copilot/vehicle-core';
import { MOTION_FRESH_MS, isDemo, movingNow } from './vehicle-state';

const T = 1_000_000;

function withSpeed(speed: VehicleSnapshot['speed']): VehicleSnapshot {
  return { ...emptySnapshot(T), speed };
}

const STATUS: StatusDto = {
  version: '0.1.0',
  vehicle: { source: 'car', connected: true, lastSnapshotAt: 1, scenario: null },
  claude: { mode: 'live', model: 'claude-opus-5-5', voiceModel: 'claude-opus-5-5' },
  budget: { dayUsd: 0, dayLimitUsd: 1, monthUsd: 0, monthLimitUsd: 20 },
};

describe('movingNow', () => {
  it('mirrors the two constants of packages/vehicle-core/src/snapshot.ts', () => {
    expect(MOTION_FRESH_MS).toBe(120_000);
  });

  it('is true for a fresh speed above 3 km/h', () => {
    expect(movingNow(withSpeed(available(24, 'km/h', 'passive-signal', T)), T)).toBe(true);
    expect(movingNow(withSpeed(available(24, 'km/h', 'passive-signal', T)), T + MOTION_FRESH_MS)).toBe(true);
  });

  it('is false once the speed reading is older than two minutes: a car that went quiet is not still moving', () => {
    expect(movingNow(withSpeed(available(24, 'km/h', 'passive-signal', T)), T + MOTION_FRESH_MS + 1)).toBe(false);
    expect(movingNow(withSpeed(available(24, 'km/h', 'passive-signal', T)), T + 10 * 60 * 60_000)).toBe(false);
  });

  it('is false at 3 km/h or less, with no speed and with no snapshot', () => {
    expect(movingNow(withSpeed(available(3, 'km/h', 'passive-signal', T)), T)).toBe(false);
    expect(movingNow(withSpeed(unavailable('not-reported')), T)).toBe(false);
    expect(movingNow(null, T)).toBe(false);
  });

  it('counts a reading dated after now (clock went backwards) as fresh', () => {
    expect(movingNow(withSpeed(available(50, 'km/h', 'passive-signal', T + 60_000)), T)).toBe(true);
  });
});

describe('isDemo', () => {
  it('is true only when the backend says the vehicle source is mock', () => {
    expect(isDemo({ ...STATUS, vehicle: { ...STATUS.vehicle, source: 'mock' } })).toBe(true);
    expect(isDemo(STATUS)).toBe(false);
    expect(isDemo(null)).toBe(false);
  });
});
