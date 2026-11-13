import { describe, expect, test } from 'vitest';
import {
  available,
  emptySnapshot,
  unavailable,
  type Clock,
  type VehicleCondition,
  type VehicleSnapshot,
} from '@copilot/vehicle-core';
import { IDLE_FALLBACK_MS, PowerGate, type PowerState } from './power-gate';

function manualClock(start: number): Clock & { t: number } {
  const clock = {
    t: start,
    now(): number {
      return clock.t;
    },
  };
  return clock;
}

function withCondition(condition: VehicleCondition, at: number): VehicleSnapshot {
  const s = emptySnapshot(at);
  s.condition = available(condition, null, 'passive-signal', at);
  return s;
}

function noCondition(at: number, speedKmh: number | null, speedAt = at): VehicleSnapshot {
  const s = emptySnapshot(at);
  s.condition = unavailable('not-reported');
  if (speedKmh !== null) s.speed = available(speedKmh, 'km/h', 'passive-signal', speedAt);
  return s;
}

function recorder(gate: PowerGate): Array<[PowerState, PowerState]> {
  const calls: Array<[PowerState, PowerState]> = [];
  gate.onChange((next, previous) => {
    calls.push([next, previous]);
  });
  return calls;
}

describe('PowerGate', () => {
  test('IDLE_FALLBACK_MS is 15 minutes', () => {
    expect(IDLE_FALLBACK_MS).toBe(900_000);
  });

  test('the initial state is awake', () => {
    const gate = new PowerGate({ clock: manualClock(1_000) });
    expect(gate.state()).toBe('awake');
  });

  test.each<[VehicleCondition, PowerState]>([
    ['parked', 'asleep'],
    ['standby', 'asleep'],
    ['living', 'awake'],
    ['ignition-on', 'awake'],
    ['starting', 'awake'],
    ['stopping', 'awake'],
    ['driving', 'driving'],
  ])('condition %s → %s', (condition, expected) => {
    const clock = manualClock(1_000);
    const gate = new PowerGate({ clock });
    expect(gate.update(withCondition(condition, 1_000))).toBe(expected);
    expect(gate.state()).toBe(expected);
  });

  test('condition unavailable and speed above MOVING_ABOVE_KMH → driving', () => {
    const gate = new PowerGate({ clock: manualClock(1_000) });
    expect(gate.update(noCondition(1_000, 50))).toBe('driving');
  });

  test('condition unavailable and speed at or below MOVING_ABOVE_KMH → awake', () => {
    const gate = new PowerGate({ clock: manualClock(1_000) });
    expect(gate.update(noCondition(1_000, 3))).toBe('awake');
  });

  test('condition unavailable and speed unavailable → awake', () => {
    const gate = new PowerGate({ clock: manualClock(1_000) });
    expect(gate.update(noCondition(1_000, null))).toBe('awake');
  });

  test('a condition flicker driving → stopping → parked notifies each change exactly once', () => {
    const clock = manualClock(1_000);
    const gate = new PowerGate({ clock });
    const calls = recorder(gate);
    gate.update(withCondition('driving', 1_000));
    gate.update(withCondition('driving', 1_000));
    clock.t = 2_000;
    gate.update(withCondition('stopping', 2_000));
    gate.update(withCondition('stopping', 2_000));
    clock.t = 3_000;
    gate.update(withCondition('parked', 3_000));
    gate.update(withCondition('parked', 3_000));
    expect(calls).toEqual([
      ['driving', 'awake'],
      ['awake', 'driving'],
      ['asleep', 'awake'],
    ]);
  });

  test('an unsubscribed listener is not called again', () => {
    const gate = new PowerGate({ clock: manualClock(1_000) });
    const calls: PowerState[] = [];
    const off = gate.onChange((next) => {
      calls.push(next);
    });
    gate.update(withCondition('driving', 1_000));
    off();
    gate.update(withCondition('parked', 1_000));
    expect(calls).toEqual(['driving']);
  });

  test('with no condition and no fresh reading for 15 minutes the gate falls asleep', () => {
    const clock = manualClock(10_000);
    const gate = new PowerGate({ clock });
    const calls = recorder(gate);
    const s = noCondition(10_000, 0);
    expect(gate.update(s)).toBe('awake');
    clock.t = 10_000 + IDLE_FALLBACK_MS - 1;
    expect(gate.update(s)).toBe('awake');
    clock.t = 10_000 + IDLE_FALLBACK_MS;
    expect(gate.update(s)).toBe('asleep');
    expect(calls).toEqual([['asleep', 'awake']]);
  });

  test('the idle fallback honours a custom idleFallbackMs', () => {
    const clock = manualClock(0);
    const gate = new PowerGate({ clock, idleFallbackMs: 60_000 });
    const s = noCondition(0, null);
    gate.update(s);
    clock.t = 60_000;
    expect(gate.update(s)).toBe('asleep');
  });

  test('a fresh reading wakes it', () => {
    const clock = manualClock(10_000);
    const gate = new PowerGate({ clock });
    gate.update(noCondition(10_000, 0));
    clock.t = 10_000 + IDLE_FALLBACK_MS;
    expect(gate.update(noCondition(10_000, 0))).toBe('asleep');
    clock.t += 1_000;
    const calls = recorder(gate);
    expect(gate.update(noCondition(clock.t, 0, clock.t))).toBe('awake');
    expect(calls).toEqual([['awake', 'asleep']]);
  });

  test('a polled tyre reading re-stamped later is not activity', () => {
    const clock = manualClock(0);
    const gate = new PowerGate({ clock });
    const s = noCondition(0, null);
    gate.update(s);
    clock.t = IDLE_FALLBACK_MS - 1_000;
    s.tyrePressure.rearLeft = available(2.3, 'bar', 'polled-signal', clock.t);
    expect(gate.update(s)).toBe('awake');
    clock.t = IDLE_FALLBACK_MS;
    expect(gate.update(s)).toBe('asleep');
  });

  test('condition unavailable and an unchanged polled value re-stamped every 10 s → asleep after the fallback', () => {
    const clock = manualClock(0);
    const gate = new PowerGate({ clock });
    const calls = recorder(gate);
    let state: PowerState = 'awake';
    for (let t = 0; t <= 16 * 60_000; t += 10_000) {
      clock.t = t;
      const s = noCondition(t, null);
      s.fuelLevel = available(42, '%', 'polled-signal', t);          // same value, new stamp, every poll
      s.tyrePressure.frontLeft = available(2.4, 'bar', 'polled-signal', t);
      state = gate.update(s);
      if (t < IDLE_FALLBACK_MS) expect(state, String(t)).toBe('awake');
    }
    expect(state).toBe('asleep');
    expect(calls).toEqual([['asleep', 'awake']]);
  });

  test('a diagnostic reading re-stamped later is not activity either', () => {
    const clock = manualClock(0);
    const gate = new PowerGate({ clock });
    let state: PowerState = 'awake';
    for (let t = 0; t <= IDLE_FALLBACK_MS; t += 10_000) {
      clock.t = t;
      const s = noCondition(t, null);
      s.coolantTemp = available(90, '°C', 'diagnostic-read', t);
      state = gate.update(s);
    }
    expect(state).toBe('asleep');
  });

  test('condition unavailable and a passive reading advancing → stays awake', () => {
    const clock = manualClock(0);
    const gate = new PowerGate({ clock });
    const calls = recorder(gate);
    for (let t = 0; t <= 60 * 60_000; t += 10_000) {
      clock.t = t;
      expect(gate.update(noCondition(t, 0, t)), String(t)).toBe('awake');
    }
    expect(calls).toEqual([]);
  });

  test('a clock jumping backwards does not put the gate to sleep or throw', () => {
    const clock = manualClock(5_000_000);
    const gate = new PowerGate({ clock });
    const s = noCondition(5_000_000, 0);
    gate.update(s);
    clock.t = 1_000;                                  // jumps back by more than the idle fallback
    expect(() => gate.update(s)).not.toThrow();
    expect(gate.state()).toBe('awake');
    clock.t = 1_000 + IDLE_FALLBACK_MS - 1;           // the fallback counts from the jump, not from before it
    expect(gate.update(s)).toBe('awake');
    clock.t = 1_000 + IDLE_FALLBACK_MS;
    expect(gate.update(s)).toBe('asleep');
  });

  test('a reading stamped earlier than before (clock moved back) still counts as fresh', () => {
    const clock = manualClock(5_000_000);
    const gate = new PowerGate({ clock });
    gate.update(noCondition(5_000_000, 0));
    clock.t = 1_000;
    gate.update(noCondition(1_000, 0, 1_000));
    clock.t = 1_000 + IDLE_FALLBACK_MS - 1;
    expect(gate.update(noCondition(1_000, 0, 1_000))).toBe('awake');
  });

  test('a known condition overrides the idle fallback', () => {
    const clock = manualClock(0);
    const gate = new PowerGate({ clock });
    const s = withCondition('ignition-on', 0);
    gate.update(s);
    clock.t = IDLE_FALLBACK_MS * 2;
    expect(gate.update(s)).toBe('awake');
  });

  test('touch() (the owner used the app) restarts the idle fallback and wakes a gate that fell asleep on it', () => {
    const clock = manualClock(0);
    const gate = new PowerGate({ clock });
    const calls = recorder(gate);
    const quiet = noCondition(0, null);
    gate.update(quiet);
    clock.t = IDLE_FALLBACK_MS - 1;
    gate.touch();
    clock.t = IDLE_FALLBACK_MS + 1;
    expect(gate.update(quiet)).toBe('awake');           // counted from the touch, not from the start
    clock.t = 2 * IDLE_FALLBACK_MS;
    expect(gate.update(quiet)).toBe('asleep');
    gate.touch();
    expect(gate.update(quiet)).toBe('awake');
    expect(calls).toEqual([['asleep', 'awake'], ['awake', 'asleep']]);
  });

  test('touch() does not wake a car that reports parked or standby', () => {
    const clock = manualClock(0);
    const gate = new PowerGate({ clock });
    for (const condition of ['parked', 'standby'] as VehicleCondition[]) {
      const s = withCondition(condition, clock.t);
      expect(gate.update(s)).toBe('asleep');
      gate.touch();
      expect(gate.update(s)).toBe('asleep');
    }
  });
});
