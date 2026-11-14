'use strict';
/**
 * fonts.js - loads the pre-baked glyph atlases (kit/runtime/fonts/*.json,
 * made by kit/tools/bake_fonts.py) and picks the best size for a request.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, 'fonts');
const families = Object.create(null);

function family(name) {
    if (families[name] !== undefined) return families[name];
    let fam = null;
    try {
        const j = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
        fam = j.sizes.map((s) => ({
            size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
            glyphs: s.glyphs, _alpha: s.alpha, alpha: null, family: name, cacheKey: j.cacheKey || '',
        }));
    } catch (e) { fam = null; }
    families[name] = fam;
    return fam;
}

// [car/kit local edit 5] Text with Cyrillic, the numero sign, the modifier apostrophe or the placeholder
// (U+25A1, \u25a1) goes to the Ukrainian atlas (cyrillic-uk.json, baked by kit/tools/bake_ukrainian.py: the Latin of the kit's
// atlases as well, so a mixed string is drawn whole); without that file, to 'cyrillic' as upstream.
const UK = 'cyrillic-uk';
const UK_TEXT = /[\u0400-\u04ff\u02bc\u2116\u25a1]/;

/** Smallest baked size >= requested (downscaling looks better), else largest. */
function get(name, size, text) {
    // Shared supplemental atlases avoid duplicating glyphs in every numeric size.
    if (text && /[\u3000-\u9fff\uff00-\uffef]/.test(text)) name = 'cjk';
    else if (text && UK_TEXT.test(text)) name = family(UK) ? UK : 'cyrillic';
    const fam = family(name) || family('label');
    if (!fam) return null;
    let best = null;
    for (const f of fam) if (f.size >= size && (!best || f.size < best.size)) best = f;
    if (!best) best = fam[fam.length - 1];
    if (!best.alpha) best.alpha = zlib.inflateSync(Buffer.from(best._alpha, 'base64'));
    return best;
}

function measure(f, s) {
    let w = 0;
    for (const ch of s) { const g = f.glyphs[ch.codePointAt(0)]; if (g) w += g[6]; }   // (no glyph: dropped, as drawn)
    return w;
}

/**
 * [car/kit local edit 5] Whether code point cp can be drawn: the Ukrainian atlas has it (else, without that
 * atlas, the Latin 'label' one). The app draws □ for a character that cannot (car/src/ui/theme.ts fitText),
 * since drawing drops a missing glyph silently.
 */
function has(cp) {
    const fam = family(UK) || family('label');
    return !!(fam && fam[0] && fam[0].glyphs[cp]);
}

module.exports = { get, measure, has };
