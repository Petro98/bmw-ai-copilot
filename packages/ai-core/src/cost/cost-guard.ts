import type { Clock } from '@copilot/vehicle-core';
import type { BilledAttempt, Usage, UsageStore } from '../types';
import { costUsd } from './prices';

export interface CostGuardOptions { dailyUsdLimit: number; monthlyUsdLimit: number; requestsPerMinute: number; clock: Clock; store: UsageStore }

export type Admission = { allowed: true } | { allowed: false; reason: 'daily-budget' | 'monthly-budget' | 'rate-limit' };

const RATE_WINDOW_MS = 60_000;

/** UTC day key 'YYYY-MM-DD'. */
function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** UTC month key 'YYYY-MM'. */
function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * Admits Claude requests against the owner's daily and monthly USD budgets and a per-minute
 * request rate, and records the cost of each answered request. Day and month keys are UTC.
 */
export class CostGuard {
  /** Times of admitted requests still inside the rate window; never longer than `requestsPerMinute`. */
  private admitted: number[] = [];

  constructor(private readonly options: CostGuardOptions) {}

  /** Checks budgets, then the rate. Counts the request toward the per-minute rate only when allowed. */
  admit(): Admission {
    const now = this.options.clock.now();
    const { monthUsd, dayUsd } = this.totalsAt(now);
    if (monthUsd >= this.options.monthlyUsdLimit) return { allowed: false, reason: 'monthly-budget' };
    if (dayUsd >= this.options.dailyUsdLimit) return { allowed: false, reason: 'daily-budget' };

    // Entries from the future (the clock jumped backwards) are dropped rather than kept,
    // so a wrong clock cannot lock the assistant out for days.
    this.admitted = this.admitted.filter((t) => t <= now && now - t < RATE_WINDOW_MS);
    if (this.admitted.length >= this.options.requestsPerMinute) return { allowed: false, reason: 'rate-limit' };
    this.admitted.push(now);
    return { allowed: true };
  }

  /** Stores the cost of an answered request under the current UTC day and returns it in USD. */
  record(model: string, usage: Usage): number {
    const usd = costUsd(model, usage);
    this.options.store.add(dayKey(this.options.clock.now()), model, usage, usd);
    return usd;
  }

  /**
   * Stores every billed attempt of one request (`ClaudeResult.billed`, or `ClaudeError.billed` for a
   * request that failed but was billed), each priced by its own model, and returns the total in USD.
   * Use it in place of `record` for that request, not in addition to it.
   */
  recordBilled(billed: ReadonlyArray<BilledAttempt>): number {
    let total = 0;
    for (const attempt of billed) total += this.record(attempt.model, attempt.usage);
    return total;
  }

  totals(): { dayUsd: number; monthUsd: number } {
    return this.totalsAt(this.options.clock.now());
  }

  private totalsAt(now: number): { dayUsd: number; monthUsd: number } {
    return {
      dayUsd: Math.max(0, this.options.store.usdForDay(dayKey(now))),
      monthUsd: Math.max(0, this.options.store.usdForMonth(monthKey(now))),
    };
  }
}
