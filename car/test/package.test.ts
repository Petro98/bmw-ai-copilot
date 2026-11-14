import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';

/**
 * The package the kit's build stages (car/kit/tools/build.py, local edit 8 in car/kit/VENDORED.md): the
 * Ukrainian glyph atlas must travel in every build, where the kit's fonts.js reads it (kit/fonts/ next to
 * kit/fonts.js), or every Cyrillic string on the car is drawn blank. The build writes only under car/dist/
 * (it replaces car/dist/p98_copilot itself); this test removes nothing.
 */
const repo = (path: string) => fileURLToPath(new URL('../../' + path, import.meta.url));

const APP_ID = 'p98_copilot';
const KIT_JS = repo(`car/dist/${APP_ID}/source/javascript/kit`);
const UK_ATLAS = 'car/kit/localization/fonts/cyrillic-uk.json';
const UK_NOTICE = 'car/kit/localization/fonts/UFL-Ubuntu.txt';

describe('staged package', () => {
  beforeAll(() => {
    // -I: isolated mode, as car/scripts/preview-car.sh runs it; no BMW SDK needed for --preview-only
    execFileSync('python3', ['-I', repo('car/kit/tools/build.py'), '--preview-only', APP_ID], {
      cwd: repo(''),
      stdio: 'pipe',
    });
  }, 60_000);

  test('the Ukrainian atlas and its licence notice are in the package\'s kit/fonts/', () => {
    const atlas = `${KIT_JS}/fonts/cyrillic-uk.json`;
    const notice = `${KIT_JS}/fonts/UFL-Ubuntu.txt`;
    expect(existsSync(atlas)).toBe(true);
    expect(existsSync(notice)).toBe(true);
    expect(readFileSync(atlas).equals(readFileSync(repo(UK_ATLAS)))).toBe(true);
    expect(readFileSync(notice).equals(readFileSync(repo(UK_NOTICE)))).toBe(true);
  });

  test('the staged kit\'s fonts module draws Cyrillic and the placeholder from that atlas', () => {
    const fonts = createRequire(import.meta.url)(`${KIT_JS}/fonts.js`) as {
      get(name: string, size: number, text: string): { family: string; size: number } | null;
      has(cp: number): boolean;
    };
    expect(fonts.has('Ї'.codePointAt(0)!)).toBe(true);
    expect(fonts.has(0x25a1)).toBe(true);      // □, drawn for a character no atlas has
    expect(fonts.get('label', 24, 'Налаштування')?.family).toBe('cyrillic-uk');
  });
});
