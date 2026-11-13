'use strict';
// Node 8 compatibility smoke test for the two packages that also run on the head unit
// (@copilot/vehicle-core and @copilot/event-engine). Plain ES2017 CommonJS: only `assert` and the
// compiled dist/ files. It exercises real behaviour, not just loading: catalogue decoding, the mock
// provider driven by an injected clock and timer stub, and the event engine with the default rules.
//
// Run through `npm run node8` (builds both packages, then runs this file on Node 8.16.2), or directly
// with `node scripts/node8-smoke.js` after `npm run build -w @copilot/vehicle-core -w @copilot/event-engine`.
// All vehicle data comes from the mock; nothing here talks to a vehicle or the network.

const assert = require('assert');

// String-literal relative requires, so the static fallback of scripts/run-node8.sh can follow them.
const vehicleCore = require('../packages/vehicle-core/dist/index.js');
const eventEngine = require('../packages/event-engine/dist/index.js');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const START = 1700000000000;

/** A hand-made clock whose time the test moves. */
function makeClock(t) {
  return {
    t: t,
    now: function () { return this.t; },
  };
}

/** A timer stub: records setInterval / clearInterval calls and fires intervals only on demand. */
function makeTimers() {
  const timers = {
    intervals: [],
    cleared: [],
    setInterval: function (fn, ms) {
      const handle = { fn: fn, ms: ms, active: true };
      timers.intervals.push(handle);
      return handle;
    },
    clearInterval: function (handle) {
      timers.cleared.push(handle);
      if (handle) handle.active = false;
    },
    fire: function () {
      for (const h of timers.intervals.slice()) {
        if (h.active) h.fn();
      }
    },
  };
  return timers;
}

/** A fresh copy of the frozen NO_LIMITS with the given overrides. */
function limitsWith(overrides) {
  return Object.assign({}, eventEngine.NO_LIMITS, overrides || {});
}

/**
 * Runs one mock scenario for `durationMs` at 1 s ticks through a fresh EventEngine with the default rules.
 * The provider's own interval drives the ticks (fired by the stub); every snapshot goes through the engine.
 */
function runScenario(scenario, durationMs, limits) {
  const clock = makeClock(START);
  const timers = makeTimers();
  const provider = new vehicleCore.MockVehicleDataProvider({ clock: clock, timers: timers, scenario: scenario });
  const engine = new eventEngine.EventEngine(eventEngine.defaultEngineOptions());
  const raised = [];
  const cleared = [];
  provider.onChange(function (snapshot) {
    const events = engine.evaluate(snapshot, clock.now(), limits);
    for (const e of events) {
      if (e.active) raised.push(e);
      else cleared.push(e);
    }
  });
  provider.start();
  assert.strictEqual(timers.intervals.length, 1, scenario + ': start() schedules exactly one interval');
  assert.strictEqual(timers.intervals[0].ms, 1000, scenario + ': default tick is 1000 ms');
  for (let elapsed = SECOND; elapsed <= durationMs; elapsed += SECOND) {
    clock.t = START + elapsed;
    timers.fire();
  }
  return { clock: clock, timers: timers, provider: provider, engine: engine, raised: raised, cleared: cleared };
}

// 1. Catalogue decoding (scalings and sentinels as specified in plan 1, Task 2).
(function catalogue() {
  const decodeRaw = vehicleCore.decodeRaw;
  const findSignal = vehicleCore.findSignal;
  assert.strictEqual(decodeRaw(findSignal('engineRpm'), 7400), 1850);
  assert.strictEqual(decodeRaw(findSignal('speed'), 6400), 100);
  assert.strictEqual(decodeRaw(findSignal('oilTemp'), 140), 92);
  assert.strictEqual(decodeRaw(findSignal('coolantTemp'), 136), 88);
  assert.strictEqual(decodeRaw(findSignal('engineRpm'), 65535), null);
  assert.strictEqual(decodeRaw(findSignal('range'), 4095), null);
  assert.strictEqual(decodeRaw(findSignal('speed'), NaN), null);
  assert.strictEqual(decodeRaw(findSignal('speed'), Infinity), null);
  assert.strictEqual(findSignal('no-such-signal'), undefined);
  assert.ok(vehicleCore.SIGNAL_CATALOGUE.length > 0, 'the catalogue is not empty');
})();

// 2. Overheat: exactly one Check Control event, raised after the 4 s dwell, critical, with the car's text.
(function overheat() {
  const run = runScenario('overheat-check-control', 70 * SECOND, limitsWith());
  assert.strictEqual(run.raised.length, 1, 'overheat raises exactly one event');
  const e = run.raised[0];
  assert.strictEqual(e.provenance, 'bmw-check-control');
  assert.strictEqual(e.severity, 'critical');
  assert.strictEqual(e.title, 'Температура двигуна. Обережно зупиніться');
  assert.strictEqual(e.at, START + 64 * SECOND, 'raised once the message has stood for the 4 s dwell');
  assert.strictEqual(run.engine.active().length, 1);

  // The head-unit clock jumps a day backwards: nothing throws and nothing new is raised.
  run.clock.t = START - 24 * 60 * MINUTE;
  for (let i = 0; i < 10; i++) {
    run.timers.fire();
    run.clock.t += SECOND;
  }
  assert.strictEqual(run.raised.length, 1, 'a clock jumping backwards raises no burst');

  // stop() clears the one interval it scheduled.
  run.provider.stop();
  assert.strictEqual(run.timers.cleared.length, 1);
  assert.strictEqual(run.timers.cleared[0], run.timers.intervals[0]);
})();

// 3. Nothing available: no event, no throw, the mock delivers nothing.
(function signalsMissing() {
  const run = runScenario('signals-missing', 10 * MINUTE, limitsWith({
    oilTempMaxC: 100, coolantTempMaxC: 100, battery12vMinPercent: 50, tyrePressureDeviationBar: 0.3,
  }));
  assert.strictEqual(run.raised.length, 0, 'an all-unavailable snapshot raises nothing');
  assert.deepStrictEqual(run.provider.capabilities().delivers, []);
  const s = run.provider.snapshot();
  assert.strictEqual(s.oilTemp.available, false);
  assert.strictEqual(s.intakeTemp.reason, 'diagnostics-disabled');
})();

// 4. Low tyre with an owner deviation limit: the owner-limit event and the Check Control message, once each,
//    even when the message later switches to its id-only variant.
(function lowTyre() {
  const run = runScenario('low-tyre', 120 * SECOND, limitsWith({ tyrePressureDeviationBar: 0.3 }));
  const byProvenance = {};
  for (const e of run.raised) byProvenance[e.provenance] = (byProvenance[e.provenance] || 0) + 1;
  assert.deepStrictEqual(byProvenance, { 'owner-configured': 1, 'bmw-check-control': 1 });
  const owner = run.raised.filter(function (e) { return e.provenance === 'owner-configured'; })[0];
  assert.strictEqual(owner.title, 'Тиск у шині (задня ліва) 2,0 бар, ціль авто 2,4 бар');
  assert.strictEqual(owner.dedupKey, 'limit:tyre:rearLeft');
  const cc = run.raised.filter(function (e) { return e.provenance === 'bmw-check-control'; })[0];
  assert.strictEqual(cc.title, 'Тиск у шинах: задня ліва');
  assert.strictEqual(cc.severity, 'warning');
  assert.strictEqual(run.cleared.length, 0);
})();

// 5. Same scenario without owner limits: only the car's own message.
(function lowTyreNoLimits() {
  const run = runScenario('low-tyre', 120 * SECOND, limitsWith());
  assert.strictEqual(run.raised.length, 1);
  assert.strictEqual(run.raised[0].provenance, 'bmw-check-control');
})();

// 6. Stored faults: only the code that is active with the warning lamp.
(function storedFaults() {
  const run = runScenario('stored-faults', 30 * SECOND, limitsWith());
  assert.strictEqual(run.raised.length, 1);
  assert.strictEqual(run.raised[0].provenance, 'bmw-fault-status');
  assert.strictEqual(run.raised[0].severity, 'warning');
})();

// 7. Steady cruise for 30 minutes without owner limits: only the due-soon service item, once.
(function steadyCruise() {
  const run = runScenario('steady-cruise', 30 * MINUTE, limitsWith());
  assert.strictEqual(run.raised.length, 1);
  assert.strictEqual(run.raised[0].provenance, 'bmw-service');
  assert.strictEqual(run.raised[0].severity, 'info');
  assert.strictEqual(run.raised[0].title, 'Гальмівна рідина: через 3 місяці');
})();

// 8. Owner oil limit with hysteresis: raised after the 5 s dwell, cleared only 2 degrees below the limit.
(function ownerOilLimit() {
  const engine = new eventEngine.EventEngine(eventEngine.defaultEngineOptions());
  const limits = limitsWith({ oilTempMaxC: 115 });
  function snapshotWithOil(value, now) {
    const s = vehicleCore.emptySnapshot(now);
    s.oilTemp = vehicleCore.available(value, '°C', 'mock', now);
    return s;
  }
  assert.deepStrictEqual(engine.evaluate(snapshotWithOil(116, START), START, limits), []);
  assert.deepStrictEqual(engine.evaluate(snapshotWithOil(116, START + 4 * SECOND), START + 4 * SECOND, limits), []);
  const raised = engine.evaluate(snapshotWithOil(116, START + 5 * SECOND), START + 5 * SECOND, limits);
  assert.strictEqual(raised.length, 1);
  assert.strictEqual(raised[0].title, 'Масло 116 °C — вище вашого ліміту 115 °C');
  assert.deepStrictEqual(engine.evaluate(snapshotWithOil(114, START + 6 * SECOND), START + 6 * SECOND, limits), []);
  const cleared = engine.evaluate(snapshotWithOil(113, START + 7 * SECOND), START + 7 * SECOND, limits);
  assert.strictEqual(cleared.length, 1);
  assert.strictEqual(cleared[0].active, false);
  assert.strictEqual(cleared[0].clearedAt, START + 7 * SECOND);
})();

// 9. setScenario notifies at once and restarts elapsed time; an unsubscribed listener is not called.
(function scenarioSwitch() {
  const clock = makeClock(START);
  const timers = makeTimers();
  const provider = new vehicleCore.MockVehicleDataProvider({ clock: clock, timers: timers });
  assert.strictEqual(provider.scenarioId(), 'steady-cruise');
  let calls = 0;
  const unsubscribe = provider.onChange(function () { calls++; });
  clock.t = START + 90 * SECOND;
  provider.setScenario('overheat-check-control');
  assert.strictEqual(calls, 1);
  assert.strictEqual(provider.scenarioId(), 'overheat-check-control');
  const cc = provider.snapshot().checkControl;
  assert.ok(cc.available && cc.value.length === 0, 'elapsed time restarted: no Check Control yet');
  unsubscribe();
  provider.tick();
  assert.strictEqual(calls, 1);
})();

console.log('node8 smoke ok on ' + process.version);
