/**
 * The head unit's platform as our modules see it: injected, so every module is unit-tested on Node 22
 * with fakes and runs unchanged on the head unit's Node 8.16.2.
 */
import type { TimerApi } from '@copilot/vehicle-core';

/** The subset of Node's `fs` the app uses (all of it exists in Node 8: no rmSync, no recursive mkdir). */
export interface FsApi {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string, options?: { mode?: number }): void;
  renameSync(from: string, to: string): void;
}

export interface FullTimerApi extends TimerApi { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }

export type KitContext = import('./kit/kit').KitContext;   // declared in kit.d.ts from the vendored kit's real ctx object
