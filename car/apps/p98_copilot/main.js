/* generated from car/src — do not edit */
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/main.ts
var crypto = __toESM(require("crypto"));
var nodeFs = __toESM(require("fs"));
var path = __toESM(require("path"));

// ../packages/event-engine/src/types.ts
var NO_LIMITS = Object.freeze({
  oilTempMaxC: null,
  coolantTempMaxC: null,
  battery12vMinPercent: null,
  tyrePressureDeviationBar: null
});

// ../packages/event-engine/src/engine.ts
var SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
function bySeverity(a, b) {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
}
function isFiniteNumber(value) {
  return typeof value === "number" && isFinite(value);
}
var EventEngine = class {
  constructor(options) {
    this.rulesById = /* @__PURE__ */ new Map();
    this.keys = /* @__PURE__ */ new Map();
    /** Times of events raised within the current window, oldest first; never longer than maxRaisedPerWindow. */
    this.raisedAt = [];
    /** Newest first, at most options.historySize. */
    this.events = [];
    /** `now` of the previous evaluate() call; null before the first one (and after restore()). */
    this.lastNow = null;
    this.options = options;
    for (const rule of options.rules) {
      if (!this.rulesById.has(rule.id)) this.rulesById.set(rule.id, rule);
    }
  }
  /**
   * Events raised or cleared by this call: raised ones first (critical, warning, info), then cleared ones.
   *
   * Unknown is not gone. A rule that returns null (its data is unavailable) and a key a rule holds through
   * ctx.hold() keep their state exactly: an active alert stays active under its id and is neither cleared nor
   * raised again when its condition is reported again, and a pending key's dwell is frozen (the time of a call
   * that could not evaluate it does not count, and its dwell does not restart). Only a rule that evaluated
   * (returned an array) and did not hold a key clears it.
   */
  evaluate(snapshot, now, limits) {
    const seenThisCall = /* @__PURE__ */ new Set();
    const skippedRules = /* @__PURE__ */ new Set();
    const unknownRules = /* @__PURE__ */ new Set();
    const heldKeys = /* @__PURE__ */ new Set();
    let holding = null;
    const eligible = [];
    const ctx = {
      snapshot,
      now,
      limits,
      isActive: (dedupKey) => {
        const entry = this.keys.get(dedupKey);
        return entry !== void 0 && entry.active;
      },
      hold: (dedupKey) => {
        if (holding === null || typeof dedupKey !== "string") return;
        const entry = this.keys.get(dedupKey);
        if (entry !== void 0 && entry.ruleId === holding.rule.id) holding.keys.push(dedupKey);
      }
    };
    for (const rule of this.options.rules) {
      let candidates;
      const current = { rule, keys: [] };
      holding = current;
      try {
        candidates = rule.evaluate(ctx);
      } catch (e) {
        skippedRules.add(rule.id);
        continue;
      } finally {
        holding = null;
      }
      if (candidates === null) {
        skippedRules.add(rule.id);
        unknownRules.add(rule.id);
        continue;
      }
      if (!Array.isArray(candidates)) {
        skippedRules.add(rule.id);
        continue;
      }
      for (const key of current.keys) heldKeys.add(key);
      for (const candidate of candidates) {
        const found = this.track(rule, candidate, now, seenThisCall);
        if (found) eligible.push(found);
      }
    }
    this.freezeDwell(seenThisCall, unknownRules, heldKeys, now);
    const raised = this.raise(eligible, snapshot, now);
    const cleared = this.forgetAbsent(seenThisCall, skippedRules, heldKeys, now);
    this.lastNow = now;
    return raised.concat(cleared);
  }
  /** Currently active alerts, critical first, then newest first. */
  active() {
    const list = [];
    this.keys.forEach((entry) => {
      if (entry.active && entry.event) list.push(entry.event);
    });
    return list.sort((a, b) => bySeverity(a, b) || b.at - a.at);
  }
  /** Raised events, newest first, at most options.historySize. */
  history() {
    return this.events.slice();
  }
  /** The memory needed to survive a restart (dwell and cooldown). */
  state() {
    const keys = [];
    this.keys.forEach((entry, dedupKey) => {
      keys.push({
        dedupKey,
        ruleId: entry.ruleId,
        firstSeenAt: entry.firstSeenAt,
        lastRaisedAt: entry.lastRaisedAt,
        active: entry.active
      });
    });
    return { keys };
  }
  /**
   * Replaces the key memory with a saved state. Malformed entries and entries of unknown rules are skipped.
   * A restored active key stays active (it is not raised again) and counts as announced: its event is rebuilt
   * from the next candidate with the original id, and its clearing is returned like any other. If the key is
   * already gone before a candidate rebuilt its event, there is no event to return and it clears silently.
   * A restored key that was raised and then
   * went away keeps only its cooldown memory: its dwell starts again when it reappears.
   */
  restore(state) {
    this.keys.clear();
    this.lastNow = null;
    const list = state && Array.isArray(state.keys) ? state.keys : [];
    for (const item of list) {
      if (!item || typeof item.dedupKey !== "string" || typeof item.ruleId !== "string") continue;
      if (!this.rulesById.has(item.ruleId) || !isFiniteNumber(item.firstSeenAt)) continue;
      const lastRaisedAt = isFiniteNumber(item.lastRaisedAt) ? item.lastRaisedAt : null;
      const wasRaised = lastRaisedAt !== null;
      const active = item.active === true && wasRaised;
      this.keys.set(item.dedupKey, {
        ruleId: item.ruleId,
        firstSeenAt: item.firstSeenAt,
        seen: active || !wasRaised,
        lastRaisedAt,
        active,
        event: null,
        announced: active
        // the previous instance announced it; its clearing must reach consumers
      });
    }
  }
  /** Records one candidate; returns it when it is eligible to be raised now. */
  track(rule, candidate, now, seenThisCall) {
    if (!candidate || typeof candidate.dedupKey !== "string") return null;
    const key = candidate.dedupKey;
    if (seenThisCall.has(key)) return null;
    let entry = this.keys.get(key);
    if (entry && entry.ruleId !== rule.id) return null;
    seenThisCall.add(key);
    if (!entry) {
      entry = { ruleId: rule.id, firstSeenAt: now, seen: true, lastRaisedAt: null, active: false, event: null, announced: false };
      this.keys.set(key, entry);
    } else if (!entry.seen) {
      entry.seen = true;
      entry.firstSeenAt = now;
    }
    if (now < entry.firstSeenAt) entry.firstSeenAt = now;
    if (entry.active) {
      if (!entry.event) entry.event = this.makeEvent(rule, candidate, entry.lastRaisedAt === null ? now : entry.lastRaisedAt);
      return null;
    }
    if (now - entry.firstSeenAt < rule.dwellMs) return null;
    const last = entry.lastRaisedAt;
    if (last !== null && now >= last && now - last < rule.cooldownMs) {
      entry.active = true;
      entry.event = this.makeEvent(rule, candidate, last);
      entry.announced = false;
      return null;
    }
    return { rule, candidate, entry };
  }
  /**
   * Pending keys that could not be evaluated in this call (rule returned null, or the key was held) do not
   * advance their dwell: their firstSeenAt moves forward by the time since the previous call, so the time
   * already dwelt is kept and the unknown interval is not counted. A clock that went backwards moves nothing.
   */
  freezeDwell(seenThisCall, unknownRules, heldKeys, now) {
    if (unknownRules.size === 0 && heldKeys.size === 0) return;
    const last = this.lastNow;
    const elapsed = last !== null && now > last ? now - last : 0;
    if (elapsed === 0) return;
    this.keys.forEach((entry, key) => {
      if (seenThisCall.has(key) || !entry.seen || entry.active) return;
      if (heldKeys.has(key) || unknownRules.has(entry.ruleId)) entry.firstSeenAt += elapsed;
    });
  }
  /** Raises eligible candidates, most severe first, unless suppressed or over the global rate. */
  raise(eligible, snapshot, now) {
    if (eligible.length === 0) return [];
    if (this.isSuppressed(snapshot)) return [];
    this.trimWindow(now);
    const ordered = eligible.map((item, index) => ({ item, index })).sort((a, b) => bySeverity(a.item.candidate, b.item.candidate) || a.index - b.index);
    const raised = [];
    for (const { item } of ordered) {
      if (this.raisedAt.length >= this.options.maxRaisedPerWindow) break;
      const event = this.makeEvent(item.rule, item.candidate, now);
      item.entry.active = true;
      item.entry.lastRaisedAt = now;
      item.entry.event = event;
      item.entry.announced = true;
      this.raisedAt.push(now);
      this.remember(event);
      raised.push(event);
    }
    return raised;
  }
  /**
   * Clears active keys that were not among this call's candidates and forgets pending ones.
   * Keys of a rule skipped in this call (it threw or could not evaluate) and held keys are untouched: an
   * evaluation error or an unavailable reading is not evidence the condition went away.
   */
  forgetAbsent(seenThisCall, skippedRules, heldKeys, now) {
    const cleared = [];
    const remove = [];
    this.keys.forEach((entry, key) => {
      if (seenThisCall.has(key) || heldKeys.has(key) || skippedRules.has(entry.ruleId)) return;
      if (entry.active) {
        if (entry.announced && entry.event) {
          const event = __spreadProps(__spreadValues({}, entry.event), { active: false, clearedAt: now });
          this.replaceInHistory(event);
          cleared.push(event);
        }
        entry.active = false;
        entry.event = null;
        entry.announced = false;
      }
      entry.seen = false;
      if (this.canForget(entry, now)) remove.push(key);
    });
    for (const key of remove) this.keys.delete(key);
    return cleared;
  }
  /** A key that is gone can be forgotten once nothing about it matters: never raised, or its cooldown is over. */
  canForget(entry, now) {
    if (entry.lastRaisedAt === null) return true;
    const rule = this.rulesById.get(entry.ruleId);
    if (!rule) return true;
    return now >= entry.lastRaisedAt && now - entry.lastRaisedAt >= rule.cooldownMs;
  }
  isSuppressed(snapshot) {
    const suppress = this.options.suppress;
    if (!suppress) return false;
    try {
      return suppress(snapshot) === true;
    } catch (e) {
      return false;
    }
  }
  /** Keeps only raise times inside the window; times in the future (clock went backwards) count as now. */
  trimWindow(now) {
    const windowMs = this.options.windowMs;
    const kept = [];
    for (const at of this.raisedAt) {
      const t = at > now ? now : at;
      if (now - t < windowMs) kept.push(t);
    }
    const max = Math.max(0, this.options.maxRaisedPerWindow);
    this.raisedAt = kept.length > max ? kept.slice(kept.length - max) : kept;
  }
  remember(event) {
    this.events.unshift(event);
    const size = Math.max(0, this.options.historySize);
    if (this.events.length > size) this.events.length = size;
  }
  replaceInHistory(event) {
    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i].id === event.id) {
        this.events[i] = event;
        return;
      }
    }
  }
  makeEvent(rule, candidate, at) {
    return {
      id: `${rule.id}:${candidate.dedupKey}:${at}`,
      ruleId: rule.id,
      dedupKey: candidate.dedupKey,
      provenance: rule.provenance,
      severity: candidate.severity,
      title: candidate.title,
      detail: candidate.detail,
      at,
      active: true,
      clearedAt: null
    };
  }
};

// ../packages/vehicle-core/src/reading.ts
function available(value, unit, source, at) {
  return { available: true, value, unit, source, at };
}
function unavailable(reason) {
  return { available: false, reason };
}

// ../packages/vehicle-core/src/snapshot.ts
var MOVING_ABOVE_KMH = 3;
function notReported() {
  return unavailable("not-reported");
}
function notReportedTyres() {
  return { frontLeft: notReported(), frontRight: notReported(), rearLeft: notReported(), rearRight: notReported() };
}
function emptySnapshot(now) {
  return {
    takenAt: now,
    condition: notReported(),
    engineRpm: notReported(),
    speed: notReported(),
    oilTemp: notReported(),
    coolantTemp: notReported(),
    gear: notReported(),
    gearStage: notReported(),
    driveMode: notReported(),
    fuelLevel: notReported(),
    range: notReported(),
    odometer: notReported(),
    battery12vCharge: notReported(),
    battery12vVoltage: notReported(),
    intakeTemp: notReported(),
    boostPressure: notReported(),
    engineLoad: notReported(),
    tyrePressure: notReportedTyres(),
    tyrePressureTarget: notReportedTyres(),
    checkControl: notReported(),
    serviceItems: notReported(),
    faultCodes: notReported()
  };
}
function isMoving(s) {
  if (!s.speed.available) return null;
  return s.speed.value > MOVING_ABOVE_KMH;
}
function isReversing(s) {
  return s.gearStage.available && s.gearStage.value === "R";
}

// ../packages/vehicle-core/src/catalogue.ts
var REPO = "idrive7-apps@4a8deb7";
var CDS = "de.bmw.infotainment.vehicle.CDS";
var VEHICLE2 = "de.bmw.infotainment.vehicle.Vehicle2";
var KOMBI = "de.bmw.infotainment.KombiIF";
var TPMS = "de.bmw.infotainment.vehicle.TPMS";
var CORNERS = [
  ["frontLeft", "FLH"],
  ["frontRight", "FRH"],
  ["rearLeft", "RLH"],
  ["rearRight", "RRH"]
];
function tyreEntries(prefix, field, memberPrefix, sourceLine) {
  return CORNERS.map(([corner, suffix]) => ({
    key: `${prefix}.${corner}`,
    iface: TPMS,
    field,
    member: memberPrefix + suffix,
    transport: "polled",
    factor: 0.1,
    offset: 0,
    invalidFrom: 65532,
    unit: null,
    verified: true,
    source: `${REPO}:apps/redline/tyres.js:${sourceLine}`
  }));
}
var ENTRIES = [
  // CDS.statusEngineSpeed2.actualValueRPMEngineCrankshaft, k 0.25, 65535 = no value (also kit/runtime/car.js:22).
  {
    key: "engineRpm",
    iface: CDS,
    field: "statusEngineSpeed2",
    member: "actualValueRPMEngineCrankshaft",
    transport: "passive",
    factor: 0.25,
    offset: 0,
    invalidFrom: 65535,
    unit: "rpm",
    verified: true,
    source: `${REPO}:apps/live_data/signals.js:63`
  },
  // Vehicle2.statusCarSpeed2.speedVehicleCentreOfGravity, k 0.015625, 65535 = no value (also kit/runtime/car.js:23).
  {
    key: "speed",
    iface: VEHICLE2,
    field: "statusCarSpeed2",
    member: "speedVehicleCentreOfGravity",
    transport: "passive",
    factor: 0.015625,
    offset: 0,
    invalidFrom: 65535,
    unit: "km/h",
    verified: true,
    source: `${REPO}:apps/live_data/signals.js:108`
  },
  // CDS.statusEngineTemperature.temperatureEngineOilDrive, factor 1 (k omitted, signals.js:180), offset -48,
  // 255 = no value (also kit/runtime/car.js:25).
  {
    key: "oilTemp",
    iface: CDS,
    field: "statusEngineTemperature",
    member: "temperatureEngineOilDrive",
    transport: "passive",
    factor: 1,
    offset: -48,
    invalidFrom: 255,
    unit: "°C",
    verified: true,
    source: `${REPO}:apps/live_data/signals.js:75`
  },
  // CDS.statusEngineTemperature.temperatureEngineDrive, factor 1, offset -48, 255 = no value.
  {
    key: "coolantTemp",
    iface: CDS,
    field: "statusEngineTemperature",
    member: "temperatureEngineDrive",
    transport: "passive",
    factor: 1,
    offset: -48,
    invalidFrom: 255,
    unit: "°C",
    verified: true,
    source: `${REPO}:apps/live_data/signals.js:74`
  },
  // KombiIF.statusRangeTankStatus.fluidLevelFuelTank, litres, factor 1, 255 and up = no value.
  // KombiIF may never notify, so it is read every 10 s: apps/live_data/signals.js:27-28.
  {
    key: "fuelLevel",
    iface: KOMBI,
    field: "statusRangeTankStatus",
    member: "fluidLevelFuelTank",
    transport: "polled",
    factor: 1,
    offset: 0,
    invalidFrom: 255,
    unit: "l",
    verified: true,
    source: `${REPO}:apps/live_data/signals.js:81`
  },
  // Same field, member range, km, 4095 and up = no value.
  {
    key: "range",
    iface: KOMBI,
    field: "statusRangeTankStatus",
    member: "range",
    transport: "polled",
    factor: 1,
    offset: 0,
    invalidFrom: 4095,
    unit: "km",
    verified: true,
    source: `${REPO}:apps/live_data/signals.js:84`
  },
  // Same field, member mileageKilometre, km, 16777215 and up = no value.
  {
    key: "odometer",
    iface: KOMBI,
    field: "statusRangeTankStatus",
    member: "mileageKilometre",
    transport: "polled",
    factor: 1,
    offset: 0,
    invalidFrom: 16777215,
    unit: "km",
    verified: true,
    source: `${REPO}:apps/live_data/signals.js:85`
  },
  // CDS.statusBattery2.conditionBatteryChargingCondition, a charge percentage (not volts). Redline and eDrive
  // accept only 0..100 (apps/redline/electrical.js:102, apps/edrive/main.js:338), so 101 and up = no value.
  // Live Data is looser (151 and up = no value, apps/live_data/signals.js:120); the stricter bound is kept.
  {
    key: "battery12vCharge",
    iface: CDS,
    field: "statusBattery2",
    member: "conditionBatteryChargingCondition",
    transport: "passive",
    factor: 1,
    offset: 0,
    invalidFrom: 101,
    unit: "%",
    verified: true,
    source: `${REPO}:apps/redline/electrical.js:102`
  },
  // TPMS.statusTyrePressure.actualValuePressureTyre{FLH,FRH,RLH,RRH}: apps/redline/tyres.js:9.
  ...tyreEntries("tyrePressure", "statusTyrePressure", "actualValuePressureTyre", 9),
  // TPMS.statusTargetTyrePressure.targetPressureTyre{FLH,FRH,RLH,RRH}, the same scaling: apps/redline/tyres.js:11.
  ...tyreEntries("tyrePressureTarget", "statusTargetTyrePressure", "targetPressureTyre", 11)
];
var SIGNAL_CATALOGUE = Object.freeze(ENTRIES.map((e) => Object.freeze(e)));
function decodeRaw(entry, raw) {
  if (typeof raw !== "number" || !isFinite(raw)) return null;
  if (entry.invalidFrom !== null && raw >= entry.invalidFrom) return null;
  return raw * entry.factor + entry.offset;
}

// ../packages/vehicle-core/src/mock/scenarios.ts
var SECOND = 1e3;
var MINUTE = 60 * SECOND;

// ../packages/event-engine/src/rules/check-control.ts
var TEN_MINUTES_MS = 6e5;
function checkControlRule() {
  return {
    id: "check-control",
    provenance: "bmw-check-control",
    dwellMs: 4e3,
    cooldownMs: TEN_MINUTES_MS,
    evaluate(ctx) {
      const reading = ctx.snapshot.checkControl;
      if (!reading.available || !Array.isArray(reading.value)) return null;
      const out = [];
      for (const message of reading.value) {
        if (!message) continue;
        const text2 = typeof message.text === "string" ? message.text.trim() : "";
        out.push({
          dedupKey: `cc:${message.id}`,
          severity: message.severity,
          title: text2 !== "" ? text2 : `Повідомлення Check Control ${message.id}`,
          detail: null
        });
      }
      return out;
    }
  };
}

// ../packages/event-engine/src/rules/fault-status.ts
function faultStatusRule() {
  return {
    id: "fault-status",
    provenance: "bmw-fault-status",
    dwellMs: 0,
    cooldownMs: TEN_MINUTES_MS,
    evaluate(ctx) {
      const reading = ctx.snapshot.faultCodes;
      if (!reading.available || !Array.isArray(reading.value)) return null;
      const out = [];
      for (const fault of reading.value) {
        if (!fault || fault.activeNow !== true || fault.warningLamp !== true) continue;
        const text2 = typeof fault.text === "string" ? fault.text.trim() : "";
        out.push({
          dedupKey: `fault:${fault.ecu}:${fault.code}`,
          severity: "warning",
          title: text2 !== "" ? text2 : `Помилка ${fault.code} (${fault.ecu})`,
          detail: null
        });
      }
      return out;
    }
  };
}

// ../packages/event-engine/src/rules/owner-limits.ts
var TEMPERATURE_EXIT_MARGIN_C = 2;
var BATTERY_EXIT_MARGIN_PERCENT = 2;
var TYRE_EXIT_MARGIN_BAR = 0.05;
var WHEELS = [
  { wheel: "frontLeft", uk: "передня ліва" },
  { wheel: "frontRight", uk: "передня права" },
  { wheel: "rearLeft", uk: "задня ліва" },
  { wheel: "rearRight", uk: "задня права" }
];
function isFiniteNumber2(value) {
  return typeof value === "number" && isFinite(value);
}
function valueIn(reading, unit) {
  if (!reading.available || reading.unit !== unit || !isFiniteNumber2(reading.value)) return null;
  return reading.value;
}
function formatNumber(value, fixed) {
  const rounded = Math.round(value * 10) / 10;
  const text2 = fixed ? rounded.toFixed(1) : String(rounded === 0 ? 0 : rounded);
  return text2.replace(".", ",");
}
function limitOf(limits, name) {
  const limit = limits ? limits[name] : null;
  return isFiniteNumber2(limit) ? limit : null;
}
function maxTemperature(ctx, name, reading, label2) {
  const limit = limitOf(ctx.limits, name);
  if (limit === null) return null;
  const dedupKey = `limit:${name}`;
  const value = valueIn(reading, "°C");
  if (value === null) {
    ctx.hold(dedupKey);
    return null;
  }
  const over = ctx.isActive(dedupKey) ? value > limit - TEMPERATURE_EXIT_MARGIN_C : value > limit;
  if (!over) return null;
  return {
    dedupKey,
    severity: "warning",
    title: `${label2} ${formatNumber(value, false)} °C — вище вашого ліміту ${formatNumber(limit, false)} °C`,
    detail: null
  };
}
function minBattery(ctx) {
  const limit = limitOf(ctx.limits, "battery12vMinPercent");
  if (limit === null) return null;
  const dedupKey = "limit:battery12vMinPercent";
  const value = valueIn(ctx.snapshot.battery12vCharge, "%");
  if (value === null) {
    ctx.hold(dedupKey);
    return null;
  }
  const under = ctx.isActive(dedupKey) ? value < limit + BATTERY_EXIT_MARGIN_PERCENT : value < limit;
  if (!under) return null;
  return {
    dedupKey,
    severity: "warning",
    title: `Акумулятор 12 В ${formatNumber(value, false)} % — нижче вашого ліміту ${formatNumber(limit, false)} %`,
    detail: null
  };
}
function tyreDeviation(ctx) {
  const limit = limitOf(ctx.limits, "tyrePressureDeviationBar");
  if (limit === null) return [];
  const out = [];
  for (const { wheel, uk } of WHEELS) {
    const dedupKey = `limit:tyre:${wheel}`;
    const pressure = valueIn(ctx.snapshot.tyrePressure[wheel], "bar");
    const target = valueIn(ctx.snapshot.tyrePressureTarget[wheel], "bar");
    if (pressure === null || target === null) {
      ctx.hold(dedupKey);
      continue;
    }
    const deviation = Math.abs(pressure - target);
    const off = ctx.isActive(dedupKey) ? deviation > limit - TYRE_EXIT_MARGIN_BAR : deviation > limit;
    if (!off) continue;
    out.push({
      dedupKey,
      severity: "warning",
      title: `Тиск у шині (${uk}) ${formatNumber(pressure, true)} бар, ціль авто ${formatNumber(target, true)} бар`,
      detail: null
    });
  }
  return out;
}
function ownerLimitsRule() {
  return {
    id: "owner-limits",
    provenance: "owner-configured",
    dwellMs: 5e3,
    cooldownMs: TEN_MINUTES_MS,
    evaluate(ctx) {
      const s = ctx.snapshot;
      const out = [];
      const oil = maxTemperature(ctx, "oilTempMaxC", s.oilTemp, "Масло");
      if (oil) out.push(oil);
      const coolant = maxTemperature(ctx, "coolantTempMaxC", s.coolantTemp, "Охолоджувальна рідина");
      if (coolant) out.push(coolant);
      const battery = minBattery(ctx);
      if (battery) out.push(battery);
      return out.concat(tyreDeviation(ctx));
    }
  };
}

// ../packages/event-engine/src/rules/service.ts
var THIRTY_DAYS_MS = 2592e6;
function serviceRule() {
  return {
    id: "service",
    provenance: "bmw-service",
    dwellMs: 0,
    cooldownMs: THIRTY_DAYS_MS,
    evaluate(ctx) {
      const reading = ctx.snapshot.serviceItems;
      if (!reading.available || !Array.isArray(reading.value)) return null;
      const out = [];
      for (const item of reading.value) {
        if (!item || item.status !== "due-soon" && item.status !== "overdue") continue;
        const name = typeof item.name === "string" && item.name.trim() !== "" ? item.name : `Сервіс ${item.id}`;
        const due = typeof item.dueText === "string" && item.dueText.trim() !== "" ? item.dueText : null;
        out.push({
          dedupKey: `service:${item.id}:${item.status}`,
          severity: item.status === "overdue" ? "warning" : "info",
          title: due === null ? name : `${name}: ${due}`,
          detail: null
        });
      }
      return out;
    }
  };
}

// ../packages/event-engine/src/rules/index.ts
function defaultRules() {
  return [checkControlRule(), serviceRule(), faultStatusRule(), ownerLimitsRule()];
}
function defaultEngineOptions() {
  return {
    rules: defaultRules(),
    maxRaisedPerWindow: 6,
    windowMs: TEN_MINUTES_MS,
    historySize: 200,
    suppress: isReversing
  };
}

// src/safe.ts
var SAFE_LOG_INTERVAL_MS = 6e4;
var MAX_LABELS = 64;
var lastLogged = /* @__PURE__ */ Object.create(null);
var labelCount = 0;
function describe(error) {
  try {
    if (error instanceof Error) return error.stack || error.message || error.name;
    return String(error);
  } catch (e) {
    return "unprintable error";
  }
}
function report(log, label2, error) {
  try {
    const now = Date.now();
    const last = lastLogged[label2];
    if (last !== void 0 && now >= last && now - last < SAFE_LOG_INTERVAL_MS) return;
    if (last === void 0) {
      if (labelCount >= MAX_LABELS) {
        lastLogged = /* @__PURE__ */ Object.create(null);
        labelCount = 0;
      }
      labelCount++;
    }
    lastLogged[label2] = now;
    log.error(label2 + ": " + describe(error));
  } catch (e) {
  }
}
function isThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}
function safe(log, label2, fn) {
  return (...args) => {
    try {
      const result = fn(...args);
      if (isThenable(result)) {
        result.then(void 0, (error) => report(log, label2, error));
      }
    } catch (error) {
      report(log, label2, error);
    }
  };
}

// src/alerts/alert-text.ts
var POPUP_TEXT_MAX = 160;
var PREFIX = {
  "bmw-check-control": "Авто повідомляє: ",
  "bmw-fault-status": "Авто повідомляє: ",
  "bmw-service": "Авто повідомляє: ",
  "owner-configured": "Ваш ліміт: "
};
function isHighSurrogate(code) {
  return code >= 55296 && code <= 56319;
}
function cutAtWord(text2, max) {
  if (text2.length <= max) return text2;
  const space = text2.lastIndexOf(" ", max);
  let cut2 = space > 0 ? space : max;
  if (cut2 === max && isHighSurrogate(text2.charCodeAt(cut2 - 1))) cut2--;
  return text2.slice(0, cut2).replace(/\s+$/, "");
}
function oneLine(text2) {
  return text2.replace(/\s+/g, " ").trim();
}
function popupText(event) {
  const prefix = PREFIX[event.provenance] || PREFIX["bmw-check-control"];
  const title = typeof event.title === "string" ? oneLine(event.title) : "";
  return cutAtWord(prefix + title, POPUP_TEXT_MAX);
}

// src/alerts/rule-runner.ts
var REPORTED_MAX = 256;
var reopened = /* @__PURE__ */ new WeakSet();
function markReopened(event) {
  reopened.add(event);
  return event;
}
function isReopened(event) {
  return reopened.has(event);
}
function eventId(ruleId, dedupKey, at) {
  return ruleId + ":" + dedupKey + ":" + at;
}
var PROVENANCE = (() => {
  const map = /* @__PURE__ */ Object.create(null);
  for (const rule of defaultRules()) map[rule.id] = rule.provenance;
  return map;
})();
var RuleRunner = class {
  constructor(options) {
    /** Alerts reported as active, by id: the head of engine.active() after the last tick (≤ REPORTED_MAX keys). */
    this.reported = /* @__PURE__ */ Object.create(null);
    /** Keys the engine restored as active, not yet seen in engine.active() nor cleared; null before the first tick. */
    this.restored = null;
    this.options = options;
  }
  /**
   * Refreshes the provider, evaluates with the current limits, and hands raised, re-opened and cleared events
   * to onEvents (raised first, in the engine's order; then re-opened; then cleared). Nothing when nothing changed.
   * The engine must be restored before the first tick.
   */
  tick() {
    const { provider, engine, clock: clock2, limits } = this.options;
    const snapshot = provider.refresh();
    const now = clock2.now();
    if (this.restored === null) this.restored = this.restoredActiveKeys();
    const returned = engine.evaluate(snapshot, now, limits());
    const out = returned.slice();
    const announced = /* @__PURE__ */ new Set();
    for (const event of returned) announced.add(event.id);
    const active = engine.active();
    const activeIds = /* @__PURE__ */ new Set();
    for (const alert of active) activeIds.add(alert.id);
    const next = /* @__PURE__ */ Object.create(null);
    const head = active.length > REPORTED_MAX ? active.slice(0, REPORTED_MAX) : active;
    const cleared = [];
    for (const alert of head) {
      const known = this.reported[alert.id];
      if (known) {
        next[alert.id] = known;
      } else if (announced.has(alert.id)) {
        next[alert.id] = alert;
      } else {
        const event = markReopened(__spreadProps(__spreadValues({}, alert), { active: true, clearedAt: null }));
        out.push(event);
        next[alert.id] = event;
      }
    }
    for (const id of Object.keys(this.reported)) {
      if (next[id] || activeIds.has(id) || announced.has(id)) continue;
      cleared.push(__spreadProps(__spreadValues({}, this.reported[id]), { active: false, clearedAt: now }));
    }
    this.reported = next;
    for (const event of this.settleRestored(activeIds, announced, now)) cleared.push(event);
    for (const event of cleared) out.push(event);
    if (out.length > 0) this.options.onEvents(out);
  }
  /** The keys the engine holds as active before the first evaluation (only a restore() can have put them there). */
  restoredActiveKeys() {
    const list = [];
    for (const key of this.options.engine.state().keys) {
      if (list.length >= REPORTED_MAX) break;
      if (!key.active || typeof key.lastRaisedAt !== "number") continue;
      list.push({ ruleId: key.ruleId, dedupKey: key.dedupKey, lastRaisedAt: key.lastRaisedAt, id: eventId(key.ruleId, key.dedupKey, key.lastRaisedAt) });
    }
    return list;
  }
  /**
   * Restored keys: one that shows up in engine.active() is handled like any other active alert (reported as
   * re-opened); one the engine no longer holds as active went away silently and its clearing is rebuilt; one
   * still active without an event (its rule could not evaluate) waits for the next tick.
   */
  settleRestored(activeIds, announced, now) {
    const restored = this.restored;
    if (!restored || restored.length === 0) return [];
    const stillActive = /* @__PURE__ */ new Set();
    for (const key of this.options.engine.state().keys) if (key.active) stillActive.add(key.dedupKey);
    const waiting = [];
    const cleared = [];
    for (const key of restored) {
      if (activeIds.has(key.id) || announced.has(key.id)) continue;
      if (stillActive.has(key.dedupKey)) {
        waiting.push(key);
        continue;
      }
      const event = restoredClearing(key, now);
      if (event) cleared.push(event);
    }
    this.restored = waiting;
    return cleared;
  }
};
function restoredClearing(key, now) {
  const provenance = PROVENANCE[key.ruleId];
  if (!provenance) return null;
  return {
    id: key.id,
    ruleId: key.ruleId,
    dedupKey: key.dedupKey,
    provenance,
    severity: "info",
    title: "",
    detail: null,
    at: key.lastRaisedAt,
    active: false,
    clearedAt: now
  };
}

// src/alerts/translit.ts
var LETTERS = {
  "а": ["a", "a"],
  "б": ["b", "b"],
  "в": ["v", "v"],
  "г": ["h", "h"],
  "ґ": ["g", "g"],
  "д": ["d", "d"],
  "е": ["e", "e"],
  "є": ["ie", "ye"],
  "ж": ["zh", "zh"],
  "з": ["z", "z"],
  "и": ["y", "y"],
  "і": ["i", "i"],
  "ї": ["i", "yi"],
  "й": ["i", "y"],
  "к": ["k", "k"],
  "л": ["l", "l"],
  "м": ["m", "m"],
  "н": ["n", "n"],
  "о": ["o", "o"],
  "п": ["p", "p"],
  "р": ["r", "r"],
  "с": ["s", "s"],
  "т": ["t", "t"],
  "у": ["u", "u"],
  "ф": ["f", "f"],
  "х": ["kh", "kh"],
  "ц": ["ts", "ts"],
  "ч": ["ch", "ch"],
  "ш": ["sh", "sh"],
  "щ": ["shch", "shch"],
  "ь": ["", ""],
  "ю": ["iu", "yu"],
  "я": ["ia", "ya"]
};
var LOOK_ALIKES = {
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "−": "-",
  "«": '"',
  "»": '"',
  "“": '"',
  "”": '"',
  "„": '"',
  "‘": "'",
  "‚": "'",
  "…": "...",
  " ": " ",
  " ": " ",
  " ": " "
};
var APOSTROPHES = "'’ʼ";
function lower(ch) {
  return ch.toLowerCase();
}
function isUkrainianLetter(ch) {
  return ch !== void 0 && LETTERS[lower(ch)] !== void 0;
}
function isUpper(ch) {
  return ch !== void 0 && ch !== lower(ch);
}
function isLetter(ch) {
  return ch !== void 0 && (isUkrainianLetter(ch) || /[A-Za-z]/.test(ch));
}
function toAscii(text2) {
  const src = typeof text2 === "string" ? text2 : "";
  const chars = Array.from(src);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const prev = chars[i - 1];
    const next = chars[i + 1];
    const pair = LETTERS[lower(ch)];
    if (pair) {
      const l = lower(ch);
      const before = APOSTROPHES.indexOf(prev === void 0 ? "" : prev) >= 0 && isLetter(chars[i - 2]) ? chars[i - 2] : prev;
      const initial = !isLetter(before);
      let latin = l === "г" && prev !== void 0 && lower(prev) === "з" ? "gh" : pair[initial ? 1 : 0];
      if (latin !== "" && isUpper(ch)) {
        const wordUpper = isUpper(next) || isUpper(prev) && !isLetter(next);
        latin = wordUpper ? latin.toUpperCase() : latin.charAt(0).toUpperCase() + latin.slice(1);
      }
      out += latin;
      continue;
    }
    if (APOSTROPHES.indexOf(ch) >= 0 && isUkrainianLetter(prev) && isUkrainianLetter(next)) continue;
    const code = ch.charCodeAt(0);
    if (ch.length === 1 && code >= 32 && code <= 126) {
      out += ch;
      continue;
    }
    if (LOOK_ALIKES[ch] !== void 0) {
      out += LOOK_ALIKES[ch];
      continue;
    }
    if (/\s/.test(ch)) out += " ";
  }
  return out.replace(/ {2,}/g, " ").trim();
}

// src/alerts/alert-presenter.ts
var POPUP_STATE = "ALERT_POP";
var POPUP_TEXT_LABEL = POPUP_STATE + "_TEXT";
var POPUP_OK_BUTTON = POPUP_STATE + "_OK";
var POPUP_VISIBLE_MS = 8e3;
var POPUP_QUEUE_MAX = 3;
var POPUP_SETTLE_MS = 4e3;
var POPUP_CHECK_MS = 1e3;
function popupGates(switchOn, snapshot) {
  return {
    enabled: () => {
      try {
        return switchOn() === true;
      } catch (e) {
        return false;
      }
    },
    hold: () => {
      try {
        return isReversing(snapshot());
      } catch (e) {
        return true;
      }
    }
  };
}
var SEVERITY_RANK2 = { critical: 0, warning: 1 };
var AlertPresenter = class {
  constructor(options) {
    /** Waiting pop-ups, most severe first, oldest first within a severity; at most POPUP_QUEUE_MAX. */
    this.queue = [];
    this.phase = "idle";
    /** The settle (or hold re-check) timeout while settling; the check interval while showing. */
    this.timer = null;
    /** The pop-up shown now (or opening). */
    this.current = null;
    /** Time the current pop-up has been up, in POPUP_CHECK_MS steps. */
    this.shownMs = 0;
    /** Bumped whenever a pop-up ends: a late answer from the HMI for an earlier one is recognised by it. */
    this.generation = 0;
    this.ui = options.ui;
    this.timers = options.timers;
    this.log = options.log;
    this.enabled = options.enabled;
    this.ascii = options.ascii;
    this.hold = typeof options.hold === "function" ? options.hold : null;
    this.onSettled = safe(this.log, "popup settle", () => this.settled());
    this.onCheck = safe(this.log, "popup check", () => this.check());
    try {
      this.ui.onClick(POPUP_OK_BUTTON, safe(this.log, "popup ok", () => this.finish()));
    } catch (error) {
      this.warn("popup onClick", error);
    }
  }
  /** Queues a critical or warning event for a pop-up; anything else is ignored. Never throws. */
  present(event) {
    try {
      if (!event || event.active !== true || isReopened(event)) return;
      if (event.severity !== "critical" && event.severity !== "warning") return;
      if (!this.allowed()) return;
      if (this.current && this.current.event.id === event.id) return;
      for (const queued of this.queue) if (queued.event.id === event.id) return;
      this.enqueue({ event, interrupted: false });
      this.pump();
    } catch (error) {
      this.warn("popup present", error);
    }
  }
  /**
   * Queues a pop-up with this fixed text, ranked as a warning, through the same gates and settle delay as an
   * alert; `id` keeps it from waiting or showing twice. Nothing is listed, kept or sent. Never throws.
   */
  presentText(id, text2) {
    try {
      if (typeof id !== "string" || id === "" || typeof text2 !== "string" || text2 === "") return;
      if (!this.allowed()) return;
      if (this.current && this.current.event.id === id) return;
      for (const queued of this.queue) if (queued.event.id === id) return;
      const event = {
        id,
        ruleId: id,
        dedupKey: id,
        provenance: "bmw-check-control",
        severity: "warning",
        title: text2,
        detail: null,
        at: 0,
        active: true,
        clearedAt: null
      };
      this.enqueue({ event, interrupted: false, text: text2 });
      this.pump();
    } catch (error) {
      this.warn("popup present", error);
    }
  }
  /** Closes the pop-up if one is up, drops every waiting one and leaves no timer. Never throws. */
  closeAll() {
    try {
      this.queue = [];
      if (this.phase === "showing") {
        this.end();
      } else {
        this.stopTimer();
        this.phase = "idle";
      }
    } catch (error) {
      this.warn("popup closeAll", error);
    }
  }
  /* ---------- internals ---------- */
  allowed() {
    try {
      return this.enabled() === true;
    } catch (e) {
      return false;
    }
  }
  /** True while a hold (reversing) keeps pop-ups back; a throw counts as held. */
  held() {
    if (this.hold === null) return false;
    try {
      return this.hold() === true;
    } catch (e) {
      return true;
    }
  }
  /**
   * Inserts by severity (FIFO within one; an interrupted pop-up goes first within its severity, it is the
   * oldest); beyond the cap the oldest of the least severe waiting is dropped.
   */
  enqueue(item) {
    const rank = SEVERITY_RANK2[item.event.severity];
    let at = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      const other = SEVERITY_RANK2[this.queue[i].event.severity];
      if (other > rank || item.interrupted && other === rank) {
        at = i;
        break;
      }
    }
    this.queue.splice(at, 0, item);
    if (this.queue.length > POPUP_QUEUE_MAX) {
      const worst = SEVERITY_RANK2[this.queue[this.queue.length - 1].event.severity];
      let drop = this.queue.length - 1;
      for (let i = 0; i < this.queue.length; i++) {
        if (SEVERITY_RANK2[this.queue[i].event.severity] === worst) {
          drop = i;
          break;
        }
      }
      this.queue.splice(drop, 1);
    }
  }
  /** When nothing is shown or settling and something waits, starts the settle delay. */
  pump() {
    if (this.phase !== "idle" || this.queue.length === 0) return;
    this.phase = "settling";
    this.timer = this.timers.setTimeout(this.onSettled, POPUP_SETTLE_MS);
  }
  /** The settle delay is over (or a hold re-check is due): switched off → drop; held → wait; else show. */
  settled() {
    this.timer = null;
    if (this.phase !== "settling") return;
    if (!this.allowed()) {
      this.phase = "idle";
      this.queue = [];
      return;
    }
    if (this.queue.length > 0 && this.held()) {
      this.timer = this.timers.setTimeout(this.onSettled, POPUP_CHECK_MS);
      return;
    }
    this.phase = "idle";
    const item = this.queue.shift();
    if (item) this.show(item);
  }
  show(item) {
    const generation = ++this.generation;
    this.phase = "showing";
    this.current = item;
    this.shownMs = 0;
    this.timer = this.timers.setInterval(this.onCheck, POPUP_CHECK_MS);
    const text2 = this.textOf(item);
    const stale = () => generation !== this.generation;
    this.call("open", () => this.ui.open(POPUP_STATE)).then(() => {
      if (stale()) {
        return this.call("close", () => this.ui.close(POPUP_STATE)).then(() => void 0);
      }
      return this.call("text", () => this.ui.text(POPUP_TEXT_LABEL, text2)).then(() => void 0);
    }).then(void 0, (error) => {
      this.warn("popup", error);
      if (!stale()) this.finish();
    });
  }
  /** Runs a ui call; a throw becomes a rejection. */
  call(what, fn) {
    try {
      return Promise.resolve(fn()).then(void 0, (error) => {
        throw new Error(what + ": " + describe2(error));
      });
    } catch (error) {
      return Promise.reject(new Error(what + ": " + describe2(error)));
    }
  }
  textOf(item) {
    const text2 = typeof item.text === "string" ? cutAtWord(item.text, POPUP_TEXT_MAX) : popupText(item.event);
    let ascii;
    try {
      ascii = this.ascii() === true;
    } catch (e) {
      ascii = false;
    }
    return ascii ? cutAtWord(toAscii(text2), POPUP_TEXT_MAX) : text2;
  }
  /**
   * Every POPUP_CHECK_MS while a pop-up is up: close it when its time is over, when pop-ups were switched off
   * (the queue is dropped), or when a hold started (it goes back to the queue once and waits with the rest).
   */
  check() {
    if (this.phase !== "showing") return;
    this.shownMs += POPUP_CHECK_MS;
    if (!this.allowed()) {
      this.queue = [];
      this.finish();
      return;
    }
    if (this.held()) {
      const interrupted = this.current;
      if (interrupted && !interrupted.interrupted) this.enqueue({ event: interrupted.event, interrupted: true, text: interrupted.text });
      this.finish();
      return;
    }
    if (this.shownMs >= POPUP_VISIBLE_MS) this.finish();
  }
  /** The current pop-up ends (time, OK, a failed ui call, switched off, held); the next one starts settling. */
  finish() {
    if (this.phase !== "showing") return;
    this.end();
    this.pump();
  }
  /** Closes the current pop-up and returns to idle. */
  end() {
    this.stopTimer();
    this.generation++;
    this.current = null;
    this.phase = "idle";
    this.call("close", () => this.ui.close(POPUP_STATE)).then(void 0, (error) => this.warn("popup", error));
  }
  stopTimer() {
    if (this.timer === null) return;
    if (this.phase === "settling") this.timers.clearTimeout(this.timer);
    else this.timers.clearInterval(this.timer);
    this.timer = null;
  }
  warn(label2, error) {
    try {
      this.log.warn(label2 + ": " + describe2(error));
    } catch (e) {
    }
  }
};
function describe2(error) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch (e) {
    return "unprintable error";
  }
}

// src/power/power-gate.ts
var IDLE_FALLBACK_MS = 9e5;
var CONDITION_TO_STATE = {
  parked: "asleep",
  standby: "asleep",
  living: "awake",
  "ignition-on": "awake",
  starting: "awake",
  stopping: "awake",
  driving: "driving"
};
var TYRE_SETS = ["tyrePressure", "tyrePressureTarget"];
var TYRE_POSITIONS = ["frontLeft", "frontRight", "rearLeft", "rearRight"];
var PowerGate = class {
  constructor(options) {
    this.current = "awake";
    this.listeners = [];
    /** The last `at` seen per passive reading path; a fixed set of keys, so bounded. */
    this.lastAt = {};
    this.clock = options.clock;
    this.idleFallbackMs = options.idleFallbackMs !== void 0 ? options.idleFallbackMs : IDLE_FALLBACK_MS;
    this.lastActivityAt = this.clock.now();
  }
  /** Call on every tick and on every condition change. */
  update(snapshot) {
    const now = this.clock.now();
    if (now < this.lastActivityAt) this.lastActivityAt = now;
    if (this.sawFreshReading(snapshot)) this.lastActivityAt = now;
    const next = this.decide(snapshot, now);
    const previous = this.current;
    if (next !== previous) {
      this.current = next;
      const listeners = this.listeners.slice();
      for (let i = 0; i < listeners.length; i++) listeners[i](next, previous);
    }
    return next;
  }
  /**
   * The owner used the app (asked a question, opened its screen, or the pairing panel is on screen): restarts the
   * idle fallback as a fresh reading would. The caller follows it with update(). A car that reports `parked` or
   * `standby` stays asleep: a known condition decides before the fallback is looked at.
   */
  touch() {
    this.lastActivityAt = this.clock.now();
  }
  state() {
    return this.current;
  }
  onChange(listener) {
    this.listeners = this.listeners.concat([listener]);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  decide(snapshot, now) {
    const condition = snapshot.condition;
    if (condition.available) {
      const mapped = CONDITION_TO_STATE[condition.value];
      if (mapped !== void 0) return mapped;
    }
    if (snapshot.speed.available && snapshot.speed.value > MOVING_ABOVE_KMH) return "driving";
    return now - this.lastActivityAt >= this.idleFallbackMs ? "asleep" : "awake";
  }
  /**
   * True when any available passive reading carries an `at` different from the one last seen for it.
   * Only `passive-signal` readings count as activity: polled readings (fuel, range, odometer, tyres) are
   * re-stamped on every poll whether or not they changed, and diagnostic reads are requests we make, so
   * neither says the car is doing anything. "Different", not "later": after the clock moves back, a
   * genuinely new reading is stamped earlier than the old one.
   */
  sawFreshReading(snapshot) {
    let fresh = false;
    const keys = Object.keys(snapshot);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === "takenAt") continue;
      if (key === "tyrePressure" || key === "tyrePressureTarget") continue;
      if (this.note(key, snapshot[key])) fresh = true;
    }
    for (let i = 0; i < TYRE_SETS.length; i++) {
      const set = snapshot[TYRE_SETS[i]];
      if (!set) continue;
      for (let j = 0; j < TYRE_POSITIONS.length; j++) {
        if (this.note(TYRE_SETS[i] + "." + TYRE_POSITIONS[j], set[TYRE_POSITIONS[j]])) fresh = true;
      }
    }
    return fresh;
  }
  note(path2, reading) {
    if (!reading || !reading.available || reading.source !== "passive-signal") return false;
    if (this.lastAt[path2] === reading.at) return false;
    this.lastAt[path2] = reading.at;
    return true;
  }
};

// src/provider/raw-decoders.ts
var TPMS2 = "de.bmw.infotainment.vehicle.TPMS";
var CONDITION = "de.bmw.infrastructure.VehicleCondition";
var VEHICLE_INFORMATION = "de.bmw.infrastructure.VehicleInformation";
var FES = "de.bmw.infotainment.drivingexcitement.FES";
var VEHICLE = "de.bmw.infotainment.vehicle.Vehicle";
var CHECK_CONTROL_MASTER = "de.bmw.infotainment.checkcontrol.CheckControlMaster";
var KOMBI2 = "de.bmw.infotainment.KombiInterface_2";
var ESSENTIAL_KEYS = ["engineRpm", "speed"];
function topKey(key) {
  const dot = key.indexOf(".");
  return dot < 0 ? key : key.slice(0, dot);
}
function catalogueInterfaces() {
  const out = [];
  for (const entry of SIGNAL_CATALOGUE) {
    let item = out.find((r) => r.iface === entry.iface);
    if (!item) {
      item = { iface: entry.iface, fields: [], polled: false, essential: false, keys: [] };
      out.push(item);
    }
    if (item.fields.indexOf(entry.field) < 0) item.fields.push(entry.field);
    if (entry.transport === "polled") item.polled = true;
    if (ESSENTIAL_KEYS.indexOf(entry.key) >= 0) item.essential = true;
    const key = topKey(entry.key);
    if (item.keys.indexOf(key) < 0) item.keys.push(key);
  }
  return out;
}
var RAW_INTERFACES = Object.freeze(catalogueInterfaces().concat([
  { iface: CONDITION, fields: ["VehicleCondition"], polled: false, essential: true, keys: ["condition"] },
  { iface: VEHICLE_INFORMATION, fields: ["statusGearboxDrive", "DataPowerTrain2"], polled: false, essential: false, keys: ["gear", "gearStage"] },
  { iface: FES, fields: ["statusFESVehicleDynamicSwitchHMI"], polled: false, essential: false, keys: ["driveMode"] },
  { iface: VEHICLE, fields: ["statusNewCurrentUnitsStatusExt"], polled: false, essential: false, keys: [] },
  { iface: CHECK_CONTROL_MASTER, fields: ["basicList"], polled: false, essential: false, keys: ["checkControl"] },
  { iface: KOMBI2, fields: ["ccList", "newCCMessage", "cbsDataServiceList"], polled: false, essential: false, keys: ["serviceItems"] }
]));
var DIAGNOSTIC_ONLY_KEYS = ["battery12vVoltage", "intakeTemp", "boostPressure", "engineLoad", "faultCodes"];
var STALE_EXEMPT_KEYS = ["odometer", "serviceItems", "checkControl"];
var MAX_CHECK_CONTROL = 64;
var MAX_CHECK_CONTROL_TEXTS = 64;
var MAX_SERVICE_ITEMS = 32;
var MAX_TEXT = 80;
var MAX_DEPTH = 8;
var MAX_NODES = 1024;
function createDecoderState() {
  return {
    pressureUnit: null,
    checkControlKnown: false,
    checkControlActive: /* @__PURE__ */ Object.create(null),
    checkControlActiveCount: 0,
    checkControlTexts: /* @__PURE__ */ Object.create(null),
    checkControlTextCount: 0
  };
}
function hasOwn(o, key) {
  return Object.prototype.hasOwnProperty.call(o, key);
}
function isStruct(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function member(v, name) {
  return isStruct(v) && hasOwn(v, name) ? v[name] : void 0;
}
function rawNumber(x) {
  if (typeof x === "number") return isFinite(x) ? x : null;
  if (typeof x === "string" && /^\d{1,10}$/.test(x)) return Number(x);
  return null;
}
function idOf(x) {
  const n = rawNumber(x);
  return n !== null && n >= 0 && Math.floor(n) === n ? n : null;
}
function carText(x) {
  if (typeof x !== "string") return null;
  const t = x.slice(0, 4 * MAX_TEXT).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, MAX_TEXT).trim();
  return t.length > 0 ? t : null;
}
function walk(v, fn) {
  let budget = MAX_NODES;
  const visit = (o, depth) => {
    if (budget <= 0 || depth > MAX_DEPTH || typeof o !== "object" || o === null) return;
    budget--;
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length && budget > 0; i++) visit(o[i], depth + 1);
      return;
    }
    const s = o;
    fn(s);
    for (const k of Object.keys(s)) {
      if (budget <= 0) return;
      if (typeof s[k] === "object" && s[k] !== null) visit(s[k], depth + 1);
    }
  };
  visit(v, 0);
}
function findHolding(v, key, depth = 0) {
  if (depth > MAX_DEPTH || typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const s = v;
  if (hasOwn(s, key)) return s;
  for (const k of Object.keys(s)) {
    const found = findHolding(s[k], key, depth + 1);
    if (found) return found;
  }
  return null;
}
function put(s, key, reading) {
  const dot = key.indexOf(".");
  if (dot < 0) {
    s[key] = reading;
    return;
  }
  const group = s[key.slice(0, dot)];
  if (isStruct(group)) group[key.slice(dot + 1)] = reading;
}
function markUnavailable(s, key, reason) {
  const current = s[key];
  if (isStruct(current) && !hasOwn(current, "available")) {
    for (const wheel of Object.keys(current)) current[wheel] = unavailable(reason);
    return;
  }
  put(s, key, unavailable(reason));
}
var CONDITION_NUMBERS = {
  PARKEN_BN_NIO: 1,
  PARKEN_BN_IO: 2,
  STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3,
  WOHNEN: 5,
  PRUEFEN_ANALYSE_DIAGNOSE: 7,
  FAHRBEREITSCHAFT_HERSTELLEN: 8,
  FAHREN: 10,
  FAHRBEREITSCHAFT_BEENDEN: 12
};
var CONDITIONS = {
  1: "parked",
  2: "parked",
  3: "standby",
  5: "living",
  7: "ignition-on",
  8: "starting",
  10: "driving",
  12: "stopping"
};
function conditionFromRaw(raw) {
  let n = null;
  if (typeof raw === "number" && isFinite(raw)) n = raw;
  else if (typeof raw === "string" && hasOwn(CONDITION_NUMBERS, raw)) n = CONDITION_NUMBERS[raw];
  if (n === null || Math.floor(n) !== n || !hasOwn(CONDITIONS, String(n))) return null;
  return CONDITIONS[String(n)];
}
var STAGES = { P: "P", R: "R", N: "N", D: "D", 1: "P", 2: "R", 3: "N", 4: "D" };
function forwardGear(x) {
  if (typeof x === "number") return x >= 3 && x <= 12 && Math.floor(x) === x ? x - 2 : null;
  const m = typeof x === "string" ? /^G(\d{1,2})$/.exec(x) : null;
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 10 ? n : null;
}
function applyGearbox(s, v, now) {
  const st = member(v, "statusActualStageDrive");
  const stage = (typeof st === "string" || typeof st === "number") && hasOwn(STAGES, String(st)) ? STAGES[String(st)] : null;
  if (stage === null) {
    s.gearStage = unavailable("invalid-value");
    s.gear = unavailable("invalid-value");
    return;
  }
  const n = stage === "D" ? forwardGear(member(v, "statusActualGearDrive")) : null;
  s.gearStage = available(stage, null, "passive-signal", now);
  s.gear = available(n === null ? stage : "D" + n, null, "passive-signal", now);
}
function applyGearSelection(s, v, now) {
  const x = member(v, "statusGearSelectionDrive");
  let n = null;
  if (typeof x === "number") n = x;
  else if (typeof x === "string") {
    const names = { N: 1, R: 2, P: 3, NP: 4 };
    if (hasOwn(names, x)) n = names[x];
    else if (/^_\d$/.test(x)) n = 4 + Number(x.slice(1));
  }
  if (n === 1 || n === 2 || n === 3) {
    const stage = n === 1 ? "N" : n === 2 ? "R" : "P";
    s.gearStage = available(stage, null, "passive-signal", now);
    s.gear = available(stage, null, "passive-signal", now);
  } else if (n === 4) {
    const st = s.gearStage;
    if (st.available && (st.value === "P" || st.value === "N")) {
      s.gear = available(st.value, null, "passive-signal", now);
    } else {
      s.gearStage = unavailable("invalid-value");
      s.gear = unavailable("invalid-value");
    }
  } else if (n !== null && n >= 5 && n <= 13 && Math.floor(n) === n) {
    s.gearStage = available("D", null, "passive-signal", now);
    s.gear = available("D" + (n - 4), null, "passive-signal", now);
  } else {
    s.gearStage = unavailable("invalid-value");
    s.gear = unavailable("invalid-value");
  }
}
var DRIVE_MODES = {
  SPORT_DYNAMIC: "Sport",
  SPORT_EXPERT: "Sport plus",
  ECO_PRO_EFFICIENT: "Eco pro",
  1: "Sport",
  2: "Sport plus",
  3: "Sport individual",
  4: "Comfort",
  5: "Comfort plus",
  6: "Comfort individual",
  7: "Eco pro",
  8: "Eco pro plus",
  9: "Eco pro individual",
  10: "Adaptive",
  0: null,
  61: null,
  62: null,
  63: null
};
var NO_ENUM = /UNGUELTIG|UNBEFUELLT|INITIALISIERUNG|NICHT_VERFUEGBAR|RESERVIERT|FEHLER/;
function applyDriveMode(s, v, now) {
  const raw = member(v, "actualValueModeDrivingExperience");
  let mode = null;
  if ((typeof raw === "number" || typeof raw === "string") && hasOwn(DRIVE_MODES, String(raw))) mode = DRIVE_MODES[String(raw)];
  else if (typeof raw === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(raw) && !NO_ENUM.test(raw)) mode = raw;
  s.driveMode = mode === null ? unavailable("invalid-value") : available(mode, null, "passive-signal", now);
}
var ENTRIES_BY_FIELD = /* @__PURE__ */ Object.create(null);
for (const entry of SIGNAL_CATALOGUE) {
  const k = entry.iface + "#" + entry.field;
  (ENTRIES_BY_FIELD[k] = ENTRIES_BY_FIELD[k] || []).push(entry);
}
var TO_BAR = { bar: 1, kPa: 0.01, psi: 0.0689476 };
function pressureUnitOf(x) {
  if (x === 1 || x === "BAR") return "bar";
  if (x === 2 || x === "KPA") return "kPa";
  if (x === 3 || x === "PSI") return "psi";
  return null;
}
function applyCatalogue(s, entries, v, now, state) {
  const struct = isStruct(v) ? v : null;
  for (const e of entries) {
    const raw = struct !== null && e.member !== null ? rawNumber(member(struct, e.member)) : null;
    const value = raw === null ? null : decodeRaw(e, raw);
    if (value === null) {
      put(s, e.key, unavailable("invalid-value"));
      continue;
    }
    const source = e.transport === "polled" ? "polled-signal" : "passive-signal";
    if (e.iface === TPMS2 && e.unit === null) {
      const unit = state.pressureUnit;
      put(s, e.key, unit === null ? available(value, null, source, now) : available(value * TO_BAR[unit], "bar", source, now));
    } else {
      put(s, e.key, available(value, e.unit, source, now));
    }
  }
}
function severityOf(colour) {
  if (colour === "RED") return "critical";
  if (colour === "YELLOW" || colour === "ORANGE") return "warning";
  if (colour === "GREEN" || colour === "WHITE") return "info";
  return "warning";
}
function rebuildCheckControl(s, state, now) {
  const list = [];
  for (const k of Object.keys(state.checkControlActive)) {
    const a = state.checkControlActive[k];
    const t = state.checkControlTexts[k];
    list.push({ id: a.id, text: t ? t.text : null, severity: severityOf(t ? t.colour : void 0), since: a.since });
  }
  list.sort((x, y) => x.since - y.since || x.id - y.id);
  s.checkControl = available(list, null, "passive-signal", now);
}
function applyCheckControlMaster(s, v, now, state) {
  if (typeof v !== "object" || v === null) {
    s.checkControl = unavailable("invalid-value");
    return;
  }
  walk(v, (o) => {
    if (!hasOwn(o, "ccmId")) return;
    const id = idOf(o.ccmId);
    if (id === null) return;
    const k = String(id);
    const on = o.activeState === "AKTIV" || o.activeState === 0;
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
function pruneCheckControlTexts(state) {
  for (const k of Object.keys(state.checkControlTexts)) {
    if (!hasOwn(state.checkControlActive, k)) {
      delete state.checkControlTexts[k];
      state.checkControlTextCount--;
    }
  }
}
function applyCheckControlTexts(s, v, now, state) {
  if (typeof v !== "object" || v === null) return;
  walk(v, (o) => {
    const id = idOf(hasOwn(o, "cCIdentifer") ? o.cCIdentifer : o.cCIdentifier);
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
      colour: hasOwn(o, "cCColor") ? o.cCColor : old ? old.colour : void 0
    };
  });
  if (state.checkControlKnown) rebuildCheckControl(s, state, now);
}
function serviceStatusOf(colour) {
  if (colour === "RED" || colour === 1) return "overdue";
  if (colour === "YELLOW" || colour === "ORANGE" || colour === 2 || colour === 4) return "due-soon";
  if (colour === "GREEN" || colour === 3) return "ok";
  return "unknown";
}
function applyServiceList(s, v, now) {
  let list = null;
  if (Array.isArray(v)) list = v;
  else if (Array.isArray(member(v, "cbsDataServiceList"))) list = member(v, "cbsDataServiceList");
  else if (Array.isArray(member(v, "value"))) list = member(v, "value");
  if (list === null) {
    s.serviceItems = unavailable("invalid-value");
    return;
  }
  const items = [];
  for (let i = 0; i < list.length && items.length < MAX_SERVICE_ITEMS; i++) {
    const e = findHolding(list[i], "cBSIdentifier");
    if (!e) continue;
    const id = idOf(e.cBSIdentifier);
    if (id === null) continue;
    const name = carText(e.cBSServcieName) || carText(e.cBSServiceName);
    const date = carText(e.cBSServiceDate);
    const way = carText(e.cBSServiceWay);
    const due = date !== null && way !== null ? date + ", " + way : date !== null ? date : way;
    items.push({ id, name, status: serviceStatusOf(e.cBSColor), dueText: due });
  }
  s.serviceItems = available(items, null, "passive-signal", now);
}
function applyRaw(snapshot, iface, field, value, now, state = createDecoderState()) {
  const entries = ENTRIES_BY_FIELD[iface + "#" + field];
  if (entries) {
    applyCatalogue(snapshot, entries, value, now, state);
    return;
  }
  if (iface === CONDITION && field === "VehicleCondition") {
    const c = conditionFromRaw(member(value, "statusConditionVehicle"));
    snapshot.condition = c === null ? unavailable("invalid-value") : available(c, null, "passive-signal", now);
  } else if (iface === VEHICLE_INFORMATION && field === "statusGearboxDrive") {
    applyGearbox(snapshot, value, now);
  } else if (iface === VEHICLE_INFORMATION && field === "DataPowerTrain2") {
    applyGearSelection(snapshot, value, now);
  } else if (iface === FES && field === "statusFESVehicleDynamicSwitchHMI") {
    applyDriveMode(snapshot, value, now);
  } else if (iface === VEHICLE && field === "statusNewCurrentUnitsStatusExt") {
    state.pressureUnit = pressureUnitOf(member(value, "unitOfMeasurementAirPressure"));
  } else if (iface === CHECK_CONTROL_MASTER && field === "basicList") {
    applyCheckControlMaster(snapshot, value, now, state);
  } else if (iface === KOMBI2 && (field === "ccList" || field === "newCCMessage")) {
    applyCheckControlTexts(snapshot, value, now, state);
  } else if (iface === KOMBI2 && field === "cbsDataServiceList") {
    applyServiceList(snapshot, value, now);
  }
}

// src/provider/bmw-provider.ts
var DEFAULT_STALE_AFTER_MS = 3e5;
var POLL_MS = 1e4;
var SIGNAL_INSTANCE = "1";
var KIND = /* @__PURE__ */ Object.create(null);
var PASSIVE_KEYS = /* @__PURE__ */ Object.create(null);
for (const raw of RAW_INTERFACES) {
  const passive = [];
  for (const key of raw.keys) {
    const exempt = STALE_EXEMPT_KEYS.indexOf(key) >= 0;
    KIND[key] = exempt ? "held" : raw.polled ? "polled" : "passive";
    if (!exempt && !raw.polled) passive.push(key);
  }
  PASSIVE_KEYS[raw.iface] = passive;
}
function kindOf(key) {
  return KIND[key] || "held";
}
var FIELD_KEYS = /* @__PURE__ */ Object.create(null);
for (const entry of SIGNAL_CATALOGUE) {
  const dot = entry.key.indexOf(".");
  const key = dot < 0 ? entry.key : entry.key.slice(0, dot);
  const list = FIELD_KEYS[entry.iface + "#" + entry.field] || (FIELD_KEYS[entry.iface + "#" + entry.field] = []);
  if (list.indexOf(key) < 0) list.push(key);
}
function isConditionInterface(raw) {
  return raw.keys.indexOf("condition") >= 0;
}
var STALE = Object.freeze(unavailable("stale"));
function isObject(v) {
  return typeof v === "object" && v !== null;
}
function describe3(error) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch (e) {
    return "unprintable error";
  }
}
function isReading(v) {
  return isObject(v) && typeof v.available === "boolean";
}
function sameReading(prev, next) {
  if (prev === next) return true;
  if (!isReading(prev) || prev.available !== next.available) return false;
  if (!prev.available || !next.available) return !prev.available && !next.available && prev.reason === next.reason;
  return prev.value === next.value && prev.unit === next.unit && prev.source === next.source && prev.at === next.at;
}
function notInFuture(r, now) {
  return r.available && r.at > now ? available(r.value, r.unit, r.source, now) : r;
}
var BmwMguVehicleDataProvider = class {
  constructor(options) {
    this.missing = /* @__PURE__ */ Object.create(null);
    this.missingKeys = [];
    this.state = createDecoderState();
    this.listeners = [];
    /** the watches signals.watch resolved with, at most one per watched interface */
    this.watches = [];
    this.running = false;
    this.suspended = false;
    /**
     * Generations. A watch, or a value through its handlers, belongs to the generation it was created in; once
     * that is no longer current the watch is shut down when it arrives and its values are dropped, so
     * start/stop/suspend/resume in any order, even while the kit is still setting watches up, never leaves two
     * watches live. The vehicle-condition watch lives for a run (start() to stop()); the others for a
     * stretch between suspends (bumped by start, stop, suspend and resume).
     */
    this.runGen = 0;
    this.restGen = 0;
    /** a handler applied a value since the last refresh(), or suspend() changed what is published */
    this.changed = false;
    /** the clock time of the latest on-change notification from any watched (non-polled) interface */
    this.lastPassiveArrivalAt = null;
    /** interfaces whose watch has said it is available (only those can "report unavailable") */
    this.upSeen = /* @__PURE__ */ Object.create(null);
    this.refreshQueued = false;
    this.signals = options.signals;
    this.clock = options.clock;
    this.log = options.log;
    this.staleAfterMs = typeof options.staleAfterMs === "number" && options.staleAfterMs > 0 ? options.staleAfterMs : DEFAULT_STALE_AFTER_MS;
    for (const iface of options.missingInterfaces || []) this.missing[iface] = true;
    for (const key of options.missingKeys || []) if (this.missingKeys.indexOf(key) < 0) this.missingKeys.push(key);
    const now = this.clock.now();
    this.latest = this.baseline(now);
    this.current = this.baseline(now);
    this.deferredRefresh = safe(this.log, "provider refresh", () => {
      this.refreshQueued = false;
      this.refresh();
    });
  }
  /**
   * One watch per interface the unit has; polled interfaces with pollMs. Every reading starts unreported
   * (Check Control and service items included): nothing from before a stop() is current truth. Resolves once
   * every watch is set up or failed.
   */
  start() {
    if (this.running) return Promise.resolve();
    this.running = true;
    this.suspended = false;
    this.runGen++;
    this.restGen++;
    this.forget(false);
    this.lastPassiveArrivalAt = null;
    this.upSeen = /* @__PURE__ */ Object.create(null);
    return this.watchInterfaces(true);
  }
  /**
   * Stops listening: later values are dropped and every watch is shut down (the kit's res.shutdown, which
   * clears its poll interval and shuts the interface's proxy down). What was published stays and ages.
   */
  stop() {
    this.running = false;
    this.suspended = false;
    this.runGen++;
    this.restGen++;
    const watches = this.watches;
    this.watches = [];
    return Promise.all(watches.map((w) => this.shutdown(w.watch))).then(() => void 0);
  }
  /**
   * Sleep without going deaf: shuts every watch down except the passive vehicle-condition watch (so no kit
   * poll interval is left), marks every reading but `condition` not-reported, and keeps notifying listeners
   * when the condition changes (from a microtask, as no tick runs while suspended). No-op unless running.
   */
  suspend() {
    try {
      if (!this.running || this.suspended) return;
      this.suspended = true;
      this.restGen++;
      const keep = [];
      const upSeen = /* @__PURE__ */ Object.create(null);
      for (const w of this.watches) {
        if (w.condition) {
          keep.push(w);
          if (this.upSeen[w.iface]) upSeen[w.iface] = true;
        } else {
          void this.shutdown(w.watch);
        }
      }
      this.watches = keep;
      this.upSeen = upSeen;
      this.forget(true);
      this.changed = true;
      this.publish(this.clock.now());
    } catch (error) {
      this.warn("provider suspend: " + describe3(error));
    }
  }
  /** Re-creates the watches suspend() shut down, with Check Control starting over. No-op unless suspended. */
  resume() {
    try {
      if (!this.running || !this.suspended) return;
      this.suspended = false;
      this.restGen++;
      this.forget(true);
      void this.watchInterfaces(false);
    } catch (error) {
      this.warn("provider resume: " + describe3(error));
    }
  }
  snapshot() {
    return this.current;
  }
  onChange(listener) {
    const entry = { listener, call: safe(this.log, "provider listener", listener) };
    this.listeners.push(entry);
    return () => {
      const i = this.listeners.indexOf(entry);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  /** The keys the snapshot delivers now (a tyre set counts when any wheel is available); diagnostics are off. */
  capabilities() {
    const delivers = [];
    const s = this.current;
    for (const key of Object.keys(s)) {
      if (key === "takenAt") continue;
      const v = s[key];
      let delivered = false;
      if (isReading(v)) delivered = v.available;
      else if (isObject(v)) delivered = Object.keys(v).some((wheel) => isReading(v[wheel]) && v[wheel].available);
      if (delivered) delivers.push(key);
    }
    return { delivers, diagnosticsEnabled: false };
  }
  /** Called by the 1 Hz tick: stamps takenAt, judges every reading, notifies listeners if anything changed. */
  refresh() {
    const published = this.publish(this.clock.now());
    const changed = this.changed || published;
    this.changed = false;
    if (changed) for (const entry of this.listeners.slice()) entry.call(this.current);
    return this.current;
  }
  /* ---------- internals ---------- */
  /** A snapshot with nothing reported, diagnostics off and the unit's missing interfaces marked. */
  baseline(now) {
    const s = emptySnapshot(now);
    for (const key of DIAGNOSTIC_ONLY_KEYS) markUnavailable(s, key, "diagnostics-disabled");
    for (const raw of RAW_INTERFACES) {
      if (this.missing[raw.iface]) for (const key of raw.keys) markUnavailable(s, key, "not-on-this-vehicle");
    }
    for (const key of this.missingKeys) markUnavailable(s, key, "not-on-this-vehicle");
    return s;
  }
  /**
   * Drops what the car said (every reading but `condition` when keepCondition) and starts Check Control over:
   * a message the car cleared while we were not listening must not stay listed. The tyre-pressure display
   * unit is kept (it is the car's setting, not a reading).
   */
  forget(keepCondition) {
    const fresh = this.baseline(this.clock.now());
    const to = this.latest;
    for (const key of Object.keys(fresh)) {
      if (key === "takenAt" || keepCondition && key === "condition") continue;
      to[key] = fresh[key];
    }
    const unit = this.state.pressureUnit;
    this.state = createDecoderState();
    this.state.pressureUnit = unit;
  }
  /** Watches every interface the unit has (all but the condition interface when !withCondition). Never rejects. */
  watchInterfaces(withCondition) {
    const run = this.runGen;
    const rest = this.restGen;
    const jobs = [];
    for (const raw of RAW_INTERFACES) {
      if (this.missing[raw.iface]) continue;
      const condition = isConditionInterface(raw);
      if (condition && !withCondition) continue;
      const isCurrent = condition ? () => run === this.runGen : () => rest === this.restGen;
      const handlers = {};
      let fields = 0;
      for (const field of raw.fields) {
        if (this.fieldMissing(raw.iface, field)) continue;
        handlers[field] = this.handler(raw.iface, field, raw.polled, isCurrent);
        fields++;
      }
      if (fields === 0) continue;
      let pending;
      try {
        pending = Promise.resolve(this.signals.watch(raw.iface, SIGNAL_INSTANCE, handlers, this.log, raw.polled ? { pollMs: POLL_MS } : void 0));
      } catch (error) {
        pending = Promise.reject(error);
      }
      jobs.push(pending.then(
        (watch) => {
          if (isCurrent()) this.watches.push({ iface: raw.iface, watch, condition });
          else void this.shutdown(watch);
        },
        (error) => this.warn("signals " + raw.iface + ": " + describe3(error))
      ));
    }
    return Promise.all(jobs).then(() => void 0);
  }
  /** True for a catalogue field every reading of which is missing (its signal is not declared on this unit). */
  fieldMissing(iface, field) {
    const keys = FIELD_KEYS[iface + "#" + field];
    if (!keys || this.missingKeys.length === 0) return false;
    for (const key of keys) if (this.missingKeys.indexOf(key) < 0) return false;
    return true;
  }
  /** A signal handler: decodes into `latest` and marks it changed, nothing else (while suspended: queues a refresh). */
  handler(iface, field, polled, isCurrent) {
    return safe(this.log, "signal " + field, (value) => {
      if (!isCurrent()) return;
      const now = this.clock.now();
      applyRaw(this.latest, iface, field, value, now, this.state);
      if (!polled) this.lastPassiveArrivalAt = now;
      this.changed = true;
      if (this.suspended) this.queueRefresh();
    });
  }
  /** At most one refresh waiting, run from a microtask rather than from inside the kit's native callback. */
  queueRefresh() {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    void Promise.resolve().then(this.deferredRefresh);
  }
  /** An interface that said it was available and now says it is not: its passive readings are dropped. */
  checkInterfaces() {
    for (const w of this.watches) {
      const watch = w.watch;
      if (!isObject(watch)) continue;
      if (watch.available === true) {
        this.upSeen[w.iface] = true;
      } else if (watch.available === false && this.upSeen[w.iface]) {
        delete this.upSeen[w.iface];
        const latest = this.latest;
        for (const key of PASSIVE_KEYS[w.iface] || []) latest[key] = unavailable("not-reported");
      }
    }
  }
  /** The reading listeners see for one decoded reading. */
  judge(kind, r, prev, now) {
    if (!r.available || kind === "held") return r;
    let at = r.at;
    if (kind === "passive" && this.lastPassiveArrivalAt !== null && this.lastPassiveArrivalAt > at) at = this.lastPassiveArrivalAt;
    if (now - at > this.staleAfterMs) return STALE;
    if (at === r.at) return r;
    if (isReading(prev) && prev.available && prev.at === at && prev.value === r.value && prev.unit === r.unit && prev.source === r.source) return prev;
    return available(r.value, r.unit, r.source, at);
  }
  /** Judges `latest` into the published snapshot; true when any published reading changed. */
  publish(now) {
    if (this.lastPassiveArrivalAt !== null && this.lastPassiveArrivalAt > now) this.lastPassiveArrivalAt = now;
    this.checkInterfaces();
    const from = this.latest;
    const to = this.current;
    let changed = false;
    for (const key of Object.keys(from)) {
      if (key === "takenAt") continue;
      const kind = kindOf(key);
      const v = from[key];
      if (isReading(v)) {
        const r = notInFuture(v, now);
        if (r !== v) from[key] = r;
        const next = this.judge(kind, r, to[key], now);
        if (!sameReading(to[key], next)) {
          to[key] = next;
          changed = true;
        }
      } else if (isObject(v)) {
        const out = to[key];
        if (!isObject(out)) continue;
        for (const wheel of Object.keys(v)) {
          const w = v[wheel];
          if (!isReading(w)) continue;
          const r = notInFuture(w, now);
          if (r !== w) v[wheel] = r;
          const next = this.judge(kind, r, out[wheel], now);
          if (!sameReading(out[wheel], next)) {
            out[wheel] = next;
            changed = true;
          }
        }
      }
    }
    this.current.takenAt = now;
    return changed;
  }
  shutdown(watch) {
    if (!isObject(watch) || typeof watch.shutdown !== "function") return Promise.resolve();
    const fn = watch.shutdown;
    return Promise.resolve().then(() => fn.call(watch)).then(() => void 0, (error) => this.warn("signals shutdown: " + describe3(error)));
  }
  warn(message) {
    try {
      this.log.warn(message);
    } catch (e) {
    }
  }
};

// src/selfmeasure.ts
var SELF_MEASURE_INTERVAL_MS = 6e5;
var MB = 1024 * 1024;
function wholeMb(bytes) {
  return typeof bytes === "number" && isFinite(bytes) ? String(Math.round(bytes / MB)) : "?";
}
function measure(prev, now, mem, cpu) {
  if (prev === null || now < prev.at || now - prev.at > 2 * SELF_MEASURE_INTERVAL_MS) {
    const c2 = cpu();
    return { sample: { at: now, user: c2.user, system: c2.system }, line: null };
  }
  if (now - prev.at < SELF_MEASURE_INTERVAL_MS) return { sample: prev, line: null };
  const c = cpu();
  const m = mem();
  const spentUs = c.user - prev.user + (c.system - prev.system);
  let share = spentUs / 1e3 / (now - prev.at) * 100;
  if (!isFinite(share) || share < 0) share = 0;
  return {
    sample: { at: now, user: c.user, system: c.system },
    line: "self: rss=" + wholeMb(m.rss) + "MB heap=" + wholeMb(m.heapUsed) + "MB cpu=" + share.toFixed(1) + "%"
  };
}

// src/state/state-file.ts
var STATE_FILE_NAME = "copilot-state.json";
var STATE_FILE_MODE = 384;
var MAX_ENGINE_KEYS = 512;
var MAX_PENDING_ALERTS = 20;
var ALERT_KEY_MAX = 256;
var ALERT_TEXT_MAX = 2e3;
var SEVERITIES = ["critical", "warning", "info"];
var PROVENANCES = ["bmw-check-control", "bmw-fault-status", "bmw-service", "owner-configured"];
var LIMIT_FIELDS = ["oilTempMaxC", "coolantTempMaxC", "battery12vMinPercent", "tyrePressureDeviationBar"];
function defaultState() {
  return { v: 1, engine: { keys: [] }, limits: __spreadValues({}, NO_LIMITS), popupsEnabled: true, asciiPopups: false, device: null };
}
function isStruct2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function finiteOrNull(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}
function limitsFrom(v) {
  const limits = __spreadValues({}, NO_LIMITS);
  if (!isStruct2(v)) return limits;
  for (const field of LIMIT_FIELDS) limits[field] = finiteOrNull(v[field]);
  return limits;
}
function engineFrom(v) {
  if (!isStruct2(v) || !Array.isArray(v.keys)) return { keys: [] };
  return { keys: v.keys.slice(0, MAX_ENGINE_KEYS) };
}
function deviceFrom(v) {
  if (!isStruct2(v) || typeof v.id !== "string" || typeof v.secret !== "string" || v.id === "" || v.secret === "") return null;
  return { id: v.id, secret: v.secret };
}
function keyString(v) {
  return typeof v === "string" && v !== "" && v.length <= ALERT_KEY_MAX;
}
function timeOrNull(v) {
  return v === null || typeof v === "number" && isFinite(v);
}
function alertFrom(v) {
  if (!isStruct2(v)) return null;
  if (!keyString(v.id) || !keyString(v.ruleId) || !keyString(v.dedupKey)) return null;
  if (typeof v.provenance !== "string" || PROVENANCES.indexOf(v.provenance) < 0) return null;
  if (typeof v.severity !== "string" || SEVERITIES.indexOf(v.severity) < 0) return null;
  if (typeof v.title !== "string" || v.title.length > ALERT_TEXT_MAX) return null;
  if (v.detail !== null && (typeof v.detail !== "string" || v.detail.length > ALERT_TEXT_MAX)) return null;
  if (typeof v.at !== "number" || !isFinite(v.at) || typeof v.active !== "boolean" || !timeOrNull(v.clearedAt)) return null;
  return {
    id: v.id,
    ruleId: v.ruleId,
    dedupKey: v.dedupKey,
    provenance: v.provenance,
    severity: v.severity,
    title: v.title,
    detail: v.detail,
    at: v.at,
    active: v.active,
    clearedAt: v.clearedAt
  };
}
function pendingFrom(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v.slice(-4 * MAX_PENDING_ALERTS)) {
    const event = alertFrom(item);
    if (event !== null) out.push(event);
  }
  return out.slice(-MAX_PENDING_ALERTS);
}
function booleanOr(v, fallback) {
  return typeof v === "boolean" ? v : fallback;
}
function codeOf(error) {
  try {
    const code = isStruct2(error) || error instanceof Error ? error.code : void 0;
    return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "error";
  } catch (e) {
    return "error";
  }
}
var StateFile = class {
  constructor(options) {
    this.fs = options.fs;
    this.log = options.log;
    const dir = String(options.dir || "").replace(/\/+$/, "");
    this.path = dir + "/" + STATE_FILE_NAME;
    this.tmpPath = this.path + ".tmp";
  }
  /** The saved state; missing, unreadable or of another version → defaults. A field of the wrong type → its default. */
  load() {
    let text2;
    try {
      if (!this.fs.existsSync(this.path)) return defaultState();
      text2 = this.fs.readFileSync(this.path, "utf8");
    } catch (error) {
      this.warn("state file: unreadable (" + codeOf(error) + "), starting clean");
      return defaultState();
    }
    let raw;
    try {
      raw = JSON.parse(text2);
    } catch (e) {
      this.warn("state file: not valid JSON, starting clean");
      return defaultState();
    }
    if (!isStruct2(raw) || raw.v !== 1) {
      this.warn("state file: unknown version, starting clean");
      return defaultState();
    }
    const defaults = defaultState();
    const loaded = {
      v: 1,
      engine: engineFrom(raw.engine),
      limits: limitsFrom(raw.limits),
      popupsEnabled: booleanOr(raw.popupsEnabled, defaults.popupsEnabled),
      asciiPopups: booleanOr(raw.asciiPopups, defaults.asciiPopups),
      device: deviceFrom(raw.device)
    };
    if (raw.paired === true && loaded.device !== null) loaded.paired = true;
    const pending = pendingFrom(raw.pendingAlerts);
    if (pending.length > 0) loaded.pendingAlerts = pending;
    return loaded;
  }
  /**
   * Writes the state to a temporary file (mode 0o600) and renames it into place. True when both steps succeeded;
   * a failure is logged and gives false, never a throw.
   */
  save(state) {
    let text2;
    try {
      text2 = JSON.stringify({
        v: 1,
        engine: state.engine,
        limits: state.limits,
        popupsEnabled: state.popupsEnabled,
        asciiPopups: state.asciiPopups,
        device: state.device,
        paired: state.paired === true,
        pendingAlerts: Array.isArray(state.pendingAlerts) ? state.pendingAlerts.slice(-MAX_PENDING_ALERTS) : []
      });
    } catch (e) {
      this.warn("state file: state could not be serialised, not saved");
      return false;
    }
    try {
      this.fs.writeFileSync(this.tmpPath, text2, { mode: STATE_FILE_MODE });
      this.fs.renameSync(this.tmpPath, this.path);
      return true;
    } catch (error) {
      this.warn("state file: save failed (" + codeOf(error) + ")");
      return false;
    }
  }
  warn(message) {
    try {
      this.log.warn(message);
    } catch (e) {
    }
  }
};

// src/ui/strings.uk.ts
var TAB_LABELS = ["ПОМІЧНИК", "ДАТЧИКИ", "СПОВІЩЕННЯ"];
var STATUS_WORDS = {
  car: { ok: "АВТО", down: "НЕМАЄ АВТО" },
  network: { ok: "МЕРЕЖА", down: "НЕМАЄ МЕРЕЖІ" },
  claude: { ok: "CLAUDE", down: "НЕМАЄ CLAUDE" }
};
var CHIPS_PARKED = [
  "Як почувається авто?",
  "Чи можна навантажувати двигун?",
  "Що з шинами?",
  "Коли наступний сервіс?",
  "Чи є помилки?",
  "Як змінилися показники за останній місяць?"
];
var CHIPS_MOVING = ["Стан авто", "Чи можна навантажувати?", "Попередження"];
var LABEL_YOUR_QUESTION = "ВАШЕ ПИТАННЯ";
var LABEL_MOVING_ANSWER = "У РУСІ · КОРОТКА ВІДПОВІДЬ";
var LABEL_ASK = "ЗАПИТАТИ";
var LABEL_RECENT_ALERTS = "ОСТАННІ СПОВІЩЕННЯ";
var LABEL_PAIRING = "ПІДКЛЮЧЕННЯ ДО ТЕЛЕФОНА";
var TEXT_NO_TURN = "Оберіть питання праворуч.";
var TEXT_PENDING = "Готую відповідь…";
var TEXT_NO_ALERTS = "Сповіщень немає.";
var TEXT_UNAVAILABLE = "Недоступно";
var TEXT_TYRE_UNAVAILABLE = "н/д";
var TEXT_TEST_POPUP = "Тестове сповіщення Copilot";
var PAIRING_LINES = [
  "Відскануйте код камерою телефона.",
  "На сторінці, що відкриється, підтвердьте підключення цього авто."
];
var PAIRING_NO_ADDRESS = "Адресу сервера не налаштовано";
var TEXT_CLOCK = "Годинник головного блока неправильний";
var PAIRING_NO_ADDRESS_NOTE = "Без неї авто не може підключитися до вашого Copilot.";
var TILE = {
  rpm: "ОБЕРТИ ДВИГУНА",
  oil: "МАСЛО",
  coolant: "ОХОЛОДЖУВАЛЬНА РІДИНА",
  gear: "ПЕРЕДАЧА І РЕЖИМ",
  fuel: "ПАЛЬНЕ",
  battery: "АКУМУЛЯТОР 12 В",
  tyresBar: "ШИНИ, БАР",
  tyres: "ШИНИ",
  intake: "ТЕМПЕРАТУРА ВПУСКУ",
  range: "ЗАПАС ХОДУ"
};
var SHORT_LABEL = {
  "ОХОЛОДЖУВАЛЬНА РІДИНА": "ОХОЛОДЖ. РІДИНА",
  "ТЕМПЕРАТУРА ВПУСКУ": "ТЕМП. ВПУСКУ"
};
var NOTE_BATTERY = "Рівень заряду, не напруга";
var NOTE_TYRE_UNIT_UNKNOWN = "Одиниця тиску невідома";
function noteRange(range) {
  return range === null ? "Запас ходу: недоступно" : `Запас ходу ${range}`;
}
function noteTyreTarget(front, rear) {
  return front === rear ? `Ціль авто: ${front}` : `Ціль авто: ${front} і ${rear}`;
}
var SEVERITY_WORD = {
  critical: "КРИТИЧНО",
  warning: "ПОПЕРЕДЖЕННЯ",
  info: "ДО ВІДОМА"
};
var PROVENANCE_TAG = {
  "bmw-check-control": "BMW CHECK CONTROL",
  "bmw-service": "СЕРВІС BMW",
  "bmw-fault-status": "ПАМ'ЯТЬ ПОМИЛОК BMW",
  "owner-configured": "ВАШ ЛІМІТ"
};
var UNIT_TEXT = {
  "rpm": "об/хв",
  "km/h": "км/год",
  "°C": "°C",
  "°F": "°F",
  "l": "л",
  "km": "км",
  "mi": "миль",
  "%": "%",
  "bar": "бар",
  "psi": "psi",
  "kPa": "кПа",
  "V": "В"
};
var UNIT_DECIMALS = { bar: 1, V: 1 };
var UNAVAILABLE_TEXT = {
  "not-reported": "Авто не надіслало це значення.",
  "invalid-value": "Авто надіслало недійсне значення.",
  "not-on-this-vehicle": "На цьому авто цього показника немає.",
  "diagnostics-disabled": "Потрібне діагностичне читання. Воно вимкнене в налаштуваннях.",
  "stale": "Значення застаріло: авто давно його не оновлювало."
};
function unavailableText(reason) {
  var _a;
  return (_a = UNAVAILABLE_TEXT[reason]) != null ? _a : UNAVAILABLE_TEXT["not-reported"];
}
var SOURCE_TEXT = {
  "passive-signal": "Сигнал авто",
  "polled-signal": "Опитування",
  "diagnostic-read": "Діагностика",
  "mock": "Демо"
};
var SECOND2 = 1e3;
var MINUTE2 = 60 * SECOND2;
var HOUR = 60 * MINUTE2;
var DAY = 24 * HOUR;
var JUST_NOW_MS = 2 * SECOND2;
function provenanceLine(source, ageMs) {
  var _a;
  return `${(_a = SOURCE_TEXT[source]) != null ? _a : SOURCE_TEXT["passive-signal"]} · ${ageText(ageMs)}`;
}
function ageText(ageMs) {
  if (!(ageMs >= JUST_NOW_MS)) return "щойно";
  if (ageMs < MINUTE2) return `${Math.floor(ageMs / SECOND2)} с тому`;
  if (ageMs < HOUR) return `${Math.floor(ageMs / MINUTE2)} хв тому`;
  if (ageMs < DAY) return `${Math.floor(ageMs / HOUR)} год тому`;
  return `${Math.floor(ageMs / DAY)} дн тому`;
}
function formatValue(value, unit) {
  var _a;
  const decimals = unit ? (_a = UNIT_DECIMALS[unit]) != null ? _a : 0 : 1;
  if (!isFinite(value)) return String(value);
  let digits = Math.abs(value).toFixed(decimals);
  if (unit === null && digits.indexOf(".") >= 0) digits = digits.replace(/\.?0+$/, "");
  const negative = value < 0 && /[1-9]/.test(digits);
  const parts = digits.split(".");
  const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return (negative ? "-" : "") + grouped + (parts[1] ? "," + parts[1] : "");
}
function unitText(unit) {
  var _a;
  return unit ? (_a = UNIT_TEXT[unit]) != null ? _a : null : null;
}
var MONTHS_GENITIVE = [
  "СІЧНЯ",
  "ЛЮТОГО",
  "БЕРЕЗНЯ",
  "КВІТНЯ",
  "ТРАВНЯ",
  "ЧЕРВНЯ",
  "ЛИПНЯ",
  "СЕРПНЯ",
  "ВЕРЕСНЯ",
  "ЖОВТНЯ",
  "ЛИСТОПАДА",
  "ГРУДНЯ"
];
function pad(n) {
  return n < 10 ? "0" + n : String(n);
}
function clock(at) {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dayOf(at, now) {
  const when = new Date(at);
  const today = new Date(now);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(when, today)) return "today";
  if (same(when, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return "yesterday";
  return "earlier";
}
function dateText(at) {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS_GENITIVE[d.getMonth()]}`;
}
function activeSince(at, now) {
  const day = dayOf(at, now);
  return "АКТИВНЕ З " + (day === "today" ? clock(at) : day === "yesterday" ? "УЧОРА" : dateText(at));
}
function clearedAt(at, now) {
  const day = dayOf(at, now);
  return "ЗНЯТО " + (day === "today" ? "О " + clock(at) : day === "yesterday" ? "ВЧОРА" : dateText(at));
}

// src/ui/theme.ts
var C = {
  ground: "#05070a",
  surface: "#0e1217",
  surfaceRaised: "#171d25",
  line: "#2c3642",
  lineStrong: "#647283",
  ink: "#f2f5f8",
  inkDim: "#a3afbc",
  signal: "#6fc3ff",
  onSignal: "#04121f",
  warning: "#ffc24a",
  critical: "#ff5647"
};
var T = {
  readingXl: { size: 72, line: 76 },
  reading: { size: 44, line: 48 },
  answerDriving: { size: 34, line: 46 },
  answer: { size: 24, line: 36 },
  title: { size: 28, line: 34 },
  label: { size: 18, line: 22 }
};
var SPACE = { s1: 4, s2: 8, s3: 16, s4: 24, s5: 40 };
var RADIUS = { sm: 6, md: 12 };
var PAGE = { w: 1600, h: 520 };
var BOX = { x: 52, y: 48, w: 1496, h: 460 };
var MIN_TARGET_H = 88;
var FONT = { text: "label", strong: "bold", reading: "light" };
var DIGITS_ONLY = /^[0-9.,:\-+%°/ kmhKMHrpmbarpsiVNCFgsxµRPDSWLOT]*$/;
function readingFont(text2) {
  return DIGITS_ONLY.test(text2) ? FONT.reading : FONT.text;
}
var APOSTROPHES2 = /[‘’ʼ′`´]/g;
var PLACEHOLDER = "□";
function fitText(text2, has) {
  if (!text2) return "";
  let out = "";
  for (const ch of text2.replace(APOSTROPHES2, "'")) {
    const cp = ch.codePointAt(0);
    out += cp === 32 || cp === 10 || has(cp) ? ch : PLACEHOLDER;
  }
  return out;
}
function opts(font, extra) {
  return Object.assign({ font, literal: true }, extra);
}
function text(p, s, x, y, size, colour, font = FONT.text, extra) {
  return p.cv.text(fitText(s, p.has), x, y, size, colour, opts(font, extra));
}
function width(p, s, size, font = FONT.text, extra) {
  return p.cv.textWidth(fitText(s, p.has), size, opts(font, extra));
}
function cut(p, s, size, maxW, font = FONT.text, extra) {
  const fitted = fitText(s, p.has);
  if (width(p, fitted, size, font, extra) <= maxW) return fitted;
  const chars = Array.from(fitted);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(p, chars.slice(0, mid).join("").replace(/\s+$/, "") + "…", size, font, extra) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("").replace(/\s+$/, "") + "…";
}
function wrap(p, s, size, maxW, maxLines, font = FONT.text, extra) {
  const lines2 = [];
  if (maxLines <= 0) return lines2;
  const paragraphs = fitText(s, p.has).split("\n");
  let truncated = false;
  outer:
    for (const para of paragraphs) {
      const words = para.split(/\s+/).filter((w) => w.length > 0);
      let line = "";
      for (const word of words) {
        const next = line ? line + " " + word : word;
        if (width(p, next, size, font, extra) <= maxW) {
          line = next;
          continue;
        }
        if (line) {
          lines2.push(line);
          if (lines2.length >= maxLines) {
            truncated = true;
            break outer;
          }
        }
        line = width(p, word, size, font, extra) <= maxW ? word : cut(p, word, size, maxW, font, extra);
      }
      if (line || words.length === 0) {
        if (lines2.length >= maxLines) {
          truncated = true;
          break;
        }
        lines2.push(line);
      }
    }
  if (truncated && lines2.length > 0) {
    const last = lines2.length - 1;
    lines2[last] = cut(p, lines2[last] + " …", size, maxW, font, extra).replace(/\s*…$/, "…");
  }
  return lines2;
}
function lines(p, ls, x, y, size, lineH, colour, font = FONT.text) {
  let base = y;
  for (const l of ls) {
    text(p, l, x, base, size, colour, font);
    base += lineH;
  }
  return base;
}
function label(p, s, x, y, colour = C.inkDim, maxW) {
  var _a;
  const spaced = { spacing: 1.4 };
  let str = s;
  if (maxW !== void 0 && width(p, str, T.label.size, FONT.strong, spaced) > maxW) {
    str = cut(p, (_a = SHORT_LABEL[s]) != null ? _a : s, T.label.size, maxW, FONT.strong, spaced);
  }
  return text(p, str, x, y, T.label.size, colour, FONT.strong, spaced);
}
function baseline(top, size, lineH) {
  return Math.round(top + (lineH - size) / 2 + size * 0.8);
}
function dashedBox(cv, x, y, w, h, r, colour = C.lineStrong) {
  const stroke = 2;
  const dash = 10;
  const gap = 7;
  const run = (from, to, put2) => {
    for (let at = from; at < to; at += dash + gap) put2(at, Math.min(dash, to - at));
  };
  run(x + r, x + w - r, (at, len) => {
    cv.fillRect(at, y, len, stroke, colour);
    cv.fillRect(at, y + h - stroke, len, stroke, colour);
  });
  run(y + r, y + h - r, (at, len) => {
    cv.fillRect(x, at, stroke, len, colour);
    cv.fillRect(x + w - stroke, at, stroke, len, colour);
  });
  cv.arc(x + r, y + r, r - stroke, r, 270, 360, colour);
  cv.arc(x + w - r, y + r, r - stroke, r, 0, 90, colour);
  cv.arc(x + w - r, y + h - r, r - stroke, r, 90, 180, colour);
  cv.arc(x + r, y + h - r, r - stroke, r, 180, 270, colour);
}
function severityColour(severity) {
  return severity === "critical" ? C.critical : severity === "warning" ? C.warning : C.signal;
}
function severityIcon(cv, severity, x, y, size, colour) {
  const k = size / 24;
  const pt = (u, v) => [x + u * k, y + v * k];
  const w = Math.max(2, 2 * k);
  const dot = (u, v) => cv.circle(x + u * k, y + v * k, w * 0.7, colour);
  if (severity === "warning") {
    cv.polyline([pt(12, 4), pt(21, 20), pt(3, 20), pt(12, 4)], w, colour);
    cv.line(x + 12 * k, y + 10 * k, x + 12 * k, y + 14 * k, w, colour);
    dot(12, 17.3);
  } else if (severity === "critical") {
    cv.polyline([pt(8.3, 3), pt(15.7, 3), pt(21, 8.3), pt(21, 15.7), pt(15.7, 21), pt(8.3, 21), pt(3, 15.7), pt(3, 8.3), pt(8.3, 3)], w, colour);
    cv.line(x + 12 * k, y + 8 * k, x + 12 * k, y + 13 * k, w, colour);
    dot(12, 16.5);
  } else {
    cv.arc(x + 12 * k, y + 12 * k, 9 * k - w / 2, 9 * k + w / 2, 0, 360, colour);
    cv.line(x + 12 * k, y + 11 * k, x + 12 * k, y + 16 * k, w, colour);
    dot(12, 7.7);
  }
}
function box(cv, x, y, w, h, fill = C.surfaceRaised) {
  cv.roundRect(x, y, w, h, RADIUS.md, fill);
}

// src/ui/draw-alerts.ts
var ROWS = 4;
var ICON = 40;
var PAD = 24;
function drawAlerts(p, vm) {
  label(p, LABEL_RECENT_ALERTS, BOX.x, baseline(BOX.y, T.label.size, T.label.line));
  const top = BOX.y + T.label.line + 12;
  if (vm.alerts.length === 0) {
    text(p, TEXT_NO_ALERTS, BOX.x, baseline(top + SPACE.s2, T.answer.size, T.answer.line), T.answer.size, C.inkDim);
    return;
  }
  const gap = SPACE.s2;
  const h = Math.floor((BOX.y + BOX.h - top - (ROWS - 1) * gap) / ROWS);
  vm.alerts.slice(0, ROWS).forEach((a, i) => {
    const y = top + i * (h + gap);
    if (a.active) {
      p.cv.roundRect(BOX.x, y, BOX.w, h, RADIUS.md, C.surfaceRaised);
      p.cv.strokeRoundRect(BOX.x + 1, y + 1, BOX.w - 2, h - 2, RADIUS.md, 2, C.lineStrong);
    } else {
      p.cv.roundRect(BOX.x, y, BOX.w, h, RADIUS.md, C.surface);
    }
    severityIcon(p.cv, a.severity, BOX.x + PAD, y + (h - ICON) / 2, ICON, severityColour(a.severity));
    const tx = BOX.x + PAD + ICON + 20;
    const room = BOX.w - (tx - BOX.x) - PAD;
    const block = T.title.line + SPACE.s2 + T.label.line;
    const blockTop = y + (h - block) / 2;
    text(p, cut(p, a.title, T.title.size, room), tx, baseline(blockTop, T.title.size, T.title.line), T.title.size, a.active ? C.ink : C.inkDim);
    label(p, a.tag, tx, baseline(blockTop + T.title.line + SPACE.s2, T.label.size, T.label.line), C.inkDim, room);
  });
}

// src/ui/qr-nayuki.ts
/*! 
 * QR Code generator library (TypeScript)
 * 
 * Copyright (c) Project Nayuki. (MIT License)
 * https://www.nayuki.io/page/qr-code-generator-library
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */
var qrcodegen;
((qrcodegen2) => {
  const _QrCode = class _QrCode {
    /*-- Constructor (low level) and fields --*/
    // Creates a new QR Code with the given version number,
    // error correction level, data codeword bytes, and mask number.
    // This is a low-level API that most users should not use directly.
    // A mid-level API is the encodeSegments() function.
    constructor(version, errorCorrectionLevel, dataCodewords, msk) {
      this.version = version;
      this.errorCorrectionLevel = errorCorrectionLevel;
      // The modules of this QR Code (false = light, true = dark).
      // Immutable after constructor finishes. Accessed through getModule().
      this.modules = [];
      // Indicates function modules that are not subjected to masking. Discarded when constructor finishes.
      this.isFunction = [];
      if (version < _QrCode.MIN_VERSION || version > _QrCode.MAX_VERSION)
        throw new RangeError("Version value out of range");
      if (msk < -1 || msk > 7)
        throw new RangeError("Mask value out of range");
      this.size = version * 4 + 17;
      let row = [];
      for (let i = 0; i < this.size; i++)
        row.push(false);
      for (let i = 0; i < this.size; i++) {
        this.modules.push(row.slice());
        this.isFunction.push(row.slice());
      }
      this.drawFunctionPatterns();
      const allCodewords = this.addEccAndInterleave(dataCodewords);
      this.drawCodewords(allCodewords);
      if (msk == -1) {
        let minPenalty = 1e9;
        for (let i = 0; i < 8; i++) {
          this.applyMask(i);
          this.drawFormatBits(i);
          const penalty = this.getPenaltyScore();
          if (penalty < minPenalty) {
            msk = i;
            minPenalty = penalty;
          }
          this.applyMask(i);
        }
      }
      assert(0 <= msk && msk <= 7);
      this.mask = msk;
      this.applyMask(msk);
      this.drawFormatBits(msk);
      this.isFunction = [];
    }
    /*-- Static factory functions (high level) --*/
    // Returns a QR Code representing the given Unicode text string at the given error correction level.
    // As a conservative upper bound, this function is guaranteed to succeed for strings that have 738 or fewer
    // Unicode code points (not UTF-16 code units) if the low error correction level is used. The smallest possible
    // QR Code version is automatically chosen for the output. The ECC level of the result may be higher than the
    // ecl argument if it can be done without increasing the version.
    static encodeText(text2, ecl) {
      const segs = qrcodegen2.QrSegment.makeSegments(text2);
      return _QrCode.encodeSegments(segs, ecl);
    }
    // Returns a QR Code representing the given binary data at the given error correction level.
    // This function always encodes using the binary segment mode, not any text mode. The maximum number of
    // bytes allowed is 2953. The smallest possible QR Code version is automatically chosen for the output.
    // The ECC level of the result may be higher than the ecl argument if it can be done without increasing the version.
    static encodeBinary(data, ecl) {
      const seg = qrcodegen2.QrSegment.makeBytes(data);
      return _QrCode.encodeSegments([seg], ecl);
    }
    /*-- Static factory functions (mid level) --*/
    // Returns a QR Code representing the given segments with the given encoding parameters.
    // The smallest possible QR Code version within the given range is automatically
    // chosen for the output. Iff boostEcl is true, then the ECC level of the result
    // may be higher than the ecl argument if it can be done without increasing the
    // version. The mask number is either between 0 to 7 (inclusive) to force that
    // mask, or -1 to automatically choose an appropriate mask (which may be slow).
    // This function allows the user to create a custom sequence of segments that switches
    // between modes (such as alphanumeric and byte) to encode text in less space.
    // This is a mid-level API; the high-level API is encodeText() and encodeBinary().
    static encodeSegments(segs, ecl, minVersion = 1, maxVersion = 40, mask = -1, boostEcl = true) {
      if (!(_QrCode.MIN_VERSION <= minVersion && minVersion <= maxVersion && maxVersion <= _QrCode.MAX_VERSION) || mask < -1 || mask > 7)
        throw new RangeError("Invalid value");
      let version;
      let dataUsedBits;
      for (version = minVersion; ; version++) {
        const dataCapacityBits2 = _QrCode.getNumDataCodewords(version, ecl) * 8;
        const usedBits = QrSegment.getTotalBits(segs, version);
        if (usedBits <= dataCapacityBits2) {
          dataUsedBits = usedBits;
          break;
        }
        if (version >= maxVersion)
          throw new RangeError("Data too long");
      }
      for (const newEcl of [_QrCode.Ecc.MEDIUM, _QrCode.Ecc.QUARTILE, _QrCode.Ecc.HIGH]) {
        if (boostEcl && dataUsedBits <= _QrCode.getNumDataCodewords(version, newEcl) * 8)
          ecl = newEcl;
      }
      let bb = [];
      for (const seg of segs) {
        appendBits(seg.mode.modeBits, 4, bb);
        appendBits(seg.numChars, seg.mode.numCharCountBits(version), bb);
        for (const b of seg.getData())
          bb.push(b);
      }
      assert(bb.length == dataUsedBits);
      const dataCapacityBits = _QrCode.getNumDataCodewords(version, ecl) * 8;
      assert(bb.length <= dataCapacityBits);
      appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
      appendBits(0, (8 - bb.length % 8) % 8, bb);
      assert(bb.length % 8 == 0);
      for (let padByte = 236; bb.length < dataCapacityBits; padByte ^= 236 ^ 17)
        appendBits(padByte, 8, bb);
      let dataCodewords = [];
      while (dataCodewords.length * 8 < bb.length)
        dataCodewords.push(0);
      bb.forEach((b, i) => dataCodewords[i >>> 3] |= b << 7 - (i & 7));
      return new _QrCode(version, ecl, dataCodewords, mask);
    }
    /*-- Accessor methods --*/
    // Returns the color of the module (pixel) at the given coordinates, which is false
    // for light or true for dark. The top left corner has the coordinates (x=0, y=0).
    // If the given coordinates are out of bounds, then false (light) is returned.
    getModule(x, y) {
      return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
    }
    /*-- Private helper methods for constructor: Drawing function modules --*/
    // Reads this object's version field, and draws and marks all function modules.
    drawFunctionPatterns() {
      for (let i = 0; i < this.size; i++) {
        this.setFunctionModule(6, i, i % 2 == 0);
        this.setFunctionModule(i, 6, i % 2 == 0);
      }
      this.drawFinderPattern(3, 3);
      this.drawFinderPattern(this.size - 4, 3);
      this.drawFinderPattern(3, this.size - 4);
      const alignPatPos = this.getAlignmentPatternPositions();
      const numAlign = alignPatPos.length;
      for (let i = 0; i < numAlign; i++) {
        for (let j = 0; j < numAlign; j++) {
          if (!(i == 0 && j == 0 || i == 0 && j == numAlign - 1 || i == numAlign - 1 && j == 0))
            this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
        }
      }
      this.drawFormatBits(0);
      this.drawVersion();
    }
    // Draws two copies of the format bits (with its own error correction code)
    // based on the given mask and this object's error correction level field.
    drawFormatBits(mask) {
      const data = this.errorCorrectionLevel.formatBits << 3 | mask;
      let rem = data;
      for (let i = 0; i < 10; i++)
        rem = rem << 1 ^ (rem >>> 9) * 1335;
      const bits = (data << 10 | rem) ^ 21522;
      assert(bits >>> 15 == 0);
      for (let i = 0; i <= 5; i++)
        this.setFunctionModule(8, i, getBit(bits, i));
      this.setFunctionModule(8, 7, getBit(bits, 6));
      this.setFunctionModule(8, 8, getBit(bits, 7));
      this.setFunctionModule(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i++)
        this.setFunctionModule(14 - i, 8, getBit(bits, i));
      for (let i = 0; i < 8; i++)
        this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
      for (let i = 8; i < 15; i++)
        this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
      this.setFunctionModule(8, this.size - 8, true);
    }
    // Draws two copies of the version bits (with its own error correction code),
    // based on this object's version field, iff 7 <= version <= 40.
    drawVersion() {
      if (this.version < 7)
        return;
      let rem = this.version;
      for (let i = 0; i < 12; i++)
        rem = rem << 1 ^ (rem >>> 11) * 7973;
      const bits = this.version << 12 | rem;
      assert(bits >>> 18 == 0);
      for (let i = 0; i < 18; i++) {
        const color = getBit(bits, i);
        const a = this.size - 11 + i % 3;
        const b = Math.floor(i / 3);
        this.setFunctionModule(a, b, color);
        this.setFunctionModule(b, a, color);
      }
    }
    // Draws a 9*9 finder pattern including the border separator,
    // with the center module at (x, y). Modules can be out of bounds.
    drawFinderPattern(x, y) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const xx = x + dx;
          const yy = y + dy;
          if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size)
            this.setFunctionModule(xx, yy, dist != 2 && dist != 4);
        }
      }
    }
    // Draws a 5*5 alignment pattern, with the center module
    // at (x, y). All modules must be in bounds.
    drawAlignmentPattern(x, y) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++)
          this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1);
      }
    }
    // Sets the color of a module and marks it as a function module.
    // Only used by the constructor. Coordinates must be in bounds.
    setFunctionModule(x, y, isDark) {
      this.modules[y][x] = isDark;
      this.isFunction[y][x] = true;
    }
    /*-- Private helper methods for constructor: Codewords and masking --*/
    // Returns a new byte string representing the given data with the appropriate error correction
    // codewords appended to it, based on this object's version and error correction level.
    addEccAndInterleave(data) {
      const ver = this.version;
      const ecl = this.errorCorrectionLevel;
      if (data.length != _QrCode.getNumDataCodewords(ver, ecl))
        throw new RangeError("Invalid argument");
      const numBlocks = _QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
      const blockEccLen = _QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
      const rawCodewords = Math.floor(_QrCode.getNumRawDataModules(ver) / 8);
      const numShortBlocks = numBlocks - rawCodewords % numBlocks;
      const shortBlockLen = Math.floor(rawCodewords / numBlocks);
      let blocks = [];
      const rsDiv = _QrCode.reedSolomonComputeDivisor(blockEccLen);
      for (let i = 0, k = 0; i < numBlocks; i++) {
        let dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
        k += dat.length;
        const ecc = _QrCode.reedSolomonComputeRemainder(dat, rsDiv);
        if (i < numShortBlocks)
          dat.push(0);
        blocks.push(dat.concat(ecc));
      }
      let result = [];
      for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
          if (i != shortBlockLen - blockEccLen || j >= numShortBlocks)
            result.push(block[i]);
        });
      }
      assert(result.length == rawCodewords);
      return result;
    }
    // Draws the given sequence of 8-bit codewords (data and error correction) onto the entire
    // data area of this QR Code. Function modules need to be marked off before this is called.
    drawCodewords(data) {
      if (data.length != Math.floor(_QrCode.getNumRawDataModules(this.version) / 8))
        throw new RangeError("Invalid argument");
      let i = 0;
      for (let right = this.size - 1; right >= 1; right -= 2) {
        if (right == 6)
          right = 5;
        for (let vert = 0; vert < this.size; vert++) {
          for (let j = 0; j < 2; j++) {
            const x = right - j;
            const upward = (right + 1 & 2) == 0;
            const y = upward ? this.size - 1 - vert : vert;
            if (!this.isFunction[y][x] && i < data.length * 8) {
              this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
              i++;
            }
          }
        }
      }
      assert(i == data.length * 8);
    }
    // XORs the codeword modules in this QR Code with the given mask pattern.
    // The function modules must be marked and the codeword bits must be drawn
    // before masking. Due to the arithmetic of XOR, calling applyMask() with
    // the same mask value a second time will undo the mask. A final well-formed
    // QR Code needs exactly one (not zero, two, etc.) mask applied.
    applyMask(mask) {
      if (mask < 0 || mask > 7)
        throw new RangeError("Mask value out of range");
      for (let y = 0; y < this.size; y++) {
        for (let x = 0; x < this.size; x++) {
          let invert;
          switch (mask) {
            case 0:
              invert = (x + y) % 2 == 0;
              break;
            case 1:
              invert = y % 2 == 0;
              break;
            case 2:
              invert = x % 3 == 0;
              break;
            case 3:
              invert = (x + y) % 3 == 0;
              break;
            case 4:
              invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 == 0;
              break;
            case 5:
              invert = x * y % 2 + x * y % 3 == 0;
              break;
            case 6:
              invert = (x * y % 2 + x * y % 3) % 2 == 0;
              break;
            case 7:
              invert = ((x + y) % 2 + x * y % 3) % 2 == 0;
              break;
            default:
              throw new Error("Unreachable");
          }
          if (!this.isFunction[y][x] && invert)
            this.modules[y][x] = !this.modules[y][x];
        }
      }
    }
    // Calculates and returns the penalty score based on state of this QR Code's current modules.
    // This is used by the automatic mask choice algorithm to find the mask pattern that yields the lowest score.
    getPenaltyScore() {
      let result = 0;
      for (let y = 0; y < this.size; y++) {
        let runColor = false;
        let runX = 0;
        let runHistory = [0, 0, 0, 0, 0, 0, 0];
        for (let x = 0; x < this.size; x++) {
          if (this.modules[y][x] == runColor) {
            runX++;
            if (runX == 5)
              result += _QrCode.PENALTY_N1;
            else if (runX > 5)
              result++;
          } else {
            this.finderPenaltyAddHistory(runX, runHistory);
            if (!runColor)
              result += this.finderPenaltyCountPatterns(runHistory) * _QrCode.PENALTY_N3;
            runColor = this.modules[y][x];
            runX = 1;
          }
        }
        result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * _QrCode.PENALTY_N3;
      }
      for (let x = 0; x < this.size; x++) {
        let runColor = false;
        let runY = 0;
        let runHistory = [0, 0, 0, 0, 0, 0, 0];
        for (let y = 0; y < this.size; y++) {
          if (this.modules[y][x] == runColor) {
            runY++;
            if (runY == 5)
              result += _QrCode.PENALTY_N1;
            else if (runY > 5)
              result++;
          } else {
            this.finderPenaltyAddHistory(runY, runHistory);
            if (!runColor)
              result += this.finderPenaltyCountPatterns(runHistory) * _QrCode.PENALTY_N3;
            runColor = this.modules[y][x];
            runY = 1;
          }
        }
        result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * _QrCode.PENALTY_N3;
      }
      for (let y = 0; y < this.size - 1; y++) {
        for (let x = 0; x < this.size - 1; x++) {
          const color = this.modules[y][x];
          if (color == this.modules[y][x + 1] && color == this.modules[y + 1][x] && color == this.modules[y + 1][x + 1])
            result += _QrCode.PENALTY_N2;
        }
      }
      let dark = 0;
      for (const row of this.modules)
        dark = row.reduce((sum, color) => sum + (color ? 1 : 0), dark);
      const total = this.size * this.size;
      const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      assert(0 <= k && k <= 9);
      result += k * _QrCode.PENALTY_N4;
      assert(0 <= result && result <= 2568888);
      return result;
    }
    /*-- Private helper functions --*/
    // Returns an ascending list of positions of alignment patterns for this version number.
    // Each position is in the range [0,177), and are used on both the x and y axes.
    // This could be implemented as lookup table of 40 variable-length lists of integers.
    getAlignmentPatternPositions() {
      if (this.version == 1)
        return [];
      else {
        const numAlign = Math.floor(this.version / 7) + 2;
        const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
        let result = [6];
        for (let pos = this.size - 7; result.length < numAlign; pos -= step)
          result.splice(1, 0, pos);
        return result;
      }
    }
    // Returns the number of data bits that can be stored in a QR Code of the given version number, after
    // all function modules are excluded. This includes remainder bits, so it might not be a multiple of 8.
    // The result is in the range [208, 29648]. This could be implemented as a 40-entry lookup table.
    static getNumRawDataModules(ver) {
      if (ver < _QrCode.MIN_VERSION || ver > _QrCode.MAX_VERSION)
        throw new RangeError("Version number out of range");
      let result = (16 * ver + 128) * ver + 64;
      if (ver >= 2) {
        const numAlign = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7)
          result -= 36;
      }
      assert(208 <= result && result <= 29648);
      return result;
    }
    // Returns the number of 8-bit data (i.e. not error correction) codewords contained in any
    // QR Code of the given version number and error correction level, with remainder bits discarded.
    // This stateless pure function could be implemented as a (40*4)-cell lookup table.
    static getNumDataCodewords(ver, ecl) {
      return Math.floor(_QrCode.getNumRawDataModules(ver) / 8) - _QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * _QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
    }
    // Returns a Reed-Solomon ECC generator polynomial for the given degree. This could be
    // implemented as a lookup table over all possible parameter values, instead of as an algorithm.
    static reedSolomonComputeDivisor(degree) {
      if (degree < 1 || degree > 255)
        throw new RangeError("Degree out of range");
      let result = [];
      for (let i = 0; i < degree - 1; i++)
        result.push(0);
      result.push(1);
      let root = 1;
      for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
          result[j] = _QrCode.reedSolomonMultiply(result[j], root);
          if (j + 1 < result.length)
            result[j] ^= result[j + 1];
        }
        root = _QrCode.reedSolomonMultiply(root, 2);
      }
      return result;
    }
    // Returns the Reed-Solomon error correction codeword for the given data and divisor polynomials.
    static reedSolomonComputeRemainder(data, divisor) {
      let result = divisor.map((_) => 0);
      for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => result[i] ^= _QrCode.reedSolomonMultiply(coef, factor));
      }
      return result;
    }
    // Returns the product of the two given field elements modulo GF(2^8/0x11D). The arguments and result
    // are unsigned 8-bit integers. This could be implemented as a lookup table of 256*256 entries of uint8.
    static reedSolomonMultiply(x, y) {
      if (x >>> 8 != 0 || y >>> 8 != 0)
        throw new RangeError("Byte out of range");
      let z = 0;
      for (let i = 7; i >= 0; i--) {
        z = z << 1 ^ (z >>> 7) * 285;
        z ^= (y >>> i & 1) * x;
      }
      assert(z >>> 8 == 0);
      return z;
    }
    // Can only be called immediately after a light run is added, and
    // returns either 0, 1, or 2. A helper function for getPenaltyScore().
    finderPenaltyCountPatterns(runHistory) {
      const n = runHistory[1];
      assert(n <= this.size * 3);
      const core = n > 0 && runHistory[2] == n && runHistory[3] == n * 3 && runHistory[4] == n && runHistory[5] == n;
      return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
    }
    // Must be called at the end of a line (row or column) of modules. A helper function for getPenaltyScore().
    finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
      if (currentRunColor) {
        this.finderPenaltyAddHistory(currentRunLength, runHistory);
        currentRunLength = 0;
      }
      currentRunLength += this.size;
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      return this.finderPenaltyCountPatterns(runHistory);
    }
    // Pushes the given value to the front and drops the last value. A helper function for getPenaltyScore().
    finderPenaltyAddHistory(currentRunLength, runHistory) {
      if (runHistory[0] == 0)
        currentRunLength += this.size;
      runHistory.pop();
      runHistory.unshift(currentRunLength);
    }
  };
  /*-- Constants and tables --*/
  // The minimum version number supported in the QR Code Model 2 standard.
  _QrCode.MIN_VERSION = 1;
  // The maximum version number supported in the QR Code Model 2 standard.
  _QrCode.MAX_VERSION = 40;
  // For use in getPenaltyScore(), when evaluating which mask is best.
  _QrCode.PENALTY_N1 = 3;
  _QrCode.PENALTY_N2 = 3;
  _QrCode.PENALTY_N3 = 40;
  _QrCode.PENALTY_N4 = 10;
  _QrCode.ECC_CODEWORDS_PER_BLOCK = [
    // Version: (note that index 0 is for padding, and is set to an illegal value)
    //0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40    Error correction level
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    // Low
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    // Medium
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    // Quartile
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
    // High
  ];
  _QrCode.NUM_ERROR_CORRECTION_BLOCKS = [
    // Version: (note that index 0 is for padding, and is set to an illegal value)
    //0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40    Error correction level
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    // Low
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    // Medium
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    // Quartile
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
    // High
  ];
  let QrCode = _QrCode;
  qrcodegen2.QrCode = _QrCode;
  function appendBits(val, len, bb) {
    if (len < 0 || len > 31 || val >>> len != 0)
      throw new RangeError("Value out of range");
    for (let i = len - 1; i >= 0; i--)
      bb.push(val >>> i & 1);
  }
  function getBit(x, i) {
    return (x >>> i & 1) != 0;
  }
  function assert(cond) {
    if (!cond)
      throw new Error("Assertion error");
  }
  const _QrSegment = class _QrSegment {
    /*-- Constructor (low level) and fields --*/
    // Creates a new QR Code segment with the given attributes and data.
    // The character count (numChars) must agree with the mode and the bit buffer length,
    // but the constraint isn't checked. The given bit buffer is cloned and stored.
    constructor(mode, numChars, bitData) {
      this.mode = mode;
      this.numChars = numChars;
      this.bitData = bitData;
      if (numChars < 0)
        throw new RangeError("Invalid argument");
      this.bitData = bitData.slice();
    }
    /*-- Static factory functions (mid level) --*/
    // Returns a segment representing the given binary data encoded in
    // byte mode. All input byte arrays are acceptable. Any text string
    // can be converted to UTF-8 bytes and encoded as a byte mode segment.
    static makeBytes(data) {
      let bb = [];
      for (const b of data)
        appendBits(b, 8, bb);
      return new _QrSegment(_QrSegment.Mode.BYTE, data.length, bb);
    }
    // Returns a segment representing the given string of decimal digits encoded in numeric mode.
    static makeNumeric(digits) {
      if (!_QrSegment.isNumeric(digits))
        throw new RangeError("String contains non-numeric characters");
      let bb = [];
      for (let i = 0; i < digits.length; ) {
        const n = Math.min(digits.length - i, 3);
        appendBits(parseInt(digits.substring(i, i + n), 10), n * 3 + 1, bb);
        i += n;
      }
      return new _QrSegment(_QrSegment.Mode.NUMERIC, digits.length, bb);
    }
    // Returns a segment representing the given text string encoded in alphanumeric mode.
    // The characters allowed are: 0 to 9, A to Z (uppercase only), space,
    // dollar, percent, asterisk, plus, hyphen, period, slash, colon.
    static makeAlphanumeric(text2) {
      if (!_QrSegment.isAlphanumeric(text2))
        throw new RangeError("String contains unencodable characters in alphanumeric mode");
      let bb = [];
      let i;
      for (i = 0; i + 2 <= text2.length; i += 2) {
        let temp = _QrSegment.ALPHANUMERIC_CHARSET.indexOf(text2.charAt(i)) * 45;
        temp += _QrSegment.ALPHANUMERIC_CHARSET.indexOf(text2.charAt(i + 1));
        appendBits(temp, 11, bb);
      }
      if (i < text2.length)
        appendBits(_QrSegment.ALPHANUMERIC_CHARSET.indexOf(text2.charAt(i)), 6, bb);
      return new _QrSegment(_QrSegment.Mode.ALPHANUMERIC, text2.length, bb);
    }
    // Returns a new mutable list of zero or more segments to represent the given Unicode text string.
    // The result may use various segment modes and switch modes to optimize the length of the bit stream.
    static makeSegments(text2) {
      if (text2 == "")
        return [];
      else if (_QrSegment.isNumeric(text2))
        return [_QrSegment.makeNumeric(text2)];
      else if (_QrSegment.isAlphanumeric(text2))
        return [_QrSegment.makeAlphanumeric(text2)];
      else
        return [_QrSegment.makeBytes(_QrSegment.toUtf8ByteArray(text2))];
    }
    // Returns a segment representing an Extended Channel Interpretation
    // (ECI) designator with the given assignment value.
    static makeEci(assignVal) {
      let bb = [];
      if (assignVal < 0)
        throw new RangeError("ECI assignment value out of range");
      else if (assignVal < 1 << 7)
        appendBits(assignVal, 8, bb);
      else if (assignVal < 1 << 14) {
        appendBits(2, 2, bb);
        appendBits(assignVal, 14, bb);
      } else if (assignVal < 1e6) {
        appendBits(6, 3, bb);
        appendBits(assignVal, 21, bb);
      } else
        throw new RangeError("ECI assignment value out of range");
      return new _QrSegment(_QrSegment.Mode.ECI, 0, bb);
    }
    // Tests whether the given string can be encoded as a segment in numeric mode.
    // A string is encodable iff each character is in the range 0 to 9.
    static isNumeric(text2) {
      return _QrSegment.NUMERIC_REGEX.test(text2);
    }
    // Tests whether the given string can be encoded as a segment in alphanumeric mode.
    // A string is encodable iff each character is in the following set: 0 to 9, A to Z
    // (uppercase only), space, dollar, percent, asterisk, plus, hyphen, period, slash, colon.
    static isAlphanumeric(text2) {
      return _QrSegment.ALPHANUMERIC_REGEX.test(text2);
    }
    /*-- Methods --*/
    // Returns a new copy of the data bits of this segment.
    getData() {
      return this.bitData.slice();
    }
    // (Package-private) Calculates and returns the number of bits needed to encode the given segments at
    // the given version. The result is infinity if a segment has too many characters to fit its length field.
    static getTotalBits(segs, version) {
      let result = 0;
      for (const seg of segs) {
        const ccbits = seg.mode.numCharCountBits(version);
        if (seg.numChars >= 1 << ccbits)
          return Infinity;
        result += 4 + ccbits + seg.bitData.length;
      }
      return result;
    }
    // Returns a new array of bytes representing the given string encoded in UTF-8.
    static toUtf8ByteArray(str) {
      str = encodeURI(str);
      let result = [];
      for (let i = 0; i < str.length; i++) {
        if (str.charAt(i) != "%")
          result.push(str.charCodeAt(i));
        else {
          result.push(parseInt(str.substring(i + 1, i + 3), 16));
          i += 2;
        }
      }
      return result;
    }
  };
  /*-- Constants --*/
  // Describes precisely all strings that are encodable in numeric mode.
  _QrSegment.NUMERIC_REGEX = /^[0-9]*$/;
  // Describes precisely all strings that are encodable in alphanumeric mode.
  _QrSegment.ALPHANUMERIC_REGEX = /^[A-Z0-9 $%*+.\/:-]*$/;
  // The set of all legal characters in alphanumeric mode,
  // where each character value maps to the index in the string.
  _QrSegment.ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  let QrSegment = _QrSegment;
  qrcodegen2.QrSegment = _QrSegment;
})(qrcodegen || (qrcodegen = {}));
((qrcodegen2) => {
  let QrCode;
  ((QrCode2) => {
    const _Ecc = class _Ecc {
      // The QR Code can tolerate about 30% erroneous codewords
      /*-- Constructor and fields --*/
      constructor(ordinal, formatBits) {
        this.ordinal = ordinal;
        this.formatBits = formatBits;
      }
    };
    /*-- Constants --*/
    _Ecc.LOW = new _Ecc(0, 1);
    // The QR Code can tolerate about  7% erroneous codewords
    _Ecc.MEDIUM = new _Ecc(1, 0);
    // The QR Code can tolerate about 15% erroneous codewords
    _Ecc.QUARTILE = new _Ecc(2, 3);
    // The QR Code can tolerate about 25% erroneous codewords
    _Ecc.HIGH = new _Ecc(3, 2);
    let Ecc = _Ecc;
    QrCode2.Ecc = _Ecc;
  })(QrCode = qrcodegen2.QrCode || (qrcodegen2.QrCode = {}));
})(qrcodegen || (qrcodegen = {}));
((qrcodegen2) => {
  let QrSegment;
  ((QrSegment2) => {
    const _Mode = class _Mode {
      /*-- Constructor and fields --*/
      constructor(modeBits, numBitsCharCount) {
        this.modeBits = modeBits;
        this.numBitsCharCount = numBitsCharCount;
      }
      /*-- Method --*/
      // (Package-private) Returns the bit width of the character count field for a segment in
      // this mode in a QR Code at the given version number. The result is in the range [0, 16].
      numCharCountBits(ver) {
        return this.numBitsCharCount[Math.floor((ver + 7) / 17)];
      }
    };
    /*-- Constants --*/
    _Mode.NUMERIC = new _Mode(1, [10, 12, 14]);
    _Mode.ALPHANUMERIC = new _Mode(2, [9, 11, 13]);
    _Mode.BYTE = new _Mode(4, [8, 16, 16]);
    _Mode.KANJI = new _Mode(8, [8, 10, 12]);
    _Mode.ECI = new _Mode(7, [0, 0, 0]);
    let Mode = _Mode;
    QrSegment2.Mode = _Mode;
  })(QrSegment = qrcodegen2.QrSegment || (qrcodegen2.QrSegment = {}));
})(qrcodegen || (qrcodegen = {}));

// src/ui/qr.ts
function encodeQr(text2) {
  const qr = qrcodegen.QrCode.encodeText(text2, qrcodegen.QrCode.Ecc.MEDIUM);
  const rows = [];
  for (let y = 0; y < qr.size; y++) {
    const row = [];
    for (let x = 0; x < qr.size; x++) row.push(qr.getModule(x, y));
    rows.push(row);
  }
  return rows;
}

// src/ui/draw-pairing.ts
var QUIET = 4;
function pairingLines(pairing) {
  if (!pairing.url) return [PAIRING_NO_ADDRESS, PAIRING_NO_ADDRESS_NOTE];
  return pairing.note ? [pairing.note] : PAIRING_LINES.slice();
}
var cached = null;
function matrixFor(url) {
  if (!cached || cached.text !== url) cached = { text: url, matrix: encodeQr(url) };
  return cached.matrix;
}
function drawQr(p, url, x, y, side) {
  const m = matrixFor(url);
  const n = m.length + 2 * QUIET;
  const k = Math.max(1, Math.floor(side / n));
  const used = n * k;
  p.cv.fillRect(x, y, used, used, C.ink);
  for (let r = 0; r < m.length; r++) {
    let c = 0;
    while (c < m.length) {
      if (!m[r][c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < m.length && m[r][c]) c++;
      p.cv.fillRect(x + (QUIET + start) * k, y + (QUIET + r) * k, (c - start) * k, k, C.ground);
    }
  }
  return used;
}
function drawPairing(p, pairing, x, y, w, h) {
  box(p.cv, x, y, w, h, C.surface);
  const pad2 = SPACE.s4;
  let tx = x + pad2;
  if (pairing.url) {
    const used = drawQr(p, pairing.url, x + pad2, y + pad2, h - 2 * pad2);
    tx = x + pad2 + used + SPACE.s5;
  }
  const room = x + w - pad2 - tx;
  label(p, LABEL_PAIRING, tx, baseline(y + pad2 + SPACE.s2, T.label.size, T.label.line), C.inkDim, room);
  const [first, second] = pairingLines(pairing);
  let top = y + pad2 + SPACE.s2 + T.label.line + SPACE.s3;
  const head = wrap(p, first, T.title.size, room, 2);
  lines(p, head, tx, baseline(top, T.title.size, T.title.line), T.title.size, T.title.line, C.ink);
  top += head.length * T.title.line + SPACE.s3;
  if (second === void 0) return;
  const rest = wrap(p, second, T.answer.size, room, 3);
  lines(p, rest, tx, baseline(top, T.answer.size, T.answer.line), T.answer.size, T.answer.line, C.inkDim);
}

// src/ui/draw-assistant.ts
var STRIP_H = 96;
var MAIN_H = BOX.h - STRIP_H - SPACE.s3;
var LEFT_W = Math.round((BOX.w - SPACE.s4) * 7 / 12);
var RIGHT_X = BOX.x + LEFT_W + SPACE.s4;
var RIGHT_W = BOX.x + BOX.w - RIGHT_X;
var STANDING_ANSWER_MAX = 8;
var MOVING_ANSWER_MAX = 3;
function drawStripTile(p, tile, x, y, w, h) {
  const pad2 = 20;
  const inner = w - 2 * pad2;
  if (!tile.available) {
    dashedBox(p.cv, x, y, w, h, RADIUS.md);
    label(p, tile.label, x + pad2, baseline(y + 12, T.label.size, T.label.line), C.inkDim, inner);
    text(p, tile.value, x + pad2, baseline(y + 12 + T.label.line + SPACE.s1, T.answer.size, 30), T.answer.size, C.inkDim);
    if (tile.note) text(p, cut(p, tile.note, T.label.size, inner), x + pad2, baseline(y + h - 12 - T.label.line, T.label.size, T.label.line), T.label.size, C.inkDim);
    return;
  }
  box(p.cv, x, y, w, h, C.surface);
  label(p, tile.label, x + pad2, baseline(y + 12, T.label.size, T.label.line), C.inkDim, inner);
  const base = baseline(y + 12 + T.label.line + SPACE.s1, T.reading.size, T.reading.line);
  const font = readingFont(tile.value);
  const unitW = tile.unit ? width(p, tile.unit, T.answer.size) + 10 : 0;
  const vw = text(p, cut(p, tile.value, T.reading.size, inner - unitW, font), x + pad2, base, T.reading.size, C.ink, font);
  if (tile.unit) text(p, tile.unit, x + pad2 + vw + 10, base, T.answer.size, C.inkDim);
}
function drawStrip(p, tiles) {
  const gap = SPACE.s2;
  const y = BOX.y + BOX.h - STRIP_H;
  const w = (BOX.w - (tiles.length - 1) * gap) / tiles.length;
  tiles.forEach((tile, i) => drawStripTile(p, tile, BOX.x + i * (w + gap), y, w, STRIP_H));
}
function drawDialog(p, vm) {
  const a = vm.assistant;
  const x = BOX.x;
  const y = BOX.y;
  box(p.cv, x, y, LEFT_W, MAIN_H, C.surface);
  const padX = 28;
  const inner = LEFT_W - 2 * padX;
  let top = y + SPACE.s4;
  label(p, vm.moving ? LABEL_MOVING_ANSWER : LABEL_YOUR_QUESTION, x + padX, baseline(top, T.label.size, T.label.line), C.inkDim, inner);
  top += T.label.line + 12;
  if (a.question) {
    if (vm.moving) {
      text(p, cut(p, a.question, T.answer.size, inner), x + padX, baseline(top, T.answer.size, 32), T.answer.size, C.inkDim);
      top += 32 + SPACE.s3;
    } else {
      text(p, cut(p, a.question, T.title.size, inner, FONT.strong), x + padX, baseline(top, T.title.size, T.title.line), T.title.size, C.ink, FONT.strong);
      top += T.title.line + SPACE.s3;
    }
  }
  const style = vm.moving ? T.answerDriving : T.answer;
  const bottom = y + MAIN_H - SPACE.s4;
  const fit = Math.max(1, Math.floor((bottom - top) / style.line));
  const max = Math.min(vm.moving ? MOVING_ANSWER_MAX : STANDING_ANSWER_MAX, fit);
  const body = a.error !== null ? a.error : a.pending ? TEXT_PENDING : a.answer !== null ? a.answer : TEXT_NO_TURN;
  const colour = a.error !== null || a.answer !== null ? C.ink : C.inkDim;
  lines(p, wrap(p, body, style.size, inner, max), x + padX, baseline(top, style.size, style.line), style.size, style.line, colour);
}
function drawChips(p, vm, onChip) {
  label(p, LABEL_ASK, RIGHT_X, baseline(BOX.y, T.label.size, T.label.line), C.inkDim, RIGHT_W);
  const chips = vm.assistant.chips;
  const cols = vm.moving ? 1 : 2;
  const rows = Math.ceil(chips.length / cols);
  const top = BOX.y + T.label.line + 12;
  const gap = SPACE.s2;
  const w = (RIGHT_W - (cols - 1) * gap) / cols;
  const h = Math.max(MIN_TARGET_H, Math.floor((BOX.y + MAIN_H - top - (rows - 1) * gap) / rows));
  const style = vm.moving ? { size: T.title.size, line: 36, max: 2 } : { size: 22, line: 27, max: 3 };
  const pad2 = vm.moving ? 32 : 20;
  chips.forEach((question, i) => {
    const cx = RIGHT_X + i % cols * (w + gap);
    const cy = top + Math.floor(i / cols) * (h + gap);
    box(p.cv, cx, cy, w, h);
    const ls = wrap(p, question, style.size, w - 2 * pad2, style.max, FONT.strong);
    const first = cy + (h - ls.length * style.line) / 2;
    lines(p, ls, cx + pad2, baseline(first, style.size, style.line), style.size, style.line, C.ink, FONT.strong);
    p.cv.target(cx, cy, w, h, () => onChip(question), "chip:" + i, RADIUS.md);
  });
}
function drawAssistant(p, vm, onChip) {
  if (!vm.pairing.paired) {
    drawPairing(p, vm.pairing, BOX.x, BOX.y, BOX.w, MAIN_H);
  } else {
    drawDialog(p, vm);
    drawChips(p, vm, onChip);
  }
  drawStrip(p, vm.assistant.strip);
}

// src/ui/view-model.ts
var TABS = ["assistant", "sensors", "alerts"];
var ALERTS_SHOWN = 4;
var CAR_FRESH_MS = 1e4;
var NOT_REPORTED = { available: false, reason: "not-reported" };
var SECOND_MS = 1e3;
function shownAge(at, now) {
  return Math.max(0, Math.floor(now / SECOND_MS) - Math.floor(at / SECOND_MS)) * SECOND_MS;
}
function pairingUrl(backendUrl, device) {
  if (!backendUrl || !device) return null;
  const base = backendUrl.replace(/\/+$/, "");
  return `${base}/pair#d=${encodeURIComponent(device.id)}&s=${encodeURIComponent(device.secret)}`;
}
function unavailableTile(label2, reading) {
  const reason = reading.available ? "not-reported" : reading.reason;
  return { label: label2, value: TEXT_UNAVAILABLE, unit: null, note: unavailableText(reason), available: false };
}
function numberTile(label2, reading, now, detail) {
  if (!reading.available) return unavailableTile(label2, reading);
  const age = provenanceLine(reading.source, shownAge(reading.at, now));
  return {
    label: label2,
    value: formatValue(reading.value, reading.unit),
    unit: unitText(reading.unit),
    note: detail === null ? age : `${detail}
${age}`,
    available: true
  };
}
function stripTile(label2, reading) {
  if (!reading.available) return unavailableTile(label2, reading);
  return { label: label2, value: formatValue(reading.value, reading.unit), unit: unitText(reading.unit), note: null, available: true };
}
function gearTile(s, now) {
  const gear = s.gear;
  if (!gear.available) return unavailableTile(TILE.gear, gear);
  const age = provenanceLine(gear.source, shownAge(gear.at, now));
  const mode = s.driveMode.available ? s.driveMode.value : null;
  return { label: TILE.gear, value: gear.value, unit: null, note: mode === null ? age : `${mode}
${age}`, available: true };
}
function fuelTile(s, now) {
  var _a;
  const range = s.range.available ? `${formatValue(s.range.value, s.range.unit)} ${(_a = unitText(s.range.unit)) != null ? _a : ""}`.trim() : null;
  return numberTile(TILE.fuel, s.fuelLevel, now, noteRange(range));
}
var TYRE_ORDER = ["frontLeft", "frontRight", "rearLeft", "rearRight"];
function tyreTile(s, now) {
  const all = TYRE_ORDER.map((k) => s.tyrePressure[k]);
  const known = all.filter((r) => r.available);
  if (known.length === 0) return unavailableTile(TILE.tyresBar, all[0]);
  const inBar = known.every((r) => r.unit === "bar");
  const cell = (r) => r.available ? formatValue(r.value, inBar ? "bar" : null) : TEXT_TYRE_UNAVAILABLE;
  const value = `${cell(all[0])} ${cell(all[1])}
${cell(all[2])} ${cell(all[3])}`;
  const details = [];
  if (!inBar) details.push(NOTE_TYRE_UNIT_UNKNOWN);
  const t = s.tyrePressureTarget;
  if (inBar && t.frontLeft.available && t.rearLeft.available && t.frontLeft.unit === "bar" && t.rearLeft.unit === "bar") {
    details.push(noteTyreTarget(formatValue(t.frontLeft.value, "bar"), formatValue(t.rearLeft.value, "bar")));
  }
  const oldest = known.reduce((a, b) => b.at < a.at ? b : a);
  details.push(provenanceLine(oldest.source, shownAge(oldest.at, now)));
  return { label: inBar ? TILE.tyresBar : TILE.tyres, value, unit: null, note: details.join("\n"), available: true };
}
function sensorTiles(s, now) {
  return [
    numberTile(TILE.rpm, s.engineRpm, now, null),
    numberTile(TILE.oil, s.oilTemp, now, null),
    numberTile(TILE.coolant, s.coolantTemp, now, null),
    gearTile(s, now),
    fuelTile(s, now),
    numberTile(TILE.battery, s.battery12vCharge, now, NOTE_BATTERY),
    tyreTile(s, now),
    numberTile(TILE.intake, s.intakeTemp, now, null)
  ];
}
function emptyTiles() {
  return [TILE.rpm, TILE.oil, TILE.coolant, TILE.gear, TILE.fuel, TILE.battery, TILE.tyresBar, TILE.intake].map((label2) => unavailableTile(label2, NOT_REPORTED));
}
function strip(s, moving) {
  const r = (pick) => s ? pick(s) : NOT_REPORTED;
  const oil = stripTile(TILE.oil, r((x) => x.oilTemp));
  const coolant = stripTile(TILE.coolant, r((x) => x.coolantTemp));
  const range = stripTile(TILE.range, r((x) => x.range));
  if (moving) return [oil, coolant, range];
  return [oil, coolant, stripTile(TILE.battery, r((x) => x.battery12vCharge)), stripTile(TILE.fuel, r((x) => x.fuelLevel)), range];
}
var SEVERITY_RANK3 = { critical: 0, warning: 1, info: 2 };
function alertRows(alerts, now) {
  return alerts.slice().sort((a, b) => {
    var _a, _b, _c, _d;
    return Number(b.active) - Number(a.active) || ((_a = SEVERITY_RANK3[a.severity]) != null ? _a : 1) - ((_b = SEVERITY_RANK3[b.severity]) != null ? _b : 1) || (b.active ? b.at - a.at : ((_c = b.clearedAt) != null ? _c : b.at) - ((_d = a.clearedAt) != null ? _d : a.at));
  }).slice(0, ALERTS_SHOWN).map((a) => {
    var _a, _b;
    const when = a.active ? activeSince(a.at, now) : clearedAt((_a = a.clearedAt) != null ? _a : a.at, now);
    const severity = SEVERITY_WORD[a.severity] ? a.severity : "warning";
    return {
      title: a.title,
      tag: `${SEVERITY_WORD[severity]} · ${(_b = PROVENANCE_TAG[a.provenance]) != null ? _b : PROVENANCE_TAG["bmw-check-control"]} · ${when}`,
      severity,
      active: a.active
    };
  });
}
function anyReading(s) {
  for (const key of Object.keys(s)) {
    const v = s[key];
    if (v && typeof v === "object") {
      if (v.available === true) return true;
      if (key === "tyrePressure" || key === "tyrePressureTarget") {
        if (TYRE_ORDER.some((k) => v[k].available)) return true;
      }
    }
  }
  return false;
}
function buildViewModel(input) {
  const { snapshot, now } = input;
  const moving = snapshot !== null && isMoving(snapshot) === true;
  const paired = input.link !== "unpaired";
  const network = input.link === "ok";
  const carFresh = snapshot !== null && now - snapshot.takenAt <= CAR_FRESH_MS && anyReading(snapshot);
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
      strip: strip(snapshot, moving)
    },
    sensors: snapshot ? sensorTiles(snapshot, now) : emptyTiles(),
    alerts: alertRows(input.alerts, now),
    pairing: { paired, url: paired ? null : input.pairUrl, note: !paired && input.clockWrong === true ? TEXT_CLOCK : null }
  };
  return Object.assign(body, { signature: signatureOf(body) });
}
function signatureOf(vm) {
  const header = { tab: vm.tab, status: vm.status };
  if (vm.tab === "sensors") return JSON.stringify([header, vm.sensors]);
  if (vm.tab === "alerts") return JSON.stringify([header, vm.alerts]);
  return JSON.stringify([header, vm.moving, vm.assistant, vm.pairing]);
}

// src/ui/draw-header.ts
function statusBadges(status) {
  const mark = (ok, words) => ({ text: ok ? words.ok : words.down, color: ok ? C.signal : C.inkDim });
  return [
    mark(status.car, STATUS_WORDS.car),
    mark(status.network, STATUS_WORDS.network),
    mark(status.claude, STATUS_WORDS.claude)
  ];
}
function drawHeader(cv, vm, frame, theme) {
  frame(cv, theme, TAB_LABELS.slice(), TABS.indexOf(vm.tab), statusBadges(vm.status).reverse());
}

// src/ui/draw-sensors.ts
var COLS = 4;
var ROWS2 = 2;
var PAD2 = 20;
var UNIT_SIZE = 26;
var DETAIL = { size: 24, line: 32 };
var AGE = { size: T.label.size, line: 24 };
function noteParts(tile) {
  if (!tile.note) return { details: [], age: null };
  const parts = tile.note.split("\n");
  const age = parts.pop();
  return { details: parts, age };
}
function drawTile(p, tile, x, y, w, h) {
  const inner = w - 2 * PAD2;
  const top = y + PAD2;
  if (!tile.available) {
    dashedBox(p.cv, x, y, w, h, RADIUS.md);
    label(p, tile.label, x + PAD2, baseline(top, T.label.size, T.label.line), C.inkDim, inner);
    const valueTop2 = top + T.label.line + SPACE.s2;
    text(p, tile.value, x + PAD2, baseline(valueTop2, T.reading.size, 56), T.reading.size, C.inkDim);
    const reasonTop = valueTop2 + 56 + SPACE.s1;
    const room = Math.max(1, Math.floor((y + h - PAD2 - reasonTop) / DETAIL.line));
    const ls = wrap(p, tile.note || "", DETAIL.size, inner, room);
    ls.forEach((l, i) => text(p, l, x + PAD2, baseline(reasonTop + i * DETAIL.line, DETAIL.size, DETAIL.line), DETAIL.size, C.inkDim));
    return;
  }
  box(p.cv, x, y, w, h);
  label(p, tile.label, x + PAD2, baseline(top, T.label.size, T.label.line), C.inkDim, inner);
  const valueTop = top + T.label.line + SPACE.s2;
  const rows = tile.value.split("\n");
  let after;
  if (rows.length > 1) {
    rows.forEach((row, i) => {
      const cells = row.split(" ");
      cells.forEach((c, j) => text(p, c, x + PAD2 + j * (inner / 2), baseline(valueTop + i * T.reading.line, T.reading.size, T.reading.line), T.reading.size, C.ink, FONT.text));
    });
    after = valueTop + rows.length * T.reading.line + SPACE.s1;
  } else {
    const font = readingFont(tile.value);
    const base = baseline(valueTop, T.readingXl.size, T.readingXl.line);
    const unitW = tile.unit ? width(p, tile.unit, UNIT_SIZE) + 12 : 0;
    const value = cut(p, tile.value, T.readingXl.size, inner - unitW, font);
    const vw = text(p, value, x + PAD2, base, T.readingXl.size, C.ink, font);
    if (tile.unit) text(p, tile.unit, x + PAD2 + vw + 12, base, UNIT_SIZE, C.inkDim);
    after = valueTop + T.readingXl.line + SPACE.s2;
  }
  const { details, age } = noteParts(tile);
  details.forEach((d, i) => text(p, cut(p, d, DETAIL.size, inner), x + PAD2, baseline(after + i * DETAIL.line, DETAIL.size, DETAIL.line), DETAIL.size, C.ink));
  if (age) text(p, cut(p, age, AGE.size, inner), x + PAD2, baseline(y + h - PAD2 - AGE.line, AGE.size, AGE.line), AGE.size, C.inkDim);
}
function drawSensors(p, vm) {
  const gap = SPACE.s2;
  const w = (BOX.w - (COLS - 1) * gap) / COLS;
  const h = (BOX.h - (ROWS2 - 1) * gap) / ROWS2;
  vm.sensors.slice(0, COLS * ROWS2).forEach((tile, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    drawTile(p, tile, BOX.x + col * (w + gap), BOX.y + row * (h + gap), w, h);
  });
}

// src/ui/screen.ts
var SCREEN = "MAIN";
var SCREEN_GFX = "MAIN_GFX";
var SCREEN_FPS = 4;
var SOFT_FRAME_MS = 1e3;
function drawKey(cv) {
  const kit = cv;
  return String(kit.textScale) + (kit.chrome ? "c" : "") + (kit.own ? "o" : "") + (onRenderer(cv) ? "g" : "");
}
function onRenderer(cv) {
  return !!cv.place;
}
function drawPage(cv, vm, o) {
  const pen = { cv, has: o.has };
  cv.clear(C.ground);
  drawHeader(cv, vm, o.frame, o.theme);
  if (vm.tab === "sensors") drawSensors(pen, vm);
  else if (vm.tab === "alerts") drawAlerts(pen, vm);
  else drawAssistant(pen, vm, o.onChip);
}
function startScreen(o) {
  var _a, _b;
  const { ctx, log } = o;
  let tab = (_a = o.tab) != null ? _a : "assistant";
  let lastKey = null;
  let lastSoftAt = null;
  let stopped = false;
  const softFrameMs = (_b = o.softFrameMs) != null ? _b : SOFT_FRAME_MS;
  const theme = ctx.theme();
  theme.sel = C.signal;
  theme.selText = C.signal;
  const chip = safe(log, "screen chip", (question, moving) => {
    if (!stopped) o.onChip(question, moving);
  });
  const turn = () => {
    if (stopped) return void 0;
    const now = o.clock.now();
    const vm = buildViewModel(Object.assign({}, o.input(), { tab, now }));
    const cv = ctx.canvas(PAGE.w, PAGE.h);
    const key = vm.signature + "|" + drawKey(cv);
    if (key === lastKey) return void 0;
    const soft = !onRenderer(cv);
    if (soft && lastSoftAt !== null && now >= lastSoftAt && now - lastSoftAt < softFrameMs) return void 0;
    drawPage(cv, vm, { has: o.has, frame: o.frame, theme, onChip: (question) => chip(question, vm.moving) });
    lastKey = key;
    lastSoftAt = soft ? now : null;
    return ctx.ui.image(SCREEN_GFX, cv);
  };
  const loop = ctx.loop(SCREEN, SCREEN_FPS, safe(log, "screen frame", turn));
  ctx.onTab(safe(log, "screen tab", (i) => {
    const next = TABS[i];
    if (stopped || next === void 0 || next === tab) return;
    tab = next;
    loop.kick();
  }));
  ctx.ui.onVisible(safe(log, "screen visible", (name, on) => {
    if (name === SCREEN && on) lastKey = null;
  }));
  ctx.onLayout(safe(log, "screen layout", () => {
    lastKey = null;
  }));
  return {
    tab: () => tab,
    show(next) {
      if (stopped || TABS.indexOf(next) < 0 || next === tab) return;
      tab = next;
      loop.kick();
    },
    redraw() {
      lastKey = null;
      if (!stopped) loop.kick();
    },
    stop() {
      stopped = true;
      loop.stop();
    }
  };
}

// src/uplink/https-client.ts
var nodeDns = __toESM(require("dns"));
var nodeHttps = __toESM(require("https"));

// src/uplink/lease.ts
var LEASE_FILE_NAME = "uplink.json";
var MAX_DNS_SERVERS = 4;
var IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
var IPV6 = /^[0-9a-fA-F:.]+$/;
function isIpAddress(text2) {
  return IPV4.test(text2) || text2.indexOf(":") >= 0 && IPV6.test(text2);
}
function offline() {
  return { online: false, dns: [] };
}
function readLease(dataDir, fs2) {
  try {
    const dir = dataDir.replace(/\/+$/, "");
    const parsed = JSON.parse(fs2.readFileSync(dir + "/" + LEASE_FILE_NAME, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return offline();
    const lease = parsed;
    if (typeof lease.ip !== "string" || lease.ip === "") return offline();
    const dns = [];
    if (Array.isArray(lease.dns)) {
      for (const server of lease.dns) {
        if (dns.length >= MAX_DNS_SERVERS) break;
        if (typeof server === "string" && isIpAddress(server)) dns.push(server);
      }
    }
    return { online: true, dns };
  } catch (e) {
    return offline();
  }
}

// src/uplink/resolver.ts
var DNS_CACHE_MS = 3e5;
var DNS_CACHE_MAX = 32;
var DNS_LOOKUP_TIMEOUT_MS = 1e4;
var DNS_FAILURE_MARK = "uplinkDnsFailure";
function isDnsFailure(error) {
  return error !== null && typeof error === "object" && error[DNS_FAILURE_MARK] === true;
}
function createLeaseLookup(options) {
  const { dns, lease, clock: clock2, timers: timers2 } = options;
  const pending = [];
  let resolver = null;
  let serversKey = "";
  let cache = /* @__PURE__ */ Object.create(null);
  let order = [];
  const forgetAll = () => {
    cache = /* @__PURE__ */ Object.create(null);
    order = [];
  };
  const remember = (name, entry) => {
    const at = order.indexOf(name);
    if (at >= 0) order.splice(at, 1);
    while (order.length >= DNS_CACHE_MAX) delete cache[order.shift()];
    cache[name] = entry;
    order.push(name);
  };
  const cached2 = (name, now) => {
    const entry = cache[name];
    if (entry === void 0) return null;
    if (now >= entry.at && now - entry.at < DNS_CACHE_MS) return entry;
    return null;
  };
  const resolverFor = (servers) => {
    const key = servers.join(",");
    if (resolver === null || key !== serversKey) {
      const next = new dns.Resolver();
      next.setServers(servers);
      resolver = next;
      serversKey = key;
      forgetAll();
    }
    return resolver;
  };
  const leaseLookup = function leaseLookup2(hostname, lookupOptions, callback) {
    if (typeof lookupOptions === "function") {
      callback = lookupOptions;
      lookupOptions = {};
    }
    const opts2 = lookupOptions !== null && typeof lookupOptions === "object" ? lookupOptions : {};
    const all = opts2.all === true;
    const wantFamily = opts2.family === 6 || opts2.family === "IPv6" ? 6 : 0;
    let done = false;
    let timer = null;
    const finish = (err, address, family) => {
      if (done) return;
      done = true;
      if (timer !== null) timers2.clearTimeout(timer);
      timer = null;
      const at = pending.indexOf(cancel);
      if (at >= 0) pending.splice(at, 1);
      if (err) callback(err);
      else if (all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const fail = (reason, code) => {
      const error = new Error("DNS lookup failed: " + reason);
      error.code = code;
      error.hostname = hostname;
      error[DNS_FAILURE_MARK] = true;
      finish(error);
    };
    const later = (fn) => {
      Promise.resolve().then(fn).then(void 0, () => void 0);
    };
    function cancel() {
      if (done) return;
      if (timer !== null) timers2.clearTimeout(timer);
      timer = null;
      later(() => fail("the uplink was closed", "ECANCELLED"));
    }
    try {
      const name = String(hostname).toLowerCase();
      if (isIpAddress(name)) {
        later(() => finish(null, name, name.indexOf(":") >= 0 ? 6 : 4));
        return;
      }
      let current;
      try {
        current = lease();
      } catch (e) {
        current = { online: false, dns: [] };
      }
      if (!current.online) {
        later(() => finish(Object.assign(new Error("no uplink lease"), { code: "EHOSTUNREACH" })));
        return;
      }
      if (current.dns.length === 0) {
        later(() => fail("the lease names no DNS server", "ENOTFOUND"));
        return;
      }
      const active = resolverFor(current.dns);
      const now = clock2.now();
      const hit = cached2(name, now);
      if (hit !== null) {
        later(() => finish(null, hit.address, hit.family));
        return;
      }
      timer = timers2.setTimeout(() => {
        timer = null;
        fail("no answer within " + DNS_LOOKUP_TIMEOUT_MS + " ms", "ETIMEOUT");
      }, DNS_LOOKUP_TIMEOUT_MS);
      pending.push(cancel);
      const answered = (family, fallback) => (err, addresses) => {
        if (done) return;
        const address = !err && Array.isArray(addresses) && typeof addresses[0] === "string" ? addresses[0] : null;
        if (address !== null) {
          if (active === resolver) remember(name, { address, family, at: clock2.now() });
          finish(null, address, family);
        } else if (fallback !== null) {
          fallback();
        } else {
          fail(err ? err.message : "no address", err && err.code || "ENOTFOUND");
        }
      };
      const ask6 = () => active.resolve6(name, answered(6, null));
      if (wantFamily === 6) ask6();
      else active.resolve4(name, answered(4, () => {
        try {
          ask6();
        } catch (error) {
          fail(error instanceof Error ? error.message : "resolver error", "ENOTFOUND");
        }
      }));
    } catch (error) {
      fail(error instanceof Error ? error.message : "resolver error", "ENOTFOUND");
    }
  };
  leaseLookup.cancelPending = () => {
    const waiting = pending.splice(0, pending.length);
    for (const cancel of waiting) cancel();
    if (waiting.length > 0 && resolver !== null && typeof resolver.cancel === "function") {
      try {
        resolver.cancel();
      } catch (e) {
      }
    }
  };
  return leaseLookup;
}

// src/uplink/https-client.ts
var UplinkError = class extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
    this.name = "UplinkError";
  }
};
var HTTPS_TIMEOUT_MS = 15e3;
var MAX_RESPONSE_BYTES = 1048576;
var URL_PATTERN = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?(\/[^?#\s]*)?$/;
function parseBaseUrl(baseUrl, plain) {
  const match = URL_PATTERN.exec(String(baseUrl).trim());
  if (match === null) return "the backend address is not a valid URL";
  const scheme = match[1];
  if (plain ? scheme !== "http" : scheme !== "https") return plain ? "the plain test mode needs an http:// address" : "the backend address must be https://";
  const port = match[3] === void 0 ? scheme === "https" ? 443 : 80 : Number(match[3]);
  if (!(port >= 1 && port <= 65535)) return "the backend port is out of range";
  const host = match[2];
  return {
    hostname: host.charAt(0) === "[" ? host.slice(1, -1) : host,
    port,
    basePath: (match[4] || "").replace(/\/+$/, "")
  };
}
var OFFLINE_CODES = ["EHOSTUNREACH", "ENETUNREACH"];
var CLOCK_CODES = ["CERT_NOT_YET_VALID", "CERT_HAS_EXPIRED"];
var TLS_CODE = /^(ERR_TLS_|ERR_SSL_|ERR_OSSL_)|CERT|SIGNATURE|^UNABLE_TO_|^EPROTO$|^HOSTNAME_MISMATCH$/;
function classifyError(error) {
  if (error instanceof UplinkError) return error.kind;
  if (isDnsFailure(error)) return "dns";
  const e = error !== null && typeof error === "object" ? error : {};
  const code = typeof e.code === "string" ? e.code : "";
  if (OFFLINE_CODES.indexOf(code) >= 0) return "offline";
  if (CLOCK_CODES.indexOf(code) >= 0) return "clock";
  if (code !== "" && TLS_CODE.test(code)) return "tls";
  const message = typeof e.message === "string" ? e.message : "";
  if (code === "" && (e.cert !== void 0 || /certificate|altnames|ssl|tls/i.test(message))) return "tls";
  return "server-error";
}
function statusKind(status) {
  if (status === 401 || status === 403) return "unauthorized";
  if (status >= 500) return "server-error";
  return "client-error";
}
function toUplinkError(error) {
  if (error instanceof UplinkError) return error;
  const kind = classifyError(error);
  const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
  return new UplinkError(kind, "request failed (" + (code || kind) + ")");
}
function abortRequest(req) {
  if (req === null) return;
  try {
    if (typeof req.abort === "function") req.abort();
    else if (typeof req.destroy === "function") req.destroy();
  } catch (e) {
  }
}
var globalTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};
var HttpsClient = class {
  constructor(o) {
    this.agent = null;
    /** The dialog long-poll's own agent; created by the first long-poll, destroyed by close(). */
    this.pollAgent = null;
    /**
     * Requests not yet settled, so `close()` can end them. Without this, a request waiting in the agent's
     * queue (one socket) would be given a new socket on the orphaned agent once the old one is destroyed,
     * and be sent after `close()`. Bounded by the callers: every entry has its own timeout and leaves the
     * list when it settles.
     */
    this.inFlight = [];
    this.https = o.https || nodeHttps;
    this.timers = o.timers || globalTimers;
    this.lease = o.lease;
    this.timeoutMs = typeof o.timeoutMs === "number" && o.timeoutMs > 0 ? o.timeoutMs : HTTPS_TIMEOUT_MS;
    this.ca = Array.isArray(o.extraCaPem) && o.extraCaPem.length > 0 ? o.extraCaPem.slice() : null;
    const parsed = parseBaseUrl(o.baseUrl, o.plainHttpForTests === true);
    this.target = typeof parsed === "string" ? null : parsed;
    this.targetProblem = typeof parsed === "string" ? parsed : "";
    if (this.target === null) {
      try {
        o.log.warn("uplink: " + this.targetProblem);
      } catch (e) {
      }
    }
    this.resolve = createLeaseLookup({
      dns: o.dns || nodeDns,
      lease: () => this.currentLease(),
      clock: o.clock || { now: () => Date.now() },
      timers: this.timers
    });
    this.generation = this.newGeneration();
  }
  /** Whether the uplink has a lease right now. Never throws. */
  online() {
    return this.currentLease().online;
  }
  request(method, path2, body, bearer, options) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let req = null;
      const cancel = () => {
        finish(new UplinkError("offline", "the uplink was closed"));
        abortRequest(req);
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.timers.clearTimeout(timer);
        timer = null;
        const index = this.inFlight.indexOf(cancel);
        if (index >= 0) this.inFlight.splice(index, 1);
        if (error !== null) reject(error);
        else resolve(value);
      };
      if (options !== void 0 && typeof options.cancelHandle === "function") {
        const cancelThis = () => {
          if (settled) return;
          finish(new UplinkError("offline", "the request was cancelled"));
          abortRequest(req);
        };
        try {
          options.cancelHandle(cancelThis);
        } catch (e) {
        }
      }
      const generation = this.generation;
      if (generation.closed) return finish(new UplinkError("offline", "the uplink is closed"));
      const target = this.target;
      if (target === null) return finish(new UplinkError("client-error", this.targetProblem));
      if (!this.online()) return finish(new UplinkError("offline", "no uplink lease"));
      let payload = null;
      if (body !== null && body !== void 0) {
        try {
          payload = JSON.stringify(body);
        } catch (e) {
          return finish(new UplinkError("client-error", "the request body is not JSON"));
        }
      }
      const headers = { Accept: "application/json", Authorization: "Bearer " + bearer };
      if (payload !== null) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload, "utf8");
      }
      const requestOptions = {
        method,
        hostname: target.hostname,
        port: target.port,
        path: target.basePath + path2,
        headers,
        agent: this.currentAgent(options !== void 0 && options.longPoll === true),
        lookup: generation.lookup
      };
      if (this.ca !== null) requestOptions.ca = this.ca;
      this.inFlight.push(cancel);
      try {
        req = this.https.request(requestOptions, (res) => this.readResponse(res, () => req, finish));
        req.on("error", (error) => finish(toUplinkError(error)));
      } catch (error) {
        abortRequest(req);
        return finish(toUplinkError(error));
      }
      const timeoutMs = options && typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : this.timeoutMs;
      timer = this.timers.setTimeout(() => {
        timer = null;
        finish(new UplinkError("timeout", "no reply within " + timeoutMs + " ms"));
        abortRequest(req);
      }, timeoutMs);
      try {
        if (payload !== null) req.end(payload);
        else req.end();
      } catch (error) {
        finish(toUplinkError(error));
        abortRequest(req);
      }
    });
  }
  /**
   * Closes the client for good, until reopen(). Every request still in flight is ended (rejected as
   * `offline`, aborted, its timer cleared), lookups still waiting for a DNS answer are ended and their
   * timers cleared, and both agents are destroyed. Node's Agent opens a new socket for the head of its
   * queue when a socket closes, even for an aborted request, and that socket calls our `lookup`: the
   * lookup handed out before close() therefore answers with an error at once from now on, without a
   * DNS query and without a timer. Requests made while closed are refused as `offline` without any I/O.
   */
  close() {
    this.generation.closed = true;
    const pending = this.inFlight.splice(0, this.inFlight.length);
    for (const cancel of pending) cancel();
    this.resolve.cancelPending();
    const agents = [this.agent, this.pollAgent];
    this.agent = null;
    this.pollAgent = null;
    for (const agent of agents) {
      if (agent === null) continue;
      try {
        agent.destroy();
      } catch (e) {
      }
    }
  }
  /** Opens a closed client again; the next request opens a new connection. Does nothing when open. */
  reopen() {
    if (this.generation.closed) this.generation = this.newGeneration();
  }
  currentLease() {
    try {
      const lease = this.lease();
      if (lease && lease.online === true) return { online: true, dns: Array.isArray(lease.dns) ? lease.dns : [] };
    } catch (e) {
    }
    return { online: false, dns: [] };
  }
  currentAgent(longPoll) {
    if (longPoll) {
      if (this.pollAgent === null) this.pollAgent = new this.https.Agent({ keepAlive: true, maxSockets: 1 });
      return this.pollAgent;
    }
    if (this.agent === null) this.agent = new this.https.Agent({ keepAlive: true, maxSockets: 1 });
    return this.agent;
  }
  /** A lookup that serves this open period only: once it is closed it fails at once, with no I/O and no timer. */
  newGeneration() {
    const generation = {
      closed: false,
      lookup: (hostname, options, callback) => {
        if (!generation.closed) return this.resolve(hostname, options, callback);
        const done = typeof options === "function" ? options : callback;
        Promise.resolve().then(() => done(Object.assign(new Error("the uplink was closed"), { code: "EHOSTUNREACH" }))).then(void 0, () => void 0);
      }
    };
    return generation;
  }
  readResponse(res, req, finish) {
    const status = typeof res.statusCode === "number" ? res.statusCode : 0;
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    res.on("data", (chunk) => {
      if (tooLarge) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += buffer.length;
      if (size > MAX_RESPONSE_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        finish(new UplinkError("server-error", "reply larger than " + MAX_RESPONSE_BYTES + " bytes"));
        abortRequest(req());
        return;
      }
      if (status >= 200 && status < 300) chunks.push(buffer);
    });
    res.on("error", (error) => finish(toUplinkError(error)));
    res.on("aborted", () => finish(new UplinkError("server-error", "the reply was cut off")));
    res.on("end", () => {
      if (status < 200 || status >= 300) return finish(new UplinkError(statusKind(status), "HTTP " + status));
      const text2 = Buffer.concat(chunks).toString("utf8");
      if (status === 204 || text2.trim() === "") return finish(null, void 0);
      try {
        finish(null, JSON.parse(text2));
      } catch (e) {
        finish(new UplinkError("server-error", "the reply is not JSON"));
      }
    });
  }
};

// ../packages/shared/src/car-dto.ts
var CAR_API_PREFIX = "/car/v1";
var MAX_SNAPSHOTS_PER_BATCH = 60;

// src/uplink/ring-buffer.ts
var RingBuffer = class {
  constructor(capacity) {
    this.head = 0;
    // index of the oldest item
    this.count = 0;
    this.capacity = Math.max(1, Math.floor(capacity) || 1);
    this.items = new Array(this.capacity);
  }
  push(item) {
    const tail = (this.head + this.count) % this.capacity;
    this.items[tail] = item;
    if (this.count < this.capacity) this.count++;
    else this.head = (this.head + 1) % this.capacity;
  }
  /** Removes and returns up to `max` items, oldest first. */
  drain(max) {
    const n = Math.min(this.count, Math.max(0, Math.floor(max) || 0));
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(this.items[this.head]);
      this.items[this.head] = void 0;
      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }
    return out;
  }
  /**
   * Puts items (oldest first) back in front of what the buffer holds, e.g. a batch that failed to send.
   * When that exceeds the capacity the oldest are dropped, so the newest `capacity` items remain.
   */
  pushFront(items) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (this.count >= this.capacity) return;
      this.head = (this.head - 1 + this.capacity) % this.capacity;
      this.items[this.head] = items[i];
      this.count++;
    }
  }
  /** A copy of what the buffer holds, oldest first; the buffer is left as it is. */
  peek() {
    const out = [];
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.head + i) % this.capacity]);
    return out;
  }
  size() {
    return this.count;
  }
};

// src/uplink/uplink-client.ts
var SNAPSHOT_BUFFER_SIZE = 240;
var ALERT_QUEUE_MAX = 20;
var SEND_INTERVAL_MS = 6e4;
var DIALOG_POLL_TIMEOUT_MS = 35e3;
var ASK_TIMEOUT_MS = 7e4;
var SNAPSHOT_BATCH_MAX_BYTES = 384e3;
var ALERT_BATCH_MAX_BYTES = 64e3;
var REFUSAL_LOG_INTERVAL_MS = 6e5;
function isObject2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
var UplinkClient = class {
  constructor(o) {
    this.snapshots = new RingBuffer(SNAPSHOT_BUFFER_SIZE);
    this.alerts = new RingBuffer(ALERT_QUEUE_MAX);
    /** The snapshot batch at the front of the buffer was refused once with a 4xx: refused again, it is dropped. */
    this.snapshotRefused = false;
    /** A refused snapshot batch was dropped and logged in this waking period. */
    this.dropLogged = false;
    /** The failure kinds logged in this waking period. */
    this.kindsLogged = [];
    this.lastBatchAt = null;
    this.lastAlertAttemptAt = null;
    this.batchInFlight = false;
    this.alertsInFlight = false;
    /** The alert batch being sent (at most ALERT_QUEUE_MAX), until its send settles: not yet delivered, so in pendingAlerts(). */
    this.alertBatchInFlight = [];
    /** A raise (sendAlerts) waits in the alert queue: it is not held for the snapshot batch while driving. */
    this.raiseWaiting = false;
    /** Set by 401/403 or another 4xx: nothing is sent with this bearer until the device changes or retry(). */
    this.blocked = null;
    this.lastOutcome = null;
    /** The refusal last logged (kind and bearer) and when, by the injected clock. */
    this.refusalLogged = null;
    /** Between close() and reopen(): nothing is sent and every explicit request is refused as offline. */
    this.closed = false;
    this.http = o.http;
    this.device = o.device;
    this.clock = o.clock;
    this.log = o.log;
    this.sendIntervalMs = typeof o.sendIntervalMs === "number" && o.sendIntervalMs > 0 ? o.sendIntervalMs : SEND_INTERVAL_MS;
  }
  /** Keeps a copy of the snapshot (the provider updates its own object in place) for the next batch. */
  recordSnapshot(snapshot) {
    try {
      this.snapshots.push(JSON.parse(JSON.stringify(snapshot)));
    } catch (e) {
    }
  }
  /**
   * Driving, the interval elapsed and online: one batch of at most 60 snapshots and SNAPSHOT_BATCH_MAX_BYTES. Not asleep: alerts kept
   * from an earlier failure are sent again, at most once per interval. Otherwise nothing.
   */
  onTick(power) {
    try {
      if (power === "asleep" || this.closed) return;
      const bearer = this.bearer();
      if (bearer === null || !this.http.online()) return;
      const now = this.clock.now();
      const driving = power === "driving";
      let batchSent = false;
      if (driving && !this.batchInFlight && this.snapshots.size() > 0 && this.elapsed(this.lastBatchAt, now)) {
        batchSent = this.sendBatch(bearer, now);
      }
      if (this.alertsInFlight || this.alerts.size() === 0) return;
      const due = batchSent || this.elapsed(this.lastAlertAttemptAt, now) && (this.raiseWaiting || !driving || this.elapsed(this.lastBatchAt, now));
      if (due) this.flushAlerts(bearer, now);
    } catch (error) {
      this.note(error);
    }
  }
  /**
   * Keeps them (in the same queue, the newest 20) for the next send, without sending now: for a clearing or a
   * re-opening, which goes with the next raise or the next batch (see onTick). Never throws.
   */
  queueAlerts(events) {
    try {
      for (const event of events) this.alerts.push(event);
    } catch (error) {
      this.note(error);
    }
  }
  /** Sends at once when online, with whatever was queued before; otherwise keeps them (the newest 20) for the next send. */
  sendAlerts(events) {
    try {
      for (const event of events) this.alerts.push(event);
      if (events.length > 0) this.raiseWaiting = true;
      if (this.alerts.size() === 0 || this.alertsInFlight || this.closed) return;
      const bearer = this.bearer();
      if (bearer === null || !this.http.online()) return;
      this.flushAlerts(bearer, this.clock.now());
    } catch (error) {
      this.note(error);
    }
  }
  /**
   * One question. With `snapshot` (the car's current readings), that snapshot is first POSTed alone to
   * /car/v1/snapshots, when open, paired and online; its outcome never stops the question (see the header).
   */
  ask(text2, style, snapshot) {
    if (snapshot !== void 0 && snapshot !== null) this.sendCurrent(snapshot);
    const body = { text: text2, style };
    return this.call(
      "POST",
      CAR_API_PREFIX + "/ask",
      body,
      { timeoutMs: ASK_TIMEOUT_MS },
      (reply) => isObject2(reply) && isObject2(reply.turn) ? reply.turn : null
    );
  }
  fetchConfig() {
    return this.call(
      "GET",
      CAR_API_PREFIX + "/config",
      null,
      void 0,
      (reply) => isObject2(reply) && isObject2(reply.ownerLimits) && typeof reply.popupsEnabled === "boolean" ? reply : null
    );
  }
  /**
   * One GET /car/v1/dialog (the server waits up to 25 s for a newer turn); the caller decides when to call again.
   * `cancelHandle`, when given, is called at once with a function that ends this poll alone: the promise then
   * rejects as `offline` and the link status is left as it was (a cancel is no failure of the link).
   */
  pollDialog(afterTurnId, cancelHandle) {
    const query = afterTurnId === null ? "" : "?after=" + encodeURIComponent(afterTurnId);
    let cancelled = false;
    let cancelRequest = null;
    const options = { timeoutMs: DIALOG_POLL_TIMEOUT_MS, longPoll: true };
    if (typeof cancelHandle === "function") options.cancelHandle = (fn) => cancelRequest = fn;
    const pending = this.call(
      "GET",
      CAR_API_PREFIX + "/dialog" + query,
      null,
      options,
      (reply) => isObject2(reply) && Array.isArray(reply.turns) ? reply.turns : null,
      () => cancelled
    );
    if (typeof cancelHandle === "function") {
      try {
        cancelHandle(() => {
          if (cancelled) return;
          cancelled = true;
          const cancel = cancelRequest;
          if (cancel !== null) cancel();
        });
      } catch (error) {
        this.note(error);
      }
    }
    return pending;
  }
  status() {
    try {
      const device = this.device();
      if (!device) return "unpaired";
      if (this.blocked !== null && this.blocked.bearer === device.id + "." + device.secret) {
        return this.blocked.kind === "unauthorized" ? "unpaired" : "error";
      }
      if (!this.http.online()) return "offline";
    } catch (e) {
      return "error";
    }
    switch (this.lastOutcome) {
      case null:
      case "ok":
        return "ok";
      case "offline":
      case "dns":
        return "offline";
      case "clock":
        return "clock";
      case "unauthorized":
        return "unpaired";
      // lifted by retry(), not yet answered otherwise
      default:
        return "error";
    }
  }
  /**
   * A copy of what is not yet delivered, oldest first: an alert send in flight, then the queue, the newest
   * ALERT_QUEUE_MAX of them (what the queue holds once a failed send is put back at its front). The wiring keeps
   * it in the state file, so a process end does not lose an unsent clearing, even when the write falls while its
   * send is in flight and that send then fails. A send that succeeds may leave a delivered event in the file;
   * sent again by the next process it changes nothing on the backend (an alert's state is set, not toggled).
   */
  pendingAlerts() {
    try {
      return this.alertBatchInFlight.concat(this.alerts.peek()).slice(-ALERT_QUEUE_MAX);
    } catch (e) {
      return [];
    }
  }
  /** What is waiting to be sent (both bounded: 240 snapshots, 20 alerts). */
  queued() {
    return { snapshots: this.snapshots.size(), alerts: this.alerts.size() };
  }
  /**
   * Lifts an `unauthorized` block, and a `client-error` block left by a background send, so that the
   * next request is attempted with the same device. Sends nothing by itself and starts no timer: the
   * wiring calls it on waking from asleep and, while the pairing screen is visible, at most every 30 s.
   */
  retry() {
    this.blocked = null;
  }
  /** Closes the connection; nothing is sent until reopen() (what is waiting stays queued). */
  close() {
    this.closed = true;
    try {
      this.http.close();
    } catch (error) {
      this.note(error);
    }
  }
  /** Opens the client again after close(); the next request opens a new connection. */
  reopen() {
    this.closed = false;
    this.kindsLogged = [];
    this.dropLogged = false;
    try {
      this.http.reopen();
    } catch (error) {
      this.note(error);
    }
  }
  elapsed(last, now) {
    return last === null || now < last || now - last >= this.sendIntervalMs;
  }
  /** The bearer for the current device, or null when unpaired or blocked for this device. */
  bearer() {
    const device = this.device();
    if (!device || typeof device.id !== "string" || typeof device.secret !== "string") return null;
    const bearer = device.id + "." + device.secret;
    if (this.blocked !== null) {
      if (this.blocked.bearer === bearer) return null;
      this.blocked = null;
      this.lastOutcome = null;
    }
    return bearer;
  }
  /**
   * Takes items oldest first while the request body `{"<key>":[...]}` stays within `maxBytes` and the batch
   * within `maxCount`; the rest stay in the buffer for the next send. Each item is measured once and the body's
   * size is the sum of the items, the commas between them and the wrapper. An item that alone exceeds the
   * budget (or cannot be serialised) could never be delivered: it is dropped with one warning.
   */
  takeBatch(buffer, key, maxCount, maxBytes) {
    const batch = [];
    const wrapper = Buffer.byteLength(JSON.stringify({ [key]: [] }), "utf8");
    let bytes = wrapper;
    while (batch.length < maxCount && buffer.size() > 0) {
      const item = buffer.drain(1)[0];
      let size;
      try {
        const text2 = JSON.stringify(item);
        size = typeof text2 === "string" ? Buffer.byteLength(text2, "utf8") : 4;
      } catch (e) {
        size = Infinity;
      }
      if (wrapper + size > maxBytes) {
        this.note("dropped one " + key + " item that alone exceeds the " + maxBytes + " byte batch limit");
        continue;
      }
      const added = (batch.length > 0 ? 1 : 0) + size;
      if (bytes + added > maxBytes) {
        buffer.pushFront([item]);
        break;
      }
      bytes += added;
      batch.push(item);
    }
    return batch;
  }
  /** Sends the next batch within the count and byte limits; false when nothing was left to send. */
  sendBatch(bearer, now) {
    const batch = this.takeBatch(this.snapshots, "snapshots", MAX_SNAPSHOTS_PER_BATCH, SNAPSHOT_BATCH_MAX_BYTES);
    if (batch.length === 0) return false;
    const body = { snapshots: batch, sentAt: now };
    this.batchInFlight = true;
    this.lastBatchAt = now;
    this.send(bearer, CAR_API_PREFIX + "/snapshots", body, false).then(
      () => {
        this.batchInFlight = false;
        this.snapshotRefused = false;
      },
      (error) => {
        this.batchInFlight = false;
        if (error instanceof UplinkError && error.kind === "client-error") {
          if (this.snapshotRefused) {
            this.snapshotRefused = false;
            if (!this.dropLogged) {
              this.dropLogged = true;
              this.note("dropped " + batch.length + " snapshots the backend refused twice (client-error)");
            }
            return;
          }
          this.snapshotRefused = true;
        }
        this.snapshots.pushFront(batch);
      }
    );
    return true;
  }
  /** The question's snapshot: a copy POSTed alone, outside the buffer and the minute's schedule. Never throws. */
  sendCurrent(snapshot) {
    try {
      if (this.closed) return;
      const bearer = this.bearer();
      if (bearer === null || !this.http.online()) return;
      const copy = JSON.parse(JSON.stringify(snapshot));
      const body = { snapshots: [copy], sentAt: this.clock.now() };
      this.send(bearer, CAR_API_PREFIX + "/snapshots", body, false).then(void 0, () => void 0);
    } catch (error) {
      this.note(error);
    }
  }
  flushAlerts(bearer, now) {
    const batch = this.takeBatch(this.alerts, "alerts", ALERT_QUEUE_MAX, ALERT_BATCH_MAX_BYTES);
    if (batch.length === 0) return;
    const body = { alerts: batch, sentAt: now };
    const withRaise = this.raiseWaiting;
    this.raiseWaiting = this.alerts.size() > 0 && withRaise;
    this.alertsInFlight = true;
    this.alertBatchInFlight = batch;
    this.lastAlertAttemptAt = now;
    this.send(bearer, CAR_API_PREFIX + "/alerts", body, true).then(
      () => {
        this.alertsInFlight = false;
        this.alertBatchInFlight = [];
      },
      () => {
        this.alertsInFlight = false;
        this.alertBatchInFlight = [];
        this.alerts.pushFront(batch);
        if (withRaise) this.raiseWaiting = true;
      }
    );
  }
  /**
   * A POST with the given bearer whose outcome is recorded; always settles, rejecting with an UplinkError.
   * `clientErrorBlocks`: whether a 4xx (other than 401/403) blocks the bearer (alerts) or not (snapshots).
   */
  send(bearer, path2, body, clientErrorBlocks) {
    let pending;
    try {
      pending = this.http.request("POST", path2, body, bearer);
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      (reply) => {
        this.lastOutcome = "ok";
        return reply;
      },
      (error) => {
        throw this.failed(error, bearer, path2, clientErrorBlocks);
      }
    );
  }
  /** An explicit request: refused at once when unpaired or blocked; the reply's shape is checked. */
  call(method, path2, body, options, shape, cancelled = () => false) {
    if (this.closed) return Promise.reject(new UplinkError("offline", "the uplink is closed"));
    let bearer;
    let paired = false;
    try {
      paired = !!this.device();
      bearer = this.bearer();
    } catch (e) {
      bearer = null;
    }
    if (bearer === null) {
      if (!paired || this.blocked === null) return Promise.reject(new UplinkError("unauthorized", "no paired device"));
      return Promise.reject(new UplinkError(this.blocked.kind, "the backend refused this device"));
    }
    const used = bearer;
    let pending;
    try {
      pending = this.http.request(method, path2, body, used, options);
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      (reply) => {
        const value = shape(reply);
        if (value === null) throw this.failed(new UplinkError("server-error", "unexpected reply from " + path2.split("?")[0]), used, path2, false);
        this.lastOutcome = "ok";
        return value;
      },
      (error) => {
        if (cancelled()) throw new UplinkError("offline", "the request was cancelled");
        throw this.failed(error, used, path2, false);
      }
    );
  }
  /**
   * Records a failure and returns it as an UplinkError. `unauthorized` blocks this bearer; `client-error`
   * blocks it only when `clientErrorBlocks` (an alert send got it): that is a lasting mismatch with the
   * backend, while a 4xx to a question (a validation or budget refusal) concerns that question only and a
   * refused snapshot batch is dropped after one retry (sendBatch). A failure that does not block is logged
   * the first time its kind occurs in this waking period, with the path (never the query or the bearer).
   */
  failed(error, bearer, path2, clientErrorBlocks) {
    const uplinkError = error instanceof UplinkError ? error : new UplinkError("server-error", "unexpected failure");
    const kind = uplinkError.kind;
    this.lastOutcome = kind;
    const blocks = kind === "unauthorized" || clientErrorBlocks && kind === "client-error";
    if (blocks) {
      if (this.blocked === null || this.blocked.bearer !== bearer) {
        this.blocked = { kind, bearer };
        if (this.refusalDue(kind + " " + bearer)) {
          this.note("the backend refused a request (" + kind + "); nothing more is sent until the device changes or retry()");
        }
      }
    } else if (kind !== "clock" && this.kindsLogged.indexOf(kind) < 0) {
      this.kindsLogged.push(kind);
      this.note(kind + " (" + String(path2).split("?")[0] + ")");
    }
    return uplinkError;
  }
  /** Whether this refusal is to be logged: a different one, or the same one REFUSAL_LOG_INTERVAL_MS after the last line. */
  refusalDue(key) {
    const now = this.clock.now();
    const last = this.refusalLogged;
    if (last !== null && last.key === key && now >= last.at && now - last.at < REFUSAL_LOG_INTERVAL_MS) return false;
    this.refusalLogged = { key, at: now };
    return true;
  }
  note(problem) {
    try {
      this.log.warn("uplink: " + (problem instanceof Error ? problem.message : String(problem)));
    } catch (e) {
    }
  }
};

// src/app.ts
var TICK_MS = 1e3;
var SNAPSHOT_EVERY_MS = 6e4;
var POLL_RETRY_MS = 5e3;
var PAIRING_RETRY_MS = 3e4;
var CONFIG_RETRY_MS = 6e4;
var RETRY_MAX_MS = 6e5;
var ALERT_SAVE_GAP_MS = 6e4;
var LISTED_MAX = 20;
var DEVICE_ID_BYTES = 12;
var DEVICE_SECRET_BYTES = 32;
var TEST_POPUP_SETTING = "testPopup";
var TEST_POPUP_ID = "copilot-test-popup";
var TEXT_NO_SERVER = "Немає зв'язку з сервером";
var TEXT_REFUSED = "Сервер відхилив запит";
function backoff(first, failures) {
  let wait = first;
  for (let i = 1; i < failures && wait < RETRY_MAX_MS; i++) wait *= 2;
  return Math.min(wait, RETRY_MAX_MS);
}
function errorLine(error) {
  const kind = error instanceof UplinkError ? error.kind : null;
  if (kind === "clock") return TEXT_CLOCK;
  if (kind === "unauthorized" || kind === "client-error" || kind === "server-error") return TEXT_REFUSED;
  return TEXT_NO_SERVER;
}
var SNAPSHOT_KEYS = Object.keys(emptySnapshot(0)).filter((k) => k !== "takenAt");
function stringList(v, keep) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) if (typeof item === "string" && keep(item) && out.indexOf(item) < 0) out.push(item);
  return out;
}
var NO_DISK = {
  existsSync: () => false,
  readFileSync: () => {
    throw new Error("no data folder");
  },
  writeFileSync: () => void 0,
  renameSync: () => void 0
};
var TURN_TEXT_MAX = 2e3;
var TURN_ID_MAX = 128;
function cutText(text2) {
  return text2.length > TURN_TEXT_MAX ? text2.slice(0, TURN_TEXT_MAX) : text2;
}
function turnFrom(v) {
  if (typeof v !== "object" || v === null) return null;
  const t = v;
  if (typeof t.id !== "string" || t.id === "" || t.id.length > TURN_ID_MAX) return null;
  if (typeof t.question !== "string" || typeof t.answer !== "string") return null;
  return {
    id: t.id,
    at: typeof t.at === "number" && isFinite(t.at) ? t.at : 0,
    question: cutText(t.question),
    answer: cutText(t.answer),
    style: t.style === "spoken" ? "spoken" : "full",
    source: t.source === "panel" || t.source === "voice" ? t.source : "car",
    model: typeof t.model === "string" ? t.model.slice(0, TURN_ID_MAX) : "",
    snapshotAt: typeof t.snapshotAt === "number" && isFinite(t.snapshotAt) ? t.snapshotAt : null
  };
}
function uploads(event) {
  if (event.severity === "critical" || event.severity === "warning") return true;
  return event.active === false && event.title === "";
}
function sameJson(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (e) {
    return false;
  }
}
function startApp(deps) {
  const { ctx, clock: clock2, timers: timers2, fs: fs2 } = deps;
  const log = ctx.log;
  const backendUrl = typeof deps.config.backendUrl === "string" && deps.config.backendUrl.trim() !== "" ? deps.config.backendUrl.trim() : null;
  const has = deps.screenKit ? deps.screenKit.has : () => true;
  const frame = deps.screenKit ? deps.screenKit.frame : () => void 0;
  let stopped = false;
  const setting = (key) => {
    try {
      return ctx.settings.get(key);
    } catch (e) {
      return void 0;
    }
  };
  const dataDir = typeof ctx.dataDir === "string" && ctx.dataDir.trim() !== "" ? ctx.dataDir : null;
  if (dataDir === null) log.warn("no data folder: the state is kept in memory only");
  const stateFile = new StateFile({ dir: dataDir || "", fs: dataDir ? fs2 : NO_DISK, log });
  const state = stateFile.load();
  state.paired = state.paired === true;
  const restoredAlerts = Array.isArray(state.pendingAlerts) ? state.pendingAlerts : [];
  state.pendingAlerts = void 0;
  let pendingAlerts = () => restoredAlerts;
  const latin = setting("latinPopups");
  if (typeof latin === "boolean") state.asciiPopups = latin;
  const engine = new EventEngine(defaultEngineOptions());
  try {
    engine.restore(state.engine);
  } catch (e) {
    log.warn("state file: engine memory not restored, starting clean");
  }
  let lastSaved = "";
  const snapshotOfState = () => {
    state.engine = engine.state();
    return JSON.stringify(state);
  };
  const save = () => {
    let current;
    try {
      current = snapshotOfState();
    } catch (e) {
      current = "";
    }
    let pending;
    try {
      pending = pendingAlerts();
    } catch (e) {
      pending = [];
    }
    lastSaved = stateFile.save(Object.assign({}, state, { pendingAlerts: pending })) ? current : "";
  };
  const saveIfChanged = () => {
    let current;
    try {
      current = snapshotOfState();
    } catch (e) {
      current = "";
    }
    if (current === "" || current !== lastSaved) save();
  };
  if (!state.device) {
    try {
      const id = deps.random(DEVICE_ID_BYTES);
      const secret = deps.random(DEVICE_SECRET_BYTES);
      if (typeof id === "string" && typeof secret === "string" && id.length >= 16 && secret.length >= 32) {
        state.device = { id, secret };
        state.paired = false;
        log.info("first run: a new device id was created for pairing");
      }
    } catch (e) {
      log.warn("first run: no random source, the car cannot pair");
    }
    save();
  } else {
    try {
      lastSaved = snapshotOfState();
    } catch (e) {
      lastSaved = "";
    }
  }
  const provider = new BmwMguVehicleDataProvider({
    signals: ctx.signals,
    clock: clock2,
    log,
    missingInterfaces: stringList(deps.config.missingInterfaces, () => true),
    missingKeys: stringList(deps.config.droppedReadings, (k) => SNAPSHOT_KEYS.indexOf(k) >= 0)
  });
  const gate = new PowerGate({ clock: clock2 });
  const noteUse = safe(log, "power gate", () => {
    if (stopped) return;
    gate.touch();
    gate.update(provider.snapshot());
  });
  let listed = [];
  const list = (event) => {
    for (let i = 0; i < listed.length; i++) {
      if (listed[i].id === event.id) {
        listed[i] = event;
        return;
      }
    }
    if (!event.active && !event.title) return;
    listed.push(event);
    if (listed.length > LISTED_MAX) {
      let drop = 0;
      for (let i = 0; i < listed.length; i++) if (!listed[i].active) {
        drop = i;
        break;
      }
      listed = listed.slice(0, drop).concat(listed.slice(drop + 1));
    }
  };
  const gates = popupGates(() => state.popupsEnabled === true && setting("popups") !== false, () => provider.snapshot());
  const presenter = new AlertPresenter({
    ui: ctx.ui,
    timers: timers2,
    log,
    enabled: gates.enabled,
    hold: gates.hold,
    ascii: () => state.asciiPopups === true
  });
  let answered = false;
  let clockWrong = false;
  let clockLogged = false;
  let onAnswered = () => void 0;
  const answeredStep = safe(log, "answered", () => onAnswered());
  const noteClock = safe(log, "clock", (wrong) => {
    clockWrong = wrong;
    if (wrong && !clockLogged) {
      clockLogged = true;
      log.warn("uplink: the head unit's clock is wrong (the server's certificate is not valid at this time); every request fails until it is set right");
    }
  });
  const http = deps.http || (backendUrl ? new HttpsClient({ baseUrl: backendUrl, lease: () => readLease(dataDir || "", dataDir ? fs2 : NO_DISK), log, timers: timers2, clock: clock2 }) : null);
  const noteAnswer = safe(log, "pairing", (authorised) => {
    if (authorised) {
      answered = true;
      if (!state.paired) {
        state.paired = true;
        log.info("pairing: the backend accepted this car");
        save();
      }
    } else if (state.paired) {
      state.paired = false;
      log.warn("pairing: the backend refused this car; showing the pairing code again");
      save();
    }
  });
  if (http) {
    const request = http.request.bind(http);
    http.request = function watched(method, path2, body, bearer, options) {
      return request(method, path2, body, bearer, options).then(
        (value) => {
          noteClock(false);
          noteAnswer(true);
          answeredStep();
          return value;
        },
        (error2) => {
          if (error2 instanceof UplinkError && error2.kind === "clock") noteClock(true);
          if (error2 instanceof UplinkError && error2.kind === "unauthorized") {
            noteClock(false);
            noteAnswer(false);
          }
          throw error2;
        }
      );
    };
  }
  const uplink = http ? new UplinkClient({ http, device: () => state.device, clock: clock2, log }) : null;
  if (uplink) {
    uplink.queueAlerts(restoredAlerts);
    pendingAlerts = () => uplink.pendingAlerts();
  }
  let alertSaveDue = false;
  let alertSavedAt = null;
  const saveAlertMemory = (now) => {
    const at = clock2.now();
    if (!now && alertSavedAt !== null && at >= alertSavedAt && at - alertSavedAt < ALERT_SAVE_GAP_MS) {
      alertSaveDue = true;
      return;
    }
    alertSaveDue = false;
    alertSavedAt = at;
    saveIfChanged();
  };
  const runner = new RuleRunner({
    provider,
    engine,
    limits: () => state.limits,
    clock: clock2,
    onEvents: (events) => {
      const upload = [];
      let raised = false;
      let cleared = false;
      for (const event of events) {
        list(event);
        presenter.present(event);
        if (!uploads(event)) continue;
        upload.push(event);
        if (event.active && !isReopened(event)) raised = true;
        if (!event.active) cleared = true;
      }
      if (uplink && upload.length > 0) {
        if (raised) uplink.sendAlerts(upload);
        else uplink.queueAlerts(upload);
      }
      if (raised || cleared) saveAlertMemory(raised);
    }
  });
  let lastTurn = null;
  let lastTurnId = null;
  let asking = false;
  let error = null;
  const linkStatus = () => {
    if (!state.paired) return "unpaired";
    if (!uplink) return "offline";
    const status = uplink.status();
    return status === "ok" && !answered ? "offline" : status;
  };
  const screenInput = () => ({
    snapshot: provider.snapshot(),
    alerts: listed,
    lastTurn,
    pending: asking,
    error,
    link: linkStatus(),
    pairUrl: pairingUrl(backendUrl, state.device),
    clockWrong
  });
  const screenVisible = () => {
    try {
      return ctx.ui.isVisible(SCREEN);
    } catch (e) {
      return false;
    }
  };
  const ask = (question, moving) => {
    if (asking || stopped) return;
    noteUse();
    if (!uplink) {
      error = TEXT_NO_SERVER;
      return;
    }
    asking = true;
    error = null;
    let current;
    try {
      current = gate.state() === "driving" ? void 0 : provider.snapshot();
    } catch (e) {
      current = void 0;
    }
    uplink.ask(question, moving ? "spoken" : "full", current).then(
      safe(log, "ask", (reply) => {
        asking = false;
        const turn = turnFrom(reply);
        if (turn !== null) {
          lastTurn = turn;
          lastTurnId = turn.id;
        }
      }),
      safe(log, "ask", (failure) => {
        asking = false;
        error = errorLine(failure);
      })
    );
  };
  let screen = null;
  try {
    screen = startScreen({ ctx, clock: clock2, log, input: screenInput, onChip: ask, has, frame });
  } catch (failure) {
    log.error("screen: " + (failure instanceof Error ? failure.message : String(failure)));
  }
  let polling = false;
  let pollGen = 0;
  let pollWait = null;
  let pollFailures = 0;
  let pollRefusals = 0;
  let pollCancel = null;
  const pollAllowed = () => !!uplink && !stopped && gate.state() !== "asleep" && screenVisible();
  const takeTurns = (turns) => {
    if (!Array.isArray(turns) || turns.length === 0) return true;
    const last = turnFrom(turns[turns.length - 1]);
    if (last === null) return false;
    lastTurn = last;
    lastTurnId = last.id;
    if (!asking) error = null;
    return true;
  };
  const waitThenPoll = (ms) => {
    if (!pollAllowed() || pollWait !== null) return;
    pollWait = timers2.setTimeout(afterWait, ms);
  };
  const pollNow = () => {
    if (polling) return;
    if (pollWait !== null) {
      timers2.clearTimeout(pollWait);
      pollWait = null;
    }
    pumpPoll();
  };
  const pumpPoll = () => {
    if (!uplink || !pollAllowed() || polling || pollWait !== null) return;
    polling = true;
    const gen = ++pollGen;
    const issuedAt = clock2.now();
    pollCancel = null;
    uplink.pollDialog(lastTurnId, (cancel) => {
      if (gen === pollGen) pollCancel = cancel;
    }).then(
      safe(log, "dialog poll", (turns) => {
        if (gen !== pollGen) return;
        polling = false;
        pollCancel = null;
        pollFailures = 0;
        if (!takeTurns(turns)) {
          if (pollRefusals === 0) log.warn("dialog poll: the newest turn from the backend was refused (wrong shape)");
          if (pollRefusals < 64) pollRefusals++;
          waitThenPoll(backoff(POLL_RETRY_MS, pollRefusals));
          return;
        }
        pollRefusals = 0;
        const now = clock2.now();
        const quick = (!Array.isArray(turns) || turns.length === 0) && now >= issuedAt && now - issuedAt < POLL_RETRY_MS;
        if (quick) waitThenPoll(POLL_RETRY_MS);
        else pumpPoll();
      }),
      safe(log, "dialog poll", (failure) => {
        if (gen !== pollGen) return;
        polling = false;
        pollCancel = null;
        if (failure instanceof UplinkError && failure.kind === "offline") {
          waitThenPoll(POLL_RETRY_MS);
          return;
        }
        if (pollFailures < 64) pollFailures++;
        waitThenPoll(backoff(POLL_RETRY_MS, pollFailures));
      })
    );
  };
  const afterWait = safe(log, "dialog poll", () => {
    pollWait = null;
    pumpPoll();
  });
  const stopPoll = () => {
    if (pollWait !== null) {
      timers2.clearTimeout(pollWait);
      pollWait = null;
    }
    pollGen++;
    polling = false;
    const cancel = pollCancel;
    pollCancel = null;
    if (cancel !== null) cancel();
  };
  let configWanted = true;
  let configBusy = false;
  let configTriedAt = null;
  let configFailures = 0;
  onAnswered = () => {
    if (pollFailures > 0) {
      pollFailures = 0;
      if (pollWait !== null) pollNow();
    }
    if (configWanted && !configBusy && configFailures > 0) {
      configFailures = 0;
      configTriedAt = null;
    }
  };
  const applyConfig = (config) => {
    const limits = config.ownerLimits;
    const popups = config.popupsEnabled === true;
    const merged = Object.assign({}, state.limits);
    for (const key of Object.keys(merged)) {
      const v = limits[key];
      merged[key] = typeof v === "number" && isFinite(v) ? v : null;
    }
    if (sameJson(merged, state.limits) && popups === state.popupsEnabled) return;
    state.limits = merged;
    state.popupsEnabled = popups;
    save();
  };
  const maybeFetchConfig = safe(log, "config", () => {
    if (!uplink || !http || !configWanted || configBusy || stopped || gate.state() === "asleep") return;
    const now = clock2.now();
    if (configTriedAt !== null && now >= configTriedAt && now - configTriedAt < backoff(CONFIG_RETRY_MS, configFailures)) return;
    if (!http.online()) return;
    configBusy = true;
    configTriedAt = now;
    uplink.fetchConfig().then(
      safe(log, "config", (config) => {
        configBusy = false;
        configWanted = false;
        configFailures = 0;
        applyConfig(config);
      }),
      safe(log, "config", () => {
        configBusy = false;
        if (configFailures < 64) configFailures++;
      })
    );
  });
  let tickHandle = null;
  let lastSnapshotAt = null;
  let lastRetryAt = null;
  let sample = null;
  const stepRules = safe(log, "rules", () => runner.tick());
  const stepGate = safe(log, "power gate", () => {
    gate.update(provider.snapshot());
  });
  const stepUplink = safe(log, "uplink tick", () => {
    if (!uplink) return;
    const now = clock2.now();
    if (lastSnapshotAt === null || now < lastSnapshotAt || now - lastSnapshotAt >= SNAPSHOT_EVERY_MS) {
      lastSnapshotAt = now;
      uplink.recordSnapshot(provider.snapshot());
    }
    uplink.onTick(gate.state());
    maybeFetchConfig();
    if (!state.paired && screenVisible() && (lastRetryAt === null || now < lastRetryAt || now - lastRetryAt >= PAIRING_RETRY_MS)) {
      lastRetryAt = now;
      const refused = uplink.status() === "unpaired";
      uplink.retry();
      if (refused) pollFailures = 0;
      pollNow();
    }
  });
  const stepAlertSave = safe(log, "state file", () => {
    if (alertSaveDue) saveAlertMemory(false);
  });
  const stepMeasure = safe(log, "self-measure", () => {
    const r = measure(sample, clock2.now(), () => process.memoryUsage(), () => process.cpuUsage());
    sample = r.sample;
    if (r.line) log.info(r.line);
  });
  const tick = safe(log, "tick", () => {
    if (stopped) return;
    stepRules();
    if (!state.paired && screenVisible()) gate.touch();
    stepGate();
    if (gate.state() === "asleep" || stopped) return;
    stepUplink();
    stepAlertSave();
    stepMeasure();
  });
  const startTick = () => {
    if (tickHandle === null && !stopped) tickHandle = timers2.setInterval(tick, TICK_MS);
  };
  const stopTick = () => {
    if (tickHandle !== null) {
      timers2.clearInterval(tickHandle);
      tickHandle = null;
    }
  };
  const fallAsleep = () => {
    stopTick();
    presenter.closeAll();
    stopPoll();
    if (uplink) uplink.close();
    answered = false;
    provider.suspend();
    alertSaveDue = false;
    saveIfChanged();
  };
  const wakeUp = () => {
    provider.resume();
    if (uplink) {
      uplink.reopen();
      uplink.retry();
    }
    configWanted = true;
    configTriedAt = null;
    configFailures = 0;
    pollFailures = 0;
    pollRefusals = 0;
    clockWrong = false;
    clockLogged = false;
    sample = null;
    lastRetryAt = clock2.now();
    startTick();
    maybeFetchConfig();
    pumpPoll();
  };
  gate.onChange(safe(log, "power", (next, previous) => {
    log.info("power: " + previous + " -> " + next);
    if (next === "asleep") fallAsleep();
    else if (previous === "asleep") wakeUp();
  }));
  provider.onChange((snapshot) => {
    if (!stopped && gate.state() === "asleep") gate.update(snapshot);
  });
  ctx.ui.onVisible(safe(log, "visible", (name, on) => {
    if (name !== SCREEN || stopped) return;
    if (on) noteUse();
    if (gate.state() === "asleep") log.info("screen: " + (on ? "shown" : "hidden") + " while asleep");
    if (on) pumpPoll();
    else stopPoll();
  }));
  let testPopupOn = setting(TEST_POPUP_SETTING) === true;
  ctx.settings.onChange(safe(log, "settings", (key, value) => {
    if (key === TEST_POPUP_SETTING) {
      const on = value === true;
      const turnedOn = on && !testPopupOn;
      testPopupOn = on;
      if (turnedOn && !stopped && gate.state() !== "asleep") presenter.presentText(TEST_POPUP_ID, TEXT_TEST_POPUP);
      return;
    }
    if (key !== "latinPopups") return;
    const ascii = value === true;
    if (ascii === state.asciiPopups) return;
    state.asciiPopups = ascii;
    save();
  }));
  const version = ctx.spec && typeof ctx.spec.version === "string" ? ctx.spec.version : "?";
  const reason = ctx.app && typeof ctx.app.startReason === "string" ? ctx.app.startReason : "unknown";
  log.info("Copilot " + version + " on Node " + process.version + ", start reason " + reason + (backendUrl ? "" : ", no backend address"));
  if (typeof ctx.background === "function") safe(log, "background", () => ctx.background("monitor", true))();
  safe(log, "provider start", () => provider.start())();
  startTick();
  maybeFetchConfig();
  pumpPoll();
  return {
    stop() {
      stopped = true;
      stopTick();
      stopPoll();
      presenter.closeAll();
      if (screen) screen.stop();
      if (uplink) uplink.close();
      safe(log, "provider stop", () => provider.stop())();
    },
    persist() {
      saveIfChanged();
    },
    inspect() {
      return {
        power: gate.state(),
        queued: uplink ? uplink.queued() : { snapshots: 0, alerts: 0 },
        history: engine.history().length,
        screen: screenInput()
      };
    }
  };
}

// src/main.ts
var mgu = require("./kit/mgu");
var fonts = require("./kit/fonts");
var gauges = require("./kit/gauges");
var fs = {
  existsSync: (p) => nodeFs.existsSync(p),
  readFileSync: (p, encoding) => nodeFs.readFileSync(p, encoding),
  writeFileSync: (p, data, options) => nodeFs.writeFileSync(p, data, options),
  renameSync: (from, to) => nodeFs.renameSync(from, to)
};
var timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};
function missingInterfaces() {
  try {
    const parsed = JSON.parse(nodeFs.readFileSync(path.join(__dirname, "kit", "missing-interfaces.json"), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [];
  } catch (e) {
    return [];
  }
}
function configOf(ctx) {
  const raw = ctx.spec && ctx.spec.config && typeof ctx.spec.config === "object" ? ctx.spec.config : {};
  const url = raw.backendUrl;
  const dropped = raw.droppedReadings;
  return {
    backendUrl: typeof url === "string" && url.trim() !== "" ? url.trim() : null,
    droppedReadings: Array.isArray(dropped) ? dropped.filter((k) => typeof k === "string") : [],
    missingInterfaces: missingInterfaces()
  };
}
var app = {
  start(ctx) {
    const handle = startApp({
      ctx,
      clock: { now: () => Date.now() },
      timers,
      fs,
      config: configOf(ctx),
      random: (bytes) => crypto.randomBytes(bytes).toString("hex"),
      screenKit: { has: (cp) => fonts.has(cp), frame: gauges.frame }
    });
    process.on("exit", safe(ctx.log, "exit", () => handle.persist()));
  }
};
safe(mgu.log, "run", () => mgu.run(app))();
