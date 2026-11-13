import { expect, test } from 'vitest';
import { Severity, emptySnapshot } from '@copilot/vehicle-core';
import { EventEngine } from './engine';
import { AlertEvent, Candidate, EngineOptions, NO_LIMITS, Rule } from './types';

interface FakeRule { rule: Rule; set(candidates: Candidate[]): void }

function candidate(dedupKey: string, severity: Severity = 'warning'): Candidate {
  return { dedupKey, severity, title: `Title ${dedupKey}`, detail: null };
}

/** A rule whose candidates the test sets before each call. */
function fakeRule(id: string, timing: { dwellMs: number; cooldownMs: number }): FakeRule {
  let current: Candidate[] = [];
  const rule: Rule = {
    id,
    provenance: 'owner-configured',
    dwellMs: timing.dwellMs,
    cooldownMs: timing.cooldownMs,
    evaluate: () => current,
  };
  return { rule, set: (candidates) => { current = candidates; } };
}

function engineWith(rules: Rule[], overrides: Partial<EngineOptions> = {}): EventEngine {
  return new EventEngine({ rules, maxRaisedPerWindow: 100, windowMs: 600_000, historySize: 50, ...overrides });
}

function run(engine: EventEngine, now: number): AlertEvent[] {
  return engine.evaluate(emptySnapshot(now), now, NO_LIMITS);
}

function raised(events: AlertEvent[]): AlertEvent[] {
  return events.filter((e) => e.active);
}

test('raises only after the dwell time', () => {
  const r = fakeRule('r', { dwellMs: 5000, cooldownMs: 600_000 });
  const engine = engineWith([r.rule]);
  r.set([candidate('a')]);
  expect(run(engine, 0)).toEqual([]);
  expect(run(engine, 4999)).toEqual([]);
  const events = run(engine, 5000);
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    id: 'r:a:5000', ruleId: 'r', dedupKey: 'a', provenance: 'owner-configured', severity: 'warning',
    title: 'Title a', detail: null, at: 5000, active: true, clearedAt: null,
  });
  expect(engine.active().map((e) => e.id)).toEqual(['r:a:5000']);
});

test('does not raise twice while the condition stays true', () => {
  const r = fakeRule('r', { dwellMs: 0, cooldownMs: 600_000 });
  const engine = engineWith([r.rule]);
  r.set([candidate('a')]);
  let count = 0;
  for (let i = 0; i < 100; i++) count += run(engine, i * 1000).length;
  expect(count).toBe(1);
  expect(engine.history()).toHaveLength(1);
});

test('clears when the condition goes away and returns the cleared event', () => {
  const r = fakeRule('r', { dwellMs: 0, cooldownMs: 600_000 });
  const engine = engineWith([r.rule]);
  r.set([candidate('a')]);
  const [event] = run(engine, 0);
  r.set([]);
  const cleared = run(engine, 1000);
  expect(cleared).toEqual([{ ...event, active: false, clearedAt: 1000 }]);
  expect(engine.active()).toEqual([]);
  expect(engine.history()[0]).toEqual({ ...event, active: false, clearedAt: 1000 });
});

test('re-activation inside the cooldown is silent', () => {
  const r = fakeRule('r', { dwellMs: 0, cooldownMs: 600_000 });
  const engine = engineWith([r.rule]);
  r.set([candidate('a')]);
  run(engine, 0);
  r.set([]);
  run(engine, 1000);
  r.set([candidate('a')]);
  expect(run(engine, 61_000)).toEqual([]);
  expect(engine.active().map((e) => e.dedupKey)).toEqual(['a']);
  expect(engine.history()).toHaveLength(1);
});

test('re-activation after the cooldown raises again', () => {
  const r = fakeRule('r', { dwellMs: 0, cooldownMs: 600_000 });
  const engine = engineWith([r.rule]);
  r.set([candidate('a')]);
  run(engine, 0);
  r.set([]);
  run(engine, 1000);
  r.set([candidate('a')]);
  const events = run(engine, 600_000);
  expect(events.map((e) => e.id)).toEqual(['r:a:600000']);
  expect(events[0].active).toBe(true);
  expect(engine.history()).toHaveLength(2);
});

test('flapping every second for ten minutes produces exactly one event', () => {
  const r = fakeRule('r', { dwellMs: 0, cooldownMs: 600_000 });
  const engine = engineWith([r.rule]);
  const returned: AlertEvent[] = [];
  for (let t = 0; t < 600_000; t += 1000) {
    r.set((t / 1000) % 2 === 0 ? [candidate('a')] : []);
    returned.push(...run(engine, t));
  }
  expect(raised(returned)).toHaveLength(1);
  // One raise and its one clearing; silent re-activations clear silently.
  expect(returned).toHaveLength(2);
  expect(engine.history()).toHaveLength(1);
});

test('global rate limit defers the seventh event of a window instead of dropping it', () => {
  const r = fakeRule('r', { dwellMs: 0, cooldownMs: 3_600_000 });
  const engine = engineWith([r.rule], { maxRaisedPerWindow: 6, windowMs: 600_000 });
  r.set(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'].map((k) => candidate(k)));
  expect(raised(run(engine, 0))).toHaveLength(6);
  expect(run(engine, 1000)).toEqual([]);
  expect(run(engine, 599_999)).toEqual([]);
  const later = run(engine, 600_000);
  expect(later.map((e) => e.dedupKey)).toEqual(['k7', 'k8']);
  expect(engine.active()).toHaveLength(8);
});

test('suppression defers and later raises', () => {
  const r = fakeRule('r', { dwellMs: 0, cooldownMs: 600_000 });
  let suppressed = true;
  const engine = engineWith([r.rule], { suppress: () => suppressed });
  r.set([candidate('a')]);
  expect(run(engine, 0)).toEqual([]);
  expect(run(engine, 1000)).toEqual([]);
  suppressed = false;
  const events = run(engine, 2000);
  expect(events.map((e) => e.id)).toEqual(['r:a:2000']);
});

test('orders raised events critical, warning, info', () => {
  const r = fakeRule('r', { dwellMs: 0, cooldownMs: 600_000 });
  const s = fakeRule('s', { dwellMs: 0, cooldownMs: 600_000 });
  const engine = engineWith([r.rule, s.rule]);
  r.set([candidate('i1', 'info'), candidate('w1', 'warning')]);
  s.set([candidate('i2', 'info'), candidate('c1', 'critical'), candidate('w2', 'warning')]);
  expect(run(engine, 0).map((e) => e.severity)).toEqual(['critical', 'warning', 'warning', 'info', 'info']);
});

test('history is bounded and newest first', () => {
  const r = fakeRule('r', { dwellMs: 0, cooldownMs: 600_000 });
  const engine = engineWith([r.rule], { historySize: 3 });
  const keys = ['a', 'b', 'c', 'd', 'e'];
  keys.forEach((key, i) => {
    r.set(keys.slice(0, i + 1).map((k) => candidate(k)));
    run(engine, i * 1000);
  });
  expect(engine.history().map((e) => e.dedupKey)).toEqual(['e', 'd', 'c']);
});

test('a clock that jumps backwards neither throws nor raises a burst', () => {
  const r = fakeRule('r', { dwellMs: 5000, cooldownMs: 600_000 });
  const engine = engineWith([r.rule], { maxRaisedPerWindow: 6 });
  r.set([candidate('a')]);
  run(engine, 995_000);
  expect(raised(run(engine, 1_000_000))).toHaveLength(1);

  r.set([candidate('a'), candidate('b'), candidate('c')]);
  expect(() => run(engine, 10)).not.toThrow();
  expect(run(engine, 4000)).toEqual([]);
  const events = run(engine, 5010);
  expect(events.map((e) => e.dedupKey)).toEqual(['b', 'c']);
  expect(run(engine, 6000)).toEqual([]);
  expect(engine.history()).toHaveLength(3);
});

test('a throwing rule does not stop the others', () => {
  const bad: Rule = {
    id: 'bad', provenance: 'bmw-service', dwellMs: 0, cooldownMs: 0,
    evaluate: () => { throw new Error('boom'); },
  };
  const r = fakeRule('r', { dwellMs: 0, cooldownMs: 600_000 });
  const engine = engineWith([bad, r.rule]);
  r.set([candidate('a')]);
  let events: AlertEvent[] = [];
  expect(() => { events = run(engine, 0); }).not.toThrow();
  expect(events.map((e) => e.id)).toEqual(['r:a:0']);
});

test('a rule that throws keeps its active alerts and pending dwell for that call', () => {
  let broken = false;
  let current: Candidate[] = [];
  const flaky: Rule = {
    id: 'r', provenance: 'owner-configured', dwellMs: 0, cooldownMs: 600_000,
    evaluate: () => { if (broken) throw new Error('boom'); return current; },
  };
  const engine = engineWith([flaky]);
  current = [candidate('a', 'critical')];
  expect(run(engine, 0).map((e) => e.id)).toEqual(['r:a:0']);
  broken = true;
  expect(run(engine, 1000)).toEqual([]);
  expect(engine.active().map((e) => e.id)).toEqual(['r:a:0']);
  broken = false;
  expect(run(engine, 2000)).toEqual([]);
  expect(engine.history()).toEqual([expect.objectContaining({ id: 'r:a:0', active: true, clearedAt: null })]);
});

test('a rule that throws does not restart the dwell of its pending keys', () => {
  let broken = false;
  let current: Candidate[] = [];
  const flaky: Rule = {
    id: 'r', provenance: 'owner-configured', dwellMs: 5000, cooldownMs: 600_000,
    evaluate: () => { if (broken) throw new Error('boom'); return current; },
  };
  const engine = engineWith([flaky]);
  current = [candidate('a')];
  expect(run(engine, 0)).toEqual([]);
  broken = true;
  expect(run(engine, 4000)).toEqual([]);
  broken = false;
  expect(run(engine, 5000).map((e) => e.id)).toEqual(['r:a:5000']);
});

test('an alert active before a restart is returned as cleared with its original id', () => {
  const r = fakeRule('r', { dwellMs: 0, cooldownMs: 600_000 });
  const first = engineWith([r.rule]);
  r.set([candidate('a')]);
  const [event] = run(first, 0);
  const state = JSON.parse(JSON.stringify(first.state()));

  const second = engineWith([r.rule]);
  second.restore(state);
  expect(run(second, 1000)).toEqual([]);
  expect(second.active().map((e) => e.id)).toEqual(['r:a:0']);
  r.set([]);
  expect(run(second, 2000)).toEqual([{ ...event, active: false, clearedAt: 2000 }]);
  expect(second.active()).toEqual([]);
});

test('state() / restore() round-trips cooldown memory', () => {
  const r = fakeRule('r', { dwellMs: 0, cooldownMs: 600_000 });
  const first = engineWith([r.rule]);
  r.set([candidate('a')]);
  run(first, 0);
  r.set([]);
  run(first, 1000);
  const state = JSON.parse(JSON.stringify(first.state()));

  const second = engineWith([r.rule]);
  second.restore(state);
  r.set([candidate('a')]);
  expect(run(second, 61_000)).toEqual([]);
  expect(second.active().map((e) => e.dedupKey)).toEqual(['a']);

  const fresh = engineWith([r.rule]);
  expect(raised(run(fresh, 61_000))).toHaveLength(1);
});
