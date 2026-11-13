import { describe, expect, test } from 'vitest';
import { NO_LIMITS } from '@copilot/event-engine';
import type { FsApi } from '../platform';
import type { Log } from '../safe';
import { STATE_FILE_NAME, StateFile, defaultState, type PersistedState } from './state-file';

const DIR = '/data/p98_copilot';
const PATH = DIR + '/' + STATE_FILE_NAME;
const SECRET = 'S'.repeat(43);

interface MemFs extends FsApi {
  files: Record<string, { data: string; mode: number | undefined }>;
  calls: string[];
  failWrite: boolean;
  failRename: boolean;
}

function memFs(): MemFs {
  const fs: MemFs = {
    files: {},
    calls: [],
    failWrite: false,
    failRename: false,
    existsSync(path) {
      return path in fs.files;
    },
    readFileSync(path) {
      const f = fs.files[path];
      if (!f) throw Object.assign(new Error('ENOENT: no such file, open ' + path), { code: 'ENOENT' });
      return f.data;
    },
    writeFileSync(path, data, options) {
      fs.calls.push('write ' + path);
      if (fs.failWrite) throw Object.assign(new Error('ENOSPC: no space left on device, open ' + path), { code: 'ENOSPC' });
      fs.files[path] = { data, mode: options && options.mode };
    },
    renameSync(from, to) {
      fs.calls.push('rename ' + from + ' ' + to);
      if (fs.failRename) throw Object.assign(new Error('EIO: rename ' + from), { code: 'EIO' });
      const f = fs.files[from];
      if (!f) throw Object.assign(new Error('ENOENT: rename ' + from), { code: 'ENOENT' });
      delete fs.files[from];
      fs.files[to] = f;
    },
  };
  return fs;
}

function memLog(): Log & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push('info ' + m),
    warn: (m) => lines.push('warn ' + m),
    error: (m) => lines.push('error ' + m),
  };
}

function sample(): PersistedState {
  return {
    v: 1,
    engine: { keys: [{ dedupKey: 'cc:7', ruleId: 'check-control', firstSeenAt: 1000, lastRaisedAt: 5000, active: true }] },
    limits: { oilTempMaxC: 115, coolantTempMaxC: null, battery12vMinPercent: 60, tyrePressureDeviationBar: 0.3 },
    popupsEnabled: false,
    asciiPopups: true,
    device: { id: 'device-0123456789abcdef', secret: SECRET },
  };
}

describe('StateFile', () => {
  test('the state file round-trips and a corrupt file yields defaults without throwing', () => {
    const fs = memFs();
    const log = memLog();
    const file = new StateFile({ dir: DIR, fs, log });
    file.save(sample());
    expect(file.load()).toEqual(sample());

    fs.files[PATH] = { data: '{"v":1,"engine":', mode: 0o600 };
    expect(() => file.load()).not.toThrow();
    expect(file.load()).toEqual(defaultState());
  });

  test('defaults: no limits, pop-ups on, ascii off, device null, empty engine memory', () => {
    const state = defaultState();
    expect(state).toEqual({ v: 1, engine: { keys: [] }, limits: { ...NO_LIMITS }, popupsEnabled: true, asciiPopups: false, device: null });
    expect(Object.isFrozen(state.limits)).toBe(false);               // a copy of the frozen NO_LIMITS
    state.limits.oilTempMaxC = 1;
    expect(defaultState().limits.oilTempMaxC).toBeNull();
  });

  test.each([
    ['missing', null],
    ['not JSON', 'garbage'],
    ['wrong version', JSON.stringify({ ...sample(), v: 2 })],
    ['not an object', '[1,2,3]'],
    ['null', 'null'],
  ])('a %s file yields defaults', (_name, data) => {
    const fs = memFs();
    if (data !== null) fs.files[PATH] = { data, mode: 0o600 };
    const file = new StateFile({ dir: DIR, fs, log: memLog() });
    expect(file.load()).toEqual(defaultState());
  });

  test('a field of the wrong type falls back to its default; the rest is kept', () => {
    const fs = memFs();
    const raw = {
      ...sample(),
      limits: { oilTempMaxC: '115', coolantTempMaxC: 104, battery12vMinPercent: Infinity, tyrePressureDeviationBar: null },
      popupsEnabled: 'yes',
      device: { id: 42, secret: SECRET },
      engine: 'x',
    };
    fs.files[PATH] = { data: JSON.stringify(raw), mode: 0o600 };
    const state = new StateFile({ dir: DIR, fs, log: memLog() }).load();
    expect(state.limits).toEqual({ oilTempMaxC: null, coolantTempMaxC: 104, battery12vMinPercent: null, tyrePressureDeviationBar: null });
    expect(state.popupsEnabled).toBe(true);
    expect(state.asciiPopups).toBe(true);
    expect(state.device).toBeNull();
    expect(state.engine).toEqual({ keys: [] });
  });

  test('save writes a temp file and renames it; a failing write is logged, not thrown', () => {
    const fs = memFs();
    const log = memLog();
    const file = new StateFile({ dir: DIR + '/', fs, log });   // a trailing slash is not doubled
    file.save(sample());
    expect(fs.calls).toEqual(['write ' + PATH + '.tmp', 'rename ' + PATH + '.tmp ' + PATH]);
    expect(fs.files[PATH].mode).toBe(0o600);
    expect(PATH + '.tmp' in fs.files).toBe(false);

    fs.failWrite = true;
    expect(() => file.save(sample())).not.toThrow();
    fs.failWrite = false;
    fs.failRename = true;
    expect(() => file.save(sample())).not.toThrow();
    expect(log.lines.filter((l) => l.startsWith('warn')).length).toBe(2);
    expect(log.lines.join('\n')).toMatch(/ENOSPC/);
  });

  test('the device secret never reaches the log', () => {
    const fs = memFs();
    const log = memLog();
    const file = new StateFile({ dir: DIR, fs, log });
    fs.failWrite = true;
    file.save(sample());
    fs.files[PATH] = { data: JSON.stringify(sample()).slice(0, -3), mode: 0o600 };   // corrupt, secret inside
    file.load();
    fs.files[PATH] = { data: JSON.stringify({ ...sample(), v: 9 }), mode: 0o600 };
    file.load();
    expect(log.lines.length).toBeGreaterThan(0);
    expect(log.lines.join('\n')).not.toContain(SECRET);
  });

  test('a state that cannot be serialised is logged and nothing is written, never thrown', () => {
    const fs = memFs();
    const log = memLog();
    const file = new StateFile({ dir: DIR, fs, log });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => file.save({ ...sample(), engine: circular as never })).not.toThrow();
    expect(fs.calls).toEqual([]);
    expect(log.lines.length).toBe(1);
  });
});
