/**
 * Head-unit entry point. car/scripts/build-car.mjs bundles it into car/apps/p98_copilot/main.js, which
 * the vendored kit (car/kit) packages as the app's javascript/app.js.
 *
 * This is the app shell: the kit's entry as .research/jap_sysmon_main.js uses it (mgu.run with an async
 * start(ctx)), drawing the word «Copilot» on the canvas screen while it is shown. Nothing here reads or
 * writes the vehicle.
 */
import type { KitContext, KitMgu } from './kit/kit';
import { safe } from './safe';

// The kit stays outside the bundle and is required the way the kit's own apps require it
// (build-car.mjs marks ./kit/* external); its types are in ./kit/kit.d.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mgu = require('./kit/mgu') as KitMgu;

/** The canvas screen of app.json; its image component is <name>_GFX (car/kit/tools/build.py build_ui). */
const MAIN = 'MAIN';
const MAIN_GFX = 'MAIN_GFX';
/** The canvas screen's image size (car/kit/runtime/display.js, HMI.img). */
const WIDTH = 1600;
const HEIGHT = 520;
/** docs/design/tokens.json: `ground` (the screen) and `ink` (primary text). */
const GROUND = '#05070a';
const INK = '#f2f5f8';

function drawShell(ctx: KitContext): Promise<unknown> {
  const cv = ctx.canvas(WIDTH, HEIGHT).clear(GROUND);
  // The kit picks the atlas for size x textScale (record.js text), and textScale reaches 1.2 on the
  // renderer (display.js _place). 'light' is whole only up to its 64 px atlas (its 110 px one has 46
  // glyphs), so 48 px stays within it: 48 x 1.2 = 57.6.
  cv.text('Copilot', WIDTH / 2, HEIGHT / 2 + 18, 48, INK, { align: 'center', font: 'light' });
  return ctx.ui.image(MAIN_GFX, cv);
}

const app = {
  async start(ctx: KitContext): Promise<void> {
    // One frame each time the screen is shown (or the renderer moves it), none while hidden: the kit's
    // loop runs only while MAIN is visible, and the frame is drawn once until it is hidden again.
    let drawn = false;
    const frame = safe(ctx.log, 'frame', () => {
      if (drawn) return undefined;
      drawn = true;
      return drawShell(ctx);
    });
    ctx.ui.onVisible(safe(ctx.log, 'visible', (name: string, on: boolean) => {
      if (name === MAIN && !on) drawn = false;
    }));
    ctx.onLayout(safe(ctx.log, 'layout', () => {
      drawn = false;
    }));
    ctx.loop(MAIN, 1, frame);
  },
};

safe(mgu.log, 'run', () => mgu.run(app))();
