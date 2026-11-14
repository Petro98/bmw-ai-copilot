import type { AskOptions, BuiltPrompt, ClaudeGateway, ClaudeResult } from '../types';
import { claudeError } from './errors';

const PREFIX = 'Демо-режим без Claude. ';
const NO_DATA = 'Даних авто немає.';
const VEHICLE_HEADER = 'ДАНІ АВТО';
// Headers of the sections that follow the vehicle block in the volatile context (Plan 1 Task 7).
const NEXT_SECTION_HEADERS = ['АКТИВНІ СПОВІЩЕННЯ', 'ЛІМІТИ ВЛАСНИКА', 'ІСТОРІЯ'];
const READING_LINES = 3;

/**
 * Claude stand-in for running without an API key. No network: it answers in Ukrainian from
 * the prompt's own «ДАНІ АВТО» block (its first three lines), word by word through `onDelta`.
 */
export class MockClaudeGateway implements ClaudeGateway {
  private readonly delayMs: number;

  constructor(options?: { delayMs?: number }) {
    const delay = options?.delayMs ?? 0;
    this.delayMs = Number.isFinite(delay) && delay > 0 ? delay : 0;
  }

  async ask(prompt: BuiltPrompt, options: AskOptions): Promise<ClaudeResult> {
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

    const lines = vehicleLines(prompt);
    const body = lines.length > 0 ? lines.map((line) => line.replace(/[.;:,\s]+$/, '')).join('. ') + '.' : NO_DATA;
    const text = PREFIX + body;

    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      if (this.delayMs > 0) await sleep(this.delayMs);
      if (signal.aborted) throw claudeError('timeout', 'aborted');
      options.onDelta?.(i < words.length - 1 ? `${words[i]} ` : words[i]!);
    }

    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    return { text, model: 'mock', usage, billed: [{ model: 'mock', usage }] };
  }
}

/** The first lines of the «ДАНІ АВТО» block, taken from the last system block that has one. */
function vehicleLines(prompt: BuiltPrompt): string[] {
  for (let b = prompt.system.length - 1; b >= 0; b--) {
    const lines = prompt.system[b]!.text.split('\n').map((line) => line.trim());
    const start = lines.findIndex((line) => line.includes(VEHICLE_HEADER));
    if (start < 0) continue;
    const found: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (NEXT_SECTION_HEADERS.some((header) => line.includes(header))) break;
      if (line !== '') found.push(line);
      if (found.length === READING_LINES) break;
    }
    return found;
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
