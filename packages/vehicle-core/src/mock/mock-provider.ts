import type { ScenarioId } from '../index';
import { Clock, TimerApi } from '../clock';
import { VehicleCapabilities, VehicleDataProvider } from '../provider';
import { Reading } from '../reading';
import { SnapshotKey, TyreSet, VehicleSnapshot } from '../snapshot';
import { SCENARIOS, Scenario } from './scenarios';

export interface MockProviderOptions { clock: Clock; timers: TimerApi; scenario?: ScenarioId; tickMs?: number }

const DEFAULT_SCENARIO: ScenarioId = 'steady-cruise';
const DEFAULT_TICK_MS = 1000;

function findScenario(id: ScenarioId): Scenario {
  for (const s of SCENARIOS) if (s.id === id) return s;
  throw new Error('Unknown mock scenario: ' + String(id));
}

function isReading(v: Reading<unknown> | TyreSet<Reading<number>>): v is Reading<unknown> {
  return typeof (v as Reading<unknown>).available === 'boolean';
}

/**
 * A read-only, deterministic mock vehicle. Time and timers are injected; it never touches a real car.
 * The snapshot is a pure function of the scenario and of the time elapsed since the scenario started.
 */
export class MockVehicleDataProvider implements VehicleDataProvider {
  private readonly clock: Clock;
  private readonly timers: TimerApi;
  private readonly tickMs: number;
  private scenario: Scenario;
  private startedAt: number;
  private current: VehicleSnapshot;
  private listeners: Array<(snapshot: VehicleSnapshot) => void> = [];
  private handle: unknown = null;
  private running = false;

  constructor(options: MockProviderOptions) {
    this.clock = options.clock;
    this.timers = options.timers;
    this.tickMs = options.tickMs === undefined ? DEFAULT_TICK_MS : options.tickMs;
    this.scenario = findScenario(options.scenario === undefined ? DEFAULT_SCENARIO : options.scenario);
    this.startedAt = this.clock.now();
    this.current = this.build();
  }

  start(): Promise<void> {
    if (!this.running) {
      this.running = true;
      this.handle = this.timers.setInterval(() => this.tick(), this.tickMs);
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (this.running) {
      this.running = false;
      this.timers.clearInterval(this.handle);
      this.handle = null;
    }
    return Promise.resolve();
  }

  snapshot(): VehicleSnapshot {
    return this.current;
  }

  onChange(listener: (snapshot: VehicleSnapshot) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** The keys the current snapshot actually delivers (a tyre set counts when any wheel is available). */
  capabilities(): VehicleCapabilities {
    const s = this.current;
    const delivers: SnapshotKey[] = [];
    for (const key of Object.keys(s) as Array<keyof VehicleSnapshot>) {
      if (key === 'takenAt') continue;
      const v = s[key];
      const delivered = isReading(v)
        ? v.available
        : v.frontLeft.available || v.frontRight.available || v.rearLeft.available || v.rearRight.available;
      if (delivered) delivers.push(key);
    }
    return { delivers, diagnosticsEnabled: false };
  }

  /** Switches scenario, restarts elapsed time and notifies listeners at once. */
  setScenario(id: ScenarioId): void {
    this.scenario = findScenario(id);
    this.startedAt = this.clock.now();
    this.current = this.build();
    this.notify();
  }

  scenarioId(): ScenarioId {
    return this.scenario.id;
  }

  /** Rebuilds the snapshot for the clock's current time and notifies listeners. */
  tick(): void {
    this.current = this.build();
    this.notify();
  }

  private build(): VehicleSnapshot {
    const now = this.clock.now();
    // A clock that jumps backwards (head-unit clocks can be days off) holds the scenario at its start.
    const elapsed = now > this.startedAt ? now - this.startedAt : 0;
    return this.scenario.build(elapsed, now);
  }

  /**
   * Calls every listener. A listener that throws is skipped so the others still run and nothing
   * escapes the timer callback or setScenario (spec §6: never throws out of a timer/handler).
   */
  private notify(): void {
    const snapshot = this.current;
    for (const listener of this.listeners.slice()) {
      try {
        listener(snapshot);
      } catch (e) {
        // Deliberately ignored so one failing subscriber does not stop the others. The binding
        // stays because ES2017 (Node 8) has no optional catch binding.
        void e;
      }
    }
  }
}
