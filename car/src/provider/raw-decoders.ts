/**
 * Raw SOME/IP structs, as the head unit hands them to an app, turned into snapshot readings.
 *
 * Read-only by construction: this module only looks at values another component received. It never talks to
 * the car, holds no proxy and declares nothing.
 *
 * Every interface, field, member and enum spelling here comes from either the shared signal catalogue
 * (packages/vehicle-core/src/catalogue.ts) or the MIT-licensed reference code idrive7-apps@4a8deb7 under
 * .research/repos/ (cited as A:<path>:<line>); the research record is .research/reports/telemetry.md
 * F1-F3, F6, F13, F14. Where the record says a structure is undocumented (Check Control, the CBS list) it is
 * walked defensively, with bounded depth and size, and anything unexpected becomes invalid-value.
 *
 * Handlers on the head unit run this for every notification, so it allocates little: one reading per value.
 */
import { SIGNAL_CATALOGUE, available, decodeRaw, unavailable } from '@copilot/vehicle-core';
import type {
  CheckControlMessage, GearStage, Reading, ServiceItem, ServiceStatus, Severity, SignalEntry, SnapshotKey,
  VehicleCondition, VehicleSnapshot,
} from '@copilot/vehicle-core';

// The catalogue's own interfaces (CDS, Vehicle2, KombiIF, TPMS) come from SIGNAL_CATALOGUE; TPMS is named here
// because its pressures need the car's display unit (catalogue.ts:31 and :39-44).
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';

/** VehicleCondition.VehicleCondition.statusConditionVehicle, notify only ('s'): A:kit/runtime/car.js:66 and :140-141 (the field), A:apps/redline/app.json signals (flag 's'). */
const CONDITION = 'de.bmw.infrastructure.VehicleCondition';
/** statusGearboxDrive and DataPowerTrain2, event only ('s', no getter, telemetry.md F2): A:kit/runtime/car.js:29-56, A:apps/live_data/app.json signals. */
const VEHICLE_INFORMATION = 'de.bmw.infrastructure.VehicleInformation';
/** statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience: A:apps/live_data/signals.js:110, A:apps/live_data/app.json signals. */
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
/** statusNewCurrentUnitsStatusExt.unitOfMeasurementAirPressure (the car's display units): A:apps/redline/tyres.js:26 and :114, A:apps/car_vitals/app.json signals. */
const VEHICLE = 'de.bmw.infotainment.vehicle.Vehicle';
/** basicList (ccmId, activeState): A:apps/dtc_scanner/main.js:125-131, A:apps/dtc_scanner/app.json signals. */
const CHECK_CONTROL_MASTER = 'de.bmw.infotainment.checkcontrol.CheckControlMaster';
/** ccList / newCCMessage (Check Control texts) and cbsDataServiceList (CBS): A:apps/dtc_scanner/main.js:120-133, A:apps/service/main.js:286-293. */
const KOMBI2 = 'de.bmw.infotainment.KombiInterface_2';

/** One SOME/IP interface the provider watches, and what it feeds. app.json "signals" lists exactly these. */
export interface RawInterface {
  readonly iface: string;
  readonly fields: ReadonlyArray<string>;
  /** a car may never notify these fields: their getters are read every POLL_MS (catalogue transport 'polled') */
  readonly polled: boolean;
  /** essential interfaces are not "_optional" in app.json: a unit without one refuses the app */
  readonly essential: boolean;
  /** the readings that are not-on-this-vehicle when the unit's firmware lacks the interface */
  readonly keys: ReadonlyArray<SnapshotKey>;
}

/** Engine speed and vehicle speed (plus vehicle condition, below) are essential, never optional. */
const ESSENTIAL_KEYS: ReadonlyArray<string> = ['engineRpm', 'speed'];

function topKey(key: string): SnapshotKey {
  const dot = key.indexOf('.');
  return (dot < 0 ? key : key.slice(0, dot)) as SnapshotKey;
}

function catalogueInterfaces(): RawInterface[] {
  const out: Array<{ iface: string; fields: string[]; polled: boolean; essential: boolean; keys: SnapshotKey[] }> = [];
  for (const entry of SIGNAL_CATALOGUE) {
    let item = out.find((r) => r.iface === entry.iface);
    if (!item) {
      item = { iface: entry.iface, fields: [], polled: false, essential: false, keys: [] };
      out.push(item);
    }
    if (item.fields.indexOf(entry.field) < 0) item.fields.push(entry.field);
    if (entry.transport === 'polled') item.polled = true;
    if (ESSENTIAL_KEYS.indexOf(entry.key) >= 0) item.essential = true;
    const key = topKey(entry.key);
    if (item.keys.indexOf(key) < 0) item.keys.push(key);
  }
  return out;
}

export const RAW_INTERFACES: ReadonlyArray<RawInterface> = Object.freeze(catalogueInterfaces().concat([
  { iface: CONDITION, fields: ['VehicleCondition'], polled: false, essential: true, keys: ['condition'] },
  { iface: VEHICLE_INFORMATION, fields: ['statusGearboxDrive', 'DataPowerTrain2'], polled: false, essential: false, keys: ['gear', 'gearStage'] },
  { iface: FES, fields: ['statusFESVehicleDynamicSwitchHMI'], polled: false, essential: false, keys: ['driveMode'] },
  { iface: VEHICLE, fields: ['statusNewCurrentUnitsStatusExt'], polled: false, essential: false, keys: [] },
  { iface: CHECK_CONTROL_MASTER, fields: ['basicList'], polled: false, essential: false, keys: ['checkControl'] },
  { iface: KOMBI2, fields: ['ccList', 'newCCMessage', 'cbsDataServiceList'], polled: false, essential: false, keys: ['serviceItems'] },
]));

/** Readings only an active diagnostic read could give (telemetry.md F3-F5): always diagnostics-disabled here. */
export const DIAGNOSTIC_ONLY_KEYS: ReadonlyArray<SnapshotKey> = ['battery12vVoltage', 'intakeTemp', 'boostPressure', 'engineLoad', 'faultCodes'];

/** Readings that legitimately change rarely: they keep their value and their original `at` instead of going stale. */
export const STALE_EXEMPT_KEYS: ReadonlyArray<SnapshotKey> = ['odometer', 'serviceItems', 'checkControl'];

/** Bounds, so nothing a car (or a broken struct) sends can grow without limit. */
const MAX_CHECK_CONTROL = 64;
const MAX_CHECK_CONTROL_TEXTS = 64;
const MAX_SERVICE_ITEMS = 32;
const MAX_TEXT = 80;
const MAX_DEPTH = 8;
const MAX_NODES = 1024;

type PressureUnit = 'bar' | 'kPa' | 'psi';
interface CheckControlActive { id: number; since: number }
interface CheckControlText { text: string | null; colour: unknown }

/** What decoding has to remember between notifications. Plain objects, bounded (see the MAX_ constants). */
export interface DecoderState {
  /** the car's tyre-pressure display unit, null until Vehicle.statusNewCurrentUnitsStatusExt says */
  pressureUnit: PressureUnit | null;
  /** the master list has arrived at least once */
  checkControlKnown: boolean;
  checkControlActive: Record<string, CheckControlActive>;
  checkControlActiveCount: number;
  checkControlTexts: Record<string, CheckControlText>;
  checkControlTextCount: number;
}

export function createDecoderState(): DecoderState {
  return {
    pressureUnit: null,
    checkControlKnown: false,
    checkControlActive: Object.create(null) as Record<string, CheckControlActive>,
    checkControlActiveCount: 0,
    checkControlTexts: Object.create(null) as Record<string, CheckControlText>,
    checkControlTextCount: 0,
  };
}

/* ---------- small, never-throwing helpers ---------- */

type Struct = Record<string, unknown>;

function hasOwn(o: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function isStruct(v: unknown): v is Struct {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function member(v: unknown, name: string): unknown {
  return isStruct(v) && hasOwn(v, name) ? v[name] : undefined;
}

/** A raw number; a string of digits counts too (A:apps/live_data/signals.js:169). */
function rawNumber(x: unknown): number | null {
  if (typeof x === 'number') return isFinite(x) ? x : null;
  if (typeof x === 'string' && /^\d{1,10}$/.test(x)) return Number(x);
  return null;
}

/** A whole non-negative id (Check Control and CBS identifiers), else null. */
function idOf(x: unknown): number | null {
  const n = rawNumber(x);
  return n !== null && n >= 0 && Math.floor(n) === n ? n : null;
}

/** The car's own text: control characters removed, trimmed, bounded; null when nothing is left. */
function carText(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const t = x.slice(0, 4 * MAX_TEXT).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_TEXT).trim();
  return t.length > 0 ? t : null;
}

/** Calls fn on every struct inside v (arrays and nested structs), with bounded depth and node count. */
function walk(v: unknown, fn: (o: Struct) => void): void {
  let budget = MAX_NODES;
  const visit = (o: unknown, depth: number): void => {
    if (budget <= 0 || depth > MAX_DEPTH || typeof o !== 'object' || o === null) return;
    budget--;
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length && budget > 0; i++) visit(o[i], depth + 1);
      return;
    }
    const s = o as Struct;
    fn(s);
    for (const k of Object.keys(s)) {
      if (budget <= 0) return;
      if (typeof s[k] === 'object' && s[k] !== null) visit(s[k], depth + 1);
    }
  };
  visit(v, 0);
}

/** The struct holding `key` somewhere inside v (unions arrive wrapped in their member's name: A:apps/service/main.js:197-206). */
function findHolding(v: unknown, key: string, depth = 0): Struct | null {
  if (depth > MAX_DEPTH || typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const s = v as Struct;
  if (hasOwn(s, key)) return s;
  for (const k of Object.keys(s)) {
    const found = findHolding(s[k], key, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Writes a reading under a catalogue key ('engineRpm' or 'tyrePressure.frontLeft'). Assign only. */
function put(s: VehicleSnapshot, key: string, reading: Reading<unknown>): void {
  const dot = key.indexOf('.');
  if (dot < 0) {
    (s as unknown as Record<string, Reading<unknown>>)[key] = reading;
    return;
  }
  const group = (s as unknown as Record<string, Record<string, Reading<unknown>>>)[key.slice(0, dot)];
  if (isStruct(group)) group[key.slice(dot + 1)] = reading;
}

/** Marks every reading under a snapshot key (all four wheels of a tyre set) with the same unavailable reason. */
export function markUnavailable(s: VehicleSnapshot, key: SnapshotKey, reason: 'not-on-this-vehicle' | 'diagnostics-disabled'): void {
  const current = s[key] as unknown;
  if (isStruct(current) && !hasOwn(current, 'available')) {
    for (const wheel of Object.keys(current)) (current as Record<string, Reading<unknown>>)[wheel] = unavailable(reason);
    return;
  }
  put(s, key, unavailable(reason));
}

/* ---------- vehicle condition ---------- */

// VehicleCondition.statusConditionVehicle: names or wire numbers (A:kit/runtime/car.js:36-42):
// 1 PARKEN_BN_NIO, 2 PARKEN_BN_IO, 3 STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG, 5 WOHNEN, 7 PRUEFEN_ANALYSE_DIAGNOSE,
// 8 FAHRBEREITSCHAFT_HERSTELLEN, 10 FAHREN, 12 FAHRBEREITSCHAFT_BEENDEN; 15 = no value.
const CONDITION_NUMBERS: Record<string, number> = {
  PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3, WOHNEN: 5,
  PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12,
};
const CONDITIONS: Record<string, VehicleCondition> = {
  1: 'parked', 2: 'parked', 3: 'standby', 5: 'living', 7: 'ignition-on', 8: 'starting', 10: 'driving', 12: 'stopping',
};

/** Names or numbers: 1,2 → parked; 3 → standby; 5 → living; 7 → ignition-on; 8 → starting; 10 → driving; 12 → stopping; else null. */
export function conditionFromRaw(raw: unknown): VehicleCondition | null {
  let n: number | null = null;
  if (typeof raw === 'number' && isFinite(raw)) n = raw;
  else if (typeof raw === 'string' && hasOwn(CONDITION_NUMBERS, raw)) n = CONDITION_NUMBERS[raw];
  if (n === null || Math.floor(n) !== n || !hasOwn(CONDITIONS, String(n))) return null;
  return CONDITIONS[String(n)];
}

/* ---------- gear ---------- */

// statusGearboxDrive.statusActualStageDrive: P = 1, R = 2, N = 3, D = 4, or the names (A:kit/runtime/car.js:32-34).
const STAGES: Record<string, GearStage> = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };

/** statusActualGearDrive: G1..G10 or wire numbers G1 = 3 ... G10 = 12 (A:kit/runtime/car.js:29-31); R / N_OR_P carry no number. */
function forwardGear(x: unknown): number | null {
  if (typeof x === 'number') return x >= 3 && x <= 12 && Math.floor(x) === x ? x - 2 : null;
  const m = typeof x === 'string' ? /^G(\d{1,2})$/.exec(x) : null;
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 10 ? n : null;
}

function applyGearbox(s: VehicleSnapshot, v: unknown, now: number): void {
  const st = member(v, 'statusActualStageDrive');
  const stage = (typeof st === 'string' || typeof st === 'number') && hasOwn(STAGES, String(st)) ? STAGES[String(st)] : null;
  if (stage === null) {
    s.gearStage = unavailable('invalid-value');
    s.gear = unavailable('invalid-value');
    return;
  }
  const n = stage === 'D' ? forwardGear(member(v, 'statusActualGearDrive')) : null;
  s.gearStage = available(stage, null, 'passive-signal', now);
  s.gear = available(n === null ? stage : 'D' + n, null, 'passive-signal', now);
}

/** DataPowerTrain2.statusGearSelectionDrive: N = 1, R = 2, P = 3, NP = 4, _1 = 5 ... _9 = 13 (A:kit/runtime/car.js:43-56). */
function applyGearSelection(s: VehicleSnapshot, v: unknown, now: number): void {
  const x = member(v, 'statusGearSelectionDrive');
  let n: number | null = null;
  if (typeof x === 'number') n = x;
  else if (typeof x === 'string') {
    const names: Record<string, number> = { N: 1, R: 2, P: 3, NP: 4 };
    if (hasOwn(names, x)) n = names[x];
    else if (/^_\d$/.test(x)) n = 4 + Number(x.slice(1));
  }
  if (n === 1 || n === 2 || n === 3) {
    const stage: GearStage = n === 1 ? 'N' : n === 2 ? 'R' : 'P';
    s.gearStage = available(stage, null, 'passive-signal', now);
    s.gear = available(stage, null, 'passive-signal', now);
  } else if (n === 4) {
    // N or P, not told apart (A:kit/runtime/car.js:53): a known N or P stage stays and is the gear; any other
    // stage (R, D) is now wrong, so stage and gear become unknown. A stale R would keep isReversing() true and
    // suppress every alert in the event engine (packages/event-engine/src/rules/index.ts).
    const st = s.gearStage;
    if (st.available && (st.value === 'P' || st.value === 'N')) {
      s.gear = available(st.value, null, 'passive-signal', now);
    } else {
      s.gearStage = unavailable('invalid-value');
      s.gear = unavailable('invalid-value');
    }
  } else if (n !== null && n >= 5 && n <= 13 && Math.floor(n) === n) {
    s.gearStage = available('D', null, 'passive-signal', now);
    s.gear = available('D' + (n - 4), null, 'passive-signal', now);
  } else {
    s.gearStage = unavailable('invalid-value');
    s.gear = unavailable('invalid-value');
  }
}

/* ---------- driving mode ---------- */

// actualValueModeDrivingExperience: A:apps/live_data/signals.js:110 (telemetry.md F2); null = no data.
const DRIVE_MODES: Record<string, string | null> = {
  SPORT_DYNAMIC: 'Sport', SPORT_EXPERT: 'Sport plus', ECO_PRO_EFFICIENT: 'Eco pro',
  1: 'Sport', 2: 'Sport plus', 3: 'Sport individual', 4: 'Comfort', 5: 'Comfort plus', 6: 'Comfort individual',
  7: 'Eco pro', 8: 'Eco pro plus', 9: 'Eco pro individual', 10: 'Adaptive', 0: null, 61: null, 62: null, 63: null,
};
/** Enum names that mean "no value" (A:apps/live_data/signals.js:35). */
const NO_ENUM = /UNGUELTIG|UNBEFUELLT|INITIALISIERUNG|NICHT_VERFUEGBAR|RESERVIERT|FEHLER/;

function applyDriveMode(s: VehicleSnapshot, v: unknown, now: number): void {
  const raw = member(v, 'actualValueModeDrivingExperience');
  let mode: string | null = null;
  if ((typeof raw === 'number' || typeof raw === 'string') && hasOwn(DRIVE_MODES, String(raw))) mode = DRIVE_MODES[String(raw)];
  else if (typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(raw) && !NO_ENUM.test(raw)) mode = raw;   // a name the table lacks: the car's own
  s.driveMode = mode === null ? unavailable('invalid-value') : available(mode, null, 'passive-signal', now);
}

/* ---------- catalogue values and tyres ---------- */

const ENTRIES_BY_FIELD: Record<string, SignalEntry[]> = Object.create(null) as Record<string, SignalEntry[]>;
for (const entry of SIGNAL_CATALOGUE) {
  const k = entry.iface + '#' + entry.field;
  (ENTRIES_BY_FIELD[k] = ENTRIES_BY_FIELD[k] || []).push(entry);
}

/** Tyre pressure arrives as 0.1 x raw in the car's display unit (catalogue.ts:39-44): kPa ÷ 100 and psi × 0.0689476 give bar. */
const TO_BAR: Record<PressureUnit, number> = { bar: 1, kPa: 0.01, psi: 0.0689476 };

/** unitOfMeasurementAirPressure: 1 BAR, 2 KPA, 3 PSI, or the names (A:apps/redline/tyres.js:26 and :32). */
function pressureUnitOf(x: unknown): PressureUnit | null {
  if (x === 1 || x === 'BAR') return 'bar';
  if (x === 2 || x === 'KPA') return 'kPa';
  if (x === 3 || x === 'PSI') return 'psi';
  return null;
}

function applyCatalogue(s: VehicleSnapshot, entries: SignalEntry[], v: unknown, now: number, state: DecoderState): void {
  const struct = isStruct(v) ? v : null;
  for (const e of entries) {
    const raw = struct !== null && e.member !== null ? rawNumber(member(struct, e.member)) : null;
    const value = raw === null ? null : decodeRaw(e, raw);
    if (value === null) {
      put(s, e.key, unavailable('invalid-value'));
      continue;
    }
    const source = e.transport === 'polled' ? 'polled-signal' : 'passive-signal';
    if (e.iface === TPMS && e.unit === null) {
      const unit = state.pressureUnit;
      put(s, e.key, unit === null ? available(value, null, source, now) : available(value * TO_BAR[unit], 'bar', source, now));
    } else {
      put(s, e.key, available(value, e.unit, source, now));
    }
  }
}

/* ---------- Check Control ---------- */

/**
 * Severity from the cluster's colour (cCColor). The colour set is undocumented (telemetry.md F13); the names are
 * the reference's own Check Control colour table (A:apps/dtc_scanner/main.js:423 `COL = { RED: crit, YELLOW: warn,
 * ORANGE: warn, GREEN: GO, WHITE: text }`): RED → critical, YELLOW / ORANGE → warning, GREEN and WHITE (drawn
 * there as neutral, not as a warning) → info. Anything else is not in that table, and neither are wire numbers
 * for cCColor (the kit says enums may arrive as numbers, A:kit/runtime/car.js:30, but no reference gives this
 * enum's numbers; DEFAULT is a CBS colour, A:apps/service/main.js:81, not a Check Control one): the safest
 * meaning, warning (shown and popped up), is used for them.
 */
function severityOf(colour: unknown): Severity {
  if (colour === 'RED') return 'critical';
  if (colour === 'YELLOW' || colour === 'ORANGE') return 'warning';
  if (colour === 'GREEN' || colour === 'WHITE') return 'info';
  return 'warning';
}

function rebuildCheckControl(s: VehicleSnapshot, state: DecoderState, now: number): void {
  const list: CheckControlMessage[] = [];
  for (const k of Object.keys(state.checkControlActive)) {
    const a = state.checkControlActive[k];
    const t = state.checkControlTexts[k];
    list.push({ id: a.id, text: t ? t.text : null, severity: severityOf(t ? t.colour : undefined), since: a.since });
  }
  list.sort((x, y) => x.since - y.since || x.id - y.id);
  s.checkControl = available(list, null, 'passive-signal', now);
}

/** CheckControlMaster.basicList: entries with ccmId; activeState 'AKTIV' or 0 = active, anything else removes it (A:apps/dtc_scanner/main.js:125-131). */
function applyCheckControlMaster(s: VehicleSnapshot, v: unknown, now: number, state: DecoderState): void {
  if (typeof v !== 'object' || v === null) {
    s.checkControl = unavailable('invalid-value');
    return;
  }
  walk(v, (o) => {
    if (!hasOwn(o, 'ccmId')) return;
    const id = idOf(o.ccmId);
    if (id === null) return;
    const k = String(id);
    const on = o.activeState === 'AKTIV' || o.activeState === 0;
    const known = hasOwn(state.checkControlActive, k);
    if (on && !known && state.checkControlActiveCount < MAX_CHECK_CONTROL) {
      state.checkControlActive[k] = { id, since: now };
      state.checkControlActiveCount++;
    } else if (!on && known) {
      delete state.checkControlActive[k];
      state.checkControlActiveCount--;
    }
  });
  state.checkControlKnown = true;
  rebuildCheckControl(s, state, now);
}

/** Drops texts of messages that are not active, to make room. */
function pruneCheckControlTexts(state: DecoderState): void {
  for (const k of Object.keys(state.checkControlTexts)) {
    if (!hasOwn(state.checkControlActive, k)) {
      delete state.checkControlTexts[k];
      state.checkControlTextCount--;
    }
  }
}

/** KombiInterface_2.ccList / newCCMessage: cCIdentifer (BMW's spelling) or cCIdentifier, cCShortName or cCName, cCColor (A:apps/dtc_scanner/main.js:120-124). */
function applyCheckControlTexts(s: VehicleSnapshot, v: unknown, now: number, state: DecoderState): void {
  if (typeof v !== 'object' || v === null) return;    // texts only: the active ids stay as they are
  walk(v, (o) => {
    const id = idOf(hasOwn(o, 'cCIdentifer') ? o.cCIdentifer : o.cCIdentifier);
    if (id === null) return;
    const k = String(id);
    const name = carText(o.cCShortName) || carText(o.cCName);
    const old = hasOwn(state.checkControlTexts, k) ? state.checkControlTexts[k] : null;
    if (!old) {
      if (state.checkControlTextCount >= MAX_CHECK_CONTROL_TEXTS) pruneCheckControlTexts(state);
      if (state.checkControlTextCount >= MAX_CHECK_CONTROL_TEXTS) return;
      state.checkControlTextCount++;
    }
    state.checkControlTexts[k] = {
      text: name !== null ? name : old ? old.text : null,
      colour: hasOwn(o, 'cCColor') ? o.cCColor : old ? old.colour : undefined,
    };
  });
  if (state.checkControlKnown) rebuildCheckControl(s, state, now);
}

/* ---------- service list (CBS) ---------- */

/**
 * cBSColor, the CBS colour enum `{ DEFAULT: 0, RED: 1, YELLOW: 2, GREEN: 3, ORANGE: 4 }` (A:apps/service/main.js:81,
 * telemetry.md F6), read as the reference labels it (A:apps/service/main.js:51 `STATUS = ['', 'Due now',
 * 'Due soon', 'OK', 'Due soon']`, and :565 `LBL = ['', 'DUE NOW', 'DUE SOON', 'OK', 'DUE SOON']`): RED 1 → due now,
 * YELLOW 2 / ORANGE 4 → due soon, GREEN 3 → ok. The enum has no overdue colour: the reference words "overdue" only
 * from the due date it parses (:73), never from cBSColor, so nothing here maps to 'overdue' (telemetry.md F6's
 * "RED = overdue" is not what the source says). DEFAULT 0 and anything else → unknown.
 */
function serviceStatusOf(colour: unknown): ServiceStatus {
  if (colour === 'RED' || colour === 1) return 'due-now';
  if (colour === 'YELLOW' || colour === 'ORANGE' || colour === 2 || colour === 4) return 'due-soon';
  if (colour === 'GREEN' || colour === 3) return 'ok';
  return 'unknown';
}

/** cbsDataServiceList: a list (or a struct carrying it) of entries holding cBSIdentifier (A:apps/service/main.js:286-293). */
function applyServiceList(s: VehicleSnapshot, v: unknown, now: number): void {
  let list: unknown[] | null = null;
  if (Array.isArray(v)) list = v;
  else if (Array.isArray(member(v, 'cbsDataServiceList'))) list = member(v, 'cbsDataServiceList') as unknown[];
  else if (Array.isArray(member(v, 'value'))) list = member(v, 'value') as unknown[];
  if (list === null) {
    s.serviceItems = unavailable('invalid-value');
    return;
  }
  const items: ServiceItem[] = [];
  for (let i = 0; i < list.length && items.length < MAX_SERVICE_ITEMS; i++) {
    const e = findHolding(list[i], 'cBSIdentifier');
    if (!e) continue;
    const id = idOf(e.cBSIdentifier);
    if (id === null) continue;
    // cBSServcieName is BMW's own spelling; cBSServiceName is the fallback (telemetry.md F6)
    const name = carText(e.cBSServcieName) || carText(e.cBSServiceName);
    const date = carText(e.cBSServiceDate);
    const way = carText(e.cBSServiceWay);
    const due = date !== null && way !== null ? date + ', ' + way : date !== null ? date : way;
    items.push({ id, name, status: serviceStatusOf(e.cBSColor), dueText: due });
  }
  s.serviceItems = available(items, null, 'passive-signal', now);
}

/* ---------- entry point ---------- */

/**
 * Applies one notification (or getter answer) to the snapshot: mutates it in place, assign-only. Never throws
 * on any value; a field it does not know is ignored. `state` carries what decoding remembers between calls
 * (the car's pressure unit, the Check Control lists); a caller decoding a stream passes the same state each time.
 */
export function applyRaw(
  snapshot: VehicleSnapshot, iface: string, field: string, value: unknown, now: number,
  state: DecoderState = createDecoderState(),
): void {
  const entries = ENTRIES_BY_FIELD[iface + '#' + field];
  if (entries) {
    applyCatalogue(snapshot, entries, value, now, state);
    return;
  }
  if (iface === CONDITION && field === 'VehicleCondition') {
    const c = conditionFromRaw(member(value, 'statusConditionVehicle'));
    snapshot.condition = c === null ? unavailable('invalid-value') : available(c, null, 'passive-signal', now);
  } else if (iface === VEHICLE_INFORMATION && field === 'statusGearboxDrive') {
    applyGearbox(snapshot, value, now);
  } else if (iface === VEHICLE_INFORMATION && field === 'DataPowerTrain2') {
    applyGearSelection(snapshot, value, now);
  } else if (iface === FES && field === 'statusFESVehicleDynamicSwitchHMI') {
    applyDriveMode(snapshot, value, now);
  } else if (iface === VEHICLE && field === 'statusNewCurrentUnitsStatusExt') {
    state.pressureUnit = pressureUnitOf(member(value, 'unitOfMeasurementAirPressure'));
  } else if (iface === CHECK_CONTROL_MASTER && field === 'basicList') {
    applyCheckControlMaster(snapshot, value, now, state);
  } else if (iface === KOMBI2 && (field === 'ccList' || field === 'newCCMessage')) {
    applyCheckControlTexts(snapshot, value, now, state);
  } else if (iface === KOMBI2 && field === 'cbsDataServiceList') {
    applyServiceList(snapshot, value, now);
  }
}
