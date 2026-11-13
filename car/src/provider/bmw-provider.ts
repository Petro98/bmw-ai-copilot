/**
 * The head unit's vehicle provider: passive SOME/IP subscriptions through the vendored kit's signals.watch
 * (car/kit/runtime/signals.js:53-94), nothing else.
 *
 * Read-only: it only watches fields (app.json declares them with the read/subscribe flags r and s), holds
 * no proxy of its own, calls no method and writes nothing. Diagnostic-only readings are always
 * diagnostics-disabled here.
 *
 * Two snapshots: handlers decode into `latest` (applyRaw: no logging, no I/O, no notification); refresh(),
 * which the app's 1 Hz tick calls while the ignition is on, judges `latest` against the clock and publishes
 * the result into the snapshot listeners and snapshot() see. While the car is parked the caller suspend()s
 * the provider: only the vehicle-condition watch stays, so a condition change can still wake the app.
 *
 * Staleness. A car notifies most fields only when they change, so during a steady drive coolant, gear or
 * drive mode can be silent for many minutes while still true. A passive reading is therefore judged (and
 * dated) by the later of its own arrival and the latest on-change notification from any watched interface:
 * while the car is talking, a field that reported no change still holds. It turns stale only when the whole
 * car has been quiet for staleAfterMs, and it is dropped at once when its own interface reports unavailable.
 * A polled reading is judged by its own last poll result. Odometer, service items and Check Control are
 * exempt and keep their value and their original `at`.
 */
import { available, emptySnapshot, unavailable } from '@copilot/vehicle-core';
import type {
  Clock, Reading, SnapshotKey, VehicleCapabilities, VehicleDataProvider, VehicleSnapshot,
} from '@copilot/vehicle-core';
import { safe, type Log } from '../safe';
import {
  DIAGNOSTIC_ONLY_KEYS, RAW_INTERFACES, STALE_EXEMPT_KEYS, applyRaw, createDecoderState, markUnavailable,
  type DecoderState, type RawInterface,
} from './raw-decoders';

/** The read side of the kit's signals module (car/kit/runtime/signals.js watch, line 53). */
export interface SignalsApi {
  watch(iface: string, instance: string | undefined, handlers: Record<string, (value: unknown) => void>, log: Log,
    opts?: { pollMs?: number }): Promise<unknown>;
}

export interface BmwProviderOptions { signals: SignalsApi; clock: Clock; log: Log; missingInterfaces: string[]; staleAfterMs?: number }

/** A reading not refreshed for this long becomes unavailable('stale'). */
export const DEFAULT_STALE_AFTER_MS = 300_000;
/**
 * Getter polling for interfaces a car may never notify (KombiIF, TPMS): every 10 s, as the reference apps do
 * (idrive7-apps@4a8deb7 apps/live_data/signals.js:27-28, apps/car_vitals/main.js:383-385).
 */
export const POLL_MS = 10_000;
/** Every reference app watches vehicle interfaces on instance '1' (car/kit/runtime/parked.js:22, idrive7-apps@4a8deb7 kit/runtime/car.js:154). */
export const SIGNAL_INSTANCE = '1';

type Listener = (snapshot: VehicleSnapshot) => void;
type AnyReading = Reading<unknown>;
type Struct = Record<string, unknown>;

/**
 * How refresh() judges a reading: 'passive' by max(own arrival, latest passive arrival), 'polled' by its own
 * arrival, 'held' not at all (stale-exempt keys, and keys no watched interface feeds).
 */
type Kind = 'passive' | 'polled' | 'held';

const KIND: Record<string, Kind> = Object.create(null) as Record<string, Kind>;
/** per interface, the passive non-exempt keys it feeds: dropped when the interface reports unavailable */
const PASSIVE_KEYS: Record<string, SnapshotKey[]> = Object.create(null) as Record<string, SnapshotKey[]>;
for (const raw of RAW_INTERFACES) {
  const passive: SnapshotKey[] = [];
  for (const key of raw.keys) {
    const exempt = STALE_EXEMPT_KEYS.indexOf(key) >= 0;
    KIND[key] = exempt ? 'held' : raw.polled ? 'polled' : 'passive';
    if (!exempt && !raw.polled) passive.push(key);
  }
  PASSIVE_KEYS[raw.iface] = passive;
}

function kindOf(key: string): Kind {
  return KIND[key] || 'held';
}

/** The vehicle-condition interface: the one watch that stays while suspended. */
function isConditionInterface(raw: RawInterface): boolean {
  return raw.keys.indexOf('condition') >= 0;
}

const STALE: AnyReading = Object.freeze(unavailable('stale'));

function isObject(v: unknown): v is Struct {
  return typeof v === 'object' && v !== null;
}

function describe(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unprintable error';
  }
}

function isReading(v: unknown): v is AnyReading {
  return isObject(v) && typeof v.available === 'boolean';
}

/** Same availability, reason, value, unit, source and time: publishing `next` over `prev` would change nothing. */
function sameReading(prev: unknown, next: AnyReading): boolean {
  if (prev === next) return true;
  if (!isReading(prev) || prev.available !== next.available) return false;
  if (!prev.available || !next.available) return !prev.available && !next.available && prev.reason === next.reason;
  return prev.value === next.value && prev.unit === next.unit && prev.source === next.source && prev.at === next.at;
}

/** A reading dated after `now` (the head-unit clock jumped backwards) is re-dated to `now`, so no age is negative. */
function notInFuture(r: AnyReading, now: number): AnyReading {
  return r.available && r.at > now ? available(r.value, r.unit, r.source, now) : r;
}

interface HeldWatch { iface: string; watch: unknown; condition: boolean }

export class BmwMguVehicleDataProvider implements VehicleDataProvider {
  private readonly signals: SignalsApi;
  private readonly clock: Clock;
  private readonly log: Log;
  private readonly staleAfterMs: number;
  private readonly missing: Record<string, true> = Object.create(null) as Record<string, true>;
  /** what the car last said, decoded; handlers write here */
  private readonly latest: VehicleSnapshot;
  /** what listeners and snapshot() see; only refresh() (and suspend()) write here */
  private readonly current: VehicleSnapshot;
  private state: DecoderState = createDecoderState();
  private readonly listeners: Array<{ listener: Listener; call: (snapshot: VehicleSnapshot) => void }> = [];
  /** the watches signals.watch resolved with, at most one per watched interface */
  private watches: HeldWatch[] = [];
  private running = false;
  private suspended = false;
  /**
   * Generations. A watch, or a value through its handlers, belongs to the generation it was created in; once
   * that is no longer current the watch is shut down when it arrives and its values are dropped, so
   * start/stop/suspend/resume in any order, even while the kit is still setting watches up, never leaves two
   * watches live. The vehicle-condition watch lives for a run (start() to stop()); the others for a
   * stretch between suspends (bumped by start, stop, suspend and resume).
   */
  private runGen = 0;
  private restGen = 0;
  /** a handler applied a value since the last refresh(), or suspend() changed what is published */
  private changed = false;
  /** the clock time of the latest on-change notification from any watched (non-polled) interface */
  private lastPassiveArrivalAt: number | null = null;
  /** interfaces whose watch has said it is available (only those can "report unavailable") */
  private upSeen: Record<string, true> = Object.create(null) as Record<string, true>;
  private refreshQueued = false;
  private readonly deferredRefresh: () => void;

  constructor(options: BmwProviderOptions) {
    this.signals = options.signals;
    this.clock = options.clock;
    this.log = options.log;
    this.staleAfterMs = typeof options.staleAfterMs === 'number' && options.staleAfterMs > 0 ? options.staleAfterMs : DEFAULT_STALE_AFTER_MS;
    for (const iface of options.missingInterfaces || []) this.missing[iface] = true;
    const now = this.clock.now();
    this.latest = this.baseline(now);
    this.current = this.baseline(now);
    this.deferredRefresh = safe(this.log, 'provider refresh', () => {
      this.refreshQueued = false;
      this.refresh();
    });
  }

  /**
   * One watch per interface the unit has; polled interfaces with pollMs. Every reading starts unreported
   * (Check Control and service items included): nothing from before a stop() is current truth. Resolves once
   * every watch is set up or failed.
   */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    this.suspended = false;
    this.runGen++;
    this.restGen++;
    this.forget(false);
    this.lastPassiveArrivalAt = null;
    this.upSeen = Object.create(null) as Record<string, true>;
    return this.watchInterfaces(true);
  }

  /**
   * Stops listening: later values are dropped and every watch is shut down (the kit's res.shutdown, which
   * clears its poll interval and shuts the interface's proxy down). What was published stays and ages.
   */
  stop(): Promise<void> {
    this.running = false;
    this.suspended = false;
    this.runGen++;
    this.restGen++;
    const watches = this.watches;
    this.watches = [];
    return Promise.all(watches.map((w) => this.shutdown(w.watch))).then(() => undefined);
  }

  /**
   * Sleep without going deaf: shuts every watch down except the passive vehicle-condition watch (so no kit
   * poll interval is left), marks every reading but `condition` not-reported, and keeps notifying listeners
   * when the condition changes (from a microtask, as no tick runs while suspended). No-op unless running.
   */
  suspend(): void {
    try {
      if (!this.running || this.suspended) return;
      this.suspended = true;
      this.restGen++;
      const keep: HeldWatch[] = [];
      const upSeen = Object.create(null) as Record<string, true>;
      for (const w of this.watches) {
        if (w.condition) {
          keep.push(w);
          if (this.upSeen[w.iface]) upSeen[w.iface] = true;
        } else {
          void this.shutdown(w.watch);
        }
      }
      this.watches = keep;
      this.upSeen = upSeen;
      this.forget(true);
      this.changed = true;
      this.publish(this.clock.now());
    } catch (error) {
      this.warn('provider suspend: ' + describe(error));
    }
  }

  /** Re-creates the watches suspend() shut down, with Check Control starting over. No-op unless suspended. */
  resume(): void {
    try {
      if (!this.running || !this.suspended) return;
      this.suspended = false;
      this.restGen++;
      this.forget(true);
      void this.watchInterfaces(false);
    } catch (error) {
      this.warn('provider resume: ' + describe(error));
    }
  }

  snapshot(): VehicleSnapshot {
    return this.current;
  }

  onChange(listener: Listener): () => void {
    const entry = { listener, call: safe(this.log, 'provider listener', listener) };
    this.listeners.push(entry);
    return () => {
      const i = this.listeners.indexOf(entry);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** The keys the snapshot delivers now (a tyre set counts when any wheel is available); diagnostics are off. */
  capabilities(): VehicleCapabilities {
    const delivers: SnapshotKey[] = [];
    const s = this.current as unknown as Struct;
    for (const key of Object.keys(s)) {
      if (key === 'takenAt') continue;
      const v = s[key];
      let delivered = false;
      if (isReading(v)) delivered = v.available;
      else if (isObject(v)) delivered = Object.keys(v).some((wheel) => isReading(v[wheel]) && (v[wheel] as AnyReading).available);
      if (delivered) delivers.push(key as SnapshotKey);
    }
    return { delivers, diagnosticsEnabled: false };
  }

  /** Called by the 1 Hz tick: stamps takenAt, judges every reading, notifies listeners if anything changed. */
  refresh(): VehicleSnapshot {
    const published = this.publish(this.clock.now());
    const changed = this.changed || published;
    this.changed = false;
    if (changed) for (const entry of this.listeners.slice()) entry.call(this.current);
    return this.current;
  }

  /* ---------- internals ---------- */

  /** A snapshot with nothing reported, diagnostics off and the unit's missing interfaces marked. */
  private baseline(now: number): VehicleSnapshot {
    const s = emptySnapshot(now);
    for (const key of DIAGNOSTIC_ONLY_KEYS) markUnavailable(s, key, 'diagnostics-disabled');
    for (const raw of RAW_INTERFACES) {
      if (this.missing[raw.iface]) for (const key of raw.keys) markUnavailable(s, key, 'not-on-this-vehicle');
    }
    return s;
  }

  /**
   * Drops what the car said (every reading but `condition` when keepCondition) and starts Check Control over:
   * a message the car cleared while we were not listening must not stay listed. The tyre-pressure display
   * unit is kept (it is the car's setting, not a reading).
   */
  private forget(keepCondition: boolean): void {
    const fresh = this.baseline(this.clock.now()) as unknown as Struct;
    const to = this.latest as unknown as Struct;
    for (const key of Object.keys(fresh)) {
      if (key === 'takenAt' || (keepCondition && key === 'condition')) continue;
      to[key] = fresh[key];
    }
    const unit = this.state.pressureUnit;
    this.state = createDecoderState();
    this.state.pressureUnit = unit;
  }

  /** Watches every interface the unit has (all but the condition interface when !withCondition). Never rejects. */
  private watchInterfaces(withCondition: boolean): Promise<void> {
    const run = this.runGen;
    const rest = this.restGen;
    const jobs: Array<Promise<void>> = [];
    for (const raw of RAW_INTERFACES) {
      if (this.missing[raw.iface]) continue;
      const condition = isConditionInterface(raw);
      if (condition && !withCondition) continue;
      const isCurrent = condition ? () => run === this.runGen : () => rest === this.restGen;
      const handlers: Record<string, (value: unknown) => void> = {};
      for (const field of raw.fields) handlers[field] = this.handler(raw.iface, field, raw.polled, isCurrent);
      let pending: Promise<unknown>;
      try {
        pending = Promise.resolve(this.signals.watch(raw.iface, SIGNAL_INSTANCE, handlers, this.log, raw.polled ? { pollMs: POLL_MS } : undefined));
      } catch (error) {
        pending = Promise.reject(error);
      }
      jobs.push(pending.then(
        (watch) => {
          if (isCurrent()) this.watches.push({ iface: raw.iface, watch, condition });
          else void this.shutdown(watch);       // stopped or suspended while this watch was being set up
        },
        (error: unknown) => this.warn('signals ' + raw.iface + ': ' + describe(error)),
      ));
    }
    return Promise.all(jobs).then(() => undefined);
  }

  /** A signal handler: decodes into `latest` and marks it changed, nothing else (while suspended: queues a refresh). */
  private handler(iface: string, field: string, polled: boolean, isCurrent: () => boolean): (value: unknown) => void {
    return safe(this.log, 'signal ' + field, (value: unknown) => {
      if (!isCurrent()) return;   // stopped, suspended, or a watch from an earlier start()
      const now = this.clock.now();
      applyRaw(this.latest, iface, field, value, now, this.state);
      // The kit hands a polled interface's poll results and its notifications to the same handler, so only
      // interfaces that are not polled count as the car actively notifying.
      if (!polled) this.lastPassiveArrivalAt = now;
      this.changed = true;
      if (this.suspended) this.queueRefresh();
    });
  }

  /** At most one refresh waiting, run from a microtask rather than from inside the kit's native callback. */
  private queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    void Promise.resolve().then(this.deferredRefresh);
  }

  /** An interface that said it was available and now says it is not: its passive readings are dropped. */
  private checkInterfaces(): void {
    for (const w of this.watches) {
      const watch = w.watch;
      if (!isObject(watch)) continue;
      if (watch.available === true) {
        this.upSeen[w.iface] = true;
      } else if (watch.available === false && this.upSeen[w.iface]) {
        delete this.upSeen[w.iface];
        const latest = this.latest as unknown as Struct;
        for (const key of PASSIVE_KEYS[w.iface] || []) latest[key] = unavailable('not-reported');
      }
    }
  }

  /** The reading listeners see for one decoded reading. */
  private judge(kind: Kind, r: AnyReading, prev: unknown, now: number): AnyReading {
    if (!r.available || kind === 'held') return r;
    let at = r.at;
    if (kind === 'passive' && this.lastPassiveArrivalAt !== null && this.lastPassiveArrivalAt > at) at = this.lastPassiveArrivalAt;
    if (now - at > this.staleAfterMs) return STALE;
    if (at === r.at) return r;
    if (isReading(prev) && prev.available && prev.at === at && prev.value === r.value && prev.unit === r.unit && prev.source === r.source) return prev;
    return available(r.value, r.unit, r.source, at);
  }

  /** Judges `latest` into the published snapshot; true when any published reading changed. */
  private publish(now: number): boolean {
    if (this.lastPassiveArrivalAt !== null && this.lastPassiveArrivalAt > now) this.lastPassiveArrivalAt = now;
    this.checkInterfaces();
    const from = this.latest as unknown as Struct;
    const to = this.current as unknown as Struct;
    let changed = false;
    for (const key of Object.keys(from)) {
      if (key === 'takenAt') continue;
      const kind = kindOf(key);
      const v = from[key];
      if (isReading(v)) {
        const r = notInFuture(v, now);
        if (r !== v) from[key] = r;
        const next = this.judge(kind, r, to[key], now);
        if (!sameReading(to[key], next)) { to[key] = next; changed = true; }
      } else if (isObject(v)) {
        const out = to[key];
        if (!isObject(out)) continue;
        for (const wheel of Object.keys(v)) {
          const w = v[wheel];
          if (!isReading(w)) continue;
          const r = notInFuture(w, now);
          if (r !== w) v[wheel] = r;
          const next = this.judge(kind, r, out[wheel], now);
          if (!sameReading(out[wheel], next)) { out[wheel] = next; changed = true; }
        }
      }
    }
    this.current.takenAt = now;
    return changed;
  }

  private shutdown(watch: unknown): Promise<void> {
    if (!isObject(watch) || typeof watch.shutdown !== 'function') return Promise.resolve();
    const fn = watch.shutdown as () => unknown;
    return Promise.resolve()
      .then(() => fn.call(watch))
      .then(() => undefined, (error: unknown) => this.warn('signals shutdown: ' + describe(error)));
  }

  private warn(message: string): void {
    try { this.log.warn(message); } catch { /* nothing more to do */ }
  }
}
