import { Component, computed, inject } from '@angular/core';
import type { AlertEvent } from '@copilot/event-engine';
import type { Reading, TyreSet, Unavailable, VehicleSnapshot } from '@copilot/vehicle-core';
import { currentTime } from '../../core/clock';
import { LiveService } from '../../core/live.service';
import { CURRENT_FOR_MS, DEMO_LABEL, isDemo } from '../../core/vehicle-state';
import { AlertRow, clockTime, dateText, dayOf } from '../../shared/alert-row/alert-row';
import { ReadingTile } from '../../shared/reading-tile/reading-tile';

export interface TileView { label: string; reading: Reading<number | string>; target: Reading<number> | null }

/** Before the first snapshot nothing has been reported; every tile stays, unavailable. */
const NOT_REPORTED: Unavailable = { available: false, reason: 'not-reported' };

/** Age notes and the heading follow the phone's clock at this pace (notes are in minutes). */
const CLOCK_EVERY_MS = 30_000;

// Ukrainian, sentence case (docs/design/README.md → Content). The heading words are labels, upper case.
export const CAR_TEXT = {
  now: 'ЗАРАЗ',
  last: 'ОСТАННІ ДАНІ',
  notLoaded: 'Дані ще не отримано.',
  alertsNotLoaded: 'Сповіщення ще не завантажено.',
  noServer: 'Немає звʼязку із сервером.',
  noServerLast: 'Немає звʼязку із сервером. Показано останні отримані дані.',
  carQuiet: 'Авто не на звʼязку. Показано останні дані, які воно надіслало.',
  carOld: 'Авто давно не оновлювало дані.',
} as const;

/** «ОНОВЛЕНО О 18:42», «ОНОВЛЕНО ВЧОРА О 18:42», «ОНОВЛЕНО 10 ЛИСТОПАДА О 18:42» (local time, seen from `now`). */
export function updatedText(at: number, now: number): string {
  const day = dayOf(at, now);
  const prefix = day === 'today' ? '' : day === 'yesterday' ? 'ВЧОРА ' : `${dateText(at)} `;
  return `ОНОВЛЕНО ${prefix}О ${clockTime(at)}`;
}

/** True when the car reported at least one value; a snapshot of only "not reported" readings has no real time. */
function hasReports(snapshot: VehicleSnapshot): boolean {
  return Object.entries(snapshot).some(([key, value]) => {
    if (key === 'takenAt' || !value || typeof value !== 'object') return false;
    const readings = 'available' in value ? [value as Reading<unknown>] : Object.values(value as Record<string, Reading<unknown>>);
    return readings.some((r) => r.available || r.reason !== 'not-reported');
  });
}

/** Active alerts first; within each group the list's own order (newest first). */
export function activeFirst(alerts: readonly AlertEvent[]): AlertEvent[] {
  return [...alerts.filter((a) => a.active), ...alerts.filter((a) => !a.active)];
}

const TYRES: ReadonlyArray<{ key: keyof TyreSet<unknown>; label: string }> = [
  { key: 'frontLeft', label: 'ШИНА ПЕРЕДНЯ ЛІВА' },
  { key: 'frontRight', label: 'ШИНА ПЕРЕДНЯ ПРАВА' },
  { key: 'rearLeft', label: 'ШИНА ЗАДНЯ ЛІВА' },
  { key: 'rearRight', label: 'ШИНА ЗАДНЯ ПРАВА' },
];

/** The tiles of the car screen, in the mockup's order (docs/design/mockups/PhoneCar.dc.html). */
export function carTiles(snapshot: VehicleSnapshot | null): TileView[] {
  const pick = (reading: Reading<number> | undefined): Reading<number> => reading ?? NOT_REPORTED;
  return [
    { label: 'МАСЛО', reading: pick(snapshot?.oilTemp), target: null },
    { label: 'ОХОЛОДЖ. РІДИНА', reading: pick(snapshot?.coolantTemp), target: null },
    { label: 'АКУМУЛЯТОР 12 В', reading: pick(snapshot?.battery12vCharge), target: null },
    { label: 'ПАЛЬНЕ', reading: pick(snapshot?.fuelLevel), target: null },
    { label: 'ЗАПАС ХОДУ', reading: pick(snapshot?.range), target: null },
    ...TYRES.map(({ key, label }) => ({
      label,
      reading: pick(snapshot?.tyrePressure?.[key]),
      target: pick(snapshot?.tyrePressureTarget?.[key]),
    })),
  ];
}

/** Car state: reading tiles and the alert list. */
@Component({
  selector: 'app-car-page',
  imports: [ReadingTile, AlertRow],
  templateUrl: './car.page.html',
  styleUrl: './car.page.css',
})
export class CarPage {
  private readonly live = inject(LiveService);

  protected readonly snapshot = this.live.snapshot;
  protected readonly alerts = computed(() => activeFirst(this.live.alerts()));
  protected readonly alertsLoaded = this.live.alertsLoaded;
  protected readonly tiles = computed(() => carTiles(this.snapshot()));
  /** The phone's clock, moving on by itself so that data which stopped arriving visibly ages. */
  protected readonly clock = currentTime(CLOCK_EVERY_MS);
  protected readonly demo = computed(() => isDemo(this.live.status()));
  private readonly vehicleConnected = computed(() => this.live.status()?.vehicle.connected === true);

  /**
   * The snapshot is "now" only while the stream is open, the backend reports the car connected, and the snapshot is
   * no older than CURRENT_FOR_MS by the phone's clock.
   */
  protected readonly current = computed(() => {
    const snapshot = this.snapshot();
    return snapshot !== null && this.live.connected() && this.vehicleConnected()
      && this.clock() - snapshot.takenAt <= CURRENT_FOR_MS;
  });

  /**
   * What age notes are measured against. While current: the snapshot's own time, stamped by the same (head-unit)
   * clock as its readings, so a phone clock that differs from the car's does not make fresh values look old. Once
   * not current: the phone's clock (never earlier than the snapshot), so the readings of a quiet car age.
   */
  protected readonly now = computed(() => {
    const snapshot = this.snapshot();
    if (!snapshot) return this.clock();
    return this.current() ? snapshot.takenAt : Math.max(snapshot.takenAt, this.clock());
  });

  /** «ЗАРАЗ · ОНОВЛЕНО О 12:41», «ОСТАННІ ДАНІ · ОНОВЛЕНО ВЧОРА О 18:42», «ДЕМО-ДАНІ · …» (docs/design/mockups/PhoneCar.dc.html). */
  protected readonly heading = computed(() => {
    const word = this.demo() ? DEMO_LABEL : this.current() ? CAR_TEXT.now : CAR_TEXT.last;
    const snapshot = this.snapshot();
    if (!snapshot || !hasReports(snapshot)) return word;
    return `${word} · ${updatedText(snapshot.takenAt, Math.max(snapshot.takenAt, this.clock()))}`;
  });

  /** One line under the heading saying why the data is not current, when the reason is known. */
  protected readonly dataNote = computed(() => {
    if (!this.snapshot()) return this.live.connected() ? CAR_TEXT.notLoaded : `${CAR_TEXT.notLoaded} ${CAR_TEXT.noServer}`;
    if (this.current()) return null;
    if (!this.live.connected()) return CAR_TEXT.noServerLast;
    const status = this.live.status();
    if (!status) return null;
    if (!status.vehicle.connected) return CAR_TEXT.carQuiet;
    return CAR_TEXT.carOld;
  });

  /** Before the first snapshot the tiles say the data has not arrived, not that the car did not send it. */
  protected readonly tileNote = computed(() => (this.snapshot() ? null : CAR_TEXT.notLoaded));

  protected readonly alertsNote = computed(() =>
    (this.live.connected() ? CAR_TEXT.alertsNotLoaded : `${CAR_TEXT.alertsNotLoaded} ${CAR_TEXT.noServer}`));
}
