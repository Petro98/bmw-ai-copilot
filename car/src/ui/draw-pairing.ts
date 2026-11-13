/**
 * Pairing, shown on the assistant tab until the device is registered: a QR code of
 * `<backendUrl>/pair#d=<deviceId>&s=<secret>` (view-model.ts pairingUrl) and two lines of instruction. The
 * phone's /pair page reads the fragment, registers the device and strips it (Plan 2 Task 7). Without a
 * backend address in the app's config: «Адресу сервера не налаштовано» and no QR.
 *
 * The code is dark modules (`ground`) on a light square (`ink`) with the standard four-module quiet zone,
 * each module a whole number of page pixels. The matrix is computed once per address (a few milliseconds)
 * and kept; the address itself is never logged.
 */
import { LABEL_PAIRING, PAIRING_LINES, PAIRING_NO_ADDRESS, PAIRING_NO_ADDRESS_NOTE } from './strings.uk';
import { encodeQr } from './qr';
import type { ViewModel } from './view-model';
import { C, SPACE, T, baseline, box, label, lines, wrap, type Pen } from './theme';

const QUIET = 4;

/** The pairing panel's words: the two instructions, or the missing-address line and its note. */
export function pairingLines(pairing: ViewModel['pairing']): string[] {
  return pairing.url ? PAIRING_LINES.slice() : [PAIRING_NO_ADDRESS, PAIRING_NO_ADDRESS_NOTE];
}

let cached: { text: string; matrix: boolean[][] } | null = null;

function matrixFor(url: string): boolean[][] {
  if (!cached || cached.text !== url) cached = { text: url, matrix: encodeQr(url) };
  return cached.matrix;
}

/** Draws the code with its quiet zone at (x, y) within side px; returns the side actually used. */
function drawQr(p: Pen, url: string, x: number, y: number, side: number): number {
  const m = matrixFor(url);
  const n = m.length + 2 * QUIET;
  const k = Math.max(1, Math.floor(side / n));
  const used = n * k;
  p.cv.fillRect(x, y, used, used, C.ink);
  for (let r = 0; r < m.length; r++) {
    // one rectangle per run of dark modules in a row
    let c = 0;
    while (c < m.length) {
      if (!m[r][c]) { c++; continue; }
      const start = c;
      while (c < m.length && m[r][c]) c++;
      p.cv.fillRect(x + (QUIET + start) * k, y + (QUIET + r) * k, (c - start) * k, k, C.ground);
    }
  }
  return used;
}

/** The pairing panel in the box x, y, w, h. */
export function drawPairing(p: Pen, pairing: ViewModel['pairing'], x: number, y: number, w: number, h: number): void {
  box(p.cv, x, y, w, h, C.surface);
  const pad = SPACE.s4;
  let tx = x + pad;
  if (pairing.url) {
    const used = drawQr(p, pairing.url, x + pad, y + pad, h - 2 * pad);
    tx = x + pad + used + SPACE.s5;
  }
  const room = x + w - pad - tx;
  label(p, LABEL_PAIRING, tx, baseline(y + pad + SPACE.s2, T.label.size, T.label.line), C.inkDim, room);
  const [first, second] = pairingLines(pairing);
  let top = y + pad + SPACE.s2 + T.label.line + SPACE.s3;
  const head = wrap(p, first, T.title.size, room, 2);
  lines(p, head, tx, baseline(top, T.title.size, T.title.line), T.title.size, T.title.line, C.ink);
  top += head.length * T.title.line + SPACE.s3;
  const rest = wrap(p, second, T.answer.size, room, 3);
  lines(p, rest, tx, baseline(top, T.answer.size, T.answer.line), T.answer.size, T.answer.line, C.inkDim);
}
