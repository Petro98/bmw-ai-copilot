/**
 * Read-only diagnostic gate: an allow-list in front of a diagnostic transport the caller hands in.
 *
 * SHIPPED DISABLED, WITH NO CALLER. Nothing in car/src constructs a ReadOnlyDiagGate, and this file
 * imports no transport (the kit's diag.js is deliberately not vendored, see car/kit/VENDORED.md). The
 * gate exists so the allow-list is reviewed and tested before any diagnostic feature is proposed to the
 * owner (spec §6, "Read-only diagnostic gate"; diagnostics stay off until the on-car checks of §12).
 *
 * Allowed, everything else throws DiagBlockedError before it can reach the transport:
 *   to one unit (target != 0xDF)
 *     22 <id> [<id> ...]   ReadDataByIdentifier, 1 to 8 two-byte identifiers
 *     01 <pid>             OBD-II current data, exactly one byte
 *     09 <pid>             OBD-II vehicle information, exactly one byte
 *   to all units (functional address 0xDF), exactly
 *     22 F1 50             which units are there and their SGBD index
 *     19 02 <mask>         active fault memory by status mask
 *     19 17 <mask> 01      info memory by status mask
 * Sources: car/kit/runtime/readonly-diag.js check() (22 with MAX_DIDS 8, 01/09 with one PID, 22 F1 50 as
 * the only functional read, no physical request to 0xDF); .research/reports/telemetry.md F5 (19 02 <mask>
 * and 19 17 <mask> 01 sent functionally to 0xDF) and F11 (22 F150, the SGBD index); spec §6.
 *
 * So sessions (10), resets (11), clearing faults (14), security access (27), communication control (28),
 * dynamic identifiers (2C), writes and coding (2E), I/O control (2F), routines (31), transfers (34-37),
 * tester present (3E), DTC settings (85), OBD 04 (clear) and 08 (control) and every other service are
 * refused, to one unit and to all units.
 */
import type { VehicleSnapshot } from '@copilot/vehicle-core';

export class DiagBlockedError extends Error {
  constructor(readonly reason: string) {
    super('diagnostic request blocked: ' + reason);
    this.name = 'DiagBlockedError';
  }
}

/** All units at once (functional request). car/kit/runtime/readonly-diag.js: `0xDF only as a functional request`. */
export const FUNCTIONAL_ADDRESS = 0xdf;
/** Identifiers in one 0x22 request: car/kit/runtime/readonly-diag.js `MAX_DIDS = 8`. */
export const MAX_IDENTIFIERS = 8;
/** One request at a time, at least this far apart: readonly-diag.js `gapMs` 25; telemetry.md F9 (Live Data, ≥ 25 ms). */
export const MIN_REQUEST_GAP_MS = 25;
/** Engine speed above 0 and below this is cranking: telemetry.md F9 (M-Copilot steady(), "rpm between 0 and 450"). */
export const CRANKING_BELOW_RPM = 450;
/** Requests waiting or in flight at once (our bound, not a vehicle fact): beyond it a request is refused. */
export const MAX_PENDING_REQUESTS = 8;

const READ_DATA_BY_IDENTIFIER = 0x22;
const OBD_CURRENT_DATA = 0x01;
const OBD_VEHICLE_INFORMATION = 0x09;
const READ_DTC_INFORMATION = 0x19;
const DTC_BY_STATUS_MASK = 0x02;             // telemetry.md F5: 19 02 <mask>
const USER_MEMORY_DTC_BY_STATUS_MASK = 0x17; // telemetry.md F5: 19 17 <mask> 01
const USER_MEMORY_SELECTION = 0x01;
const SGBD_INDEX_HIGH = 0xf1;                // telemetry.md F11: 22 F150
const SGBD_INDEX_LOW = 0x50;

/** The longest request the allow-list can pass: 22 with MAX_IDENTIFIERS two-byte identifiers. */
const MAX_REQUEST_LENGTH = 1 + 2 * MAX_IDENTIFIERS;

/**
 * A plain array holding the caller's bytes, read once by index. No method of the caller's object
 * (an Array subclass or a Proxy can override slice and friends) is ever called, so what is checked
 * is what is sent. A length beyond anything allowed is refused before any index is read.
 */
function copyRequest(request: ReadonlyArray<number>): number[] {
  if (!Array.isArray(request)) throw new DiagBlockedError('bad request');
  const length = request.length;
  if (typeof length !== 'number' || !(length >= 0 && length <= MAX_REQUEST_LENGTH) || Math.floor(length) !== length) {
    throw new DiagBlockedError('bad request length');
  }
  const copy: number[] = [];
  for (let i = 0; i < length; i++) copy.push(request[i]);
  return copy;
}

function isByte(b: unknown): b is number {
  return typeof b === 'number' && b >= 0 && b <= 0xff && Math.floor(b) === b;
}

function hex(n: number): string {
  return isByte(n) ? (n < 16 ? '0' : '') + n.toString(16).toUpperCase() : String(n);
}

function isAllowedToAllUnits(r: ReadonlyArray<number>): boolean {
  if (r.length === 3 && r[0] === READ_DATA_BY_IDENTIFIER) return r[1] === SGBD_INDEX_HIGH && r[2] === SGBD_INDEX_LOW;
  if (r[0] !== READ_DTC_INFORMATION) return false;
  if (r.length === 3) return r[1] === DTC_BY_STATUS_MASK;
  if (r.length === 4) return r[1] === USER_MEMORY_DTC_BY_STATUS_MASK && r[3] === USER_MEMORY_SELECTION;
  return false;
}

/** Throws DiagBlockedError unless `request` (service id first) is on the allow-list for `target`. */
export function assertReadOnly(target: number, request: ReadonlyArray<number>): void {
  if (!isByte(target)) throw new DiagBlockedError('bad address ' + String(target));
  if (!Array.isArray(request)) throw new DiagBlockedError('bad request');
  if (request.length === 0) throw new DiagBlockedError('empty request');
  for (let i = 0; i < request.length; i++) {
    if (!isByte(request[i])) throw new DiagBlockedError('bad request byte');
  }
  const sid = request[0];
  const dataLength = request.length - 1;
  if (target === FUNCTIONAL_ADDRESS) {
    if (isAllowedToAllUnits(request)) return;
    throw new DiagBlockedError('service ' + hex(sid) + ' in this form is not allowed to all units');
  }
  if (sid === READ_DATA_BY_IDENTIFIER) {
    if (dataLength >= 2 && dataLength <= 2 * MAX_IDENTIFIERS && dataLength % 2 === 0) return;
    throw new DiagBlockedError('22 takes 1 to ' + MAX_IDENTIFIERS + ' two-byte identifiers');
  }
  if (sid === OBD_CURRENT_DATA || sid === OBD_VEHICLE_INFORMATION) {
    if (dataLength === 1) return;
    throw new DiagBlockedError(hex(sid) + ' takes exactly one byte');
  }
  throw new DiagBlockedError('service ' + hex(sid) + ' is not allowed');
}

/**
 * Whether the car is awake and steady enough for a read (telemetry.md F9, plan Task 5): not while the
 * condition is unknown, parked, standby, starting or stopping, and not while the engine is cranking.
 */
export function diagAllowedNow(snapshot: VehicleSnapshot): { allowed: boolean; reason: string | null } {
  const condition = snapshot && snapshot.condition;
  if (!condition || condition.available !== true) return { allowed: false, reason: 'condition-unknown' };
  switch (condition.value) {
    case 'living':
    case 'ignition-on':
    case 'driving':
      break;
    default:
      return { allowed: false, reason: String(condition.value) };
  }
  const rpm = snapshot.engineRpm;
  if (rpm && rpm.available === true && typeof rpm.value === 'number' && rpm.value > 0 && rpm.value < CRANKING_BELOW_RPM) {
    return { allowed: false, reason: 'cranking' };
  }
  return { allowed: true, reason: null };
}

export interface DiagTransport { send(target: number, request: number[]): Promise<number[]> }

export interface ReadOnlyDiagGateOptions {
  enabled: () => boolean;
  snapshot: () => VehicleSnapshot;
  transport: DiagTransport;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function noop(): void {}

export class ReadOnlyDiagGate {
  /**
   * enabled() false → DiagBlockedError('disabled'); then diagAllowedNow; then assertReadOnly. One request
   * at a time, at least MIN_REQUEST_GAP_MS apart; the checks run again just before a queued request goes.
   */
  readonly send: (target: number, request: number[]) => Promise<number[]>;

  constructor(options: ReadOnlyDiagGateOptions) {
    // The transport lives only in this closure: nothing outside send() can reach it.
    const transport = options.transport;
    let pending = 0;
    let chain: Promise<unknown> = Promise.resolve();
    let nextAt = 0;

    const check = (target: number, request: ReadonlyArray<number>): void => {
      let on: boolean;
      try { on = options.enabled() === true; } catch { on = false; }
      if (!on) throw new DiagBlockedError('disabled');
      let now: { allowed: boolean; reason: string | null };
      try { now = diagAllowedNow(options.snapshot()); } catch { now = { allowed: false, reason: 'condition-unknown' }; }
      if (!now.allowed) throw new DiagBlockedError(now.reason || 'not-steady');
      assertReadOnly(target, request);
    };

    this.send = (target: number, request: number[]): Promise<number[]> => {
      let checked: number[];
      try {
        checked = copyRequest(request);   // a plain copy: what is checked is what is sent
        check(target, checked);
      } catch (e) {
        return Promise.reject(e);
      }
      if (pending >= MAX_PENDING_REQUESTS) return Promise.reject(new DiagBlockedError('queue-full'));
      pending++;
      const run = async (): Promise<number[]> => {
        try {
          // a clock jumping backwards never stretches the wait beyond one gap
          const wait = Math.min(MIN_REQUEST_GAP_MS, Math.max(0, nextAt - Date.now()));
          if (wait > 0) await sleep(wait);
          check(target, checked);
          try {
            return await transport.send(target, copyRequest(checked));
          } finally {
            nextAt = Date.now() + MIN_REQUEST_GAP_MS;
          }
        } finally {
          pending--;
        }
      };
      const result = chain.then(run, run);
      chain = result.then(noop, noop);
      return result;
    };
  }
}
