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
import { CONFIG_RETRY_MS, PAIRING_RETRY_MS, POLL_RETRY_MS, RETRY_MAX_MS, TEXT_CLOCK, TEXT_NO_SERVER, TEXT_REFUSED, TURN_ID_MAX, TURN_TEXT_MAX, startApp, type AppHandle } from './app';
import type { KitContext } from './kit/kit';
import { IDLE_FALLBACK_MS } from './power/power-gate';
import { STATE_FILE_NAME } from './state/state-file';
import { SCREEN } from './ui/screen';
import { CHIPS_MOVING, CHIPS_PARKED } from './ui/view-model';
import { PAIRING_LINES, TEXT_TEST_POPUP } from './ui/strings.uk';
import { UplinkError, type HttpsClient, type RequestOptions, type UplinkErrorKind } from './uplink/https-client';

const CONDITION = 'de.bmw.infrastructure.VehicleCondition';
const CDS = 'de.bmw.infotainment.vehicle.CDS';
const V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const CCM = 'de.bmw.infotainment.checkcontrol.CheckControlMaster';
const KOMBI2 = 'de.bmw.infotainment.KombiInterface_2';
const VI = 'de.bmw.infrastructure.VehicleInformation';

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
  /** ended through the cancel handle the caller was given (RequestOptions.cancelHandle) */
  cancelled: boolean;
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
    /** every request (online) is rejected with this kind; null = answered as above */
    fail: null as UplinkErrorKind | null,
    calls: [] as Call[],
    closes: 0,
    reopens: 0,
  };
  const http = {
    online: (): boolean => {
      if (f.throwing) throw new Error('lease unreadable');
      return f.online;
    },
    request(method: string, path: string, body: unknown, bearer: string, options?: RequestOptions): Promise<unknown> {
      if (f.throwing) throw new Error('socket exploded');
      return new Promise((resolve, reject) => {
        const call: Call = {
          method, path, body, bearer, settled: false, cancelled: false,
          resolve: (v) => { if (!call.settled) { call.settled = true; resolve(v); } },
          reject: (e) => { if (!call.settled) { call.settled = true; reject(e); } },
        };
        f.calls.push(call);
        if (options && options.cancelHandle) {
          options.cancelHandle(() => {
            if (call.settled) return;
            call.cancelled = true;
            call.reject(new UplinkError('offline', 'the request was cancelled'));
          });
        }
        if (!f.online) return call.reject(new UplinkError('offline', 'no lease'));
        if (f.fail !== null) return call.reject(new UplinkError(f.fail, 'test'));
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

/** A canvas that records the page's touch targets and the text drawn, and accepts every other drawing call. */
function fakeCanvas(targets: Map<string, () => unknown>, drawn: string[]): unknown {
  const fields: Record<string, unknown> = { w: 1600, h: 520, textScale: 1, extra: 0, own: false, chrome: null, place: null, scroll: false };
  const cv: unknown = new Proxy(fields, {
    get(t, p) {
      if (typeof p === 'string' && p in t) return t[p];
      if (p === 'then') return undefined;
      if (p === 'target') return (_x: number, _y: number, _w: number, _h: number, run: () => unknown, key: string) => { targets.set(key, run); return cv; };
      if (p === 'text') return (s: unknown) => { drawn.push(String(s)); return 10; };
      if (p === 'textWidth') return () => 10;
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
  // stands for the kit's screen loop (car/kit/runtime/mgu.js ctx.loop): on the car a 4 Hz timer that runs while the
  // head unit reports the screen shown, whatever the power gate says; here a turn runs only when a test calls frame()
  let loopFn: (() => unknown) | null = null;
  let drawn: string[] = [];
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
    /** the selector in R, or back in D (statusGearboxDrive, car/src/provider/raw-decoders.ts applyGearbox) */
    reverse: (on: boolean) => send(VI, 'statusGearboxDrive', { statusActualStageDrive: on ? 'R' : 'D' }),
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
    /** The text the last frame() drew (empty when that turn drew nothing). */
    drawn: (): string[] => drawn.slice(),
    /** One loop turn of the screen with a recording canvas: the page's touch targets by key. */
    async frame(): Promise<Map<string, () => unknown>> {
      const targets = new Map<string, () => unknown>();
      drawn = [];
      (ctx as { canvas: () => unknown }).canvas = () => fakeCanvas(targets, drawn);
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

interface Posted { id: string; severity: string; active: boolean; title: string }

function alertPosts(s: Booted): Posted[] {
  const out: Posted[] = [];
  for (const c of s.net.to('/car/v1/alerts')) for (const a of (c.body as { alerts: Posted[] }).alerts) out.push(a);
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
    s.kit.cc(901, 'YELLOW', true);
    await s.time.run(5000);                                   // raised: its memory is written at once
    s.kit.cc(901, 'YELLOW', false);
    await s.time.run(2000);                                   // cleared inside a minute of that: written later
    const writes = s.fs.stateWrites();
    const closes = s.net.f.closes;
    await park(s);
    expect(s.time.pending()).toEqual([]);
    expect(s.net.f.closes).toBe(closes + 1);
    expect(s.fs.stateWrites()).toBe(writes + 1);
    await s.time.run(3_600_000);
    expect(s.fs.stateWrites()).toBe(writes + 1);
    // a drive and a sleep that changed nothing write nothing
    await drive(s);
    await park(s);
    const settled = s.fs.stateWrites();
    for (let i = 0; i < 3; i++) {
      await drive(s);
      await s.time.run(10_000);
      await park(s);
    }
    expect(s.fs.stateWrites()).toBe(settled);
    // asleep, the uplink refuses everything without a request
    const calls = s.net.f.calls.length;
    s.kit.setVisible(true);
    await flush();
    expect(s.net.f.calls.length).toBe(calls);
  });

  test('a failed state write is not counted as saved: the next chance writes it again', async () => {
    const fs = memFs();
    const s = await boot({ fs, state: pairedState() });
    await drive(s);
    const write = fs.writeFileSync;
    fs.writeFileSync = () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); };
    s.kit.setSetting('latinPopups', true);                     // a change that is saved at once: the write fails
    fs.writeFileSync = write;
    const before = fs.stateWrites();
    s.app.persist();
    expect(fs.stateWrites()).toBe(before + 1);
    expect((fs.saved() as { asciiPopups: boolean }).asciiPopups).toBe(true);
  });

  test('a raised alert reaches the state file at once: a restart without a clean exit does not repeat it', async () => {
    const fs = memFs();
    const first = await boot({ fs, state: pairedState() });
    await drive(first);
    const writes = fs.stateWrites();
    first.kit.cc(901, 'YELLOW', true);
    await first.time.run(5000 + POPUP_SETTLE_MS + 1000);
    expect(first.kit.opened.filter((n) => n === POPUP_STATE)).toHaveLength(1);
    expect(fs.stateWrites()).toBe(writes + 1);
    const raisedId = alertPosts(first)[0].id;
    first.app.stop();                                          // killed: no persist()

    const second = await boot({ fs, time: fakeTime(first.time.clock.now() + 120_000) });
    await drive(second);
    second.kit.cc(901, 'YELLOW', true);
    await second.time.run(60_000);
    expect(second.kit.opened).not.toContain(POPUP_STATE);
    for (const posted of alertPosts(second)) expect([posted.id, posted.active]).toEqual([raisedId, true]);
  });

  test('alert-driven writes stay bounded: a flapping warning writes its clearings at most once a minute', async () => {
    const s = await boot({ state: pairedState() });
    await drive(s);
    const writes = s.fs.stateWrites();
    // ten minutes of a message that comes and goes every 10 s (re-opened inside its cooldown, cleared again)
    for (let i = 0; i < 60; i++) {
      s.kit.cc(901, 'YELLOW', i % 2 === 0);
      await s.time.run(5000);
      s.kit.rpm(1800 + i);
      await s.time.run(5000);
    }
    expect(s.fs.stateWrites() - writes).toBeLessThanOrEqual(12);
    expect(s.fs.stateWrites() - writes).toBeGreaterThan(0);
  });

  test('a quiet car that idled asleep wakes when the owner uses the app; a parked car stays asleep', async () => {
    // engine off, ignition on, nothing notifies for 16 minutes: the idle fallback puts the app to sleep
    const s = await boot({ state: pairedState(), visible: true });
    const targets = await s.kit.frame();
    s.kit.condition('WOHNEN');
    await s.time.run(IDLE_FALLBACK_MS + 60_000);
    expect(s.app.inspect().power).toBe('asleep');
    expect(s.time.pending()).toEqual([]);
    const asks = s.net.to('/car/v1/ask').length;
    // a chip tap wakes it and the question goes out
    targets.get('chip:0')!();
    await flush();
    expect(s.app.inspect().power).toBe('awake');
    expect(s.net.to('/car/v1/ask')).toHaveLength(asks + 1);
    expect(s.time.pending()).toEqual(TICK);
    expect(s.app.inspect().screen.error).toBeNull();

    // asleep again; the screen shown reopens the dialog poll
    const t = await boot({ state: pairedState() });
    t.kit.condition('WOHNEN');
    await t.time.run(IDLE_FALLBACK_MS + 60_000);
    expect(t.app.inspect().power).toBe('asleep');
    t.kit.setVisible(true);
    await flush();
    expect(t.app.inspect().power).toBe('awake');
    expect(t.net.open('/car/v1/dialog')).toHaveLength(1);
    expect(t.time.pending()).toEqual(TICK);
    // used once, it idles out again after another quiet 15 minutes
    t.kit.setVisible(false);
    await t.time.run(IDLE_FALLBACK_MS + 2000);
    expect(t.app.inspect().power).toBe('asleep');

    // parked: a chip tap or the screen shown changes nothing, no timer starts, nothing is sent
    const p = await boot({ state: pairedState(), visible: true });
    const chips = await p.kit.frame();
    await park(p);
    const calls = p.net.f.calls.length;
    chips.get('chip:0')!();
    await flush();
    p.kit.setVisible(false);
    p.kit.setVisible(true);
    await flush();
    await p.time.run(600_000);
    expect(p.app.inspect().power).toBe('asleep');
    expect(p.time.pending()).toEqual([]);
    expect(p.net.f.calls.length).toBe(calls);
    // the owner's car check can see in the log that the screen changed while asleep (the kit's loop follows it)
    expect(p.kit.lines.filter((l) => /^I screen: (shown|hidden) while asleep/.test(l))).toHaveLength(2);
    // standby (the customer not in the car) is asleep too
    p.kit.condition('STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG');
    await flush();
    chips.get('chip:0')!();
    await flush();
    expect(p.app.inspect().power).toBe('asleep');
    expect(p.time.pending()).toEqual([]);
  });

  test('the pairing panel on screen keeps a quiet car awake, so registering on the phone completes pairing', async () => {
    const net = fakeHttp();
    net.f.unauthorized = true;
    net.f.dialogReply = [];
    const s = await boot({ net, visible: true });
    s.kit.condition('WOHNEN');
    await s.time.run(2 * IDLE_FALLBACK_MS + 6 * 60_000);       // long after every back-off reached its cap
    expect(s.app.inspect().power).toBe('awake');
    expect(s.app.inspect().screen.link).toBe('unpaired');
    // one refused request per pairing retry (every 30 s), not one per poll attempt
    expect(net.f.calls.length).toBeLessThanOrEqual(2 * 36 + 10);
    // refused after each pairing retry: logged the first time, then at most once every ten minutes, not every 30 s
    expect(s.kit.lines.filter((l) => l.indexOf('refused a request') >= 0).length).toBeLessThanOrEqual(4);
    net.f.unauthorized = false;                                // the owner registered the car on the phone
    await s.time.run(35_000);
    expect(s.app.inspect().screen.link).toBe('ok');
  });

  test('a wrong head-unit clock is on the pairing panel as soon as a request fails so, logged once per wake', async () => {
    const net = fakeHttp();
    net.f.fail = 'clock';
    const s = await boot({ net, visible: true });              // first run: unpaired, the config fetch fails at once
    expect(s.app.inspect().screen).toMatchObject({ link: 'unpaired', clockWrong: true, error: null });
    await s.kit.frame();
    expect(s.kit.drawn()).toContain(TEXT_CLOCK);
    expect(s.kit.drawn()).not.toContain(PAIRING_LINES[0]);
    const clockLines = () => s.kit.lines.filter((l) => l.indexOf('clock') >= 0);
    expect(clockLines()).toHaveLength(1);
    expect(clockLines()[0]).toMatch(/^W uplink: /);
    await s.time.run(300_000);
    expect(clockLines()).toHaveLength(1);
    expect(s.net.f.calls.length).toBeLessThan(20);             // backed off, not every 5 s

    // after a sleep the first request (the config fetch on waking) finds it again, and logs it once more
    await park(s);
    s.kit.condition('WOHNEN');
    await flush();
    expect(s.app.inspect().power).toBe('awake');
    expect(s.app.inspect().screen.clockWrong).toBe(true);
    expect(s.net.to('/car/v1/config').filter((c) => c.settled).length).toBeGreaterThan(1);
    expect(clockLines()).toHaveLength(2);

    // the owner sets the clock: the next request is answered, the line goes and pairing goes on
    net.f.fail = null;
    net.f.unauthorized = true;
    await s.time.run(PAIRING_RETRY_MS + 1000);                 // the pairing retry tries the poll whatever failed
    expect(s.app.inspect().screen).toMatchObject({ link: 'unpaired', clockWrong: false });
    await s.kit.frame();
    expect(s.kit.drawn()).toContain(PAIRING_LINES[0]);
    expect(s.kit.drawn()).not.toContain(TEXT_CLOCK);

    // paired: the answer area says it without a question being asked
    const paired = fakeHttp();
    paired.f.fail = 'clock';
    const t = await boot({ state: pairedState(), net: paired, visible: true });
    expect(t.app.inspect().screen).toMatchObject({ link: 'clock', clockWrong: true, error: null });
    await t.kit.frame();
    expect(t.kit.drawn()).toContain(TEXT_CLOCK);
  });

  test('repeated failed requests back off: the wait doubles up to ten minutes and starts over on success', async () => {
    expect(RETRY_MAX_MS).toBe(600_000);
    const net = fakeHttp();
    net.f.fail = 'server-error';
    const s = await boot({ state: pairedState(), net, visible: true });
    for (let minute = 0; minute < 30; minute++) {              // the engine running: the car stays awake
      s.kit.rpm(800 + minute);
      await s.time.run(60_000);
    }
    expect(s.app.inspect().power).toBe('awake');
    // without a back-off: 360 polls (one per 5 s) and 30 config fetches (one per minute)
    expect(s.net.to('/car/v1/dialog').length).toBeLessThanOrEqual(12);
    expect(s.net.to('/car/v1/config').length).toBeLessThanOrEqual(7);
    expect(s.time.pending().every((t) => t.ms <= RETRY_MAX_MS)).toBe(true);

    net.f.fail = null;                                         // the server is back
    for (let minute = 0; minute < 10; minute++) {
      s.kit.rpm(900 + minute);
      await s.time.run(60_000);
    }
    expect(s.net.open('/car/v1/dialog')).toHaveLength(1);      // a held long-poll
    expect(s.app.inspect().screen.link).toBe('ok');
    await s.time.run(2000);
    expect(s.net.to('/car/v1/config').filter((c) => c.settled && !c.cancelled).pop()).toBeDefined();
    // the next failure waits the first step again
    s.net.open('/car/v1/dialog')[0].reject(new UplinkError('server-error', 'HTTP 502'));
    await flush();
    await s.time.run(POLL_RETRY_MS);
    expect(s.net.open('/car/v1/dialog')).toHaveLength(1);
    expect(CONFIG_RETRY_MS).toBe(60_000);
  });

  test('a link back after a long outage reopens the dialog poll within a minute, not after the poll\'s back-off', async () => {
    for (const kind of ['offline', 'dns'] as const) {
      const net = fakeHttp();
      const s = await boot({ state: pairedState(), net, visible: true });
      await drive(s);
      expect(s.net.open('/car/v1/dialog')).toHaveLength(1);
      // the link goes: no lease (nothing is sent, the requests are refused locally) or a resolver that fails
      if (kind === 'offline') net.f.online = false;
      else net.f.fail = 'dns';
      for (const c of s.net.open('/car/v1/dialog')) c.reject(new UplinkError(kind, 'link lost'));
      await flush();
      for (let minute = 0; minute < 12; minute++) {
        s.kit.rpm(800 + minute);
        await s.time.run(60_000);
      }
      expect(s.app.inspect().power).toBe('driving');
      net.f.online = true;
      net.f.fail = null;
      // a no-lease refusal is no failure of the link: the poll keeps its 5 s step; after a real failure the next
      // answered request (the minute's snapshot batch) starts the poll's back-off over
      await s.time.run(kind === 'offline' ? POLL_RETRY_MS + 1000 : 61_000);
      expect(s.net.open('/car/v1/dialog')).toHaveLength(1);
      expect(s.app.inspect().screen.link).toBe('ok');
      s.app.stop();
    }
  });

  test('unpaired, the pairing panel tries the poll every 30 s whatever failed before: pairing is seen within 35 s', async () => {
    const net = fakeHttp();
    net.f.fail = 'dns';
    net.f.dialogReply = [];
    const s = await boot({ net, visible: true });
    s.kit.condition('WOHNEN');
    await s.time.run(12 * 60_000);
    expect(s.app.inspect().screen.link).toBe('unpaired');
    net.f.fail = null;                                         // the network is back and the owner registered the car
    await s.time.run(35_000);
    expect(s.app.inspect().screen.link).toBe('ok');
    s.app.stop();
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
    const raisedId = alertPosts(first)[0].id;
    first.app.persist();                                       // main.ts does this on the process's exit
    first.app.stop();

    // a new process (a tile tap starting the app again), two minutes later, the message still on
    const second = await boot({ fs, time: fakeTime(first.time.clock.now() + 120_000) });
    await drive(second);
    second.kit.cc(901, 'YELLOW', true);
    await second.time.run(60_000);
    expect(second.kit.opened).not.toContain(POPUP_STATE);
    // no new raise: at most the re-opened alert under the id of its first raise, still active
    for (const posted of alertPosts(second)) expect([posted.id, posted.active]).toEqual([raisedId, true]);
    expect(second.app.inspect().screen.alerts.map((a) => [a.title, a.active])).toEqual([['Synthetic message 901', true]]);
    expect(second.app.inspect().screen.pairUrl).toContain(DEVICE.id);
  });

  test('restart after a warning went away: its clearing, rebuilt from the key memory, reaches the phone under the raise\'s id', async () => {
    const fs = memFs();
    const first = await boot({ fs, state: pairedState() });
    await drive(first);
    first.kit.cc(901, 'YELLOW', true);
    await first.time.run(5000);
    expect(alertPosts(first).map((a) => [a.severity, a.active])).toEqual([['warning', true]]);
    const raisedId = alertPosts(first)[0].id;
    first.app.persist();
    first.app.stop();

    // a new process, the message gone by the first evaluation: the engine clears it silently, the runner rebuilds it
    const second = await boot({ fs, time: fakeTime(first.time.clock.now() + 120_000) });
    await drive(second);
    // the raise's write fell while its send was in flight, so the file still holds it: sent once more at start
    // (a repeat changes nothing on the backend: VehicleHub.ingestAlert ignores an alert already in that state)
    expect(alertPosts(second).map((a) => [a.id, a.active])).toEqual([[raisedId, true]]);
    const atStart = second.net.to('/car/v1/alerts').length;
    second.kit.cc(901, 'YELLOW', false);
    await second.time.run(2000);
    expect(second.net.to('/car/v1/alerts')).toHaveLength(atStart);   // a clearing causes no request of its own
    await second.time.run(60_000);
    expect(alertPosts(second).slice(1).map((a) => [a.id, a.active, a.severity, a.title])).toEqual([[raisedId, false, 'info', '']]);
    expect(second.kit.opened).not.toContain(POPUP_STATE);
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

    // hidden: the held poll is cancelled at once, alone (the uplink is not closed, the link is not marked failed)
    const closes = s.net.f.closes;
    const held = s.net.open('/car/v1/dialog');
    expect(s.app.inspect().screen.link).toBe('ok');
    s.kit.setVisible(false);
    await flush();
    expect(s.net.f.closes).toBe(closes);
    expect(held[0].cancelled).toBe(true);
    expect(s.net.open('/car/v1/dialog')).toHaveLength(0);
    expect(s.app.inspect().screen.link).toBe('ok');
    expect(s.time.pending()).toEqual(TICK);                    // no retry waits for a hidden screen
    await s.time.run(30_000);
    expect(s.net.open('/car/v1/dialog')).toHaveLength(0);
    expect(s.net.to('/car/v1/dialog')).toHaveLength(2);
    // shown again: one new poll from the last turn seen
    s.kit.setVisible(true);
    await flush();
    expect(s.net.open('/car/v1/dialog').map((c) => c.path)).toEqual(['/car/v1/dialog?after=t-9']);
    s.kit.setVisible(false);
    await flush();
    expect(s.net.open('/car/v1/dialog')).toHaveLength(0);
    expect(s.net.to('/car/v1/dialog')).toHaveLength(3);

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

  test('parked means none of the app\'s timers; a condition change wakes the app with exactly the 1 Hz tick', async () => {
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

  test('a clearing and a re-opening reach the phone under the raise\'s id, riding with the next snapshot batch; an info clearing stays local', async () => {
    const s = await boot({ state: pairedState() });
    await drive(s);
    s.kit.send(KOMBI2, 'ccList', [
      { cCIdentifer: 901, cCShortName: 'Synthetic message 901', cCColor: 'YELLOW' },
      { cCIdentifer: 902, cCShortName: 'Synthetic message 902', cCColor: 'GREEN' },
    ]);
    s.kit.send(CCM, 'basicList', [{ ccmId: 901, activeState: 'AKTIV' }, { ccmId: 902, activeState: 'AKTIV' }]);
    await s.time.run(5000);                                   // the Check Control rule's 4 s dwell
    const raised = alertPosts(s);
    expect(raised.map((a) => [a.severity, a.active])).toEqual([['warning', true]]);   // sent at once, alone
    const id = raised[0].id;

    // both messages go away: the warning's clearing waits for the next snapshot batch and goes with it
    s.kit.send(CCM, 'basicList', [{ ccmId: 901, activeState: 'INAKTIV' }, { ccmId: 902, activeState: 'INAKTIV' }]);
    await s.time.run(2000);
    expect(s.app.inspect().screen.alerts.every((a) => !a.active)).toBe(true);
    expect(s.app.inspect().queued.alerts).toBe(1);
    expect(s.net.to('/car/v1/alerts')).toHaveLength(1);       // no request of its own
    await s.time.run(60_000);
    const posts = s.net.to('/car/v1/alerts');
    expect(posts).toHaveLength(2);
    const at = s.net.f.calls.indexOf(posts[1]);
    expect(s.net.f.calls[at - 1].path).toBe('/car/v1/snapshots');   // in the same tick as the minute's batch
    expect((posts[1].body as { alerts: Posted[] }).alerts.map((a) => [a.id, a.active])).toEqual([[id, false]]);
    expect(s.app.inspect().queued.alerts).toBe(0);

    // the warning comes back inside its cooldown: re-opened under the same id, sent with a batch, not popped up again
    const popups = s.kit.opened.filter((n) => n === POPUP_STATE).length;
    s.kit.send(CCM, 'basicList', [{ ccmId: 901, activeState: 'AKTIV' }]);
    await s.time.run(5000);
    expect(s.net.to('/car/v1/alerts')).toHaveLength(2);
    await s.time.run(60_000);
    const last = s.net.to('/car/v1/alerts');
    expect(last).toHaveLength(3);
    expect((last[2].body as { alerts: Posted[] }).alerts.map((a) => [a.id, a.active])).toEqual([[id, true]]);
    expect(s.kit.opened.filter((n) => n === POPUP_STATE)).toHaveLength(popups);
    for (const posted of alertPosts(s)) expect(posted.severity).not.toBe('info');
  });

  test('the test switch shows one pop-up through the same gates, and stores, lists and sends nothing', async () => {
    const s = await boot({ state: pairedState(), settings: { testPopup: false } });
    await drive(s);
    const writes = s.fs.stateWrites();
    const shownTexts = () => s.kit.texts.filter(([n]) => n === POPUP_TEXT_LABEL).map(([, t]) => t);

    s.kit.setSetting('testPopup', true);
    await s.time.run(POPUP_SETTLE_MS - 500);
    expect(s.kit.opened).not.toContain(POPUP_STATE);           // after the same settle delay as an alert
    await s.time.run(1000);
    expect(s.kit.opened.filter((n) => n === POPUP_STATE)).toHaveLength(1);
    expect(shownTexts()).toEqual([TEXT_TEST_POPUP]);
    expect(TEXT_TEST_POPUP).toBe('Тестове сповіщення Copilot');
    await s.time.run(20_000);
    expect(s.app.inspect().screen.alerts).toEqual([]);
    expect(s.app.inspect().history).toBe(0);
    expect(s.app.inspect().queued.alerts).toBe(0);
    expect(alertPosts(s)).toHaveLength(0);
    expect(s.fs.stateWrites()).toBe(writes);

    // on stays on: only an off-to-on change shows it again
    s.kit.setSetting('testPopup', true);
    await s.time.run(POPUP_SETTLE_MS + 1000);
    expect(s.kit.opened.filter((n) => n === POPUP_STATE)).toHaveLength(1);
    s.kit.setSetting('testPopup', false);
    await s.time.run(POPUP_SETTLE_MS + 1000);
    expect(s.kit.opened.filter((n) => n === POPUP_STATE)).toHaveLength(1);

    // the Latin switch applies to it as well
    s.kit.setSetting('latinPopups', true);
    s.kit.setSetting('testPopup', true);
    await s.time.run(POPUP_SETTLE_MS + 1000);
    expect(s.kit.opened.filter((n) => n === POPUP_STATE)).toHaveLength(2);
    const latin = shownTexts()[1];
    expect(latin).toContain('Copilot');
    expect(latin).toMatch(/^Testove spovishchennia/);
    expect(latin).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);

    // pop-ups switched off: nothing
    s.kit.setSetting('testPopup', false);
    s.kit.setSetting('popups', false);
    s.kit.setSetting('testPopup', true);
    await s.time.run(POPUP_SETTLE_MS + 1000);
    expect(s.kit.opened.filter((n) => n === POPUP_STATE)).toHaveLength(2);

    // asleep: no effect, no timer, and nothing shows up on waking
    s.kit.setSetting('popups', true);
    s.kit.setSetting('testPopup', false);
    await park(s);
    s.kit.setSetting('testPopup', true);
    expect(s.time.pending()).toEqual([]);
    await drive(s);
    await s.time.run(POPUP_SETTLE_MS + 1000);
    expect(s.kit.opened.filter((n) => n === POPUP_STATE)).toHaveLength(2);

    // switched on before the app started: no pop-up at start
    const on = await boot({ state: pairedState(), settings: { testPopup: true } });
    await on.time.run(POPUP_SETTLE_MS + 1000);
    expect(on.kit.opened).not.toContain(POPUP_STATE);
  });

  test('the test pop-up waits while reversing, like an alert', async () => {
    const s = await boot({ state: pairedState() });
    await drive(s);
    s.kit.reverse(true);
    await s.time.run(1000);
    s.kit.setSetting('testPopup', true);
    await s.time.run(POPUP_SETTLE_MS + 3000);
    expect(s.kit.opened).not.toContain(POPUP_STATE);
    s.kit.reverse(false);
    await s.time.run(2000);
    expect(s.kit.opened.filter((n) => n === POPUP_STATE)).toHaveLength(1);
    expect(s.kit.texts.filter(([n]) => n === POPUP_TEXT_LABEL).map(([, t]) => t)).toEqual([TEXT_TEST_POPUP]);
  });

  test('a question asked while the car is not driving carries the current snapshot, sent alone just before it; driving it does not', async () => {
    const s = await boot({ state: pairedState(), visible: true });
    s.kit.condition('PRUEFEN_ANALYSE_DIAGNOSE');               // ignition on, engine off
    s.kit.send(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 0 });
    await s.time.run(10 * 60_000);
    expect(s.app.inspect().power).toBe('awake');
    expect(s.net.to('/car/v1/snapshots')).toHaveLength(0);       // awake: no minute batches
    const before = s.net.f.calls.length;
    const targets = await s.kit.frame();
    targets.get('chip:0')!();
    await flush();
    const sent = s.net.f.calls.slice(before);
    expect(sent.map((c) => c.method + ' ' + c.path)).toEqual(['POST /car/v1/snapshots', 'POST /car/v1/ask']);
    const batch = sent[0].body as { snapshots: Array<{ takenAt: number }>; sentAt: number };
    expect(batch.snapshots).toHaveLength(1);
    expect(batch.sentAt).toBe(s.time.clock.now());
    expect(batch.snapshots[0]).toEqual(JSON.parse(JSON.stringify(s.app.inspect().screen.snapshot)));
    expect(sent[1].body).toEqual({ text: CHIPS_PARKED[0], style: 'full' });
    expect(s.app.inspect().queued.snapshots).toBe(10);          // the buffer is left as it was

    // driving: the minute batch keeps the backend current, the question goes alone
    s.net.open('/car/v1/ask').forEach((c) => c.reject(new UplinkError('timeout', 'test')));
    await drive(s);
    await s.time.run(5000);
    const driving = s.net.f.calls.length;
    (await s.kit.frame()).get('chip:0')!();
    await flush();
    expect(s.net.f.calls.slice(driving).map((c) => c.path)).toEqual(['/car/v1/ask']);
  });

  test('an alert clearing not yet sent when the process ends is kept in the state file and sent by the next process', async () => {
    const fs = memFs();
    const net = fakeHttp();
    const first = await boot({ fs, net, state: pairedState() });
    await drive(first);
    first.kit.cc(901, 'YELLOW', true);
    await first.time.run(5000);
    const raisedId = alertPosts(first)[0].id;
    net.f.online = false;                                      // underground parking
    first.kit.cc(901, 'YELLOW', false);
    await first.time.run(2000);
    expect(first.app.inspect().queued.alerts).toBe(1);
    await park(first);                                         // asleep: the state is written once
    const saved = fs.saved() as { pendingAlerts?: Array<{ id: string; active: boolean }> };
    expect((saved.pendingAlerts || []).map((a) => [a.id, a.active])).toEqual([[raisedId, false]]);
    first.app.stop();                                          // the process ends

    const net2 = fakeHttp();
    const second = await boot({ fs, net: net2, time: fakeTime(first.time.clock.now() + 3_600_000) });
    expect(second.app.inspect().queued.alerts).toBe(1);
    await second.time.run(2000);
    expect(alertPosts(second).map((a) => [a.id, a.active])).toEqual([[raisedId, false]]);
    expect(second.app.inspect().queued.alerts).toBe(0);
    // carrying the queue adds no write of its own: a sleep that changed nothing else writes nothing
    const writes = fs.stateWrites();
    await park(second);
    expect(fs.stateWrites()).toBe(writes);
  });

  test('a write made while an alert send is in flight keeps the queued clearing; the send fails and the next process sends both', async () => {
    const fs = memFs();
    const net = fakeHttp();
    const first = await boot({ fs, net, state: pairedState() });
    await drive(first);
    first.kit.cc(901, 'YELLOW', true);
    await first.time.run(5000);
    const raisedId = alertPosts(first)[0].id;
    await first.time.run(120_000);
    net.f.online = false;                                      // no lease: the clearing is queued and written
    first.kit.cc(901, 'YELLOW', false);
    await first.time.run(3000);
    const pend = () => (((fs.saved() as { pendingAlerts?: Array<{ id: string; active: boolean; severity: string }> }).pendingAlerts) || [])
      .map((a) => [a.id === raisedId, a.active, a.severity]);
    expect(pend()).toEqual([[true, false, 'warning']]);
    net.f.online = true;                                       // the lease is back, the backend does not answer
    net.f.holdAlerts = true;
    first.kit.cc(902, 'RED', true);
    await first.time.run(5000);
    expect(net.open('/car/v1/alerts')).toHaveLength(1);        // the clearing and the raise, in flight
    expect(pend()).toEqual([[true, false, 'warning'], [false, true, 'critical']]);
    net.open('/car/v1/alerts').forEach((c) => c.reject(new UplinkError('timeout', 'test')));
    await flush();
    expect(first.app.inspect().queued.alerts).toBe(2);
    net.f.fail = 'timeout';
    await first.time.run(10_000);
    await park(first);
    first.app.persist();
    expect(pend()).toEqual([[true, false, 'warning'], [false, true, 'critical']]);
    first.app.stop();

    const second = await boot({ fs, net: fakeHttp(), time: fakeTime(first.time.clock.now() + 3_600_000) });
    await drive(second);
    await second.time.run(180_000);
    expect(alertPosts(second).map((a) => [a.id === raisedId, a.active, a.severity])).toEqual([
      [true, false, 'warning'],
      [false, true, 'critical'],
    ]);
  });

  test('a clearing written by the deferred tick while its own send is in flight survives that send failing', async () => {
    const fs = memFs();
    const net = fakeHttp();
    const first = await boot({ fs, net, state: pairedState() });
    await drive(first);
    await first.time.run(30_000);
    first.kit.cc(901, 'YELLOW', true);
    await first.time.run(5000);
    const raisedId = alertPosts(first)[0].id;                  // delivered
    first.kit.cc(901, 'YELLOW', false);                        // inside ALERT_SAVE_GAP_MS: its write waits for a tick
    await first.time.run(2000);
    net.f.holdAlerts = true;                                   // the link stays up, the backend stops answering
    await first.time.run(70_000);
    const pend = () => (((fs.saved() as { pendingAlerts?: Array<{ id: string; active: boolean }> }).pendingAlerts) || [])
      .map((a) => [a.id === raisedId, a.active]);
    expect(net.open('/car/v1/alerts')).toHaveLength(1);        // the clearing, in flight
    expect(pend()).toEqual([[true, false]]);
    net.open('/car/v1/alerts').forEach((c) => c.reject(new UplinkError('timeout', 'test')));
    net.f.fail = 'timeout';
    await first.time.run(5000);
    await park(first);
    first.app.persist();
    expect(pend()).toEqual([[true, false]]);
    first.app.stop();

    const second = await boot({ fs, net: fakeHttp(), time: fakeTime(first.time.clock.now() + 3_600_000) });
    await drive(second);
    await second.time.run(180_000);
    expect(alertPosts(second).map((a) => [a.id === raisedId, a.active])).toEqual([[true, false]]);
  });

  test('a raise whose send has not gone out is in the write that the raise makes at once', async () => {
    const fs = memFs();
    const net = fakeHttp();
    net.f.online = false;
    const first = await boot({ fs, net, state: pairedState() });
    await drive(first);
    first.kit.cc(901, 'RED', true);
    await first.time.run(5000);
    const saved = fs.saved() as { pendingAlerts?: Array<{ severity: string; active: boolean }> };
    expect((saved.pendingAlerts || []).map((a) => [a.severity, a.active])).toEqual([['critical', true]]);
    first.app.stop();                                          // killed: no persist()
    const second = await boot({ fs, time: fakeTime(first.time.clock.now() + 60_000) });
    await second.time.run(2000);
    expect(alertPosts(second).map((a) => [a.severity, a.active])).toEqual([['critical', true]]);
  });

  test('dialog turns from the backend are checked and their text is cut before they are kept or drawn', async () => {
    const net = fakeHttp();
    const s = await boot({ state: pairedState(), net, visible: true });
    const good: DialogTurn = { id: 't-1', at: START, question: 'Що з шинами?', answer: 'Тиск у нормі.', style: 'full', source: 'panel', model: 'm', snapshotAt: null };
    const bad = [
      { ...good, id: 't-2', answer: 42 },
      { ...good, id: 't-3', question: null },
      { ...good, id: 'x'.repeat(TURN_ID_MAX + 1) },
      { ...good, id: '' },
    ];
    for (const turn of bad) {
      s.net.open('/car/v1/dialog')[0].resolve({ turns: [turn] });
      await flush();
      expect(s.app.inspect().screen.lastTurn).toBeNull();
      await s.kit.frame();                                     // drawing still works
      await s.time.run(60_000);                                // a refused reply backs off (5, 10, 20, 40 s) before the next poll
    }
    const long = { ...good, question: 'п'.repeat(50_000), answer: 'а'.repeat(1_000_000) };
    s.net.open('/car/v1/dialog')[0].resolve({ turns: [long] });
    await flush();
    const kept = s.app.inspect().screen.lastTurn!;
    expect(kept.id).toBe('t-1');
    expect(kept.answer.length).toBe(TURN_TEXT_MAX);
    expect(kept.question.length).toBe(TURN_TEXT_MAX);

    // the same for the answer to a question asked here
    const chips = await s.kit.frame();
    chips.get('chip:0')!();
    await flush();
    s.net.open('/car/v1/ask')[0].resolve({ turn: { ...good, id: 't-5', answer: 'б'.repeat(10_000) } });
    await flush();
    expect(s.app.inspect().screen.lastTurn!.answer.length).toBe(TURN_TEXT_MAX);
    chips.get('chip:0')!();
    await flush();
    s.net.open('/car/v1/ask')[0].resolve({ turn: { ...good, id: 't-6', answer: { text: 'x' } } });
    await flush();
    expect(s.app.inspect().screen.lastTurn!.id).toBe('t-5');
    expect(s.app.inspect().screen.pending).toBe(false);
  });

  test('a poll answered at once with a refused newest turn is not re-issued at once: it backs off', async () => {
    const net = fakeHttp();
    const good: DialogTurn = { id: 't-1', at: START, question: 'Що з шинами?', answer: 'Тиск у нормі.', style: 'full', source: 'panel', model: 'm', snapshotAt: null };
    net.f.dialogReply = [{ ...good, id: 't-2', answer: 42 } as unknown as DialogTurn];
    const s = await boot({ state: pairedState(), net, visible: true });
    await flush(20);
    expect(s.net.to('/car/v1/dialog')).toHaveLength(1);        // no time passed: no second poll
    expect(s.app.inspect().screen.lastTurn).toBeNull();
    // one poll per back-off step, the step doubling: 5 s, then 10 s, then 20 s
    await s.time.run(POLL_RETRY_MS);
    expect(s.net.to('/car/v1/dialog')).toHaveLength(2);
    await s.time.run(2 * POLL_RETRY_MS - 1);
    expect(s.net.to('/car/v1/dialog')).toHaveLength(2);
    await s.time.run(1);
    expect(s.net.to('/car/v1/dialog')).toHaveLength(3);
    await s.time.run(4 * 60_000);                              // polls at 35, 75, 155 s: not one every 5 s
    expect(s.net.to('/car/v1/dialog').length).toBeLessThanOrEqual(6);
    expect(s.time.pending().every((t) => t.ms <= RETRY_MAX_MS)).toBe(true);
    expect(s.kit.lines.filter((l) => l.indexOf('newest turn from the backend was refused') >= 0)).toHaveLength(1);
    // a good turn is taken and the poll goes on at once (a held long-poll)
    net.f.dialogReply = null;
    await s.time.run(6 * 60_000);                              // the step then waiting (320 s) runs out; the car stays awake
    const open = s.net.open('/car/v1/dialog');
    expect(open).toHaveLength(1);
    open[0].resolve({ turns: [good] });
    await flush();
    expect(s.app.inspect().screen.lastTurn!.id).toBe('t-1');
    expect(s.net.open('/car/v1/dialog')).toHaveLength(1);
    s.app.stop();
  });

  test('a question the server could not answer reads as refused, one the network could not carry as no connection', async () => {
    const s = await boot({ state: pairedState(), visible: true });
    const targets = await s.kit.frame();
    const cases: Array<[UplinkErrorKind, string]> = [['server-error', TEXT_REFUSED], ['dns', TEXT_NO_SERVER], ['tls', TEXT_NO_SERVER], ['unauthorized', TEXT_REFUSED]];
    for (const [kind, line] of cases) {
      targets.get('chip:0')!();
      await flush();
      s.net.open('/car/v1/ask').forEach((c) => c.reject(new UplinkError(kind, 'test')));
      await flush();
      expect(s.app.inspect().screen.error).toBe(line);
    }
  });
});
