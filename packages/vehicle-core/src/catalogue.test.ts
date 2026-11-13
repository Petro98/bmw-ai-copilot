import { expect, test } from 'vitest';
import { decodeRaw, findSignal, SIGNAL_CATALOGUE } from './catalogue';

test('decodes the documented scalings', () => {
  expect(decodeRaw(findSignal('engineRpm')!, 7400)).toBe(1850);
  expect(decodeRaw(findSignal('speed')!, 6400)).toBe(100);
  expect(decodeRaw(findSignal('oilTemp')!, 140)).toBe(92);
  expect(decodeRaw(findSignal('coolantTemp')!, 136)).toBe(88);
  expect(decodeRaw(findSignal('tyrePressure.rearLeft')!, 24)).toBeCloseTo(2.4, 5);
});

test('returns null at and above the invalid sentinel, and for junk', () => {
  expect(decodeRaw(findSignal('engineRpm')!, 65535)).toBeNull();
  expect(decodeRaw(findSignal('oilTemp')!, 255)).toBeNull();
  expect(decodeRaw(findSignal('range')!, 4095)).toBeNull();
  expect(decodeRaw(findSignal('battery12vCharge')!, 151)).toBeNull();
  expect(decodeRaw(findSignal('speed')!, NaN)).toBeNull();
  expect(decodeRaw(findSignal('speed')!, Infinity)).toBeNull();
});

test('every entry carries a provenance string and unverified entries are flagged', () => {
  for (const e of SIGNAL_CATALOGUE) {
    expect(e.source).toMatch(/^(idrive7-apps|idrive7-custom-apps)@[0-9a-f]{7}:.+:\d+$/);
    expect(typeof e.verified).toBe('boolean');
  }
});

test('keys are unique', () => {
  expect(new Set(SIGNAL_CATALOGUE.map((e) => e.key)).size).toBe(SIGNAL_CATALOGUE.length);
});
