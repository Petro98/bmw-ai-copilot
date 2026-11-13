import { expect, test } from 'vitest';
import { available } from './reading';
import { emptySnapshot, isMoving, isReversing } from './snapshot';

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
