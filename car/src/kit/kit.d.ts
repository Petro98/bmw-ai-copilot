/**
 * Types for the vendored app kit (car/kit/runtime, MIT), written from its source, not from memory:
 *   - KitContext: the `ctx` object runInner() builds in car/kit/runtime/mgu.js (lines 527-639);
 *   - KitUi: the Ui class in mgu.js (lines 142-280);
 *   - KitSettings: the Settings class in mgu.js (lines 85-139);
 *   - KitCanvas: the Recorder class in car/kit/runtime/record.js (the canvas.js drawing API, recorded);
 *   - KitTheme: the theme objects in car/kit/runtime/themes.js;
 *   - KitSignals: watch() in car/kit/runtime/signals.js.
 *
 * Deliberately left out, so that using them is a type error in our code: the write and method-call
 * functions of signals.js (set, call, proxy, on), the native proxy a watch returns, and the settings
 * writer of the Settings class (settings change through the kit's own settings screen).
 *
 * The offline preview (car/kit/tools/hu-stub.js) gives a smaller ctx: no background, onTouch, onBack,
 * focus, onPageFocus or onSwipe, and a signals.watch that resolves with { error: 'preview' }.
 */

/** A colour: '#rrggbb' / '#rrggbbaa', [r, g, b] / [r, g, b, a] (0-255), or a packed 0xRRGGBBAA. */
export type KitColour = string | number | ReadonlyArray<number>;

export interface KitLog {
  error(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  info(...parts: unknown[]): void;
  debug(...parts: unknown[]): void;
}

/** car/kit/runtime/themes.js: one colour scheme (M Tricolour is the default for an unknown id). */
export interface KitTheme {
  name: string;
  bg: string; panelTop: string; panelBottom: string; panelEdge: string;
  tab: string; track: string; tick: string; text: string; dim: string;
  accent: string; accent2: string; ok: string; warn: string; crit: string; cold: string;
  glow: string; stripes: string[]; oil: string; bar: string; hang?: string; sel: string; selText?: string;
  marker: string; ramp: string[]; hotRamp: string[];
}

export interface KitTextOptions {
  /**
   * A baked atlas family in car/kit/runtime/fonts: 'label' (default), 'bold', 'light', 'num', 'gear'.
   * The atlas is chosen for size x canvas textScale (record.js text, fonts.js get: the smallest baked size
   * at or above it, else the largest), and textScale is the renderer's scale on the head unit (up to 1.2,
   * display.js _place), not 1 as in the preview. Some atlases are partial (46 glyphs, no full Latin
   * alphabet): light@110 and num@64/96/150, so keep size x 1.2 at or below 64 for 'light' and at or below
   * 40 for 'num' text that is not digits; a missing glyph is dropped silently.
   */
  font?: string;
  align?: 'left' | 'center' | 'right';
  /** extra px between characters */
  spacing?: number;
  /** draw the string as given (no i18n lookup) */
  literal?: boolean;
}

/** A cached layer made by the kit's gauges.layer() / record.makeLayer(). */
export interface KitLayer { readonly layerId: number; readonly w: number; readonly h: number }

/**
 * car/kit/runtime/record.js Recorder: the surface ctx.canvas(w, h) returns. Angles are degrees clockwise
 * from 12 o'clock; text y is the baseline; every drawing call returns the recorder.
 */
export interface KitCanvas {
  readonly w: number;
  readonly h: number;
  /** device px per logical px (text is drawn at the size it is shown) */
  readonly textScale: number;
  /** logical px the screen has below the page (reading it marks the page as one that reaches down) */
  readonly extra: number;
  /** true where the kit runs the screen (buttons are drawn on the page there) */
  readonly own: boolean;
  /** a page that scrolls: true, or { y, bar } for a list from y down (ctx.onScroll) */
  scroll: boolean | { y: number; bar: { x: number; y: number; w: number; h: number } };

  /** Something on the page a tap or the controller can press: run() is called; key names it across frames. */
  target(x: number, y: number, w: number, h: number, run: () => unknown, key: string, r?: number, turn?: (detents: number) => void): this;
  clear(c?: KitColour): this;
  fillRect(x: number, y: number, w: number, h: number, c: KitColour): this;
  /** vertical gradient; stops = [[t 0..1, colour], ...] */
  gradientRect(x: number, y: number, w: number, h: number, stops: ReadonlyArray<readonly [number, KitColour]>): this;
  card(x: number, y: number, w: number, h: number, r: number, stops: ReadonlyArray<readonly [number, KitColour]>): this;
  roundRect(x: number, y: number, w: number, h: number, r: number, c: KitColour): this;
  strokeRoundRect(x: number, y: number, w: number, h: number, r: number, width: number, c: KitColour): this;
  rampRect(x: number, y: number, w: number, h: number, r: number, stops: ReadonlyArray<KitColour>, spanX?: number, spanW?: number): this;
  circle(cx: number, cy: number, r: number, c: KitColour): this;
  arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number, c: KitColour,
    opts?: { round?: boolean; ramp?: ReadonlyArray<KitColour>; rampFrom?: number; rampTo?: number }): this;
  line(xa: number, ya: number, xb: number, yb: number, width: number, c: KitColour): this;
  polyline(pts: ReadonlyArray<readonly [number, number]>, width: number, c: KitColour): this;
  /** filled convex quad, four points in order */
  quad(pts: ReadonlyArray<readonly [number, number]>, c: KitColour): this;
  fillUnder(pts: ReadonlyArray<readonly [number, number]>, baseY: number, c: KitColour): this;
  /** opacity 0..1 for what follows; 1 to end */
  alpha(a: number): this;
  clip(x: number, y: number, w: number, h: number): this;
  noclip(): this;
  blit(layer: KitLayer, x: number, y: number): this;
  /** Draws text; returns its width in logical px. A character missing from the atlas is dropped. */
  text(str: string, x: number, y: number, size: number, c: KitColour, opts?: KitTextOptions): number;
  textWidth(str: string, size: number, opts?: KitTextOptions): number;
}

/** An RHMI click: the row a list or drop-down was pressed on. */
export interface KitClickEvent { row?: number; value?: unknown }

/** mgu.js Ui: the head unit's own HMI (screens, pop-ups, bar buttons, texts). */
export interface KitUi {
  /** Sets a label's text. For a pop-up the order is open, then text (car/kit/runtime/mgu.js, jap_sysmon). */
  text(name: string, text: string, row?: number, cell?: string): Promise<unknown>;
  cells(name: string, row: number, cells: Record<string, string>): Promise<unknown>;
  selected(name: string, row: number): Promise<unknown>;
  rows(name: string, count: number): Promise<unknown>;
  visible(name: string, on: boolean): Promise<unknown>;
  enabled(name: string, on: boolean): Promise<unknown>;
  checked(name: string, on: boolean, row?: number): Promise<unknown>;
  onClick(name: string, fn: (event: KitClickEvent) => unknown): void;
  open(stateName: string): Promise<unknown>;
  close(stateName: string): Promise<unknown>;
  isVisible(stateName: string): boolean;
  /** false while an HMI pop-up covers the (visible) screen */
  hasFocus(stateName: string): boolean;
  onFocus(fn: (stateName: string, on: boolean) => void): void;
  onVisible(fn: (stateName: string, on: boolean) => void): void;
  /** Shows a frame (a KitCanvas from ctx.canvas, or PNG bytes) in a graphic component, e.g. 'MAIN_GFX'. */
  image(name: string, frame: KitCanvas | Uint8Array): Promise<unknown>;
}

/** mgu.js Settings: the app's settings from app.json "settings", persisted in the data folder. */
export interface KitSettings {
  get(key: string): unknown;
  onChange(fn: (key: string, value: unknown) => void): void;
  /** human text for the current value */
  display(key: string): string;
}

/** What signals.watch() resolves with (its native proxy is not exposed to our code). */
export interface KitWatch {
  readonly iface: string;
  /** true once the provider (the car) answers */
  readonly available: boolean;
  /** why the watch could not be set up (no native module, no interface config), else null */
  readonly error: string | null;
  shutdown(): Promise<unknown>;
}

/** car/kit/runtime/signals.js, read side only. */
export interface KitSignals {
  /**
   * Subscribes to the fields of one interface instance; also reads those with a getter once the provider
   * is available, and again every opts.pollMs while it is. The kit passes String(instance) to the native
   * binding, so give the instance as a string (e.g. '1', as car/kit/runtime/parked.js does).
   */
  watch(iface: string, instance: string, handlers: Record<string, (value: unknown) => void>, log?: KitLog,
    opts?: { pollMs?: number }): Promise<KitWatch>;
}

/** The app's own app.json as the kit carries it (car/kit/tools/build.py writes kit/app-spec.json). */
export interface KitSpec {
  id: string;
  title: string;
  version: string;
  screens?: unknown[] | null;
  popups?: unknown[] | null;
  settings?: unknown[] | null;
  config?: Record<string, unknown> | null;
  stateIds: Record<string, number>;
}

/** ctx.loop's handle. */
export interface KitLoop { stop(): void; kick(): void }

/** The `ctx` the kit hands to start(ctx) (car/kit/runtime/mgu.js runInner). */
export interface KitContext {
  app: unknown;
  ui: KitUi;
  settings: KitSettings;
  log: KitLog;
  spec: KitSpec;
  /** the app's writable data folder on the head unit */
  dataDir: string;
  display: unknown;
  widget: unknown;
  /** Keeps the app running while hidden (life.js hold): MainApp otherwise stops a hidden app. */
  background(name: string, on: boolean): Promise<unknown>;
  signals: KitSignals;
  theme(): KitTheme;
  controller: { grab(on: boolean): void; onInput(fn: (event: Record<string, number>) => void): void };
  /** fn(i) when page tab i is tapped or pressed; fn(i, true) when that also closed a sheet */
  onTab(fn: (index: number, closedSheet?: boolean) => unknown): void;
  /** fn(x, y) for a tap on the page (logical px), where the kit runs the screen */
  onTap(fn: (x: number, y: number) => unknown): void;
  /** fn(phase 1 down / 2 move / 3 up, x, y in screen px); return true to take the touch */
  onTouch(fn: (phase: number, x: number, y: number) => boolean | void): void;
  /** fn(atEdge) when the controller is pushed left; return true when the app took it */
  onBack(fn: (atEdge: boolean) => boolean): void;
  focus(key: string | null): void;
  sheet(sheet: unknown): boolean;
  hideButton(id: string, hide?: boolean): void;
  onPageFocus(fn: (key: string | null) => void): void;
  onScroll(fn: (dy: number) => boolean): void;
  onSwipe(fn: (dx: number) => boolean): void;
  /** fn() when where the frame goes changed: an app that draws only on changes draws again */
  onLayout(fn: () => void): void;
  /** the surface for one frame (reused between calls): pass it to ui.image */
  canvas(w: number, h: number): KitCanvas;
  /** Runs fn while screen stateName is visible: once per renderer refresh on the GPU path, else about fps a second. */
  loop(stateName: string, fps: number, fn: () => unknown): KitLoop;
}

/** What a kit app implements (mgu.run(impl)). */
export interface KitApp { start(ctx: KitContext): unknown }

/** car/kit/runtime/mgu.js module exports, as the bundle requires them: require('./kit/mgu'). */
export interface KitMgu {
  run(app: KitApp): Promise<KitContext | undefined>;
  log: KitLog;
  SPEC: KitSpec;
}
