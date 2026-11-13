import { Severity, VehicleSnapshot } from '@copilot/vehicle-core';
import { AlertEvent, Candidate, EngineOptions, EngineState, OwnerLimits, Rule, RuleContext } from './types';

/** What the engine remembers about one dedupKey. */
interface KeyEntry {
  ruleId: string;
  /** When the key was first seen in its current appearance (dwell is measured from here). */
  firstSeenAt: number;
  /** True while the key is among the candidates (pending or active); false once it went away (cooldown memory only). */
  seen: boolean;
  lastRaisedAt: number | null;
  active: boolean;
  /** The event active() shows for this key; null when not active or not yet known (restored state). */
  event: AlertEvent | null;
  /** True when evaluate() returned this event as raised, so its clearing is returned too. */
  announced: boolean;
}

interface Eligible { rule: Rule; candidate: Candidate; entry: KeyEntry }

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function bySeverity(a: { severity: Severity }, b: { severity: Severity }): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

/**
 * Turns rule candidates into alert events: dwell, per-rule cooldown, de-duplication by dedupKey,
 * a global rate limit, suppression and severity ordering. Pure in-memory state, no timers, no clock:
 * the caller passes `now`, which may jump backwards (head-unit clocks can be days off).
 */
export class EventEngine {
  private readonly options: EngineOptions;
  private readonly rulesById = new Map<string, Rule>();
  private readonly keys = new Map<string, KeyEntry>();
  /** Times of events raised within the current window, oldest first; never longer than maxRaisedPerWindow. */
  private raisedAt: number[] = [];
  /** Newest first, at most options.historySize. */
  private events: AlertEvent[] = [];
  /** `now` of the previous evaluate() call; null before the first one (and after restore()). */
  private lastNow: number | null = null;

  constructor(options: EngineOptions) {
    this.options = options;
    for (const rule of options.rules) {
      if (!this.rulesById.has(rule.id)) this.rulesById.set(rule.id, rule);
    }
  }

  /**
   * Events raised or cleared by this call: raised ones first (critical, warning, info), then cleared ones.
   *
   * Unknown is not gone. A rule that returns null (its data is unavailable) and a key a rule holds through
   * ctx.hold() keep their state exactly: an active alert stays active under its id and is neither cleared nor
   * raised again when its condition is reported again, and a pending key's dwell is frozen (the time of a call
   * that could not evaluate it does not count, and its dwell does not restart). Only a rule that evaluated
   * (returned an array) and did not hold a key clears it.
   */
  evaluate(snapshot: VehicleSnapshot, now: number, limits: OwnerLimits): AlertEvent[] {
    const seenThisCall = new Set<string>();
    /** Rules skipped this call (threw, returned null or a non-array): their keys are left as they were. */
    const skippedRules = new Set<string>();
    /** Rules that could not evaluate (returned null): their pending keys' dwell is frozen too. */
    const unknownRules = new Set<string>();
    /** Keys a rule that did evaluate could not evaluate (ctx.hold): kept like those of a rule returning null. */
    const heldKeys = new Set<string>();
    /** Holds of the rule being evaluated; merged into heldKeys only if it returns normally. */
    let holding: { rule: Rule; keys: string[] } | null = null;
    const eligible: Eligible[] = [];
    const ctx: RuleContext = {
      snapshot,
      now,
      limits,
      isActive: (dedupKey: string) => {
        const entry = this.keys.get(dedupKey);
        return entry !== undefined && entry.active;
      },
      hold: (dedupKey: string) => {
        if (holding === null || typeof dedupKey !== 'string') return;
        const entry = this.keys.get(dedupKey);
        // Only a key this rule already has can be held: holding never creates or grows any state.
        if (entry !== undefined && entry.ruleId === holding.rule.id) holding.keys.push(dedupKey);
      },
    };

    for (const rule of this.options.rules) {
      let candidates: Candidate[] | null;
      const current = { rule, keys: [] as string[] };
      holding = current;
      try {
        candidates = rule.evaluate(ctx);
      } catch {
        skippedRules.add(rule.id); // a broken rule is skipped for this call; the others still run
        continue;
      } finally {
        holding = null;
      }
      if (candidates === null) {
        skippedRules.add(rule.id);
        unknownRules.add(rule.id);
        continue;
      }
      if (!Array.isArray(candidates)) {
        skippedRules.add(rule.id);
        continue;
      }
      for (const key of current.keys) heldKeys.add(key);
      for (const candidate of candidates) {
        const found = this.track(rule, candidate, now, seenThisCall);
        if (found) eligible.push(found);
      }
    }

    this.freezeDwell(seenThisCall, unknownRules, heldKeys, now);
    const raised = this.raise(eligible, snapshot, now);
    const cleared = this.forgetAbsent(seenThisCall, skippedRules, heldKeys, now);
    this.lastNow = now;
    return raised.concat(cleared);
  }

  /** Currently active alerts, critical first, then newest first. */
  active(): AlertEvent[] {
    const list: AlertEvent[] = [];
    this.keys.forEach((entry) => {
      if (entry.active && entry.event) list.push(entry.event);
    });
    return list.sort((a, b) => bySeverity(a, b) || b.at - a.at);
  }

  /** Raised events, newest first, at most options.historySize. */
  history(): AlertEvent[] {
    return this.events.slice();
  }

  /** The memory needed to survive a restart (dwell and cooldown). */
  state(): EngineState {
    const keys: EngineState['keys'] = [];
    this.keys.forEach((entry, dedupKey) => {
      keys.push({
        dedupKey,
        ruleId: entry.ruleId,
        firstSeenAt: entry.firstSeenAt,
        lastRaisedAt: entry.lastRaisedAt,
        active: entry.active,
      });
    });
    return { keys };
  }

  /**
   * Replaces the key memory with a saved state. Malformed entries and entries of unknown rules are skipped.
   * A restored active key stays active (it is not raised again) and counts as announced: its event is rebuilt
   * from the next candidate with the original id, and its clearing is returned like any other. If the key is
   * already gone before a candidate rebuilt its event, there is no event to return and it clears silently.
   * A restored key that was raised and then
   * went away keeps only its cooldown memory: its dwell starts again when it reappears.
   */
  restore(state: EngineState): void {
    this.keys.clear();
    this.lastNow = null;
    const list = state && Array.isArray(state.keys) ? state.keys : [];
    for (const item of list) {
      if (!item || typeof item.dedupKey !== 'string' || typeof item.ruleId !== 'string') continue;
      if (!this.rulesById.has(item.ruleId) || !isFiniteNumber(item.firstSeenAt)) continue;
      const lastRaisedAt = isFiniteNumber(item.lastRaisedAt) ? item.lastRaisedAt : null;
      const wasRaised = lastRaisedAt !== null;
      const active = item.active === true && wasRaised;
      this.keys.set(item.dedupKey, {
        ruleId: item.ruleId,
        firstSeenAt: item.firstSeenAt,
        seen: active || !wasRaised,
        lastRaisedAt,
        active,
        event: null,
        announced: active, // the previous instance announced it; its clearing must reach consumers
      });
    }
  }

  /** Records one candidate; returns it when it is eligible to be raised now. */
  private track(rule: Rule, candidate: Candidate, now: number, seenThisCall: Set<string>): Eligible | null {
    if (!candidate || typeof candidate.dedupKey !== 'string') return null;
    const key = candidate.dedupKey;
    if (seenThisCall.has(key)) return null; // the first candidate of a key wins within one call
    let entry = this.keys.get(key);
    if (entry && entry.ruleId !== rule.id) return null; // the key belongs to another rule
    seenThisCall.add(key);

    if (!entry) {
      entry = { ruleId: rule.id, firstSeenAt: now, seen: true, lastRaisedAt: null, active: false, event: null, announced: false };
      this.keys.set(key, entry);
    } else if (!entry.seen) {
      entry.seen = true;
      entry.firstSeenAt = now;
    }
    if (now < entry.firstSeenAt) entry.firstSeenAt = now; // the clock went backwards

    if (entry.active) {
      if (!entry.event) entry.event = this.makeEvent(rule, candidate, entry.lastRaisedAt === null ? now : entry.lastRaisedAt);
      return null;
    }
    if (now - entry.firstSeenAt < rule.dwellMs) return null;

    const last = entry.lastRaisedAt;
    if (last !== null && now >= last && now - last < rule.cooldownMs) {
      // Back inside the cooldown: active again, without an event. The id is that of the last raise.
      entry.active = true;
      entry.event = this.makeEvent(rule, candidate, last);
      entry.announced = false;
      return null;
    }
    return { rule, candidate, entry };
  }

  /**
   * Pending keys that could not be evaluated in this call (rule returned null, or the key was held) do not
   * advance their dwell: their firstSeenAt moves forward by the time since the previous call, so the time
   * already dwelt is kept and the unknown interval is not counted. A clock that went backwards moves nothing.
   */
  private freezeDwell(seenThisCall: Set<string>, unknownRules: Set<string>, heldKeys: Set<string>, now: number): void {
    if (unknownRules.size === 0 && heldKeys.size === 0) return;
    const last = this.lastNow;
    const elapsed = last !== null && now > last ? now - last : 0;
    if (elapsed === 0) return;
    this.keys.forEach((entry, key) => {
      if (seenThisCall.has(key) || !entry.seen || entry.active) return;
      if (heldKeys.has(key) || unknownRules.has(entry.ruleId)) entry.firstSeenAt += elapsed;
    });
  }

  /** Raises eligible candidates, most severe first, unless suppressed or over the global rate. */
  private raise(eligible: Eligible[], snapshot: VehicleSnapshot, now: number): AlertEvent[] {
    if (eligible.length === 0) return [];
    if (this.isSuppressed(snapshot)) return [];
    this.trimWindow(now);

    const ordered = eligible
      .map((item, index) => ({ item, index }))
      .sort((a, b) => bySeverity(a.item.candidate, b.item.candidate) || a.index - b.index);
    const raised: AlertEvent[] = [];
    for (const { item } of ordered) {
      if (this.raisedAt.length >= this.options.maxRaisedPerWindow) break; // stays pending, tried again next call
      const event = this.makeEvent(item.rule, item.candidate, now);
      item.entry.active = true;
      item.entry.lastRaisedAt = now;
      item.entry.event = event;
      item.entry.announced = true;
      this.raisedAt.push(now);
      this.remember(event);
      raised.push(event);
    }
    return raised;
  }

  /**
   * Clears active keys that were not among this call's candidates and forgets pending ones.
   * Keys of a rule skipped in this call (it threw or could not evaluate) and held keys are untouched: an
   * evaluation error or an unavailable reading is not evidence the condition went away.
   */
  private forgetAbsent(seenThisCall: Set<string>, skippedRules: Set<string>, heldKeys: Set<string>, now: number): AlertEvent[] {
    const cleared: AlertEvent[] = [];
    const remove: string[] = [];
    this.keys.forEach((entry, key) => {
      if (seenThisCall.has(key) || heldKeys.has(key) || skippedRules.has(entry.ruleId)) return;
      if (entry.active) {
        if (entry.announced && entry.event) {
          const event: AlertEvent = { ...entry.event, active: false, clearedAt: now };
          this.replaceInHistory(event);
          cleared.push(event);
        }
        entry.active = false;
        entry.event = null;
        entry.announced = false;
      }
      entry.seen = false;
      if (this.canForget(entry, now)) remove.push(key);
    });
    for (const key of remove) this.keys.delete(key);
    return cleared;
  }

  /** A key that is gone can be forgotten once nothing about it matters: never raised, or its cooldown is over. */
  private canForget(entry: KeyEntry, now: number): boolean {
    if (entry.lastRaisedAt === null) return true;
    const rule = this.rulesById.get(entry.ruleId);
    if (!rule) return true;
    return now >= entry.lastRaisedAt && now - entry.lastRaisedAt >= rule.cooldownMs;
  }

  private isSuppressed(snapshot: VehicleSnapshot): boolean {
    const suppress = this.options.suppress;
    if (!suppress) return false;
    try {
      return suppress(snapshot) === true;
    } catch {
      return false;
    }
  }

  /** Keeps only raise times inside the window; times in the future (clock went backwards) count as now. */
  private trimWindow(now: number): void {
    const windowMs = this.options.windowMs;
    const kept: number[] = [];
    for (const at of this.raisedAt) {
      const t = at > now ? now : at;
      if (now - t < windowMs) kept.push(t);
    }
    const max = Math.max(0, this.options.maxRaisedPerWindow);
    this.raisedAt = kept.length > max ? kept.slice(kept.length - max) : kept;
  }

  private remember(event: AlertEvent): void {
    this.events.unshift(event);
    const size = Math.max(0, this.options.historySize);
    if (this.events.length > size) this.events.length = size;
  }

  private replaceInHistory(event: AlertEvent): void {
    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i].id === event.id) {
        this.events[i] = event;
        return;
      }
    }
  }

  private makeEvent(rule: Rule, candidate: Candidate, at: number): AlertEvent {
    return {
      id: `${rule.id}:${candidate.dedupKey}:${at}`,
      ruleId: rule.id,
      dedupKey: candidate.dedupKey,
      provenance: rule.provenance,
      severity: candidate.severity,
      title: candidate.title,
      detail: candidate.detail,
      at,
      active: true,
      clearedAt: null,
    };
  }
}
