/**
 * The alerts tab (docs/design/mockups/Alerts.dc.html, its list): «ОСТАННІ СПОВІЩЕННЯ» and up to four rows,
 * active ones first. A row: the severity icon (triangle, octagon or circle), the title in `title`, and the
 * tag line «<severity> · <provenance> · <when>». An active row sits on `surface-raised` with a `line-strong`
 * edge; a cleared one on `surface`, its title in `ink-dim`, and its tag line says when it was cleared
 * («ЗНЯТО О 12:39»), so the difference is in words, not only in colour.
 */
import { LABEL_RECENT_ALERTS, TEXT_NO_ALERTS } from './strings.uk';
import type { ViewModel } from './view-model';
import { BOX, C, RADIUS, SPACE, T, baseline, cut, label, severityColour, severityIcon, text, type Pen } from './theme';

const ROWS = 4;
const ICON = 40;
const PAD = 24;

export function drawAlerts(p: Pen, vm: ViewModel): void {
  label(p, LABEL_RECENT_ALERTS, BOX.x, baseline(BOX.y, T.label.size, T.label.line));
  const top = BOX.y + T.label.line + 12;
  if (vm.alerts.length === 0) {
    text(p, TEXT_NO_ALERTS, BOX.x, baseline(top + SPACE.s2, T.answer.size, T.answer.line), T.answer.size, C.inkDim);
    return;
  }
  const gap = SPACE.s2;
  const h = Math.floor((BOX.y + BOX.h - top - (ROWS - 1) * gap) / ROWS);
  vm.alerts.slice(0, ROWS).forEach((a, i) => {
    const y = top + i * (h + gap);
    if (a.active) {
      p.cv.roundRect(BOX.x, y, BOX.w, h, RADIUS.md, C.surfaceRaised);
      p.cv.strokeRoundRect(BOX.x + 1, y + 1, BOX.w - 2, h - 2, RADIUS.md, 2, C.lineStrong);
    } else {
      p.cv.roundRect(BOX.x, y, BOX.w, h, RADIUS.md, C.surface);
    }
    severityIcon(p.cv, a.severity, BOX.x + PAD, y + (h - ICON) / 2, ICON, severityColour(a.severity));
    const tx = BOX.x + PAD + ICON + 20;
    const room = BOX.w - (tx - BOX.x) - PAD;
    const block = T.title.line + SPACE.s2 + T.label.line;
    const blockTop = y + (h - block) / 2;
    text(p, cut(p, a.title, T.title.size, room), tx, baseline(blockTop, T.title.size, T.title.line), T.title.size, a.active ? C.ink : C.inkDim);
    label(p, a.tag, tx, baseline(blockTop + T.title.line + SPACE.s2, T.label.size, T.label.line), C.inkDim, room);
  });
}
