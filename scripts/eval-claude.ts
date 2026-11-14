/*
 * Opt-in answer check against the real Claude API. It costs money and needs a key, so it is never run in CI or by
 * the test suite.
 *
 *   ANTHROPIC_API_KEY=... npx tsx --tsconfig tsconfig.base.json scripts/eval-claude.ts
 *
 * It asks the six fixed questions of the panel's topic chips against three mock scenarios (18 requests) through the
 * real gateway, with the backend's model, effort, token and timeout configuration (CLAUDE_* variables, same defaults
 * as the backend), and prints each answer. After each answer it lists every car-style number (a value with °C, бар,
 * км, л, % or В) that does not occur in the rendered snapshot Claude was given: a candidate for an invented value,
 * to be read by a person. Nothing is stored and nothing talks to a vehicle; the snapshots come from the mock
 * scenarios. The API key is read from the environment only and is never printed.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicGateway, buildPrompt, renderSnapshot, toClaudeError, type Usage } from '@copilot/ai-core';
import { NO_LIMITS } from '@copilot/event-engine';
import { SCENARIOS, type ScenarioId } from '@copilot/vehicle-core';
import { loadConfig } from '../apps/backend/src/config';

/** The six topic-chip questions of the panel's assistant screen (Plan 1 Task 15). */
const QUESTIONS: readonly string[] = [
  'Як почувається авто?',
  'Чи можна навантажувати двигун?',
  'Що з шинами?',
  'Коли наступний сервіс?',
  'Чи є помилки?',
  'Як змінилися показники за останній місяць?',
];

/** A normal drive, a Check Control warning, and a car that reports nothing. */
const EVAL_SCENARIOS: readonly ScenarioId[] = ['steady-cruise', 'overheat-check-control', 'signals-missing'];

/** Time into each scenario at which the snapshot is taken (the overheat Check Control message starts at 60 s). */
const ELAPSED_MS = 90_000;

/** A car-style number in an answer (Plan 1 Task 16). */
const CAR_NUMBER = /\d+([,.]\d+)? ?(°C|бар|км|л|%|В)/gu;
const ANY_NUMBER = /\d+([,.]\d+)?/gu;

/** Error codes after which the remaining requests cannot succeed either. */
const FATAL = new Set(['auth', 'credit-exhausted', 'bad-request']);

function numericValue(text: string): number {
  return Number.parseFloat(text.replace(',', '.'));
}

/** Car-style numbers in `answer` whose value does not occur anywhere in `rendered`. */
function unsupportedNumbers(answer: string, rendered: string): string[] {
  const known = new Set((rendered.match(ANY_NUMBER) ?? []).map(numericValue));
  const out: string[] = [];
  for (const match of answer.matchAll(CAR_NUMBER)) {
    const value = numericValue(match[0].match(ANY_NUMBER)![0]);
    if (!known.has(value)) out.push(match[0]);
  }
  return out;
}

async function main(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (apiKey.trim() === '') {
    console.error('ANTHROPIC_API_KEY is not set. This opt-in script calls the real Claude API and refuses to start without a key.');
    return 2;
  }
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ ...process.env, CLAUDE_MODE: 'live' });
  } catch (error) {
    // The same readable list of invalid variables the backend prints at startup (it never contains the key).
    console.error(error instanceof Error ? error.message : 'Invalid configuration.');
    return 2;
  }
  const gateway = new AnthropicGateway(new Anthropic({ apiKey: config.anthropicApiKey ?? apiKey }));
  const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let flagged = 0;
  let failed = 0;

  console.log(`Model ${config.claudeModel}, effort ${config.claudeEffort}, ${EVAL_SCENARIOS.length * QUESTIONS.length} requests.\n`);
  for (const id of EVAL_SCENARIOS) {
    const scenario = SCENARIOS.find((s) => s.id === id)!;
    const now = Date.now();
    const snapshot = scenario.build(ELAPSED_MS, now);
    const rendered = renderSnapshot(snapshot, now);
    console.log(`=== ${scenario.id} (${scenario.title})\n${rendered}\n`);

    for (const question of QUESTIONS) {
      const prompt = buildPrompt({
        question, style: 'full', snapshot, alerts: [], limits: NO_LIMITS, history: [], trendSummary: null,
        vehicleLabel: config.vehicleLabel, now,
      });
      console.log(`--- ${question}`);
      try {
        const result = await gateway.ask(prompt, {
          model: config.claudeModel, effort: config.claudeEffort, maxTokens: config.claudeMaxTokens,
          timeoutMs: config.claudeTimeoutMs,
        });
        for (const key of Object.keys(total) as Array<keyof Usage>) total[key] += result.usage[key];
        console.log(result.text);
        const unsupported = unsupportedNumbers(result.text, rendered);
        if (unsupported.length > 0) {
          flagged++;
          console.log(`!! numbers not in the snapshot: ${unsupported.join('; ')}`);
        }
        console.log(`(model ${result.model}, ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens)\n`);
      } catch (error) {
        const code = toClaudeError(error).code;   // the code only: never the raw error, which could carry request details
        failed++;
        console.log(`!! request failed: ${code}\n`);
        if (FATAL.has(code)) {
          console.error(`Stopping: ${code} will not change for the remaining requests.`);
          return 1;
        }
      }
    }
  }

  console.log(`Answers with numbers not in the snapshot: ${flagged}. Failed requests: ${failed}.`);
  console.log(`Tokens: ${total.inputTokens} in, ${total.outputTokens} out, ${total.cacheReadTokens} cache read, ${total.cacheWriteTokens} cache write.`);
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => { process.exitCode = code; },
  () => {
    console.error('eval-claude failed unexpectedly.');
    process.exitCode = 1;
  },
);
