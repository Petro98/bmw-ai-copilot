/**
 * The 1 Hz rule tick: refresh the provider, run the shared event engine with the owner's current limits and
 * hand what changed to the app (pop-up presenter, uplink, screen list).
 *
 * The engine returns an event for a raise and for the clearing of an alert it returned as raised. Two
 * transitions it does not return (packages/event-engine/src/engine.ts):
 *   - a key back inside its cooldown becomes active again silently, under the id of its last raise, and its
 *     later clearing is silent too;
 *   - after restore(), a key active before the restart is rebuilt silently when its condition is still there,
 *     and cleared silently when the condition is gone at the first evaluation.
 * So, like the backend's VehicleHub, the runner keeps what it reports equal to engine.active(): after each
 * evaluation an alert active without a returned event is reported once as re-opened (marked with
 * markReopened, so the presenter never pops it up a second time), and an alert it reported active that is no
 * longer active is reported cleared. A key restored as active whose condition is gone has no event content
 * left in the engine: its clearing is rebuilt from the key memory (see restoredClearing).
 *
 * tick() does not catch: the app calls it through safe() (car/src/safe.ts), like every timer callback.
 */
import { defaultRules } from '@copilot/event-engine';
import type { AlertEvent, EventEngine, OwnerLimits, Provenance } from '@copilot/event-engine';
import type { Clock } from '@copilot/vehicle-core';
import type { BmwMguVehicleDataProvider } from '../provider/bmw-provider';

/**
 * At most this many active alerts are tracked for reconciling (the engine's active list is sorted critical
 * first, then newest first, and only its head is tracked). A real car has a handful; the cap only keeps the
 * bookkeeping bounded if a rule ever produces a flood of keys.
 */
export const REPORTED_MAX = 256;

/** Events reported as re-opened: active again without a raise. Weak, so it holds nothing alive. */
const reopened = new WeakSet<AlertEvent>();

/** Marks an event as re-opened (active again without a raise); returns the same event. */
export function markReopened(event: AlertEvent): AlertEvent {
  reopened.add(event);
  return event;
}

/** True for an event the runner reported as re-opened: shown in lists, never popped up again. */
export function isReopened(event: AlertEvent): boolean {
  return reopened.has(event);
}

/** The engine's event id for a key raised at `at` (engine.ts makeEvent: `${rule.id}:${dedupKey}:${at}`). */
function eventId(ruleId: string, dedupKey: string, at: number): string {
  return ruleId + ':' + dedupKey + ':' + at;
}

/** Provenance of each default rule, for a clearing rebuilt from key memory. */
const PROVENANCE: Record<string, Provenance> = (() => {
  const map = Object.create(null) as Record<string, Provenance>;
  for (const rule of defaultRules()) map[rule.id] = rule.provenance;
  return map;
})();

interface RestoredKey { ruleId: string; dedupKey: string; lastRaisedAt: number; id: string }

export interface RuleRunnerOptions {
  /** Only refresh() is used; the head unit passes its BmwMguVehicleDataProvider. */
  provider: Pick<BmwMguVehicleDataProvider, 'refresh'>;
  engine: EventEngine;
  limits: () => OwnerLimits;
  clock: Clock;
  onEvents: (events: AlertEvent[]) => void;
}

export class RuleRunner {
  private readonly options: RuleRunnerOptions;
  /** Alerts reported as active, by id: the head of engine.active() after the last tick (≤ REPORTED_MAX keys). */
  private reported: Record<string, AlertEvent> = Object.create(null) as Record<string, AlertEvent>;
  /** Keys the engine restored as active, not yet seen in engine.active() nor cleared; null before the first tick. */
  private restored: RestoredKey[] | null = null;

  constructor(options: RuleRunnerOptions) {
    this.options = options;
  }

  /**
   * Refreshes the provider, evaluates with the current limits, and hands raised, re-opened and cleared events
   * to onEvents (raised first, in the engine's order; then re-opened; then cleared). Nothing when nothing changed.
   * The engine must be restored before the first tick.
   */
  tick(): void {
    const { provider, engine, clock, limits } = this.options;
    const snapshot = provider.refresh();
    const now = clock.now();
    if (this.restored === null) this.restored = this.restoredActiveKeys();

    const returned = engine.evaluate(snapshot, now, limits());
    const out: AlertEvent[] = returned.slice();
    const announced = new Set<string>();
    for (const event of returned) announced.add(event.id);

    const active = engine.active();
    const activeIds = new Set<string>();
    for (const alert of active) activeIds.add(alert.id);
    const next = Object.create(null) as Record<string, AlertEvent>;
    const head = active.length > REPORTED_MAX ? active.slice(0, REPORTED_MAX) : active;
    const cleared: AlertEvent[] = [];
    for (const alert of head) {
      const known = this.reported[alert.id];
      if (known) {
        next[alert.id] = known;
      } else if (announced.has(alert.id)) {
        next[alert.id] = alert;
      } else {
        const event = markReopened({ ...alert, active: true, clearedAt: null });
        out.push(event);
        next[alert.id] = event;
      }
    }
    for (const id of Object.keys(this.reported)) {
      if (next[id] || activeIds.has(id) || announced.has(id)) continue;
      cleared.push({ ...this.reported[id], active: false, clearedAt: now });
    }
    this.reported = next;
    for (const event of this.settleRestored(activeIds, announced, now)) cleared.push(event);

    for (const event of cleared) out.push(event);
    if (out.length > 0) this.options.onEvents(out);
  }

  /** The keys the engine holds as active before the first evaluation (only a restore() can have put them there). */
  private restoredActiveKeys(): RestoredKey[] {
    const list: RestoredKey[] = [];
    for (const key of this.options.engine.state().keys) {
      if (list.length >= REPORTED_MAX) break;
      if (!key.active || typeof key.lastRaisedAt !== 'number') continue;
      list.push({ ruleId: key.ruleId, dedupKey: key.dedupKey, lastRaisedAt: key.lastRaisedAt, id: eventId(key.ruleId, key.dedupKey, key.lastRaisedAt) });
    }
    return list;
  }

  /**
   * Restored keys: one that shows up in engine.active() is handled like any other active alert (reported as
   * re-opened); one the engine no longer holds as active went away silently and its clearing is rebuilt; one
   * still active without an event (its rule could not evaluate) waits for the next tick.
   */
  private settleRestored(activeIds: Set<string>, announced: Set<string>, now: number): AlertEvent[] {
    const restored = this.restored;
    if (!restored || restored.length === 0) return [];
    const stillActive = new Set<string>();
    for (const key of this.options.engine.state().keys) if (key.active) stillActive.add(key.dedupKey);
    const waiting: RestoredKey[] = [];
    const cleared: AlertEvent[] = [];
    for (const key of restored) {
      if (activeIds.has(key.id) || announced.has(key.id)) continue;
      if (stillActive.has(key.dedupKey)) {
        waiting.push(key);
        continue;
      }
      const event = restoredClearing(key, now);
      if (event) cleared.push(event);
    }
    this.restored = waiting;
    return cleared;
  }
}

/**
 * The clearing of an alert raised before a restart whose condition was gone by the first evaluation. The
 * engine keeps no content for it, so the event carries the original id, rule, key, provenance and raise
 * time, and neutral content: severity 'info', an empty title, no detail. A consumer matches it by id.
 * Null for a rule outside the default set (its provenance is unknown).
 */
function restoredClearing(key: RestoredKey, now: number): AlertEvent | null {
  const provenance = PROVENANCE[key.ruleId];
  if (!provenance) return null;
  return {
    id: key.id, ruleId: key.ruleId, dedupKey: key.dedupKey, provenance, severity: 'info',
    title: '', detail: null, at: key.lastRaisedAt, active: false, clearedAt: now,
  };
}
