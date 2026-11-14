import type { Usage } from '../types';

/** USD per million tokens. `cacheWritePerMTok` is the 5-minute cache write rate. */
export interface Price { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number }

/** A model's price and whether it came from the table (`fallback: false`) or is the unknown-model fallback. */
export interface PriceLookup { price: Price; fallback: boolean }

const price = (inputPerMTok: number, outputPerMTok: number, cacheReadPerMTok: number, cacheWritePerMTok: number): Price =>
  Object.freeze({ inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok });

// Source: the claude-api skill (model table "Current Models", cached 2026-11-03; shared/models.md;
// shared/prompt-caching.md "Economics"). Input and output rates are the table's. Cache reads are the
// per-model rates the skill states (Fable 5.2 / Mythos 5.2 $0.20, Fable 5.1 / Mythos 5.1 $0.25,
// Fable 5 / Mythos 5 $1, Opus 5.5 $0.20, Sonnet 5.5 $0.10); every other model uses the skill's general
// rule of 0.1x the input rate. 5-minute cache writes are 1.25x the input rate (Fable 5.2's $10 is stated).
// Claude Haiku 5.5 rates apply to prompts up to 100K tokens; this app's prompts stay far below that.
export const PRICES: Readonly<Record<string, Price>> = Object.freeze({
  'claude-fable-5-2': price(8, 40, 0.2, 10),
  'claude-mythos-5-2': price(8, 40, 0.2, 10),
  'claude-fable-5-1': price(10, 50, 0.25, 12.5),
  'claude-mythos-5-1': price(10, 50, 0.25, 12.5),
  'claude-fable-5': price(10, 50, 1, 12.5),
  'claude-mythos-5': price(10, 50, 1, 12.5),
  'claude-opus-5-5': price(4, 20, 0.2, 5),
  'claude-opus-5': price(5, 25, 0.5, 6.25),
  'claude-opus-4-8': price(5, 25, 0.5, 6.25),
  'claude-opus-4-7': price(5, 25, 0.5, 6.25),
  'claude-opus-4-6': price(5, 25, 0.5, 6.25),
  'claude-sonnet-5-5': price(2, 10, 0.1, 2.5),
  'claude-sonnet-5': price(2, 10, 0.2, 2.5),
  'claude-sonnet-4-6': price(3, 15, 0.3, 3.75),
  'claude-haiku-5-5': price(0.1, 0.5, 0.01, 0.125),
  'claude-haiku-4-5': price(1, 5, 0.1, 1.25),
  mock: price(0, 0, 0, 0),
});

const maxOf = (key: keyof Price): number => Math.max(...Object.values(PRICES).map((p) => p[key]));

/**
 * The price of a model the table does not list: the highest rate of each component across the table,
 * so a budget guard over-counts rather than under-counts. Model names are free-form configuration, and
 * a server-side refusal fallback can answer with a different model id than the one requested.
 */
export const FALLBACK_PRICE: Price = price(
  maxOf('inputPerMTok'), maxOf('outputPerMTok'), maxOf('cacheReadPerMTok'), maxOf('cacheWritePerMTok'),
);

/** The price of `model`, and whether it is the unknown-model fallback (so a caller can log that once). */
export function priceFor(model: string): PriceLookup {
  return Object.prototype.hasOwnProperty.call(PRICES, model)
    ? { price: PRICES[model]!, fallback: false }
    : { price: FALLBACK_PRICE, fallback: true };
}

/** Cost of one request in USD, and whether the model was priced with `FALLBACK_PRICE`. */
export function costUsdDetailed(model: string, usage: Usage): { usd: number; fallback: boolean } {
  const { price: p, fallback } = priceFor(model);
  const usd = (
    usage.inputTokens * p.inputPerMTok +
    usage.outputTokens * p.outputPerMTok +
    usage.cacheReadTokens * p.cacheReadPerMTok +
    usage.cacheWriteTokens * p.cacheWritePerMTok
  ) / 1_000_000;
  return { usd, fallback };
}

/** Cost of one request in USD. An unknown model is priced with `FALLBACK_PRICE`; see `costUsdDetailed`. */
export function costUsd(model: string, usage: Usage): number {
  return costUsdDetailed(model, usage).usd;
}
