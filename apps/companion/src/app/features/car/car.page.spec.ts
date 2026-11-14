import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AlertEvent } from '@copilot/event-engine';
import type { StatusDto } from '@copilot/shared';
import { SCENARIOS, available, emptySnapshot } from '@copilot/vehicle-core';
import type { ScenarioId, VehicleSnapshot } from '@copilot/vehicle-core';
import { CLOCK } from '../../core/clock';
import { LiveService } from '../../core/live.service';
import { CarPage } from './car.page';

const NOW = new Date(2026, 10, 13, 12, 41).getTime();
const MINUTE = 60_000;

function scenario(id: ScenarioId, at = NOW): VehicleSnapshot {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found.build(0, at);
}

/** A snapshot from the car (not the mock) with the oil reading `oilAgeMs` older than the snapshot. */
function carSnapshot(takenAt: number, oilAgeMs = 0): VehicleSnapshot {
  return { ...emptySnapshot(takenAt), oilTemp: available(92, '°C', 'passive-signal', takenAt - oilAgeMs) };
}

function alert(id: string, overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id, ruleId: 'check-control', dedupKey: `cc:${id}`, provenance: 'bmw-check-control', severity: 'warning',
    title: `Повідомлення ${id}`, detail: null, at: NOW - 5 * 60_000, active: true, clearedAt: null, ...overrides,
  };
}

function status(source: 'car' | 'mock', connected: boolean): StatusDto {
  return {
    version: '0.1.0',
    vehicle: { source, connected, lastSnapshotAt: connected ? NOW : null, scenario: source === 'mock' ? 'steady-cruise' : null },
    claude: { mode: 'live', model: 'claude-opus-5-5', voiceModel: 'claude-opus-5-5' },
    budget: { dayUsd: 0, dayLimitUsd: 1, monthUsd: 0, monthLimitUsd: 20 },
  };
}

describe('CarPage', () => {
  let live: {
    snapshot: ReturnType<typeof signal<VehicleSnapshot | null>>;
    alerts: ReturnType<typeof signal<AlertEvent[]>>;
    alertsLoaded: ReturnType<typeof signal<boolean>>;
    status: ReturnType<typeof signal<StatusDto | null>>;
    connected: ReturnType<typeof signal<boolean>>;
  };
  let clock: number;

  async function render(): Promise<{ el: HTMLElement; update: () => Promise<void> }> {
    await TestBed.configureTestingModule({
      imports: [CarPage],
      providers: [{ provide: LiveService, useValue: live }, { provide: CLOCK, useValue: () => clock }],
    }).compileComponents();
    const fixture = TestBed.createComponent(CarPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const update = async () => { fixture.detectChanges(); await fixture.whenStable(); };
    return { el: fixture.nativeElement as HTMLElement, update };
  }

  const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const heading = (el: HTMLElement) => text(el.querySelector('#car-now'));
  const notice = (el: HTMLElement) => text(el.querySelector('[data-data-note]'));
  const tiles = (el: HTMLElement) => Array.from(el.querySelectorAll('app-reading-tile'));

  beforeEach(() => {
    clock = NOW;
    live = {
      snapshot: signal<VehicleSnapshot | null>(null),
      alerts: signal<AlertEvent[]>([]),
      alertsLoaded: signal(true),
      status: signal<StatusDto | null>(status('car', true)),
      connected: signal(true),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders every tile as unavailable for the signals-missing snapshot without errors', async () => {
    live.snapshot.set(scenario('signals-missing'));
    const { el } = await render();
    expect(tiles(el).map((t) => t.querySelector('[data-label]')?.textContent?.trim())).toEqual([
      'МАСЛО', 'ОХОЛОДЖ. РІДИНА', 'АКУМУЛЯТОР 12 В', 'ПАЛЬНЕ', 'ЗАПАС ХОДУ',
      'ШИНА ПЕРЕДНЯ ЛІВА', 'ШИНА ПЕРЕДНЯ ПРАВА', 'ШИНА ЗАДНЯ ЛІВА', 'ШИНА ЗАДНЯ ПРАВА',
    ]);
    for (const tile of tiles(el)) {
      expect(tile.classList).toContain('unavailable');
      expect(tile.querySelector('[data-value]')?.textContent?.trim()).toBe('Недоступно');
      expect(tile.querySelector('[data-note]')?.textContent?.trim()).toMatch(/^\p{Lu}.+\.$/u);
    }
    expect(el.querySelector('[data-empty]')?.textContent?.trim()).toBe('Сповіщень немає');
  });

  it('before the first snapshot keeps every tile, unavailable, and says the data has not loaded and why', async () => {
    live.alertsLoaded.set(false);
    live.connected.set(false);
    live.status.set(null);
    const { el, update } = await render();
    expect(tiles(el).length).toBe(9);
    expect(tiles(el).every((t) => t.classList.contains('unavailable'))).toBe(true);
    for (const tile of tiles(el)) expect(text(tile.querySelector('[data-note]'))).toBe('Дані ще не отримано.');
    expect(el.textContent).not.toContain('Авто не надіслало це значення');
    expect(el.textContent).not.toContain('ЗАРАЗ');
    expect(notice(el)).toBe('Дані ще не отримано. Немає звʼязку із сервером.');
    expect(el.querySelector('[data-empty]')).toBeNull();
    expect(text(el.querySelector('[data-not-loaded]'))).toBe('Сповіщення ще не завантажено. Немає звʼязку із сервером.');

    // Connected but still loading: no reason is known yet.
    live.connected.set(true);
    await update();
    expect(notice(el)).toBe('Дані ще не отримано.');
    expect(text(el.querySelector('[data-not-loaded]'))).toBe('Сповіщення ще не завантажено.');

    live.alertsLoaded.set(true);
    await update();
    expect(el.querySelector('[data-not-loaded]')).toBeNull();
    expect(text(el.querySelector('[data-empty]'))).toBe('Сповіщень немає');
  });

  it('shows the readings with units, tyre targets and the time of a live snapshot under «ЗАРАЗ»', async () => {
    live.status.set(status('car', true));
    live.snapshot.set(scenario('steady-cruise'));
    const { el } = await render();
    expect(tiles(el).every((t) => !t.classList.contains('unavailable'))).toBe(true);
    const oil = tiles(el)[0].querySelector('[data-value]')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(oil).toMatch(/^\d+ °C$/);
    const tyre = tiles(el)[7].querySelector('[data-value]')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(tyre).toMatch(/^\d,\d бар · ціль \d,\d$/);
    expect(heading(el)).toBe('ЗАРАЗ · ОНОВЛЕНО О 12:41');
    expect(el.querySelector('[data-data-note]')).toBeNull();
  });

  it('a live car keeps its notes against the snapshot time, so a phone clock that differs does not age fresh values', async () => {
    live.snapshot.set(carSnapshot(NOW, 20_000));
    clock = NOW + 90_000;
    const { el } = await render();
    expect(heading(el)).toBe('ЗАРАЗ · ОНОВЛЕНО О 12:41');
    expect(tiles(el)[0].querySelector('[data-note]')).toBeNull();
  });

  it('a quiet car: «ОСТАННІ ДАНІ» with the date, the reason, and readings that show their age', async () => {
    const takenAt = new Date(2026, 10, 10, 18, 42).getTime();
    clock = new Date(2026, 10, 13, 9, 0).getTime();
    live.status.set(status('car', false));
    live.snapshot.set(carSnapshot(takenAt, 20_000));
    const { el } = await render();
    expect(heading(el)).toBe('ОСТАННІ ДАНІ · ОНОВЛЕНО 10 ЛИСТОПАДА О 18:42');
    expect(el.textContent).not.toContain('ЗАРАЗ');
    expect(notice(el)).toBe('Авто не на звʼязку. Показано останні дані, які воно надіслало.');
    expect(text(tiles(el)[0].querySelector('[data-note]'))).toBe('2 дн тому');
  });

  it('a quiet car since yesterday says «ВЧОРА», and its notes keep ageing as time passes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const takenAt = new Date(2026, 10, 12, 22, 30).getTime();
    clock = new Date(2026, 10, 13, 0, 0).getTime();
    live.status.set(status('car', false));
    live.snapshot.set(carSnapshot(takenAt));
    const { el, update } = await render();
    expect(heading(el)).toBe('ОСТАННІ ДАНІ · ОНОВЛЕНО ВЧОРА О 22:30');
    expect(text(tiles(el)[0].querySelector('[data-note]'))).toBe('1 год тому');

    clock += 60 * MINUTE;
    vi.advanceTimersByTime(60 * MINUTE);
    await update();
    expect(text(tiles(el)[0].querySelector('[data-note]'))).toBe('2 год тому');
  });

  it('old data is not «ЗАРАЗ» even while the backend still calls the car connected', async () => {
    live.snapshot.set(carSnapshot(NOW));
    clock = NOW + 10 * MINUTE;
    const { el } = await render();
    expect(heading(el)).toBe('ОСТАННІ ДАНІ · ОНОВЛЕНО О 12:41');
    expect(notice(el)).toBe('Авто давно не оновлювало дані.');
    expect(text(tiles(el)[0].querySelector('[data-note]'))).toBe('10 хв тому');
  });

  it('with the stream down the last data stays under «ОСТАННІ ДАНІ» with the reason', async () => {
    live.snapshot.set(carSnapshot(NOW));
    live.connected.set(false);
    const { el } = await render();
    expect(heading(el)).toBe('ОСТАННІ ДАНІ · ОНОВЛЕНО О 12:41');
    expect(notice(el)).toBe('Немає звʼязку із сервером. Показано останні отримані дані.');
  });

  it('gives no time for a snapshot in which the car has reported nothing yet', async () => {
    live.status.set(status('car', false));
    live.snapshot.set(emptySnapshot(NOW));
    const { el } = await render();
    expect(heading(el)).toBe('ОСТАННІ ДАНІ');
    expect(text(tiles(el)[0].querySelector('[data-note]'))).toBe('Авто не надіслало це значення.');
  });

  it('heads demo data «ДЕМО-ДАНІ», never «ЗАРАЗ»', async () => {
    live.status.set(status('mock', true));
    live.snapshot.set(scenario('steady-cruise'));
    const { el } = await render();
    expect(heading(el)).toBe('ДЕМО-ДАНІ · ОНОВЛЕНО О 12:41');
    expect(el.textContent).not.toContain('ЗАРАЗ');
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

  it('lists active alerts first, and a cleared one says «ЗНЯТО»', async () => {
    live.snapshot.set(scenario('steady-cruise'));
    // Newest first, as LiveService keeps them: the cleared one was raised later than the active one.
    live.alerts.set([
      alert('cleared', { at: NOW - MINUTE, active: false, clearedAt: NOW - 30_000 }),
      alert('active', { at: NOW - 10 * MINUTE }),
    ]);
    const { el, update } = await render();
    let rows = Array.from(el.querySelectorAll('app-alert-row'));
    expect(rows.map((r) => r.querySelector('[data-title]')?.textContent?.trim())).toEqual(['Повідомлення active', 'Повідомлення cleared']);
    expect(text(rows[1].querySelector('[data-tags]'))).toContain('ЗНЯТО О 12:40');

    // The same id arriving again with active: false moves it down and marks it.
    live.alerts.set([
      alert('cleared', { at: NOW - MINUTE, active: false, clearedAt: NOW - 30_000 }),
      alert('active', { at: NOW - 10 * MINUTE, active: false, clearedAt: NOW }),
    ]);
    await update();
    rows = Array.from(el.querySelectorAll('app-alert-row'));
    expect(rows.every((r) => r.getAttribute('data-active') === 'false')).toBe(true);
  });
});
