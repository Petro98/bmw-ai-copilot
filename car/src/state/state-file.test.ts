import { describe, expect, test } from 'vitest';
import { NO_LIMITS } from '@copilot/event-engine';
import type { FsApi } from '../platform';
import type { Log } from '../safe';
import { MAX_PENDING_ALERTS, STATE_FILE_NAME, StateFile, defaultState, type PersistedState } from './state-file';

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
    expect(file.save(sample())).toBe(true);
    expect(fs.calls).toEqual(['write ' + PATH + '.tmp', 'rename ' + PATH + '.tmp ' + PATH]);
    expect(fs.files[PATH].mode).toBe(0o600);
    expect(PATH + '.tmp' in fs.files).toBe(false);

    // a failed save says so (the caller must not count it as saved)
    fs.failWrite = true;
    expect(() => file.save(sample())).not.toThrow();
    expect(file.save(sample())).toBe(false);
    fs.failWrite = false;
    fs.failRename = true;
    expect(() => file.save(sample())).not.toThrow();
    expect(file.save(sample())).toBe(false);
    expect(log.lines.filter((l) => l.startsWith('warn')).length).toBe(4);
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
    let saved: boolean | undefined;
    expect(() => { saved = file.save({ ...sample(), engine: circular as never }); }).not.toThrow();
    expect(saved).toBe(false);
    expect(fs.calls).toEqual([]);
    expect(log.lines.length).toBe(1);
  });

  test('alerts not yet sent round-trip, at most 20 and each checked; an older file without them loads unchanged', () => {
    const fs = memFs();
    const file = new StateFile({ dir: DIR, fs, log: memLog() });
    const event = (n: number) => ({
      id: 'cc:7:' + n, ruleId: 'check-control', dedupKey: 'cc:7', provenance: 'bmw-check-control' as const, severity: 'warning' as const,
      title: 'Тиск у шинах', detail: null, at: 1000 + n, active: n % 2 === 0, clearedAt: n % 2 === 0 ? null : 2000 + n,
    });
    const withPending = { ...sample(), pendingAlerts: [event(0), event(1)] };
    expect(file.save(withPending)).toBe(true);
    expect(file.load()).toEqual(withPending);
    expect(MAX_PENDING_ALERTS).toBe(20);

    // too many: the newest 20 are kept; a damaged entry is skipped, the rest kept
    const many = Array.from({ length: 30 }, (_, i) => event(i));
    const damaged: unknown[] = [
      { ...event(40), severity: 'loud' }, { ...event(41), id: 7 }, { ...event(42), at: 'now' }, { ...event(43), active: 'yes' },
      { ...event(44), detail: 5 }, { ...event(45), clearedAt: '1' }, { ...event(46), provenance: 'elsewhere' }, null, 'x',
      { ...event(47), title: 'x'.repeat(5000) },
    ];
    fs.files[PATH] = { data: JSON.stringify({ ...sample(), pendingAlerts: damaged.concat(many) }), mode: 0o600 };
    const loaded = file.load();
    expect(loaded.pendingAlerts!.map((a) => a.id)).toEqual(many.slice(10).map((a) => a.id));
    fs.files[PATH] = { data: JSON.stringify({ ...sample(), pendingAlerts: 'nope' }), mode: 0o600 };
    expect(file.load()).toEqual(sample());
    fs.files[PATH] = { data: JSON.stringify({ ...sample(), pendingAlerts: [] }), mode: 0o600 };
    expect(file.load()).toEqual(sample());
  });
});
