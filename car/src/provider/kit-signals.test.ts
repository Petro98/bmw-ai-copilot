/**
 * The vendored kit's signals.watch (car/kit/runtime/signals.js), loaded on Node 22 with a fake native binding:
 * `require('someip')` is answered with a stand-in and the interface config is answered for one made-up
 * interface name, so nothing here knows or reaches a real vehicle interface.
 *
 * Covers the local edit recorded in car/kit/VENDORED.md: a polled watch's interval is cleared by shutdown().
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const nodeRequire = createRequire(import.meta.url);
const KIT_SIGNALS = fileURLToPath(new URL('../../kit/runtime/signals.js', import.meta.url));

/** a made-up interface: loadConfig() looks for '<iface with dots as underscores>.json' */
const FAKE_IFACE = 'test.FakeInterface';
const FAKE_CONFIG_FILE = 'test_FakeInterface.json';
const FAKE_CONFIG = { fields: { statusFake: { getter: true } } };

interface KitWatchResult { available: boolean; error: string | null; shutdown(): Promise<unknown> }
interface KitSignalsModule {
  watch(iface: string, instance: string, handlers: Record<string, (v: unknown) => void>, log: unknown, opts?: { pollMs?: number }): Promise<KitWatchResult>;
}

const binding = { getValueCalls: 0, proxyShutdowns: 0 };
const fakeSomeip = {
  buildProxy: () => Promise.resolve({
    init: () => Promise.resolve(),
    subscribeToAvailability: () => null,
    subscribe: () => Promise.resolve(),
    isAvailable: () => true,
    getValue: () => { binding.getValueCalls++; return Promise.resolve({ value: 1 }); },
    shutdown: () => { binding.proxyShutdowns++; },
  }),
};

type ModuleWithLoad = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const fs = nodeRequire('fs') as { readFileSync: (...args: unknown[]) => unknown };
const realReadFileSync = fs.readFileSync;
let kit: KitSignalsModule;

/** lets the kit's setImmediate ticks and promise chains run (setImmediate is never faked here) */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeAll(() => {
  const Module = nodeRequire('module') as ModuleWithLoad;
  const realLoad = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'someip') return fakeSomeip;
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    delete nodeRequire.cache[KIT_SIGNALS];
    kit = nodeRequire(KIT_SIGNALS) as KitSignalsModule;
  } finally {
    Module._load = realLoad;
  }
  fs.readFileSync = function readFileSync(...args: unknown[]): unknown {
    const p = args[0];
    if (typeof p === 'string' && p.endsWith(FAKE_CONFIG_FILE)) return JSON.stringify(FAKE_CONFIG);
    return realReadFileSync.apply(fs, args);
  };
});

afterAll(() => {
  fs.readFileSync = realReadFileSync;
  delete nodeRequire.cache[KIT_SIGNALS];
});

describe('vendored kit signals.watch', () => {
  test('a polled watch keeps one interval; shutdown clears it, marks the watch unavailable, and a second shutdown is harmless', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const seen: unknown[] = [];
      const res = await kit.watch(FAKE_IFACE, '1', { statusFake: (v) => seen.push(v) }, null, { pollMs: 10_000 });
      await flush();
      expect(res.error).toBeNull();
      expect(res.available).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      const afterSetup = binding.getValueCalls;
      vi.advanceTimersByTime(10_000);
      await flush();
      expect(binding.getValueCalls).toBe(afterSetup + 1);   // the poll re-reads the getter
      expect(seen.length).toBeGreaterThan(0);

      await res.shutdown();
      expect(vi.getTimerCount()).toBe(0);
      expect(res.available).toBe(false);
      expect(binding.proxyShutdowns).toBe(1);
      await expect(res.shutdown()).resolves.toBeUndefined();
      expect(binding.proxyShutdowns).toBe(1);
      vi.advanceTimersByTime(60_000);
      await flush();
      expect(binding.getValueCalls).toBe(afterSetup + 1);   // no poll after shutdown
    } finally {
      vi.useRealTimers();
    }
  });

  test('a watch without pollMs starts no interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const res = await kit.watch(FAKE_IFACE, '1', { statusFake: () => undefined }, null);
      expect(res.error).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      await res.shutdown();
      expect(res.available).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
