'use strict';

// Kit runtime (display.js, renderd.js, mgu.js Settings) against a stand-in mgu-render on a Unix socket: the
// unchanged-frame skip and its keepalive, a sheet that throws, X_STATE front flips, a reconnect after a cut
// message, the theme kept on a fresh install. No SDK, renderer or car needed:
//   node kit/tools/test_runtime.js

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-rt-'));
process.env.MGU_RENDERD_SOCKET = path.join(dir, 'render.sock');
['MGU_RENDERER', 'MGU_RENDERD_FILE', 'MGU_RENDERD_PROTO', 'MGU_NO_GRAB'].forEach((k) => delete process.env[k]);
const { Display } = require('../runtime/display');
const { RenderClient } = require('../runtime/renderd');
const themes = require('../runtime/themes');

const FRAME = 7, READY = 101, TICK = 102, TOUCH = 105, X_READY = 0x4d520101, X_STATE = 0x4d520102, X_CCU = 0x4d520103;
const GRAB = 10, X_GRAB = 0x4d520002;   // [car/kit local edit 7] renderd.js M.GRAB, X.GRAB
const uncaught = [];
process.on('uncaughtException', (e) => uncaught.push(e));     // (else node exits, as mgu.js does on the car)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u32 = (...a) => Buffer.from(new Uint32Array(a).buffer);
function msg(type, p) {
    const b = Buffer.alloc(8 + p.length + ((4 - (p.length & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4); p.copy(b, 8);
    return b;
}
async function waitFor(fn, ms) {
    for (const t0 = Date.now(); Date.now() - t0 < (ms || 2000); await sleep(10)) if (fn()) return true;
    return false;
}

// the renderer's side: the app's FRAMEs (time of each, a TICK back for each), READY on connect (onConn)
// [car/kit local edit 7] also every connection (conns) and the type of every message the app sent (types)
let onConn = null;
const conns = [];
const server = net.createServer((s) => {
    const c = { s, frames: [], types: [], buf: Buffer.alloc(0), send: (t, p) => s.write(msg(t, p)) };
    conns.push(c);
    s.on('data', (d) => {
        c.buf = Buffer.concat([c.buf, d]);
        while (c.buf.length >= 8) {
            const t = c.buf.readUInt32LE(0), n = c.buf.readUInt32LE(4);
            if (c.buf.length < 8 + n) break;
            c.buf = c.buf.slice(8 + n);
            c.types.push(t);
            if (t === FRAME) { c.frames.push(Date.now()); c.send(TICK, u32(c.frames.length, 0)); }
        }
    });
    s.on('error', () => {});
    onConn(c);
});
const ready = (c) => { c.send(X_READY, u32(1, 1, 7)); c.send(READY, u32(4, 1920, 720, 1)); };   // touch, controller, front gate
const ccu = (k, pb, df) => { const b = Buffer.alloc(5); b.writeUInt16BE(k, 1); b[3] = pb; b[4] = df; return b; };
const touch = (phase, x, y) => { const b = Buffer.alloc(12); b.writeUInt32LE(phase, 0); b.writeFloatLE(x, 4); b.writeFloatLE(y, 8); return b; };

/** A Display on the stand-in renderer, the kit running the screen (full-screen layout, touch), shown. */
async function setup() {
    let conn = null;
    onConn = (c) => { conn = c; ready(c); };
    const log = { errors: [], info() {}, warn() {}, debug() {}, error: (...a) => log.errors.push(a) };
    const vis = new Set(['MAIN']), visH = [];
    const ui = {
        rhmi: null, close() {}, visible() {}, onVisible: (fn) => visH.push(fn), isVisible: (n) => vis.has(n),
        setVisible: (v) => { if (v) vis.add('MAIN'); else vis.delete('MAIN'); visH.forEach((fn) => fn('MAIN', v)); },
    };
    const spec = { id: 'test', title: 'Test', screens: [{ name: 'MAIN', kind: 'canvas', buttons: [['BTN_SETTINGS', 'Settings']] }] };
    const d = new Display(ui, log, spec, { get: () => undefined, onChange() {} }, () => themes.theme());
    assert(await waitFor(() => conn && d.active() && d.own()), 'display on the renderer');
    return { d, ui, log, c: conn, end() { d.closeSheet(); d.gpu.close(); clearInterval(d.keepTimer); } };
}
/** The app draws its page (v: what changes) and hands it over, as ui.image does. */
function page(d, v) {
    const r = d.canvas(1600, 520);
    r.fillRect(100, 100, 400, 200, '#ff0000'); r.fillRect(0, 300, v, 10, '#00ff00');
    d.present('MAIN', r, () => Promise.resolve());
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('unchanged frames: not sent again, but one a second (the renderer hides an app quiet for 3 s)', async () => {
    const t = await setup(), c = t.c;
    try {
        const t0 = Date.now();
        while (Date.now() - t0 < 2500) { page(t.d, 10); await sleep(16); }
        const f = c.frames.slice(), gaps = f.slice(1).map((x, i) => x - f[i]).concat(Date.now() - f[f.length - 1]);
        console.log('  a static page at 60 fps for 2.5 s: ' + f.length + ' FRAMEs, longest gap ' + Math.max(...gaps) + ' ms');
        assert(f.length >= 2 && f.length <= 6, 'FRAMEs for a static page: ' + f.length);
        assert(Math.max(...gaps) < 1600, 'the longest time without a FRAME: ' + Math.max(...gaps) + ' ms');
        // a changed page: at once
        let n = c.frames.length;
        page(t.d, 20); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'a changed page');
        // the header changed (the knob turned onto a tab), the page did not: at once, and only once
        n = c.frames.length;
        c.send(X_CCU, ccu(0, 0, 0)); c.send(X_CCU, ccu(1, 0, 0)); await sleep(50);
        assert.strictEqual(t.d.focusTab, 0);
        assert.strictEqual(c.frames.length, n + 1, 'the header changed');
        page(t.d, 20); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'the same page with the same header');
        // shown again: the picture comes back once the HMI's page has opened (display.js SHOW_DELAY_MS, 350 ms),
        // then the same page goes out at once
        t.ui.setVisible(false); t.ui.setVisible(true);
        await sleep(450);
        n = c.frames.length;
        page(t.d, 20); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'shown again');
        // a sheet painted every 33 ms that does not change: its first frame, then the keepalive
        n = c.frames.length;
        assert(t.d.openSheet({ draw: (r) => { r.fillRect(0, 0, 50, 50, '#0000ff'); return []; }, move() {} }));
        await sleep(1500);
        console.log('  a static sheet for 1.5 s: ' + (c.frames.length - n) + ' FRAMEs');
        assert(c.frames.length - n >= 2 && c.frames.length - n <= 4, 'FRAMEs for a static sheet: ' + (c.frames.length - n));
        // closed: the page again, at once
        n = c.frames.length;
        t.d.closeSheet(); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'the sheet closed');
    } finally { t.end(); }
});

test('a sheet\'s press, back and touch target that throw: logged, the app runs on', async () => {
    const t = await setup(), c = t.c;
    try {
        page(t.d, 10);
        const boom = (w) => () => { throw new Error(w); };
        assert(t.d.openSheet({ draw: () => [{ x: 0, y: 0, w: 1600, h: 520, act: boom('act') }], move() {}, press: boom('press'), back: boom('back') }));
        const n = uncaught.length;
        c.send(X_CCU, ccu(0, 0, 0)); c.send(X_CCU, ccu(0, 1, 0));                      // press
        c.send(X_CCU, ccu(0, 0, 0)); c.send(X_CCU, ccu(0, 0, 10));                     // push left
        c.send(TOUCH, touch(1, 800, 300)); c.send(TOUCH, touch(3, 800, 300));          // a tap on the target
        await sleep(100);
        // (an uncaught exception ends the app on the car: mgu.js process.exit(1), and the platform wipes its data)
        assert.deepStrictEqual(uncaught.slice(n).map((e) => e.message), [], 'uncaught in the socket\'s data handler');
        assert.deepStrictEqual(t.log.errors.map((a) => a[0] + ' ' + a[1].message), ['sheet press', 'sheet back', 'sheet act']);
        assert(t.d.sheet, 'the sheet stays open');
    } finally { t.end(); }
});

test('not in front, then in front (not on screen yet) within 1.5 s: the app stays on the renderer', async () => {
    const t = await setup(), c = t.c;
    try {
        page(t.d, 10);
        c.send(X_STATE, u32(1, 0, 0)); await sleep(100);
        c.send(X_STATE, u32(1, 0, 1)); await sleep(1700);
        assert(!t.d.blocked, 'blocked though in front');
        assert(t.d.own());
        // not in front for good: blocked after 1.5 s
        c.send(X_STATE, u32(1, 0, 0)); await sleep(1700);
        assert.strictEqual(t.d.blocked, true, 'not in front for 1.5 s');
    } finally { t.end(); }
});

test('a connection cut in the middle of a message: the next connection\'s READY is read', async () => {
    let n = 0;
    onConn = (c) => {
        if (n++) { ready(c); return; }
        c.s.write(Buffer.concat([u32(TICK, 8), u32(1)]));                              // 4 of TICK's 8 bytes
        setTimeout(() => c.s.destroy(), 50);
    };
    const g = new RenderClient('test', { info() {}, warn() {}, error() {} }, { native: true });
    try {
        let readyN = 0;
        g.on('ready', () => readyN++);
        g.connect();
        await waitFor(() => readyN, 5000);
        assert.strictEqual(n, 2, 'connected again');
        assert.strictEqual(readyN, 1, 'READY after the reconnect');
        assert(g.native && g.info && g.info.touch, 'X_READY after the reconnect');
    } finally { g.close(); }
});

test('the one-time move to the new default theme: a theme picked on a fresh install stays', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
    const cls = src.match(/class Settings[\s\S]*?\n}\n/)[0];      // (as hu-stub.js: the real class without the SDK)
    const make = (sub) => {
        const dd = path.join(dir, sub);
        fs.mkdirSync(dd);
        return new Function('fs', 'path', 'DATA_DIR', 'log', cls + '\nreturn Settings;')(fs, path, dd, { warn() {}, error() {} });
    };
    const file = (sub) => path.join(dir, sub, 'settings.json');
    const schema = [{ key: 'theme', type: 'choice', default: 'm_tricolour', options: [] }, { key: 'units', type: 'choice', default: 'metric', options: [] }];
    // fresh install: no file until something is set; a theme set then stays
    let S = make('fresh');
    assert.strictEqual(new S(schema).get('theme'), 'm_tricolour');
    assert(!fs.existsSync(file('fresh')), 'a fresh start writes no file');
    new S(schema).set('theme', 'amber');
    assert.strictEqual(new S(schema).get('theme'), 'amber', 'theme picked on a fresh install, next start');
    // another setting set first, the theme later: stays too
    S = make('fresh2');
    new S(schema).set('units', 'imperial');
    new S(schema).set('theme', 'amber');
    assert.strictEqual(new S(schema).get('theme'), 'amber', 'theme picked after another setting, next start');
    // saved before the new default (no mark): moved to it once, the next choice stays
    S = make('old');
    fs.writeFileSync(file('old'), JSON.stringify({ theme: 'amber', units: 'imperial' }));
    const o = new S(schema);
    assert.strictEqual(o.get('theme'), 'm_tricolour', 'an old save moves to the new default');
    assert.strictEqual(o.get('units'), 'imperial');
    assert.strictEqual(JSON.parse(fs.readFileSync(file('old'), 'utf8'))._themeV, 2);
    o.set('theme', 'amber');
    assert.strictEqual(new S(schema).get('theme'), 'amber');
});

test('a new scale keeps the uploads (the renderer keeps them), a new size sends them again', async () => {
    const t = await setup(), g = t.d.gpu;
    try {
        const pl = Object.assign({}, g.placement);
        g.sent.atlas.add(1); g.sent.ramp.add(2); g.sent.image.set(3, 1); g.sent.layer.add(4);
        g.place(Object.assign({}, pl, { scale: pl.scale * 0.9 }));
        assert.deepStrictEqual([g.sent.atlas.has(1), g.sent.ramp.has(2), g.sent.image.has(3)], [true, true, true], 'a new scale sends everything again');
        assert(!g.sent.layer.has(4), 'layers drawn at the old scale');
        g.place(Object.assign({}, pl, { w: pl.w - 8 }));
        assert.deepStrictEqual([g.sent.atlas.size, g.sent.ramp.size, g.sent.image.size], [0, 0, 0], 'a new size');
    } finally { t.end(); }
});

/*
 * [car/kit local edits 7 and 9] Nothing of the display runs while the screen is hidden, the kit never takes the
 * controller on its own, and the kit's own strings on the screen are Ukrainian (car/kit/VENDORED.md).
 */
test('the keep-alive runs only while the screen shows and only with a renderer', async () => {
    const t = await setup(), c = t.c;
    try {
        page(t.d, 10);
        assert(t.d.keepTimer, 'a keep-alive while shown on the renderer');
        await sleep(100);                               // (that FRAME reaches the stand-in renderer)
        t.ui.setVisible(false);
        assert.strictEqual(t.d.keepTimer, null, 'the keep-alive stops when the screen is hidden');
        const n = c.frames.length;
        page(t.d, 20);                                  // a frame handed over while hidden: kept, not kept alive
        await sleep(1600);
        assert.strictEqual(t.d.keepTimer, null, 'a keep-alive started while hidden');
        assert.strictEqual(c.frames.length, n, 'FRAMEs while hidden: ' + (c.frames.length - n));
    } finally { t.end(); }
    // the software path (the 'renderer' setting): no renderer, so no keep-alive at all
    const log = { info() {}, warn() {}, debug() {}, error() {} };
    const ui = { rhmi: null, close() {}, visible() {}, onVisible() {}, isVisible: (name) => name === 'MAIN' };
    const spec = { id: 'test', title: 'Test', screens: [{ name: 'MAIN', kind: 'canvas', buttons: [] }] };
    const d = new Display(ui, log, spec, { get: (k) => (k === 'renderer' ? 'software' : undefined), onChange() {} }, () => themes.theme());
    try {
        assert.strictEqual(d.gpu || null, null, 'a renderer client on the software path');
        page(d, 10); page(d, 20);
        assert.strictEqual(d.keepTimer || null, null, 'a keep-alive without a renderer');
    } finally { clearInterval(d.keepTimer); }
});

test('a short hide and show: the keep-alive goes on with the app\'s unchanged first frame', async () => {
    const t = await setup(), c = t.c;
    try {
        page(t.d, 10); await sleep(100); page(t.d, 20); await sleep(100);
        t.ui.setVisible(false); await sleep(50); t.ui.setVisible(true);
        assert(t.d.keepTimer, 'the keep-alive starts again when the screen shows with a frame to keep');
        page(t.d, 20);                                  // the app's one redraw after showing: identical, not sent
        const n = c.frames.length;
        await sleep(3200);
        assert(c.frames.length - n >= 2, 'keep-alive FRAMEs in 3.2 s after showing again: ' + (c.frames.length - n));
    } finally { t.end(); }
});

test('the kit never takes the iDrive controller on its own; an app that asks still gets it', async () => {
    const t = await setup(), c = t.c;
    try {
        page(t.d, 10);
        await sleep(700);                               // (renderd.js re-sends a held grab every 500 ms)
        assert.strictEqual(!!t.d.gpu.grabbing, false, 'the kit holds the controller');
        assert.strictEqual(t.d.gpu.grabTimer || null, null, 'a grab re-send timer');
        assert.strictEqual(c.types.filter((x) => x === X_GRAB || x === GRAB).length, 0, 'GRAB messages sent');
        t.d.grab(true);
        assert.strictEqual(!!t.d.gpu.grabbing, true, 'ctx.controller.grab(true)');
        t.d.grab(false);
        assert.strictEqual(t.d.gpu.grabTimer || null, null, 'released at once');
    } finally { t.end(); }
});

test('no renderer reconnect attempts while the screen is hidden; it looks again when shown', async () => {
    // lost while hidden
    let t = await setup();
    try {
        page(t.d, 10);
        t.ui.setVisible(false);
        const before = conns.length;
        t.c.s.destroy();                                // the renderer goes away while the screen is hidden
        await sleep(3600);                              // (renderd.js retries every 3 s)
        assert.strictEqual(conns.length, before, 'connections while hidden: ' + (conns.length - before));
        assert.strictEqual(t.d.gpu, null, 'a renderer client kept while hidden');
        t.ui.setVisible(true);
        assert(await waitFor(() => t.d.gpu && t.d.gpu.ready, 4000), 'the renderer again after showing');
    } finally { t.end(); }
    // not reachable while shown (retried), then hidden: the retries stop
    t = await setup();
    try {
        page(t.d, 10);
        onConn = (c) => c.s.destroy();                  // a renderer that drops every connection at once
        t.c.s.destroy();
        await sleep(3500);
        t.ui.setVisible(false);
        const before = conns.length;
        await sleep(3600);
        assert.strictEqual(conns.length, before, 'connections while hidden: ' + (conns.length - before));
        assert.strictEqual(t.d.gpu, null, 'a renderer client kept while hidden');
        onConn = (c) => ready(c);
        t.ui.setVisible(true);
        assert(await waitFor(() => t.d.gpu && t.d.gpu.ready, 6000), 'the renderer again after showing');
    } finally { t.end(); }
    // an autostart app starts hidden: no renderer client until the screen shows
    const vis = new Set(), visH = [];
    const ui = { rhmi: null, close() {}, visible() {}, onVisible: (fn) => visH.push(fn), isVisible: (n) => vis.has(n) };
    const spec = { id: 'test', title: 'Test', screens: [{ name: 'MAIN', kind: 'canvas', buttons: [] }] };
    const before = conns.length;
    const d = new Display(ui, { info() {}, warn() {}, debug() {}, error() {} }, spec, { get: () => undefined, onChange() {} }, () => themes.theme());
    try {
        await sleep(300);
        assert.strictEqual(d.gpu || null, null, 'a renderer client while hidden from the start');
        assert.strictEqual(conns.length, before, 'connections while hidden from the start');
        onConn = (c) => ready(c);
        vis.add('MAIN'); visH.forEach((fn) => fn('MAIN', true));
        assert(await waitFor(() => d.gpu && d.gpu.ready, 4000), 'the renderer once shown');
    } finally { if (d.gpu) d.gpu.close(); clearInterval(d.keepTimer); }
});

test('the kit\'s own strings on the screen are Ukrainian: the Settings tab and a switch\'s value', async () => {
    const t = await setup();
    try {
        const tl = t.d._tabList();
        assert(tl.settings >= 0, 'a Settings tab where the kit runs the screen');
        assert.strictEqual(tl.tabs[tl.settings], 'Налаштування');
    } finally { t.end(); }
    const src = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
    const cls = src.match(/class Settings[\s\S]*?\n}\n/)[0];      // (as hu-stub.js: the real class without the SDK)
    const dd = path.join(dir, 'uk');
    fs.mkdirSync(dd);
    const S = new Function('fs', 'path', 'DATA_DIR', 'log', cls + '\nreturn Settings;')(fs, path, dd, { warn() {}, error() {} });
    const s = new S([{ key: 'popups', type: 'bool', default: true }]);
    assert.strictEqual(s.display('popups'), 'Увімкнено');
    s.set('popups', false);
    assert.strictEqual(s.display('popups'), 'Вимкнено');
});

(async () => {
    await new Promise((r) => server.listen(process.env.MGU_RENDERD_SOCKET, r));
    let failed = 0;
    for (const [name, fn] of cases) {
        try { await fn(); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
    }
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(failed ? failed + ' of ' + cases.length + ' failed' : 'runtime: all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
