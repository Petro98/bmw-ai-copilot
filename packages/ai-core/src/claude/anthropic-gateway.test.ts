import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  BadRequestError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { describe, expect, test } from 'vitest';
import { ClaudeError, type AskOptions, type BuiltPrompt, type ClaudeErrorCode } from '../types';
import { AnthropicGateway } from './anthropic-gateway';
import { toClaudeError, userMessageFor } from './errors';
import { rulesFor } from './model-rules';

// A hand-written fake of the only SDK surface the gateway uses:
// `client.beta.messages.stream(body, options)` → `{ on('text', fn), finalMessage() }`.
// Nothing here touches the network.

interface FakeFinal {
  model?: string;
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
  usage?: Partial<{
    input_tokens: number; output_tokens: number;
    cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null;
  }>;
}

interface Captured { body: Record<string, unknown>; options: { signal?: AbortSignal; timeout?: number } | undefined }

function fakeClient(script: { deltas?: string[]; final?: FakeFinal; fail?: unknown; waitForAbort?: boolean }) {
  const captured: Captured[] = [];
  const client = {
    beta: {
      messages: {
        stream(body: Record<string, unknown>, options?: { signal?: AbortSignal; timeout?: number }) {
          captured.push({ body, options });
          const listeners: Array<(delta: string, snapshot: string) => void> = [];
          return {
            on(event: string, listener: (delta: string, snapshot: string) => void) {
              if (event === 'text') listeners.push(listener);
              return this;
            },
            async finalMessage() {
              if (script.waitForAbort) {
                const signal = options?.signal;
                await new Promise<void>((resolve) => {
                  if (!signal || signal.aborted) return resolve();
                  signal.addEventListener('abort', () => resolve(), { once: true });
                });
                throw new APIUserAbortError();
              }
              let snapshot = '';
              for (const delta of script.deltas ?? []) {
                snapshot += delta;
                for (const listener of listeners) listener(delta, snapshot);
              }
              if (script.fail !== undefined) throw script.fail;
              const final = script.final ?? { stop_reason: 'end_turn', content: [] };
              return {
                model: final.model ?? String(body.model),
                stop_reason: final.stop_reason,
                content: final.content,
                usage: {
                  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: null, cache_creation_input_tokens: null,
                  ...final.usage,
                },
              };
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, captured };
}

const prompt: BuiltPrompt = {
  system: [
    { type: 'text', text: 'static instructions', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'volatile context' },
  ],
  messages: [{ role: 'user', content: 'Яка температура масла?' }],
};

function opts(overrides: Partial<AskOptions> = {}): AskOptions {
  return { model: 'claude-opus-5-5', effort: 'low', maxTokens: 2048, timeoutMs: 30_000, ...overrides };
}

const okFinal: FakeFinal = {
  stop_reason: 'end_turn',
  content: [{ type: 'thinking', text: '' }, { type: 'text', text: 'Масло 92 °C.' }],
  usage: { input_tokens: 500, output_tokens: 30, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0 },
};

async function expectClaudeError(promise: Promise<unknown>, code: ClaudeErrorCode): Promise<ClaudeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeError);
    expect((error as ClaudeError).code).toBe(code);
    return error as ClaudeError;
  }
  throw new Error(`expected ClaudeError(${code}) but the promise resolved`);
}

describe('rulesFor', () => {
  test('server-side fallback only on claude-opus-5-5 and claude-sonnet-5-5', () => {
    expect(rulesFor('claude-opus-5-5').supportsServerFallback).toBe(true);
    expect(rulesFor('claude-sonnet-5-5').supportsServerFallback).toBe(true);
    expect(rulesFor('claude-haiku-5-5').supportsServerFallback).toBe(false);
    expect(rulesFor('mock').supportsServerFallback).toBe(false);
    expect(rulesFor('something-else').supportsServerFallback).toBe(false);
  });
});

describe('AnthropicGateway', () => {
  test('sends adaptive thinking, explicit effort, no sampling parameters', async () => {
    const { client, captured } = fakeClient({ final: okFinal });
    await new AnthropicGateway(client).ask(prompt, opts({ effort: 'low', maxTokens: 1234 }));
    expect(captured).toHaveLength(1);
    const body = captured[0]!.body;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.max_tokens).toBe(1234);
    expect(body.system).toEqual(prompt.system);
    expect(body.messages).toEqual(prompt.messages);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'low' });
    for (const key of ['temperature', 'top_p', 'top_k', 'tool_choice', 'tools']) {
      expect(Object.keys(body)).not.toContain(key);
    }
  });

  test('adds the server-side fallback only for models that support it', async () => {
    const opus = fakeClient({ final: okFinal });
    await new AnthropicGateway(opus.client).ask(prompt, opts({ model: 'claude-opus-5-5' }));
    expect(opus.captured[0]!.body.fallbacks).toBe('default');
    expect(opus.captured[0]!.body.betas).toEqual(['server-side-fallback-2026-07-01']);

    const sonnet = fakeClient({ final: okFinal });
    await new AnthropicGateway(sonnet.client).ask(prompt, opts({ model: 'claude-sonnet-5-5' }));
    expect(sonnet.captured[0]!.body.fallbacks).toBe('default');

    const haiku = fakeClient({ final: okFinal });
    await new AnthropicGateway(haiku.client).ask(prompt, opts({ model: 'claude-haiku-5-5' }));
    expect(Object.keys(haiku.captured[0]!.body)).not.toContain('fallbacks');
    expect(Object.keys(haiku.captured[0]!.body)).not.toContain('betas');
  });

  test('streams deltas and returns the final text and usage', async () => {
    const { client } = fakeClient({
      deltas: ['Масло ', '92 °C.'],
      final: { ...okFinal, model: 'claude-opus-4-8' },
    });
    const deltas: string[] = [];
    const result = await new AnthropicGateway(client).ask(prompt, opts({ onDelta: (text) => deltas.push(text) }));
    expect(deltas).toEqual(['Масло ', '92 °C.']);
    expect(result).toEqual({
      text: 'Масло 92 °C.',
      model: 'claude-opus-4-8',
      usage: { inputTokens: 500, outputTokens: 30, cacheReadTokens: 2500, cacheWriteTokens: 0 },
    });
  });

  test('missing cache counters become 0 and text blocks are concatenated', async () => {
    const { client } = fakeClient({
      final: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Перша. ' }, { type: 'fallback' }, { type: 'text', text: 'Друга.' }],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    });
    const result = await new AnthropicGateway(client).ask(prompt, opts());
    expect(result.text).toBe('Перша. Друга.');
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test('a refusal becomes ClaudeError("refusal") and no text is returned', async () => {
    const { client } = fakeClient({
      deltas: ['Частков'],
      final: { stop_reason: 'refusal', content: [{ type: 'text', text: 'Частков' }] },
    });
    const error = await expectClaudeError(new AnthropicGateway(client).ask(prompt, opts()), 'refusal');
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain('Частков');
  });

  test('max_tokens with no text becomes ClaudeError("empty-answer")', async () => {
    const { client } = fakeClient({ final: { stop_reason: 'max_tokens', content: [{ type: 'thinking', text: '' }] } });
    const error = await expectClaudeError(new AnthropicGateway(client).ask(prompt, opts()), 'empty-answer');
    expect(error.retryable).toBe(false);
  });

  test('an end_turn with only whitespace text is an empty answer too', async () => {
    const { client } = fakeClient({ final: { stop_reason: 'end_turn', content: [{ type: 'text', text: '  \n' }] } });
    await expectClaudeError(new AnthropicGateway(client).ask(prompt, opts()), 'empty-answer');
  });

  test('an SDK error thrown while streaming is mapped, not rethrown raw', async () => {
    const { client } = fakeClient({ fail: new RateLimitError(429, rateLimitBody, undefined, new Headers()) });
    const error = await expectClaudeError(new AnthropicGateway(client).ask(prompt, opts()), 'rate-limited');
    expect(error.retryable).toBe(true);
  });

  test('options.timeoutMs and options.signal are both passed to the SDK', async () => {
    const { client, captured } = fakeClient({ final: okFinal });
    const controller = new AbortController();
    await new AnthropicGateway(client).ask(prompt, opts({ timeoutMs: 12_345, signal: controller.signal }));
    expect(captured[0]!.options?.timeout).toBe(12_345);
    expect(captured[0]!.options?.signal).toBeInstanceOf(AbortSignal);
  });

  test('aborting the caller signal ends the request as a timeout', async () => {
    const { client } = fakeClient({ waitForAbort: true });
    const controller = new AbortController();
    const pending = new AnthropicGateway(client).ask(prompt, opts({ signal: controller.signal }));
    controller.abort();
    const error = await expectClaudeError(pending, 'timeout');
    expect(error.retryable).toBe(true);
  });

  test('the overall timeout aborts a stream that never finishes', async () => {
    const { client } = fakeClient({ waitForAbort: true });
    await expectClaudeError(new AnthropicGateway(client).ask(prompt, opts({ timeoutMs: 20 })), 'timeout');
  });
});

// ---- error mapping ----------------------------------------------------------

const rateLimitBody = { type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit.' } };

function rateLimit(): unknown {
  return new RateLimitError(429, rateLimitBody, undefined, new Headers());
}
function status(code: number): unknown {
  const type = code === 529 ? 'overloaded_error'
    : code === 401 ? 'authentication_error'
    : code === 403 ? 'permission_error'
    : code >= 500 ? 'api_error'
    : 'invalid_request_error';
  return APIError.generate(code, { type: 'error', error: { type, message: `status ${code}` } }, undefined, new Headers());
}
function creditTooLow(): unknown {
  return new BadRequestError(400, {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    },
  }, undefined, new Headers());
}
function connection(): unknown {
  return new APIConnectionError({ message: 'Connection error.' });
}
function aborted(): unknown {
  return new APIUserAbortError();
}

describe('toClaudeError', () => {
  test.each([
    [rateLimit(), 'rate-limited', true], [status(529), 'overloaded', true], [status(401), 'auth', false],
    [creditTooLow(), 'credit-exhausted', false], [status(400), 'bad-request', false],
    [connection(), 'network', true], [aborted(), 'timeout', true], [new Error('x'), 'unknown', false],
  ])('maps %s to %s (retryable %s)', (err, code, retryable) => {
    const e = toClaudeError(err); expect(e.code).toBe(code); expect(e.retryable).toBe(retryable);
  });

  test('more SDK shapes: 403, connection timeout, a mid-stream overloaded event, a DOM abort', () => {
    expect(toClaudeError(status(403)).code).toBe('auth');
    expect(toClaudeError(new APIConnectionTimeoutError()).code).toBe('timeout');
    const midStream = new APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers(), 'overloaded_error');
    expect(toClaudeError(midStream)).toMatchObject({ code: 'overloaded', retryable: true });
    expect(toClaudeError(new DOMException('aborted', 'AbortError')).code).toBe('timeout');
    expect(toClaudeError(new DOMException('timed out', 'TimeoutError')).code).toBe('timeout');
    expect(toClaudeError(status(500))).toMatchObject({ code: 'unknown', retryable: false });
    expect(toClaudeError('a string')).toMatchObject({ code: 'unknown', retryable: false });
  });

  test('a ClaudeError passes through unchanged', () => {
    const original = new ClaudeError('refusal', 'declined', false);
    expect(toClaudeError(original)).toBe(original);
  });

  test('error messages never contain the API key or request headers', () => {
    const secret = 'placeholder-secret-not-a-real-key';
    const headers = new Headers({ 'x-api-key': secret, authorization: `Bearer ${secret}`, 'request-id': 'req_1' });
    const leaky = [
      new BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: `bad key ${secret}` } }, undefined, headers),
      new APIError(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${secret}` } }, undefined, headers),
      new APIConnectionError({ message: `fetch failed with header x-api-key: ${secret}` }),
      new Error(`x-api-key: ${secret}`),
    ];
    for (const error of leaky) {
      const mapped = toClaudeError(error);
      expect(mapped.message).not.toContain(secret);
      expect(mapped.message.toLowerCase()).not.toContain('x-api-key');
      expect(mapped.message.toLowerCase()).not.toContain('authorization');
      expect(JSON.stringify(mapped)).not.toContain(secret);
      expect(userMessageFor(mapped.code)).not.toContain(secret);
    }
  });

  test('every error code has a Ukrainian user message', () => {
    const codes: ClaudeErrorCode[] = [
      'refusal', 'empty-answer', 'rate-limited', 'overloaded', 'credit-exhausted',
      'auth', 'timeout', 'network', 'bad-request', 'unknown',
    ];
    const seen = new Set<string>();
    for (const code of codes) {
      const message = userMessageFor(code);
      expect(message.length).toBeGreaterThan(10);
      expect(message).toMatch(/[а-яіїєґ]/i);          // Cyrillic
      expect(message).not.toMatch(/!/);               // no exclamation marks (docs/design/README.md)
      seen.add(message);
    }
    expect(seen.size).toBe(codes.length);
  });
});
