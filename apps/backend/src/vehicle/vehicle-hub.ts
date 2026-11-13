import type { AlertEvent, EventEngine } from '@copilot/event-engine';
import type { Clock, VehicleDataProvider, VehicleSnapshot } from '@copilot/vehicle-core';
import type { AlertStore } from '../stores/alert-store';
import type { SettingsStore } from '../stores/settings-store';
import { sampleFromSnapshot, type TelemetryStore } from '../stores/telemetry-store';
import type { LiveBus } from './live-bus';

export interface VehicleHubOptions {
  provider: VehicleDataProvider; engine: EventEngine | null;      // null when alerts arrive from the car (Plan 2)
  alerts: AlertStore; telemetry: TelemetryStore; settings: SettingsStore; bus: LiveBus; clock: Clock;
  sampleIntervalMs: number; retentionDays: number; snapshotPublishIntervalMs?: number;   // default 1000
}

const DEFAULT_SNAPSHOT_PUBLISH_INTERVAL_MS = 1000;
const DAY_MS = 86_400_000;

/** UTC day 'YYYY-MM-DD' of an epoch-millisecond time. */
function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * True when `intervalMs` has passed since `last`, or when there was no `last`, or when the clock went
 * backwards past it (head-unit clocks can be days off): the pace then restarts from the new time
 * instead of stalling until the old time comes round again.
 */
function due(last: number | null, now: number, intervalMs: number): boolean {
  return last === null || now < last || now - last >= intervalMs;
}

/**
 * Wires the vehicle provider to the rule engine, the stores and the live bus. It owns no timer: every step
 * runs on a provider change. It only reads the vehicle; nothing here writes to or controls a vehicle.
 */
export class VehicleHub {
  private readonly options: VehicleHubOptions;
  private readonly snapshotIntervalMs: number;
  private unsubscribe: (() => void) | null = null;
  private lastSeenAt: number | null = null;
  private lastPublishedAt: number | null = null;
  private lastSample: { clockAt: number; day: string } | null = null;
  /**
   * Engine alerts the AlertStore holds as active, by id. Seeded from the store on start and kept equal to
   * `engine.active()` after every evaluation. Its size is that of the active set, so it stays bounded.
   */
  private readonly storedActive = new Map<string, AlertEvent>();

  constructor(options: VehicleHubOptions) {
    this.options = options;
    const interval = options.snapshotPublishIntervalMs;
    this.snapshotIntervalMs = typeof interval === 'number' && Number.isFinite(interval) && interval >= 0
      ? interval
      : DEFAULT_SNAPSHOT_PUBLISH_INTERVAL_MS;
  }

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.storedActive.clear();
    if (this.options.engine) {
      // After a restart the engine's saved state has no event content: what the store still holds as active is
      // reconciled with engine.active() after the first evaluation.
      for (const alert of this.options.alerts.active()) this.storedActive.set(alert.id, alert);
    }
    this.unsubscribe = this.options.provider.onChange((snapshot) => this.onChange(snapshot));
    await this.options.provider.start();
  }

  async stop(): Promise<void> {
    if (!this.unsubscribe) return;
    this.unsubscribe();
    this.unsubscribe = null;
    // The next start may come after midnight, when this run can no longer see the day change: roll up now.
    // An idempotent upsert; the day is rolled up again, complete, if it changes later in a run.
    try {
      if (this.lastSample) this.options.telemetry.rollUpDay(this.lastSample.day);
    } catch {
      // A failing store must not keep the provider running.
    }
    await this.options.provider.stop();
  }

  snapshot(): VehicleSnapshot {
    return this.options.provider.snapshot();
  }

  /** `takenAt` of the last snapshot the provider delivered while the hub ran; null before the first. */
  lastSnapshotAt(): number | null {
    return this.lastSeenAt;
  }

  /** An alert decided elsewhere (the car, Plan 2): persisted and published as it is. */
  ingestAlert(event: AlertEvent): void {
    this.options.alerts.upsert(event);
    this.options.bus.publish({ type: 'alert', alert: event });
  }

  private onChange(snapshot: VehicleSnapshot): void {
    const now = this.options.clock.now();
    this.lastSeenAt = snapshot.takenAt;
    // Each step is independent: a failing store must not keep the snapshot from the panel, or the reverse.
    // Nothing is lost for good: the next change repeats every step from the current state.
    try {
      this.evaluate(snapshot, now);
    } catch {
      // The alert state is re-derived from engine.active() on the next change.
    }
    try {
      this.publishSnapshot(snapshot, now);
    } catch {
      // Dropped; the next change publishes a fresh one.
    }
    try {
      this.sample(snapshot, now);
    } catch {
      // Skipped; the next change samples again.
    }
  }

  private evaluate(snapshot: VehicleSnapshot, now: number): void {
    const engine = this.options.engine;
    if (!engine) return;
    const limits = this.options.settings.get().ownerLimits;
    for (const event of engine.evaluate(snapshot, now, limits)) this.record(event);
    this.reconcile(engine.active(), now);
  }

  /**
   * Makes the store agree with the engine for the two transitions the engine does not return as events:
   * a key active again inside its cooldown (re-opened under the id of its last raise), and a key that ends
   * without an announced event (a restored key whose condition is gone, or such a re-opened key).
   */
  private reconcile(active: AlertEvent[], now: number): void {
    const activeIds = new Set<string>();
    for (const alert of active) {
      activeIds.add(alert.id);
      if (!this.storedActive.has(alert.id)) this.record({ ...alert, active: true, clearedAt: null });
    }
    for (const alert of Array.from(this.storedActive.values())) {
      if (!activeIds.has(alert.id)) this.record({ ...alert, active: false, clearedAt: now });
    }
  }

  /** Persists and publishes one engine alert, then tracks whether the store now holds it as active. */
  private record(event: AlertEvent): void {
    this.options.alerts.upsert(event);
    if (event.active) this.storedActive.set(event.id, event);
    else this.storedActive.delete(event.id);
    this.options.bus.publish({ type: 'alert', alert: event });
  }

  private publishSnapshot(snapshot: VehicleSnapshot, now: number): void {
    if (!due(this.lastPublishedAt, now, this.snapshotIntervalMs)) return;
    this.lastPublishedAt = now;
    this.options.bus.publish({ type: 'snapshot', snapshot });
  }

  /** One telemetry sample per interval; when the UTC day of the samples changed, roll up the previous day and prune. */
  private sample(snapshot: VehicleSnapshot, now: number): void {
    const last = this.lastSample;
    if (!Number.isFinite(snapshot.takenAt)) return;
    if (!due(last === null ? null : last.clockAt, now, this.options.sampleIntervalMs)) return;
    const telemetry = this.options.telemetry;
    const sample = sampleFromSnapshot(snapshot);
    const day = utcDay(sample.at);   // throws for a time outside the Date range, before anything is stored
    this.lastSample = { clockAt: now, day };
    telemetry.addSample(sample);
    if (last === null) {
      // First sample since start: a run that ended without stop() (a crash) may have missed the day change.
      // Skipped when an earlier prune may have taken part of that day, so a complete roll-up is never
      // overwritten by a partial one. A gap of more than one day after a crash is not recovered here.
      const previousStart = Date.parse(`${day}T00:00:00Z`) - DAY_MS;
      if (previousStart >= now - this.options.retentionDays * DAY_MS) telemetry.rollUpDay(utcDay(previousStart));
      // A run may never see a day change (stopped and started every day), so each run also prunes once here.
      // It follows the roll-up, whose day lies inside the retention when it runs: the prune cannot take part of it.
      telemetry.prune(this.options.retentionDays, now);
    } else if (last.day !== day) {
      telemetry.rollUpDay(last.day);
      telemetry.prune(this.options.retentionDays, now);
    }
  }
}
