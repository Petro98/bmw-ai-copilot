import { TestBed } from '@angular/core/testing';
import type { AlertEvent } from '@copilot/event-engine';
import { AlertRow, eventTime } from './alert-row';

const NOW = new Date(2026, 10, 13, 12, 41).getTime();

function alert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'a1', ruleId: 'check-control', dedupKey: 'cc:1', provenance: 'bmw-check-control', severity: 'warning',
    title: 'Тиск у шинах: задня ліва', detail: null, at: new Date(2026, 10, 13, 12, 36).getTime(),
    active: true, clearedAt: null, ...overrides,
  };
}

async function render(event: AlertEvent): Promise<HTMLElement> {
  await TestBed.configureTestingModule({ imports: [AlertRow] }).compileComponents();
  const fixture = TestBed.createComponent(AlertRow);
  fixture.componentRef.setInput('alert', event);
  fixture.componentRef.setInput('now', NOW);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

function tagLine(el: HTMLElement): string {
  return el.querySelector('[data-tags]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('AlertRow', () => {
  it('an alert row shows a word and an icon for severity, not colour alone', async () => {
    const el = await render(alert());
    expect(el.textContent).toContain('ПОПЕРЕДЖЕННЯ');
    expect(el.textContent).toContain('BMW CHECK CONTROL');
    expect(el.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(el.querySelector('svg[data-shape="triangle"]')).not.toBeNull();
    expect(el.querySelector('[data-title]')?.textContent?.trim()).toBe('Тиск у шинах: задня ліва');
    expect(tagLine(el)).toBe('ПОПЕРЕДЖЕННЯ · BMW CHECK CONTROL · 12:36');
  });

  it('draws critical as an octagon and info as a circle, each with its word', async () => {
    const critical = await render(alert({ severity: 'critical' }));
    expect(critical.querySelector('svg[data-shape="octagon"][aria-hidden="true"]')).not.toBeNull();
    expect(tagLine(critical)).toBe('КРИТИЧНО · BMW CHECK CONTROL · 12:36');

    TestBed.resetTestingModule();
    const info = await render(alert({ severity: 'info', provenance: 'bmw-service', at: new Date(2026, 10, 12, 9, 0).getTime() }));
    expect(info.querySelector('svg[data-shape="circle"][aria-hidden="true"]')).not.toBeNull();
    expect(tagLine(info)).toBe('ДО ВІДОМА · СЕРВІС BMW · ВЧОРА');
  });

  it('names the owner\'s limit as the owner\'s', async () => {
    const el = await render(alert({ provenance: 'owner-configured', at: new Date(2026, 10, 9, 18, 5).getTime() }));
    expect(tagLine(el)).toBe('ПОПЕРЕДЖЕННЯ · ВАШ ЛІМІТ · 9 ЛИСТОПАДА');
  });

  it('formats event times as a clock time today, «ВЧОРА», or a date', () => {
    expect(eventTime(new Date(2026, 10, 13, 0, 5).getTime(), NOW)).toBe('00:05');
    expect(eventTime(new Date(2026, 10, 12, 23, 59).getTime(), NOW)).toBe('ВЧОРА');
    expect(eventTime(new Date(2026, 0, 2, 8, 0).getTime(), NOW)).toBe('2 СІЧНЯ');
    // An event "in the future" (head-unit clock ahead of the phone) still shows a plain time, never throws.
    expect(eventTime(new Date(2026, 10, 13, 15, 0).getTime(), NOW)).toBe('15:00');
  });
});
