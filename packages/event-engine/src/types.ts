import { Severity, VehicleSnapshot } from '@copilot/vehicle-core';

export type Provenance = 'bmw-check-control' | 'bmw-fault-status' | 'bmw-service' | 'owner-configured';

/** Limits the owner sets. `null` means "not set": the matching rule is inert. There are no built-in thresholds. */
export interface OwnerLimits {
  oilTempMaxC: number | null; coolantTempMaxC: number | null;
  battery12vMinPercent: number | null; tyrePressureDeviationBar: number | null;
}

/** All limits unset. */
export const NO_LIMITS: OwnerLimits = Object.freeze({
  oilTempMaxC: null,
  coolantTempMaxC: null,
  battery12vMinPercent: null,
  tyrePressureDeviationBar: null,
});

export interface Candidate { dedupKey: string; severity: Severity; title: string; detail: string | null }

export interface RuleContext {
  snapshot: VehicleSnapshot; now: number; limits: OwnerLimits;
  isActive(dedupKey: string): boolean;   // lets a rule apply its exit (hysteresis) threshold
}

export interface Rule {
  id: string; provenance: Provenance; dwellMs: number; cooldownMs: number;
  evaluate(ctx: RuleContext): Candidate[];
}

export interface AlertEvent {
  id: string; ruleId: string; dedupKey: string; provenance: Provenance; severity: Severity;
  title: string; detail: string | null; at: number; active: boolean; clearedAt: number | null;
}

export interface EngineOptions {
  rules: Rule[]; maxRaisedPerWindow: number; windowMs: number; historySize: number;
  suppress?: (snapshot: VehicleSnapshot) => boolean;
}

export interface EngineState { keys: Array<{ dedupKey: string; ruleId: string; firstSeenAt: number; lastRaisedAt: number | null; active: boolean }> }
