import type { ApiError, ApiErrorCode } from '@copilot/shared';
import { AssistantError } from '../assistant/assistant-service';

/**
 * The one table from ApiErrorCode to HTTP status (contract: Plan 1 Task 1, "Errors: HTTP 4xx/5xx with an ApiError body").
 * `budget-exhausted` is 402 Payment Required, not 429: the owner's daily or monthly spend limit is reached and
 * waiting a minute does not help, so it must not look like the per-minute `rate-limited` (429) that clients may retry.
 */
export const HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  'validation': 400,
  'unauthorized': 401,
  'budget-exhausted': 402,
  'not-found': 404,
  'claude-refused': 422,
  'rate-limited': 429,
  'internal': 500,
  'claude-unavailable': 503,
};

// Ukrainian, sentence case, no exclamation marks (docs/design/README.md → Content).
export const MESSAGES = {
  invalidRequest: 'Некоректний запит.',
  tooLarge: 'Запит завеликий.',
  notFound: 'Не знайдено.',
  mockOnly: 'Демо-сценарії доступні лише з імітованим авто.',
  internal: 'Внутрішня помилка сервера. Спробуйте пізніше.',
} as const;

/** An error a route throws on purpose; its message is Ukrainian and safe to display. */
export class HttpError extends Error {
  constructor(readonly code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function apiError(code: ApiErrorCode, message: string): ApiError {
  return { error: { code, message } };
}

/**
 * Turns anything thrown during a request into a status and an ApiError body. Only messages written for the
 * user (HttpError, AssistantError) pass through; anything else becomes `internal` with a fixed message, so no
 * stack trace, SQL text or secret can reach a response. `internal` tells the caller to log the original.
 */
export function toApiError(error: unknown): { status: number; body: ApiError; internal: boolean } {
  if (error instanceof HttpError || error instanceof AssistantError) {
    return { status: HTTP_STATUS[error.code], body: apiError(error.code, error.message), internal: false };
  }
  // Fastify's own request errors (malformed JSON, body over the limit, wrong content type) carry a 4xx status.
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    if (statusCode === 404) return { status: 404, body: apiError('not-found', MESSAGES.notFound), internal: false };
    const message = statusCode === 413 ? MESSAGES.tooLarge : MESSAGES.invalidRequest;
    return { status: HTTP_STATUS.validation, body: apiError('validation', message), internal: false };
  }
  return { status: HTTP_STATUS.internal, body: apiError('internal', MESSAGES.internal), internal: true };
}
