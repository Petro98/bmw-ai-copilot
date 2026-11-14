import { describe, expect, test } from 'vitest';
import {
  available,
  emptySnapshot,
  unavailable,
  type VehicleSnapshot,
} from '@copilot/vehicle-core';
import type { AlertEvent } from '@copilot/event-engine';
import type { DialogTurn } from '@copilot/shared';
import {
  CHIPS_MOVING,
  CHIPS_PARKED,
  buildViewModel,
  pairingUrl,
  type ViewModelInput,
} from './view-model';
import { pairingLines } from './draw-pairing';
import { encodeQr } from './qr';
import { fitText } from './theme';
import { PAIRING_LINES, PAIRING_NO_ADDRESS, TEXT_CLOCK } from './strings.uk';
import { startScreen, type ScreenKit } from './screen';
import type { Log } from '../safe';

/** 2026-11-13 12:41:00 local time: the tests do not depend on the machine's time zone. */
const NOW = new Date(2026, 10, 13, 12, 41, 0).getTime();
const SEC = 1000;

/** A healthy car standing still, as in the mockups (docs/design/mockups/Main.dc.html, Sensors.dc.html). */
function parkedSnapshot(now = NOW): VehicleSnapshot {
  const s = emptySnapshot(now);
  s.condition = available('living', null, 'passive-signal', now - 2 * SEC);
  s.speed = available(0, 'km/h', 'passive-signal', now);
  s.engineRpm = available(1850, 'rpm', 'passive-signal', now);
  s.oilTemp = available(92, '°C', 'passive-signal', now - 4 * SEC);
  s.coolantTemp = available(88, '°C', 'passive-signal', now - 4 * SEC);
  s.gear = available('D4', null, 'passive-signal', now);
  s.driveMode = available('Comfort', null, 'passive-signal', now);
  s.fuelLevel = available(41, 'l', 'polled-signal', now - 9 * SEC);
  s.range = available(452, 'km', 'polled-signal', now - 9 * SEC);
  s.battery12vCharge = available(84, '%', 'passive-signal', now - 9 * SEC);
  s.tyrePressure = {
    frontLeft: available(2.3, 'bar', 'polled-signal', now - 10 * SEC),
    frontRight: available(2.3, 'bar', 'polled-signal', now - 10 * SEC),
    rearLeft: available(2.4, 'bar', 'polled-signal', now - 10 * SEC),
    rearRight: available(2.4, 'bar', 'polled-signal', now - 10 * SEC),
  };
  s.tyrePressureTarget = {
    frontLeft: available(2.3, 'bar', 'polled-signal', now - 10 * SEC),
    frontRight: available(2.3, 'bar', 'polled-signal', now - 10 * SEC),
    rearLeft: available(2.4, 'bar', 'polled-signal', now - 10 * SEC),
    rearRight: available(2.4, 'bar', 'polled-signal', now - 10 * SEC),
  };
  s.intakeTemp = unavailable('diagnostics-disabled');
  return s;
}

function movingSnapshot(): VehicleSnapshot {
  const s = parkedSnapshot();
  s.condition = available('driving', null, 'passive-signal', NOW);
  s.speed = available(87, 'km/h', 'passive-signal', NOW);
  return s;
}

function input(over: Partial<ViewModelInput> = {}): ViewModelInput {
  return {
    snapshot: parkedSnapshot(), alerts: [], lastTurn: null, pending: false, error: null,
    link: 'ok', tab: 'assistant', now: NOW, pairUrl: null, ...over,
  };
}

function alert(over: Partial<AlertEvent>): AlertEvent {
  return {
    id: 'a1', ruleId: 'r', dedupKey: 'k', provenance: 'bmw-check-control', severity: 'warning',
    title: 'Тиск у шинах: задня ліва', detail: null, at: new Date(2026, 10, 13, 12, 36).getTime(),
    active: true, clearedAt: null, ...over,
  };
}

const TURN: DialogTurn = {
  id: 't1', at: NOW - 30 * SEC, question: 'Як почувається авто?', answer: 'Двигун прогрітий: масло 92 °C.',
  style: 'full', source: 'car', model: 'mock', snapshotAt: new Date(2026, 10, 13, 12, 40).getTime(),
};

describe('sensor tiles', () => {
  test('a healthy parked snapshot produces the mockup tiles', () => {
    const vm = buildViewModel(input({ tab: 'sensors' }));
    expect(vm.sensors.map((t) => t.label)).toEqual([
      'ОБЕРТИ ДВИГУНА', 'МАСЛО', 'ОХОЛОДЖУВАЛЬНА РІДИНА', 'ПЕРЕДАЧА І РЕЖИМ',
      'ПАЛЬНЕ', 'АКУМУЛЯТОР 12 В', 'ШИНИ, БАР', 'ТЕМПЕРАТУРА ВПУСКУ',
    ]);
    expect(vm.sensors[0]).toEqual({ label: 'ОБЕРТИ ДВИГУНА', value: '1 850', unit: 'об/хв', note: 'Сигнал авто · щойно', available: true });
    expect(vm.sensors[1]).toEqual({ label: 'МАСЛО', value: '92', unit: '°C', note: 'Сигнал авто · 4 с тому', available: true });
    expect(vm.sensors[3]).toMatchObject({ value: 'D4', unit: null, note: 'Comfort\nСигнал авто · щойно' });
    expect(vm.sensors[4]).toMatchObject({ value: '41', unit: 'л', note: 'Запас ходу 452 км\nОпитування · 9 с тому' });
    expect(vm.sensors[5]).toMatchObject({ value: '84', unit: '%', note: 'Рівень заряду, не напруга\nСигнал авто · 9 с тому' });
    expect(vm.sensors[6]).toMatchObject({ value: '2,3 2,3\n2,4 2,4', unit: null, note: 'Ціль авто: 2,3 і 2,4\nОпитування · 10 с тому', available: true });
  });

  test('an unavailable reading keeps its tile with «Недоступно» and a reason, and no number', () => {
    const s = parkedSnapshot();
    s.oilTemp = unavailable('invalid-value');
    const vm = buildViewModel(input({ snapshot: s, tab: 'sensors' }));
    const oil = vm.sensors[1];
    expect(oil).toEqual({ label: 'МАСЛО', value: 'Недоступно', unit: null, note: 'Авто надіслало недійсне значення.', available: false });
    expect(oil.value + (oil.note ?? '')).not.toMatch(/\d/);
    const intake = vm.sensors[7];
    expect(intake).toEqual({
      label: 'ТЕМПЕРАТУРА ВПУСКУ', value: 'Недоступно', unit: null,
      note: 'Потрібне діагностичне читання. Воно вимкнене в налаштуваннях.', available: false,
    });
    // in the assistant's strip as well
    const strip = buildViewModel(input({ snapshot: s })).assistant.strip;
    expect(strip[0]).toMatchObject({ label: 'МАСЛО', value: 'Недоступно', unit: null, available: false });
  });

  test('before the first snapshot every tile is there, unavailable', () => {
    const vm = buildViewModel(input({ snapshot: null, tab: 'sensors' }));
    expect(vm.sensors).toHaveLength(8);
    for (const tile of vm.sensors) expect(tile).toMatchObject({ value: 'Недоступно', available: false });
  });
});

describe('assistant', () => {
  test('moving shows three chips and three strip readings; standing shows six and five', () => {
    const standing = buildViewModel(input({ lastTurn: TURN }));
    expect(standing.moving).toBe(false);
    expect(standing.assistant.chips).toEqual(CHIPS_PARKED);
    expect(CHIPS_PARKED).toHaveLength(6);
    expect(standing.assistant.strip.map((t) => t.label)).toEqual(['МАСЛО', 'ОХОЛОДЖУВАЛЬНА РІДИНА', 'АКУМУЛЯТОР 12 В', 'ПАЛЬНЕ', 'ЗАПАС ХОДУ']);
    expect(standing.assistant.strip[4]).toMatchObject({ value: '452', unit: 'км' });

    const moving = buildViewModel(input({ snapshot: movingSnapshot(), lastTurn: TURN }));
    expect(moving.moving).toBe(true);
    expect(moving.assistant.chips).toEqual(['Стан авто', 'Чи можна навантажувати?', 'Попередження']);
    expect(CHIPS_MOVING).toEqual(moving.assistant.chips);
    expect(moving.assistant.strip.map((t) => t.label)).toEqual(['МАСЛО', 'ОХОЛОДЖУВАЛЬНА РІДИНА', 'ЗАПАС ХОДУ']);
  });

  test('the last turn, a pending question and an error are shown in the answer slot', () => {
    expect(buildViewModel(input({ lastTurn: TURN })).assistant).toMatchObject({
      question: 'Як почувається авто?', answer: 'Двигун прогрітий: масло 92 °C.', pending: false, error: null,
    });
    expect(buildViewModel(input({ lastTurn: TURN, pending: true })).assistant).toMatchObject({ question: null, answer: null, pending: true });
    expect(buildViewModel(input({ lastTurn: TURN, error: 'Немає зв\'язку з сервером' })).assistant)
      .toMatchObject({ question: null, answer: null, error: 'Немає зв\'язку з сервером' });
  });

  test('an unknown speed counts as standing', () => {
    const s = parkedSnapshot();
    s.speed = unavailable('not-reported');
    expect(buildViewModel(input({ snapshot: s })).moving).toBe(false);
  });
});

describe('signature', () => {
  test('the signature is stable for an unchanged input and changes when a visible value changes', () => {
    const a = buildViewModel(input({ tab: 'sensors' }));
    const b = buildViewModel(input({ tab: 'sensors' }));
    expect(b.signature).toBe(a.signature);

    // a change in a reading's `at` alone, with the same displayed age text, does not change it
    const s = parkedSnapshot();
    s.engineRpm = available(1850, 'rpm', 'passive-signal', NOW - 600);
    s.oilTemp = available(92, '°C', 'passive-signal', NOW - 4 * SEC + 300);
    expect(buildViewModel(input({ snapshot: s, tab: 'sensors' })).signature).toBe(a.signature);

    const hotter = parkedSnapshot();
    hotter.oilTemp = available(93, '°C', 'passive-signal', NOW - 4 * SEC);
    expect(buildViewModel(input({ snapshot: hotter, tab: 'sensors' })).signature).not.toBe(a.signature);
    expect(buildViewModel(input({ tab: 'alerts' })).signature).not.toBe(a.signature);
    expect(buildViewModel(input({ tab: 'sensors', now: NOW + 2 * SEC })).signature).not.toBe(a.signature);   // ages moved on
  });

  test('only what the tab shown draws is in the signature', () => {
    const later = NOW + 5 * SEC;                       // the sensors tiles' age notes move on; status stays
    const listed = [alert({})];
    const changed = [alert({}), alert({ id: 'a2', title: 'Двигун', severity: 'critical' })];

    const assistant = buildViewModel(input({ alerts: listed })).signature;
    expect(buildViewModel(input({ alerts: listed, now: later })).signature).toBe(assistant);
    expect(buildViewModel(input({ alerts: changed })).signature).toBe(assistant);

    const alerts = buildViewModel(input({ tab: 'alerts', alerts: listed })).signature;
    expect(buildViewModel(input({ tab: 'alerts', alerts: listed, now: later })).signature).toBe(alerts);
    const hotter = parkedSnapshot();
    hotter.oilTemp = available(93, '°C', 'passive-signal', NOW - 4 * SEC);
    expect(buildViewModel(input({ tab: 'alerts', alerts: listed, snapshot: hotter })).signature).toBe(alerts);
    expect(buildViewModel(input({ tab: 'alerts', alerts: changed })).signature).not.toBe(alerts);

    const sensors = buildViewModel(input({ tab: 'sensors', alerts: listed })).signature;
    expect(buildViewModel(input({ tab: 'sensors', alerts: changed })).signature).toBe(sensors);
    expect(buildViewModel(input({ tab: 'sensors', lastTurn: TURN })).signature).toBe(sensors);

    // the header (status marks) is on every tab; the assistant's answer and the pairing only on its own
    expect(buildViewModel(input({ alerts: listed, link: 'offline' })).signature).not.toBe(assistant);
    expect(buildViewModel(input({ tab: 'alerts', alerts: listed, link: 'offline' })).signature).not.toBe(alerts);
    expect(buildViewModel(input({ alerts: listed, lastTurn: TURN })).signature).not.toBe(assistant);
  });

  test('ages move on together at the whole seconds of the clock, not at each reading\'s own phase', () => {
    const s = parkedSnapshot();
    s.oilTemp = available(92, '°C', 'passive-signal', NOW - 3500);
    const first = buildViewModel(input({ snapshot: s, tab: 'sensors' }));
    expect(first.sensors[1].note).toBe('Сигнал авто · 4 с тому');
    // 600 ms later, still inside the same second of the clock: nothing on the page moved
    expect(buildViewModel(input({ snapshot: s, tab: 'sensors', now: NOW + 600 })).signature).toBe(first.signature);
    expect(buildViewModel(input({ snapshot: s, tab: 'sensors', now: NOW + 1000 })).sensors[1].note).toBe('Сигнал авто · 5 с тому');
  });
});

describe('screen', () => {
  /** A stand-in for the kit's ctx: a canvas that takes every drawing call, a loop the test turns by hand. */
  function fakeKit(renderer: boolean) {
    const handlers: { turn: (() => unknown) | null; visible: Array<(name: string, on: boolean) => void> } = { turn: null, visible: [] };
    const target: Record<string | symbol, unknown> = {
      w: 1600, h: 520, textScale: renderer ? 1.1 : 1, extra: 0, own: renderer, chrome: renderer ? { tabs: null } : null,
      place: renderer ? { full: true, scale: 1.1 } : null, scroll: false,
      textWidth: (s: string, size: number) => s.length * size * 0.5,
      text: (s: string, _x: number, _y: number, size: number) => s.length * size * 0.5,
    };
    const cv: unknown = new Proxy(target, {
      get: (t, k) => (k in t ? t[k] : () => cv),
    });
    let frames = 0;
    const ctx = {
      canvas: () => cv,
      loop: (_name: string, _fps: number, fn: () => unknown) => { handlers.turn = fn; return { kick() {}, stop() {} }; },
      onTab: () => undefined,
      onLayout: () => undefined,
      theme: () => ({}),
      ui: { image: () => { frames++; return Promise.resolve(); }, onVisible: (fn: (name: string, on: boolean) => void) => handlers.visible.push(fn) },
    };
    return { ctx, frames: () => frames, turn: () => handlers.turn && handlers.turn() };
  }

  function run(renderer: boolean, tab: 'assistant' | 'sensors' | 'alerts', seconds: number, revving = false) {
    let now = NOW;
    const kit = fakeKit(renderer);
    const errors: string[] = [];
    const log = { info() {}, warn() {}, error: (m: string) => errors.push(m) };
    startScreen({
      ctx: kit.ctx as unknown as ScreenKit, clock: { now: () => now }, log: log as unknown as Log, tab,
      // a steady car: two readings polled every 10 s, each at its own phase of the second (.0 and .5)
      input: () => {
        const s = parkedSnapshot(now);
        s.fuelLevel = available(41, 'l', 'polled-signal', now - (now % (10 * SEC)));
        s.coolantTemp = available(88, '°C', 'polled-signal', now - ((now - 500) % (10 * SEC)));
        // revving: a value that changes four times a second
        if (revving) s.engineRpm = available(1800 + ((now / 250) % 8) * 50, 'rpm', 'passive-signal', now);
        return { snapshot: s, alerts: [], lastTurn: TURN, pending: false, error: null, link: 'ok', pairUrl: null };
      },
      onChip: () => undefined, has: () => true, frame: () => ({ x: 0, y: 72, w: 1600, h: 448 }) as never,
    });
    for (let t = 0; t < seconds * 4; t++) { kit.turn(); now += 250; }
    expect(errors).toEqual([]);
    return kit.frames();
  }

  test('on the software (PNG) path at most one frame a second is drawn', () => {
    const frames = run(false, 'sensors', 20, true);
    expect(frames).toBeGreaterThanOrEqual(19);
    expect(frames).toBeLessThanOrEqual(21);
    // on the renderer every change is drawn (the kit's loop keeps that at the 4 fps asked for)
    expect(run(true, 'sensors', 20, true)).toBeGreaterThan(70);
  });

  test('a steady car on the assistant and alerts tabs is drawn once', () => {
    expect(run(true, 'assistant', 20)).toBe(1);
    expect(run(true, 'alerts', 20)).toBe(1);
    expect(run(false, 'assistant', 20)).toBe(1);
    // the sensors tab on the renderer: its age notes move on once a second at most
    expect(run(true, 'sensors', 20)).toBeLessThanOrEqual(21);
  });
});

describe('alerts', () => {
  test('alerts carry severity word, provenance tag and time in the tag line', () => {
    const vm = buildViewModel(input({
      tab: 'alerts',
      alerts: [
        alert({}),
        alert({ id: 'a2', provenance: 'bmw-fault-status', severity: 'critical', title: 'Двигун', at: NOW - 60 * SEC }),
        alert({ id: 'a3', provenance: 'owner-configured', title: 'Масло 118 °C — вище вашого ліміту 115 °C', at: new Date(2026, 10, 9, 9, 0).getTime() }),
        alert({ id: 'a4', provenance: 'bmw-service', severity: 'info', title: 'Гальмівна рідина', at: new Date(2026, 10, 12, 8, 0).getTime() }),
      ],
    }));
    const tags = vm.alerts.map((a) => a.tag);
    expect(tags).toContain('ПОПЕРЕДЖЕННЯ · BMW CHECK CONTROL · АКТИВНЕ З 12:36');
    expect(tags).toContain('КРИТИЧНО · ПАМ\'ЯТЬ ПОМИЛОК BMW · АКТИВНЕ З 12:40');
    expect(tags).toContain('ПОПЕРЕДЖЕННЯ · ВАШ ЛІМІТ · АКТИВНЕ З 9 ЛИСТОПАДА');
    expect(tags).toContain('ДО ВІДОМА · СЕРВІС BMW · АКТИВНЕ З УЧОРА');
    expect(vm.alerts[0]).toMatchObject({ title: 'Двигун', severity: 'critical', active: true });   // critical first
  });

  test('a cleared alert says when it was cleared and comes after the active ones', () => {
    const vm = buildViewModel(input({
      tab: 'alerts',
      alerts: [
        alert({ id: 'old', active: false, clearedAt: new Date(2026, 10, 13, 12, 39).getTime() }),
        alert({ id: 'new', title: 'Низький заряд', at: NOW - 10 * SEC }),
      ],
    }));
    expect(vm.alerts.map((a) => a.active)).toEqual([true, false]);
    expect(vm.alerts[1].tag).toBe('ПОПЕРЕДЖЕННЯ · BMW CHECK CONTROL · ЗНЯТО О 12:39');
  });

  test('at most four alerts are listed', () => {
    const many = Array.from({ length: 9 }, (_, i) => alert({ id: 'x' + i, title: 'А' + i, at: NOW - i * SEC }));
    expect(buildViewModel(input({ tab: 'alerts', alerts: many })).alerts).toHaveLength(4);
  });
});

describe('status and pairing', () => {
  test('status marks follow the link status and data freshness', () => {
    expect(buildViewModel(input()).status).toEqual({ car: true, network: true, claude: true });
    expect(buildViewModel(input({ link: 'offline' })).status).toEqual({ car: true, network: false, claude: false });
    expect(buildViewModel(input({ link: 'clock' })).status).toMatchObject({ network: false });
    expect(buildViewModel(input({ error: 'Сервер відхилив запит' })).status).toEqual({ car: true, network: true, claude: false });
    expect(buildViewModel(input({ snapshot: null })).status.car).toBe(false);
    // a snapshot the 1 Hz tick stopped refreshing
    expect(buildViewModel(input({ snapshot: parkedSnapshot(NOW - 30 * SEC) })).status.car).toBe(false);
    // a car that reports nothing at all
    expect(buildViewModel(input({ snapshot: emptySnapshot(NOW) })).status.car).toBe(false);
  });

  test('unpaired with a backend address yields a pairing URL; without one it says so', () => {
    const device = { id: 'dev_0123456789abcdef', secret: 'S'.repeat(43) };
    const url = pairingUrl('https://example.invalid/', device);
    expect(url).toBe('https://example.invalid/pair#d=dev_0123456789abcdef&s=' + 'S'.repeat(43));
    expect(pairingUrl(null, device)).toBeNull();
    expect(pairingUrl('https://example.invalid', null)).toBeNull();

    const withUrl = buildViewModel(input({ link: 'unpaired', pairUrl: url }));
    expect(withUrl.pairing).toEqual({ paired: false, url, note: null });
    expect(pairingLines(withUrl.pairing)).toHaveLength(2);

    const without = buildViewModel(input({ link: 'unpaired', pairUrl: null }));
    expect(without.pairing).toEqual({ paired: false, url: null, note: null });
    expect(pairingLines(without.pairing)[0]).toBe(PAIRING_NO_ADDRESS);
    expect(PAIRING_NO_ADDRESS).toBe('Адресу сервера не налаштовано');

    expect(buildViewModel(input({ link: 'ok', pairUrl: url })).pairing).toEqual({ paired: true, url: null, note: null });
  });

  test('a wrong head-unit clock is shown at once: on the pairing panel in place of its instructions, and on the assistant tab', () => {
    expect(TEXT_CLOCK).toBe('Годинник головного блока неправильний');
    const url = 'https://example.invalid/pair#d=dev_0123456789abcdef&s=' + 'S'.repeat(43);

    // unpaired: the QR code stays (the phone can still register the car), the line replaces the instructions
    const unpaired = buildViewModel(input({ link: 'unpaired', pairUrl: url, clockWrong: true }));
    expect(unpaired.pairing).toEqual({ paired: false, url, note: TEXT_CLOCK });
    expect(pairingLines(unpaired.pairing)).toEqual([TEXT_CLOCK]);
    expect(pairingLines(buildViewModel(input({ link: 'unpaired', pairUrl: url })).pairing)).toEqual(PAIRING_LINES.slice());
    // the signature (what the tab draws) changes with it, so the page is redrawn
    expect(unpaired.signature).not.toBe(buildViewModel(input({ link: 'unpaired', pairUrl: url })).signature);

    // paired: the answer area says it without a question being asked; the last answer gives way to it
    const turn: DialogTurn = { id: 't', at: NOW, question: 'Q', answer: 'A', style: 'full', source: 'car', model: 'm', snapshotAt: null };
    const paired = buildViewModel(input({ link: 'clock', clockWrong: true, lastTurn: turn }));
    expect(paired.assistant).toMatchObject({ error: TEXT_CLOCK, question: null, answer: null });
    expect(paired.pairing.note).toBeNull();
    expect(paired.status).toMatchObject({ network: false, claude: false });
    // a question's own error and a pending question come first
    expect(buildViewModel(input({ link: 'clock', clockWrong: true, error: 'Сервер відхилив запит' })).assistant.error).toBe('Сервер відхилив запит');
    expect(buildViewModel(input({ link: 'clock', clockWrong: true, pending: true })).assistant).toMatchObject({ error: null, pending: true });
    // without it, nothing changes
    expect(buildViewModel(input({ lastTurn: turn })).assistant).toMatchObject({ error: null, answer: 'A' });
  });
});

describe('text and QR', () => {
  test('typographic apostrophes become \' and a character no atlas has becomes □', () => {
    const has = (cp: number) => cp < 0x2000 || cp === 0x25a1;
    expect(fitText('Пам’ять памʼять', has)).toBe('Пам\'ять пам\'ять');
    expect(fitText('Тиск 🛞 низький', has)).toBe('Тиск □ низький');
    expect(fitText('', has)).toBe('');
  });

  test('encodeQr of a 200-character URL returns a square matrix', () => {
    const url = 'https://example.invalid/pair#d=' + 'd'.repeat(40) + '&s=' + 's'.repeat(200 - 74);
    expect(url).toHaveLength(200);
    const m = encodeQr(url);
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.length).toBeLessThanOrEqual(177);
    for (const row of m) expect(row).toHaveLength(m.length);
    // the finder pattern's dark corner
    expect(m[0][0]).toBe(true);
    expect(m[0][6]).toBe(true);
    expect(m[1][1]).toBe(false);
  });
});
