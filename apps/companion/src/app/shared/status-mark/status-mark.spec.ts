import { TestBed } from '@angular/core/testing';
import { StatusMark } from './status-mark';

async function render(on: boolean): Promise<HTMLElement> {
  await TestBed.configureTestingModule({ imports: [StatusMark] }).compileComponents();
  const fixture = TestBed.createComponent(StatusMark);
  fixture.componentRef.setInput('name', 'vehicle');
  fixture.componentRef.setInput('label', 'АВТО');
  fixture.componentRef.setInput('on', on);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('StatusMark', () => {
  it('shows a check icon and says the link is up, not by colour alone', async () => {
    const el = await render(true);
    expect(el.getAttribute('data-mark')).toBe('vehicle');
    expect(el.getAttribute('data-state')).toBe('on');
    expect(el.textContent?.replace(/\s+/g, ' ').trim()).toBe('АВТО підключено');
    expect(el.querySelector('svg[aria-hidden="true"] path')?.getAttribute('d')).toBe('M5 12.5l4.5 4.5L19 7.5');
  });

  it('shows a dash icon and says the link is down', async () => {
    const el = await render(false);
    expect(el.getAttribute('data-state')).toBe('off');
    expect(el.textContent?.replace(/\s+/g, ' ').trim()).toBe('АВТО не підключено');
    expect(el.querySelector('svg[aria-hidden="true"] path')?.getAttribute('d')).toBe('M6 12h12');
  });
});
