import { describe, expect, test } from 'vitest';
import {
  EventEngine, NO_LIMITS, defaultEngineOptions, type AlertEvent, type OwnerLimits, type Rule,
} from '@copilot/event-engine';
import { available, emptySnapshot, type CheckControlMessage, type VehicleSnapshot } from '@copilot/vehicle-core';
import { REPORTED_MAX, RuleRunner, isReopened } from './rule-runner';

function manualClock(start: number) {
  const clock = { t: start, now: () => clock.t };
  return clock;
}

/** A provider stand-in: refresh() returns whatever snapshot the test set, stamped with the clock. */
function fakeProvider(clock: { now(): number }) {
  const p = {
    snap: emptySnapshot(0) as VehicleSnapshot,
    refreshes: 0,
    refresh(): VehicleSnapshot {
      p.refreshes++;
      p.snap.takenAt = clock.now();
      return p.snap;
    },
  };
  return p;
}

function withOil(c: number, at: number): VehicleSnapshot {
  const s = emptySnapshot(at);
  s.oilTemp = available(c, '°C', 'passive-signal', at);
  return s;
}

function withCheckControl(messages: CheckControlMessage[], at: number): VehicleSnapshot {
  const s = emptySnapshot(at);
  s.checkControl = available(messages, null, 'passive-signal', at);
  return s;
}

const CC7: CheckControlMessage = { id: 7, text: 'Тиск у шинах: задня ліва', severity: 'warning', since: 0 };

function setup(engine = new EventEngine(defaultEngineOptions()), start = 1_000_000) {
  const clock = manualClock(start);
  const provider = fakeProvider(clock);
  let limits: OwnerLimits = { ...NO_LIMITS };
  const batches: AlertEvent[][] = [];
  const runner = new RuleRunner({
    provider, engine, clock, limits: () => limits, onEvents: (events) => batches.push(events),
  });
  return {
    clock, provider, engine, runner, batches,
    setLimits(next: OwnerLimits) {
      limits = next;
    },
    /** Every event handed to onEvents, flattened. */
    all(): AlertEvent[] {
      return ([] as AlertEvent[]).concat(...batches);
    },
  };
}

/** Raises CC7 on a fresh engine and returns the engine's saved state and the raised event. */
function raiseCc7(start: number) {
  const s = setup(new EventEngine(defaultEngineOptions()), start);
  s.provider.snap = withCheckControl([CC7], start);
  s.runner.tick();
  s.clock.t += 4000;                                        // the check-control rule's dwell
  s.runner.tick();
  const raised = s.all().filter((e) => e.active);
  expect(raised).toHaveLength(1);
  return { state: s.engine.state(), raised: raised[0], s };
}

describe('RuleRunner', () => {
  test('tick() evaluates with the current limits and forwards raised and cleared events', () => {
    const s = setup();
    s.provider.snap = withOil(120, s.clock.t);
    s.runner.tick();
    s.clock.t += 10_000;
    s.runner.tick();
    expect(s.batches).toEqual([]);                           // no limit set: no alert, however hot
    expect(s.provider.refreshes).toBe(2);

    s.setLimits({ ...NO_LIMITS, oilTempMaxC: 115 });
    s.runner.tick();
    s.clock.t += 5000;                                       // the owner-limit rule's dwell
    s.runner.tick();
    expect(s.batches).toHaveLength(1);
    const raised = s.batches[0][0];
    expect(raised).toMatchObject({ provenance: 'owner-configured', severity: 'warning', active: true });
    expect(isReopened(raised)).toBe(false);

    s.clock.t += 1000;
    s.runner.tick();
    expect(s.batches).toHaveLength(1);                       // still active: nothing new

    s.provider.snap = withOil(100, s.clock.t);
    s.clock.t += 1000;
    s.runner.tick();
    expect(s.batches).toHaveLength(2);
    expect(s.batches[1]).toEqual([{ ...raised, active: false, clearedAt: s.clock.t }]);
  });

  test('after restore(), an alert raised before the restart is not raised again inside its cooldown', () => {
    const { state, raised } = raiseCc7(1_000_000);
    const engine = new EventEngine(defaultEngineOptions());
    engine.restore(JSON.parse(JSON.stringify(state)));
    const s = setup(engine, 1_000_000 + 60_000);             // a restart a minute later, mid-drive
    s.provider.snap = withCheckControl([CC7], s.clock.t);
    for (let i = 0; i < 10; i++) {
      s.runner.tick();
      s.clock.t += 1000;
    }
    const events = s.all();
    expect(events).toHaveLength(1);                          // reported once, so the list and the backend agree
    expect(events[0]).toMatchObject({ id: raised.id, active: true, clearedAt: null, title: CC7.text });
    expect(isReopened(events[0])).toBe(true);               // ... but marked: the presenter never pops it up again
    expect(events.some((e) => e.active && !isReopened(e))).toBe(false);

    s.provider.snap = withCheckControl([], s.clock.t);
    s.runner.tick();
    const cleared = s.all()[1];
    expect(cleared).toMatchObject({ id: raised.id, active: false, clearedAt: s.clock.t });
  });

  test('a restored alert whose condition is gone at the first evaluation is reported cleared', () => {
    const { state, raised } = raiseCc7(1_000_000);
    const engine = new EventEngine(defaultEngineOptions());
    engine.restore(state);
    const s = setup(engine, 1_000_000 + 60_000);
    s.provider.snap = withCheckControl([], s.clock.t);
    s.runner.tick();
    expect(s.batches).toHaveLength(1);
    expect(s.batches[0]).toHaveLength(1);
    const cleared = s.batches[0][0];
    expect(cleared).toMatchObject({
      id: raised.id, ruleId: raised.ruleId, dedupKey: raised.dedupKey, provenance: 'bmw-check-control',
      at: raised.at, active: false, clearedAt: s.clock.t,
    });
    for (let i = 0; i < 5; i++) {
      s.clock.t += 1000;
      s.runner.tick();
    }
    expect(s.batches).toHaveLength(1);                       // reported once
  });

  test('a restored alert waits while its rule cannot evaluate, and is not cleared for it', () => {
    const { state } = raiseCc7(1_000_000);
    const engine = new EventEngine(defaultEngineOptions());
    engine.restore(state);
    const s = setup(engine, 1_000_000 + 60_000);
    // a Check Control value the rule chokes on: the rule throws, the engine leaves its keys alone
    const broken: CheckControlMessage[] = [CC7];
    Object.defineProperty(broken, 0, {
      get() {
        throw new Error('bad element');
      },
    });
    s.provider.snap = withCheckControl(broken, s.clock.t);
    s.runner.tick();
    expect(s.batches).toEqual([]);
    s.clock.t += 1000;
    s.provider.snap = withCheckControl([CC7], s.clock.t);
    s.runner.tick();
    expect(s.all()).toHaveLength(1);
    expect(isReopened(s.all()[0])).toBe(true);
  });

  test('an alert back inside its cooldown is reported re-opened, never raised again, and its end is reported', () => {
    const s = setup();
    s.provider.snap = withCheckControl([CC7], s.clock.t);
    s.runner.tick();
    s.clock.t += 4000;
    s.runner.tick();
    const raised = s.all()[0];
    expect(raised.active).toBe(true);

    s.clock.t += 1000;
    s.provider.snap = withCheckControl([], s.clock.t);
    s.runner.tick();
    expect(s.all()[1]).toMatchObject({ id: raised.id, active: false });

    s.clock.t += 60_000;                                     // back, well inside the ten-minute cooldown
    s.provider.snap = withCheckControl([CC7], s.clock.t);
    s.runner.tick();
    s.clock.t += 4000;
    s.runner.tick();
    expect(s.all()).toHaveLength(3);
    const reopened = s.all()[2];
    expect(reopened).toMatchObject({ id: raised.id, active: true, clearedAt: null });
    expect(isReopened(reopened)).toBe(true);
    s.clock.t += 1000;
    s.runner.tick();
    expect(s.all()).toHaveLength(3);

    s.clock.t += 1000;
    s.provider.snap = withCheckControl([], s.clock.t);
    s.runner.tick();                                         // the engine returns nothing for this clearing
    expect(s.all()).toHaveLength(4);
    expect(s.all()[3]).toMatchObject({ id: raised.id, active: false, clearedAt: s.clock.t });
  });

  test('the bookkeeping is bounded and steady with more active alerts than it tracks', () => {
    const many = REPORTED_MAX + 50;
    const rule: Rule = {
      id: 'many', provenance: 'bmw-check-control', dwellMs: 0, cooldownMs: 600_000,
      evaluate: () => Array.from({ length: many }, (_, i) => ({ dedupKey: 'k' + i, severity: 'warning' as const, title: 't' + i, detail: null })),
    };
    const engine = new EventEngine({ rules: [rule], maxRaisedPerWindow: 10_000, windowMs: 600_000, historySize: 10 });
    const s = setup(engine);
    s.runner.tick();
    expect(s.all().filter((e) => e.active)).toHaveLength(many);       // everything the engine returns is forwarded
    for (let i = 0; i < 3; i++) {
      s.clock.t += 1000;
      s.runner.tick();
    }
    expect(s.batches).toHaveLength(1);                                  // no flapping
    const reported = (s.runner as unknown as { reported: Record<string, AlertEvent> }).reported;
    expect(Object.keys(reported).length).toBeLessThanOrEqual(REPORTED_MAX);
  });

  test('a throwing provider propagates to the caller (who wraps tick in safe) without corrupting the runner', () => {
    const s = setup();
    const refresh = s.provider.refresh;
    s.provider.refresh = () => {
      throw new Error('provider broke');
    };
    expect(() => s.runner.tick()).toThrow();
    s.provider.refresh = refresh;
    s.provider.snap = withCheckControl([CC7], s.clock.t);
    s.runner.tick();
    s.clock.t += 4000;
    s.runner.tick();
    expect(s.all()).toHaveLength(1);
  });
});
