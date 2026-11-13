import {
  buildPrompt, toClaudeError, userMessageFor,
  type ClaudeErrorCode, type ClaudeGateway, type ClaudeResult, type CostGuard, type Effort,
} from '@copilot/ai-core';
import { MAX_QUESTION_CHARS, type ApiErrorCode, type AskRequest, type DialogTurn } from '@copilot/shared';
import type { Clock } from '@copilot/vehicle-core';
import type { AlertStore } from '../stores/alert-store';
import type { DialogStore } from '../stores/dialog-store';
import type { SettingsStore } from '../stores/settings-store';
import type { TelemetryStore } from '../stores/telemetry-store';
import type { VehicleHub } from '../vehicle/vehicle-hub';
import { trendSummary } from './trend-summary';

export interface AssistantConfig {
  model: string; voiceModel: string; effort: Effort; voiceEffort: Effort; maxTokens: number; timeoutMs: number;
  historyTurns: number; vehicleLabel: string | null;
}

/** A question that got no answer. `message` is Ukrainian and safe to display; it never holds a secret. */
export class AssistantError extends Error {
  constructor(readonly code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'AssistantError';
  }
}

export interface AssistantDeps {
  hub: Pick<VehicleHub, 'snapshot'>;
  dialog: Pick<DialogStore, 'add' | 'lastTurns'>;
  alerts: Pick<AlertStore, 'active'>;
  settings: Pick<SettingsStore, 'get'>;
  telemetry: Pick<TelemetryStore, 'dailySummaries'>;
  gateway: ClaudeGateway;
  guard: CostGuard;
  clock: Clock;
  config: AssistantConfig;
  newId: () => string;
}

/** Days of roll-ups the trend summary looks at. */
const TREND_DAYS = 30;

// Ukrainian, sentence case, no exclamation marks (docs/design/README.md → Content).
const MESSAGES = {
  empty: 'Введіть питання.',
  tooLong: `Питання задовге: не більше ${MAX_QUESTION_CHARS} символів.`,
  dailyBudget: 'Денний бюджет на запити до Claude вичерпано. Спробуйте завтра.',
  monthlyBudget: 'Місячний бюджет на запити до Claude вичерпано. Спробуйте наступного місяця.',
  rateLimit: 'Забагато питань за хвилину. Спробуйте трохи пізніше.',
} as const;

function apiCodeFor(code: ClaudeErrorCode): ApiErrorCode {
  if (code === 'refusal') return 'claude-refused';
  if (code === 'rate-limited') return 'rate-limited';
  return 'claude-unavailable';
}

/** UTC day 'YYYY-MM-DD'. */
function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Answers one question: budget gate, prompt from the current vehicle state, Claude, cost, stored turn.
 * Only a successful question is stored; a refused, failed or aborted one stores nothing. It reads the
 * vehicle state only; nothing here writes to or controls a vehicle. Nothing here logs.
 */
export class AssistantService {
  constructor(private readonly deps: AssistantDeps) {}

  async ask(request: AskRequest, onDelta?: (text: string) => void, signal?: AbortSignal): Promise<DialogTurn> {
    const { deps } = this;
    const { config } = deps;
    // Validation lives in the HTTP layer; this is the last line so a bad call can never reach Claude.
    const question = typeof request.text === 'string' ? request.text.trim() : '';
    if (question === '') throw new AssistantError('validation', MESSAGES.empty);
    if (question.length > MAX_QUESTION_CHARS) throw new AssistantError('validation', MESSAGES.tooLong);
    if (signal?.aborted) throw new AssistantError('claude-unavailable', userMessageFor('timeout'));

    const admission = deps.guard.admit();
    if (!admission.allowed) {
      if (admission.reason === 'rate-limit') throw new AssistantError('rate-limited', MESSAGES.rateLimit);
      throw new AssistantError(
        'budget-exhausted', admission.reason === 'daily-budget' ? MESSAGES.dailyBudget : MESSAGES.monthlyBudget,
      );
    }

    const style = request.style ?? 'full';
    const source = request.source ?? 'panel';
    const now = deps.clock.now();
    const snapshot = deps.hub.snapshot();
    const prompt = buildPrompt({
      question,
      style,
      snapshot,
      alerts: deps.alerts.active(),
      limits: deps.settings.get().ownerLimits,
      // lastTurns is oldest first, the order buildPrompt expects.
      history: deps.dialog.lastTurns(config.historyTurns).map((turn) => ({ question: turn.question, answer: turn.answer })),
      trendSummary: trendSummary(deps.telemetry.dailySummaries(TREND_DAYS), utcDay(now)),
      vehicleLabel: config.vehicleLabel,
      now,
    });
    const spoken = style === 'spoken';

    let result: ClaudeResult;
    try {
      result = await deps.gateway.ask(prompt, {
        model: spoken ? config.voiceModel : config.model,
        effort: spoken ? config.voiceEffort : config.effort,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
        onDelta,
        signal,
      });
    } catch (error) {
      const claudeError = toClaudeError(error);
      // A failed request can still be billed (a refusal, an empty answer): record it, once.
      if (claudeError.billed) deps.guard.recordBilled(claudeError.billed);
      throw new AssistantError(apiCodeFor(claudeError.code), userMessageFor(claudeError.code));
    }

    deps.guard.recordBilled(result.billed);
    // The caller went away while the answer was finishing: it is paid for, but nobody asked to keep it.
    if (signal?.aborted) throw new AssistantError('claude-unavailable', userMessageFor('timeout'));

    const turn: DialogTurn = {
      id: deps.newId(),
      at: deps.clock.now(),
      question,
      answer: result.text,
      style,
      source,
      model: result.model,
      snapshotAt: snapshot.takenAt,
    };
    deps.dialog.add(turn);
    return turn;
  }
}
