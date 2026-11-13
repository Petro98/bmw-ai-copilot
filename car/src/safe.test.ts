import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { safe, type Log } from './safe';

function recordingLog(): { lines: string[]; log: Log } {
  const lines: string[] = [];
  const push = (m: string): void => {
    lines.push(m);
  };
  return { lines, log: { info: push, warn: push, error: push } };
}

/** Lets a rejected promise reach the handler safe() attached to it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

test('safe() swallows a throw and a rejection and logs once per label per minute', async () => {
  const { lines, log } = recordingLog();

  const throwing = safe(log, 'tick', () => {
    throw new Error('boom');
  });
  expect(() => throwing()).not.toThrow();
  expect(throwing()).toBeUndefined();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('tick');
  expect(lines[0]).toContain('boom');

  const rejecting = safe(log, 'upload', () => Promise.reject(new Error('offline')));
  expect(rejecting()).toBeUndefined();
  await settle();
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain('upload');
  expect(lines[1]).toContain('offline');
  rejecting();
  await settle();
  expect(lines).toHaveLength(2);

  // a second wrapper with the same label shares the label's budget
  const sameLabel = safe(log, 'tick', () => {
    throw new Error('again');
  });
  sameLabel();
  expect(lines).toHaveLength(2);

  vi.setSystemTime(1_000_000 + 59_999);
  throwing();
  expect(lines).toHaveLength(2);

  vi.setSystemTime(1_000_000 + 60_000);
  throwing();
  expect(lines).toHaveLength(3);
  expect(lines[2]).toContain('tick');
});

test('safe() passes the arguments through and returns nothing on success', async () => {
  const { lines, log } = recordingLog();
  const seen: Array<[number, string]> = [];
  const wrapped = safe(log, 'args', (n: number, s: string) => {
    seen.push([n, s]);
    return 42;
  });
  expect(wrapped(7, 'x')).toBeUndefined();
  const asyncWrapped = safe(log, 'args-async', async (n: number) => {
    seen.push([n, 'async']);
  });
  expect(asyncWrapped(8)).toBeUndefined();
  await settle();
  expect(seen).toEqual([
    [7, 'x'],
    [8, 'async'],
  ]);
  expect(lines).toEqual([]);
});

test('a value that cannot be printed and a log that throws do not escape', async () => {
  const unprintable = {
    toString(): string {
      throw new Error('no string');
    },
  };
  const { lines, log } = recordingLog();
  const throwsUnprintable = safe(log, 'unprintable', () => {
    throw unprintable;
  });
  expect(() => throwsUnprintable()).not.toThrow();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('unprintable');

  const brokenLog: Log = {
    info: () => {
      throw new Error('log down');
    },
    warn: () => {
      throw new Error('log down');
    },
    error: () => {
      throw new Error('log down');
    },
  };
  const withBrokenLog = safe(brokenLog, 'broken-log', () => {
    throw new Error('first');
  });
  expect(() => withBrokenLog()).not.toThrow();
  const rejectsWithBrokenLog = safe(brokenLog, 'broken-log-async', () => Promise.reject(unprintable));
  expect(() => rejectsWithBrokenLog()).not.toThrow();
  await settle();
});
