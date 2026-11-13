/**
 * Ukrainian → Latin for the pop-up's ASCII fallback (the owner turns it on when the head unit's pop-up
 * widget cannot draw Cyrillic; car check B11 in docs/CAR_CHECKLIST.md). The table is Ukraine's official
 * romanisation (Cabinet of Ministers resolution No. 55 of 27 January 2010): є ї й ю я are Ye Yi Y Yu Ya at
 * the start of a word and ie i i iu ia inside it, «зг» is «zgh», the soft sign and the apostrophe are dropped.
 * A few typographic characters become their ASCII look-alikes; anything else outside printable ASCII is
 * dropped, and the spaces left behind are collapsed.
 */

/** Lower-case letters: [inside a word, at the start of a word]. */
const LETTERS: Record<string, [string, string]> = {
  'а': ['a', 'a'], 'б': ['b', 'b'], 'в': ['v', 'v'], 'г': ['h', 'h'], 'ґ': ['g', 'g'], 'д': ['d', 'd'],
  'е': ['e', 'e'], 'є': ['ie', 'ye'], 'ж': ['zh', 'zh'], 'з': ['z', 'z'], 'и': ['y', 'y'], 'і': ['i', 'i'],
  'ї': ['i', 'yi'], 'й': ['i', 'y'], 'к': ['k', 'k'], 'л': ['l', 'l'], 'м': ['m', 'm'], 'н': ['n', 'n'],
  'о': ['o', 'o'], 'п': ['p', 'p'], 'р': ['r', 'r'], 'с': ['s', 's'], 'т': ['t', 't'], 'у': ['u', 'u'],
  'ф': ['f', 'f'], 'х': ['kh', 'kh'], 'ц': ['ts', 'ts'], 'ч': ['ch', 'ch'], 'ш': ['sh', 'sh'],
  'щ': ['shch', 'shch'], 'ь': ['', ''], 'ю': ['iu', 'yu'], 'я': ['ia', 'ya'],
};

/** Typographic characters with an obvious ASCII look-alike. */
const LOOK_ALIKES: Record<string, string> = {
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '«': '"', '»': '"', '“': '"', '”': '"', '„': '"',
  '‘': "'", '‚': "'", '…': '...', ' ': ' ', ' ': ' ', ' ': ' ',
};

/** Apostrophes that are part of a Ukrainian word (п'ять, м’ята, подвір'я): dropped between letters. */
const APOSTROPHES = "'’ʼ";

function lower(ch: string): string {
  return ch.toLowerCase();
}

function isUkrainianLetter(ch: string | undefined): boolean {
  return ch !== undefined && LETTERS[lower(ch)] !== undefined;
}

function isUpper(ch: string | undefined): boolean {
  return ch !== undefined && ch !== lower(ch);
}

/** True for any letter (Ukrainian or Latin), so a word boundary is found in mixed text too. */
function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && (isUkrainianLetter(ch) || /[A-Za-z]/.test(ch));
}

/** Ukrainian → Latin transliteration; any other non-ASCII character is dropped. Never throws. */
export function toAscii(text: string): string {
  const src = typeof text === 'string' ? text : '';
  const chars = Array.from(src);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const prev = chars[i - 1];
    const next = chars[i + 1];
    const pair = LETTERS[lower(ch)];
    if (pair) {
      const l = lower(ch);
      // at the start of a word: nothing letter-like before it (an in-word apostrophe does not start a word)
      const before = APOSTROPHES.indexOf(prev === undefined ? '' : prev) >= 0 && isLetter(chars[i - 2]) ? chars[i - 2] : prev;
      const initial = !isLetter(before);
      let latin = (l === 'г' && prev !== undefined && lower(prev) === 'з') ? 'gh' : pair[initial ? 1 : 0];
      if (latin !== '' && isUpper(ch)) {
        const wordUpper = isUpper(next) || (isUpper(prev) && !isLetter(next));
        latin = wordUpper ? latin.toUpperCase() : latin.charAt(0).toUpperCase() + latin.slice(1);
      }
      out += latin;
      continue;
    }
    if (APOSTROPHES.indexOf(ch) >= 0 && isUkrainianLetter(prev) && isUkrainianLetter(next)) continue;
    const code = ch.charCodeAt(0);
    if (ch.length === 1 && code >= 0x20 && code <= 0x7e) {
      out += ch;
      continue;
    }
    if (LOOK_ALIKES[ch] !== undefined) {
      out += LOOK_ALIKES[ch];
      continue;
    }
    if (/\s/.test(ch)) out += ' ';
    // anything else is dropped
  }
  return out.replace(/ {2,}/g, ' ').trim();
}
