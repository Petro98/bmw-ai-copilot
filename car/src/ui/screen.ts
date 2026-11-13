/**
 * The head unit's screen: the entry point the app's wiring (Plan 2 Task 9, car/src/app.ts) calls once.
 *
 *   const screen = startScreen({ ctx, clock, log, input: () => ({ snapshot, alerts, lastTurn, pending, error,
 *     link, pairUrl }), onChip: (question, moving) => ask(question, moving ? 'spoken' : 'full'),
 *     has: require('./kit/fonts').has, frame: require('./kit/gauges').frame });
 *
 * It owns the page (`MAIN`, drawn into `MAIN_GFX`), the current tab, and the tabs' and chips' taps. It reads
 * its input only while it draws and never stores the vehicle's data.
 *
 * When it draws (spec §9: "the screen is drawn only while visible and only when something changed"):
 *   - only inside the kit's ctx.loop for MAIN, which runs while MAIN is visible and not at all while it is
 *     hidden, asked for SCREEN_FPS = 4 frames a second (the kit honours that on both paths: car/kit/VENDORED.md,
 *     local edit 6);
 *   - each loop turn builds the view model and returns without drawing when its signature (what the tab shown
 *     draws: view-model.ts), and the way the kit wants this frame drawn (renderer scale, full-screen header,
 *     kit-run screen), equal those of the last frame drawn;
 *   - without the GPU renderer (the kit's software path: every frame is rasterised, PNG-encoded and written to a
 *     file the HMI shows) at most one frame a second, SOFT_FRAME_MS by the injected clock (spec §9: "never the
 *     software PNG path above 1 fps"); a change inside that second is drawn by the first turn after it. Nothing is drawn for the renderer's sake: its keep-alive (a frame at least once a second, or it hides
 *     a quiet app) is the kit's display, which re-sends the last frame by itself (car/kit/runtime/display.js
 *     _keep); a frame that is identical anyway is not sent again within a second (display.js _send).
 *   - after the screen is shown again, or the kit changes where the frame goes (ctx.onLayout), the next turn
 *     draws once even if nothing changed.
 *
 * Colours: the kit draws the full-screen header itself with its theme's selection colour (M Tricolour's red,
 * our `critical`). startScreen sets that theme's `sel`/`selText` to `signal` once, so the active tab is
 * marked in the assistant's colour as docs/design/README.md asks; nothing else of the kit's theme changes.
 */
import type { Clock, VehicleSnapshot } from '@copilot/vehicle-core';
import type { AlertEvent } from '@copilot/event-engine';
import type { DialogTurn } from '@copilot/shared';
import type { KitCanvas, KitContext, KitTheme } from '../kit/kit';
import { safe, type Log } from '../safe';
import type { LinkStatus } from '../uplink/uplink-client';
import { drawAlerts } from './draw-alerts';
import { drawAssistant } from './draw-assistant';
import { drawHeader, type FrameFn } from './draw-header';
import { drawSensors } from './draw-sensors';
import { C, PAGE, type Pen } from './theme';
import { TABS, buildViewModel, type Tab, type ViewModel } from './view-model';

/** app.json's canvas screen and its image component (car/kit/tools/build.py build_ui: <name>_GFX). */
export const SCREEN = 'MAIN';
export const SCREEN_GFX = 'MAIN_GFX';
/** Frames a second asked of the kit's loop: a turn is a few string comparisons when nothing changed. */
export const SCREEN_FPS = 4;
/** Least time between two frames on the kit's software (PNG) path (spec §9: never above 1 fps). */
export const SOFT_FRAME_MS = 1000;

/** What the screen shows, read at each loop turn. */
export interface ScreenInput {
  snapshot: VehicleSnapshot | null;
  alerts: ReadonlyArray<AlertEvent>;
  lastTurn: DialogTurn | null;
  pending: boolean;
  error: string | null;
  link: LinkStatus;
  pairUrl: string | null;
  /** The last request failed because the head unit's clock is wrong (view-model.ts shows «Годинник…»). */
  clockWrong?: boolean;
}

/** The parts of the kit's ctx the screen uses (the preview's stubbed ctx has them too). */
export type ScreenKit = Pick<KitContext, 'canvas' | 'loop' | 'onTab' | 'onLayout' | 'theme'> & {
  ui: Pick<KitContext['ui'], 'image' | 'onVisible'>;
};

export interface ScreenOptions {
  ctx: ScreenKit;
  clock: Clock;
  log: Log;
  input: () => ScreenInput;
  /** A chip was pressed: ask its question (spoken style while moving). */
  onChip: (question: string, moving: boolean) => void;
  /** car/kit/runtime/fonts.js has: whether a code point can be drawn (otherwise □ is drawn). */
  has: (cp: number) => boolean;
  /** car/kit/runtime/gauges.js frame: the page's tabs (and status badges) for the kit's header. */
  frame: FrameFn;
  /** The tab shown first (default: the assistant). */
  tab?: Tab;
  /**
   * Least time between two software-path frames (default SOFT_FRAME_MS). Only the offline preview passes 0:
   * its stubbed head unit draws one PNG per step on demand, with a clock that stands still.
   */
  softFrameMs?: number;
}

export interface Screen {
  tab(): Tab;
  /** Shows a tab (the header's taps do this by themselves). */
  show(tab: Tab): void;
  /** Draws at the next loop turn even if nothing changed. */
  redraw(): void;
  /** Stops the loop; later taps and turns do nothing. */
  stop(): void;
}

/** How the kit wants this frame drawn: a different answer means a different frame for the same view model. */
function drawKey(cv: KitCanvas): string {
  const kit = cv as unknown as { chrome?: unknown; own?: unknown; textScale?: unknown };
  return String(kit.textScale) + (kit.chrome ? 'c' : '') + (kit.own ? 'o' : '') + (onRenderer(cv) ? 'g' : '');
}

/**
 * Whether this frame goes to the GPU renderer: the kit's canvas() sets `place` (where the frame lands on screen)
 * only while the renderer path is active, and null on the software path (car/kit/runtime/display.js canvas).
 */
function onRenderer(cv: KitCanvas): boolean {
  return !!(cv as unknown as { place?: unknown }).place;
}

/** Draws the whole page for a view model (header via the kit's frame, then the tab's content). */
export function drawPage(cv: KitCanvas, vm: ViewModel, o: { has: (cp: number) => boolean; frame: FrameFn; theme: KitTheme; onChip: (question: string) => void }): void {
  const pen: Pen = { cv, has: o.has };
  cv.clear(C.ground);
  drawHeader(cv, vm, o.frame, o.theme);
  if (vm.tab === 'sensors') drawSensors(pen, vm);
  else if (vm.tab === 'alerts') drawAlerts(pen, vm);
  else drawAssistant(pen, vm, o.onChip);
}

export function startScreen(o: ScreenOptions): Screen {
  const { ctx, log } = o;
  let tab: Tab = o.tab ?? 'assistant';
  let lastKey: string | null = null;
  let lastSoftAt: number | null = null;
  let stopped = false;
  const softFrameMs = o.softFrameMs ?? SOFT_FRAME_MS;

  const theme = ctx.theme();
  theme.sel = C.signal;
  theme.selText = C.signal;

  const chip = safe(log, 'screen chip', (question: string, moving: boolean) => {
    if (!stopped) o.onChip(question, moving);
  });

  const turn = (): unknown => {
    if (stopped) return undefined;
    const now = o.clock.now();
    const vm = buildViewModel(Object.assign({}, o.input(), { tab, now }));
    const cv = ctx.canvas(PAGE.w, PAGE.h);
    const key = vm.signature + '|' + drawKey(cv);
    if (key === lastKey) return undefined;
    const soft = !onRenderer(cv);
    // software path: not again within a second (a clock that went back does not hold the screen)
    if (soft && lastSoftAt !== null && now >= lastSoftAt && now - lastSoftAt < softFrameMs) return undefined;
    drawPage(cv, vm, { has: o.has, frame: o.frame, theme, onChip: (question) => chip(question, vm.moving) });
    lastKey = key;
    lastSoftAt = soft ? now : null;
    return ctx.ui.image(SCREEN_GFX, cv);
  };

  const loop = ctx.loop(SCREEN, SCREEN_FPS, safe(log, 'screen frame', turn));

  ctx.onTab(safe(log, 'screen tab', (i: number) => {
    const next = TABS[i];
    if (stopped || next === undefined || next === tab) return;
    tab = next;
    loop.kick();
  }));
  ctx.ui.onVisible(safe(log, 'screen visible', (name: string, on: boolean) => {
    if (name === SCREEN && on) lastKey = null;
  }));
  ctx.onLayout(safe(log, 'screen layout', () => {
    lastKey = null;
  }));

  return {
    tab: () => tab,
    show(next: Tab) {
      if (stopped || TABS.indexOf(next) < 0 || next === tab) return;
      tab = next;
      loop.kick();
    },
    redraw() {
      lastKey = null;
      if (!stopped) loop.kick();
    },
    stop() {
      stopped = true;
      loop.stop();
    },
  };
}
