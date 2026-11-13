import { expect, test } from 'vitest';
import { ageMs, available, unavailable } from './reading';

test('ageMs is null for an unavailable reading and never negative', () => {
  expect(ageMs(unavailable('not-reported'), 1000)).toBeNull();
  expect(ageMs(available(92, '°C', 'mock', 5000), 1000)).toBe(0);      // clock went backwards
  expect(ageMs(available(92, '°C', 'mock', 400), 1000)).toBe(600);
});
