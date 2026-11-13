/**
 * The wired head-unit app (car/src/app.ts) against a fake kit context, a manual clock with injected timers, an
 * in-memory file system and a fake HTTPS client. Nothing here touches a car, a network or the disk.
 *
 * The raw SOME/IP structs are invented in the shapes car/test/fixtures/raw-signals.json documents (vehicle
 * condition names from car/src/provider/raw-decoders.ts, Check Control lists from the same file).
 */
import { describe, expect, test } from 'vitest';
import { NO_LIMITS } from '@copilot/event-engine';
import type { DialogTurn } from '@copilot/shared';
import { POPUP_SETTLE_MS, POPUP_STATE, POPUP_TEXT_LABEL } from './alerts/alert-presenter';
import { TEXT_CLOCK, TEXT_NO_SERVER, TEXT_REFUSED, startApp, type AppHandle } from './app';
import type { KitContext } from './kit/kit';
import { IDLE_FALLBACK_MS } from './power/power-gate';
import { STATE_FILE_NAME } from './state/state-file';
import { SCREEN } from './ui/screen';
import { CHIPS_MOVING, CHIPS_PARKED } from './ui/view-model';
import { UplinkError, type HttpsClient, type UplinkErrorKind } from './uplink/https-client';

const CONDITION = 'de.bmw.infrastructure.VehicleCondition';
const CDS = 'de.bmw.infotainment.vehicle.CDS';
const V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const CCM = 'de.bmw.infotainment.checkcontrol.CheckControlMaster';
const KOMBI2 = 'de.bmw.infotainment.KombiInterface_2';

const DATA_DIR = '/data';
const STATE_PATH = DATA_DIR + '/' + STATE_FILE_NAME;
const BACKEND = 'https://backend.example.invalid';
const START = Date.UTC(2026, 10, 13, 8, 0, 0);

/** Lets promise chains (watch set-up, request outcomes, a deferred provider refresh) run. */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/* ---------- manual time ---------- */

interface FakeTimer { fn: () => void; at: number; every: number | null; ms: number }

function fakeTime(start = START) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, FakeTimer>();
  const api = {
    setInterval: (fn: () => void, ms: number): unknown => {
      timers.set(++seq, { fn, at: now + ms, every: ms, ms });
      return seq;
    },
    clearInterval: (handle: unknown): void => { timers.delete(handle as number); },
    setTimeout: (fn: () => void, ms: number): unknown => {
      timers.set(++seq, { fn, at: now + ms, every: null, ms });
      return seq;
    },
    clearTimeout: (handle: unknown): void => { timers.delete(handle as number); },
  };
  return {
    api,
    clock: { now: () => now },
    /** Moves the clock by ms, running every timer that falls due on the way (and promise jobs after each). */
    async run(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        let nextId = -1;
        let next: FakeTimer | null = null;
        for (const [id, t] of timers) if (t.at <= end && (next === null || t.at < next.at)) { next = t; nextId = id; }
        if (next === null) break;
        now = next.at;
        if (next.every === null) timers.delete(nextId);
        else next.at += next.every;
        next.fn();
        await flush();
      }
      now = end;
      await flush();
    },
    pending(): Array<{ ms: number; repeat: boolean }> {
      return [...timers.values()].map((t) => ({ ms: t.ms, repeat: t.every !== null }));
    },
  };
}

/* ---------- in-memory file system ---------- */

function memFs() {
  const files = new Map<string, string>();
  const writes: string[] = [];
  return {
    files,
    writes,
    stateWrites: () => writes.filter((p) => p === STATE_PATH + '.tmp').length,
    saved: (): Record<string, unknown> => JSON.parse(files.get(STATE_PATH) as string),
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string): string => {
      const text = files.get(p);
      if (text === undefined) throw Object.assign(new Error('ENOENT: no such file ' + p), { code: 'ENOENT' });
      return text;
    },
    writeFileSync: (p: string, data: string): void => {
      writes.push(p);
      files.set(p, data);
    },
    renameSync: (from: string, to: string): void => {
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
  };
}

/* ---------- fake HTTPS client ---------- */

interface Call {
  method: string; path: string; body: unknown; bearer: string; settled: boolean;
  resolve(value: unknown): void; reject(error: unknown): void;
}

function fakeHttp() {
  const f = {
    online: true,
    /** every request is answered 401 */
    unauthorized: false,
    /** GET /car/v1/config waits for the test instead of answering at once */
    holdConfig: false,
    /** POST /car/v1/alerts waits for the test instead of answering at once */
    holdAlerts: false,
    /** GET /car/v1/dialog answers at once with these turns; null = it waits for the test (a long-poll) */
    dialogReply: null as DialogTurn[] | null,
    throwing: false,
    calls: [] as Call[],
    closes: 0,
    reopens: 0,
  };
  const http = {
    online: (): boolean => {
      if (f.throwing) throw new Error('lease unreadable');
      return f.online;
    },
    request(method: string, path: string, body: unknown, bearer: string): Promise<unknown> {
      if (f.throwing) throw new Error('socket exploded');
      return new Promise((resolve, reject) => {
        const call: Call = {
          method, path, body, bearer, settled: false,
          resolve: (v) => { if (!call.settled) { call.settled = true; resolve(v); } },
          reject: (e) => { if (!call.settled) { call.settled = true; reject(e); } },
        };
        f.calls.push(call);
        if (!f.online) return call.reject(new UplinkError('offline', 'no lease'));
        if (f.unauthorized) return call.reject(new UplinkError('unauthorized', 'HTTP 401'));
        if (path === '/car/v1/config' && !f.holdConfig) call.resolve({ ownerLimits: { ...NO_LIMITS }, popupsEnabled: true });
        if ((path === '/car/v1/alerts' && !f.holdAlerts) || path === '/car/v1/snapshots') call.resolve(null);
        if (path.indexOf('/car/v1/dialog') === 0 && f.dialogReply !== null) call.resolve({ turns: f.dialogReply });
      });
    },
    close(): void {
      f.closes++;
      for (const c of f.calls) c.reject(new UplinkError('offline', 'the uplink was closed'));
    },
    reopen(): void {
      f.reopens++;
    },
  };
  return {
    f,
    http: http as unknown as HttpsClient,
    to: (prefix: string) => f.calls.filter((c) => c.path.indexOf(prefix) === 0),
    open: (prefix: string) => f.calls.filter((c) => c.path.indexOf(prefix) === 0 && !c.settled),
  };
}

/* ---------- fake kit context ---------- */

interface KitOptions { config?: Record<string, unknown>; visible?: boolean; settings?: Record<string, unknown>; throwUi?: boolean; throwWatch?: boolean; dataDir?: string }

/** A canvas that records the page's touch targets and accepts every drawing call. */
function fakeCanvas(targets: Map<string, () => unknown>): unknown {
  const fields: Record<string, unknown> = { w: 1600, h: 520, textScale: 1, extra: 0, own: false, chrome: null, place: null, scroll: false };
  const cv: unknown = new Proxy(fields, {
    get(t, p) {
      if (typeof p === 'string' && p in t) return t[p];
      if (p === 'then') return undefined;
      if (p === 'target') return (_x: number, _y: number, _w: number, _h: number, run: () => unknown, key: string) => { targets.set(key, run); return cv; };
      if (p === 'text' || p === 'textWidth') return () => 10;
      return () => cv;
    },
    set(t, p, v) { (t as Record<string | symbol, unknown>)[p] = v; return true; },
  });
  return cv;
}

function fakeKit(o: KitOptions = {}) {
  const handlers: Record<string, Record<string, (value: unknown) => void>> = {};
  const watchCalls: Array<{ iface: string; fields: string[] }> = [];
  const lines: string[] = [];
  const opened: string[] = [];
  const texts: Array<[string, string]> = [];
  const visibleHandlers: Array<(name: string, on: boolean) => void> = [];
  const settingHandlers: Array<(key: string, value: unknown) => void> = [];
  const visible = new Set<string>(o.visible ? [SCREEN] : []);
  const values: Record<string, unknown> = { popups: true, latinPopups: false, ...o.settings };
  const background: Array<[string, boolean]> = [];
  let loopFn: (() => unknown) | null = null;
  const say = (level: string) => (...parts: unknown[]) => { lines.push(level + ' ' + parts.map(String).join(' ')); };
  const ctx = {
    app: {},
    log: { info: say('I'), warn: say('W'), error: say('E'), debug() {} },
    spec: { id: 'p98_copilot', title: 'Copilot', version: '0.1.0', config: o.config || null, stateIds: {} },
    dataDir: o.dataDir === undefined ? DATA_DIR : o.dataDir,
    background: (name: string, on: boolean) => { background.push([name, on]); return Promise.resolve(); },
    signals: {
      watch(iface: string, _instance: string, h: Record<string, (value: unknown) => void>) {
        if (o.throwWatch) throw new Error('someip native module not available');
        watchCalls.push({ iface, fields: Object.keys(h) });
        handlers[iface] = h;
        const w = { iface, available: true, error: null, shutdown: () => { w.available = false; return Promise.resolve(); } };
        return Promise.resolve(w);
      },
    },
    ui: {
      open: (name: string) => { if (o.throwUi) throw new Error('HMI gone'); opened.push(name); return Promise.resolve(); },
      close: () => Promise.resolve(),
      text: (name: string, text: string) => { if (o.throwUi) throw new Error('HMI gone'); texts.push([name, text]); return Promise.resolve(); },
      onClick: () => undefined,
      onVisible: (fn: (name: string, on: boolean) => void) => { visibleHandlers.push(fn); },
      isVisible: (name: string) => visible.has(name),
      image: () => Promise.resolve(),
    },
    settings: { get: (key: string) => values[key], onChange: (fn: (key: string, value: unknown) => void) => { settingHandlers.push(fn); }, display: () => '' },
    theme: () => ({}),
    canvas: () => undefined as unknown,
    loop: (_name: string, _fps: number, fn: () => unknown) => { loopFn = fn; return { stop() { loopFn = null; }, kick() {} }; },
    onTab() {},
    onLayout() {},
  };
  const send = (iface: string, field: string, value: unknown): void => {
    const h = handlers[iface];
    if (h && h[field]) h[field](value);
  };
  return {
    ctx: ctx as unknown as KitContext,
    send,
    watchCalls,
    lines,
    opened,
    texts,
    background,
    condition: (name: string) => send(CONDITION, 'VehicleCondition', { statusConditionVehicle: name }),
    speed: (kmh: number) => send(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: kmh / 0.015625 }),
    rpm: (rpm: number) => send(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: rpm * 4 }),
    /** one Check Control message, its text and colour, active or not */
    cc: (id: number, colour: string, active: boolean) => {
      send(KOMBI2, 'ccList', [{ cCIdentifer: id, cCShortName: 'Synthetic message ' + id, cCColor: colour }]);
      send(CCM, 'basicList', [{ ccmId: id, activeState: active ? 'AKTIV' : 'INAKTIV', requestorDiagAddr: 96, reason: 0 }]);
    },
    setVisible(on: boolean): void {
      if (on) visible.add(SCREEN); else visible.delete(SCREEN);
      for (const fn of visibleHandlers) fn(SCREEN, on);
    },
    setSetting(key: string, value: unknown): void {
      values[key] = value;
      for (const fn of settingHandlers) fn(key, value);
    },
    /** One loop turn of the screen with a recording canvas: the page's touch targets by key. */
    async frame(): Promise<Map<string, () => unknown>> {
      const targets = new Map<string, () => unknown>();
      (ctx as { canvas: () => unknown }).canvas = () => fakeCanvas(targets);
      expect(loopFn).not.toBeNull();
      await loopFn!();
      return targets;
    },
  };
}

/* ---------- the app ---------- */

/** Deterministic hex from a counter, `bytes` bytes long (the app's random source in tests). */
function counterRandom() {
  let n = 0;
  return (bytes: number): string => {
    n++;
    let out = '';
    for (let i = 0; i < bytes; i++) out += ((i * 37 + n * 101) & 255).toString(16).padStart(2, '0');
    return out;
  };
}

const DEVICE = { id: 'a1b2c3d4e5f60718293a4b5c', secret: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0' };

/** A saved state with a device the backend has already accepted. */
function pairedState(extra: Record<string, unknown> = {}) {
  return { v: 1, engine: { keys: [] }, limits: { ...NO_LIMITS }, popupsEnabled: true, asciiPopups: false, device: DEVICE, paired: true, ...extra };
}

interface BootOptions extends KitOptions { fs?: ReturnType<typeof memFs>; net?: ReturnType<typeof fakeHttp>; time?: ReturnType<typeof fakeTime>; state?: unknown; backendUrl?: string | null; droppedReadings?: string[]; missingInterfaces?: string[] }

async function boot(o: BootOptions = {}) {
  const time = o.time || fakeTime();
  const fs = o.fs || memFs();
  if (o.state !== undefined) fs.files.set(STATE_PATH, typeof o.state === 'string' ? o.state : JSON.stringify(o.state));
  const net = o.net || fakeHttp();
  const kit = fakeKit(o);
  const app: AppHandle = startApp({
    ctx: kit.ctx,
    clock: time.clock,
    timers: time.api,
    fs,
    config: {
      backendUrl: o.backendUrl === undefined ? BACKEND : o.backendUrl,
      droppedReadings: o.droppedReadings,
      missingInterfaces: o.missingInterfaces,
    },
    random: counterRandom(),
    screenKit: { has: () => true, frame: () => undefined },
    http: net.http,
  });
  await flush();
  return { app, kit, time, fs, net };
}

type Booted = Awaited<ReturnType<typeof boot>>;

async function drive(s: Booted): Promise<void> {
  s.kit.condition('FAHREN');
  s.kit.rpm(1800);
  await s.time.run(1000);
}

async function park(s: Booted): Promise<void> {
  s.kit.condition('PARKEN_BN_IO');
  await s.time.run(1000);
}

function alertPosts(s: Booted): Array<{ id: string; severity: string }> {
  const out: Array<{ id: string; severity: string }> = [];
  for (const c of s.net.to('/car/v1/alerts')) for (const a of (c.body as { alerts: Array<{ id: string; severity: string }> }).alerts) out.push(a);
  return out;
}

const TICK = [{ ms: 1000, repeat: true }];

describe('startApp', () => {
  test('no interval exists while parked; one 1000 ms interval exists while awake or driving', async () => {
    const s = await boot();
    expect(s.app.inspect().power).toBe('awake');
    expect(s.time.pending()).toEqual(TICK);

    await park(s);
    expect(s.app.inspect().power).toBe('asleep');
    expect(s.time.pending()).toEqual([]);
    await s.time.run(600_000);
    expect(s.time.pending()).toEqual([]);

    await drive(s);
    expect(s.app.inspect().power).toBe('driving');
    expect(s.time.pending()).toEqual(TICK);
    expect(s.kit.background).toEqual([['monitor', true]]);
    s.app.stop();
    expect(s.time.pending()).toEqual([]);
  });

  test('falling asleep clears the interval, closes the uplink and writes the state exactly once', async () => {
    const s = await boot({ state: pairedState() });
    await drive(s);
    await s.time.run(30_000);
    const writes = s.fs.stateWrites();
    const closes = s.net.f.closes;
    await park(s);
    expect(s.time.pending()).toEqual([]);
    expect(s.net.f.closes).toBe(closes + 1);
    expect(s.fs.stateWrites()).toBe(writes + 1);
    await s.time.run(3_600_000);
    expect(s.fs.stateWrites()).toBe(writes + 1);
    // asleep, the uplink refuses everything without a request
    const calls = s.net.f.calls.length;
    s.kit.setVisible(true);
    await flush();
    expect(s.net.f.calls.length).toBe(calls);
  });

  test('a raised warning is shown as a pop-up and sent to the backend; an info event is only listed', async () => {
    const s = await boot({ state: pairedState() });
    await drive(s);
    s.kit.send(KOMBI2, 'ccList', [
      { cCIdentifer: 901, cCShortName: 'Synthetic message 901', cCColor: 'YELLOW' },
      { cCIdentifer: 902, cCShortName: 'Synthetic message 902', cCColor: 'GREEN' },
    ]);
    s.kit.send(CCM, 'basicList', [{ ccmId: 901, activeState: 'AKTIV' }, { ccmId: 902, activeState: 'AKTIV' }]);
    await s.time.run(5000);                                   // the Check Control rule's 4 s dwell
    await s.time.run(POPUP_SETTLE_MS + 1000);
    expect(s.kit.opened.filter((n) => n === POPUP_STATE)).toHaveLength(1);
    const shown = s.kit.texts.filter(([n]) => n === POPUP_TEXT_LABEL).map(([, t]) => t);
    expect(shown.join('\n')).toContain('Synthetic message 901');
    expect(shown.join('\n')).not.toContain('902');
    const posted = alertPosts(s);
    expect(posted).toHaveLength(1);
    expect(posted[0].severity).toBe('warning');
    const listed = s.app.inspect().screen.alerts;
    expect(listed.map((a) => a.title).sort()).toEqual(['Synthetic message 901', 'Synthetic message 902']);
  });

  test('with the uplink offline an alert still pops up', async () => {
    const net = fakeHttp();
    net.f.online = false;
    const s = await boot({ state: pairedState(), net });
    await drive(s);
    s.kit.cc(901, 'RED', true);
    await s.time.run(5000 + POPUP_SETTLE_MS + 1000);
    expect(s.kit.opened).toContain(POPUP_STATE);
    expect(s.net.to('/car/v1/alerts')).toHaveLength(0);
    expect(s.app.inspect().queued.alerts).toBe(1);
  });

  test('a chip tap asks once; a second tap while pending is ignored; an uplink error shows the Ukrainian line', async () => {
    const s = await boot({ state: pairedState(), visible: true });
    let targets = await s.kit.frame();
    targets.get('chip:0')!();
    targets.get('chip:1')!();
    await flush();
    const asks = s.net.to('/car/v1/ask');
    expect(asks).toHaveLength(1);
    expect(asks[0].body).toEqual({ text: CHIPS_PARKED[0], style: 'full' });
    expect(s.app.inspect().screen.pending).toBe(true);

    const cases: Array<[UplinkErrorKind, string]> = [['offline', TEXT_NO_SERVER], ['clock', TEXT_CLOCK], ['client-error', TEXT_REFUSED], ['timeout', TEXT_NO_SERVER]];
    for (const [kind, line] of cases) {
      s.net.open('/car/v1/ask').forEach((c) => c.reject(new UplinkError(kind, 'test')));
      await flush();
      expect(s.app.inspect().screen).toMatchObject({ pending: false, error: line });
      targets.get('chip:0')!();
      await flush();
    }
    expect(TEXT_NO_SERVER).toBe('Немає зв\'язку з сервером');
    expect(TEXT_CLOCK).toBe('Годинник головного блока неправильний');
    expect(TEXT_REFUSED).toBe('Сервер відхилив запит');

    // the answer replaces the error
    const turn: DialogTurn = { id: 't-1', at: START, question: CHIPS_PARKED[0], answer: 'Усе гаразд.', style: 'full', source: 'car', model: 'm', snapshotAt: null };
    s.net.open('/car/v1/ask').forEach((c) => c.resolve({ turn }));
    await flush();
    expect(s.app.inspect().screen).toMatchObject({ pending: false, error: null, lastTurn: turn });

    // moving: the moving chips, answered in the spoken style
    s.kit.condition('FAHREN');
    s.kit.speed(87);
    await s.time.run(2000);
    targets = await s.kit.frame();
    targets.get('chip:0')!();
    await flush();
    const last = s.net.to('/car/v1/ask').pop()!;
    expect(last.body).toEqual({ text: CHIPS_MOVING[0], style: 'spoken' });
  });

  test('a throwing provider, presenter or uplink never escapes a tick', async () => {
    const net = fakeHttp();
    const s = await boot({ state: pairedState(), net, throwUi: true });
    await drive(s);
    net.f.throwing = true;
    // a struct whose member throws when read (the provider's handler), a warning (the presenter's HMI calls throw)
    s.kit.send(CONDITION, 'VehicleCondition', { get statusConditionVehicle(): string { throw new Error('bad struct'); } });
    s.kit.cc(901, 'YELLOW', true);
    await s.time.run(60_000);
    expect(s.app.inspect().power).toBe('driving');
    expect(s.time.pending()).toContainEqual({ ms: 1000, repeat: true });
    await park(s);
    expect(s.app.inspect().power).toBe('asleep');
    expect(s.time.pending()).toEqual([]);
    expect(s.kit.lines.filter((l) => l[0] === 'E').length).toBeLessThan(20);

    // signals.watch itself throws: the app still runs its tick, and falls asleep after the idle fallback
    const t = await boot({ throwWatch: true });
    await t.time.run(IDLE_FALLBACK_MS + 2000);
    expect(t.app.inspect().power).toBe('asleep');
    expect(t.time.pending()).toEqual([]);
  });

  test('restart mid-drive: state is restored and no alert repeats inside its cooldown', async () => {
    const fs = memFs();
    const first = await boot({ fs, state: pairedState() });
    await drive(first);
    first.kit.cc(901, 'YELLOW', true);
    await first.time.run(5000 + POPUP_SETTLE_MS + 1000);
    expect(first.kit.opened.filter((n) => n === POPUP_STATE)).toHaveLength(1);
    expect(alertPosts(first)).toHaveLength(1);
    first.app.persist();                                       // main.ts does this on the process's exit
    first.app.stop();

    // a new process (a tile tap starting the app again), two minutes later, the message still on
    const second = await boot({ fs, time: fakeTime(first.time.clock.now() + 120_000) });
    await drive(second);
    second.kit.cc(901, 'YELLOW', true);
    await second.time.run(60_000);
    expect(second.kit.opened).not.toContain(POPUP_STATE);
    expect(alertPosts(second)).toHaveLength(0);
    expect(second.app.inspect().screen.alerts.map((a) => [a.title, a.active])).toEqual([['Synthetic message 901', true]]);
    expect(second.app.inspect().screen.pairUrl).toContain(DEVICE.id);
  });

  test('a corrupt or missing state file starts clean, with a new device, and logs nothing of its content', async () => {
    const s = await boot({ state: '{"v":1,"device":{"id":"' + DEVICE.id + '","secret":"' + DEVICE.secret + '"' });
    expect(s.app.inspect().power).toBe('awake');
    const saved = s.fs.saved() as { device: { id: string; secret: string } };
    expect(saved.device.id).not.toBe(DEVICE.id);
    for (const line of s.kit.lines) expect(line).not.toContain(DEVICE.secret);
    await drive(s);
    expect(s.app.inspect().power).toBe('driving');
  });

  test('without a data folder from the kit nothing is written anywhere and the app still runs', async () => {
    const s = await boot({ dataDir: '' });
    await drive(s);
    await park(s);
    expect(s.fs.writes).toEqual([]);
    expect(s.app.inspect().power).toBe('asleep');
    expect(s.kit.lines.some((l) => l.indexOf('no data folder') >= 0)).toBe(true);
  });

  test('first run creates a device id (16+ chars) and a secret (32+ chars) and they survive a restart', async () => {
    const fs = memFs();
    const first = await boot({ fs, net: (() => { const n = fakeHttp(); n.f.online = false; return n; })() });
    const saved = fs.saved() as { device: { id: string; secret: string }; paired: boolean };
    expect(saved.device.id.length).toBeGreaterThanOrEqual(16);
    expect(saved.device.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(saved.device.secret.length).toBeGreaterThanOrEqual(32);
    expect(saved.paired).toBe(false);
    expect(first.app.inspect().screen.pairUrl).toBe(BACKEND + '/pair#d=' + saved.device.id + '&s=' + saved.device.secret);
    first.app.stop();
    const second = await boot({ fs });
    expect((fs.saved() as { device: unknown }).device).toEqual(saved.device);
    expect(second.app.inspect().screen.pairUrl).toContain(saved.device.id);
    for (const line of first.kit.lines.concat(second.kit.lines)) expect(line).not.toContain(saved.device.secret);
  });

  test('the pairing panel shows until the backend has accepted this device; marks are not confirmed before an answer', async () => {
    const net = fakeHttp();
    net.f.unauthorized = true;
    net.f.dialogReply = [];
    const s = await boot({ net, visible: true });
    expect(s.app.inspect().screen.link).toBe('unpaired');
    await s.time.run(60_000);
    expect(s.app.inspect().screen.link).toBe('unpaired');
    // refused: at most a request per 30 s goes out (the pairing retry), not one per poll attempt
    expect(net.f.calls.length).toBeLessThanOrEqual(4);

    net.f.unauthorized = false;                                // the owner registered the car on the phone
    await s.time.run(35_000);
    expect(s.app.inspect().screen.link).toBe('ok');
    expect((s.fs.saved() as { paired: boolean }).paired).toBe(true);

    // a car that was paired before: no mark reads as confirmed until a request has been answered
    const held = fakeHttp();
    held.f.holdConfig = true;
    const t = await boot({ state: pairedState(), net: held });
    expect(t.app.inspect().screen.link).toBe('offline');
    held.open('/car/v1/config').forEach((c) => c.resolve({ ownerLimits: { ...NO_LIMITS, oilTempMaxC: 120 }, popupsEnabled: true }));
    await flush();
    expect(t.app.inspect().screen.link).toBe('ok');
    expect((t.fs.saved() as { limits: { oilTempMaxC: number } }).limits.oilTempMaxC).toBe(120);

    // an unauthorized answer later (the device was revoked) shows the pairing panel again
    held.f.unauthorized = true;
    await park(t);
    await drive(t);
    expect(t.app.inspect().screen.link).toBe('unpaired');
    expect((t.fs.saved() as { paired: boolean }).paired).toBe(false);
  });

  test('a dialog poll is open only while the screen is visible and the car is not asleep', async () => {
    const s = await boot({ state: pairedState() });
    expect(s.net.to('/car/v1/dialog')).toHaveLength(0);
    s.kit.setVisible(true);
    await flush();
    expect(s.net.open('/car/v1/dialog')).toHaveLength(1);
    expect(s.net.open('/car/v1/dialog')[0].path).toBe('/car/v1/dialog');

    const turn: DialogTurn = { id: 't-9', at: START, question: 'Що з шинами?', answer: 'Тиск у нормі.', style: 'full', source: 'panel', model: 'm', snapshotAt: null };
    s.net.open('/car/v1/dialog')[0].resolve({ turns: [turn] });
    await flush();
    expect(s.app.inspect().screen.lastTurn).toEqual(turn);
    expect(s.net.open('/car/v1/dialog').map((c) => c.path)).toEqual(['/car/v1/dialog?after=t-9']);

    // hidden: the held poll is left to end by itself (the server holds it at most 25 s); no new one is issued
    const closes = s.net.f.closes;
    const held = s.net.open('/car/v1/dialog');
    s.kit.setVisible(false);
    await flush();
    expect(s.net.f.closes).toBe(closes);
    expect(s.net.open('/car/v1/dialog')).toEqual(held);
    // shown again while it is still open: that same poll goes on, no second one
    s.kit.setVisible(true);
    await flush();
    expect(s.net.open('/car/v1/dialog')).toEqual(held);
    s.kit.setVisible(false);
    await flush();
    await s.time.run(25_000);
    held[0].resolve({ turns: [] });
    await flush();
    expect(s.net.open('/car/v1/dialog')).toHaveLength(0);
    await s.time.run(30_000);
    expect(s.net.open('/car/v1/dialog')).toHaveLength(0);
    expect(s.net.to('/car/v1/dialog')).toHaveLength(2);

    s.kit.setVisible(true);
    await flush();
    expect(s.net.open('/car/v1/dialog')).toHaveLength(1);
    // an error: one new poll after 5 s, not at once
    s.net.open('/car/v1/dialog')[0].reject(new UplinkError('server-error', 'HTTP 502'));
    await flush();
    expect(s.net.open('/car/v1/dialog')).toHaveLength(0);
    await s.time.run(5000);
    expect(s.net.open('/car/v1/dialog')).toHaveLength(1);

    await park(s);
    expect(s.net.open('/car/v1/dialog')).toHaveLength(0);
    await s.time.run(60_000);
    expect(s.net.open('/car/v1/dialog')).toHaveLength(0);
    await drive(s);
    expect(s.net.open('/car/v1/dialog')).toHaveLength(1);
  });

  test('hiding the screen leaves the link alone: the marks stay confirmed and a pending alert is still sent', async () => {
    const net = fakeHttp();
    net.f.holdAlerts = true;
    const s = await boot({ state: pairedState(), net, visible: true });
    await drive(s);
    expect(s.app.inspect().screen.link).toBe('ok');
    s.kit.cc(901, 'YELLOW', true);
    await s.time.run(5000);                                   // the Check Control rule's 4 s dwell
    const pending = net.open('/car/v1/alerts');
    expect(pending).toHaveLength(1);
    expect(net.open('/car/v1/dialog')).toHaveLength(1);
    const closes = net.f.closes;

    s.kit.setVisible(false);
    await flush();
    expect(net.f.closes).toBe(closes);
    expect(s.app.inspect().screen.link).toBe('ok');
    expect(net.open('/car/v1/alerts')).toEqual(pending);    // not cancelled

    pending[0].resolve(null);
    s.kit.setVisible(true);
    await flush();
    expect(s.app.inspect().screen.link).toBe('ok');
    await s.time.run(20_000);
    expect(s.app.inspect().screen.link).toBe('ok');
    expect(alertPosts(s)).toHaveLength(1);                    // sent once, not again after a cancel
    expect(net.f.closes).toBe(closes);
  });

  test('parked means zero timers; a condition change wakes the app with exactly the 1 Hz tick', async () => {
    const s = await boot({ state: pairedState(), visible: true });
    await drive(s);
    s.kit.cc(901, 'YELLOW', true);
    await s.time.run(5000 + POPUP_SETTLE_MS + 500);            // a pop-up is up: the presenter's 1 s check runs
    expect(s.kit.opened).toContain(POPUP_STATE);
    expect(s.time.pending().length).toBeGreaterThan(1);
    s.net.open('/car/v1/dialog').forEach((c) => c.reject(new UplinkError('timeout', 'test')));   // a poll waiting 5 s
    await flush();

    s.kit.condition('PARKEN_BN_IO');
    await s.time.run(1000);
    expect(s.app.inspect().power).toBe('asleep');
    expect(s.time.pending()).toEqual([]);
    expect(s.net.open('')).toHaveLength(0);
    // only the vehicle-condition watch is left: a struct on another interface changes nothing
    s.kit.rpm(900);
    await flush();
    expect(s.time.pending()).toEqual([]);

    s.kit.condition('FAHREN');                                 // the only wake path: a condition change
    await flush();
    expect(s.app.inspect().power).toBe('driving');
    expect(s.time.pending()).toEqual(TICK);
    expect(s.net.f.reopens).toBeGreaterThan(0);
  });

  test('a simulated hour of driving leaves every buffer at or below its cap', async () => {
    const net = fakeHttp();
    net.f.online = false;
    const s = await boot({ state: pairedState(), net });
    await drive(s);
    let id = 1000;
    for (let second = 0; second < 3600; second++) {
      s.kit.rpm(1500 + (second % 40) * 25);
      s.kit.speed(40 + (second % 60));
      if (second % 90 === 0) {
        s.kit.cc(id, 'YELLOW', false);
        id++;
        s.kit.cc(id, 'YELLOW', true);
      }
      await s.time.run(1000);
    }
    const seen = s.app.inspect();
    expect(seen.power).toBe('driving');
    expect(seen.queued.snapshots).toBeGreaterThan(0);
    expect(seen.queued.snapshots).toBeLessThanOrEqual(240);
    expect(seen.queued.alerts).toBe(20);                        // more were raised than the queue keeps
    expect(seen.history).toBeLessThanOrEqual(200);
    expect(seen.screen.alerts.length).toBeLessThanOrEqual(20);
    expect(s.kit.lines.filter((l) => l.indexOf('self: ') >= 0).length).toBeLessThanOrEqual(6);
    expect(s.kit.lines.length).toBeLessThan(40);
    expect(s.time.pending().length).toBeLessThanOrEqual(2);
  });

  test('a reading whose signal the deployed app.json leaves out is not-on-this-vehicle and is not watched', async () => {
    const s = await boot({ state: pairedState(), droppedReadings: ['battery12vCharge', 'no-such-reading'], missingInterfaces: [TPMS] });
    const cds = s.kit.watchCalls.find((c) => c.iface === CDS)!;
    expect(cds.fields).not.toContain('statusBattery2');
    expect(cds.fields).toContain('statusEngineSpeed2');
    expect(s.kit.watchCalls.find((c) => c.iface === TPMS)).toBeUndefined();
    s.kit.send(CDS, 'statusBattery2', { conditionBatteryChargingCondition: 84 });
    await drive(s);
    const snap = s.app.inspect().screen.snapshot!;
    expect(snap.battery12vCharge).toEqual({ available: false, reason: 'not-on-this-vehicle' });
    expect(snap.tyrePressure.frontLeft).toEqual({ available: false, reason: 'not-on-this-vehicle' });
    expect(snap.engineRpm.available).toBe(true);
  });

  test('pop-ups need both switches on; Latin pop-up text follows the car\'s setting and is saved once', async () => {
    const s = await boot({ state: pairedState(), settings: { latinPopups: false } });
    await drive(s);
    const writes = s.fs.stateWrites();
    s.kit.setSetting('latinPopups', true);
    expect(s.fs.stateWrites()).toBe(writes + 1);
    expect((s.fs.saved() as { asciiPopups: boolean }).asciiPopups).toBe(true);
    s.kit.send(KOMBI2, 'ccList', [{ cCIdentifer: 905, cCShortName: 'Тиск у шинах', cCColor: 'YELLOW' }]);
    s.kit.send(CCM, 'basicList', [{ ccmId: 905, activeState: 'AKTIV' }]);
    await s.time.run(5000 + POPUP_SETTLE_MS + 1000);
    const shown = s.kit.texts.filter(([n]) => n === POPUP_TEXT_LABEL).map(([, t]) => t).join('\n');
    expect(shown).toMatch(/Tysk u shynakh/i);
    expect(shown).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);

    const off = await boot({ state: pairedState(), settings: { popups: false } });
    await drive(off);
    off.kit.cc(906, 'RED', true);
    await off.time.run(5000 + POPUP_SETTLE_MS + 1000);
    expect(off.kit.opened).not.toContain(POPUP_STATE);
    expect(alertPosts(off)).toHaveLength(1);                   // still sent and listed, only not popped up

    const quiet = fakeHttp();
    quiet.f.holdConfig = true;                                 // the phone's switch as last fetched: off
    const phoneOff = await boot({ state: pairedState({ popupsEnabled: false }), net: quiet });
    await drive(phoneOff);
    phoneOff.kit.cc(907, 'RED', true);
    await phoneOff.time.run(5000 + POPUP_SETTLE_MS + 1000);
    expect(phoneOff.kit.opened).not.toContain(POPUP_STATE);
  });
});
