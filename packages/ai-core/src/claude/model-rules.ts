/** Per-model request rules the gateway applies. */
export interface ModelRules { supportsServerFallback: boolean }

// Models that accept the server-side refusal fallback (`fallbacks: 'default'` with the
// `server-side-fallback-2026-07-01` beta), per the claude-api skill. Claude Haiku 5.5 has no
// server-side fallback; unknown ids get none either, so a request never carries a parameter
// its model may reject.
const SERVER_FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

export function rulesFor(model: string): ModelRules {
  return { supportsServerFallback: SERVER_FALLBACK_MODELS.has(model) };
}
