import type { AlertEvent, OwnerLimits } from '@copilot/event-engine';
import type { VehicleSnapshot } from '@copilot/vehicle-core';

export type AnswerStyle = 'full' | 'spoken';

export interface HistoryTurn { question: string; answer: string }

export interface PromptInput {
  question: string; style: AnswerStyle; snapshot: VehicleSnapshot; alerts: AlertEvent[];
  limits: OwnerLimits; history: HistoryTurn[]; trendSummary: string | null;
  vehicleLabel: string | null; now: number;
}

export interface SystemBlock { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }

export interface BuiltPrompt { system: SystemBlock[]; messages: Array<{ role: 'user' | 'assistant'; content: string }> }

export type Effort = 'low' | 'medium' | 'high';

export interface AskOptions { model: string; effort: Effort; maxTokens: number; timeoutMs: number; onDelta?: (text: string) => void; signal?: AbortSignal }

export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

/** One billed attempt of a Claude request, priced by its own model. */
export interface BilledAttempt { model: string; usage: Usage }

/**
 * `usage` and `model` describe the attempt that produced the answer. `billed` lists every billed
 * attempt of the turn, the answering one included: with a server-side refusal fallback a declined
 * attempt is billed too and appears only there. Without a fallback it is one entry equal to `usage`.
 */
export interface ClaudeResult { text: string; model: string; usage: Usage; billed: BilledAttempt[] }

export interface ClaudeGateway { ask(prompt: BuiltPrompt, options: AskOptions): Promise<ClaudeResult> }

export type ClaudeErrorCode =
  | 'refusal' | 'empty-answer' | 'rate-limited' | 'overloaded' | 'credit-exhausted'
  | 'auth' | 'timeout' | 'network' | 'bad-request' | 'unknown';

/**
 * A failed Claude request, already classified. `message` never contains the API key or request headers.
 * `billed` is set when the request was nonetheless billed (a refusal, an empty answer or one cut off by
 * max_tokens, or a conservative estimate for a request aborted or timed out after it started streaming),
 * so the cost can still be recorded.
 */
export class ClaudeError extends Error {
  constructor(
    readonly code: ClaudeErrorCode, message: string, readonly retryable: boolean,
    readonly billed?: BilledAttempt[],
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

export interface UsageStore {                          // implemented by the backend (Task 10), used by the cost guard (Task 9)
  add(day: string, model: string, usage: Usage, usd: number): void;   // day 'YYYY-MM-DD' (UTC)
  usdForDay(day: string): number;
  usdForMonth(month: string): number;                                  // 'YYYY-MM'
}
