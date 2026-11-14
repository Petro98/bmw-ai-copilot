import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { ClaudeError, type BilledAttempt, type ClaudeErrorCode } from '../types';

const RETRYABLE: Readonly<Record<ClaudeErrorCode, boolean>> = {
  'refusal': false,
  'empty-answer': false,
  'rate-limited': true,
  'overloaded': true,
  'credit-exhausted': false,
  'auth': false,
  'timeout': true,
  'network': true,
  'bad-request': false,
  'unknown': false,
};

// Ukrainian, sentence case, no exclamation marks (docs/design/README.md → Content).
const USER_MESSAGES: Readonly<Record<ClaudeErrorCode, string>> = {
  'refusal': 'Claude не відповів на це питання. Спробуйте сформулювати його інакше.',
  'empty-answer': 'Відповідь не надійшла. Спробуйте поставити питання ще раз.',
  'rate-limited': 'Забагато запитів до Claude. Спробуйте за хвилину.',
  'overloaded': 'Claude зараз перевантажений. Спробуйте трохи пізніше.',
  'credit-exhausted': 'Кредит API Claude вичерпано. Поповніть баланс в Anthropic Console.',
  'auth': 'Сервер не має доступу до Claude. Перевірте ключ API в налаштуваннях сервера.',
  'timeout': 'Claude не відповів вчасно. Спробуйте ще раз.',
  'network': 'Немає зв’язку з Claude. Перевірте інтернет і спробуйте ще раз.',
  'bad-request': 'Запит до Claude не вдався. Спробуйте змінити питання.',
  'unknown': 'Не вдалося отримати відповідь від Claude. Спробуйте пізніше.',
};

/** Ukrainian sentence for the UI. Contains nothing from the request or the error. */
export function userMessageFor(code: ClaudeErrorCode): string {
  return USER_MESSAGES[code];
}

/**
 * Builds a ClaudeError whose message is assembled only from safe, fixed parts. `billed` is passed
 * when the failed request was nonetheless billed; it holds token counts and model ids only.
 */
export function claudeError(code: ClaudeErrorCode, detail?: string, billed?: BilledAttempt[]): ClaudeError {
  const message = detail ? `Claude request failed: ${code} (${detail})` : `Claude request failed: ${code}`;
  return new ClaudeError(code, message, RETRYABLE[code], billed);
}

/**
 * Classifies anything thrown by the SDK (or by the stream around it).
 *
 * The resulting message names only the code, the HTTP status and the API error type — never
 * the SDK's own message, the response body, headers or a cause — so the API key or request
 * headers cannot reach a log, an error message or an HTTP response through it.
 * Nothing is retried here: the SDK's own bounded retries are the only ones.
 */
export function toClaudeError(error: unknown): ClaudeError {
  if (error instanceof ClaudeError) return error;

  // Order matters: the timeout and abort classes extend APIConnectionError / APIError.
  if (error instanceof APIUserAbortError) return claudeError('timeout', 'aborted');
  if (error instanceof APIConnectionTimeoutError) return claudeError('timeout', 'connection timeout');
  if (error instanceof APIConnectionError) return claudeError('network', 'connection error');

  if (error instanceof APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    const type = error.type;
    const detail = [status !== undefined ? `HTTP ${status}` : null, type].filter(Boolean).join(', ') || undefined;

    if (error instanceof RateLimitError || status === 429 || type === 'rate_limit_error') return claudeError('rate-limited', detail);
    // 529 arrives as an HTTP status; mid-stream it arrives as an SSE error event of type overloaded_error.
    if (status === 529 || type === 'overloaded_error') return claudeError('overloaded', detail);
    if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') {
      return claudeError('auth', detail);
    }
    if (type === 'billing_error' || (status === 400 && saysCreditTooLow(error))) return claudeError('credit-exhausted', detail);
    if (status === 400 || type === 'invalid_request_error') return claudeError('bad-request', detail);
    if (status === 408 || type === 'timeout_error') return claudeError('timeout', detail);
    return claudeError('unknown', detail);
  }

  if (isAbortLike(error)) return claudeError('timeout', 'aborted');
  return claudeError('unknown');
}

function saysCreditTooLow(error: APIError): boolean {
  // The API reports exhausted prepaid credit as a 400 whose message reads
  // "Your credit balance is too low to access the Anthropic API ...".
  const text = error.apiMessage ?? error.message;
  return /credit balance is too low/i.test(text);
}

function isAbortLike(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}
