/**
 * Head-unit entry point. car/scripts/build-car.mjs bundles it into car/apps/p98_copilot/main.js, which
 * the vendored kit (car/kit) packages as the app's javascript/app.js.
 *
 * The kit's entry as .research/jap_sysmon_main.js uses it (mgu.run with a start(ctx)); start(ctx) wires the
 * app (car/src/app.ts) with the platform's real clock, timers, file system and random source. The app's
 * config comes from app.json "config" as the kit carries it (ctx.spec.config, car/kit/tools/build.py writes it
 * into kit/app-spec.json): `backendUrl`, written only into the owner's private deploy copy by
 * car/scripts/publish-car.mjs (null in this repository), and `droppedReadings`, the readings whose signal that
 * copy leaves out. The interfaces the installer left out on this unit are read from the kit's
 * missing-interfaces.json, as car/kit/runtime/mgu.js reads it.
 *
 * Nothing here reads or writes the vehicle itself; the kit's shutdown path is left to the kit. When the
 * process exits (the kit exits it when MainApp asks), the state file is written if anything in it changed.
 */
import * as crypto from 'crypto';
import * as nodeFs from 'fs';
import * as path from 'path';
import { startApp, type AppDeps, type AppHandle } from './app';
import type { KitContext, KitMgu } from './kit/kit';
import type { FsApi, FullTimerApi } from './platform';
import { safe } from './safe';
import type { FrameFn } from './ui/draw-header';

// The kit stays outside the bundle and is required the way the kit's own apps require it
// (build-car.mjs marks ./kit/* external); its types are in ./kit/kit.d.ts.
/* eslint-disable @typescript-eslint/no-require-imports */
const mgu = require('./kit/mgu') as KitMgu;
const fonts = require('./kit/fonts') as { has(cp: number): boolean };
const gauges = require('./kit/gauges') as { frame: FrameFn };
/* eslint-enable @typescript-eslint/no-require-imports */

const fs: FsApi = {
  existsSync: (p) => nodeFs.existsSync(p),
  readFileSync: (p, encoding) => nodeFs.readFileSync(p, encoding),
  writeFileSync: (p, data, options) => nodeFs.writeFileSync(p, data, options),
  renameSync: (from, to) => nodeFs.renameSync(from, to),
};

const timers: FullTimerApi = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The interfaces the installer left out (car/kit/runtime/mgu.js reads the same file: { "<iface>": "<what is lost>" }). */
function missingInterfaces(): string[] {
  try {
    const parsed: unknown = JSON.parse(nodeFs.readFileSync(path.join(__dirname, 'kit', 'missing-interfaces.json'), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed as object) : [];
  } catch {
    return [];   // none missing (the file exists only when the installer left an interface out)
  }
}

function configOf(ctx: KitContext): AppDeps['config'] {
  const raw = ctx.spec && ctx.spec.config && typeof ctx.spec.config === 'object' ? ctx.spec.config : {};
  const url = raw.backendUrl;
  const dropped = raw.droppedReadings;
  return {
    backendUrl: typeof url === 'string' && url.trim() !== '' ? url.trim() : null,
    droppedReadings: Array.isArray(dropped) ? dropped.filter((k): k is string => typeof k === 'string') : [],
    missingInterfaces: missingInterfaces(),
  };
}

const app = {
  start(ctx: KitContext): void {
    const handle: AppHandle = startApp({
      ctx,
      clock: { now: () => Date.now() },
      timers,
      fs,
      config: configOf(ctx),
      random: (bytes) => crypto.randomBytes(bytes).toString('hex'),
      screenKit: { has: (cp) => fonts.has(cp), frame: gauges.frame },
    });
    process.on('exit', safe(ctx.log, 'exit', () => handle.persist()));
  },
};

safe(mgu.log, 'run', () => mgu.run(app))();
