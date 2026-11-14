import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { of } from 'rxjs';
import type { AskStyle, DialogTurn } from '@copilot/shared';
import { SCENARIOS } from '@copilot/vehicle-core';
import type { ScenarioId, VehicleSnapshot } from '@copilot/vehicle-core';
import { ApiService } from '../../core/api.service';
import { AskService } from '../../core/ask.service';
import { CLOCK } from '../../core/clock';
import { LiveService } from '../../core/live.service';
import { AssistantPage, TOPICS } from './assistant.page';

const NOW = new Date(2026, 10, 13, 12, 41).getTime();

function scenario(id: ScenarioId, at = NOW): VehicleSnapshot {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found.build(0, at);
}

function turn(n: number): DialogTurn {
  return {
    id: `t${n}`, at: NOW - n * 60_000, question: `Питання ${n}`, answer: `Відповідь ${n}`,
    style: 'full', source: 'panel', model: 'claude-opus-5-5', snapshotAt: NOW - n * 60_000,
  };
}

/** Stands in for AskService: the spec drives its signals and the outcome of `ask`. */
class FakeAskService {
  readonly pending = signal(false);
  readonly partial = signal('');
  readonly error = signal<string | null>(null);
  readonly ask = vi.fn<(text: string, style?: AskStyle) => Promise<DialogTurn | null>>();
  readonly cancel = vi.fn(() => { this.pending.set(false); });
}

describe('AssistantPage', () => {
  let live: { snapshot: ReturnType<typeof signal<VehicleSnapshot | null>> };
  let api: { dialog: ReturnType<typeof vi.fn> };
  let ask: FakeAskService;
  let clock: number;

  async function render(): Promise<{
    el: HTMLElement; update: () => Promise<void>; fixture: ComponentFixture<AssistantPage>;
  }> {
    await TestBed.configureTestingModule({
      imports: [AssistantPage],
      providers: [
        { provide: LiveService, useValue: live },
        { provide: ApiService, useValue: api },
        { provide: AskService, useValue: ask },
        { provide: CLOCK, useValue: () => clock },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(AssistantPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const update = async () => { fixture.detectChanges(); await fixture.whenStable(); };
    return { el: fixture.nativeElement as HTMLElement, update, fixture };
  }

  const chips = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLButtonElement>('[data-chip]'));
  const field = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input#question');
  const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  beforeEach(() => {
    clock = NOW;
    live = { snapshot: signal<VehicleSnapshot | null>(scenario('parked')) };
    api = { dialog: vi.fn(() => of([])) };
    ask = new FakeAskService();
  });

  it('shows the last exchange and up to 20 earlier turns under a collapsed «Раніше»', async () => {
    api.dialog.mockReturnValue(of(Array.from({ length: 25 }, (_, i) => turn(i + 1))));
    const { el } = await render();
    expect(api.dialog).toHaveBeenCalledWith(21);
    expect(text(el.querySelector('[data-question]'))).toBe('Питання 1');
    expect(text(el.querySelector('[data-answer]'))).toBe('Відповідь 1');
    const earlier = el.querySelector('details');
    expect(earlier?.open).toBe(false);
    expect(text(earlier?.querySelector('summary'))).toBe('Раніше');
    const rows = Array.from(earlier?.querySelectorAll('li') ?? []);
    expect(rows.length).toBe(20);
    expect(text(rows[0])).toContain('Питання 2');
    expect(text(rows[0])).toContain('Відповідь 2');
    expect(text(rows[19])).toContain('Питання 21');
  });

  it('a chip sends its exact question', async () => {
    ask.ask.mockResolvedValue(turn(0));
    const { el } = await render();
    expect(chips(el).map((c) => text(c))).toEqual([...TOPICS]);
    expect(TOPICS).toEqual([
      'Як почувається авто?', 'Чи можна навантажувати двигун?', 'Що з шинами?',
      'Коли наступний сервіс?', 'Чи є помилки?', 'Як змінилися показники за останній місяць?',
    ]);
    chips(el)[5].click();
    expect(ask.ask).toHaveBeenCalledWith('Як змінилися показники за останній місяць?');
  });

  it('sends the typed question, shows the growing answer and «Скасувати» while pending, then the turn', async () => {
    let resolve: (t: DialogTurn | null) => void = () => undefined;
    ask.ask.mockImplementation(() => { ask.pending.set(true); return new Promise((r) => { resolve = r; }); });
    const { el, update } = await render();

    const input = field(el)!;
    input.value = '  Як там масло?  ';
    input.dispatchEvent(new Event('input'));
    await update();
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await update();
    expect(ask.ask).toHaveBeenCalledWith('Як там масло?');

    ask.partial.set('Масло 92');
    await update();
    expect(text(el.querySelector('[data-question]'))).toBe('Як там масло?');
    expect(text(el.querySelector('[data-answer]'))).toBe('Масло 92');
    expect(field(el)?.disabled).toBe(true);
    const cancel = Array.from(el.querySelectorAll('button')).find((b) => text(b) === 'Скасувати');
    expect(cancel).toBeDefined();

    ask.pending.set(false);
    resolve({ ...turn(0), question: 'Як там масло?', answer: 'Масло 92 °C.' });
    await update();
    await update();
    expect(text(el.querySelector('[data-answer]'))).toBe('Масло 92 °C.');
    expect(field(el)?.value).toBe('');
    expect(Array.from(el.querySelectorAll('button')).some((b) => text(b) === 'Скасувати')).toBe(false);
  });

  it('keeps the question in flight and its answer when the page is left and opened again', async () => {
    let resolve: (t: DialogTurn | null) => void = () => undefined;
    ask.ask.mockImplementation(() => { ask.pending.set(true); return new Promise((r) => { resolve = r; }); });
    api.dialog.mockReturnValue(of([turn(1)]));
    const first = await render();
    chips(first.el)[0].click();
    await first.update();
    first.fixture.destroy();                // the routes are lazy: leaving the tab destroys the page

    const again = TestBed.createComponent(AssistantPage);
    const el = again.nativeElement as HTMLElement;
    const update = async () => { again.detectChanges(); await again.whenStable(); };
    await update();
    ask.partial.set('Добре');
    await update();
    expect(text(el.querySelector('[data-question]'))).toBe('Як почувається авто?');
    expect(text(el.querySelector('[data-answer]'))).toBe('Добре');

    ask.pending.set(false);
    resolve({ ...turn(0), question: 'Як почувається авто?', answer: 'Добре.' });
    await update();
    await update();
    expect(text(el.querySelector('[data-question]'))).toBe('Як почувається авто?');
    expect(text(el.querySelector('[data-answer]'))).toBe('Добре.');
  });

  it('«Скасувати» cancels the question in flight', async () => {
    ask.ask.mockImplementation(() => { ask.pending.set(true); return new Promise(() => undefined); });
    const { el, update } = await render();
    chips(el)[0].click();
    await update();
    Array.from(el.querySelectorAll('button')).find((b) => text(b) === 'Скасувати')!.click();
    expect(ask.cancel).toHaveBeenCalled();
  });

  it('a failed question shows the server message and re-enables input', async () => {
    ask.ask.mockImplementation(async () => {
      ask.error.set('Денний бюджет вичерпано.');
      return null;
    });
    api.dialog.mockReturnValue(of([turn(1)]));
    const { el, update } = await render();
    const input = field(el)!;
    input.value = 'Чи є помилки?';
    input.dispatchEvent(new Event('input'));
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await update();
    await update();
    expect(text(el.querySelector('[data-question]'))).toBe('Чи є помилки?');
    expect(text(el.querySelector('[data-error]'))).toBe('Денний бюджет вичерпано.');
    expect(el.querySelector('[data-answer]')).toBeNull();
    expect(field(el)?.disabled).toBe(false);
    expect(field(el)?.value).toBe('Чи є помилки?');
    expect(chips(el).every((c) => !c.disabled)).toBe(true);
  });

  it('hides the text field and extra chips while the car is moving', async () => {
    api.dialog.mockReturnValue(of([turn(1), turn(2)]));
    const { el, update } = await render();
    expect(field(el)).not.toBeNull();
    expect(chips(el).length).toBe(6);
    expect(el.querySelector('details')).not.toBeNull();
    expect(el.querySelector('[data-answer]')?.classList).not.toContain('answer-driving');

    live.snapshot.set(scenario('steady-cruise'));
    await update();
    expect(field(el)).toBeNull();
    expect(chips(el).map((c) => text(c))).toEqual(TOPICS.slice(0, 3));
    expect(el.querySelector('details')).toBeNull();
    expect(el.querySelector('[data-answer]')?.classList).toContain('answer-driving');
  });

  it('a speed older than two minutes does not count as moving: the car went quiet, the full layout stays', async () => {
    api.dialog.mockReturnValue(of([turn(1), turn(2)]));
    live.snapshot.set(scenario('steady-cruise', NOW - 10 * 60 * 60_000));
    const { el } = await render();
    expect(field(el)).not.toBeNull();
    expect(chips(el).length).toBe(6);
    expect(el.querySelector('details')).not.toBeNull();
    expect(el.querySelector('[data-answer]')?.classList).not.toContain('answer-driving');
  });

  it('leaves the driving layout as the last speed ages, with no new snapshot', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      live.snapshot.set(scenario('steady-cruise'));
      const { el, update } = await render();
      expect(field(el)).toBeNull();
      expect(chips(el).length).toBe(3);

      clock = NOW + 2 * 60_000;
      vi.advanceTimersByTime(60_000);
      await update();
      expect(field(el)).toBeNull();

      clock = NOW + 2 * 60_000 + 10_000;
      vi.advanceTimersByTime(10_000);
      await update();
      expect(field(el)).not.toBeNull();
      expect(chips(el).length).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts characters from 400 and stops at 500', async () => {
    const { el, update } = await render();
    const input = field(el)!;
    expect(input.maxLength).toBe(500);
    input.value = 'а'.repeat(399);
    input.dispatchEvent(new Event('input'));
    await update();
    expect(el.querySelector('[data-counter]')).toBeNull();
    input.value = 'а'.repeat(400);
    input.dispatchEvent(new Event('input'));
    await update();
    expect(text(el.querySelector('[data-counter]'))).toBe('400 / 500');
  });

  it('works with no snapshot and no history', async () => {
    live.snapshot.set(null);
    const { el } = await render();
    expect(el.querySelector('[data-question]')).toBeNull();
    expect(field(el)).not.toBeNull();
    expect(chips(el).length).toBe(6);
  });
});
