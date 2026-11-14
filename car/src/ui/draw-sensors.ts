/**
 * The sensors tab (docs/design/mockups/Sensors.dc.html): eight tiles, four by two. A tile: its label, the
 * reading in `reading-xl` with its unit beside it, detail lines, and at the bottom where the reading came from
 * and how old it is. The tyre tile shows four pressures, front row over rear row. An unavailable reading keeps
 * its tile: dashed `line-strong` edge, «Недоступно» and the reason, all in `ink-dim`, and no number.
 */
import type { Tile, ViewModel } from './view-model';
import { BOX, C, FONT, RADIUS, SPACE, T, baseline, box, cut, dashedBox, label, readingFont, text, width, wrap, type Pen } from './theme';

const COLS = 4;
const ROWS = 2;
const PAD = 20;
const UNIT_SIZE = 26;
const DETAIL = { size: 24, line: 32 } as const;
const AGE = { size: T.label.size, line: 24 } as const;

/** Splits a tile's note into its detail lines and its last line (where the reading came from, its age). */
function noteParts(tile: Tile): { details: string[]; age: string | null } {
  if (!tile.note) return { details: [], age: null };
  const parts = tile.note.split('\n');
  const age = parts.pop() as string;
  return { details: parts, age };
}

export function drawTile(p: Pen, tile: Tile, x: number, y: number, w: number, h: number): void {
  const inner = w - 2 * PAD;
  const top = y + PAD;
  if (!tile.available) {
    dashedBox(p.cv, x, y, w, h, RADIUS.md);
    label(p, tile.label, x + PAD, baseline(top, T.label.size, T.label.line), C.inkDim, inner);
    const valueTop = top + T.label.line + SPACE.s2;
    text(p, tile.value, x + PAD, baseline(valueTop, T.reading.size, 56), T.reading.size, C.inkDim);
    const reasonTop = valueTop + 56 + SPACE.s1;
    const room = Math.max(1, Math.floor((y + h - PAD - reasonTop) / DETAIL.line));
    const ls = wrap(p, tile.note || '', DETAIL.size, inner, room);
    ls.forEach((l, i) => text(p, l, x + PAD, baseline(reasonTop + i * DETAIL.line, DETAIL.size, DETAIL.line), DETAIL.size, C.inkDim));
    return;
  }
  box(p.cv, x, y, w, h);
  label(p, tile.label, x + PAD, baseline(top, T.label.size, T.label.line), C.inkDim, inner);
  const valueTop = top + T.label.line + SPACE.s2;
  const rows = tile.value.split('\n');
  let after: number;
  if (rows.length > 1) {
    // the tyre grid: two columns of `reading`
    rows.forEach((row, i) => {
      const cells = row.split(' ');
      cells.forEach((c, j) => text(p, c, x + PAD + j * (inner / 2), baseline(valueTop + i * T.reading.line, T.reading.size, T.reading.line), T.reading.size, C.ink, FONT.text));
    });
    after = valueTop + rows.length * T.reading.line + SPACE.s1;
  } else {
    const font = readingFont(tile.value);
    const base = baseline(valueTop, T.readingXl.size, T.readingXl.line);
    const unitW = tile.unit ? width(p, tile.unit, UNIT_SIZE) + 12 : 0;
    const value = cut(p, tile.value, T.readingXl.size, inner - unitW, font);
    const vw = text(p, value, x + PAD, base, T.readingXl.size, C.ink, font);
    if (tile.unit) text(p, tile.unit, x + PAD + vw + 12, base, UNIT_SIZE, C.inkDim);
    after = valueTop + T.readingXl.line + SPACE.s2;
  }
  const { details, age } = noteParts(tile);
  details.forEach((d, i) => text(p, cut(p, d, DETAIL.size, inner), x + PAD, baseline(after + i * DETAIL.line, DETAIL.size, DETAIL.line), DETAIL.size, C.ink));
  if (age) text(p, cut(p, age, AGE.size, inner), x + PAD, baseline(y + h - PAD - AGE.line, AGE.size, AGE.line), AGE.size, C.inkDim);
}

export function drawSensors(p: Pen, vm: ViewModel): void {
  const gap = SPACE.s2;
  const w = (BOX.w - (COLS - 1) * gap) / COLS;
  const h = (BOX.h - (ROWS - 1) * gap) / ROWS;
  vm.sensors.slice(0, COLS * ROWS).forEach((tile, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    drawTile(p, tile, BOX.x + col * (w + gap), BOX.y + row * (h + gap), w, h);
  });
}
