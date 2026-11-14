import { readdirSync, readFileSync, statSync } from 'node:fs';
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

/** Every TypeScript file under the given directories (tests excluded), concatenated. */
function sources(dirs: string[]): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  expect(files.length).toBeGreaterThan(0);
  return files.map((f) => readFileSync(f, 'utf8')).join('\n');
}

/** Every TypeScript file under car/src that ships in the bundle (tests excluded), concatenated. */
function ourCode(): string {
  return sources([join(carDir, 'src')]);
}

/** The shared packages the bundle takes in (car/src imports them through tsconfig paths). */
function bundledPackages(): string {
  return sources(['vehicle-core', 'event-engine', 'shared'].map((p) => join(repoDir, 'packages', p, 'src')));
}

/** Names of the kit's write side, the head unit's power and shutdown control, and process control. */
const FORBIDDEN_NAMES = [
  'process.exit', 'child_process', 'signals.set', 'signals.call', 'signals.proxy', 'signals.on(', 'callMethod', 'setValue',
  'WakeUpOnDemand', 'WodControl', 'RegisterShutdownClient',
];
/** Indexed or cast access to the kit's signals object (`signals['set']`, `(ctx.signals as any).call(`, `(x.signals).proxy(`). */
const SIGNALS_ESCAPE = /\bsignals\s*\[|\bsignals\s+as\s+[^;]*?\)\s*\.\s*(set|call|proxy|on)\b|\bsignals\s*\)\s*\.\s*(set|call|proxy|on)\b|\[\s*["'`](set|call|proxy|callMethod|setValue)["'`]\s*\]/;

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
  const ours = ourCode();
  const packages = bundledPackages();
  const shipped = bundle();
  for (const needle of FORBIDDEN_NAMES) {
    expect(ours).not.toContain(needle);
    expect(packages).not.toContain(needle);
    expect(shipped).not.toContain(needle);
  }
  // no `.set(` at all in our own code (the packages and so the bundle use Map.prototype.set)
  expect(ours).not.toContain('.set(');
  for (const text of [ours, packages, shipped]) expect(text).not.toMatch(SIGNALS_ESCAPE);
  // the guard itself catches the indexed and cast forms
  for (const bad of ["ctx.signals['set'](x)", '(ctx.signals as any).call(m)', '(ctx.signals).proxy(i)', 'k["callMethod"]', 'signals[name]'])
    expect(bad).toMatch(SIGNALS_ESCAPE);

  // app.json: the kit's flags are r = read (getter), s = subscribe, w = write (car/kit/runtime/signals.js, set());
  // car/kit/tools/build.py also turns `_methods`, `_broadcasts` and a non-object interface entry ("*" = everything)
  // into manifest grants, so every interface is an object whose only underscore key is `_optional` (a note)
  const signals = appJson().signals as Record<string, unknown>;
  expect(typeof signals === 'object' && signals !== null && !Array.isArray(signals)).toBe(true);
  expect(Object.keys(signals).length).toBeGreaterThan(0);
  for (const iface of Object.keys(signals)) {
    const fields = signals[iface];
    expect(typeof fields === 'object' && fields !== null && !Array.isArray(fields), iface).toBe(true);
    for (const [field, flags] of Object.entries(fields as Record<string, unknown>)) {
      if (field.charAt(0) === '_') expect(field, iface).toBe('_optional');
      else expect(flags, iface + '.' + field).toMatch(/^(r|s|rs)$/);
    }
  }
});

test('the QR generator\'s MIT notice travels with the shipped bundle', () => {
  const src = bundle();
  expect(src).toMatch(/Copyright \(c\) Project Nayuki/);
  expect(src).toMatch(/Permission is hereby granted, free of charge/);
  expect(src).toMatch(/The above copyright notice and this permission notice shall be included in/);
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

// The frame the shipped app draws is rendered by `npm run check:car` (car/preview/*.png); glyph coverage of the
// Ukrainian atlas is asserted in car/test/atlas.test.ts and car/test/package.test.ts.

test('mgu-repo.json builds car/apps with the vendored kit and never requires the controller gate', () => {
  const repo = JSON.parse(readFileSync(join(repoDir, 'mgu-repo.json'), 'utf8'));
  expect(repo.apps.path).toBe('car/apps/*');
  expect(repo.apps.build.python).toBe('car/kit/tools/build.py');
  expect(repo.apps.mguHmi).toEqual(['ID7']);
  expect(JSON.stringify(repo)).not.toContain('mgu-inputgate');
});
