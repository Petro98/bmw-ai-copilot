import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ClaudeError, CostGuard, MockClaudeGateway, type ClaudeGateway } from '@copilot/ai-core';
import { EventEngine, NO_LIMITS, defaultEngineOptions } from '@copilot/event-engine';
import type { ApiError, AskStreamEvent, DialogTurn, LiveEvent, MetricsDto, SettingsDto, StatusDto } from '@copilot/shared';
import { MockVehicleDataProvider, type TimerApi, type VehicleSnapshot } from '@copilot/vehicle-core';
import { AssistantService } from '../assistant/assistant-service';
import { assistantConfigFrom, loadConfig, type Config } from '../config';
import { openDatabase } from '../db/database';
import { MIGRATIONS } from '../db/migrations';
import { DialogFeed } from '../features/car-link/routes';
import { createLogger } from '../logger';
import { isEntryPath, start } from '../main';
import { AlertStore } from '../stores/alert-store';
import { DialogStore } from '../stores/dialog-store';
import { SettingsStore } from '../stores/settings-store';
import { TelemetryStore } from '../stores/telemetry-store';
import { SqliteUsageStore } from '../stores/usage-store';
import { LiveBus } from '../vehicle/live-bus';
import { VehicleHub } from '../vehicle/vehicle-hub';
import { buildApp } from './app';
import { MAX_EVENT_STREAMS } from './routes/events';

const SECOND = 1000;
const START = Date.UTC(2026, 10, 13, 10, 0, 0);   // 2026-11-13T10:00:00Z
const NO_TIMERS: TimerApi = { setInterval: () => null, clearInterval: () => undefined };
const FAKE_KEY = 'sk-ant-test-0000000000000000';

interface Rig {
  app: FastifyInstance;
  db: DatabaseSync;
  clock: { t: number; now(): number };
  mock: MockVehicleDataProvider;
  engine: EventEngine;
  hub: VehicleHub;
  bus: LiveBus;
  dialog: DialogStore;
  settings: SettingsStore;
  /** Every live event published on the bus since the rig was built. */
  events: LiveEvent[];
  /** Moves the clock forward by `ms` in one-second steps, ticking the mock provider after each step. */
  advance(ms: number): void;
}

interface RigOptions { config?: Partial<Config>; gateway?: ClaudeGateway; dailyUsdLimit?: number }

const rigs: Rig[] = [];

async function rig(options: RigOptions = {}): Promise<Rig> {
  const config: Config = { ...loadConfig({ LOG_LEVEL: 'silent' }), ...options.config };
  const db = openDatabase(':memory:');
  const clock = { t: START, now(): number { return this.t; } };
  const mock = new MockVehicleDataProvider({ clock, timers: NO_TIMERS, scenario: 'steady-cruise' });
  const engine = new EventEngine(defaultEngineOptions());
  const alerts = new AlertStore(db);
  const dialog = new DialogStore(db);
  const settings = new SettingsStore(db);
  const telemetry = new TelemetryStore(db);
  const bus = new LiveBus();
  const events: LiveEvent[] = [];
  bus.subscribe((event) => { events.push(event); });
  const hub = new VehicleHub({
    provider: mock, engine, alerts, telemetry, settings, bus, clock, sampleIntervalMs: 60 * SECOND, retentionDays: 90,
  });
  const guard = new CostGuard({
    dailyUsdLimit: options.dailyUsdLimit ?? config.budgetDailyUsd, monthlyUsdLimit: config.budgetMonthlyUsd,
    requestsPerMinute: config.rateLimitPerMinute, clock, store: new SqliteUsageStore(db),
  });
  let n = 0;
  const assistant = new AssistantService({
    hub, dialog, alerts, settings, telemetry, gateway: options.gateway ?? new MockClaudeGateway(), guard, clock,
    config: assistantConfigFrom(config), newId: () => `turn-${++n}`,
  });
  const app = buildApp({
    config, logger: createLogger(config), hub, bus, assistant, dialog, alerts, settings, guard,
    mock: config.vehicleSource === 'mock' ? mock : null, clock,
  });
  await hub.start();
  await app.ready();
  const r: Rig = {
    app, db, clock, mock, engine, hub, bus, dialog, settings, events,
    advance(ms: number): void {
      for (let elapsed = 0; elapsed < ms; elapsed += SECOND) {
        clock.t += SECOND;
        mock.tick();
      }
    },
  };
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.app.close();
    await r.hub.stop();
    r.db.close();
  }
  vi.restoreAllMocks();
});

function expectApiError(body: unknown, code: ApiError['error']['code']): void {
  const error = (body as ApiError).error;
  expect(error.code).toBe(code);
  expect(typeof error.message).toBe('string');
  expect(error.message.length).toBeGreaterThan(0);
  expect(Object.keys(body as object)).toEqual(['error']);
  expect(Object.keys(error).sort()).toEqual(['code', 'message']);
}

/** Splits an SSE body into `{ event, data }` pairs; comment lines are skipped. */
function parseSse(text: string): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split('\n\n')) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (data !== '') out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

const SETTINGS: SettingsDto = {
  ownerLimits: { oilTempMaxC: 120, coolantTempMaxC: 110, battery12vMinPercent: 60, tyrePressureDeviationBar: 0.3 },
  popupsEnabled: false,
  diagnosticsEnabled: false,
};

describe('HTTP API', () => {
  test('GET /api/health and /api/status answer with the contract shapes', async () => {
    const { app, advance } = await rig();
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    advance(SECOND);
    const status = await app.inject({ method: 'GET', url: '/api/status' });
    expect(status.statusCode).toBe(200);
    const dto = status.json<StatusDto>();
    expect(dto).toEqual({
      version: expect.any(String),
      vehicle: { source: 'mock', connected: true, lastSnapshotAt: START + SECOND, scenario: 'steady-cruise' },
      claude: { mode: 'mock', model: 'claude-opus-5-5', voiceModel: 'claude-opus-5-5' },
      budget: { dayUsd: 0, dayLimitUsd: 1, monthUsd: 0, monthLimitUsd: 20 },
    });

    const metrics = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(metrics.statusCode).toBe(200);
    const m = metrics.json<MetricsDto>();
    expect(Object.keys(m).sort()).toEqual(['cpuSystemMs', 'cpuUserMs', 'heapUsedMb', 'rssMb', 'sseClients', 'uptimeS']);
    expect(m.sseClients).toBe(0);
  });

  test('the API key never appears in a response', async () => {
    const { app } = await rig({ config: { anthropicApiKey: FAKE_KEY } });
    for (const url of ['/api/health', '/api/status', '/api/metrics', '/api/settings', '/api/snapshot']) {
      const response = await app.inject({ method: 'GET', url, headers: { 'x-api-key': FAKE_KEY } });
      expect(response.body).not.toContain('sk-ant');
      expect(JSON.stringify(response.headers)).not.toContain('sk-ant');
    }
  });

  test('GET /api/snapshot returns the mock snapshot', async () => {
    const { app, mock, advance } = await rig();
    advance(3 * SECOND);
    const response = await app.inject({ method: 'GET', url: '/api/snapshot' });
    expect(response.statusCode).toBe(200);
    expect(response.json<VehicleSnapshot>()).toEqual(JSON.parse(JSON.stringify(mock.snapshot())));
  });

  test('POST /api/ask answers and GET /api/dialog then lists the turn', async () => {
    const { app, events } = await rig();
    const ask = await app.inject({ method: 'POST', url: '/api/ask', payload: { text: '  Яка температура масла?  ' } });
    expect(ask.statusCode).toBe(200);
    const { turn } = ask.json<{ turn: DialogTurn }>();
    expect(turn).toMatchObject({ question: 'Яка температура масла?', style: 'full', source: 'panel', model: 'mock' });
    expect(turn.answer).toContain('Демо-режим');

    const dialog = await app.inject({ method: 'GET', url: '/api/dialog?limit=21' });
    expect(dialog.statusCode).toBe(200);
    expect(dialog.json<DialogTurn[]>()).toEqual([turn]);
    // The stored turn changed the spend: the panel hears a fresh status.
    expect(events.some((event) => event.type === 'status')).toBe(true);
  });

  test.each([[''], [' '], ['x'.repeat(501)]])('question %j is a 400 validation error, never a 500', async (text) => {
    const { app, dialog } = await rig();
    const response = await app.inject({ method: 'POST', url: '/api/ask', payload: { text } });
    expect(response.statusCode).toBe(400);
    expectApiError(response.json(), 'validation');
    expect(dialog.recent(10)).toEqual([]);
  });

  test.each([
    ['not json', { 'content-type': 'application/json' }, '{"text":'],
    ['not an object', { 'content-type': 'application/json' }, '"hello"'],
    ['a number for text', { 'content-type': 'application/json' }, '{"text":42}'],
    ['an unknown style', { 'content-type': 'application/json' }, '{"text":"ok","style":"shout"}'],
    ['an oversized body', { 'content-type': 'application/json' }, JSON.stringify({ text: 'ok', pad: 'x'.repeat(20_000) })],
  ])('a body that is %s is a 400 validation error', async (_name, headers, payload) => {
    const { app } = await rig();
    const response = await app.inject({ method: 'POST', url: '/api/ask', headers, payload });
    expect(response.statusCode).toBe(400);
    expectApiError(response.json(), 'validation');
  });

  test.each(['0', '-1', 'NaN', '51', '2.5', 'abc', ''])('limit=%s is a 400 validation error', async (limit) => {
    const { app } = await rig();
    for (const path of ['/api/dialog', '/api/alerts']) {
      const response = await app.inject({ method: 'GET', url: `${path}?limit=${limit}` });
      expect(response.statusCode).toBe(400);
      expectApiError(response.json(), 'validation');
    }
  });

  test('limits from 1 to 50 are accepted; without one the contract defaults apply', async () => {
    const { app } = await rig();
    for (const url of ['/api/dialog', '/api/dialog?limit=1', '/api/dialog?limit=50', '/api/alerts', '/api/alerts?limit=50']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    }
  });

  test('PUT /api/settings rejects NaN, negative and out-of-range limits with 400 and keeps the old settings', async () => {
    const { app, settings } = await rig();
    settings.set(SETTINGS);
    const bad: unknown[] = [
      { ...SETTINGS, ownerLimits: { ...SETTINGS.ownerLimits, oilTempMaxC: 'NaN' } },
      { ...SETTINGS, ownerLimits: { ...SETTINGS.ownerLimits, coolantTempMaxC: -5 } },
      { ...SETTINGS, ownerLimits: { ...SETTINGS.ownerLimits, oilTempMaxC: 201 } },
      { ...SETTINGS, ownerLimits: { ...SETTINGS.ownerLimits, battery12vMinPercent: 0 } },
      { ...SETTINGS, ownerLimits: { ...SETTINGS.ownerLimits, tyrePressureDeviationBar: 2.5 } },
      { ...SETTINGS, ownerLimits: { ...SETTINGS.ownerLimits, tyrePressureDeviationBar: 0.01 } },
      { ...SETTINGS, popupsEnabled: 'yes' },
      { ownerLimits: SETTINGS.ownerLimits },
      // Diagnostics stay off until the owner approves the check in the car (the panel's switch is disabled).
      { ...SETTINGS, diagnosticsEnabled: true },
    ];
    for (const payload of bad) {
      const response = await app.inject({ method: 'PUT', url: '/api/settings', payload: payload as object });
      expect(response.statusCode).toBe(400);
      expectApiError(response.json(), 'validation');
    }
    // A literal NaN is not JSON: still a validation error.
    const nan = await app.inject({
      method: 'PUT', url: '/api/settings', headers: { 'content-type': 'application/json' },
      payload: '{"ownerLimits":{"oilTempMaxC":NaN,"coolantTempMaxC":null,"battery12vMinPercent":null,"tyrePressureDeviationBar":null},"popupsEnabled":true,"diagnosticsEnabled":false}',
    });
    expect(nan.statusCode).toBe(400);
    expectApiError(nan.json(), 'validation');

    expect(settings.get()).toEqual(SETTINGS);
    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json()).toEqual(SETTINGS);
  });

  test('PUT /api/settings accepts null limits and the hub uses them', async () => {
    const { app, settings, engine, advance, events } = await rig();
    settings.set(SETTINGS);
    const next: SettingsDto = { ownerLimits: { ...NO_LIMITS }, popupsEnabled: true, diagnosticsEnabled: false };
    const response = await app.inject({ method: 'PUT', url: '/api/settings', payload: next });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(next);
    expect(settings.get()).toEqual(next);
    expect(events.some((event) => event.type === 'status')).toBe(true);

    const evaluate = vi.spyOn(engine, 'evaluate');
    advance(SECOND);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]![2]).toEqual(NO_LIMITS);
  });

  test('POST /api/mock/scenario switches the scenario; an unknown id is 400; with a car source the route is 404', async () => {
    const { app, mock, events } = await rig();
    const list = await app.inject({ method: 'GET', url: '/api/mock/scenarios' });
    expect(list.statusCode).toBe(200);
    const scenarios = list.json<Array<{ id: string; title: string }>>();
    expect(scenarios.map((s) => s.id)).toContain('overheat-check-control');
    expect(scenarios.every((s) => typeof s.title === 'string' && s.title.length > 0)).toBe(true);

    const set = await app.inject({ method: 'POST', url: '/api/mock/scenario', payload: { id: 'low-tyre' } });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ id: 'low-tyre' });
    expect(mock.scenarioId()).toBe('low-tyre');
    const status = events.filter((event) => event.type === 'status');
    expect(status.at(-1)).toMatchObject({ status: { vehicle: { scenario: 'low-tyre' } } });

    for (const payload of [{ id: 'moon-landing' }, { id: 7 }, {}]) {
      const bad = await app.inject({ method: 'POST', url: '/api/mock/scenario', payload });
      expect(bad.statusCode).toBe(400);
      expectApiError(bad.json(), 'validation');
    }
    expect(mock.scenarioId()).toBe('low-tyre');

    const car = await rig({ config: { vehicleSource: 'car' } });
    for (const [method, url] of [['GET', '/api/mock/scenarios'], ['POST', '/api/mock/scenario']] as const) {
      const response = await car.app.inject({ method, url, payload: method === 'POST' ? { id: 'low-tyre' } : undefined });
      expect(response.statusCode).toBe(404);
      expectApiError(response.json(), 'not-found');
    }
    const carStatus = await car.app.inject({ method: 'GET', url: '/api/status' });
    expect(carStatus.json<StatusDto>().vehicle).toMatchObject({ source: 'car', scenario: null });
  });

  test('an unknown route is a 404 ApiError', async () => {
    const { app } = await rig();
    const response = await app.inject({ method: 'GET', url: '/api/nothing-here' });
    expect(response.statusCode).toBe(404);
    expectApiError(response.json(), 'not-found');
  });

  test('POST /api/ask/stream emits delta events and ends with done', async () => {
    const { app, dialog } = await rig();
    const response = await app.inject({ method: 'POST', url: '/api/ask/stream', payload: { text: 'Як справи?' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toBe('no-cache');
    const events = parseSse(response.body);
    const deltas = events.filter((e) => e.event === 'delta');
    expect(deltas.length).toBeGreaterThan(1);
    const last = events.at(-1)!;
    expect(last.event).toBe('done');
    const done = last.data as Extract<AskStreamEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(deltas.map((e) => (e.data as { text: string }).text).join('')).toBe(done.turn.answer);
    expect(dialog.recent(5)).toEqual([done.turn]);
  });

  test('an invalid question on the stream is a plain 400 before any stream opens', async () => {
    const { app } = await rig();
    const response = await app.inject({ method: 'POST', url: '/api/ask/stream', payload: { text: '' } });
    expect(response.statusCode).toBe(400);
    expectApiError(response.json(), 'validation');
  });

  test('a budget refusal on the stream is a single error event with code budget-exhausted', async () => {
    const { app, dialog } = await rig({ dailyUsdLimit: 0 });
    const response = await app.inject({ method: 'POST', url: '/api/ask/stream', payload: { text: 'Як справи?' } });
    const events = parseSse(response.body);
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('error');
    expect((events[0]!.data as Extract<AskStreamEvent, { type: 'error' }>).error.code).toBe('budget-exhausted');
    expect(dialog.recent(5)).toEqual([]);

    const plain = await app.inject({ method: 'POST', url: '/api/ask', payload: { text: 'Як справи?' } });
    expect(plain.statusCode).toBe(402);
    expectApiError(plain.json(), 'budget-exhausted');
  });

  test.each([
    ['refusal', 422, 'claude-refused'],
    ['rate-limited', 429, 'rate-limited'],
    ['overloaded', 503, 'claude-unavailable'],
  ] as const)('a Claude %s is HTTP %i with code %s', async (claudeCode, status, apiCode) => {
    const gateway: ClaudeGateway = { ask: async () => { throw new ClaudeError(claudeCode, 'x', false); } };
    const { app, dialog } = await rig({ gateway });
    const response = await app.inject({ method: 'POST', url: '/api/ask', payload: { text: 'Як справи?' } });
    expect(response.statusCode).toBe(status);
    expectApiError(response.json(), apiCode);
    expect(dialog.recent(5)).toEqual([]);
  });

  test('a billed refusal still publishes a status event, so the panel shows the new spend', async () => {
    const billed = [{ model: 'claude-opus-5-5', usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }];
    const gateway: ClaudeGateway = { ask: async () => { throw new ClaudeError('refusal', 'x', false, billed); } };
    const { app, events } = await rig({ gateway });
    const statuses = (): number => events.filter((event) => event.type === 'status').length;
    expect((await app.inject({ method: 'POST', url: '/api/ask', payload: { text: 'Як справи?' } })).statusCode).toBe(422);
    expect(statuses()).toBe(1);
    await app.inject({ method: 'POST', url: '/api/ask/stream', payload: { text: 'Як справи?' } });
    expect(statuses()).toBe(2);
  });

  test('closing the app aborts a question still waiting for Claude', async () => {
    const gateway: ClaudeGateway = {
      ask: (_prompt, options) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new ClaudeError('timeout', 'aborted', true)));
      }),
    };
    const { app } = await rig({ gateway });
    const pending = app.inject({ method: 'POST', url: '/api/ask', payload: { text: 'Як справи?' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const began = Date.now();
    await app.close();
    expect(Date.now() - began).toBeLessThan(1000);
    expect((await pending).statusCode).toBe(503);
  });

  test('a bare OPTIONS request gets no plain-text error body', async () => {
    const { app } = await rig();
    const response = await app.inject({ method: 'OPTIONS', url: '/api/status' });
    expect(response.statusCode).toBeLessThan(400);
    expect(response.body).toBe('');
  });

  test('an unexpected exception is a 500 ApiError with code internal and no stack trace or secret in the body', async () => {
    const { app, dialog } = await rig();
    vi.spyOn(dialog, 'recent').mockImplementation(() => {
      throw new Error(`SQLITE_IOERR: disk I/O error ${FAKE_KEY}`);
    });
    const response = await app.inject({ method: 'GET', url: '/api/dialog' });
    expect(response.statusCode).toBe(500);
    expectApiError(response.json(), 'internal');
    expect(response.body).not.toContain('sk-ant');
    expect(response.body).not.toContain('SQLITE');
    expect(response.body).not.toMatch(/\bat\s.+:\d+/);   // no stack frame
  });

  test('CORS is granted to the configured origin only', async () => {
    const { app } = await rig();
    const allowed = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'http://localhost:4200' } });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    const other = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
    expect(other.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  test('the CORS preflight from the configured origin allows PUT for saving settings', async () => {
    const { app } = await rig();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/settings',
      headers: {
        origin: 'http://localhost:4200',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    const methods = String(preflight.headers['access-control-allow-methods']).split(',').map((m) => m.trim());
    expect(methods).toEqual(expect.arrayContaining(['GET', 'HEAD', 'POST', 'PUT']));
  });
});

describe('live events stream', () => {
  interface SseClient { request: ClientRequest; text(): string; response: Promise<IncomingMessage> }

  function connect(port: number, path: string): SseClient {
    let body = '';
    let resolveResponse!: (response: IncomingMessage) => void;
    const response = new Promise<IncomingMessage>((resolve) => { resolveResponse = resolve; });
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('error', () => undefined);
      resolveResponse(res);
    });
    request.on('error', () => undefined);
    request.end();
    return { request, text: () => body, response };
  }

  test('GET /api/events delivers an alert raised by the hub and removes the subscriber on disconnect', async () => {
    const { app, bus, mock, advance } = await rig();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const baseline = bus.listenerCount();

    const client = connect(port, '/api/events');
    const res = await client.response;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    // The current status arrives at once.
    await vi.waitFor(() => expect(parseSse(client.text()).some((e) => e.event === 'status')).toBe(true));
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline + 1));

    const metrics = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(metrics.json<MetricsDto>().sseClients).toBe(1);

    mock.setScenario('overheat-check-control');
    advance(70 * SECOND);
    await vi.waitFor(() => {
      const alert = parseSse(client.text()).find((e) => e.event === 'alert');
      expect(alert).toBeDefined();
      expect((alert!.data as Extract<LiveEvent, { type: 'alert' }>).alert).toMatchObject({
        ruleId: 'check-control', severity: 'critical', active: true,
      });
    });

    client.request.destroy();
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline));
    const after = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(after.json<MetricsDto>().sseClients).toBe(0);
  });

  test(`at most ${MAX_EVENT_STREAMS} event streams are open at once; a further one is a 429 ApiError`, async () => {
    const { app } = await rig();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const clients = Array.from({ length: MAX_EVENT_STREAMS }, () => connect(port, '/api/events'));
    for (const client of clients) expect((await client.response).statusCode).toBe(200);
    const refused = connect(port, '/api/events');
    const res = await refused.response;
    expect(res.statusCode).toBe(429);
    await vi.waitFor(() => expect(refused.text()).not.toBe(''));
    expectApiError(JSON.parse(refused.text()), 'rate-limited');
    // A closed stream makes room again.
    clients[0].request.destroy();
    await vi.waitFor(async () => expect((await app.inject({ method: 'GET', url: '/api/metrics' })).json<MetricsDto>().sseClients).toBe(MAX_EVENT_STREAMS - 1));
    const next = connect(port, '/api/events');
    expect((await next.response).statusCode).toBe(200);
    for (const client of [...clients, next]) client.request.destroy();
  });

  test('closing the app ends open event streams', async () => {
    const { app, bus } = await rig();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const client = connect(port, '/api/events');
    const res = await client.response;
    const ended = new Promise<void>((resolve) => { res.on('end', () => resolve()); res.on('close', () => resolve()); });
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(2));
    await app.close();
    await ended;
    expect(bus.listenerCount()).toBe(1);
  });
});

describe('process lifecycle', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test('close() stops the hub and closes the database', async () => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-backend-'));
    const databasePath = join(dir, 'copilot.sqlite');
    const clock = { now: () => START };
    let intervals = 0;
    const timers: TimerApi = {
      setInterval: () => { intervals++; return intervals; },
      clearInterval: () => { intervals--; },
    };
    const handle = await start({ DATABASE_PATH: databasePath, PORT: '0', LOG_LEVEL: 'silent' }, { clock, timers });
    expect(intervals).toBe(1);                        // the mock provider is running
    expect(existsSync(`${databasePath}-wal`)).toBe(true);   // the database is open in WAL mode
    await handle.close();
    expect(intervals).toBe(0);                        // the hub stopped the provider
    expect(existsSync(`${databasePath}-wal`)).toBe(false);  // the last connection closed and checkpointed
    await handle.close();                             // a second close is harmless
  });

  test('switching the vehicle source on one database resets the vehicle data, keeps the rest and warns once', async () => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-backend-'));
    const databasePath = join(dir, 'data', 'copilot.sqlite');
    const lines: string[] = [];
    const logDestination = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
    const warnings = (): string[] => lines.map((line) => JSON.parse(line) as { level: number; msg: string })
      .filter((line) => line.level === 40).map((line) => line.msg);
    const env = { DATABASE_PATH: databasePath, PORT: '0', LOG_LEVEL: 'warn' };

    const demo = await start(env, { clock: { now: () => START }, timers: NO_TIMERS, logDestination });
    await demo.close();
    expect(statSync(join(dir, 'data')).mode & 0o777).toBe(0o700);
    // What a demo run leaves: an active alert, telemetry, a dialog turn; and what the owner set up.
    let db = openDatabase(databasePath);
    new AlertStore(db).upsert({
      id: 'service:x:1', ruleId: 'service', dedupKey: 'x', provenance: 'bmw-service', severity: 'warning',
      title: 'Гальмівна рідина: через 3 місяці', detail: null, at: START, active: true, clearedAt: null,
    });
    const telemetry = new TelemetryStore(db);
    telemetry.addSample({ at: START, values: { odometer: 48210 } });
    telemetry.rollUpDay('2026-11-13');
    new DialogStore(db).add({
      id: 'demo', at: START + SECOND, question: 'Як авто?', answer: 'Демо-режим без Claude.', style: 'full', source: 'panel',
      model: 'mock', snapshotAt: null,
    });
    new SettingsStore(db).set({ ...SETTINGS, ownerLimits: { ...SETTINGS.ownerLimits, oilTempMaxC: 130 } });
    db.close();
    expect(warnings()).toEqual([]);

    const later = START + 60 * 60 * SECOND;
    const car = await start({ ...env, VEHICLE_SOURCE: 'car' }, { clock: { now: () => later }, logDestination });
    await car.close();
    expect(warnings()).toEqual([expect.stringContaining('vehicle source changed')]);

    db = openDatabase(databasePath);
    try {
      // The demo's alert events are removed, not cleared: the car's history never lists them.
      expect(db.prepare('SELECT COUNT(*) AS n FROM alert_events').get()?.n).toBe(0);
      expect(new TelemetryStore(db).dailySummaries(30)).toEqual([]);
      expect(db.prepare('SELECT source, since FROM vehicle_source').all()).toEqual([{ source: 'car', since: later }]);
      const dialog = new DialogStore(db);
      expect(dialog.recent(5).map((t) => t.id)).toEqual(['demo']);
      expect(new DialogFeed(dialog, later).lastTurns(4)).toEqual([]);
      expect(new SettingsStore(db).get().ownerLimits.oilTempMaxC).toBe(130);
    } finally {
      db.close();
    }

    // The same source again: nothing is reset and nothing is logged.
    const again = await start({ ...env, VEHICLE_SOURCE: 'car' }, { clock: { now: () => later + SECOND }, logDestination });
    await again.close();
    expect(warnings()).toHaveLength(1);
  });

  test('a database from before the source record that holds demo alerts is reset on a first start with the car', async () => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-backend-'));
    const databasePath = join(dir, 'copilot.sqlite');
    const old = new DatabaseSync(databasePath);
    for (const sql of MIGRATIONS.slice(0, 3)) old.exec(sql);
    old.exec('PRAGMA user_version = 3');
    old.exec(`INSERT INTO alert_events VALUES ('cc:39:1', 'check-control', 'cc:39', 'bmw-check-control', 'critical',
      'Температура двигуна. Обережно зупиніться', NULL, ${START}, 1, NULL)`);
    old.close();

    const handle = await start(
      { DATABASE_PATH: databasePath, PORT: '0', LOG_LEVEL: 'silent', VEHICLE_SOURCE: 'car' }, { clock: { now: () => START + SECOND } },
    );
    await handle.close();
    const db = openDatabase(databasePath);
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM alert_events').get()?.n).toBe(0);
      expect(db.prepare('SELECT source FROM vehicle_source').all()).toEqual([{ source: 'car' }]);
    } finally {
      db.close();
    }
  });

  test("a demo start on the car's database is refused unless ALLOW_VEHICLE_SOURCE_RESET is set, and then warns once", async () => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-backend-'));
    const databasePath = join(dir, 'copilot.sqlite');
    const lines: string[] = [];
    const logDestination = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
    const warnings = (): string[] => lines.map((line) => JSON.parse(line) as { level: number; msg: string })
      .filter((line) => line.level === 40).map((line) => line.msg);
    const env = { DATABASE_PATH: databasePath, PORT: '0', LOG_LEVEL: 'warn' };

    const car = await start({ ...env, VEHICLE_SOURCE: 'car' }, { clock: { now: () => START }, logDestination });
    await car.close();
    let db = openDatabase(databasePath);
    new AlertStore(db).upsert({
      id: 'cc:39:1', ruleId: 'check-control', dedupKey: 'cc:39', provenance: 'bmw-check-control', severity: 'critical',
      title: 'car alert', detail: null, at: START, active: true, clearedAt: null,
    });
    new TelemetryStore(db).addSample({ at: START, values: { odometer: 48210 } });
    const dump = (): unknown => ['alert_events', 'telemetry_samples', 'vehicle_source']
      .map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const before = dump();
    db.close();

    // VEHICLE_SOURCE forgotten: the start fails (main's startup-failure path logs it once and exits 1).
    await expect(start(env, { clock: { now: () => START + SECOND }, timers: NO_TIMERS, logDestination }))
      .rejects.toThrow(/DATABASE_PATH[\s\S]*ALLOW_VEHICLE_SOURCE_RESET=1/);
    db = openDatabase(databasePath);
    expect(dump()).toEqual(before);
    db.close();
    expect(warnings()).toEqual([]);

    const later = START + 60 * SECOND;
    const demo = await start(
      { ...env, ALLOW_VEHICLE_SOURCE_RESET: '1' }, { clock: { now: () => later }, timers: NO_TIMERS, logDestination },
    );
    await demo.close();
    expect(warnings()).toEqual([expect.stringContaining('vehicle source changed')]);
    db = openDatabase(databasePath);
    try {
      // The car's alert stays in its history, cleared at the switch; its telemetry is gone.
      expect(new AlertStore(db).get('cc:39:1')).toMatchObject({ active: false, clearedAt: later });
      expect(db.prepare('SELECT COUNT(*) AS n FROM telemetry_samples').get()?.n).toBe(0);
      expect(db.prepare('SELECT source, since FROM vehicle_source').all()).toEqual([{ source: 'mock', since: later }]);
    } finally {
      db.close();
    }
  });

  test('a configuration error rejects start() before anything is opened', async () => {
    await expect(start({ PORT: 'abc', LOG_LEVEL: 'silent' })).rejects.toThrow(/PORT/);
  });

  test('the entry check matches the started file through a symlinked directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-backend-'));
    mkdirSync(join(dir, 'real', 'dist'), { recursive: true });
    const file = join(dir, 'real', 'dist', 'main.js');
    writeFileSync(file, '');
    writeFileSync(join(dir, 'real', 'dist', 'other.js'), '');
    symlinkSync(join(dir, 'real'), join(dir, 'current'), 'dir');   // like /tmp -> /private/tmp or a release link

    expect(isEntryPath(file, file)).toBe(true);
    expect(isEntryPath(join(dir, 'current', 'dist', 'main.js'), file)).toBe(true);
    expect(isEntryPath(join(dir, 'current', 'dist', '..', 'dist', 'main.js'), file)).toBe(true);
    expect(isEntryPath(join(dir, 'current', 'dist', 'other.js'), file)).toBe(false);
    expect(isEntryPath(join(dir, 'missing.js'), file)).toBe(false);
    expect(isEntryPath(undefined, file)).toBe(false);
    expect(isEntryPath(file, undefined)).toBe(false);
  });
});
