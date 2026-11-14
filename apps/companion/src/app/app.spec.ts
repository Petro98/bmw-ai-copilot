import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { StatusDto } from '@copilot/shared';
import { App } from './app';
import { routes } from './app.routes';
import { LiveService } from './core/live.service';

const STATUS: StatusDto = {
  version: '0.1.0',
  vehicle: { source: 'car', connected: true, lastSnapshotAt: 1, scenario: null },
  claude: { mode: 'live', model: 'claude-opus-5-5', voiceModel: 'claude-opus-5-5' },
  budget: { dayUsd: 0, dayLimitUsd: 1, monthUsd: 0, monthLimitUsd: 20 },
};

describe('App shell', () => {
  let live: { status: ReturnType<typeof signal<StatusDto | null>>; connected: ReturnType<typeof signal<boolean>>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    live = { status: signal<StatusDto | null>(null), connected: signal(false), connect: vi.fn(), disconnect: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes), { provide: LiveService, useValue: live }],
    }).compileComponents();
  });

  it('connects the live stream and shows the three sections in the bottom navigation', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(live.connect).toHaveBeenCalled();
    const links = Array.from(el.querySelectorAll('nav a')).map((a) => [a.textContent?.trim(), a.getAttribute('href')]);
    expect(links).toEqual([['Голос', '/'], ['Авто', '/car'], ['Налаштування', '/settings']]);
    expect(el.querySelector('header')?.textContent).toContain('Copilot');
  });

  it('shows the status marks with a dash until the car and Claude are connected, then a check', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const marks = () => Array.from(el.querySelectorAll('[data-mark]')).map((m) => [m.getAttribute('data-mark'), m.getAttribute('data-state'), m.textContent?.replace(/\s+/g, ' ').trim()]);
    expect(marks()).toEqual([['vehicle', 'off', 'АВТО не підʼєднано'], ['claude', 'off', 'CLAUDE не підʼєднано']]);

    live.connected.set(true);
    live.status.set(STATUS);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(marks()).toEqual([['vehicle', 'on', 'АВТО підʼєднано'], ['claude', 'on', 'CLAUDE підʼєднано']]);
    expect(el.querySelectorAll('[data-mark] svg[aria-hidden="true"]').length).toBe(2);
    expect(el.querySelectorAll('app-status-mark').length).toBe(2);
    expect(el.querySelector('[data-demo]')).toBeNull();
  });

  it('with the mock vehicle source shows a persistent «ДЕМО-ДАНІ» mark and never a connected car', async () => {
    const fixture = TestBed.createComponent(App);
    live.connected.set(true);
    live.status.set({ ...STATUS, vehicle: { source: 'mock', connected: true, lastSnapshotAt: 1, scenario: 'steady-cruise' } });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const vehicle = el.querySelector('[data-mark="vehicle"]');
    expect(vehicle?.getAttribute('data-state')).toBe('demo');
    expect(vehicle?.textContent?.replace(/\s+/g, ' ').trim()).toBe('АВТО демо-дані, авто не підʼєднано');
    expect(vehicle?.querySelector('svg path')?.getAttribute('d')).toBe('M6 12h12');
    const demo = el.querySelector('[data-demo]');
    expect(demo?.textContent?.replace(/\s+/g, ' ').trim())
      .toBe('ДЕМО-ДАНІ Імітовані показники і сповіщення, а не дані вашого авто.');

    // It stays while the stream is down: the last status still says the source is mock.
    live.connected.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(el.querySelector('[data-demo]')).not.toBeNull();
  });

  it('names the screen in the page\'s one level-1 heading', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const headings = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('h1'));
    expect(headings.map((h) => h.textContent?.trim())).toEqual(['Copilot']);
  });

  it('marks the active tab by weight and a bar as well as by colour', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const [voice, car] = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('nav a'));
    voice.classList.add('active');            // what routerLinkActive sets on the current section
    const active = getComputedStyle(voice);
    const other = getComputedStyle(car);
    expect(active.fontWeight).toBe('700');
    expect(other.fontWeight).toBe('500');
    expect(active.borderTopWidth).toBe('2px');
    expect(other.borderTopWidth).toBe('2px');  // the same box, so the label does not move
    expect(active.borderTopColor).not.toBe(other.borderTopColor);
  });
});
