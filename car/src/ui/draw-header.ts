/**
 * The header: the app's tabs and the three status marks, handed to the kit's page frame (car/kit/runtime/
 * gauges.js `frame`). With the GPU renderer's full-screen layout the kit draws them itself in its header in
 * the HMI's title strip, left of the HMI's own status corner, and keeps the back column see-through
 * (display.js _drawChrome, headerCompact); the kit adds its Settings tab, which opens its settings sheet.
 * Without the renderer, `frame` draws a slim tab bar along the top of the page (y 0-36).
 *
 * A status mark is a word whose text says whether the link works («МЕРЕЖА» / «НЕМАЄ МЕРЕЖІ»), so it never
 * relies on colour alone; the colour follows (signal when it works, ink-dim when not).
 */
import type { KitCanvas, KitTheme } from '../kit/kit';
import { STATUS_WORDS, TAB_LABELS } from './strings.uk';
import { C } from './theme';
import { TABS, type ViewModel } from './view-model';

export interface Badge { text: string; color: string }

/** car/kit/runtime/gauges.js frame(cv, t, tabs, sel, badges). */
export type FrameFn = (cv: KitCanvas, theme: KitTheme, tabs: string[], sel: number, badges: Badge[]) => void;

export function statusBadges(status: ViewModel['status']): Badge[] {
  const mark = (ok: boolean, words: { ok: string; down: string }): Badge =>
    ({ text: ok ? words.ok : words.down, color: ok ? C.signal : C.inkDim });
  return [
    mark(status.car, STATUS_WORDS.car),
    mark(status.network, STATUS_WORDS.network),
    mark(status.claude, STATUS_WORDS.claude),
  ];
}

export function drawHeader(cv: KitCanvas, vm: ViewModel, frame: FrameFn, theme: KitTheme): void {
  // the kit lays badges out from the right edge leftwards (gauges.js badgeRow): reversed, they read
  // «АВТО · МЕРЕЖА · CLAUDE» from left to right as in the mockups
  frame(cv, theme, TAB_LABELS.slice(), TABS.indexOf(vm.tab), statusBadges(vm.status).reverse());
}
