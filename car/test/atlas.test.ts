import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The Ukrainian glyph atlas (car/kit/tools/bake_ukrainian.py) and the kit's routing to it
 * (car/kit/runtime/fonts.js, local edit 5 in car/kit/VENDORED.md).
 */
const repo = (path: string) => fileURLToPath(new URL('../../' + path, import.meta.url));

interface AtlasSize { size: number; atlasW: number; atlasH: number; glyphs: Record<string, number[]> }
interface Atlas { family: string; source: string; cacheKey: string; sizes: AtlasSize[] }

function atlas(path: string): Atlas {
  return JSON.parse(readFileSync(repo(path), 'utf8')) as Atlas;
}

/** Every character every baked size of the atlas has a glyph for. */
function glyphSet(path: string): Set<string> {
  const sizes = atlas(path).sizes;
  const sets = sizes.map((s) => new Set(Object.keys(s.glyphs).map((cp) => String.fromCodePoint(Number(cp)))));
  return new Set([...sets[0]].filter((ch) => sets.every((set) => set.has(ch))));
}

const UK_ATLAS = 'car/kit/localization/fonts/cyrillic-uk.json';

describe('Ukrainian atlas', () => {
  test('the baked atlas contains every Ukrainian letter and the apostrophe', () => {
    const have = glyphSet(UK_ATLAS);
    for (const ch of 'АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯабвгґдеєжзиіїйклмнопрстуфхцчшщьюя\'') expect(have.has(ch)).toBe(true);
  });

  test('it also has the signs the screens use, the Latin of the kit\'s atlas and the placeholder □', () => {
    const have = glyphSet(UK_ATLAS);
    for (const ch of '№«»ʼ’°·—…%,.:/□') expect(have.has(ch), ch).toBe(true);
    for (let cp = 0x20; cp < 0x7f; cp++) expect(have.has(String.fromCodePoint(cp)), 'U+' + cp.toString(16)).toBe(true);
  });

  test('every size stays within the kit\'s atlas height limit and is one family', () => {
    const a = atlas(UK_ATLAS);
    expect(a.family).toBe('cyrillic-uk');
    expect(a.source).toMatch(/Ubuntu Font Licence/);
    expect(a.cacheKey).toMatch(/^[0-9a-f]{16}$/);
    expect(a.sizes.length).toBeGreaterThan(0);
    for (const s of a.sizes) {
      expect(s.atlasW).toBe(1024);
      expect(s.atlasH).toBeLessThanOrEqual(2048);
    }
  });

  test('the Ubuntu Font Licence travels next to the atlas', () => {
    const notice = readFileSync(repo('car/kit/localization/fonts/UFL-Ubuntu.txt'), 'utf8');
    expect(notice).toMatch(/UBUNTU FONT LICENCE Version 1\.0/);
  });

  test('the kit routes Cyrillic, the numero sign and the placeholder to the Ukrainian atlas', () => {
    // the kit's fonts.js as it sits in a package: kit/fonts.js beside kit/fonts/<family>.json
    const dir = mkdtempSync(join(tmpdir(), 'copilot-fonts-'));
    try {
      mkdirSync(join(dir, 'fonts'));
      copyFileSync(repo('car/kit/runtime/fonts.js'), join(dir, 'fonts.js'));
      copyFileSync(repo('car/kit/runtime/fonts/label.json'), join(dir, 'fonts', 'label.json'));
      copyFileSync(repo(UK_ATLAS), join(dir, 'fonts', 'cyrillic-uk.json'));
      const fonts = createRequire(import.meta.url)(join(dir, 'fonts.js')) as {
        get(name: string, size: number, text: string): { family: string; size: number } | null;
        has(cp: number): boolean;
      };
      expect(fonts.get('label', 24, 'Copilot')?.family).toBe('label');
      expect(fonts.get('label', 24, 'Пам\'ять помилок')?.family).toBe('cyrillic-uk');
      expect(fonts.get('bold', 18, 'ҐАНОК')?.family).toBe('cyrillic-uk');
      expect(fonts.get('light', 72, '№ 5')?.family).toBe('cyrillic-uk');
      expect(fonts.get('label', 24, '□ 5')?.family).toBe('cyrillic-uk');
      expect(fonts.has(0x0491)).toBe(true);      // ґ
      expect(fonts.has(0x25a1)).toBe(true);      // □
      expect(fonts.has(0x1f6de)).toBe(false);    // an emoji: drawn as □ by the screens (theme.ts fitText)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
