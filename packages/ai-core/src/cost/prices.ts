import type { Usage } from '../types';

/** USD per million tokens. `cacheWritePerMTok` is the 5-minute cache write rate. */
export interface Price { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number }

// Rates from Plan 1 Task 9, checked against the claude-api skill (model table cached 2026-11-03):
// cache reads as listed per model, 5-minute cache writes at 1.25x the input rate.
// Claude Haiku 5.5 rates apply to prompts up to 100K tokens; this app's prompts stay far below that.
export const PRICES: Readonly<Record<string, Price>> = Object.freeze({
  'claude-opus-5-5': Object.freeze({ inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 }),
  'claude-sonnet-5-5': Object.freeze({ inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2.5 }),
  'claude-haiku-5-5': Object.freeze({ inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 }),
  mock: Object.freeze({ inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }),
});

/** The most expensive listed model; an unknown model is priced as this one so a budget never undercounts. */
const FALLBACK_MODEL = 'claude-opus-5-5';

/** Cost of one request in USD. An unknown model is priced as `claude-opus-5-5`. */
export function costUsd(model: string, usage: Usage): number {
  const price = Object.prototype.hasOwnProperty.call(PRICES, model) ? PRICES[model]! : PRICES[FALLBACK_MODEL]!;
  return (
    usage.inputTokens * price.inputPerMTok +
    usage.outputTokens * price.outputPerMTok +
    usage.cacheReadTokens * price.cacheReadPerMTok +
    usage.cacheWriteTokens * price.cacheWritePerMTok
  ) / 1_000_000;
}
