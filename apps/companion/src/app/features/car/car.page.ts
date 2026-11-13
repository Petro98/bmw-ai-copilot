import { Component, computed, inject } from '@angular/core';
import type { Reading, TyreSet, Unavailable, VehicleSnapshot } from '@copilot/vehicle-core';
import { LiveService } from '../../core/live.service';
import { AlertRow, eventTime } from '../../shared/alert-row/alert-row';
import { ReadingTile } from '../../shared/reading-tile/reading-tile';

export interface TileView { label: string; reading: Reading<number | string>; target: Reading<number> | null }

/** Before the first snapshot nothing has been reported; every tile stays, unavailable. */
const NOT_REPORTED: Unavailable = { available: false, reason: 'not-reported' };

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
  protected readonly alerts = this.live.alerts;
  protected readonly tiles = computed(() => carTiles(this.snapshot()));
  /**
   * Age notes compare a reading with the snapshot it came in, both stamped by the same (head-unit) clock,
   * so a phone clock that differs from the car's does not make fresh values look old.
   */
  protected readonly now = computed(() => this.snapshot()?.takenAt ?? 0);
  protected readonly updatedAt = computed(() => {
    const snapshot = this.snapshot();
    return snapshot ? eventTime(snapshot.takenAt, snapshot.takenAt) : null;
  });
}
