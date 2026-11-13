import { afterEach, expect, test, vi } from 'vitest';
import { emptySnapshot, type VehicleSnapshot } from '@copilot/vehicle-core';
import type { AlertEvent } from '@copilot/event-engine';
import type { Log } from '../safe';
import { UplinkError, type HttpsClient, type UplinkErrorKind } from './https-client';
import { ALERT_QUEUE_MAX, ASK_TIMEOUT_MS, SNAPSHOT_BUFFER_SIZE, UplinkClient } from './uplink-client';

const quietLog: Log = { info() {}, warn() {}, error() {} };
const MINUTE = 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are inspected loosely in the assertions
type Body = any;
interface Call { method: string; path: string; body: Body; bearer: string; options?: { timeoutMs?: number } }

/** A stand-in for HttpsClient: records every request and answers with `reply`. */
function fakeHttp(reply: (call: Call) => Promise<unknown> = () => Promise.resolve(undefined)) {
  const state = { online: true, closes: 0, calls: [] as Call[], reply };
  const http = {
    online: () => state.online,
    request(method: string, path: string, body: unknown, bearer: string, options?: { timeoutMs?: number }) {
      const call = { method, path, body: body === null ? null : JSON.parse(JSON.stringify(body)), bearer, options };
      state.calls.push(call);
      if (!state.online) return Promise.reject(new UplinkError('offline', 'no lease'));
      return state.reply(call);
    },
    close() {
      state.closes++;
    },
  };
  return { http: http as unknown as HttpsClient, state };
}

const fail = (kind: UplinkErrorKind) => () => Promise.reject(new UplinkError(kind, kind));

function setup(options: { reply?: (call: Call) => Promise<unknown>; device?: { id: string; secret: string } | null } = {}) {
  const { http, state } = fakeHttp(options.reply);
  const clock = { t: 1_000_000, now() { return this.t; } };
  const device = { current: options.device === undefined ? { id: 'device-0001', secret: 'secret-0001' } : options.device };
  const uplink = new UplinkClient({ http, device: () => device.current, clock, log: quietLog });
  return { uplink, state, clock, device };
}

function snap(n: number): VehicleSnapshot {
  return emptySnapshot(n);
}

function alert(n: number): AlertEvent {
  return {
    id: 'a' + n, ruleId: 'r', dedupKey: 'k' + n, provenance: 'owner-configured', severity: 'warning',
    title: 'Ліміт ' + n, detail: null, at: n, active: true, clearedAt: null,
  };
}

/** Lets the client's promise chains settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('the buffer sizes are the plan\'s', () => {
  expect(SNAPSHOT_BUFFER_SIZE).toBe(240);
  expect(ALERT_QUEUE_MAX).toBe(20);
});

test('while driving one batch goes out per minute with the bearer header; while awake or asleep none does', async () => {
  const { uplink, state, clock } = setup();
  for (let i = 0; i < 3; i++) uplink.recordSnapshot(snap(i));
  uplink.onTick('awake');
  uplink.onTick('asleep');
  expect(state.calls).toHaveLength(0);

  uplink.onTick('driving');
  await settle();
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toMatchObject({ method: 'POST', path: '/car/v1/snapshots', bearer: 'device-0001.secret-0001' });
  expect(state.calls[0].body.snapshots.map((s: VehicleSnapshot) => s.takenAt)).toEqual([0, 1, 2]);

  uplink.recordSnapshot(snap(3));
  for (let s = 1; s < 60; s++) {
    clock.t += 1000;
    uplink.onTick('driving');
    await settle();
  }
  expect(state.calls).toHaveLength(1);
  clock.t += 1000;
  uplink.onTick('driving');
  await settle();
  expect(state.calls).toHaveLength(2);
  expect(state.calls[1].body.snapshots.map((s: VehicleSnapshot) => s.takenAt)).toEqual([3]);
  expect(uplink.status()).toBe('ok');
});

test('a batch holds at most 60 snapshots; an empty buffer sends nothing', async () => {
  const { uplink, state, clock } = setup();
  uplink.onTick('driving');
  expect(state.calls).toHaveLength(0);
  for (let i = 0; i < 100; i++) uplink.recordSnapshot(snap(i));
  uplink.onTick('driving');
  await settle();
  clock.t += MINUTE;
  uplink.onTick('driving');
  await settle();
  expect(state.calls.map((c) => c.body.snapshots.length)).toEqual([60, 40]);
});

test('a recorded snapshot is a copy: later changes to the live object are not sent', async () => {
  const { uplink, state } = setup();
  const live = snap(5);
  uplink.recordSnapshot(live);
  live.takenAt = 99;
  uplink.onTick('driving');
  await settle();
  expect(state.calls[0].body.snapshots[0].takenAt).toBe(5);
});

test('a failed batch is retried at the next interval and the buffer never exceeds 240', async () => {
  const { uplink, state, clock } = setup({ reply: fail('server-error') });
  for (let i = 0; i < 300; i++) uplink.recordSnapshot(snap(i));
  expect(uplink.queued().snapshots).toBe(240);
  uplink.onTick('driving');
  await settle();
  expect(state.calls).toHaveLength(1);
  expect(uplink.status()).toBe('error');
  expect(uplink.queued().snapshots).toBe(240);

  // no retry inside the interval, however many ticks come
  for (let s = 0; s < 59; s++) {
    clock.t += 1000;
    uplink.recordSnapshot(snap(1000 + s));
    uplink.onTick('driving');
    await settle();
    expect(uplink.queued().snapshots).toBeLessThanOrEqual(240);
  }
  expect(state.calls).toHaveLength(1);

  clock.t += 1000;
  uplink.onTick('driving');
  await settle();
  expect(state.calls).toHaveLength(2);
  // the retried batch starts with the oldest snapshot still kept
  const kept = state.calls[1].body.snapshots.map((s: VehicleSnapshot) => s.takenAt);
  expect(kept).toHaveLength(60);
  expect(kept[0]).toBe(119);

  state.reply = () => Promise.resolve(undefined);
  for (let m = 0; m < 10; m++) {
    clock.t += MINUTE;
    uplink.onTick('driving');
    await settle();
  }
  expect(uplink.queued().snapshots).toBe(0);
  expect(uplink.status()).toBe('ok');
});

test('a batch still in flight is not overlapped by the next interval', async () => {
  let release: () => void = () => {};
  const { uplink, state, clock } = setup({ reply: () => new Promise<void>((resolve) => (release = resolve)) });
  for (let i = 0; i < 5; i++) uplink.recordSnapshot(snap(i));
  uplink.onTick('driving');
  clock.t += 2 * MINUTE;
  uplink.recordSnapshot(snap(9));
  uplink.onTick('driving');
  expect(state.calls).toHaveLength(1);
  release();
  await settle();
  clock.t += MINUTE;
  uplink.onTick('driving');
  await settle();
  expect(state.calls).toHaveLength(2);
});

test('a clock that jumps backwards does not stall the uploads', async () => {
  const { uplink, state, clock } = setup();
  uplink.recordSnapshot(snap(1));
  uplink.onTick('driving');
  await settle();
  clock.t -= 3_600_000;
  uplink.recordSnapshot(snap(2));
  uplink.onTick('driving');
  await settle();
  expect(state.calls).toHaveLength(2);
});

test('while offline nothing is attempted and status is offline', async () => {
  const { uplink, state } = setup();
  state.online = false;
  uplink.recordSnapshot(snap(1));
  uplink.onTick('driving');
  await settle();
  expect(state.calls).toHaveLength(0);
  expect(uplink.status()).toBe('offline');
  expect(uplink.queued().snapshots).toBe(1);
});

test('after unauthorized nothing more is sent', async () => {
  const { uplink, state, clock, device } = setup({ reply: fail('unauthorized') });
  uplink.recordSnapshot(snap(1));
  uplink.onTick('driving');
  await settle();
  expect(state.calls).toHaveLength(1);
  expect(uplink.status()).toBe('unpaired');

  for (let m = 0; m < 5; m++) {
    clock.t += MINUTE;
    uplink.recordSnapshot(snap(2 + m));
    uplink.onTick('driving');
    uplink.sendAlerts([alert(m)]);
    await settle();
  }
  await expect(uplink.ask('Як справи?', 'full')).rejects.toMatchObject({ kind: 'unauthorized' });
  await expect(uplink.fetchConfig()).rejects.toMatchObject({ kind: 'unauthorized' });
  await expect(uplink.pollDialog(null)).rejects.toMatchObject({ kind: 'unauthorized' });
  expect(state.calls).toHaveLength(1);

  // a new device identity lifts the block
  state.reply = () => Promise.resolve(undefined);
  device.current = { id: 'device-0002', secret: 'secret-0002' };
  clock.t += MINUTE;
  uplink.onTick('driving');
  await settle();
  expect(state.calls.length).toBeGreaterThan(1);
  expect(state.calls[1].bearer).toBe('device-0002.secret-0002');
});

test('after a client error nothing more is sent either', async () => {
  const { uplink, state, clock } = setup({ reply: fail('client-error') });
  uplink.sendAlerts([alert(1)]);
  await settle();
  expect(state.calls).toHaveLength(1);
  expect(uplink.status()).toBe('error');
  uplink.recordSnapshot(snap(1));
  clock.t += MINUTE;
  uplink.onTick('driving');
  uplink.sendAlerts([alert(2)]);
  await settle();
  await expect(uplink.ask('Стан авто', 'spoken')).rejects.toMatchObject({ kind: 'client-error' });
  expect(state.calls).toHaveLength(1);
});

test('a 4xx refusal of one question does not stop the uploads, but a 401 to it does', async () => {
  const { uplink, state, clock } = setup({ reply: fail('client-error') });
  await expect(uplink.ask('Стан авто', 'full')).rejects.toMatchObject({ kind: 'client-error' });
  state.reply = () => Promise.resolve(undefined);
  uplink.recordSnapshot(snap(1));
  uplink.onTick('driving');
  await settle();
  expect(state.calls).toHaveLength(2);

  state.reply = fail('unauthorized');
  await expect(uplink.ask('Стан авто', 'full')).rejects.toMatchObject({ kind: 'unauthorized' });
  uplink.recordSnapshot(snap(2));
  clock.t += MINUTE;
  uplink.onTick('driving');
  await settle();
  expect(state.calls).toHaveLength(3);
  expect(uplink.status()).toBe('unpaired');
});

test('alerts are sent at once when online and kept (max 20) when offline', async () => {
  const { uplink, state, clock } = setup();
  uplink.sendAlerts([alert(1)]);
  await settle();
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toMatchObject({ method: 'POST', path: '/car/v1/alerts', bearer: 'device-0001.secret-0001' });
  expect(state.calls[0].body.alerts.map((a: AlertEvent) => a.id)).toEqual(['a1']);
  expect(uplink.queued().alerts).toBe(0);

  state.online = false;
  for (let i = 2; i < 30; i++) uplink.sendAlerts([alert(i)]);
  await settle();
  expect(state.calls).toHaveLength(1);
  expect(uplink.queued().alerts).toBe(20);

  // back online: the kept alerts go with the next send, newest 20, oldest first
  state.online = true;
  uplink.sendAlerts([alert(30)]);
  await settle();
  expect(state.calls).toHaveLength(2);
  expect(state.calls[1].body.alerts.map((a: AlertEvent) => a.id)).toEqual(Array.from({ length: 20 }, (_, i) => 'a' + (11 + i)));
  expect(uplink.queued().alerts).toBe(0);

  // a failed alert send keeps them; the next tick after the interval sends them, not every tick
  state.reply = fail('server-error');
  uplink.sendAlerts([alert(31)]);
  await settle();
  expect(uplink.queued().alerts).toBe(1);
  state.reply = () => Promise.resolve(undefined);
  uplink.onTick('awake');
  await settle();
  expect(state.calls).toHaveLength(3);
  clock.t += MINUTE;
  uplink.onTick('awake');
  await settle();
  expect(state.calls).toHaveLength(4);
  expect(state.calls[3].body.alerts.map((a: AlertEvent) => a.id)).toEqual(['a31']);
  expect(uplink.queued().alerts).toBe(0);

  // asleep: nothing at all
  uplink.sendAlerts([]);
  state.online = false;
  uplink.sendAlerts([alert(32)]);
  state.online = true;
  clock.t += MINUTE;
  uplink.onTick('asleep');
  await settle();
  expect(state.calls).toHaveLength(4);
});

test('with no paired device nothing is sent and status is unpaired', async () => {
  const { uplink, state, clock } = setup({ device: null });
  expect(uplink.status()).toBe('unpaired');
  uplink.recordSnapshot(snap(1));
  uplink.sendAlerts([alert(1)]);
  for (let m = 0; m < 3; m++) {
    clock.t += MINUTE;
    uplink.onTick('driving');
  }
  await settle();
  await expect(uplink.ask('Стан авто', 'full')).rejects.toBeInstanceOf(UplinkError);
  await expect(uplink.fetchConfig()).rejects.toBeInstanceOf(UplinkError);
  await expect(uplink.pollDialog(null)).rejects.toBeInstanceOf(UplinkError);
  expect(state.calls).toHaveLength(0);
  expect(uplink.queued()).toEqual({ snapshots: 1, alerts: 1 });
});

test('ask, config and dialog use the car API and check the reply shape', async () => {
  const turn = { id: 't 1', at: 1, question: 'Стан авто', answer: 'Усе гаразд.', style: 'spoken', source: 'car', model: 'm', snapshotAt: null };
  const replies: Record<string, unknown> = {
    'POST /car/v1/ask': { turn },
    'GET /car/v1/config': { ownerLimits: {}, popupsEnabled: true },
    'GET /car/v1/dialog': { turns: [turn] },
    'GET /car/v1/dialog?after=t%201': { turns: [] },
  };
  const { uplink, state } = setup({ reply: (c) => Promise.resolve(replies[c.method + ' ' + c.path]) });
  await expect(uplink.ask('Стан авто', 'spoken')).resolves.toEqual(turn);
  expect(state.calls[0].body).toEqual({ text: 'Стан авто', style: 'spoken' });
  await expect(uplink.fetchConfig()).resolves.toEqual({ ownerLimits: {}, popupsEnabled: true });
  await expect(uplink.pollDialog(null)).resolves.toEqual([turn]);
  await expect(uplink.pollDialog('t 1')).resolves.toEqual([]);
  // the dialog poll may wait 25 s on the server, so its own timeout is longer than that
  const poll = state.calls.find((c) => c.path.indexOf('/car/v1/dialog') === 0)!;
  expect(poll.options!.timeoutMs!).toBeGreaterThan(25_000);
  // the backend may spend up to CLAUDE_TIMEOUT_MS = 60 s on one answer, so the ask waits longer than that
  const ask = state.calls.find((c) => c.path === '/car/v1/ask')!;
  expect(ask.options!.timeoutMs!).toBe(ASK_TIMEOUT_MS);
  expect(ASK_TIMEOUT_MS).toBeGreaterThan(60_000);
  for (const c of state.calls) expect(c.bearer).toBe('device-0001.secret-0001');

  state.reply = () => Promise.resolve({ nothing: true });
  await expect(uplink.ask('x', 'full')).rejects.toMatchObject({ kind: 'server-error' });
  await expect(uplink.fetchConfig()).rejects.toMatchObject({ kind: 'server-error' });
  await expect(uplink.pollDialog(null)).rejects.toMatchObject({ kind: 'server-error' });
});

test('status follows the last outcome', async () => {
  const { uplink, state } = setup();
  expect(uplink.status()).toBe('ok');
  state.reply = fail('clock');
  await expect(uplink.ask('x', 'full')).rejects.toMatchObject({ kind: 'clock' });
  expect(uplink.status()).toBe('clock');
  state.reply = fail('dns');
  await expect(uplink.fetchConfig()).rejects.toMatchObject({ kind: 'dns' });
  expect(uplink.status()).toBe('offline');
  state.reply = fail('timeout');
  await expect(uplink.fetchConfig()).rejects.toMatchObject({ kind: 'timeout' });
  expect(uplink.status()).toBe('error');
  state.reply = () => Promise.resolve({ ownerLimits: {}, popupsEnabled: false });
  await uplink.fetchConfig();
  expect(uplink.status()).toBe('ok');
});

test('a non-UplinkError failure is treated as a server error and never escapes sendAlerts or onTick', async () => {
  const { uplink, state } = setup({ reply: () => Promise.reject(new TypeError('boom')) });
  uplink.recordSnapshot(snap(1));
  expect(() => uplink.onTick('driving')).not.toThrow();
  expect(() => uplink.sendAlerts([alert(1)])).not.toThrow();
  await settle();
  expect(uplink.status()).toBe('error');
  state.reply = () => {
    throw new Error('sync throw');
  };
  expect(() => uplink.sendAlerts([alert(2)])).not.toThrow();
  await settle();
});

test('close() closes the connection and the client can be used again after', async () => {
  const { uplink, state, clock } = setup();
  uplink.close();
  expect(state.closes).toBe(1);
  uplink.recordSnapshot(snap(1));
  clock.t += MINUTE;
  uplink.onTick('driving');
  await settle();
  expect(state.calls).toHaveLength(1);
});

test('no timer is created by the client', async () => {
  const timers = [
    vi.spyOn(globalThis, 'setTimeout'),
    vi.spyOn(globalThis, 'setInterval'),
    vi.spyOn(globalThis, 'setImmediate'),
  ];
  const { uplink, clock } = setup({ reply: fail('server-error') });
  for (let i = 0; i < 100; i++) {
    uplink.recordSnapshot(snap(i));
    uplink.onTick(i % 3 === 0 ? 'asleep' : i % 3 === 1 ? 'awake' : 'driving');
    uplink.sendAlerts([alert(i)]);
    clock.t += 1000;
  }
  await uplink.ask('x', 'full').catch(() => undefined);
  await uplink.fetchConfig().catch(() => undefined);
  await uplink.pollDialog(null).catch(() => undefined);
  uplink.status();
  uplink.close();
  await settle();
  for (const spy of timers) expect(spy).not.toHaveBeenCalled();
});
