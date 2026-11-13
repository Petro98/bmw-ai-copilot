/**
 * The head unit's vehicle provider: passive SOME/IP subscriptions through the vendored kit's signals.watch
 * (car/kit/runtime/signals.js:53-83), nothing else.
 *
 * Read-only: it only watches fields (app.json declares them with the read/subscribe flags r and s), holds
 * no proxy of its own, calls no method and writes nothing. Diagnostic-only readings are always
 * diagnostics-disabled here.
 *
 * Handlers only decode (applyRaw): no logging, no I/O, no notification. Listeners hear about changes from
 * refresh(), which the app's 1 Hz tick calls while the ignition is on; when the car is parked the caller
 * stop()s the provider (and with it every watch) and stops ticking.
 */
import { emptySnapshot, unavailable } from '@copilot/vehicle-core';
import type {
  Clock, Reading, SnapshotKey, VehicleCapabilities, VehicleDataProvider, VehicleSnapshot,
} from '@copilot/vehicle-core';
import { safe, type Log } from '../safe';
import {
  DIAGNOSTIC_ONLY_KEYS, RAW_INTERFACES, STALE_EXEMPT_KEYS, applyRaw, createDecoderState, markUnavailable,
  type DecoderState,
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function describe(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unprintable error';
  }
}

function isReading(v: unknown): v is Reading<unknown> {
  return isObject(v) && typeof v.available === 'boolean';
}

/** The stale version of a reading, or null when it is still fresh (a clock that jumped backwards counts as fresh). */
function staleOrNull(reading: Reading<unknown>, now: number, staleAfterMs: number): Reading<unknown> | null {
  return reading.available && now - reading.at > staleAfterMs ? unavailable('stale') : null;
}

export class BmwMguVehicleDataProvider implements VehicleDataProvider {
  private readonly signals: SignalsApi;
  private readonly clock: Clock;
  private readonly log: Log;
  private readonly staleAfterMs: number;
  private readonly missing: Record<string, true> = Object.create(null) as Record<string, true>;
  private readonly current: VehicleSnapshot;
  private readonly state: DecoderState = createDecoderState();
  private readonly listeners: Array<{ listener: Listener; call: (snapshot: VehicleSnapshot) => void }> = [];
  /** what signals.watch resolved with, one per watched interface while running */
  private watches: unknown[] = [];
  private running = false;
  /**
   * Bumped by every start() and stop(). A watch, or a value through a handler, belongs to the start() that
   * captured the generation; once it is no longer current that watch is shut down and its values dropped, so
   * start() -> stop() -> start() while the kit is still setting watches up never leaves two watches live.
   */
  private generation = 0;
  /** a handler applied a value since the last refresh() */
  private changed = false;

  constructor(options: BmwProviderOptions) {
    this.signals = options.signals;
    this.clock = options.clock;
    this.log = options.log;
    this.staleAfterMs = typeof options.staleAfterMs === 'number' && options.staleAfterMs > 0 ? options.staleAfterMs : DEFAULT_STALE_AFTER_MS;
    for (const iface of options.missingInterfaces || []) this.missing[iface] = true;
    this.current = emptySnapshot(this.clock.now());
    for (const key of DIAGNOSTIC_ONLY_KEYS) markUnavailable(this.current, key, 'diagnostics-disabled');
    for (const raw of RAW_INTERFACES) {
      if (this.missing[raw.iface]) for (const key of raw.keys) markUnavailable(this.current, key, 'not-on-this-vehicle');
    }
  }

  /** One watch per interface the unit has; polled interfaces with pollMs. Resolves once every watch is set up or failed. */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    const generation = ++this.generation;
    const jobs: Array<Promise<void>> = [];
    for (const raw of RAW_INTERFACES) {
      if (this.missing[raw.iface]) continue;
      const handlers: Record<string, (value: unknown) => void> = {};
      for (const field of raw.fields) handlers[field] = this.handler(raw.iface, field, generation);
      let pending: Promise<unknown>;
      try {
        pending = Promise.resolve(this.signals.watch(raw.iface, SIGNAL_INSTANCE, handlers, this.log, raw.polled ? { pollMs: POLL_MS } : undefined));
      } catch (error) {
        pending = Promise.reject(error);
      }
      jobs.push(pending.then(
        (watch) => {
          if (generation === this.generation) this.watches.push(watch);
          else void this.shutdown(watch);       // stopped (and maybe restarted) while this watch was being set up
        },
        (error: unknown) => {
          try { this.log.warn('signals ' + raw.iface + ': ' + describe(error)); } catch { /* nothing more to do */ }
        },
      ));
    }
    return Promise.all(jobs).then(() => undefined);
  }

  /**
   * Stops listening: later values are dropped and every watch is shut down (the kit's res.shutdown, which
   * shuts the interface's proxy down).
   */
  stop(): Promise<void> {
    this.running = false;
    this.generation++;
    const watches = this.watches;
    this.watches = [];
    return Promise.all(watches.map((w) => this.shutdown(w))).then(() => undefined);
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
    const s = this.current as unknown as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      if (key === 'takenAt') continue;
      const v = s[key];
      let delivered = false;
      if (isReading(v)) delivered = v.available;
      else if (isObject(v)) delivered = Object.keys(v).some((wheel) => isReading(v[wheel]) && (v[wheel] as Reading<unknown>).available);
      if (delivered) delivers.push(key as SnapshotKey);
    }
    return { delivers, diagnosticsEnabled: false };
  }

  /** Called by the 1 Hz tick: stamps takenAt, marks old readings stale, notifies listeners if anything changed. */
  refresh(): VehicleSnapshot {
    const now = this.clock.now();
    const s = this.current;
    s.takenAt = now;
    let changed = this.changed;
    this.changed = false;
    const record = s as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === 'takenAt' || STALE_EXEMPT_KEYS.indexOf(key as SnapshotKey) >= 0) continue;
      const v = record[key];
      if (isReading(v)) {
        const stale = staleOrNull(v, now, this.staleAfterMs);
        if (stale) { record[key] = stale; changed = true; }
      } else if (isObject(v)) {
        for (const wheel of Object.keys(v)) {
          const r = v[wheel];
          const stale = isReading(r) ? staleOrNull(r, now, this.staleAfterMs) : null;
          if (stale) { v[wheel] = stale; changed = true; }
        }
      }
    }
    if (changed) for (const entry of this.listeners.slice()) entry.call(s);
    return s;
  }

  /** A signal handler: decodes into the snapshot and marks it changed, nothing else. */
  private handler(iface: string, field: string, generation: number): (value: unknown) => void {
    return safe(this.log, 'signal ' + field, (value: unknown) => {
      if (generation !== this.generation) return;   // stopped, or a watch from an earlier start()
      applyRaw(this.current, iface, field, value, this.clock.now(), this.state);
      this.changed = true;
    });
  }

  private shutdown(watch: unknown): Promise<void> {
    if (!isObject(watch) || typeof watch.shutdown !== 'function') return Promise.resolve();
    const fn = watch.shutdown as () => unknown;
    return Promise.resolve()
      .then(() => fn.call(watch))
      .then(() => undefined, (error: unknown) => {
        try { this.log.warn('signals shutdown: ' + describe(error)); } catch { /* nothing more to do */ }
      });
  }
}
