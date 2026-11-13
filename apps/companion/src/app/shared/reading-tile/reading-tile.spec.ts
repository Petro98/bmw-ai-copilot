import { TestBed } from '@angular/core/testing';
import { available, unavailable } from '@copilot/vehicle-core';
import type { Reading } from '@copilot/vehicle-core';
import { ReadingTile } from './reading-tile';

const NOW = 1_000_000;

async function render(inputs: { label: string; reading: Reading<number | string>; now: number; target?: Reading<number> | null }): Promise<HTMLElement> {
  await TestBed.configureTestingModule({ imports: [ReadingTile] }).compileComponents();
  const fixture = TestBed.createComponent(ReadingTile);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('ReadingTile', () => {
  it('shows «Недоступно» and the reason, with no number, for an unavailable reading', async () => {
    const el = await render({ label: 'МАСЛО', reading: unavailable('diagnostics-disabled'), now: NOW });
    expect(el.classList).toContain('unavailable');
    expect(el.querySelector('[data-value]')?.textContent?.trim()).toBe('Недоступно');
    expect(el.querySelector('[data-note]')?.textContent?.trim()).toBe('Потрібне діагностичне читання. Воно вимкнене в налаштуваннях.');
    expect(el.textContent).toContain('МАСЛО');
    expect(el.textContent).not.toMatch(/\d/);
  });

  it('shows the value with its unit and no note for a fresh reading', async () => {
    const el = await render({ label: 'МАСЛО', reading: available(92, '°C', 'mock', NOW), now: NOW });
    expect(el.classList).not.toContain('unavailable');
    expect(el.querySelector('[data-value]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('92 °C');
    expect(el.querySelector('[data-note]')).toBeNull();
  });

  it('adds the car\'s target after the unit of a tyre reading', async () => {
    const el = await render({
      label: 'ШИНА ЗАДНЯ ЛІВА', reading: available(2.0, 'bar', 'mock', NOW), now: NOW,
      target: available(2.4, 'bar', 'mock', NOW),
    });
    expect(el.querySelector('[data-value]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('2,0 бар · ціль 2,4');
  });

  it('leaves the target out when the car did not send one', async () => {
    const el = await render({
      label: 'ШИНА ЗАДНЯ ЛІВА', reading: available(2.0, 'bar', 'mock', NOW), now: NOW,
      target: unavailable('not-reported'),
    });
    expect(el.querySelector('[data-value]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('2,0 бар');
  });

  it('notes the age of a reading older than a minute', async () => {
    const el = await render({ label: 'МАСЛО', reading: available(92, '°C', 'mock', NOW - 20 * 60_000), now: NOW });
    expect(el.querySelector('[data-note]')?.textContent?.trim()).toBe('20 хв тому');
  });
});
