import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { CostGuard, MockClaudeGateway } from '@copilot/ai-core';
import { EventEngine, defaultEngineOptions } from '@copilot/event-engine';
import type { StatusDto } from '@copilot/shared';
import { MockVehicleDataProvider, type TimerApi } from '@copilot/vehicle-core';
import { AssistantService } from '../../assistant/assistant-service';
import { assistantConfigFrom, loadConfig, type Config } from '../../config';
import { openDatabase } from '../../db/database';
import { buildApp } from '../../http/app';
import { createLogger } from '../../logger';
import { AlertStore } from '../../stores/alert-store';
import { DialogStore } from '../../stores/dialog-store';
import { SettingsStore } from '../../stores/settings-store';
import { TelemetryStore } from '../../stores/telemetry-store';
import { SqliteUsageStore } from '../../stores/usage-store';
import { LiveBus } from '../../vehicle/live-bus';
import { VehicleHub } from '../../vehicle/vehicle-hub';
import { DeviceStore } from '../car-link/device-store';
import { DialogFeed } from '../car-link/routes';
import {
  LoginLimiter, SESSION_COOKIE, SESSION_TTL_MS, issueSessionValue, readCookie, sameSecret, verifySessionValue,
} from './session';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const START = Date.UTC(2026, 10, 13, 10, 0, 0);   // 2026-11-13T10:00:00Z
const NO_TIMERS: TimerApi = { setInterval: () => null, clearInterval: () => undefined };
// Obviously fake values of the required lengths: never real credentials.
const OWNER_TOKEN = 'test-owner-token-000000000000';
const SESSION_SECRET = 'test-session-secret-00000000000000000000';

interface Rig { app: FastifyInstance; db: DatabaseSync; clock: { t: number; now(): number }; hub: VehicleHub }
const rigs: Rig[] = [];

async function rig(env: Record<string, string> = {}): Promise<Rig> {
  const config: Config = loadConfig({ LOG_LEVEL: 'silent', ...env });
  const db = openDatabase(':memory:');
  const clock = { t: START, now(): number { return this.t; } };
  const mock = new MockVehicleDataProvider({ clock, timers: NO_TIMERS, scenario: 'steady-cruise' });
  const alerts = new AlertStore(db);
  const dialog = new DialogStore(db);
  const settings = new SettingsStore(db);
  const telemetry = new TelemetryStore(db);
  const bus = new LiveBus();
  const hub = new VehicleHub({
    provider: mock, engine: new EventEngine(defaultEngineOptions()), alerts, telemetry, settings, bus, clock,
    sampleIntervalMs: MINUTE, retentionDays: 90,
  });
  const guard = new CostGuard({
    dailyUsdLimit: config.budgetDailyUsd, monthlyUsdLimit: config.budgetMonthlyUsd,
    requestsPerMinute: config.rateLimitPerMinute, clock, store: new SqliteUsageStore(db),
  });
  const feed = new DialogFeed(dialog);
  let n = 0;
  const assistant = new AssistantService({
    hub, dialog: feed, alerts, settings, telemetry, gateway: new MockClaudeGateway(), guard, clock,
    config: assistantConfigFrom(config), newId: () => `turn-${++n}`,
  });
  const app = buildApp({
    config, logger: createLogger(config), hub, bus, assistant, dialog, alerts, settings, guard, mock, clock,
    carLink: { devices: new DeviceStore(db), provider: null, feed },
  });
  await hub.start();
  await app.ready();
  const r = { app, db, clock, hub };
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

const PROTECTED = { OWNER_TOKEN, SESSION_SECRET };

/** Logs in and returns the `name=value` pair of the session cookie. */
async function login(app: FastifyInstance): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/session', payload: { token: OWNER_TOKEN } });
  expect(response.statusCode).toBe(204);
  const header = String(response.headers['set-cookie']);
  return header.split(';')[0];
}

describe('owner access', () => {
  test('with OWNER_TOKEN set, /api/status is 401 without a session and 200 with one; /api/health stays open', async () => {
    const { app } = await rig(PROTECTED);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);

    const refused = await app.inject({ method: 'GET', url: '/api/status' });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
    for (const url of ['/api/snapshot', '/api/alerts', '/api/dialog', '/api/settings', '/api/devices', '/api/metrics']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/api/ask', payload: { text: 'Як авто?' } })).statusCode).toBe(401);

    const response = await app.inject({ method: 'POST', url: '/api/session', payload: { token: OWNER_TOKEN } });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    const header = String(response.headers['set-cookie']);
    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=[^;]+;`));
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_TTL_MS / 1000}`]) {
      expect(header.split('; ')).toContain(attribute);
    }
    const cookie = header.split(';')[0];
    const ok = await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<StatusDto>().vehicle.source).toBe('mock');

    // A changed signature or another cookie is not a session.
    const [expires, nonce, mac] = cookie.slice(SESSION_COOKIE.length + 1).split('.');
    const tampered = `${SESSION_COOKIE}=${expires}.${nonce}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
    expect((await app.inject({ method: 'GET', url: '/api/status', headers: { cookie: tampered } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/status', headers: { cookie: 'other=1' } })).statusCode).toBe(401);

    // DELETE /api/session clears the cookie.
    const out = await app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(new RegExp(`^${SESSION_COOKIE}=; .*Max-Age=0`));
  });

  test('a session ends after 30 days', async () => {
    const r = await rig(PROTECTED);
    const cookie = await login(r.app);
    r.clock.t += SESSION_TTL_MS - SECOND;
    expect((await r.app.inject({ method: 'GET', url: '/api/status', headers: { cookie } })).statusCode).toBe(200);
    r.clock.t += 2 * SECOND;
    expect((await r.app.inject({ method: 'GET', url: '/api/status', headers: { cookie } })).statusCode).toBe(401);
  });

  test('a wrong token is 401 and five in a minute lock that address out', async () => {
    const r = await rig(PROTECTED);
    const attempt = (token: string, remoteAddress = '192.0.2.10') =>
      r.app.inject({ method: 'POST', url: '/api/session', payload: { token }, remoteAddress });

    for (let i = 0; i < 5; i++) {
      const wrong = await attempt(`wrong-token-${i}-0000000000000000`);
      expect(wrong.statusCode).toBe(401);
      expect(wrong.headers['set-cookie']).toBeUndefined();
    }
    // Locked: even the right token is refused for a minute, from that address only.
    const locked = await attempt(OWNER_TOKEN);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('rate-limited');
    expect(locked.headers['set-cookie']).toBeUndefined();
    expect((await attempt(OWNER_TOKEN, '192.0.2.11')).statusCode).toBe(204);

    // X-Forwarded-For is not trusted: a forged header does not escape the lock.
    const forged = await r.app.inject({
      method: 'POST', url: '/api/session', payload: { token: OWNER_TOKEN }, remoteAddress: '192.0.2.10',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expect(forged.statusCode).toBe(429);

    r.clock.t += MINUTE + SECOND;
    expect((await attempt(OWNER_TOKEN)).statusCode).toBe(204);
  });

  test('malformed login bodies are 400 and never reach the comparison', async () => {
    const { app } = await rig(PROTECTED);
    for (const payload of [{}, { token: 42 }, { token: '' }, { token: 'x'.repeat(600) }]) {
      const response = await app.inject({ method: 'POST', url: '/api/session', payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('validation');
    }
  });

  test('with no OWNER_TOKEN the API is open (Plan 1 behaviour) and logging in sets no cookie', async () => {
    const { app } = await rig();
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(200);
    const response = await app.inject({ method: 'POST', url: '/api/session', payload: { token: 'anything' } });
    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  test('device registration needs the owner session', async () => {
    const { app } = await rig(PROTECTED);
    const device = { deviceId: 'test-device-000000000001', secret: 'f'.repeat(64), label: 'Головний блок' };
    expect((await app.inject({ method: 'POST', url: '/api/devices', payload: device })).statusCode).toBe(401);
    const cookie = await login(app);
    const created = await app.inject({ method: 'POST', url: '/api/devices', payload: device, headers: { cookie } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ deviceId: device.deviceId, label: 'Головний блок', createdAt: START, lastSeenAt: null });
  });
});

describe('configuration', () => {
  test('with no OWNER_TOKEN a non-loopback HOST is a startup error', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(/OWNER_TOKEN/);
    expect(() => loadConfig({ HOST: '192.0.2.5' })).toThrow(/HOST/);
    for (const host of ['127.0.0.1', '127.0.0.2', '::1', 'localhost']) {
      expect(loadConfig({ HOST: host }).host).toBe(host);
    }
    expect(loadConfig({ HOST: '0.0.0.0', ...PROTECTED })).toMatchObject({
      host: '0.0.0.0', ownerToken: OWNER_TOKEN, sessionSecret: SESSION_SECRET,
    });
  });

  test('OWNER_TOKEN needs a SESSION_SECRET of 32 characters; errors name the variable, never the value', () => {
    const messageOf = (env: Record<string, string>): string => {
      try {
        loadConfig(env);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };
    const missing = messageOf({ OWNER_TOKEN });
    expect(missing).toContain('SESSION_SECRET');
    expect(missing).not.toContain(OWNER_TOKEN);
    const short = messageOf({ OWNER_TOKEN, SESSION_SECRET: 'short-secret-value' });
    expect(short).toContain('SESSION_SECRET');
    expect(short).not.toContain('short-secret-value');
    const shortToken = messageOf({ OWNER_TOKEN: 'short-token-value', SESSION_SECRET });
    expect(shortToken).toContain('OWNER_TOKEN');
    expect(shortToken).not.toContain('short-token-value');
    expect(shortToken).not.toContain(SESSION_SECRET);
    expect(loadConfig({ VEHICLE_SOURCE: 'car' }).vehicleSource).toBe('car');
  });
});

describe('session primitives', () => {
  test('a session value verifies only with its secret, unaltered and unexpired', () => {
    const value = issueSessionValue(SESSION_SECRET, START);
    expect(verifySessionValue(value, SESSION_SECRET, START)).toBe(true);
    expect(verifySessionValue(value, SESSION_SECRET, START + SESSION_TTL_MS - 1)).toBe(true);
    expect(verifySessionValue(value, SESSION_SECRET, START + SESSION_TTL_MS)).toBe(false);
    expect(verifySessionValue(value, `${SESSION_SECRET}x`, START)).toBe(false);
    const [expires, nonce, mac] = value.split('.');
    expect(verifySessionValue(`${Number(expires) + 1}.${nonce}.${mac}`, SESSION_SECRET, START)).toBe(false);
    expect(verifySessionValue(`${expires}.${nonce}.${mac.slice(0, 10)}`, SESSION_SECRET, START)).toBe(false);
    for (const junk of ['', '.', '..', 'a.b.c', `${expires}.${nonce}`]) expect(verifySessionValue(junk, SESSION_SECRET, START)).toBe(false);
  });

  test('cookies are read by name; secrets compare by content', () => {
    expect(readCookie('a=1; copilot_session=abc; b=2', SESSION_COOKIE)).toBe('abc');
    expect(readCookie('a=1', SESSION_COOKIE)).toBeNull();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeNull();
    expect(sameSecret(OWNER_TOKEN, OWNER_TOKEN)).toBe(true);
    expect(sameSecret(`${OWNER_TOKEN}0`, OWNER_TOKEN)).toBe(false);
    expect(sameSecret('', OWNER_TOKEN)).toBe(false);
  });

  test('the login limiter stays bounded', () => {
    const limiter = new LoginLimiter({ maxTracked: 10 });
    for (let i = 0; i < 100; i++) limiter.recordFailure(`198.51.100.${i}`, START);
    expect(limiter.size()).toBeLessThanOrEqual(10);
  });
});
