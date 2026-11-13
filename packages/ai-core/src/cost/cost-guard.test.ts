import { describe, expect, test } from 'vitest';
import type { Usage, UsageStore } from '../types';
import { CostGuard, type CostGuardOptions } from './cost-guard';
import { costUsd, PRICES } from './prices';

/** In-memory UsageStore keyed by UTC day 'YYYY-MM-DD'. */
class MemoryUsageStore implements UsageStore {
  readonly rows: Array<{ day: string; model: string; usage: Usage; usd: number }> = [];
  add(day: string, model: string, usage: Usage, usd: number): void {
    this.rows.push({ day, model, usage, usd });
  }
  usdForDay(day: string): number {
    return this.rows.filter((r) => r.day === day).reduce((sum, r) => sum + r.usd, 0);
  }
  usdForMonth(month: string): number {
    return this.rows.filter((r) => r.day.startsWith(`${month}-`)).reduce((sum, r) => sum + r.usd, 0);
  }
}

class FakeClock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const START = Date.UTC(2026, 10, 13, 12, 0, 0); // 2026-11-13T12:00:00Z

const usage = (inputTokens: number, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0): Usage => ({
  inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
});

function guard(overrides: Partial<CostGuardOptions> = {}) {
  const clock = new FakeClock(START);
  const store = new MemoryUsageStore();
  const g = new CostGuard({
    dailyUsdLimit: 1, monthlyUsdLimit: 10, requestsPerMinute: 1000, clock, store, ...overrides,
  });
  return { g, clock, store };
}

describe('costUsd', () => {
  test('prices a request', () => {
    expect(costUsd('claude-opus-5-5', { inputTokens: 500, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0 }))
      .toBeCloseTo(0.0085, 6);
  });

  test('prices every token kind with the listed per-million rates', () => {
    const million = usage(1_000_000, 1_000_000, 1_000_000, 1_000_000);
    expect(costUsd('claude-opus-5-5', million)).toBeCloseTo(4 + 20 + 0.2 + 5, 9);
    expect(costUsd('claude-sonnet-5-5', million)).toBeCloseTo(2 + 10 + 0.1 + 2.5, 9);
    expect(costUsd('claude-haiku-5-5', million)).toBeCloseTo(0.1 + 0.5 + 0.01 + 0.125, 9);
    expect(costUsd('mock', million)).toBe(0);
  });

  test('an unknown model is priced as the most expensive listed one', () => {
    const u = usage(1234, 567, 8910, 1112);
    const mostExpensive = Math.max(...Object.keys(PRICES).map((m) => costUsd(m, u)));
    expect(costUsd('some-future-model', u)).toBe(costUsd('claude-opus-5-5', u));
    expect(costUsd('some-future-model', u)).toBe(mostExpensive);
  });
});

describe('CostGuard', () => {
  test('admits until the daily budget is spent, then refuses with daily-budget', () => {
    const { g } = guard({ dailyUsdLimit: 1 });
    expect(g.admit()).toEqual({ allowed: true });
    expect(g.record('claude-opus-5-5', usage(0, 30_000))).toBeCloseTo(0.6, 9);   // 30k output × $20/MTok
    expect(g.admit()).toEqual({ allowed: true });
    g.record('claude-opus-5-5', usage(0, 20_000));                                // +0.4 → 1.0
    expect(g.admit()).toEqual({ allowed: false, reason: 'daily-budget' });
    expect(g.totals().dayUsd).toBeCloseTo(1, 9);
  });

  test('the monthly budget wins over a fresh day', () => {
    const { g, clock } = guard({ dailyUsdLimit: 5, monthlyUsdLimit: 2 });
    g.record('claude-opus-5-5', usage(0, 100_000));                               // $2 on 2026-11-13
    clock.t = START + DAY;                                                          // 2026-11-14: day total is 0
    expect(g.totals()).toEqual({ dayUsd: 0, monthUsd: 2 });
    expect(g.admit()).toEqual({ allowed: false, reason: 'monthly-budget' });
  });

  test('the rate limit refuses the request above the limit and recovers a minute later', () => {
    const { g, clock } = guard({ requestsPerMinute: 2 });
    expect(g.admit().allowed).toBe(true);
    clock.t += 10_000;
    expect(g.admit().allowed).toBe(true);
    clock.t += 10_000;
    expect(g.admit()).toEqual({ allowed: false, reason: 'rate-limit' });
    clock.t = START + MINUTE;                                                       // first request leaves the window
    expect(g.admit().allowed).toBe(true);
    expect(g.admit()).toEqual({ allowed: false, reason: 'rate-limit' });
    clock.t = START + 10_000 + MINUTE + MINUTE;                                     // everything has left the window
    expect(g.admit().allowed).toBe(true);
  });

  test('a refused request does not count toward the rate', () => {
    const { g, clock } = guard({ requestsPerMinute: 1 });
    expect(g.admit().allowed).toBe(true);
    for (let i = 0; i < 5; i++) {
      clock.t += 5_000;
      expect(g.admit().allowed).toBe(false);
    }
    clock.t = START + MINUTE;
    expect(g.admit().allowed).toBe(true);
  });

  test('a new UTC day resets the daily total', () => {
    const { g, clock, store } = guard({ dailyUsdLimit: 1 });
    clock.t = Date.UTC(2026, 10, 13, 23, 59, 0);
    g.record('claude-opus-5-5', usage(0, 50_000));                                // $1
    expect(g.admit()).toEqual({ allowed: false, reason: 'daily-budget' });
    clock.t = Date.UTC(2026, 10, 14, 0, 0, 0);
    expect(g.totals().dayUsd).toBe(0);
    expect(g.admit()).toEqual({ allowed: true });
    expect(store.rows[0]?.day).toBe('2026-11-13');
  });

  test('record stores the cost under the UTC day and returns it', () => {
    const { g, store } = guard();
    const u = usage(500, 300, 2500, 0);
    const usd = g.record('claude-opus-5-5', u);
    expect(usd).toBeCloseTo(0.0085, 9);
    expect(store.rows).toEqual([{ day: '2026-11-13', model: 'claude-opus-5-5', usage: u, usd }]);
  });

  test('a clock moving backwards does not make admit() throw or go negative', () => {
    const { g, clock } = guard({ requestsPerMinute: 2 });
    g.record('claude-opus-5-5', usage(0, 1000));
    expect(g.admit().allowed).toBe(true);
    expect(g.admit().allowed).toBe(true);
    clock.t = START - 3 * DAY;                                                      // head-unit clock days off
    expect(() => g.admit()).not.toThrow();
    const t = g.totals();
    expect(t.dayUsd).toBeGreaterThanOrEqual(0);
    expect(t.monthUsd).toBeGreaterThanOrEqual(0);
    clock.t = START - 3 * DAY - 30_000;                                             // and backwards again
    expect(() => g.admit()).not.toThrow();
    expect(() => g.record('claude-opus-5-5', usage(10, 10))).not.toThrow();
    clock.t = START + 5_000;                                                        // back to real time
    expect(() => g.admit()).not.toThrow();
  });
});
