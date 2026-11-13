import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { CostGuard, MockClaudeGateway, type ClaudeGateway } from '@copilot/ai-core';
import type { AlertEvent } from '@copilot/event-engine';
import type { CarConfigResponse, CarDialogResponse, DeviceDto, DialogTurn, LiveEvent, StatusDto } from '@copilot/shared';
import { available, emptySnapshot, type VehicleSnapshot } from '@copilot/vehicle-core';
import { AssistantService } from '../../assistant/assistant-service';
import { assistantConfigFrom, loadConfig, type Config } from '../../config';
import { openDatabase } from '../../db/database';
import { buildApp } from '../../http/app';
import { createLogger } from '../../logger';
import { start } from '../../main';
import { AlertStore } from '../../stores/alert-store';
import { DialogStore } from '../../stores/dialog-store';
import { SettingsStore } from '../../stores/settings-store';
import { TelemetryStore } from '../../stores/telemetry-store';
import { SqliteUsageStore } from '../../stores/usage-store';
import { LiveBus } from '../../vehicle/live-bus';
import { VehicleHub } from '../../vehicle/vehicle-hub';
import { CarLinkVehicleDataProvider } from './car-link-provider';
import { DeviceStore } from './device-store';
import { DialogFeed } from './routes';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const START = Date.UTC(2026, 10, 13, 10, 0, 0);   // 2026-11-13T10:00:00Z
// Obviously fake values of the required lengths: never real credentials.
const OWNER_TOKEN = 'test-owner-token-000000000000';
const SESSION_SECRET = 'test-session-secret-00000000000000000000';
const DEVICE_ID = 'test-device-000000000001';
const DEVICE_SECRET = 'feedface'.repeat(8);
const BEARER = `Bearer ${DEVICE_ID}.${DEVICE_SECRET}`;

interface Rig {
  app: FastifyInstance;
  db: DatabaseSync;
  clock: { t: number; now(): number };
  hub: VehicleHub;
  provider: CarLinkVehicleDataProvider;
  devices: DeviceStore;
  feed: DialogFeed;
  alerts: AlertStore;
  dialog: DialogStore;
  events: LiveEvent[];
  logs: string[];
  /** POSTs to /car/v1/<path> as the registered device. */
  car(method: 'GET' | 'POST', path: string, payload?: InjectOptions['payload'], headers?: Record<string, string>): Promise<LightMyRequestResponse>;
}

interface RigOptions { env?: Record<string, string>; gateway?: ClaudeGateway; dialogWaitMs?: number; register?: boolean }

const rigs: Rig[] = [];

async function rig(options: RigOptions = {}): Promise<Rig> {
  const config: Config = loadConfig({ LOG_LEVEL: 'trace', VEHICLE_SOURCE: 'car', ...options.env });
  const logs: string[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } });
  const db = openDatabase(':memory:');
  const clock = { t: START, now(): number { return this.t; } };
  const provider = new CarLinkVehicleDataProvider({ clock });
  const alerts = new AlertStore(db);
  const dialog = new DialogStore(db);
  const settings = new SettingsStore(db);
  const telemetry = new TelemetryStore(db);
  const bus = new LiveBus();
  const events: LiveEvent[] = [];
  bus.subscribe((event) => { events.push(event); });
  const hub = new VehicleHub({
    provider, engine: null, alerts, telemetry, settings, bus, clock, sampleIntervalMs: MINUTE, retentionDays: 90,
  });
  const guard = new CostGuard({
    dailyUsdLimit: config.budgetDailyUsd, monthlyUsdLimit: config.budgetMonthlyUsd,
    requestsPerMinute: config.rateLimitPerMinute, clock, store: new SqliteUsageStore(db),
  });
  const feed = new DialogFeed(dialog);
  const devices = new DeviceStore(db);
  let n = 0;
  const assistant = new AssistantService({
    hub, dialog: feed, alerts, settings, telemetry, gateway: options.gateway ?? new MockClaudeGateway(), guard, clock,
    config: assistantConfigFrom(config), newId: () => `turn-${++n}`,
  });
  const app = buildApp({
    config, logger: createLogger(config, sink), hub, bus, assistant, dialog, alerts, settings, guard, mock: null, clock,
    carLink: { devices, provider, feed, dialogWaitMs: options.dialogWaitMs },
  });
  await hub.start();
  await app.ready();
  if (options.register !== false) devices.register({ deviceId: DEVICE_ID, secret: DEVICE_SECRET, label: 'Головний блок' }, START);
  const r: Rig = {
    app, db, clock, hub, provider, devices, feed, alerts, dialog, events, logs,
    car: (method, path, payload, headers = {}) => app.inject({
      method, url: `/car/v1/${path}`, headers: { authorization: BEARER, ...headers }, ...(payload === undefined ? {} : { payload }),
    }),
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
});

/** A snapshot as the head unit sends it: a few passive readings, the rest not reported. */
function carSnapshot(at: number, oilTemp = 92): VehicleSnapshot {
  return {
    ...emptySnapshot(at),
    oilTemp: available(oilTemp, '°C', 'passive-signal', at),
    speed: available(48, 'km/h', 'passive-signal', at),
    gear: available('D4', null, 'passive-signal', at),
    condition: available('driving', null, 'passive-signal', at),
    checkControl: available([{ id: 39, text: 'Температура двигуна', severity: 'critical', since: at }], null, 'passive-signal', at),
  };
}

function raise(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'check-control:cc:39:1000', ruleId: 'check-control', dedupKey: 'cc:39', provenance: 'bmw-check-control',
    severity: 'critical', title: 'Температура двигуна', detail: null, at: START, active: true, clearedAt: null,
    ...overrides,
  };
}

const alertEvents = (r: Rig): AlertEvent[] => r.events.flatMap((e) => (e.type === 'alert' ? [e.alert] : []));

function turn(id: string, at: number): DialogTurn {
  return { id, at, question: `Питання ${id}`, answer: `Відповідь ${id}`, style: 'full', source: 'panel', model: 'mock', snapshotAt: null };
}

describe('device access', () => {
  test('a registered device can post snapshots; the snapshot is then served by /api/snapshot', async () => {
    const r = await rig();
    const snapshot = carSnapshot(START - 2 * SECOND);
    const posted = await r.car('POST', 'snapshots', { snapshots: [carSnapshot(START - 3 * SECOND, 90), snapshot] });
    expect(posted.statusCode).toBe(204);
    const served = await r.app.inject({ method: 'GET', url: '/api/snapshot' });
    expect(served.json<VehicleSnapshot>()).toEqual(JSON.parse(JSON.stringify(snapshot)));
    expect(r.provider.connected()).toBe(true);
    expect(r.devices.list()).toEqual([{ deviceId: DEVICE_ID, label: 'Головний блок', createdAt: START, lastSeenAt: START }]);
    const status = await r.app.inject({ method: 'GET', url: '/api/status' });
    expect(status.json<StatusDto>().vehicle).toEqual({ source: 'car', connected: true, lastSnapshotAt: snapshot.takenAt, scenario: null });
    // The engine-less hub published the snapshot to the panel.
    expect(r.events.some((e) => e.type === 'snapshot')).toBe(true);
  });

  test.each([['missing header'], ['unknown device'], ['wrong secret'], ['revoked device'], ['malformed header']])(
    '%s is 401 and ingests nothing',
    async (kind) => {
      const r = await rig();
      const headers: Record<string, string> = ({
        'missing header': {},
        'unknown device': { authorization: `Bearer test-device-000000000099.${DEVICE_SECRET}` },
        'wrong secret': { authorization: `Bearer ${DEVICE_ID}.${'0'.repeat(64)}` },
        'revoked device': { authorization: BEARER },
        'malformed header': { authorization: `Basic ${DEVICE_ID}.${DEVICE_SECRET}` },
      } as Record<string, Record<string, string>>)[kind];
      if (kind === 'revoked device') expect(r.devices.remove(DEVICE_ID)).toBe(true);
      const response = await r.app.inject({
        method: 'POST', url: '/car/v1/snapshots', payload: { snapshots: [carSnapshot(START)] }, headers,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
      expect(r.provider.connected()).toBe(false);
      expect(r.hub.snapshot().oilTemp.available).toBe(false);
      for (const [method, path] of [['GET', 'config'], ['GET', 'dialog'], ['POST', 'alerts'], ['POST', 'ask']] as const) {
        const other = await r.app.inject({ method, url: `/car/v1/${path}`, headers, ...(method === 'POST' ? { payload: {} } : {}) });
        expect(other.statusCode).toBe(401);
      }
      expect(r.alerts.recent(10)).toEqual([]);
    },
  );

  test('a batch over 60 snapshots or over 512 KB is rejected with 400/413', async () => {
    const r = await rig();
    const many = Array.from({ length: 61 }, (_, i) => carSnapshot(START - (61 - i) * SECOND));
    const over = await r.car('POST', 'snapshots', { snapshots: many });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe('validation');

    const huge = JSON.stringify({ snapshots: [carSnapshot(START)], pad: 'x'.repeat(600 * 1024) });
    const big = await r.car('POST', 'snapshots', huge, { 'content-type': 'application/json' });
    expect([400, 413]).toContain(big.statusCode);
    expect(r.provider.connected()).toBe(false);

    const sixty = await r.car('POST', 'snapshots', { snapshots: many.slice(1) });
    expect(sixty.statusCode).toBe(204);
  });

  test.each([
    ['an unknown unit', (s: VehicleSnapshot) => ({ ...s, oilTemp: { ...s.oilTemp, unit: 'kelvin' } })],
    ['a non-numeric reading', (s: VehicleSnapshot) => ({ ...s, oilTemp: { ...s.oilTemp, value: '92' } })],
    ['an unknown source', (s: VehicleSnapshot) => ({ ...s, speed: { ...s.speed, source: 'guess' } })],
    ['an unknown reason', (s: VehicleSnapshot) => ({ ...s, range: { available: false, reason: 'because' } })],
    ['a reading without a time', (s: VehicleSnapshot) => ({ ...s, speed: { available: true, value: 1, unit: 'km/h', source: 'passive-signal' } })],
    ['a long gear text', (s: VehicleSnapshot) => ({ ...s, gear: available('D'.repeat(100), null, 'passive-signal', START) })],
    ['a drive mode over 40 characters', (s: VehicleSnapshot) => ({ ...s, driveMode: available('S'.repeat(41), null, 'passive-signal', START) })],
    ['65 Check Control messages', (s: VehicleSnapshot) => ({
      ...s, checkControl: available(Array.from({ length: 65 }, (_, id) => ({ id, text: 'x', severity: 'info', since: START })), null, 'passive-signal', START),
    })],
    ['51 service items', (s: VehicleSnapshot) => ({
      ...s, serviceItems: available(Array.from({ length: 51 }, (_, id) => ({ id, name: 'x', status: 'ok', dueText: null })), null, 'passive-signal', START),
    })],
    ['a Check Control text over 300 characters', (s: VehicleSnapshot) => ({
      ...s, checkControl: available([{ id: 1, text: 'я'.repeat(301), severity: 'info', since: START }], null, 'passive-signal', START),
    })],
    ['a fault code text over 300 characters', (s: VehicleSnapshot) => ({
      ...s, faultCodes: available([{ ecu: 'DME', code: '0x1234', text: 'x'.repeat(301), activeNow: true, warningLamp: false }], null, 'passive-signal', START),
    })],
    ['a missing reading', (s: VehicleSnapshot) => { const rest: Partial<VehicleSnapshot> = { ...s }; delete rest.oilTemp; return rest; }],
  ])('a snapshot with %s is a 400 and the whole batch is dropped', async (_name, spoil) => {
    const r = await rig();
    const response = await r.car('POST', 'snapshots', { snapshots: [carSnapshot(START - SECOND), spoil(carSnapshot(START))] });
    expect(response.statusCode).toBe(400);
    expect(r.provider.connected()).toBe(false);
    expect(r.hub.snapshot().oilTemp.available).toBe(false);
  });

  test('a snapshot at the car decoder\'s own maxima is accepted (car/src/provider/raw-decoders.ts)', async () => {
    const r = await rig();
    const at = START - SECOND;
    const snapshot: VehicleSnapshot = {
      ...carSnapshot(at),
      // applyDriveMode passes through an unknown enum name of up to 40 characters: /^[A-Z][A-Z0-9_]{0,39}$/.
      driveMode: available('S'.repeat(40), null, 'passive-signal', at),
      // MAX_CHECK_CONTROL = 64 active messages, MAX_SERVICE_ITEMS = 32, MAX_TEXT = 80 characters.
      checkControl: available(Array.from({ length: 64 }, (_, id) => ({ id, text: 'я'.repeat(80), severity: 'warning' as const, since: at })), null, 'passive-signal', at),
      serviceItems: available(Array.from({ length: 32 }, (_, id) => ({ id, name: 'я'.repeat(80), status: 'ok' as const, dueText: null })), null, 'passive-signal', at),
    };
    const response = await r.car('POST', 'snapshots', { snapshots: [snapshot] });
    expect(response.statusCode).toBe(204);
    expect(r.hub.snapshot().driveMode).toEqual(available('S'.repeat(40), null, 'passive-signal', at));
    const cc = r.hub.snapshot().checkControl;
    expect(cc.available && cc.value.length).toBe(64);
  });

  test('GET /car/v1/config carries the owner limits and the pop-up switch', async () => {
    const r = await rig();
    const response = await r.car('GET', 'config');
    expect(response.statusCode).toBe(200);
    expect(response.json<CarConfigResponse>()).toEqual({
      ownerLimits: { oilTempMaxC: null, coolantTempMaxC: null, battery12vMinPercent: null, tyrePressureDeviationBar: null },
      popupsEnabled: true,
    });
  });

  test('the owner registers, lists and revokes devices; the secret is never returned', async () => {
    const r = await rig({ register: false });
    const device = { deviceId: 'test-device-000000000002', secret: 'c0ffee00'.repeat(8), label: '  Головний блок  ' };
    const created = await r.app.inject({ method: 'POST', url: '/api/devices', payload: device });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(device.secret);
    expect(created.json<DeviceDto>()).toEqual({ deviceId: device.deviceId, label: 'Головний блок', createdAt: START, lastSeenAt: null });
    const list = await r.app.inject({ method: 'GET', url: '/api/devices' });
    expect(list.json<DeviceDto[]>()).toEqual([created.json()]);
    // Only a SHA-256 of the secret is stored.
    expect(JSON.stringify(r.db.prepare('SELECT * FROM devices').all())).not.toContain(device.secret);

    for (const bad of [
      { ...device, deviceId: 'short' }, { ...device, deviceId: 'has spaces in the id 0000' }, { ...device, deviceId: 'x'.repeat(65) },
      { ...device, secret: 'too-short' }, { ...device, label: '' }, { ...device, label: 'x'.repeat(61) }, { deviceId: device.deviceId },
    ]) {
      const refused = await r.app.inject({ method: 'POST', url: '/api/devices', payload: bad });
      expect(refused.statusCode).toBe(400);
      expect(refused.body).not.toContain(device.secret);
    }
    expect((await r.app.inject({ method: 'DELETE', url: `/api/devices/${device.deviceId}` })).statusCode).toBe(204);
    expect((await r.app.inject({ method: 'DELETE', url: `/api/devices/${device.deviceId}` })).statusCode).toBe(404);
    expect(r.devices.list()).toEqual([]);
  });
});

describe('alerts from the car', () => {
  test('a raise and its clearing under the same id: one stored alert, cleared, original content kept, two publishes', async () => {
    const r = await rig();
    expect((await r.car('POST', 'alerts', { alerts: [raise()] })).statusCode).toBe(204);
    // A clearing rebuilt after a restart of the car app: severity 'info' and an empty title.
    const clearing = raise({ severity: 'info', title: '', active: false, clearedAt: START + MINUTE });
    expect((await r.car('POST', 'alerts', { alerts: [clearing] })).statusCode).toBe(204);
    expect(r.alerts.recent(10)).toEqual([raise({ active: false, clearedAt: START + MINUTE })]);
    expect(alertEvents(r)).toEqual([raise(), raise({ active: false, clearedAt: START + MINUTE })]);

    // Re-opened under the same id: active again, still the original content.
    expect((await r.car('POST', 'alerts', { alerts: [raise({ title: 'інше', at: START + 2 * MINUTE })] })).statusCode).toBe(204);
    expect(r.alerts.recent(10)).toEqual([raise()]);
    expect(alertEvents(r)).toHaveLength(3);
  });

  test('an alert posted twice is stored and published once', async () => {
    const r = await rig();
    await r.car('POST', 'alerts', { alerts: [raise()] });
    await r.car('POST', 'alerts', { alerts: [raise()] });
    await r.car('POST', 'alerts', { alerts: [raise(), raise()] });
    expect(r.alerts.recent(10)).toEqual([raise()]);
    expect(alertEvents(r)).toEqual([raise()]);
  });

  test('a clearing for an unknown id is stored as cleared without inventing content', async () => {
    const r = await rig();
    const clearing = raise({ severity: 'info', title: '', active: false, clearedAt: START + MINUTE });
    await r.car('POST', 'alerts', { alerts: [clearing] });
    expect(r.alerts.recent(10)).toEqual([clearing]);
    expect(r.alerts.active()).toEqual([]);
  });

  test.each([
    ['an unknown severity', { severity: 'fatal' }],
    ['an unknown provenance', { provenance: 'claude' }],
    ['a title over 300 characters', { title: 'x'.repeat(301) }],
    ['a missing id', { id: '' }],
    ['a non-boolean active flag', { active: 'yes' }],
  ])('an alert with %s is a 400 and nothing of the batch is stored', async (_name, spoil) => {
    const r = await rig();
    const response = await r.car('POST', 'alerts', { alerts: [raise({ id: 'first' }), { ...raise(), ...spoil }] });
    expect(response.statusCode).toBe(400);
    expect(r.alerts.recent(10)).toEqual([]);
    expect(alertEvents(r)).toEqual([]);
  });
});

describe('the car-link provider', () => {
  test('the provider reports disconnected three minutes after the last batch', async () => {
    const r = await rig();
    await r.car('POST', 'snapshots', { snapshots: [carSnapshot(START - SECOND)] });
    r.clock.t += 3 * MINUTE - SECOND;
    expect(r.provider.connected()).toBe(true);
    r.clock.t += SECOND;
    expect(r.provider.connected()).toBe(false);
    const status = await r.app.inject({ method: 'GET', url: '/api/status' });
    expect(status.json<StatusDto>().vehicle.connected).toBe(false);
    // An offline car leaves its last snapshot readable, with the times it was taken: the readings age.
    const served = r.hub.snapshot();
    expect(served.oilTemp).toEqual(available(92, '°C', 'passive-signal', START - SECOND));
    expect(served.takenAt).toBe(START - SECOND);
  });

  test('times from a head-unit clock running ahead are capped at the time of receipt', () => {
    const clock = { t: START, now(): number { return this.t; } };
    const provider = new CarLinkVehicleDataProvider({ clock });
    provider.ingest([carSnapshot(START + 10 * MINUTE)]);
    const s = provider.snapshot();
    expect(s.takenAt).toBe(START);
    expect(s.oilTemp).toEqual(available(92, '°C', 'passive-signal', START));
    expect(s.checkControl.available && s.checkControl.at).toBe(START);
    expect(provider.capabilities().diagnosticsEnabled).toBe(false);
    expect(provider.capabilities().delivers).toEqual(expect.arrayContaining(['oilTemp', 'speed', 'gear', 'condition', 'checkControl']));
  });

  test('with VEHICLE_SOURCE=car the mock routes answer 404', async () => {
    const r = await rig();
    expect((await r.app.inject({ method: 'GET', url: '/api/mock/scenarios' })).statusCode).toBe(404);
    expect((await r.app.inject({ method: 'POST', url: '/api/mock/scenario', payload: { id: 'parked' } })).statusCode).toBe(404);
  });

  test('start() with VEHICLE_SOURCE=car runs without an engine and stops cleanly', async () => {
    const handle = await start({ VEHICLE_SOURCE: 'car', DATABASE_PATH: ':memory:', PORT: '0', LOG_LEVEL: 'silent' });
    await handle.close();
  });
});

describe('questions and the dialog from the car', () => {
  test('POST /car/v1/ask answers with a stored turn whose source is car', async () => {
    const r = await rig();
    const response = await r.car('POST', 'ask', { text: 'Як почувається авто?', style: 'spoken' });
    expect(response.statusCode).toBe(200);
    const { turn: answered } = response.json<{ turn: DialogTurn }>();
    expect(answered).toMatchObject({ question: 'Як почувається авто?', style: 'spoken', source: 'car' });
    expect(r.dialog.recent(5)).toEqual([answered]);
  });

  test('car questions pass the same rate gate as panel questions', async () => {
    const r = await rig({ env: { RATE_LIMIT_PER_MINUTE: '1' } });
    expect((await r.app.inject({ method: 'POST', url: '/api/ask', payload: { text: 'Перше' } })).statusCode).toBe(200);
    const refused = await r.car('POST', 'ask', { text: 'Друге', style: 'spoken' });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('rate-limited');
  });

  test('a question Claude does not answer in time is refused within CLAUDE_TIMEOUT_MS', async () => {
    const hanging: ClaudeGateway = { ask: () => new Promise(() => undefined) };
    const r = await rig({ env: { CLAUDE_TIMEOUT_MS: '1000' }, gateway: hanging });
    const began = Date.now();
    const response = await r.car('POST', 'ask', { text: 'Як авто?', style: 'spoken' });
    expect(Date.now() - began).toBeLessThan(3000);
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('claude-unavailable');
    expect(r.dialog.recent(5)).toEqual([]);
  });

  test('an invalid question is a 400', async () => {
    const r = await rig();
    for (const payload of [{ text: '', style: 'spoken' }, { text: 'x'.repeat(501), style: 'spoken' }, { style: 'full' }]) {
      expect((await r.car('POST', 'ask', payload)).statusCode).toBe(400);
    }
  });

  test('GET /car/v1/dialog returns immediately when newer turns exist and waits otherwise', async () => {
    const r = await rig();
    r.feed.add(turn('a', START));
    r.feed.add(turn('b', START + 1));
    r.feed.add(turn('c', START + 2));

    // Without `after`: at most the latest turn, at once.
    expect((await r.car('GET', 'dialog')).json<CarDialogResponse>().turns.map((t) => t.id)).toEqual(['c']);
    // Strictly newer than `after`, oldest first.
    expect((await r.car('GET', 'dialog?after=a')).json<CarDialogResponse>().turns.map((t) => t.id)).toEqual(['b', 'c']);
    // An unknown id counts as absent.
    expect((await r.car('GET', 'dialog?after=nope')).json<CarDialogResponse>().turns.map((t) => t.id)).toEqual(['c']);

    // Nothing newer: the request waits until a turn is stored, then returns it.
    let settled = false;
    const waiting = r.car('GET', 'dialog?after=c').then((response) => { settled = true; return response; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(r.feed.listenerCount()).toBe(1);
    r.clock.t += 10 * SECOND;
    const asked = await r.car('POST', 'ask', { text: 'Що з маслом?', style: 'spoken' });
    const response = await waiting;
    expect(response.statusCode).toBe(200);
    expect(response.json<CarDialogResponse>().turns).toEqual([asked.json<{ turn: DialogTurn }>().turn]);
    expect(r.feed.listenerCount()).toBe(0);
  });

  test('the wait ends empty after its time, and a third waiter of one device releases the oldest', async () => {
    const r = await rig({ dialogWaitMs: 200 });
    const empty = await r.car('GET', 'dialog');
    expect(empty.json<CarDialogResponse>()).toEqual({ turns: [] });
    expect(r.feed.listenerCount()).toBe(0);

    const order: string[] = [];
    const slow = await rig({ dialogWaitMs: 10_000 });
    const first = slow.car('GET', 'dialog').then((x) => { order.push('first'); return x; });
    const second = slow.car('GET', 'dialog').then((x) => { order.push('second'); return x; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const third = slow.car('GET', 'dialog').then((x) => { order.push('third'); return x; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first']);
    expect(slow.feed.listenerCount()).toBe(2);
    expect((await first).json<CarDialogResponse>()).toEqual({ turns: [] });

    // Server shutdown releases the rest.
    await slow.app.close();
    expect((await second).statusCode).toBe(200);
    expect((await third).statusCode).toBe(200);
    expect(slow.feed.listenerCount()).toBe(0);
  });

  test('a waiting request whose client disconnects leaves no waiter behind', async () => {
    const r = await rig({ dialogWaitMs: 10_000 });
    await r.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = r.app.server.address() as AddressInfo;
    const request = httpRequest({ host: '127.0.0.1', port, path: '/car/v1/dialog', method: 'GET', headers: { authorization: BEARER } });
    request.on('error', () => undefined);
    request.end();
    for (let i = 0; i < 50 && r.feed.listenerCount() === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.feed.listenerCount()).toBe(1);
    request.destroy();
    for (let i = 0; i < 50 && r.feed.listenerCount() > 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.feed.listenerCount()).toBe(0);
  });
});

describe('secrets', () => {
  test('the device secret appears in no response body and no log line', async () => {
    const r = await rig({ env: { OWNER_TOKEN, SESSION_SECRET }, register: false });
    const bodies: string[] = [];
    const keep = async (p: Promise<LightMyRequestResponse>) => {
      const response = await p;
      bodies.push(response.body, JSON.stringify(response.headers));
      return response;
    };

    await keep(r.app.inject({ method: 'POST', url: '/api/session', payload: { token: `${OWNER_TOKEN}-wrong` } }));
    const login = await r.app.inject({ method: 'POST', url: '/api/session', payload: { token: OWNER_TOKEN } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const cookieValue = cookie.split('=')[1];
    const owner = { cookie };
    const device = { deviceId: DEVICE_ID, secret: DEVICE_SECRET, label: 'Головний блок' };
    await keep(r.app.inject({ method: 'POST', url: '/api/devices', payload: device, headers: owner }));
    await keep(r.app.inject({ method: 'POST', url: '/api/devices', payload: { ...device, label: '' }, headers: owner }));
    await keep(r.app.inject({ method: 'POST', url: '/api/devices', payload: `{"secret":"${DEVICE_SECRET}"`, headers: { ...owner, 'content-type': 'application/json' } }));
    await keep(r.app.inject({ method: 'GET', url: '/api/devices', headers: owner }));
    await keep(r.car('POST', 'snapshots', { snapshots: [carSnapshot(START)] }));
    await keep(r.car('POST', 'snapshots', { snapshots: [{ secret: DEVICE_SECRET }] }));
    await keep(r.car('POST', 'snapshots', `{"broken": "${DEVICE_SECRET}`, { 'content-type': 'application/json' }));
    await keep(r.car('GET', 'config'));
    await keep(r.app.inject({ method: 'GET', url: '/car/v1/config', headers: { authorization: `Bearer ${DEVICE_ID}.${DEVICE_SECRET}0` } }));
    await keep(r.car('POST', 'ask', { text: 'Як авто?', style: 'spoken' }));
    // A careless log call with secret-named fields is redacted too.
    const app = r.app as unknown as { log: { info(o: object, m: string): void } };
    app.log.info({
      secret: DEVICE_SECRET, token: OWNER_TOKEN, ownerToken: OWNER_TOKEN, sessionSecret: SESSION_SECRET, cookie,
      headers: { authorization: BEARER, cookie, 'set-cookie': cookie },
    }, 'careless');

    expect(r.logs.length).toBeGreaterThan(5);
    const everything = [...bodies, ...r.logs].join('\n');
    for (const secret of [DEVICE_SECRET, OWNER_TOKEN, SESSION_SECRET, cookieValue]) expect(everything).not.toContain(secret);
  });
});
