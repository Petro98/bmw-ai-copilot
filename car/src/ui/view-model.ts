/**
 * What the head-unit screens show, as plain data: built from the snapshot, the alerts, the last answer and
 * the link status, and drawn by draw-*.ts. Pure: no clock (now is passed in), no kit, no I/O.
 *
 * `signature` is what the tab shown draws, as text, so it changes exactly when something visible changes:
 * the header (tab, status marks) and that tab's content only (the assistant's answer, chips, strip and pairing;
 * the sensors tiles; the alerts list). screen.ts draws a frame only when it differs from the last one drawn.
 * A reading's receive time is in the view model only as the age text it shows («4 с тому»), so a reading
 * refreshed with the same value and the same age text does not cause a frame. Ages are counted in whole seconds
 * of the clock (`shownAge`), so every age note on the page moves on at the same moment, once a second at most,
 * not each at its own reading's phase.
 */
import { isMoving, type Reading, type Severity, type TyreSet, type VehicleSnapshot } from '@copilot/vehicle-core';
import type { AlertEvent } from '@copilot/event-engine';
import type { DialogTurn } from '@copilot/shared';
import type { LinkStatus } from '../uplink/uplink-client';
import {
  CHIPS_MOVING,
  CHIPS_PARKED,
  NOTE_BATTERY,
  NOTE_TYRE_UNIT_UNKNOWN,
  PROVENANCE_TAG,
  SEVERITY_WORD,
  TEXT_CLOCK,
  TEXT_TYRE_UNAVAILABLE,
  TEXT_UNAVAILABLE,
  TILE,
  activeSince,
  clearedAt,
  formatValue,
  noteRange,
  noteTyreTarget,
  provenanceLine,
  unavailableText,
  unitText,
} from './strings.uk';

export { CHIPS_MOVING, CHIPS_PARKED };

export type Tab = 'assistant' | 'sensors' | 'alerts';
export const TABS: readonly Tab[] = ['assistant', 'sensors', 'alerts'];

export interface Tile { label: string; value: string; unit: string | null; note: string | null; available: boolean }

export interface ViewModel {
  tab: Tab; moving: boolean;
  status: { car: boolean; network: boolean; claude: boolean };
  assistant: { question: string | null; answer: string | null; pending: boolean; error: string | null; chips: string[]; strip: Tile[] };
  sensors: Tile[];                 // eight tiles in the mockup's order
  alerts: Array<{ title: string; tag: string; severity: Severity; active: boolean }>;
  /** `note`: a line shown in place of the pairing instructions (the wrong-clock line), or null. */
  pairing: { paired: boolean; url: string | null; note: string | null };
  signature: string;               // changes exactly when something visible changes
}

export interface ViewModelInput {
  snapshot: VehicleSnapshot | null;
  alerts: ReadonlyArray<AlertEvent>;
  lastTurn: DialogTurn | null;
  pending: boolean;
  error: string | null;
  link: LinkStatus;
  tab: Tab;
  now: number;
  pairUrl: string | null;
  /** The last request failed because the head unit's clock is wrong (no request has succeeded since). */
  clockWrong?: boolean;
}

/** The alerts tab lists this many (four rows of the design's touch height fit the page; no scrolling). */
export const ALERTS_SHOWN = 4;
/** The car counts as reporting while the 1 Hz tick refreshed its snapshot this recently. */
export const CAR_FRESH_MS = 10_000;

const NOT_REPORTED: Reading<never> = { available: false, reason: 'not-reported' };
const SECOND_MS = 1000;

/**
 * A reading's age as shown: whole seconds of the clock between its receive time and now, so all age notes
 * change together when the clock passes a whole second. Never negative (a clock that went back reads «щойно»).
 */
function shownAge(at: number, now: number): number {
  return Math.max(0, Math.floor(now / SECOND_MS) - Math.floor(at / SECOND_MS)) * SECOND_MS;
}

/** `<backendUrl>/pair#d=<deviceId>&s=<secret>`, the pairing page's address; null without an address or a device. */
export function pairingUrl(backendUrl: string | null, device: { id: string; secret: string } | null): string | null {
  if (!backendUrl || !device) return null;
  const base = backendUrl.replace(/\/+$/, '');
  return `${base}/pair#d=${encodeURIComponent(device.id)}&s=${encodeURIComponent(device.secret)}`;
}

function unavailableTile(label: string, reading: Reading<unknown>): Tile {
  const reason = reading.available ? 'not-reported' : reading.reason;
  return { label, value: TEXT_UNAVAILABLE, unit: null, note: unavailableText(reason), available: false };
}

/** A number reading as a tile: value and unit, a detail line, then where it came from and its age. */
function numberTile(label: string, reading: Reading<number>, now: number, detail: string | null): Tile {
  if (!reading.available) return unavailableTile(label, reading);
  const age = provenanceLine(reading.source, shownAge(reading.at, now));
  return {
    label,
    value: formatValue(reading.value, reading.unit),
    unit: unitText(reading.unit),
    note: detail === null ? age : `${detail}\n${age}`,
    available: true,
  };
}

/** A short strip reading (label and value only); an unavailable one keeps «Недоступно» and its reason. */
function stripTile(label: string, reading: Reading<number>): Tile {
  if (!reading.available) return unavailableTile(label, reading);
  return { label, value: formatValue(reading.value, reading.unit), unit: unitText(reading.unit), note: null, available: true };
}

function gearTile(s: VehicleSnapshot, now: number): Tile {
  const gear = s.gear;
  if (!gear.available) return unavailableTile(TILE.gear, gear);
  const age = provenanceLine(gear.source, shownAge(gear.at, now));
  const mode = s.driveMode.available ? s.driveMode.value : null;
  return { label: TILE.gear, value: gear.value, unit: null, note: mode === null ? age : `${mode}\n${age}`, available: true };
}

function fuelTile(s: VehicleSnapshot, now: number): Tile {
  const range = s.range.available ? `${formatValue(s.range.value, s.range.unit)} ${unitText(s.range.unit) ?? ''}`.trim() : null;
  return numberTile(TILE.fuel, s.fuelLevel, now, noteRange(range));
}

const TYRE_ORDER: ReadonlyArray<keyof TyreSet<unknown>> = ['frontLeft', 'frontRight', 'rearLeft', 'rearRight'];

/** Four pressures in a two-by-two grid (front row, rear row), the car's targets and the oldest age. */
function tyreTile(s: VehicleSnapshot, now: number): Tile {
  const all = TYRE_ORDER.map((k) => s.tyrePressure[k]);
  const known = all.filter((r): r is Extract<Reading<number>, { available: true }> => r.available);
  if (known.length === 0) return unavailableTile(TILE.tyresBar, all[0]);
  const inBar = known.every((r) => r.unit === 'bar');
  const cell = (r: Reading<number>) => (r.available ? formatValue(r.value, inBar ? 'bar' : null) : TEXT_TYRE_UNAVAILABLE);
  const value = `${cell(all[0])} ${cell(all[1])}\n${cell(all[2])} ${cell(all[3])}`;
  const details: string[] = [];
  if (!inBar) details.push(NOTE_TYRE_UNIT_UNKNOWN);
  const t = s.tyrePressureTarget;
  if (inBar && t.frontLeft.available && t.rearLeft.available && t.frontLeft.unit === 'bar' && t.rearLeft.unit === 'bar') {
    details.push(noteTyreTarget(formatValue(t.frontLeft.value, 'bar'), formatValue(t.rearLeft.value, 'bar')));
  }
  const oldest = known.reduce((a, b) => (b.at < a.at ? b : a));
  details.push(provenanceLine(oldest.source, shownAge(oldest.at, now)));
  return { label: inBar ? TILE.tyresBar : TILE.tyres, value, unit: null, note: details.join('\n'), available: true };
}

function sensorTiles(s: VehicleSnapshot, now: number): Tile[] {
  return [
    numberTile(TILE.rpm, s.engineRpm, now, null),
    numberTile(TILE.oil, s.oilTemp, now, null),
    numberTile(TILE.coolant, s.coolantTemp, now, null),
    gearTile(s, now),
    fuelTile(s, now),
    numberTile(TILE.battery, s.battery12vCharge, now, NOTE_BATTERY),
    tyreTile(s, now),
    numberTile(TILE.intake, s.intakeTemp, now, null),
  ];
}

function emptyTiles(): Tile[] {
  return [TILE.rpm, TILE.oil, TILE.coolant, TILE.gear, TILE.fuel, TILE.battery, TILE.tyresBar, TILE.intake]
    .map((label) => unavailableTile(label, NOT_REPORTED));
}

function strip(s: VehicleSnapshot | null, moving: boolean): Tile[] {
  const r = (pick: (x: VehicleSnapshot) => Reading<number>) => (s ? pick(s) : NOT_REPORTED);
  const oil = stripTile(TILE.oil, r((x) => x.oilTemp));
  const coolant = stripTile(TILE.coolant, r((x) => x.coolantTemp));
  const range = stripTile(TILE.range, r((x) => x.range));
  if (moving) return [oil, coolant, range];
  return [oil, coolant, stripTile(TILE.battery, r((x) => x.battery12vCharge)), stripTile(TILE.fuel, r((x) => x.fuelLevel)), range];
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Active first, then critical before warning before information, then newest first. */
function alertRows(alerts: ReadonlyArray<AlertEvent>, now: number): ViewModel['alerts'] {
  return alerts
    .slice()
    .sort((a, b) => (Number(b.active) - Number(a.active))
      || (SEVERITY_RANK[a.severity] ?? 1) - (SEVERITY_RANK[b.severity] ?? 1)
      || (b.active ? b.at - a.at : (b.clearedAt ?? b.at) - (a.clearedAt ?? a.at)))
    .slice(0, ALERTS_SHOWN)
    .map((a) => {
      const when = a.active ? activeSince(a.at, now) : clearedAt(a.clearedAt ?? a.at, now);
      const severity: Severity = SEVERITY_WORD[a.severity] ? a.severity : 'warning';
      return {
        title: a.title,
        tag: `${SEVERITY_WORD[severity]} · ${PROVENANCE_TAG[a.provenance] ?? PROVENANCE_TAG['bmw-check-control']} · ${when}`,
        severity,
        active: a.active,
      };
    });
}

function anyReading(s: VehicleSnapshot): boolean {
  for (const key of Object.keys(s) as Array<keyof VehicleSnapshot>) {
    const v = s[key] as unknown;
    if (v && typeof v === 'object') {
      if ((v as { available?: unknown }).available === true) return true;
      if (key === 'tyrePressure' || key === 'tyrePressureTarget') {
        if (TYRE_ORDER.some((k) => (v as TyreSet<Reading<number>>)[k].available)) return true;
      }
    }
  }
  return false;
}

export function buildViewModel(input: ViewModelInput): ViewModel {
  const { snapshot, now } = input;
  const moving = snapshot !== null && isMoving(snapshot) === true;
  const paired = input.link !== 'unpaired';
  const network = input.link === 'ok';
  const carFresh = snapshot !== null && now - snapshot.takenAt <= CAR_FRESH_MS && anyReading(snapshot);
  // a wrong clock is shown without a question being asked; a question's own error or a pending one comes first
  const error = input.error !== null ? input.error : input.clockWrong === true && !input.pending ? TEXT_CLOCK : null;
  const turn = input.pending || error ? null : input.lastTurn;
  const body = {
    tab: input.tab,
    moving,
    status: { car: carFresh, network, claude: network && error === null },
    assistant: {
      question: turn ? turn.question : null,
      answer: turn ? turn.answer : null,
      pending: input.pending,
      error,
      chips: (moving ? CHIPS_MOVING : CHIPS_PARKED).slice(),
      strip: strip(snapshot, moving),
    },
    sensors: snapshot ? sensorTiles(snapshot, now) : emptyTiles(),
    alerts: alertRows(input.alerts, now),
    pairing: { paired, url: paired ? null : input.pairUrl, note: !paired && input.clockWrong === true ? TEXT_CLOCK : null },
  };
  return Object.assign(body, { signature: signatureOf(body) });
}

/** The header (tab and status marks) and the content of the tab shown: what drawPage draws for this model. */
function signatureOf(vm: Omit<ViewModel, 'signature'>): string {
  const header = { tab: vm.tab, status: vm.status };
  if (vm.tab === 'sensors') return JSON.stringify([header, vm.sensors]);
  if (vm.tab === 'alerts') return JSON.stringify([header, vm.alerts]);
  return JSON.stringify([header, vm.moving, vm.assistant, vm.pairing]);
}
