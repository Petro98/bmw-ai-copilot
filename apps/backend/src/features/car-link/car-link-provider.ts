import {
  emptySnapshot,
  type Clock, type Reading, type SnapshotKey, type TyreSet, type VehicleCapabilities, type VehicleDataProvider,
  type VehicleSnapshot,
} from '@copilot/vehicle-core';

/** The car counts as connected while its last batch is younger than this (Plan 2 Task 7). */
export const DEFAULT_OFFLINE_AFTER_MS = 180_000;

const TYRE_KEYS: ReadonlyArray<SnapshotKey> = ['tyrePressure', 'tyrePressureTarget'];

function isTyreSet(key: SnapshotKey): boolean {
  return TYRE_KEYS.includes(key);
}

/** A reading whose time lies after `limit` (a head-unit clock running ahead) gets `limit`, so it can only age. */
function capReading<T>(reading: Reading<T>, limit: number): Reading<T> {
  return reading.available && reading.at > limit ? { ...reading, at: limit } : reading;
}

function capTyres(set: TyreSet<Reading<number>>, limit: number): TyreSet<Reading<number>> {
  return {
    frontLeft: capReading(set.frontLeft, limit),
    frontRight: capReading(set.frontRight, limit),
    rearLeft: capReading(set.rearLeft, limit),
    rearRight: capReading(set.rearRight, limit),
  };
}

/**
 * A difference between the car's clock at send time (`sentAt`) and the backend's clock on arrival up to this size is
 * network latency or a held request, not a wrong clock, and is left alone.
 */
export const CLOCK_TOLERANCE_MS = 120_000;

/**
 * How far the head-unit clock is behind the backend's (negative: ahead), from the car's own clock at send time.
 * 0 when the batch carries no `sentAt` (an older car bundle) or the difference is within CLOCK_TOLERANCE_MS.
 * The head unit's clock can be days off (spec section 4) and is checked on the car only through certificate dates.
 */
export function clockOffset(sentAt: number | undefined, receivedAt: number): number {
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt)) return 0;
  const offset = receivedAt - sentAt;
  return Math.abs(offset) <= CLOCK_TOLERANCE_MS ? 0 : offset;
}

function shiftReading<T>(reading: Reading<T>, offset: number): Reading<T> {
  return reading.available ? { ...reading, at: reading.at + offset } : reading;
}

/** The snapshot with `takenAt`, every available reading's `at` and each Check Control `since` moved by `offset`. */
export function shiftSnapshot(snapshot: VehicleSnapshot, offset: number): VehicleSnapshot {
  if (offset === 0) return snapshot;
  const out = { ...snapshot, takenAt: snapshot.takenAt + offset } as Record<string, unknown>;
  for (const key of Object.keys(snapshot) as Array<keyof VehicleSnapshot>) {
    if (key === 'takenAt') continue;
    if (isTyreSet(key)) {
      const set = snapshot[key] as TyreSet<Reading<number>>;
      out[key] = {
        frontLeft: shiftReading(set.frontLeft, offset), frontRight: shiftReading(set.frontRight, offset),
        rearLeft: shiftReading(set.rearLeft, offset), rearRight: shiftReading(set.rearRight, offset),
      };
    } else {
      out[key] = shiftReading(snapshot[key] as Reading<unknown>, offset);
    }
  }
  const cc = snapshot.checkControl;
  if (cc.available) {
    out.checkControl = { ...cc, at: cc.at + offset, value: cc.value.map((message) => ({ ...message, since: message.since + offset })) };
  }
  return out as unknown as VehicleSnapshot;
}

/**
 * Times are kept as the car sent them (an offline car's readings age by their real `at`), except that nothing may lie
 * in the future of the moment the backend received it: otherwise a car clock running ahead would keep readings
 * looking fresh after the car went quiet.
 */
function capTimes(snapshot: VehicleSnapshot, receivedAt: number): VehicleSnapshot {
  const out = { ...snapshot, takenAt: Math.min(snapshot.takenAt, receivedAt) } as Record<string, unknown>;
  for (const key of Object.keys(snapshot) as Array<keyof VehicleSnapshot>) {
    if (key === 'takenAt') continue;
    out[key] = isTyreSet(key)
      ? capTyres(snapshot[key] as TyreSet<Reading<number>>, receivedAt)
      : capReading(snapshot[key] as Reading<unknown>, receivedAt);
  }
  return out as unknown as VehicleSnapshot;
}

function delivered(snapshot: VehicleSnapshot): SnapshotKey[] {
  const keys: SnapshotKey[] = [];
  for (const key of Object.keys(snapshot) as Array<keyof VehicleSnapshot>) {
    if (key === 'takenAt') continue;
    const value = snapshot[key];
    const ok = isTyreSet(key)
      ? Object.values(value as TyreSet<Reading<number>>).some((reading) => reading.available)
      : (value as Reading<unknown>).available;
    if (ok) keys.push(key);
  }
  return keys;
}

/**
 * The vehicle as the head unit reports it over the car link: the newest snapshot of the last validated batch.
 * It owns no timer and only receives; nothing here writes to or controls a vehicle. Alerts do not pass through
 * here: the car evaluates the rules itself and its alerts go to the hub directly (car-link/routes.ts).
 */
export class CarLinkVehicleDataProvider implements VehicleDataProvider {
  readonly offlineAfterMs: number;
  private readonly clock: Clock;
  private readonly listeners: Array<(snapshot: VehicleSnapshot) => void> = [];
  private latest: VehicleSnapshot | null = null;
  private lastBatchAt: number | null = null;

  constructor(options: { clock: Clock; offlineAfterMs?: number }) {
    this.clock = options.clock;
    const after = options.offlineAfterMs;
    this.offlineAfterMs = typeof after === 'number' && Number.isFinite(after) && after > 0 ? after : DEFAULT_OFFLINE_AFTER_MS;
  }

  async start(): Promise<void> {
    // Nothing to open: snapshots arrive through ingest().
  }

  async stop(): Promise<void> {
    // Nothing to close.
  }

  /** The last snapshot received, or every reading not reported before the first batch. */
  snapshot(): VehicleSnapshot {
    return this.latest ?? emptySnapshot(this.clock.now());
  }

  onChange(listener: (snapshot: VehicleSnapshot) => void): () => void {
    this.listeners.push(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  capabilities(): VehicleCapabilities {
    return { delivers: this.latest ? delivered(this.latest) : [], diagnosticsEnabled: false };
  }

  /**
   * A validated batch, oldest first (the car drains its ring buffer in order). The newest becomes the current
   * snapshot and is announced once: the hub publishes and samples at most once a second and once a minute, so
   * the older snapshots of a one-minute batch would only be dropped there.
   */
  ingest(snapshots: VehicleSnapshot[]): void {
    if (snapshots.length === 0) return;
    const now = this.clock.now();
    this.latest = capTimes(snapshots[snapshots.length - 1], now);
    this.lastBatchAt = now;
    const current = this.latest;
    for (const listener of this.listeners.slice()) {
      try {
        listener(current);
      } catch {
        // One failing listener must not keep the snapshot from the others.
      }
    }
  }

  /** True while the last batch is younger than `offlineAfterMs` (a server clock that stepped back counts as young). */
  connected(): boolean {
    if (this.lastBatchAt === null) return false;
    return this.clock.now() - this.lastBatchAt < this.offlineAfterMs;
  }
}
