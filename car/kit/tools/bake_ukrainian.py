#!/usr/bin/env python3
"""Bake the Ukrainian glyph atlas from the Ubuntu font (Pillow required).

  python3 car/kit/tools/bake_ukrainian.py path/to/Ubuntu-Regular.ttf

Written for this project (Plan 2 Task 8) from the kit's bake_cyrillic.py and bake_fonts.py (MIT, see
car/kit/VENDORED.md) as templates. Output: car/kit/localization/fonts/cyrillic-uk.json, the atlas the
kit's fonts.js picks for any text with Cyrillic in it (local edit 5), in bake_fonts.py's format:
{"family", "source", "cacheKey", "sizes": [{size, ascent, descent, atlasW, atlasH, alpha: base64(zlib(8-bit
alpha)), glyphs: {code point: [x, y, w, h, ox, oy, advance]}}]}.

The characters: the Latin of the kit's own atlases (bake_fonts.TEXT, so a mixed string looks the same as a
Latin one), the Cyrillic block U+0400-U+045F with Ґ ґ (every Ukrainian letter, and the letters of a Check
Control text in another Cyrillic language), the apostrophes ʼ ’, № « », and □ - the placeholder the screens
draw for a character no atlas has (car/src/ui/theme.ts fitText). □ is not in the Ubuntu font: it is drawn
here as an outlined square. A character the font lacks is left out, never baked as the font's .notdef box,
and a missing Ukrainian letter stops the bake.

The generated atlas is committed; normal builds need neither Pillow nor the font. The font's licence (Ubuntu
Font Licence 1.0) is kept next to the atlas: car/kit/localization/fonts/UFL-Ubuntu.txt.
"""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import zlib

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
KIT = HERE.parent
OUT = KIT / 'localization' / 'fonts' / 'cyrillic-uk.json'

# Sizes, chosen for the screens' text (car/src/ui/theme.ts: 18 to 44 logical px) times the renderer's scale
# (up to 1.2, car/kit/runtime/display.js _place): fonts.js takes the smallest baked size at or above a
# request (it scales down), so 18 x 1.2 = 21.6 -> 22 and 44 x 1.2 = 52.8 -> 54.
SIZES = (22, 30, 40, 54)
# bake_cyrillic.py's limit: an atlas taller than this does not fit the renderer's reserved texture budget
MAX_ATLAS_H = 2048
ATLAS_W = 1024

UKRAINIAN = 'АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯабвгґдеєжзиіїйклмнопрстуфхцчшщьюя'
CYRILLIC = ''.join(chr(c) for c in range(0x0400, 0x0460)) + 'Ґґ'
SIGNS = 'ʼ’№«»'
PLACEHOLDER = '□'


def kit_text():
    """bake_fonts.TEXT, read from the kit's tool without running its main()."""
    spec = importlib.util.spec_from_file_location('bake_fonts', HERE / 'bake_fonts.py')
    baker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baker)
    return baker.TEXT


def notdef_of(font):
    """The bitmap the font draws for a code point it has no glyph for."""
    m = font.getmask('\U0010fffd')
    return (m.size, bytes(m))


def glyph_image(font, ch):
    """(image or None, bbox relative to the baseline, advance) of one character."""
    bbox = font.getbbox(ch, anchor='ls')
    adv = font.getlength(ch)
    w, h = max(0, bbox[2] - bbox[0]), max(0, bbox[3] - bbox[1])
    if not (w and h):
        return None, bbox, adv
    im = Image.new('L', (w, h), 0)
    ImageDraw.Draw(im).text((-bbox[0], -bbox[1]), ch, font=font, fill=255, anchor='ls')
    return im, bbox, adv


def placeholder_image(size):
    """□: an outlined square on the baseline, as tall as a capital letter."""
    side = round(size * 0.62)
    stroke = max(2, round(size / 14))
    im = Image.new('L', (side, side), 0)
    ImageDraw.Draw(im).rectangle([0, 0, side - 1, side - 1], outline=255, width=stroke)
    left = round(size * 0.08)
    return im, (left, -side, left + side, 0), round(size * 0.78, 2)


def bake(font_path, size, chars, notdef_check):
    font = ImageFont.truetype(str(font_path), size)
    ascent, descent = font.getmetrics()
    notdef = notdef_of(font)
    imgs, missing = [], []
    for ch in dict.fromkeys(chars):
        if ch == PLACEHOLDER:
            imgs.append((ch,) + placeholder_image(size))
            continue
        if notdef_check and ch.strip():
            m = font.getmask(ch)
            if (m.size, bytes(m)) == notdef:
                missing.append(ch)
                continue
        imgs.append((ch,) + glyph_image(font, ch))
    # shelf-pack, as bake_fonts.py does
    x = y = rowh = 0
    place = {}
    for ch, im, bbox, adv in imgs:
        if im is None:
            place[ch] = (0, 0, 0, 0)
            continue
        if x + im.width > ATLAS_W:
            x, y, rowh = 0, y + rowh + 1, 0
        place[ch] = (x, y, im.width, im.height)
        x += im.width + 1
        rowh = max(rowh, im.height)
    height = y + rowh + 1
    atlas = Image.new('L', (ATLAS_W, height), 0)
    glyphs = {}
    for ch, im, bbox, adv in imgs:
        px, py, pw, ph = place[ch]
        if im is not None:
            atlas.paste(im, (px, py))
        glyphs[ord(ch)] = [px, py, pw, ph, bbox[0], bbox[1], round(adv, 2)]
    return {'size': size, 'ascent': ascent, 'descent': descent, 'atlasW': ATLAS_W, 'atlasH': height,
            'alpha': base64.b64encode(zlib.compress(atlas.tobytes(), 9)).decode(), 'glyphs': glyphs}, missing


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: bake_ukrainian.py path/to/Ubuntu-Regular.ttf')
    font = Path(sys.argv[1]).resolve()
    if not font.is_file():
        raise SystemExit('Ubuntu font not found: ' + str(font))
    chars = ''.join(dict.fromkeys(kit_text() + CYRILLIC + UKRAINIAN + SIGNS + "'" + PLACEHOLDER))
    sizes, missing = [], set()
    for size in SIZES:
        atlas, miss = bake(font, size, chars, True)
        if atlas['atlasH'] > MAX_ATLAS_H:
            raise SystemExit('size %d: the atlas is %d px tall, over the kit\'s %d' % (size, atlas['atlasH'], MAX_ATLAS_H))
        sizes.append(atlas)
        missing.update(miss)
    lost = [ch for ch in UKRAINIAN + SIGNS + "'" if ch in missing]
    if lost:
        raise SystemExit('the font has no glyph for: ' + ' '.join(lost))
    cache_key = hashlib.sha256(json.dumps(sizes, separators=(',', ':')).encode()).hexdigest()[:16]
    data = {'family': 'cyrillic-uk', 'source': font.name + ' (Ubuntu Font Licence 1.0)', 'cacheKey': cache_key, 'sizes': sizes}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print('cyrillic-uk: %d characters, sizes %s, atlas heights %s, %d bytes' % (
        len(sizes[0]['glyphs']), list(SIZES), [s['atlasH'] for s in sizes], OUT.stat().st_size))
    if missing:
        print('  not in the font (left out, drawn as the placeholder): ' + ' '.join('U+%04X' % ord(c) for c in sorted(missing)))


if __name__ == '__main__':
    main()
