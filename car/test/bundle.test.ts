import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// Paths are resolved from this file, so the test runs the same from the repository root or from car/.
const carDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = join(carDir, '..');
const bundlePath = join(carDir, 'apps', 'p98_copilot', 'main.js');

function bundle(): string {
  return readFileSync(bundlePath, 'utf8');
}

function appJson(): Record<string, unknown> & { signals: unknown } {
  return JSON.parse(readFileSync(join(carDir, 'apps', 'p98_copilot', 'app.json'), 'utf8'));
}

/** Every TypeScript file under car/src that ships in the bundle (tests excluded), concatenated. */
function ourCode(): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path);
    }
  };
  walk(join(carDir, 'src'));
  expect(files.length).toBeGreaterThan(0);
  return files.map((f) => readFileSync(f, 'utf8')).join('\n');
}

test('the bundle is one CommonJS file with no ES2018+ syntax markers', () => {
  const src = bundle();
  expect(src).not.toMatch(/\?\.|\?\?|\bimport\s*\(|\basync\s*\*|\.\.\.\s*\w+\s*}\s*=/); // optional chaining, nullish, dynamic import, async generators, object rest
  expect(src).toMatch(/^\/\* generated from car\/src/);
  expect(src).not.toMatch(/^\s*(import|export)\s/m);
});

test('the bundle loads the kit as the kit apps do and nothing else from disk', () => {
  const src = bundle();
  expect(src).toMatch(/require\("\.\/kit\/mgu"\)/);
  const pattern = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = pattern.exec(src); m !== null; m = pattern.exec(src)) expect(m[1]).toMatch(/^(\.\/kit\/[a-z0-9_-]+|[a-z_]+)$/);
});

test('the bundle and app.json contain none of the forbidden references', () => {
  for (const needle of ['process.exit', 'signals.set', '.set(', 'WakeUpOnDemand', 'WodControl', 'RegisterShutdownClient'])
    expect(ourCode()).not.toContain(needle); // ourCode(): car/src/**/*.ts only
  // the kit's flags: r = read (getter), s = subscribe, w = write (car/kit/runtime/signals.js, set())
  expect(JSON.stringify(appJson().signals)).not.toMatch(/"[rs]*w[rs]*"/);
});

test('app.json is the autostart, read-only Copilot app the plan describes', () => {
  const app = appJson();
  expect(app).toMatchObject({
    id: 'p98_copilot',
    title: 'Copilot',
    loggingId: 'OAPC',
    startType: 'autostart',
    mguInternet: true,
    mguHmi: ['ID7'],
    memoryKB: 131072,
    cpuLimit: 30,
    screens: [{ name: 'MAIN', kind: 'canvas' }],
    popups: [{ name: 'ALERT_POP', type: 'popUp', widget: 'LT_State_PopupSmall', label: 'text3', button: 'OK' }],
  });
  expect((app.screens as unknown[]).length).toBe(1);
  expect((app.popups as unknown[]).length).toBe(1);
});

/** The text calls one shell frame makes, with the bundle run against a stand-in for the kit's mgu.run. */
async function shellTexts(): Promise<Array<{ str: string; size: number; font: string }>> {
  const texts: Array<{ str: string; size: number; font: string }> = [];
  let frame: (() => unknown) | undefined;
  const log = { error() {}, warn() {}, info() {}, debug() {} };
  const canvas = {
    clear() { return canvas; },
    text(str: string, _x: number, _y: number, size: number, _c: unknown, opts?: { font?: string }) {
      texts.push({ str, size, font: (opts && opts.font) || 'label' });
      return 0;
    },
  };
  const ctx = {
    log,
    canvas: () => canvas,
    ui: { onVisible() {}, image: () => Promise.resolve() },
    onLayout() {},
    loop(_name: string, _fps: number, fn: () => unknown) { frame = fn; return { stop() {}, kick() {} }; },
  };
  const mgu = { log, run: (app: { start(c: unknown): unknown }) => Promise.resolve(app.start(ctx)) };
  const fakeRequire = (id: string): unknown => {
    if (id === './kit/mgu') return mgu;
    throw new Error('unexpected require ' + id);
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', bundle())(fakeRequire, mod, mod.exports);
  await new Promise((resolve) => setImmediate(resolve));
  expect(frame).toBeDefined();
  await frame!();
  return texts;
}

test('the shell word is drawn whole at every text scale the kit renders at', async () => {
  // car/kit/runtime/record.js text(): the atlas is fonts.get(family, size * textScale, text). textScale is
  // 1 on the software path and the renderer's place.scale otherwise (car/kit/runtime/display.js canvas()):
  // full layout floor(min((1920 - 84) / 1576, (720 - 80 - bar) / 482) * 1000) / 1000 = 1.164 (bar 0 or 48),
  // "fill" 1920 / 1600 = 1.2 (display.js _place, HMI, FULL).
  const fonts = createRequire(import.meta.url)(join(carDir, 'kit', 'runtime', 'fonts.js')) as {
    get(family: string, size: number, text: string): { size: number; glyphs: Record<string, unknown> } | null;
  };
  const texts = await shellTexts();
  expect(texts.map((t) => t.str)).toContain('Copilot');
  for (const { str, size, font } of texts) {
    for (const scale of [1, 1.164, 1.2]) {
      const atlas = fonts.get(font, size * scale, str);
      expect(atlas, `${font} ${size} px x ${scale}`).not.toBeNull();
      const missing = [...str].filter((ch) => !atlas!.glyphs[ch.codePointAt(0)!]);
      expect(missing, `${font} ${size} px x ${scale} -> atlas ${atlas!.size} px`).toEqual([]);
    }
  }
});

test('mgu-repo.json builds car/apps with the vendored kit and never requires the controller gate', () => {
  const repo = JSON.parse(readFileSync(join(repoDir, 'mgu-repo.json'), 'utf8'));
  expect(repo.apps.path).toBe('car/apps/*');
  expect(repo.apps.build.python).toBe('car/kit/tools/build.py');
  expect(repo.apps.mguHmi).toEqual(['ID7']);
  expect(JSON.stringify(repo)).not.toContain('mgu-inputgate');
});
