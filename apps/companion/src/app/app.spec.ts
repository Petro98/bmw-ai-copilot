import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { StatusDto } from '@copilot/shared';
import { App } from './app';
import { routes } from './app.routes';
import { LiveService } from './core/live.service';

const STATUS: StatusDto = {
  version: '0.1.0',
  vehicle: { source: 'mock', connected: true, lastSnapshotAt: 1, scenario: 'steady-cruise' },
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
    expect(marks()).toEqual([['vehicle', 'off', 'АВТО не підключено'], ['claude', 'off', 'CLAUDE не підключено']]);

    live.connected.set(true);
    live.status.set(STATUS);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(marks()).toEqual([['vehicle', 'on', 'АВТО підключено'], ['claude', 'on', 'CLAUDE підключено']]);
    expect(el.querySelectorAll('[data-mark] svg[aria-hidden="true"]').length).toBe(2);
  });
});
