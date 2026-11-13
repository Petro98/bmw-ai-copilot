import type Anthropic from '@anthropic-ai/sdk';
import type { AskOptions, BuiltPrompt, ClaudeGateway, ClaudeResult } from '../types';
import { claudeError, toClaudeError } from './errors';
import { rulesFor } from './model-rules';

// Server-side refusal fallback, as the claude-api skill documents it: this beta header plus
// `fallbacks: 'default'` lets the API re-run a declined request on its recommended model.
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Claude over the official SDK: streamed, adaptive thinking, explicit effort, no sampling
 * parameters, no prefill, no tools. The beta messages endpoint is used because `fallbacks`
 * is only typed there; models without server-side fallback get no beta header.
 */
export class AnthropicGateway implements ClaudeGateway {
  constructor(private readonly client: Anthropic) {}

  async ask(prompt: BuiltPrompt, options: AskOptions): Promise<ClaudeResult> {
    // One deadline for the whole streamed answer (the SDK's own `timeout` is per attempt),
    // combined with the caller's signal. Either one aborting ends the request as a timeout.
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const fallback = rulesFor(options.model).supportsServerFallback
      ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const }
      : {};

    let message;
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: options.model,
          max_tokens: options.maxTokens,
          system: prompt.system,
          messages: prompt.messages,
          thinking: { type: 'adaptive' },
          output_config: { effort: options.effort },
          ...fallback,
        },
        { signal, timeout: options.timeoutMs },
      );
      const onDelta = options.onDelta;
      if (onDelta) stream.on('text', (delta) => onDelta(delta));
      message = await stream.finalMessage();
    } catch (error) {
      throw toClaudeError(error);
    }

    // stop_reason before content: a refusal (after any fallback) carries no usable answer,
    // even when part of a text was streamed before the decline.
    if (message.stop_reason === 'refusal') throw claudeError('refusal', 'stop_reason refusal');

    let text = '';
    for (const block of message.content) {
      if (block.type === 'text') text += block.text;
    }
    if (text.trim() === '') throw claudeError('empty-answer', `stop_reason ${message.stop_reason ?? 'null'}`);

    const usage = message.usage;
    return {
      text,
      model: message.model,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
