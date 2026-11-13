import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { available, emptySnapshot, VehicleCondition, VehicleSnapshot } from '@copilot/vehicle-core';
import {
  assertReadOnly,
  DiagBlockedError,
  diagAllowedNow,
  FUNCTIONAL_ADDRESS,
  MAX_PENDING_REQUESTS,
  MIN_REQUEST_GAP_MS,
  ReadOnlyDiagGate,
} from './readonly-gate';

const UNIT = 0x12;
const ALL = 0xdf;

function snapshotWith(condition: VehicleCondition | null, rpm?: number): VehicleSnapshot {
  const s = emptySnapshot(0);
  if (condition !== null) s.condition = available(condition, null, 'passive-signal', 0);
  if (rpm !== undefined) s.engineRpm = available(rpm, 'rpm', 'passive-signal', 0);
  return s;
}

function refused(target: number, request: ReadonlyArray<number>): boolean {
  try {
    assertReadOnly(target, request);
    return false;
  } catch (e) {
    expect(e).toBeInstanceOf(DiagBlockedError);
    return true;
  }
}

function gate(options: { enabled?: () => boolean; snapshot?: () => VehicleSnapshot } = {}) {
  const sent: Array<{ target: number; request: number[] }> = [];
  const transport = {
    send: vi.fn((target: number, request: number[]) => {
      sent.push({ target, request });
      return Promise.resolve([0x62, 0xf1, 0x90]);
    }),
  };
  const g = new ReadOnlyDiagGate({
    enabled: options.enabled || (() => true),
    snapshot: options.snapshot || (() => snapshotWith('driving', 800)),
    transport,
  });
  return { g, transport, sent };
}

test('the functional address is 0xDF', () => {
  expect(FUNCTIONAL_ADDRESS).toBe(0xdf);
});

test.each([0x10, 0x11, 0x14, 0x27, 0x28, 0x2c, 0x2e, 0x2f, 0x31, 0x34, 0x35, 0x36, 0x37, 0x3e, 0x85])('service 0x%s is refused for a unit and for all units', (sid) => {
    expect(() => assertReadOnly(0x12, [sid, 0x01])).toThrow(DiagBlockedError);
    expect(() => assertReadOnly(0xdf, [sid, 0x01])).toThrow(DiagBlockedError);
  });

describe('every service that is not explicitly allowed is refused, whatever its length', () => {
  // UDS (ISO 14229-1) services that change something, named so a reader can check the list:
  // session control 10, reset 11, clear DTCs 14, security access 27, communication control 28,
  // authentication 29, dynamic identifiers 2C, write by identifier 2E (coding), I/O control 2F,
  // routine control 31, download/upload/transfer 34-38, write memory 3D, tester present 3E,
  // DTC settings 85, response on event 86, link control 87; KWP write by local identifier 3B.
  // OBD-II modes besides 01/09: 04 clears fault memory, 08 controls an on-board system.
  const WRITES_AND_CONTROLS = [
    0x10, 0x11, 0x14, 0x27, 0x28, 0x29, 0x2c, 0x2e, 0x2f, 0x31, 0x34, 0x35, 0x36, 0x37, 0x38, 0x3b, 0x3d, 0x3e,
    0x85, 0x86, 0x87, 0x04, 0x08,
  ];
  const ALLOWED_SIDS = [0x01, 0x09, 0x19, 0x22];

  test('named write, coding, clear, security, session, reset, routine and I/O-control services', () => {
    for (const sid of WRITES_AND_CONTROLS) {
      for (const tail of [[], [0x01], [0x01, 0x02], [0xf1, 0x50], [0x02, 0x0c], [0x17, 0xff, 0x01], [0xff, 0xff, 0xff]]) {
        expect(refused(UNIT, [sid, ...tail]), `unit ${sid.toString(16)} ${tail}`).toBe(true);
        expect(refused(ALL, [sid, ...tail]), `all ${sid.toString(16)} ${tail}`).toBe(true);
      }
    }
  });

  test('all 256 service ids: only 01, 09, 19 and 22 can ever pass', () => {
    for (let sid = 0; sid <= 0xff; sid++) {
      if (ALLOWED_SIDS.indexOf(sid) >= 0) continue;
      for (let len = 0; len <= 17; len++) {
        const tail = new Array<number>(len).fill(0x01);
        expect(refused(UNIT, [sid, ...tail])).toBe(true);
        expect(refused(ALL, [sid, ...tail])).toBe(true);
      }
    }
  });

  test('a 0x19 request to one unit is refused', () => {
    expect(refused(UNIT, [0x19, 0x02, 0x0c])).toBe(true);
    expect(refused(UNIT, [0x19, 0x17, 0xff, 0x01])).toBe(true);
  });

  test('01 and 09 are refused to all units', () => {
    expect(refused(ALL, [0x01, 0x0c])).toBe(true);
    expect(refused(ALL, [0x09, 0x02])).toBe(true);
  });
});

test('allows 22 with one to eight identifiers, refuses nine and odd lengths', () => {
  for (let ids = 1; ids <= 8; ids++) {
    const request = [0x22];
    for (let i = 0; i < ids; i++) request.push(0x44, i);
    expect(() => assertReadOnly(UNIT, request)).not.toThrow();
  }
  const nine = [0x22];
  for (let i = 0; i < 9; i++) nine.push(0x44, i);
  expect(refused(UNIT, nine)).toBe(true);
  expect(refused(UNIT, [0x22])).toBe(true);
  for (const odd of [[0x22, 0x44], [0x22, 0x44, 0x02, 0x58]]) expect(refused(UNIT, odd)).toBe(true);
  // 01 and 09 take exactly one byte
  expect(() => assertReadOnly(UNIT, [0x01, 0x0c])).not.toThrow();
  expect(() => assertReadOnly(UNIT, [0x09, 0x02])).not.toThrow();
  for (const bad of [[0x01], [0x01, 0x0c, 0x0d], [0x09], [0x09, 0x02, 0x00]]) expect(refused(UNIT, bad)).toBe(true);
});

test('allows only F150, 19 02 and 19 17 … 01 to all units; refuses 19 with any other sub-function', () => {
  expect(() => assertReadOnly(ALL, [0x22, 0xf1, 0x50])).not.toThrow();
  for (const mask of [0x00, 0x0c, 0xff]) {
    expect(() => assertReadOnly(ALL, [0x19, 0x02, mask])).not.toThrow();
    expect(() => assertReadOnly(ALL, [0x19, 0x17, mask, 0x01])).not.toThrow();
  }
  for (let sub = 0; sub <= 0xff; sub++) {
    if (sub === 0x02 || sub === 0x17) continue;
    expect(refused(ALL, [0x19, sub, 0x0c])).toBe(true);
    expect(refused(ALL, [0x19, sub, 0x0c, 0x01])).toBe(true);
  }
  // wrong shapes of the allowed ones
  for (const bad of [
    [0x19], [0x19, 0x02], [0x19, 0x02, 0x0c, 0x00], [0x19, 0x17, 0x0c], [0x19, 0x17, 0x0c, 0x02],
    [0x19, 0x17, 0x0c, 0x01, 0x00], [0x22, 0xf1, 0x90], [0x22, 0xf1], [0x22, 0xf1, 0x50, 0xf1, 0x90],
  ]) expect(refused(ALL, bad), JSON.stringify(bad)).toBe(true);
});

test('refuses a physical request addressed to 0xDF and an empty request', () => {
  // the 0x22 reads allowed to one unit are not allowed to all units
  expect(refused(ALL, [0x22, 0x44, 0x02])).toBe(true);
  expect(refused(ALL, [0x22, 0xf1, 0x90])).toBe(true);
  expect(refused(UNIT, [])).toBe(true);
  expect(refused(ALL, [])).toBe(true);
  // malformed bytes and addresses
  for (const bad of [[0x22, 0x44, 256], [0x22, -1, 0x02], [0x22, 0x44, 1.5], [0x22, 0x44, NaN], [0x122, 0x44, 0x02]])
    expect(refused(UNIT, bad), JSON.stringify(bad)).toBe(true);
  for (const target of [-1, 256, 1.5, NaN]) expect(refused(target, [0x22, 0x44, 0x02])).toBe(true);
  expect(refused(UNIT, null as unknown as number[])).toBe(true);
  expect(refused(UNIT, 'abc' as unknown as number[])).toBe(true);
  expect(refused(UNIT, { length: 3, 0: 0x22, 1: 0xf1, 2: 0x90 } as unknown as number[])).toBe(true);
});

test('diagAllowedNow follows the vehicle condition and the cranking window', () => {
  expect(diagAllowedNow(snapshotWith(null))).toEqual({ allowed: false, reason: 'condition-unknown' });
  for (const c of ['parked', 'standby', 'starting', 'stopping'] as const)
    expect(diagAllowedNow(snapshotWith(c))).toEqual({ allowed: false, reason: c });
  for (const c of ['living', 'ignition-on', 'driving'] as const)
    expect(diagAllowedNow(snapshotWith(c))).toEqual({ allowed: true, reason: null });
  for (const rpm of [1, 200, 449, 449.9]) expect(diagAllowedNow(snapshotWith('driving', rpm))).toEqual({ allowed: false, reason: 'cranking' });
  for (const rpm of [0, 450, 800]) expect(diagAllowedNow(snapshotWith('ignition-on', rpm)).allowed).toBe(true);
});

test('is blocked while disabled, while parked, while starting or stopping and while cranking', async () => {
  const cases: Array<[() => boolean, () => VehicleSnapshot, string]> = [
    [() => false, () => snapshotWith('driving', 800), 'disabled'],
    [() => 'yes' as unknown as boolean, () => snapshotWith('driving', 800), 'disabled'],
    [() => { throw new Error('settings'); }, () => snapshotWith('driving', 800), 'disabled'],
    [() => true, () => snapshotWith('parked'), 'parked'],
    [() => true, () => snapshotWith('starting'), 'starting'],
    [() => true, () => snapshotWith('stopping'), 'stopping'],
    [() => true, () => snapshotWith('ignition-on', 300), 'cranking'],
    [() => true, () => snapshotWith(null), 'condition-unknown'],
    [() => true, () => { throw new Error('no snapshot'); }, 'condition-unknown'],
  ];
  for (const [enabled, snapshot, reason] of cases) {
    const { g, transport } = gate({ enabled, snapshot });
    const err = await g.send(UNIT, [0x22, 0xf1, 0x90]).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DiagBlockedError);
    expect((err as DiagBlockedError).reason).toBe(reason);
    expect(transport.send).not.toHaveBeenCalled();
  }
  // enabled and steady, but a write is still refused before the transport
  const { g, transport } = gate();
  await expect(g.send(UNIT, [0x2e, 0xf1, 0x90, 0x00])).rejects.toBeInstanceOf(DiagBlockedError);
  expect(transport.send).not.toHaveBeenCalled();
  // an allowed read goes through
  await expect(g.send(UNIT, [0x22, 0xf1, 0x90])).resolves.toEqual([0x62, 0xf1, 0x90]);
  expect(transport.send).toHaveBeenCalledTimes(1);
});

test('the gate re-checks before sending: a queued request is dropped once the car parks or the gate is disabled', async () => {
  vi.useFakeTimers();
  try {
    for (const change of ['parked', 'disabled'] as const) {
      let condition: VehicleCondition = 'driving';
      let on = true;
      let release: (() => void) | undefined;
      const transport = {
        send: vi.fn(() => new Promise<number[]>((resolve) => { release = () => resolve([0x62]); })),
      };
      const g = new ReadOnlyDiagGate({ enabled: () => on, snapshot: () => snapshotWith(condition), transport });
      const first = g.send(UNIT, [0x22, 0x44, 0x02]);
      const second = g.send(UNIT, [0x22, 0x44, 0x03]).then(() => null, (e: unknown) => e);
      const third = g.send(UNIT, [0x22, 0x44, 0x04]).then(() => null, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.send).toHaveBeenCalledTimes(1);
      if (change === 'parked') condition = 'parked';
      else on = false;
      release!();
      await vi.advanceTimersByTimeAsync(100);
      await expect(first).resolves.toEqual([0x62]);
      expect(((await second) as DiagBlockedError).reason).toBe(change);
      expect(((await third) as DiagBlockedError).reason).toBe(change);
      expect(transport.send).toHaveBeenCalledTimes(1);
    }
  } finally {
    vi.useRealTimers();
  }
});

test('the request the transport receives is the one that was checked', async () => {
  const { g, sent } = gate();
  const request = [0x22, 0xf1, 0x90];
  const p = g.send(UNIT, request);
  request[0] = 0x2e;            // a caller changing its array after the call changes nothing
  await p;
  expect(sent).toEqual([{ target: UNIT, request: [0x22, 0xf1, 0x90] }]);
});

describe('a request object that runs its own code cannot change what is sent', () => {
  const READ = [0x22, 0xf1, 0x90];
  const WRITE = [0x2e, 0xf1, 0x90, 0x00];

  // The transport may only ever see a plain array with exactly the allowed read, or nothing.
  async function sendsOnlyTheRead(request: number[]): Promise<void> {
    const { g, sent } = gate();
    await g.send(UNIT, request).then(() => null, (e: unknown) => {
      expect(e).toBeInstanceOf(DiagBlockedError);
    });
    for (const s of sent) {
      expect(Object.getPrototypeOf(s.request)).toBe(Array.prototype);
      expect(s.request).toEqual(READ);
    }
  }

  test('an Array subclass whose slice() returns a write', async () => {
    class Shifty extends Array<number> {
      override slice(): number[] {
        const c = new Shifty();
        c.push(...READ);
        (c as unknown as { slice: () => number[] }).slice = () => WRITE.slice();
        return c;
      }
    }
    const request = new Shifty();
    request.push(...READ);
    await sendsOnlyTheRead(request);
  });

  test('a Proxy of an array whose slice() returns the read once, then a write', async () => {
    let slices = 0;
    const request = new Proxy(READ.slice(), {
      get(target, key, receiver) {
        if (key === 'slice') return () => (slices++ === 0 ? READ.slice() : WRITE.slice());
        return Reflect.get(target, key, receiver);
      },
    });
    await sendsOnlyTheRead(request);
  });

  test('a Proxy of an array whose bytes change after the first read', async () => {
    const reads: Record<string, number> = {};
    const request = new Proxy(READ.slice(), {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          reads[key] = (reads[key] || 0) + 1;
          if (reads[key] > 1) return WRITE[Number(key)];
        }
        if (key === 'length' && Object.keys(reads).length > 0) return WRITE.length;
        return Reflect.get(target, key, receiver);
      },
    });
    await sendsOnlyTheRead(request);
  });

  test('an array whose length lies is refused without the gate walking it', async () => {
    let indexReads = 0;
    const request = new Proxy(READ.slice(), {
      get(target, key, receiver) {
        if (key === 'length') return 0xffffffff;
        if (typeof key === 'string' && /^\d+$/.test(key)) indexReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const { g, transport } = gate();
    const err = await g.send(UNIT, request).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DiagBlockedError);
    expect(indexReads).toBe(0);
    expect(transport.send).not.toHaveBeenCalled();
  });
});

describe('pacing', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('paces requests at least 25 ms apart and never overlaps them', async () => {
    expect(MIN_REQUEST_GAP_MS).toBe(25);
    const spans: Array<{ start: number; end: number }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const transport = {
      send: () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const span = { start: Date.now(), end: -1 };
        spans.push(span);
        return new Promise<number[]>((resolve) => {
          setTimeout(() => { inFlight--; span.end = Date.now(); resolve([0x62]); }, 10 + spans.length * 7);
        });
      },
    };
    const g = new ReadOnlyDiagGate({ enabled: () => true, snapshot: () => snapshotWith('driving', 900), transport });
    const all = Promise.all([0, 1, 2, 3, 4].map((i) => g.send(UNIT, [0x22, 0x44, i])));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(all).resolves.toHaveLength(5);
    expect(maxInFlight).toBe(1);
    expect(spans).toHaveLength(5);
    for (let i = 1; i < spans.length; i++) expect(spans[i].start - spans[i - 1].end).toBeGreaterThanOrEqual(25);
  });

  test('a failing transport does not stall the queue and the gap still holds', async () => {
    const starts: number[] = [];
    let n = 0;
    const transport = {
      send: () => {
        starts.push(Date.now());
        return n++ === 0 ? Promise.reject(new Error('busy')) : Promise.resolve([0x62]);
      },
    };
    const g = new ReadOnlyDiagGate({ enabled: () => true, snapshot: () => snapshotWith('driving'), transport });
    const a = g.send(UNIT, [0x22, 0x44, 0x02]).then(() => 'ok', () => 'failed');
    const b = g.send(UNIT, [0x22, 0x44, 0x03]);
    await vi.advanceTimersByTimeAsync(100);
    expect(await a).toBe('failed');
    await expect(b).resolves.toEqual([0x62]);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(25);
  });

  test('the queue is bounded', async () => {
    const transport = { send: vi.fn(() => new Promise<number[]>(() => {})) };   // never answers
    const g = new ReadOnlyDiagGate({ enabled: () => true, snapshot: () => snapshotWith('driving'), transport });
    const outcomes: unknown[] = new Array(20).fill('pending');
    for (let i = 0; i < 20; i++) g.send(UNIT, [0x22, 0x44, i]).then((v) => { outcomes[i] = v; }, (e: unknown) => { outcomes[i] = e; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.send).toHaveBeenCalledTimes(1);
    for (let i = 0; i < MAX_PENDING_REQUESTS; i++) expect(outcomes[i]).toBe('pending');
    for (let i = MAX_PENDING_REQUESTS; i < 20; i++) expect((outcomes[i] as DiagBlockedError).reason).toBe('queue-full');
  });
});

test('the gate has no caller and reaches no transport of its own', () => {
  const srcDir = fileURLToPath(new URL('..', import.meta.url));
  const own = fileURLToPath(new URL('./readonly-gate.ts', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path);
    }
  };
  walk(srcDir);
  for (const file of files) {
    if (file === own) continue;
    const text = readFileSync(file, 'utf8');
    expect(text, file).not.toMatch(/readonly-gate|ReadOnlyDiagGate|assertReadOnly/);
  }
  const gateSrc = readFileSync(own, 'utf8');
  // only a type-only import of the shared vehicle contract; no require, no kit, no diag transport
  const imports = gateSrc.match(/^\s*import\b.*$/gm) || [];
  expect(imports).toEqual(["import type { VehicleSnapshot } from '@copilot/vehicle-core';"]);
  expect(gateSrc).not.toMatch(/\brequire\s*\(|\bimport\s*\(|InternalTasu|sendTasuRequest|someip|buildProxy/);
});
