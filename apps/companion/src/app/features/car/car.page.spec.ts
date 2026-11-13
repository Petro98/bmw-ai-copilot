import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AlertEvent } from '@copilot/event-engine';
import { SCENARIOS } from '@copilot/vehicle-core';
import type { ScenarioId, VehicleSnapshot } from '@copilot/vehicle-core';
import { LiveService } from '../../core/live.service';
import { CarPage } from './car.page';

const NOW = new Date(2026, 10, 13, 12, 41).getTime();

function scenario(id: ScenarioId): VehicleSnapshot {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found.build(0, NOW);
}

function alert(id: string, overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id, ruleId: 'check-control', dedupKey: `cc:${id}`, provenance: 'bmw-check-control', severity: 'warning',
    title: `Повідомлення ${id}`, detail: null, at: NOW - 5 * 60_000, active: true, clearedAt: null, ...overrides,
  };
}

describe('CarPage', () => {
  let live: { snapshot: ReturnType<typeof signal<VehicleSnapshot | null>>; alerts: ReturnType<typeof signal<AlertEvent[]>> };

  async function render(): Promise<{ el: HTMLElement; update: () => Promise<void> }> {
    await TestBed.configureTestingModule({
      imports: [CarPage],
      providers: [{ provide: LiveService, useValue: live }],
    }).compileComponents();
    const fixture = TestBed.createComponent(CarPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const update = async () => { fixture.detectChanges(); await fixture.whenStable(); };
    return { el: fixture.nativeElement as HTMLElement, update };
  }

  beforeEach(() => {
    live = { snapshot: signal<VehicleSnapshot | null>(null), alerts: signal<AlertEvent[]>([]) };
  });

  it('renders every tile as unavailable for the signals-missing snapshot without errors', async () => {
    live.snapshot.set(scenario('signals-missing'));
    const { el } = await render();
    const tiles = Array.from(el.querySelectorAll('app-reading-tile'));
    expect(tiles.map((t) => t.querySelector('[data-label]')?.textContent?.trim())).toEqual([
      'МАСЛО', 'ОХОЛОДЖ. РІДИНА', 'АКУМУЛЯТОР 12 В', 'ПАЛЬНЕ', 'ЗАПАС ХОДУ',
      'ШИНА ПЕРЕДНЯ ЛІВА', 'ШИНА ПЕРЕДНЯ ПРАВА', 'ШИНА ЗАДНЯ ЛІВА', 'ШИНА ЗАДНЯ ПРАВА',
    ]);
    for (const tile of tiles) {
      expect(tile.classList).toContain('unavailable');
      expect(tile.querySelector('[data-value]')?.textContent?.trim()).toBe('Недоступно');
      expect(tile.querySelector('[data-note]')?.textContent?.trim()).toMatch(/^\p{Lu}.+\.$/u);
    }
    expect(el.querySelector('[data-empty]')?.textContent?.trim()).toBe('Сповіщень немає');
  });

  it('keeps every tile, unavailable, before the first snapshot arrives', async () => {
    const { el } = await render();
    const tiles = Array.from(el.querySelectorAll('app-reading-tile'));
    expect(tiles.length).toBe(9);
    expect(tiles.every((t) => t.classList.contains('unavailable'))).toBe(true);
  });

  it('shows the readings with units, tyre targets and the time of the snapshot', async () => {
    live.snapshot.set(scenario('steady-cruise'));
    const { el } = await render();
    const tiles = Array.from(el.querySelectorAll('app-reading-tile'));
    expect(tiles.every((t) => !t.classList.contains('unavailable'))).toBe(true);
    const oil = tiles[0].querySelector('[data-value]')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(oil).toMatch(/^\d+ °C$/);
    const tyre = tiles[7].querySelector('[data-value]')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(tyre).toMatch(/^\d,\d бар · ціль \d,\d$/);
    expect(el.textContent).toContain('ОНОВЛЕНО О 12:41');
  });

  it('lists the alerts with their tag line, and updates when one arrives', async () => {
    live.snapshot.set(scenario('steady-cruise'));
    const { el, update } = await render();
    expect(el.querySelectorAll('app-alert-row').length).toBe(0);
    live.alerts.set([alert('b', { severity: 'critical' }), alert('a', { provenance: 'owner-configured' })]);
    await update();
    const rows = Array.from(el.querySelectorAll('app-alert-row'));
    expect(rows.map((r) => r.querySelector('[data-title]')?.textContent?.trim())).toEqual(['Повідомлення b', 'Повідомлення a']);
    expect(rows[0].textContent).toContain('КРИТИЧНО');
    expect(rows[1].textContent).toContain('ВАШ ЛІМІТ');
    expect(el.querySelector('[data-empty]')).toBeNull();
  });
});
