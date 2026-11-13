/**
 * Preview-only bundle entry: the head-unit screens (car/src/ui/screen.ts) drawn from a fixed fixture by the
 * kit's offline preview (car/kit/tools/preview.js against its stubbed head unit), never shipped. Built to
 * car/build/preview-entry.js (git-ignored) by car/scripts/build-car.mjs; car/scripts/preview-car.sh puts it in
 * place of the staged app's javascript/app.js and presses these stand-in components between frames:
 *
 *   PREVIEW_STANDING  assistant tab, the car standing, a full answer
 *   PREVIEW_MOVING    assistant tab, the car moving, a spoken answer
 *   PREVIEW_SENSORS   sensors tab (one reading unavailable: intake, diagnostics disabled)
 *   PREVIEW_ALERTS    alerts tab (active and cleared alerts, one title with a character no atlas has)
 *   PREVIEW_PAIRING   assistant tab before pairing (a QR code of an https://example.invalid address)
 *
 * The fixture is made up for the preview: no real car, device, address or secret.
 */
import { available, emptySnapshot, unavailable, type VehicleSnapshot } from '@copilot/vehicle-core';
import type { AlertEvent } from '@copilot/event-engine';
import type { DialogTurn } from '@copilot/shared';
import type { KitContext, KitMgu } from './kit/kit';
import { safe } from './safe';
import type { FrameFn } from './ui/draw-header';
import { startScreen, type ScreenInput } from './ui/screen';
import { pairingUrl, type Tab } from './ui/view-model';

/* eslint-disable @typescript-eslint/no-require-imports */
const mgu = require('./kit/mgu') as KitMgu;
const fonts = require('./kit/fonts') as { has(cp: number): boolean };
const gauges = require('./kit/gauges') as { frame: FrameFn };
/* eslint-enable @typescript-eslint/no-require-imports */

/** 2026-11-13 12:41 on the head unit's clock. */
const NOW = new Date(2026, 10, 13, 12, 41, 0).getTime();
const SEC = 1000;

function snapshot(moving: boolean): VehicleSnapshot {
  const s = emptySnapshot(NOW);
  s.condition = available(moving ? 'driving' : 'living', null, 'passive-signal', NOW - 2 * SEC);
  s.speed = available(moving ? 87 : 0, 'km/h', 'passive-signal', NOW);
  s.engineRpm = available(moving ? 2350 : 1850, 'rpm', 'passive-signal', NOW);
  s.oilTemp = available(92, '°C', 'passive-signal', NOW - 4 * SEC);
  s.coolantTemp = available(88, '°C', 'passive-signal', NOW - 4 * SEC);
  s.gear = available('D4', null, 'passive-signal', NOW);
  s.driveMode = available('Comfort', null, 'passive-signal', NOW);
  s.fuelLevel = available(41, 'l', 'polled-signal', NOW - 9 * SEC);
  s.range = available(452, 'km', 'polled-signal', NOW - 9 * SEC);
  s.battery12vCharge = available(84, '%', 'passive-signal', NOW - 9 * SEC);
  const bar = (v: number) => available(v, 'bar', 'polled-signal', NOW - 10 * SEC);
  s.tyrePressure = { frontLeft: bar(2.3), frontRight: bar(2.3), rearLeft: bar(2.0), rearRight: bar(2.4) };
  s.tyrePressureTarget = { frontLeft: bar(2.3), frontRight: bar(2.3), rearLeft: bar(2.4), rearRight: bar(2.4) };
  s.intakeTemp = unavailable('diagnostics-disabled');
  return s;
}

const at = (h: number, m: number, dayOffset = 0) => new Date(2026, 10, 13 + dayOffset, h, m).getTime();

function alert(id: string, over: Partial<AlertEvent>): AlertEvent {
  return {
    id, ruleId: 'preview', dedupKey: id, provenance: 'bmw-check-control', severity: 'warning', title: '',
    detail: null, at: at(12, 36), active: true, clearedAt: null, ...over,
  };
}

const ALERTS: AlertEvent[] = [
  alert('cc', { title: 'Тиск у шинах: задня ліва' }),
  alert('fault', { provenance: 'bmw-fault-status', severity: 'critical', title: 'Помилка в пам\'яті блока двигуна', at: at(12, 30) }),
  alert('limit', { provenance: 'owner-configured', title: 'Масло 118 °C — вище вашого ліміту 115 °C', at: at(9, 5), active: false, clearedAt: at(9, 20) }),
  alert('service', { provenance: 'bmw-service', severity: 'info', title: 'Гальмівна рідина: заміна через 3 місяці ⚙', at: at(8, 0, -1) }),
];

const STANDING_TURN: DialogTurn = {
  id: 'preview-1', at: NOW - 20 * SEC, question: 'Як зараз почувається моя машина?',
  answer: 'Двигун прогрітий: масло 92 °C, охолоджувальна рідина 88 °C. Активних повідомлень Check Control немає. '
    + 'Акумулятор 12 В заряджений на 84 %. Тиск у задній лівій шині 2,0 бар, нижче цілі авто 2,4 бар; інші три '
    + 'відповідають цілі. Найближчий сервіс за даними авто — гальмівна рідина, через 3 місяці.',
  style: 'full', source: 'car', model: 'preview', snapshotAt: NOW - 25 * SEC,
};

const MOVING_TURN: DialogTurn = {
  id: 'preview-2', at: NOW - 10 * SEC, question: 'Чи можна вже навантажувати двигун?',
  answer: 'Масло 92 °C, охолоджувальна рідина 88 °C — двигун прогрітий. Це звичайна робоча температура за '
    + 'загальною практикою, не ліміт BMW.',
  style: 'spoken', source: 'car', model: 'preview', snapshotAt: NOW - 12 * SEC,
};

const PAIR_URL = pairingUrl('https://example.invalid', { id: 'preview-device-0001', secret: 'preview-secret-not-real-000000000000' });

interface Step { tab: Tab; input: ScreenInput }

const base: ScreenInput = {
  snapshot: snapshot(false), alerts: ALERTS, lastTurn: STANDING_TURN, pending: false, error: null, link: 'ok', pairUrl: null,
};

const STEPS: Record<string, Step> = {
  PREVIEW_STANDING: { tab: 'assistant', input: base },
  PREVIEW_MOVING: { tab: 'assistant', input: { ...base, snapshot: snapshot(true), lastTurn: MOVING_TURN } },
  PREVIEW_SENSORS: { tab: 'sensors', input: base },
  PREVIEW_ALERTS: { tab: 'alerts', input: base },
  PREVIEW_PAIRING: { tab: 'assistant', input: { ...base, link: 'unpaired', lastTurn: null, pairUrl: PAIR_URL } },
};

const app = {
  start(ctx: KitContext): void {
    let step: Step = STEPS.PREVIEW_STANDING;
    const screen = startScreen({
      ctx,
      clock: { now: () => NOW },
      log: ctx.log,
      input: () => step.input,
      onChip: () => undefined,
      has: (cp) => fonts.has(cp),
      frame: gauges.frame,
      tab: step.tab,
      // the stub draws one PNG per step on demand and the fixture's clock stands still: no software-path pacing
      softFrameMs: 0,
    });
    for (const name of Object.keys(STEPS)) {
      ctx.ui.onClick(name, () => {
        step = STEPS[name];
        screen.show(step.tab);
      });
    }
  },
};

safe(mgu.log, 'preview', () => mgu.run(app))();
