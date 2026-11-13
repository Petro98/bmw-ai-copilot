import {
  MOVING_ABOVE_KMH,
  type Clock,
  type Reading,
  type SnapshotKey,
  type TyreSet,
  type VehicleCondition,
  type VehicleSnapshot,
} from '@copilot/vehicle-core';

/**
 * What the rest of the app may do (wired in Task 9):
 * - `asleep`  → no timer at all, no network, connections closed, state file written once;
 * - `awake`   → 1 Hz tick, network only for an alert or a question;
 * - `driving` → 1 Hz tick and the once-a-minute snapshot upload.
 */
export type PowerState = 'asleep' | 'awake' | 'driving';

/**
 * 15 min, the kit's Ambient config convention for a car that does not report its own state:
 * idrive7-apps@4a8deb7:apps/ambient_config/main.js:44 `const IDLE_MS = 15 * 60000;`
 * (also .research/reports/footprint.md:68 and .research/reports/lifecycle.md:82-83).
 */
export const IDLE_FALLBACK_MS = 900_000;

const CONDITION_TO_STATE: Readonly<Record<VehicleCondition, PowerState>> = {
  parked: 'asleep',
  standby: 'asleep',
  living: 'awake',
  'ignition-on': 'awake',
  starting: 'awake',
  stopping: 'awake',
  driving: 'driving',
};

const TYRE_SETS: ReadonlyArray<'tyrePressure' | 'tyrePressureTarget'> = ['tyrePressure', 'tyrePressureTarget'];
const TYRE_POSITIONS: ReadonlyArray<keyof TyreSet<unknown>> = ['frontLeft', 'frontRight', 'rearLeft', 'rearRight'];

type Listener = (next: PowerState, previous: PowerState) => void;

/**
 * Decides whether the app may run at all. Pure and timer-free: the caller feeds it a snapshot on every
 * tick and on every condition change. Listeners are called synchronously from `update()`; callers wrap
 * them in `safe()`.
 */
export class PowerGate {
  private readonly clock: Clock;
  private readonly idleFallbackMs: number;
  private current: PowerState = 'awake';
  private listeners: Listener[] = [];
  /** The last `at` seen per reading path; a fixed set of keys, so bounded. */
  private lastAt: Record<string, number> = {};
  /** Clock time at which a reading's `at` last changed (or the gate was created). */
  private lastActivityAt: number;

  constructor(options: { clock: Clock; idleFallbackMs?: number }) {
    this.clock = options.clock;
    this.idleFallbackMs = options.idleFallbackMs !== undefined ? options.idleFallbackMs : IDLE_FALLBACK_MS;
    this.lastActivityAt = this.clock.now();
  }

  /** Call on every tick and on every condition change. */
  update(snapshot: VehicleSnapshot): PowerState {
    const now = this.clock.now();
    // A head-unit clock can jump backwards: count the idle fallback from the jump, never from the future.
    if (now < this.lastActivityAt) this.lastActivityAt = now;
    if (this.sawFreshReading(snapshot)) this.lastActivityAt = now;

    const next = this.decide(snapshot, now);
    const previous = this.current;
    if (next !== previous) {
      this.current = next;
      const listeners = this.listeners.slice();
      for (let i = 0; i < listeners.length; i++) listeners[i](next, previous);
    }
    return next;
  }

  state(): PowerState {
    return this.current;
  }

  onChange(listener: Listener): () => void {
    this.listeners = this.listeners.concat([listener]);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private decide(snapshot: VehicleSnapshot, now: number): PowerState {
    const condition = snapshot.condition;
    if (condition.available) {
      const mapped = CONDITION_TO_STATE[condition.value];
      if (mapped !== undefined) return mapped;
    }
    if (snapshot.speed.available && snapshot.speed.value > MOVING_ABOVE_KMH) return 'driving';
    return now - this.lastActivityAt >= this.idleFallbackMs ? 'asleep' : 'awake';
  }

  /**
   * True when any available reading carries an `at` different from the one last seen for it. "Different",
   * not "later": after the clock moves back, a genuinely new reading is stamped earlier than the old one.
   */
  private sawFreshReading(snapshot: VehicleSnapshot): boolean {
    let fresh = false;
    const keys = Object.keys(snapshot) as Array<keyof VehicleSnapshot>;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === 'takenAt') continue;
      if (key === 'tyrePressure' || key === 'tyrePressureTarget') continue;
      if (this.note(key, snapshot[key as SnapshotKey] as Reading<unknown>)) fresh = true;
    }
    for (let i = 0; i < TYRE_SETS.length; i++) {
      const set = snapshot[TYRE_SETS[i]];
      if (!set) continue;
      for (let j = 0; j < TYRE_POSITIONS.length; j++) {
        if (this.note(TYRE_SETS[i] + '.' + TYRE_POSITIONS[j], set[TYRE_POSITIONS[j]])) fresh = true;
      }
    }
    return fresh;
  }

  private note(path: string, reading: Reading<unknown> | undefined): boolean {
    if (!reading || !reading.available) return false;
    if (this.lastAt[path] === reading.at) return false;
    this.lastAt[path] = reading.at;
    return true;
  }
}
