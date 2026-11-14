import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { emptySnapshot, isReversing, type VehicleSnapshot } from '@copilot/vehicle-core';
import { applyRaw, conditionFromRaw, createDecoderState, type DecoderState } from './raw-decoders';

const CDS = 'de.bmw.infotainment.vehicle.CDS';
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const VEHICLE = 'de.bmw.infotainment.vehicle.Vehicle';
const CCM = 'de.bmw.infotainment.checkcontrol.CheckControlMaster';
const KOMBI2 = 'de.bmw.infotainment.KombiInterface_2';
const VI = 'de.bmw.infrastructure.VehicleInformation';

type FeedEntry = [string, string, unknown];
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../test/fixtures/raw-signals.json', import.meta.url)), 'utf8'),
) as { feed: FeedEntry[] };

function feed(snapshot: VehicleSnapshot, entries: FeedEntry[], now: number, state: DecoderState): void {
  for (const [iface, field, value] of entries) applyRaw(snapshot, iface, field, value, now, state);
}

function valueOf(reading: { available: boolean; value?: unknown }): unknown {
  return reading.available ? reading.value : undefined;
}

describe('applyRaw', () => {
  test('decodes the fixture feed into the expected readings', () => {
    const s = emptySnapshot(0);
    feed(s, fixture.feed, 1000, createDecoderState());
    expect(s.engineRpm).toEqual({ available: true, value: 1850, unit: 'rpm', source: 'passive-signal', at: 1000 });
    expect(s.speed).toMatchObject({ available: true, value: 100, unit: 'km/h', source: 'passive-signal' });
    expect(s.oilTemp).toMatchObject({ available: true, value: 92, unit: '°C' });
    expect(s.coolantTemp).toMatchObject({ available: true, value: 88, unit: '°C' });
    expect(s.battery12vCharge).toMatchObject({ available: true, value: 84, unit: '%' });
    expect(s.fuelLevel).toMatchObject({ available: true, value: 41, unit: 'l', source: 'polled-signal' });
    expect(s.range).toMatchObject({ available: true, value: 452, unit: 'km', source: 'polled-signal' });
    expect(s.odometer).toMatchObject({ available: true, value: 23817, unit: 'km', source: 'polled-signal' });
    expect(s.condition).toMatchObject({ available: true, value: 'driving', unit: null });
    expect(s.gear).toMatchObject({ available: true, value: 'D4' });
    expect(s.gearStage).toMatchObject({ available: true, value: 'D' });
    expect(s.driveMode).toMatchObject({ available: true, value: 'Sport' });
    expect(valueOf(s.tyrePressure.frontLeft)).toBeCloseTo(2.5, 6);
    expect(valueOf(s.tyrePressure.rearLeft)).toBeCloseTo(2.7, 6);
    expect(valueOf(s.tyrePressure.rearRight)).toBeCloseTo(2.6, 6);
    expect(s.tyrePressure.frontRight).toMatchObject({ unit: 'bar', source: 'polled-signal' });
    expect(valueOf(s.tyrePressureTarget.rearRight)).toBeCloseTo(2.7, 6);
    expect(s.serviceItems).toEqual({
      available: true, unit: null, source: 'passive-signal', at: 1000,
      value: [
        { id: 1, name: 'Synthetic item one', status: 'ok', dueText: '09/2027, 9000 km' },
        { id: 3, name: 'Synthetic item two', status: 'due-soon', dueText: '01/2027' },
      ],
    });
    // what the passive feed can never give
    expect(s.battery12vVoltage).toEqual({ available: false, reason: 'not-reported' });
    expect(s.faultCodes).toEqual({ available: false, reason: 'not-reported' });
  });

  test('an invalid sentinel becomes invalid-value, never zero', () => {
    const s = emptySnapshot(0);
    applyRaw(s, CDS, 'statusEngineTemperature', { temperatureEngineOilDrive: 255, temperatureEngineDrive: 136 }, 5);
    expect(s.oilTemp).toEqual({ available: false, reason: 'invalid-value' });
    expect(s.coolantTemp).toMatchObject({ available: true, value: 88 });
    applyRaw(s, CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 65535 }, 5);
    expect(s.engineRpm).toEqual({ available: false, reason: 'invalid-value' });
    applyRaw(s, TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 65532 }, 5);
    expect(s.tyrePressure.frontLeft).toEqual({ available: false, reason: 'invalid-value' });
    expect(s.tyrePressure.frontRight).toEqual({ available: false, reason: 'invalid-value' });   // member missing
  });

  test.each([
    [1, 'parked'], [2, 'parked'], [3, 'standby'], [5, 'living'], [7, 'ignition-on'], [8, 'starting'],
    [10, 'driving'], [12, 'stopping'], ['FAHREN', 'driving'], [15, null], ['x', null],
  ])('condition %j → %j', (raw, expected) => expect(conditionFromRaw(raw)).toBe(expected));

  test('condition names, gaps in the table and junk', () => {
    expect(conditionFromRaw('PARKEN_BN_NIO')).toBe('parked');
    expect(conditionFromRaw('PARKEN_BN_IO')).toBe('parked');
    expect(conditionFromRaw('STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG')).toBe('standby');
    expect(conditionFromRaw('WOHNEN')).toBe('living');
    expect(conditionFromRaw('PRUEFEN_ANALYSE_DIAGNOSE')).toBe('ignition-on');
    expect(conditionFromRaw('FAHRBEREITSCHAFT_HERSTELLEN')).toBe('starting');
    expect(conditionFromRaw('FAHRBEREITSCHAFT_BEENDEN')).toBe('stopping');
    for (const junk of [0, 4, 6, 9, 11, 13, -1, 2.5, NaN, null, undefined, {}, [], 'toString', '10'])
      expect(conditionFromRaw(junk)).toBeNull();
  });

  test('an unknown condition stores invalid-value', () => {
    const s = emptySnapshot(0);
    applyRaw(s, 'de.bmw.infrastructure.VehicleCondition', 'VehicleCondition', { statusConditionVehicle: 15 }, 1);
    expect(s.condition).toEqual({ available: false, reason: 'invalid-value' });
  });

  test('kPa and psi tyre pressures are stored in bar; an unknown unit keeps unit null', () => {
    const unknown = emptySnapshot(0);
    applyRaw(unknown, TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 25 }, 1);
    expect(unknown.tyrePressure.frontLeft).toMatchObject({ available: true, unit: null });
    expect(valueOf(unknown.tyrePressure.frontLeft)).toBeCloseTo(2.5, 6);

    const kpaState = createDecoderState();
    const kpa = emptySnapshot(0);
    applyRaw(kpa, VEHICLE, 'statusNewCurrentUnitsStatusExt', { unitOfMeasurementAirPressure: 2 }, 1, kpaState);
    applyRaw(kpa, TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 2500 }, 1, kpaState);
    expect(kpa.tyrePressure.frontLeft).toMatchObject({ available: true, unit: 'bar' });
    expect(valueOf(kpa.tyrePressure.frontLeft)).toBeCloseTo(2.5, 6);

    const psiState = createDecoderState();
    const psi = emptySnapshot(0);
    applyRaw(psi, VEHICLE, 'statusNewCurrentUnitsStatusExt', { unitOfMeasurementAirPressure: 'PSI' }, 1, psiState);
    applyRaw(psi, TPMS, 'statusTargetTyrePressure', { targetPressureTyreRRH: 360 }, 1, psiState);
    expect(psi.tyrePressureTarget.rearRight).toMatchObject({ available: true, unit: 'bar' });
    expect(valueOf(psi.tyrePressureTarget.rearRight)).toBeCloseTo(36 * 0.0689476, 6);

    const barState = createDecoderState();
    const bar = emptySnapshot(0);
    applyRaw(bar, VEHICLE, 'statusNewCurrentUnitsStatusExt', { unitOfMeasurementAirPressure: 'BAR' }, 1, barState);
    applyRaw(bar, TPMS, 'statusTyrePressure', { actualValuePressureTyreRLH: 27 }, 1, barState);
    expect(bar.tyrePressure.rearLeft).toMatchObject({ available: true, unit: 'bar' });
    expect(valueOf(bar.tyrePressure.rearLeft)).toBeCloseTo(2.7, 6);

    // a unit the table does not know: back to unknown
    applyRaw(bar, VEHICLE, 'statusNewCurrentUnitsStatusExt', { unitOfMeasurementAirPressure: 9 }, 2, barState);
    applyRaw(bar, TPMS, 'statusTyrePressure', { actualValuePressureTyreRLH: 27 }, 2, barState);
    expect(bar.tyrePressure.rearLeft).toMatchObject({ available: true, unit: null });
  });

  test('a struct with a missing member or a wrong type does not throw', () => {
    for (const junk of [null, undefined, 42, 'x', {}, [], { actualValueRPMEngineCrankshaft: 'abc' }])
      expect(() => applyRaw(emptySnapshot(0), 'de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', junk, 0)).not.toThrow();
    const s = emptySnapshot(0);
    applyRaw(s, CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 'abc' }, 0);
    expect(s.engineRpm).toEqual({ available: false, reason: 'invalid-value' });
    applyRaw(s, CDS, 'statusEngineSpeed2', null, 0);
    expect(s.engineRpm).toEqual({ available: false, reason: 'invalid-value' });

    // every field of every interface, with every kind of junk
    const fields: Array<[string, string]> = [
      ...fixture.feed.map(([iface, field]): [string, string] => [iface, field]),
      [KOMBI2, 'newCCMessage'], [VI, 'statusGearboxDrive'], ['no.such.Interface', 'nothing'],
    ];
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 200; i++) { const next: Record<string, unknown> = {}; cursor.x = next; cursor = next; }
    const cyclic: Record<string, unknown> = { ccmId: 1, activeState: 0 };
    cyclic.self = cyclic;
    for (const [iface, field] of fields) {
      for (const junk of [null, undefined, 42, 'x', {}, [], [null, 1, 'a'], { value: 'x' }, deep, cyclic, NaN, true]) {
        const state = createDecoderState();
        expect(() => applyRaw(emptySnapshot(0), iface, field, junk, 0, state)).not.toThrow();
      }
    }
  });

  test('Check Control joins ids with text and colour; a message without text has text null', () => {
    const state = createDecoderState();
    const s = emptySnapshot(0);
    feed(s, fixture.feed.filter(([iface]) => iface === CCM || iface === KOMBI2), 1000, state);
    expect(s.checkControl).toMatchObject({ available: true, source: 'passive-signal', at: 1000 });
    expect(valueOf(s.checkControl)).toEqual([
      { id: 901, text: 'Synthetic message one', severity: 'warning', since: 1000 },
      { id: 902, text: null, severity: 'warning', since: 1000 },
    ]);

    // text that arrives after the id, a red colour, and an id going inactive
    applyRaw(s, KOMBI2, 'newCCMessage', { cCIdentifier: 902, cCName: 'Synthetic message two', cCColor: 'RED' }, 2000, state);
    expect(valueOf(s.checkControl)).toEqual([
      { id: 901, text: 'Synthetic message one', severity: 'warning', since: 1000 },
      { id: 902, text: 'Synthetic message two', severity: 'critical', since: 1000 },
    ]);
    applyRaw(s, CCM, 'basicList', [{ ccmId: 901, activeState: 'PASSIV' }], 3000, state);
    expect(valueOf(s.checkControl)).toEqual([{ id: 902, text: 'Synthetic message two', severity: 'critical', since: 1000 }]);

    // other known colours are info; an unknown colour is a warning
    applyRaw(s, KOMBI2, 'ccList', [{ cCIdentifer: 903, cCShortName: 'Three', cCColor: 'GREEN' }, { cCIdentifer: 904, cCShortName: 'Four', cCColor: 77 }], 4000, state);
    applyRaw(s, CCM, 'basicList', { basicList: [{ ccmId: 903, activeState: 0 }, { ccmId: 904, activeState: 0 }] }, 4000, state);
    expect(valueOf(s.checkControl)).toEqual([
      { id: 902, text: 'Synthetic message two', severity: 'critical', since: 1000 },
      { id: 903, text: 'Three', severity: 'info', since: 4000 },
      { id: 904, text: 'Four', severity: 'warning', since: 4000 },
    ]);
  });

  test('Check Control colours follow the reference table: white and green info; default, numbers and anything else a warning', () => {
    // A:apps/dtc_scanner/main.js:423 COL = { RED: crit, YELLOW: warn, ORANGE: warn, GREEN: GO, WHITE: text }
    const cases: Array<[unknown, string]> = [
      ['RED', 'critical'], ['YELLOW', 'warning'], ['ORANGE', 'warning'], ['GREEN', 'info'], ['WHITE', 'info'],
      ['DEFAULT', 'warning'], [1, 'warning'], [0, 'warning'], [undefined, 'warning'],
    ];
    cases.forEach(([colour, severity], i) => {
      const state = createDecoderState();
      const s = emptySnapshot(0);
      applyRaw(s, KOMBI2, 'ccList', [{ cCIdentifer: 950 + i, cCShortName: 'Colour ' + i, cCColor: colour }], 1, state);
      applyRaw(s, CCM, 'basicList', [{ ccmId: 950 + i, activeState: 0 }], 1, state);
      expect([colour, (valueOf(s.checkControl) as Array<{ severity: string }>)[0].severity]).toEqual([colour, severity]);
    });
  });

  test('Check Control texts are cleaned and bounded; a junk master list is invalid-value', () => {
    const state = createDecoderState();
    const s = emptySnapshot(0);
    applyRaw(s, KOMBI2, 'ccList', [{ cCIdentifer: 905, cCShortName: '  \u0007' + 'A'.repeat(500) + '\n' }], 1, state);
    applyRaw(s, CCM, 'basicList', [{ ccmId: 905, activeState: 0 }], 1, state);
    const list = valueOf(s.checkControl) as Array<{ text: string }>;
    expect(list[0].text).toMatch(/^A+$/);
    expect(list[0].text.length).toBeLessThanOrEqual(80);
    applyRaw(s, CCM, 'basicList', 'garbage', 2, state);
    expect(s.checkControl).toEqual({ available: false, reason: 'invalid-value' });
  });

  test('Check Control and service lists stay bounded', () => {
    const state = createDecoderState();
    const s = emptySnapshot(0);
    const many = Array.from({ length: 500 }, (_, i) => ({ ccmId: i + 1, activeState: 0 }));
    applyRaw(s, CCM, 'basicList', many, 1, state);
    expect((valueOf(s.checkControl) as unknown[]).length).toBeLessThanOrEqual(64);
    const texts = Array.from({ length: 500 }, (_, i) => ({ cCIdentifer: i + 1, cCShortName: 'T' + i }));
    expect(() => applyRaw(s, KOMBI2, 'ccList', texts, 1, state)).not.toThrow();
    const items = Array.from({ length: 500 }, (_, i) => ({ cBSIdentifier: i + 1, cBSColor: 1, cBSServcieName: 'X' }));
    applyRaw(s, KOMBI2, 'cbsDataServiceList', items, 1, state);
    expect((valueOf(s.serviceItems) as unknown[]).length).toBeLessThanOrEqual(32);
  });

  test('service colours: red due now (never overdue), yellow or orange due soon, green ok, else unknown; BMW typo member first', () => {
    const s = emptySnapshot(0);
    applyRaw(s, KOMBI2, 'cbsDataServiceList', { cbsDataServiceList: [
      { cBSIdentifier: 1, cBSColor: 'RED', cBSServcieName: 'Typo name', cBSServiceName: 'Other name' },
      { cBSIdentifier: 2, cBSColor: 'ORANGE' },
      { cBSIdentifier: 3, cBSColor: 4 },
      { cBSIdentifier: 4, cBSColor: 3 },
      { cBSIdentifier: 5, cBSColor: 'DEFAULT' },
      { cBSIdentifier: 6, cBSColor: 1 },
      { cBSIdentifier: 7, cBSColor: 'PURPLE' },
      { cBSIdentifier: 8, cBSColor: 9 },
      { cBSColor: 'RED' },
    ] }, 1);
    expect(valueOf(s.serviceItems)).toEqual([
      { id: 1, name: 'Typo name', status: 'due-now', dueText: null },
      { id: 2, name: null, status: 'due-soon', dueText: null },
      { id: 3, name: null, status: 'due-soon', dueText: null },
      { id: 4, name: null, status: 'ok', dueText: null },
      { id: 5, name: null, status: 'unknown', dueText: null },
      { id: 6, name: null, status: 'due-now', dueText: null },
      { id: 7, name: null, status: 'unknown', dueText: null },
      { id: 8, name: null, status: 'unknown', dueText: null },
    ]);
    applyRaw(s, KOMBI2, 'cbsDataServiceList', 42, 2);
    expect(s.serviceItems).toEqual({ available: false, reason: 'invalid-value' });
  });

  test('gear from the gearbox status and from the gear selection', () => {
    const s = emptySnapshot(0);
    applyRaw(s, VI, 'statusGearboxDrive', { statusActualStageDrive: 'D', statusActualGearDrive: 'G6' }, 1);
    expect([valueOf(s.gearStage), valueOf(s.gear)]).toEqual(['D', 'D6']);
    applyRaw(s, VI, 'statusGearboxDrive', { statusActualStageDrive: 2, statusActualGearDrive: 1 }, 1);
    expect([valueOf(s.gearStage), valueOf(s.gear)]).toEqual(['R', 'R']);
    applyRaw(s, VI, 'statusGearboxDrive', { statusActualStageDrive: 4, statusActualGearDrive: 5 }, 1);
    expect([valueOf(s.gearStage), valueOf(s.gear)]).toEqual(['D', 'D3']);
    applyRaw(s, VI, 'DataPowerTrain2', { statusGearSelectionDrive: 3 }, 1);
    expect([valueOf(s.gearStage), valueOf(s.gear)]).toEqual(['P', 'P']);
    applyRaw(s, VI, 'DataPowerTrain2', { statusGearSelectionDrive: 'NP' }, 1);       // N or P: P stays
    expect([valueOf(s.gearStage), valueOf(s.gear)]).toEqual(['P', 'P']);
    applyRaw(s, VI, 'DataPowerTrain2', { statusGearSelectionDrive: 'R' }, 1);
    expect([valueOf(s.gearStage), valueOf(s.gear)]).toEqual(['R', 'R']);
    applyRaw(s, VI, 'DataPowerTrain2', { statusGearSelectionDrive: 4 }, 1);           // N or P after R: no longer reversing, stage not known
    expect(s.gearStage).toEqual({ available: false, reason: 'invalid-value' });
    expect(isReversing(s)).toBe(false);
    expect(s.gear).toEqual({ available: false, reason: 'invalid-value' });
    applyRaw(s, VI, 'DataPowerTrain2', { statusGearSelectionDrive: 13 }, 1);
    expect([valueOf(s.gearStage), valueOf(s.gear)]).toEqual(['D', 'D9']);
    applyRaw(s, VI, 'statusGearboxDrive', { statusActualStageDrive: 'UNGUELTIG' }, 1);
    expect(s.gearStage).toEqual({ available: false, reason: 'invalid-value' });
    expect(s.gear).toEqual({ available: false, reason: 'invalid-value' });
  });

  test('driving mode: known numbers and names, no-data codes and unknown names', () => {
    const s = emptySnapshot(0);
    const FES = 'de.bmw.infotainment.drivingexcitement.FES';
    const mode = (raw: unknown): unknown => {
      applyRaw(s, FES, 'statusFESVehicleDynamicSwitchHMI', { actualValueModeDrivingExperience: raw }, 1);
      return s.driveMode.available ? s.driveMode.value : s.driveMode.reason;
    };
    expect(mode(4)).toBe('Comfort');
    expect(mode('SPORT_EXPERT')).toBe('Sport plus');
    expect(mode(10)).toBe('Adaptive');
    expect(mode(0)).toBe('invalid-value');
    expect(mode(63)).toBe('invalid-value');
    expect(mode(42)).toBe('invalid-value');
    expect(mode('SOME_NEW_MODE')).toBe('SOME_NEW_MODE');
    expect(mode('SIGNAL_UNGUELTIG')).toBe('invalid-value');
  });
});
