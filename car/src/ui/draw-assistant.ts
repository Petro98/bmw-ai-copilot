/**
 * The assistant tab (docs/design/mockups/Main.dc.html standing, AssistantMoving.dc.html moving).
 *
 * Standing: the last question in `title` and the answer in `answer` (up to eight lines, as many as fit),
 * six question chips in two columns, and a strip of five readings. Moving: «У РУСІ · КОРОТКА ВІДПОВІДЬ», the
 * question in `ink-dim`, the answer in `answer-driving` (three lines at most), three chips, three readings.
 * The chips are the only way to ask (no keyboard): each is a page target (tap, or the iDrive controller
 * turned onto it and pressed) at least 88 px tall. Until the device is paired the dialog and the chips give
 * way to the pairing panel (draw-pairing.ts).
 */
import {
  LABEL_ASK,
  LABEL_MOVING_ANSWER,
  LABEL_YOUR_QUESTION,
  TEXT_NO_TURN,
  TEXT_PENDING,
} from './strings.uk';
import type { Tile, ViewModel } from './view-model';
import { drawPairing } from './draw-pairing';
import {
  BOX,
  C,
  FONT,
  MIN_TARGET_H,
  RADIUS,
  SPACE,
  T,
  baseline,
  box,
  cut,
  dashedBox,
  label,
  lines,
  readingFont,
  text,
  width,
  wrap,
  type Pen,
} from './theme';

const STRIP_H = 96;
const MAIN_H = BOX.h - STRIP_H - SPACE.s3;
const LEFT_W = Math.round((BOX.w - SPACE.s4) * 7 / 12);
const RIGHT_X = BOX.x + LEFT_W + SPACE.s4;
const RIGHT_W = BOX.x + BOX.w - RIGHT_X;
const STANDING_ANSWER_MAX = 8;
const MOVING_ANSWER_MAX = 3;

/** One reading of the strip under the dialog: label, then value and unit (or «Недоступно» and why). */
function drawStripTile(p: Pen, tile: Tile, x: number, y: number, w: number, h: number): void {
  const pad = 20;
  const inner = w - 2 * pad;
  if (!tile.available) {
    dashedBox(p.cv, x, y, w, h, RADIUS.md);
    label(p, tile.label, x + pad, baseline(y + 12, T.label.size, T.label.line), C.inkDim, inner);
    text(p, tile.value, x + pad, baseline(y + 12 + T.label.line + SPACE.s1, T.answer.size, 30), T.answer.size, C.inkDim);
    if (tile.note) text(p, cut(p, tile.note, T.label.size, inner), x + pad, baseline(y + h - 12 - T.label.line, T.label.size, T.label.line), T.label.size, C.inkDim);
    return;
  }
  box(p.cv, x, y, w, h, C.surface);
  label(p, tile.label, x + pad, baseline(y + 12, T.label.size, T.label.line), C.inkDim, inner);
  const base = baseline(y + 12 + T.label.line + SPACE.s1, T.reading.size, T.reading.line);
  const font = readingFont(tile.value);
  const unitW = tile.unit ? width(p, tile.unit, T.answer.size) + 10 : 0;
  const vw = text(p, cut(p, tile.value, T.reading.size, inner - unitW, font), x + pad, base, T.reading.size, C.ink, font);
  if (tile.unit) text(p, tile.unit, x + pad + vw + 10, base, T.answer.size, C.inkDim);
}

function drawStrip(p: Pen, tiles: Tile[]): void {
  const gap = SPACE.s2;
  const y = BOX.y + BOX.h - STRIP_H;
  const w = (BOX.w - (tiles.length - 1) * gap) / tiles.length;
  tiles.forEach((tile, i) => drawStripTile(p, tile, BOX.x + i * (w + gap), y, w, STRIP_H));
}

/** The dialog panel: what was asked and the answer, or the state of the question. */
function drawDialog(p: Pen, vm: ViewModel): void {
  const a = vm.assistant;
  const x = BOX.x;
  const y = BOX.y;
  box(p.cv, x, y, LEFT_W, MAIN_H, C.surface);
  const padX = 28;
  const inner = LEFT_W - 2 * padX;
  let top = y + SPACE.s4;
  label(p, vm.moving ? LABEL_MOVING_ANSWER : LABEL_YOUR_QUESTION, x + padX, baseline(top, T.label.size, T.label.line), C.inkDim, inner);
  top += T.label.line + 12;
  if (a.question) {
    if (vm.moving) {
      text(p, cut(p, a.question, T.answer.size, inner), x + padX, baseline(top, T.answer.size, 32), T.answer.size, C.inkDim);
      top += 32 + SPACE.s3;
    } else {
      text(p, cut(p, a.question, T.title.size, inner, FONT.strong), x + padX, baseline(top, T.title.size, T.title.line), T.title.size, C.ink, FONT.strong);
      top += T.title.line + SPACE.s3;
    }
  }
  const style = vm.moving ? T.answerDriving : T.answer;
  const bottom = y + MAIN_H - SPACE.s4;
  const fit = Math.max(1, Math.floor((bottom - top) / style.line));
  const max = Math.min(vm.moving ? MOVING_ANSWER_MAX : STANDING_ANSWER_MAX, fit);
  const body = a.error !== null ? a.error : a.pending ? TEXT_PENDING : a.answer !== null ? a.answer : TEXT_NO_TURN;
  const colour = a.error !== null || a.answer !== null ? C.ink : C.inkDim;
  lines(p, wrap(p, body, style.size, inner, max), x + padX, baseline(top, style.size, style.line), style.size, style.line, colour);
}

/** The chips: six in two columns standing, three in one column moving; each one a page target. */
function drawChips(p: Pen, vm: ViewModel, onChip: (question: string) => void): void {
  label(p, LABEL_ASK, RIGHT_X, baseline(BOX.y, T.label.size, T.label.line), C.inkDim, RIGHT_W);
  const chips = vm.assistant.chips;
  const cols = vm.moving ? 1 : 2;
  const rows = Math.ceil(chips.length / cols);
  const top = BOX.y + T.label.line + 12;
  const gap = SPACE.s2;
  const w = (RIGHT_W - (cols - 1) * gap) / cols;
  const h = Math.max(MIN_TARGET_H, Math.floor((BOX.y + MAIN_H - top - (rows - 1) * gap) / rows));
  const style = vm.moving ? { size: T.title.size, line: 36, max: 2 } : { size: 22, line: 27, max: 3 };
  const pad = vm.moving ? 32 : 20;
  chips.forEach((question, i) => {
    const cx = RIGHT_X + (i % cols) * (w + gap);
    const cy = top + Math.floor(i / cols) * (h + gap);
    box(p.cv, cx, cy, w, h);
    const ls = wrap(p, question, style.size, w - 2 * pad, style.max, FONT.strong);
    const first = cy + (h - ls.length * style.line) / 2;
    lines(p, ls, cx + pad, baseline(first, style.size, style.line), style.size, style.line, C.ink, FONT.strong);
    p.cv.target(cx, cy, w, h, () => onChip(question), 'chip:' + i, RADIUS.md);
  });
}

export function drawAssistant(p: Pen, vm: ViewModel, onChip: (question: string) => void): void {
  if (!vm.pairing.paired) {
    drawPairing(p, vm.pairing, BOX.x, BOX.y, BOX.w, MAIN_H);
  } else {
    drawDialog(p, vm);
    drawChips(p, vm, onChip);
  }
  drawStrip(p, vm.assistant.strip);
}
