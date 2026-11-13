import { expect, test } from 'vitest';
import { available } from './reading';
import { emptySnapshot, isMoving, isMovingNow, isReversing, MOTION_FRESH_MS, type ServiceItem, type ServiceStatus } from './snapshot';

test('emptySnapshot reports every reading as not-reported', () => {
  const s = emptySnapshot(7);
  expect(s.takenAt).toBe(7);
  expect(s.oilTemp).toEqual({ available: false, reason: 'not-reported' });
  expect(s.tyrePressure.rearLeft).toEqual({ available: false, reason: 'not-reported' });
  expect(s.checkControl.available).toBe(false);
});

test('isMoving uses the 3 km/h convention and is null without speed', () => {
  expect(isMoving(emptySnapshot(0))).toBeNull();
  expect(isMoving({ ...emptySnapshot(0), speed: available(3, 'km/h', 'mock', 0) })).toBe(false);
  expect(isMoving({ ...emptySnapshot(0), speed: available(3.1, 'km/h', 'mock', 0) })).toBe(true);
});

test('isReversing is false unless the gear stage is known to be R', () => {
  expect(isReversing(emptySnapshot(0))).toBe(false);
  expect(isReversing({ ...emptySnapshot(0), gearStage: available('R', null, 'mock', 0) })).toBe(true);
});

test('isMovingNow needs a fresh speed reading', () => {
  const at = 1000000;
  const driving = { ...emptySnapshot(at), speed: available(60, 'km/h', 'mock', at) };
  expect(isMovingNow(emptySnapshot(at), at)).toBeNull();
  expect(isMovingNow(driving, at)).toBe(true);
  expect(isMovingNow(driving, at + MOTION_FRESH_MS)).toBe(true);
  expect(isMovingNow(driving, at + MOTION_FRESH_MS + 1)).toBeNull();        // the car stopped reporting
  expect(isMovingNow(driving, at - 5000)).toBe(true);                       // clock went backwards
  expect(isMovingNow({ ...driving, speed: available(0, 'km/h', 'mock', at) }, at)).toBe(false);
});

test('a service item can be due now, the state the car reports, distinct from overdue', () => {
  const statuses: ServiceStatus[] = ['ok', 'due-soon', 'due-now', 'overdue', 'unknown'];
  const item: ServiceItem = { id: 3, name: null, status: 'due-now', dueText: null };
  expect(statuses).toContain(item.status);
  expect(item.status).not.toBe('overdue');
});
