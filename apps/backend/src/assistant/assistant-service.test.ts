import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, test, vi } from 'vitest';
import {
  ClaudeError, CostGuard, userMessageFor,
  type AskOptions, type BilledAttempt, type BuiltPrompt, type ClaudeErrorCode, type ClaudeGateway, type ClaudeResult, type Usage,
} from '@copilot/ai-core';
import type { AlertEvent } from '@copilot/event-engine';
import type { AskRequest } from '@copilot/shared';
import { available, emptySnapshot, type VehicleSnapshot } from '@copilot/vehicle-core';
import { openDatabase } from '../db/database';
import { AlertStore } from '../stores/alert-store';
import { DialogStore } from '../stores/dialog-store';
import { SettingsStore } from '../stores/settings-store';
import { TelemetryStore, type DailySummary } from '../stores/telemetry-store';
import { SqliteUsageStore } from '../stores/usage-store';
import { AssistantError, AssistantService, type AssistantConfig } from './assistant-service';
import { trendSummary } from './trend-summary';

const NOW = Date.UTC(2026, 10, 13, 10, 0, 0);   // 2026-11-13T10:00:00Z
const TAKEN_AT = NOW - 5_000;

const CONFIG: AssistantConfig = {
  model: 'claude-opus-5-5', voiceModel: 'claude-haiku-5-5', effort: 'medium', voiceEffort: 'low',
  maxTokens: 16_000, timeoutMs: 60_000, historyTurns: 2, vehicleLabel: null,
};

const USAGE: Usage = { inputTokens: 500, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0 };

/** A gateway that never touches the network: it records every call and answers with `answer`. */
class FakeGateway implements ClaudeGateway {
  readonly calls: Array<{ prompt: BuiltPrompt; options: AskOptions }> = [];
  answer: (prompt: BuiltPrompt, options: AskOptions) => Promise<ClaudeResult> = async (_prompt, options) => ({
    text: 'Температура масла в нормі.', model: options.model, usage: USAGE, billed: [{ model: options.model, usage: USAGE }],
  });

  ask(prompt: BuiltPrompt, options: AskOptions): Promise<ClaudeResult> {
    this.calls.push({ prompt, options });
    return this.answer(prompt, options);
  }
}

function snapshot(): VehicleSnapshot {
  return { ...emptySnapshot(TAKEN_AT), oilTemp: available(92, '°C', 'mock', TAKEN_AT) };
}

interface Rig {
  db: DatabaseSync;
  gateway: FakeGateway;
  guard: CostGuard;
  dialog: DialogStore;
  alerts: AlertStore;
  telemetry: TelemetryStore;
  service: AssistantService;
  usageRows(): number;
}

function rig(options: { dailyUsdLimit?: number; requestsPerMinute?: number; config?: Partial<AssistantConfig> } = {}): Rig {
  const db = openDatabase(':memory:');
  const clock = { now: () => NOW };
  const dialog = new DialogStore(db);
  const alerts = new AlertStore(db);
  const settings = new SettingsStore(db);
  const telemetry = new TelemetryStore(db);
  const guard = new CostGuard({
    dailyUsdLimit: options.dailyUsdLimit ?? 1, monthlyUsdLimit: 20, requestsPerMinute: options.requestsPerMinute ?? 10,
    clock, store: new SqliteUsageStore(db),
  });
  const gateway = new FakeGateway();
  let n = 0;
  const service = new AssistantService({
    hub: { snapshot },
    dialog, alerts, settings, telemetry, gateway, guard, clock,
    config: { ...CONFIG, ...options.config },
    newId: () => `turn-${++n}`,
  });
  return {
    db, gateway, guard, dialog, alerts, telemetry, service,
    usageRows: () => Number((db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n),
  };
}

async function rejection(promise: Promise<unknown>): Promise<AssistantError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AssistantError);
    return error as AssistantError;
  }
  throw new Error('expected a rejection');
}

function day(date: string, oil: { min: number; max: number; avg: number } = { min: 80, max: 105, avg: 92 }): DailySummary {
  return { day: date, values: { oilTemp: oil } };
}

describe('AssistantService', () => {
  test('a successful question stores one turn with the model and snapshot time and records usage', async () => {
    const r = rig();
    const turn = await r.service.ask({ text: '  Як масло?  ' });

    expect(turn).toEqual({
      id: 'turn-1', at: NOW, question: 'Як масло?', answer: 'Температура масла в нормі.',
      style: 'full', source: 'panel', model: 'claude-opus-5-5', snapshotAt: TAKEN_AT,
    });
    expect(r.dialog.recent(10)).toEqual([turn]);
    expect(r.gateway.calls[0].options).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', maxTokens: 16_000, timeoutMs: 60_000 });
    expect(r.gateway.calls[0].prompt.messages.at(-1)).toEqual({ role: 'user', content: 'Як масло?' });
    expect(r.usageRows()).toBe(1);
    expect(r.guard.totals().dayUsd).toBeCloseTo(0.0085, 6);
  });

  test('every billed attempt of the turn is recorded, each by its own model', async () => {
    const r = rig();
    const declined: BilledAttempt = { model: 'claude-opus-5-5', usage: { ...USAGE, outputTokens: 0 } };
    r.gateway.answer = async () => ({
      text: 'Відповідь.', model: 'claude-sonnet-5-5', usage: USAGE,
      billed: [declined, { model: 'claude-sonnet-5-5', usage: USAGE }],
    });
    const turn = await r.service.ask({ text: 'Питання' });
    expect(turn.model).toBe('claude-sonnet-5-5');
    expect(r.usageRows()).toBe(2);
  });

  test('spoken style uses the voice model and voice effort', async () => {
    const r = rig();
    const turn = await r.service.ask({ text: 'Скільки пального?', style: 'spoken', source: 'voice' });
    expect(r.gateway.calls[0].options).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(r.gateway.calls[0].prompt.system[1].text).toContain('СТИЛЬ: усний');
    expect(turn).toMatchObject({ style: 'spoken', source: 'voice', model: 'claude-haiku-5-5' });
  });

  test('the prompt carries the last N turns and the active alerts', async () => {
    const r = rig();
    for (let i = 1; i <= 3; i++) {
      r.dialog.add({
        id: `old-${i}`, at: NOW - (10 - i) * 60_000, question: `Питання ${i}`, answer: `Відповідь ${i}`,
        style: 'full', source: 'panel', model: 'claude-opus-5-5', snapshotAt: null,
      });
    }
    const raised: AlertEvent = {
      id: 'a1', ruleId: 'check-control', dedupKey: 'cc:39', provenance: 'bmw-check-control', severity: 'critical',
      title: 'Перегрів двигуна', detail: null, at: NOW - 1000, active: true, clearedAt: null,
    };
    const cleared: AlertEvent = { ...raised, id: 'a2', dedupKey: 'cc:40', title: 'Старе сповіщення', active: false, clearedAt: NOW - 500 };
    r.alerts.upsert(raised);
    r.alerts.upsert(cleared);

    await r.service.ask({ text: 'Що сталося?' });

    const prompt = r.gateway.calls[0].prompt;
    // historyTurns = 2: the two most recent turns, oldest first, then the question.
    expect(prompt.messages).toEqual([
      { role: 'user', content: 'Питання 2' }, { role: 'assistant', content: 'Відповідь 2' },
      { role: 'user', content: 'Питання 3' }, { role: 'assistant', content: 'Відповідь 3' },
      { role: 'user', content: 'Що сталося?' },
    ]);
    expect(prompt.system[1].text).toContain('Перегрів двигуна');
    expect(prompt.system[1].text).not.toContain('Старе сповіщення');
    expect(prompt.system[1].text).toContain('Температура масла: 92 °C');
  });

  test('the prompt carries the dated trend summary, or says there is none', async () => {
    const empty = rig();
    await empty.service.ask({ text: 'Як справи?' });
    expect(empty.gateway.calls[0].prompt.system[1].text).toContain('ІСТОРІЯ:\nнакопичених даних немає');

    const r = rig();
    for (const [d, oil] of [['2026-10-01', 80], ['2026-10-02', 95]] as const) {
      r.telemetry.addSample({ at: Date.parse(`${d}T12:00:00Z`), values: { oilTemp: oil } });
      r.telemetry.rollUpDay(d);
    }
    await r.service.ask({ text: 'Як справи?' });
    const text = r.gateway.calls[0].prompt.system[1].text;
    expect(text).toContain('2026-10-01');
    expect(text).toContain('2026-10-02');
    expect(text).toContain('2026-11-13');
  });

  test('a budget refusal never reaches the gateway', async () => {
    const r = rig({ dailyUsdLimit: 0 });
    const spy = vi.spyOn(r.gateway, 'ask');
    const error = await rejection(r.service.ask({ text: 'Питання' }));
    expect(error.code).toBe('budget-exhausted');
    expect(error.message.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    expect(r.dialog.recent(10)).toEqual([]);
  });

  test('the per-minute rate refusal never reaches the gateway', async () => {
    const r = rig({ requestsPerMinute: 1 });
    await r.service.ask({ text: 'Перше' });
    const error = await rejection(r.service.ask({ text: 'Друге' }));
    expect(error.code).toBe('rate-limited');
    expect(r.gateway.calls).toHaveLength(1);
    expect(r.dialog.recent(10)).toHaveLength(1);
  });

  test.each([
    ['refusal', 'claude-refused'], ['rate-limited', 'rate-limited'], ['timeout', 'claude-unavailable'],
    ['credit-exhausted', 'claude-unavailable'], ['empty-answer', 'claude-unavailable'],
    ['overloaded', 'claude-unavailable'], ['auth', 'claude-unavailable'], ['network', 'claude-unavailable'],
  ] as const)('gateway %s becomes %s and stores no turn', async (claudeCode, apiCode) => {
    const r = rig();
    r.gateway.answer = async () => { throw new ClaudeError(claudeCode as ClaudeErrorCode, `Claude request failed: ${claudeCode}`, false); };
    const error = await rejection(r.service.ask({ text: 'Питання' }));
    expect(error.code).toBe(apiCode);
    expect(error.message).toBe(userMessageFor(claudeCode));
    expect(r.dialog.recent(10)).toEqual([]);
    expect(r.usageRows()).toBe(0);
    expect(r.gateway.calls).toHaveLength(1);
  });

  test('a billed failure is recorded once and still stores no turn', async () => {
    const r = rig();
    r.gateway.answer = async () => {
      throw new ClaudeError('refusal', 'Claude request failed: refusal', false, [{ model: 'claude-opus-5-5', usage: USAGE }]);
    };
    const error = await rejection(r.service.ask({ text: 'Питання' }));
    expect(error.code).toBe('claude-refused');
    expect(r.usageRows()).toBe(1);
    expect(r.guard.totals().dayUsd).toBeCloseTo(0.0085, 6);
    expect(r.dialog.recent(10)).toEqual([]);
  });

  test('an unexpected gateway failure is claude-unavailable and leaks nothing of it', async () => {
    const r = rig();
    r.gateway.answer = async () => { throw new Error('boom sk-ant-secret'); };
    const error = await rejection(r.service.ask({ text: 'Питання' }));
    expect(error.code).toBe('claude-unavailable');
    expect(error.message).not.toContain('sk-ant');
    expect(r.dialog.recent(10)).toEqual([]);
  });

  test('deltas are forwarded to the caller', async () => {
    const r = rig();
    r.gateway.answer = async (_prompt, options) => {
      options.onDelta?.('Масло ');
      options.onDelta?.('в нормі.');
      return { text: 'Масло в нормі.', model: options.model, usage: USAGE, billed: [{ model: options.model, usage: USAGE }] };
    };
    const deltas: string[] = [];
    const turn = await r.service.ask({ text: 'Як масло?' }, (text) => deltas.push(text));
    expect(deltas).toEqual(['Масло ', 'в нормі.']);
    expect(turn.answer).toBe('Масло в нормі.');
  });

  test('an aborted request rejects and stores nothing', async () => {
    const r = rig();
    const controller = new AbortController();
    r.gateway.answer = (_prompt, options) => new Promise((_resolve, reject) => {
      expect(options.signal).toBe(controller.signal);
      options.signal?.addEventListener('abort', () => reject(new ClaudeError('timeout', 'Claude request failed: timeout (aborted)', true)));
    });
    const pending = r.service.ask({ text: 'Питання' }, undefined, controller.signal);
    controller.abort();
    const error = await rejection(pending);
    expect(error.code).toBe('claude-unavailable');
    expect(r.dialog.recent(10)).toEqual([]);
  });

  test('a request aborted before it starts never reaches the gateway', async () => {
    const r = rig();
    const controller = new AbortController();
    controller.abort();
    await rejection(r.service.ask({ text: 'Питання' }, undefined, controller.signal));
    expect(r.gateway.calls).toHaveLength(0);
    expect(r.dialog.recent(10)).toEqual([]);
  });

  test('an answer that arrives after the caller aborted is billed but not stored', async () => {
    const r = rig();
    const controller = new AbortController();
    r.gateway.answer = async (_prompt, options) => {
      controller.abort();
      return { text: 'Пізно.', model: options.model, usage: USAGE, billed: [{ model: options.model, usage: USAGE }] };
    };
    await rejection(r.service.ask({ text: 'Питання' }, undefined, controller.signal));
    expect(r.usageRows()).toBe(1);
    expect(r.dialog.recent(10)).toEqual([]);
  });

  test.each([[''], ['   '], ['x'.repeat(501)]])('question %j is a validation error and reaches nothing', async (text) => {
    const r = rig();
    const request: AskRequest = { text };
    const error = await rejection(r.service.ask(request));
    expect(error.code).toBe('validation');
    expect(r.gateway.calls).toHaveLength(0);
  });
});

describe('trendSummary', () => {
  test('trendSummary is null with one day and names min–max with two', () => {
    expect(trendSummary([day('2026-11-12')])).toBeNull();
    expect(trendSummary([day('2026-11-11'), day('2026-11-12')])).toContain('Температура масла');
  });

  test('is null without summaries', () => {
    expect(trendSummary([])).toBeNull();
  });

  test('names the first and last day it covers and today, so old data is not read as current', () => {
    const text = trendSummary([day('2026-09-01', { min: 70, max: 98, avg: 85 }), day('2026-09-03', { min: 75, max: 110, avg: 95.25 })], '2026-11-13');
    expect(text).toContain('2026-09-01');
    expect(text).toContain('2026-09-03');
    expect(text).toContain('2026-11-13');
    expect(text).toContain('Температура масла: від 70 до 110 °C');
    expect(text).toContain('95,3 °C');
  });

  test('uses the catalogue unit of each key and leaves out keys with no data', () => {
    const text = trendSummary([
      { day: '2026-11-11', values: { range: { min: 300, max: 450, avg: 400 }, battery12vCharge: { min: 80, max: 90, avg: 85 } } },
      { day: '2026-11-12', values: { range: { min: 250, max: 300, avg: 270 } } },
    ]);
    expect(text).toContain('Запас ходу: від 250 до 450 км');
    expect(text).toContain('Заряд акумулятора 12 В: від 80 до 90 %');
    expect(text).not.toContain('Температура масла');
  });
});
