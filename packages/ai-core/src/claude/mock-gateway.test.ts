import { afterEach, describe, expect, test, vi } from 'vitest';
import { ClaudeError, type AskOptions, type BuiltPrompt } from '../types';
import { MockClaudeGateway } from './mock-gateway';

function promptWith(context: string): BuiltPrompt {
  return {
    system: [
      { type: 'text', text: 'Статичні інструкції.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: context },
    ],
    messages: [{ role: 'user', content: 'Як справи в авто?' }],
  };
}

const context = [
  'СТИЛЬ: повний. РУХ: авто стоїть. Відповідай не більше 8 речень.',
  '',
  'ДАНІ АВТО',
  'Температура масла: 92 °C',
  'Температура охолоджувальної рідини: 88 °C',
  'Запас ходу: 452 км',
  'Рівень палива: 61 %',
  'Недоступно: Температура впуску (потрібне діагностичне читання, вимкнено)',
  '',
  'АКТИВНІ СПОВІЩЕННЯ',
  'немає',
].join('\n');

const options: AskOptions = { model: 'mock', effort: 'low', maxTokens: 512, timeoutMs: 1000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MockClaudeGateway', () => {
  test('the mock gateway answers from the prompt data without any network', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('network is not allowed in the mock gateway'); });
    vi.stubGlobal('fetch', fetchSpy);

    const deltas: string[] = [];
    const result = await new MockClaudeGateway().ask(promptWith(context), { ...options, onDelta: (t) => deltas.push(t) });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.model).toBe('mock');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(result.billed).toEqual([{ model: 'mock', usage: result.usage }]);
    expect(result.text.startsWith('Демо-режим без Claude. ')).toBe(true);
    expect(result.text).toContain('Температура масла: 92 °C');
    expect(result.text).toContain('Температура охолоджувальної рідини: 88 °C');
    expect(result.text).toContain('Запас ходу: 452 км');
    expect(result.text).not.toContain('Рівень палива');            // only the first three reading lines
    expect(result.text).not.toContain('АКТИВНІ СПОВІЩЕННЯ');
  });

  test('deltas arrive word by word and add up to the answer', async () => {
    const deltas: string[] = [];
    const result = await new MockClaudeGateway().ask(promptWith(context), { ...options, onDelta: (t) => deltas.push(t) });
    expect(deltas.length).toBe(result.text.split(' ').length);
    expect(deltas.join('')).toBe(result.text);
    expect(deltas[0]).toBe('Демо-режим ');
  });

  test('an all-unavailable vehicle block is echoed as unavailable, never as a number', async () => {
    const empty = ['ДАНІ АВТО', 'Недоступно: Температура масла (не повідомлено)', '', 'АКТИВНІ СПОВІЩЕННЯ', 'немає'].join('\n');
    const result = await new MockClaudeGateway().ask(promptWith(empty), options);
    expect(result.text).toBe('Демо-режим без Claude. Недоступно: Температура масла (не повідомлено).');
  });

  test('a prompt without a vehicle block still gets a Ukrainian answer', async () => {
    const result = await new MockClaudeGateway().ask(promptWith('щось інше'), options);
    expect(result.text.startsWith('Демо-режим без Claude. ')).toBe(true);
    expect(result.text.length).toBeGreaterThan('Демо-режим без Claude. '.length);
  });

  test('delayMs paces the words and an aborted signal stops the answer', async () => {
    const controller = new AbortController();
    const deltas: string[] = [];
    const pending = new MockClaudeGateway({ delayMs: 5 }).ask(promptWith(context), {
      ...options,
      signal: controller.signal,
      onDelta: (t) => { deltas.push(t); if (deltas.length === 2) controller.abort(); },
    });
    await expect(pending).rejects.toBeInstanceOf(ClaudeError);
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    expect(deltas.length).toBe(2);
  });
});
