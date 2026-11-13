import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CostGuard, MockClaudeGateway, type AskOptions, type BuiltPrompt, type ClaudeGateway, type ClaudeResult } from '@copilot/ai-core';
import { EventEngine, defaultEngineOptions, type AlertEvent } from '@copilot/event-engine';
import type { DialogTurn, LiveEvent } from '@copilot/shared';
import { MockVehicleDataProvider, type ScenarioId, type TimerApi } from '@copilot/vehicle-core';
import { AssistantService } from './assistant/assistant-service';
import { assistantConfigFrom, loadConfig } from './config';
import { openDatabase } from './db/database';
import { buildApp } from './http/app';
import { createLogger } from './logger';
import { AlertStore } from './stores/alert-store';
import { DialogStore } from './stores/dialog-store';
import { EngineStateStore } from './stores/engine-state-store';
import { SettingsStore } from './stores/settings-store';
import { TelemetryStore } from './stores/telemetry-store';
import { SqliteUsageStore } from './stores/usage-store';
import { LiveBus } from './vehicle/live-bus';
import { VehicleHub } from './vehicle/vehicle-hub';

/*
 * The phase-1 vertical slice, end to end through the real HTTP app: the mock vehicle (driven by a manual clock and
 * manual interval timers, never real waiting) → vehicle hub → event engine → alert store and live bus → assistant →
 * (recording) mock Claude gateway → dialog store → REST and SSE. The wiring mirrors `wire()` in main.ts; only the
 * clock, the timers, the in-memory database and the recording gateway differ. Nothing here touches a vehicle or the
 * network beyond a loopback socket.
 */

const SECOND = 1000;
const START = Date.UTC(2026, 10, 13, 10, 0, 0);   // 2026-11-13T10:00:00Z
// The Check Control text of the overheat scenario (packages/vehicle-core/src/mock/scenarios.ts, from 60 s).
const OVERHEAT_CC_TEXT = 'Температура двигуна. Обережно зупиніться';

/** setInterval/clearInterval that fire only when the test moves the manual clock. */
class ManualTimers implements TimerApi {
  private next = 1;
  private readonly intervals = new Map<number, { fn: () => void; ms: number; due: number }>();
  constructor(private readonly clock: { t: number }) {}

  setInterval(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.intervals.set(id, { fn, ms, due: this.clock.t + ms });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  count(): number {
    return this.intervals.size;
  }

  /** Moves the clock forward one second at a time and fires every interval that fell due. */
  advance(ms: number): void {
    const end = this.clock.t + ms;
    while (this.clock.t < end) {
      this.clock.t = Math.min(end, this.clock.t + SECOND);
      for (const [id, timer] of [...this.intervals]) {
        while (this.intervals.has(id) && timer.due <= this.clock.t) {
          timer.due += timer.ms;
          timer.fn();
        }
      }
    }
  }
}

/** The mock gateway, recording every prompt it is given. */
class RecordingGateway implements ClaudeGateway {
  readonly prompts: BuiltPrompt[] = [];
  private readonly inner = new MockClaudeGateway();
  ask(prompt: BuiltPrompt, options: AskOptions): Promise<ClaudeResult> {
    this.prompts.push(prompt);
    return this.inner.ask(prompt, options);
  }
}

interface Slice {
  app: FastifyInstance;
  db: DatabaseSync;
  timers: ManualTimers;
  gateway: RecordingGateway;
  hub: VehicleHub;
  bus: LiveBus;
  port: number;
}

const slices: Slice[] = [];

/** A fresh backend on a fresh in-memory database, listening on a loopback port. */
async function slice(scenario: ScenarioId): Promise<Slice> {
  const config = loadConfig({ LOG_LEVEL: 'silent', MOCK_SCENARIO: scenario });
  const db = openDatabase(':memory:');
  const clock = { t: START, now(): number { return this.t; } };
  const timers = new ManualTimers(clock);

  const alerts = new AlertStore(db);
  const dialog = new DialogStore(db);
  const settings = new SettingsStore(db);
  const telemetry = new TelemetryStore(db);
  const engineState = new EngineStateStore(db);
  const engine = new EventEngine(defaultEngineOptions());
  const saved = engineState.load();
  if (saved) engine.restore(saved);

  const mock = new MockVehicleDataProvider({ clock, timers, scenario: config.mockScenario });
  const bus = new LiveBus();
  const hub = new VehicleHub({
    provider: mock, engine, alerts, telemetry, settings, bus, clock,
    sampleIntervalMs: config.telemetrySampleIntervalMs, retentionDays: config.telemetryRetentionDays,
  });
  const guard = new CostGuard({
    dailyUsdLimit: config.budgetDailyUsd, monthlyUsdLimit: config.budgetMonthlyUsd,
    requestsPerMinute: config.rateLimitPerMinute, clock, store: new SqliteUsageStore(db),
  });
  const gateway = new RecordingGateway();
  let n = 0;
  const assistant = new AssistantService({
    hub, dialog, alerts, settings, telemetry, gateway, guard, clock,
    config: assistantConfigFrom(config), newId: () => `turn-${++n}`,
  });
  const app = buildApp({ config, logger: createLogger(config), hub, bus, assistant, dialog, alerts, settings, guard, mock, clock });

  // As in main.ts: the hub subscribes first; the engine state is saved after each evaluation.
  await hub.start();
  mock.onChange(() => engineState.save(engine.state()));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const s: Slice = { app, db, timers, gateway, hub, bus, port };
  slices.push(s);
  return s;
}

afterEach(async () => {
  for (const s of slices.splice(0)) {
    await s.app.close();
    await s.hub.stop();
    s.db.close();
  }
});

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

describe('vertical slice', () => {
  test('mock telemetry → event engine → Claude → response → live stream', async () => {
    const { app, timers, gateway, bus, port } = await slice('steady-cruise');
    expect(timers.count()).toBe(1);   // the mock provider's one-second tick is the only timer

    const baseline = bus.listenerCount();
    const live = connect(port, '/api/events');
    expect((await live.response).statusCode).toBe(200);
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline + 1));

    // 1. Switch the scenario through the API and let 70 simulated seconds pass.
    const switched = await app.inject({ method: 'POST', url: '/api/mock/scenario', payload: { id: 'overheat-check-control' } });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toEqual({ id: 'overheat-check-control' });
    timers.advance(70 * SECOND);

    // 2. Exactly one alert: the car's own Check Control message, critical.
    const listed = await app.inject({ method: 'GET', url: '/api/alerts' });
    expect(listed.statusCode).toBe(200);
    const alerts = listed.json<AlertEvent[]>();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ provenance: 'bmw-check-control', severity: 'critical', active: true });

    // 3. The open live stream carried that same alert.
    await vi.waitFor(() => {
      const streamed = parseSse(live.text()).filter((e) => e.event === 'alert');
      expect(streamed.map((e) => (e.data as Extract<LiveEvent, { type: 'alert' }>).alert.id)).toContain(alerts[0]!.id);
    });

    // 4. A question is answered against the current snapshot.
    const asked = await app.inject({ method: 'POST', url: '/api/ask', payload: { text: 'Що сталося?' } });
    expect(asked.statusCode).toBe(200);
    const { turn } = asked.json<{ turn: DialogTurn }>();
    expect(turn.question).toBe('Що сталося?');
    expect(turn.answer.trim().length).toBeGreaterThan(0);
    expect(turn.snapshotAt).toBe(START + 70 * SECOND);

    // 5. The dialog lists that turn first.
    const dialog = await app.inject({ method: 'GET', url: '/api/dialog' });
    expect(dialog.statusCode).toBe(200);
    expect(dialog.json<DialogTurn[]>()[0]).toEqual(turn);

    // 6. Claude was given the car's Check Control text in the context.
    expect(gateway.prompts).toHaveLength(1);
    const context = gateway.prompts[0]!.system.map((block) => block.text).join('\n');
    expect(context).toContain(OVERHEAT_CC_TEXT);

    live.request.destroy();
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline));
  });

  test('with every signal missing, asking still answers and no alert exists', async () => {
    // A fresh database: no engine state or alert from an earlier run can be held over.
    const { app, timers, gateway } = await slice('signals-missing');
    timers.advance(70 * SECOND);

    const listed = await app.inject({ method: 'GET', url: '/api/alerts' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([]);

    const snapshot = await app.inject({ method: 'GET', url: '/api/snapshot' });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json<{ oilTemp: unknown }>().oilTemp).toEqual({ available: false, reason: 'not-reported' });

    const asked = await app.inject({ method: 'POST', url: '/api/ask', payload: { text: 'Як почувається авто?' } });
    expect(asked.statusCode).toBe(200);
    const { turn } = asked.json<{ turn: DialogTurn }>();
    expect(turn.answer.trim().length).toBeGreaterThan(0);

    // The prompt names the values as unavailable instead of inventing them.
    const context = gateway.prompts[0]!.system.map((block) => block.text).join('\n');
    expect(context).toContain('Недоступно:');

    const after = await app.inject({ method: 'GET', url: '/api/alerts' });
    expect(after.json()).toEqual([]);
  });
});
