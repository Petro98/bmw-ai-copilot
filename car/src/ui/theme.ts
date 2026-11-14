/**
 * The look of the head-unit screens: colours from docs/design/tokens.json, the car type styles, the page
 * geometry, and the text helpers every screen uses (fitting a string to the atlases, wrapping, cutting).
 *
 * Geometry. Screens draw on the kit's 1600 x 520 page (car/kit/runtime/display.js PAGE). Without the GPU
 * renderer the page is the HMI's own image component at 1:1 (display.js HMI.img). With the renderer's
 * full-screen layout the kit draws the 80 px header itself (app name, our tabs, status badges), keeps the
 * HMI's left column (84 px) and its status corner see-through, and shows the page's part
 * { x 12, y 38, w 1576, h 482 } scaled by about 1.165 right of that column (display.js FULL, _place). The
 * content below therefore starts at x 52 (screen x of about 130, clear of the design's 104 px column), ends
 * at x 1548, and runs from y 48 to y 508; type sizes are the design's px at the page's scale, so on the
 * renderer they show slightly larger and never below `label` (18 px).
 */
import type { KitCanvas, KitTextOptions } from '../kit/kit';
import { SHORT_LABEL } from './strings.uk';

/** docs/design/tokens.json colours. */
export const C = {
  ground: '#05070a',
  surface: '#0e1217',
  surfaceRaised: '#171d25',
  line: '#2c3642',
  lineStrong: '#647283',
  ink: '#f2f5f8',
  inkDim: '#a3afbc',
  signal: '#6fc3ff',
  onSignal: '#04121f',
  warning: '#ffc24a',
  critical: '#ff5647',
} as const;

/** docs/design/tokens.json "Car screen" styles: size and line height in px. */
export const T = {
  readingXl: { size: 72, line: 76 },
  reading: { size: 44, line: 48 },
  answerDriving: { size: 34, line: 46 },
  answer: { size: 24, line: 36 },
  title: { size: 28, line: 34 },
  label: { size: 18, line: 22 },
} as const;

/** docs/design/tokens.json spacing and radii. */
export const SPACE = { s1: 4, s2: 8, s3: 16, s4: 24, s5: 40 } as const;
export const RADIUS = { sm: 6, md: 12 } as const;

/** The page (logical px) and the content box inside it (see the comment at the top). */
export const PAGE = { w: 1600, h: 520 } as const;
export const BOX = { x: 52, y: 48, w: 1496, h: 460 } as const;
/** Touch targets on the car screen are at least this tall (docs/design/README.md "Layout"). */
export const MIN_TARGET_H = 88;

/** Kit font families (car/kit/runtime/fonts): 'label' regular text, 'bold' labels, 'light' large readings. */
export const FONT = { text: 'label', strong: 'bold', reading: 'light' } as const;

/** The characters the 'light' and 'num' atlases have at their large sizes (car/kit/tools/bake_fonts.py DIGITS). */
const DIGITS_ONLY = /^[0-9.,:\-+%°/ kmhKMHrpmbarpsiVNCFgsxµRPDSWLOT]*$/;

/** The family for a large reading: 'light' where its atlas has every character, else regular text. */
export function readingFont(text: string): string {
  return DIGITS_ONLY.test(text) ? FONT.reading : FONT.text;
}

const APOSTROPHES = /[‘’ʼ′`´]/g;
const PLACEHOLDER = '□';

/**
 * A string as the atlases can draw it: typographic apostrophes become ', and a character no atlas has
 * (has(code point) false) becomes □, never dropped (the kit drops a missing glyph silently).
 */
export function fitText(text: string, has: (cp: number) => boolean): string {
  if (!text) return '';
  let out = '';
  for (const ch of text.replace(APOSTROPHES, '\'')) {
    const cp = ch.codePointAt(0) as number;
    out += cp === 0x20 || cp === 0x0a || has(cp) ? ch : PLACEHOLDER;
  }
  return out;
}

/** Drawing context shared by the screens: the canvas, the glyph check, and text drawn literally (no i18n). */
export interface Pen {
  cv: KitCanvas;
  has: (cp: number) => boolean;
}

function opts(font: string, extra?: KitTextOptions): KitTextOptions {
  return Object.assign({ font, literal: true }, extra);
}

/** Draws one line of text (y is the baseline); returns its width. */
export function text(p: Pen, s: string, x: number, y: number, size: number, colour: string, font: string = FONT.text, extra?: KitTextOptions): number {
  return p.cv.text(fitText(s, p.has), x, y, size, colour, opts(font, extra));
}

export function width(p: Pen, s: string, size: number, font: string = FONT.text, extra?: KitTextOptions): number {
  return p.cv.textWidth(fitText(s, p.has), size, opts(font, extra));
}

/** One line cut to maxW with '…'. */
export function cut(p: Pen, s: string, size: number, maxW: number, font: string = FONT.text, extra?: KitTextOptions): string {
  const fitted = fitText(s, p.has);
  if (width(p, fitted, size, font, extra) <= maxW) return fitted;
  const chars = Array.from(fitted);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(p, chars.slice(0, mid).join('').replace(/\s+$/, '') + '…', size, font, extra) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('').replace(/\s+$/, '') + '…';
}

/**
 * Wraps text into at most maxLines lines of width maxW (on spaces; a word wider than a line is cut), the
 * last one ending in '…' when the text did not fit. Explicit '\n' starts a new line.
 */
export function wrap(p: Pen, s: string, size: number, maxW: number, maxLines: number, font: string = FONT.text, extra?: KitTextOptions): string[] {
  const lines: string[] = [];
  if (maxLines <= 0) return lines;
  const paragraphs = fitText(s, p.has).split('\n');
  let truncated = false;
  outer:
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    let line = '';
    for (const word of words) {
      const next = line ? line + ' ' + word : word;
      if (width(p, next, size, font, extra) <= maxW) {
        line = next;
        continue;
      }
      if (line) {
        lines.push(line);
        if (lines.length >= maxLines) { truncated = true; break outer; }
      }
      line = width(p, word, size, font, extra) <= maxW ? word : cut(p, word, size, maxW, font, extra);
    }
    if (line || words.length === 0) {
      if (lines.length >= maxLines) { truncated = true; break; }
      lines.push(line);
    }
  }
  if (truncated && lines.length > 0) {
    const last = lines.length - 1;
    lines[last] = cut(p, lines[last] + ' …', size, maxW, font, extra).replace(/\s*…$/, '…');
  }
  return lines;
}

/** Draws wrapped lines from baseline y, lineH apart; returns the baseline after the last line. */
export function lines(p: Pen, ls: string[], x: number, y: number, size: number, lineH: number, colour: string, font: string = FONT.text): number {
  let base = y;
  for (const l of ls) {
    text(p, l, x, base, size, colour, font);
    base += lineH;
  }
  return base;
}

/** An upper-case label in `label` style (letter-spaced, medium); too wide, its short form, then cut. */
export function label(p: Pen, s: string, x: number, y: number, colour: string = C.inkDim, maxW?: number): number {
  const spaced = { spacing: 1.4 };
  let str = s;
  if (maxW !== undefined && width(p, str, T.label.size, FONT.strong, spaced) > maxW) {
    str = cut(p, SHORT_LABEL[s] ?? s, T.label.size, maxW, FONT.strong, spaced);
  }
  return text(p, str, x, y, T.label.size, colour, FONT.strong, spaced);
}

/** Baseline for text of `size` whose line box starts at top with height lineH. */
export function baseline(top: number, size: number, lineH: number): number {
  return Math.round(top + (lineH - size) / 2 + size * 0.8);
}

/**
 * The dashed `line-strong` edge of an unavailable reading's tile (docs/design/README.md "Colour"): dashes
 * along the straight sides and quarter arcs at the corners (the kit's canvas has no dashed stroke).
 */
export function dashedBox(cv: KitCanvas, x: number, y: number, w: number, h: number, r: number, colour: string = C.lineStrong): void {
  const stroke = 2;
  const dash = 10;
  const gap = 7;
  const run = (from: number, to: number, put: (at: number, len: number) => void) => {
    for (let at = from; at < to; at += dash + gap) put(at, Math.min(dash, to - at));
  };
  run(x + r, x + w - r, (at, len) => { cv.fillRect(at, y, len, stroke, colour); cv.fillRect(at, y + h - stroke, len, stroke, colour); });
  run(y + r, y + h - r, (at, len) => { cv.fillRect(x, at, stroke, len, colour); cv.fillRect(x + w - stroke, at, stroke, len, colour); });
  cv.arc(x + r, y + r, r - stroke, r, 270, 360, colour);
  cv.arc(x + w - r, y + r, r - stroke, r, 0, 90, colour);
  cv.arc(x + w - r, y + h - r, r - stroke, r, 90, 180, colour);
  cv.arc(x + r, y + h - r, r - stroke, r, 180, 270, colour);
}

/** Severity colour (docs/design/tokens.json): information uses `signal`. */
export function severityColour(severity: 'info' | 'warning' | 'critical'): string {
  return severity === 'critical' ? C.critical : severity === 'warning' ? C.warning : C.signal;
}

/**
 * The severity icon, size px square at (x, y), 2 px stroke in the severity's colour: a triangle for a
 * warning, an octagon for critical, a circle for information (docs/design/README.md "Iconography"; the
 * paths of docs/design/mockups/Alerts.dc.html on a 24-unit grid).
 */
export function severityIcon(cv: KitCanvas, severity: 'info' | 'warning' | 'critical', x: number, y: number, size: number, colour: string): void {
  const k = size / 24;
  const pt = (u: number, v: number): [number, number] => [x + u * k, y + v * k];
  const w = Math.max(2, 2 * k);
  const dot = (u: number, v: number) => cv.circle(x + u * k, y + v * k, w * 0.7, colour);
  if (severity === 'warning') {
    cv.polyline([pt(12, 4), pt(21, 20), pt(3, 20), pt(12, 4)], w, colour);
    cv.line(x + 12 * k, y + 10 * k, x + 12 * k, y + 14 * k, w, colour);
    dot(12, 17.3);
  } else if (severity === 'critical') {
    cv.polyline([pt(8.3, 3), pt(15.7, 3), pt(21, 8.3), pt(21, 15.7), pt(15.7, 21), pt(8.3, 21), pt(3, 15.7), pt(3, 8.3), pt(8.3, 3)], w, colour);
    cv.line(x + 12 * k, y + 8 * k, x + 12 * k, y + 13 * k, w, colour);
    dot(12, 16.5);
  } else {
    cv.arc(x + 12 * k, y + 12 * k, 9 * k - w / 2, 9 * k + w / 2, 0, 360, colour);
    cv.line(x + 12 * k, y + 11 * k, x + 12 * k, y + 16 * k, w, colour);
    dot(12, 7.7);
  }
}

/** A tile's or panel's box: `surface-raised` (or another fill) with `radius-md` corners. */
export function box(cv: KitCanvas, x: number, y: number, w: number, h: number, fill: string = C.surfaceRaised): void {
  cv.roundRect(x, y, w, h, RADIUS.md, fill);
}
