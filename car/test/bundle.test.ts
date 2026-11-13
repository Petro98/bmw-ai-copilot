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

// The frame the shipped app draws is rendered by `npm run check:car` (car/preview/*.png); glyph coverage of the
// Ukrainian atlas is asserted in car/test/atlas.test.ts and car/test/package.test.ts.

test('mgu-repo.json builds car/apps with the vendored kit and never requires the controller gate', () => {
  const repo = JSON.parse(readFileSync(join(repoDir, 'mgu-repo.json'), 'utf8'));
  expect(repo.apps.path).toBe('car/apps/*');
  expect(repo.apps.build.python).toBe('car/kit/tools/build.py');
  expect(repo.apps.mguHmi).toEqual(['ID7']);
  expect(JSON.stringify(repo)).not.toContain('mgu-inputgate');
});
