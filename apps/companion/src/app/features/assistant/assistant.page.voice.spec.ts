import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { AskStreamEvent, DialogTurn } from '@copilot/shared';
import { SCENARIOS } from '@copilot/vehicle-core';
import type { ScenarioId, VehicleSnapshot } from '@copilot/vehicle-core';
import { ApiService } from '../../core/api.service';
import { AskService } from '../../core/ask.service';
import { LiveService } from '../../core/live.service';
import { SPEECH_RECOGNIZER, SPEECH_SPEAKER } from '../../speech/speech.tokens';
import type { RecognizerEvent, SpeechRecognizer, SpeechSpeaker } from '../../speech/speech.types';
import { AssistantPage } from './assistant.page';
import { NO_VOICE_TEXT } from './talk.controller';
import { TALK_TEXT } from './talk.machine';
import { ScreenWakeLock, WakeLockDocument, WakeLockNavigator } from './wake-lock';

const NOW = new Date(2026, 10, 13, 12, 41).getTime();

function scenario(id: ScenarioId): VehicleSnapshot {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found.build(0, NOW);
}

const TURN: DialogTurn = {
  id: 'v1', at: NOW, question: 'Як почувається авто?', answer: 'Двигун прогрітий: масло 92 °C. Помилок немає.',
  style: 'spoken', source: 'voice', model: 'claude-opus-5-5', snapshotAt: NOW,
};

class FakeRecognizer implements SpeechRecognizer {
  supported = true;
  listener: ((event: RecognizerEvent) => void) | null = null;
  readonly start = vi.fn((onEvent: (event: RecognizerEvent) => void) => { this.listener = onEvent; });
  readonly stop = vi.fn();
  readonly abort = vi.fn();
  isSupported(): boolean { return this.supported; }
  emit(event: RecognizerEvent): void { this.listener?.(event); }
}

class FakeSpeaker implements SpeechSpeaker {
  voice = true;
  resolvers: Array<() => void> = [];
  readonly prime = vi.fn();
  readonly speak = vi.fn((_text: string) => new Promise<void>((resolve) => { this.resolvers.push(resolve); }));
  readonly cancel = vi.fn(() => { const all = this.resolvers; this.resolvers = []; all.forEach((r) => r()); });
  isSupported(): boolean { return true; }
  hasVoice(): boolean { return this.voice; }
  speaking(): boolean { return this.resolvers.length > 0; }
  finishAll(): void { const all = this.resolvers; this.resolvers = []; all.forEach((r) => r()); }
}

/** One streamed answer the spec feeds event by event. */
class StreamedAnswer {
  init: RequestInit | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();

  respond(init: RequestInit): Response {
    this.init = init;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { this.controller = c; } });
    init.signal?.addEventListener('abort', () => this.controller?.error(new DOMException('Aborted', 'AbortError')));
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  send(event: AskStreamEvent): void {
    this.controller?.enqueue(this.encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  }

  close(): void { this.controller?.close(); }

  get body(): Record<string, unknown> { return JSON.parse(String(this.init?.body)) as Record<string, unknown>; }
}

describe('AssistantPage voice', () => {
  let live: { snapshot: ReturnType<typeof signal<VehicleSnapshot | null>> };
  let recognizer: FakeRecognizer;
  let speaker: FakeSpeaker;
  let answer: StreamedAnswer;
  let fetchMock: ReturnType<typeof vi.fn>;

  async function render(): Promise<{ el: HTMLElement; settle: () => Promise<void>; fixture: ComponentFixture<AssistantPage> }> {
    await TestBed.configureTestingModule({
      imports: [AssistantPage],
      providers: [
        provideRouter([]),
        { provide: LiveService, useValue: live },
        { provide: ApiService, useValue: { dialog: vi.fn(() => of([])) } },
        { provide: SPEECH_RECOGNIZER, useValue: recognizer },
        { provide: SPEECH_SPEAKER, useValue: speaker },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(AssistantPage);
    const settle = async () => {
      for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
      await fixture.whenStable();
    };
    await settle();
    return { el: fixture.nativeElement as HTMLElement, settle, fixture };
  }

  const button = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-talk]')!;
  const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const stateLine = (el: HTMLElement) => text(el.querySelector('[data-talk-state]'));
  const message = (el: HTMLElement) => text(el.querySelector('[data-talk-message]'));
  const chips = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLButtonElement>('[data-chip]'));
  const field = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input#question');

  beforeEach(() => {
    live = { snapshot: signal<VehicleSnapshot | null>(scenario('parked')) };
    recognizer = new FakeRecognizer();
    speaker = new FakeSpeaker();
    answer = new StreamedAnswer();
    fetchMock = vi.fn((_url: string, init: RequestInit) => Promise.resolve(answer.respond(init)));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  });

  /** Tap the button and say the question. */
  async function askAloud(el: HTMLElement, settle: () => Promise<void>, question = 'Як почувається авто?'): Promise<void> {
    button(el).click();
    await settle();
    recognizer.emit({ type: 'partial', text: 'Як почувається' });
    await settle();
    recognizer.emit({ type: 'final', text: question });
    recognizer.emit({ type: 'end' });
    await settle();
  }

  it('opening the page does not open the microphone; the button says «Говорити»', async () => {
    const { el } = await render();
    expect(recognizer.start).not.toHaveBeenCalled();
    expect(button(el).getAttribute('aria-label')).toBe('Говорити');
    expect(button(el).disabled).toBe(false);
    expect(stateLine(el)).toBe('Натисніть і говоріть');
    expect(text(el)).toContain('УКРАЇНСЬКА');
    expect(el.querySelector('[data-meter]')).toBeNull();
  });

  it('a voice exchange: listening, thinking, speaking sentence by sentence, then idle with the answer shown', async () => {
    const { el, settle } = await render();
    button(el).click();
    await settle();
    expect(recognizer.start).toHaveBeenCalledTimes(1);
    expect(speaker.prime).toHaveBeenCalledTimes(1);
    expect(button(el).getAttribute('aria-label')).toBe('Зупинити');
    expect(stateLine(el)).toBe('Слухаю…');
    expect(el.querySelector('[data-meter]')).not.toBeNull();

    recognizer.emit({ type: 'partial', text: 'Як почувається' });
    await settle();
    expect(text(el.querySelector('[data-question]'))).toBe('Як почувається');

    recognizer.emit({ type: 'final', text: 'Як почувається авто?' });
    recognizer.emit({ type: 'end' });
    await settle();
    expect(stateLine(el)).toBe('Думаю…');
    expect(el.querySelector('[data-meter]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(answer.body).toEqual({ text: 'Як почувається авто?', style: 'spoken', source: 'voice' });

    answer.send({ type: 'delta', text: 'Двигун прогрітий: масло 92 °C. ' });
    answer.send({ type: 'sentence', text: 'Двигун прогрітий: масло 92 °C.' });
    await settle();
    expect(speaker.speak).toHaveBeenCalledWith('Двигун прогрітий: масло 92 °C.');
    expect(stateLine(el)).toBe('Відповідаю…');
    expect(button(el).getAttribute('aria-label')).toBe('Зупинити');
    expect(el.querySelector('[data-meter]')).not.toBeNull();
    expect(text(el.querySelector('[data-question]'))).toBe('Як почувається авто?');
    expect(text(el.querySelector('[data-answer]'))).toBe('Двигун прогрітий: масло 92 °C.');

    answer.send({ type: 'delta', text: 'Помилок немає.' });
    answer.send({ type: 'sentence', text: 'Помилок немає.' });
    answer.send({ type: 'done', turn: TURN });
    answer.close();
    await settle();
    expect(speaker.speak).toHaveBeenCalledTimes(2);
    expect(stateLine(el)).toBe('Відповідаю…');            // still speaking the queued sentences

    speaker.finishAll();
    await settle();
    expect(stateLine(el)).toBe('Натисніть і говоріть');
    expect(button(el).getAttribute('aria-label')).toBe('Говорити');
    expect(text(el.querySelector('[data-answer]'))).toBe(TURN.answer);
    expect(recognizer.start).toHaveBeenCalledTimes(1);     // never reopened after the answer
  });

  it('a tap while speaking stops speech and cancels the answer request at once', async () => {
    const { el, settle } = await render();
    await askAloud(el, settle);
    answer.send({ type: 'sentence', text: 'Двигун прогрітий: масло 92 °C.' });
    await settle();
    expect(stateLine(el)).toBe('Відповідаю…');

    button(el).click();
    expect(speaker.cancel).toHaveBeenCalled();
    expect(answer.init?.signal?.aborted).toBe(true);
    await settle();
    expect(stateLine(el)).toBe('Натисніть і говоріть');
    expect(recognizer.start).toHaveBeenCalledTimes(1);
    expect(chips(el).every((c) => !c.disabled)).toBe(true);
  });

  it('an error event stops everything and shows the message', async () => {
    const { el, settle } = await render();
    await askAloud(el, settle);
    answer.send({ type: 'sentence', text: 'Двигун прогрітий: масло 92 °C.' });
    answer.send({ type: 'error', error: { code: 'budget-exhausted', message: 'Денний бюджет вичерпано.' } });
    answer.close();
    await settle();
    expect(speaker.cancel).toHaveBeenCalled();
    expect(stateLine(el)).toBe('Натисніть і говоріть');
    expect(text(el)).toContain('Денний бюджет вичерпано.');
    expect(chips(el).every((c) => !c.disabled)).toBe(true);
    expect(field(el)?.disabled).toBe(false);
  });

  it('a 401 on the answer stream sends the owner to sign in and leaves nothing pending', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ error: { code: 'internal', message: 'Потрібно увійти.' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )));
    const { el, settle } = await render();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const ask = TestBed.inject(AskService);

    await askAloud(el, settle);
    expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { return: '/' } });
    expect(ask.pending()).toBe(false);
    expect(ask.error()).toBeNull();
    expect(stateLine(el)).toBe('Натисніть і говоріть');
    expect(el.querySelector('[data-error]')).toBeNull();
  });

  it('a 401 on a typed question also sends the owner to sign in', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 401 })));
    const { el, settle } = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    chips(el)[0].click();
    await settle();
    expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { return: '/' } });
    expect(TestBed.inject(AskService).pending()).toBe(false);
    expect(chips(el).every((c) => !c.disabled)).toBe(true);
  });

  it('without recognition the button is disabled with the explanation and the text field still works', async () => {
    recognizer.supported = false;
    const { el, settle } = await render();
    expect(button(el).disabled).toBe(true);
    expect(message(el)).toBe('Цей браузер не розпізнає мовлення. Напишіть запитання текстом.');
    button(el).click();
    expect(recognizer.start).not.toHaveBeenCalled();

    const input = field(el)!;
    expect(input.disabled).toBe(false);
    input.value = 'Чи є помилки?';
    input.dispatchEvent(new Event('input'));
    await settle();
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await settle();
    expect(answer.body).toEqual({ text: 'Чи є помилки?', style: 'full', source: 'panel' });
  });

  it.each([
    ['not-allowed', TALK_TEXT.notAllowed],
    ['no-speech', TALK_TEXT.notHeard],
    ['network', TALK_TEXT.network],
    ['unsupported', TALK_TEXT.unsupported],
  ] as const)('recogniser error %s shows one clear message and leaves typing and the chips usable', async (code, expected) => {
    const { el, settle } = await render();
    button(el).click();
    await settle();
    recognizer.emit({ type: 'error', code });
    recognizer.emit({ type: 'end' });
    await settle();
    expect(message(el)).toBe(expected);
    expect(el.querySelectorAll('[data-talk-message]').length).toBe(1);
    expect(stateLine(el)).toBe('Натисніть і говоріть');
    expect(button(el).disabled).toBe(false);
    expect(chips(el).every((c) => !c.disabled)).toBe(true);
    expect(field(el)?.disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('without a Ukrainian voice the answer is shown as text and the note appears', async () => {
    speaker.voice = false;
    const { el, settle } = await render();
    expect(el.querySelector('[data-voice-note]')).toBeNull();
    await askAloud(el, settle);
    answer.send({ type: 'delta', text: 'Двигун прогрітий: масло 92 °C.' });
    answer.send({ type: 'sentence', text: 'Двигун прогрітий: масло 92 °C.' });
    answer.send({ type: 'done', turn: { ...TURN, answer: 'Двигун прогрітий: масло 92 °C.' } });
    answer.close();
    await settle();
    expect(speaker.speak).not.toHaveBeenCalled();
    expect(text(el.querySelector('[data-voice-note]'))).toBe(NO_VOICE_TEXT);
    expect(NO_VOICE_TEXT).toBe('На цьому телефоні немає українського голосу. Відповідь показано текстом.');
    expect(text(el.querySelector('[data-answer]'))).toBe('Двигун прогрітий: масло 92 °C.');
    expect(stateLine(el)).toBe('Натисніть і говоріть');
  });

  it('hiding the page closes the microphone', async () => {
    const { el, settle } = await render();
    button(el).click();
    await settle();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(recognizer.abort).toHaveBeenCalledTimes(1);
    expect(stateLine(el)).toBe('Натисніть і говоріть');
    expect(message(el)).toBe('');

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(recognizer.start).toHaveBeenCalledTimes(1);     // coming back does not reopen it
  });

  it('leaving the page closes the microphone', async () => {
    const { el, settle, fixture } = await render();
    button(el).click();
    await settle();
    fixture.destroy();
    expect(recognizer.abort).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(recognizer.start).toHaveBeenCalledTimes(1);
  });

  it('while moving the button, state and answer stay and the text field goes', async () => {
    live.snapshot.set(scenario('steady-cruise'));
    const { el } = await render();
    expect(button(el)).not.toBeNull();
    expect(stateLine(el)).toBe('Натисніть і говоріть');
    expect(field(el)).toBeNull();
  });
});

describe('ScreenWakeLock', () => {
  class FakeDocument implements WakeLockDocument {
    visibilityState: DocumentVisibilityState = 'visible';
    private listeners: Array<() => void> = [];
    addEventListener(_type: 'visibilitychange', listener: () => void): void { this.listeners.push(listener); }
    removeEventListener(_type: 'visibilitychange', listener: () => void): void {
      this.listeners = this.listeners.filter((l) => l !== listener);
    }
    set(state: DocumentVisibilityState): void { this.visibilityState = state; this.listeners.forEach((l) => l()); }
    get listenerCount(): number { return this.listeners.length; }
  }

  function sentinel(): { released: boolean; release: ReturnType<typeof vi.fn<() => Promise<void>>> } {
    const s = { released: false, release: vi.fn(async () => { s.released = true; }) };
    return s;
  }

  const tick = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

  it('requests the screen lock while visible and again when the page returns', async () => {
    const doc = new FakeDocument();
    const sentinels: Array<ReturnType<typeof sentinel>> = [];
    const nav: WakeLockNavigator = { wakeLock: { request: vi.fn(async () => { const s = sentinel(); sentinels.push(s); return s; }) } };
    const lock = new ScreenWakeLock(doc, nav);
    lock.start();
    await tick();
    expect(nav.wakeLock!.request).toHaveBeenCalledWith('screen');
    expect(nav.wakeLock!.request).toHaveBeenCalledTimes(1);

    sentinels[0].released = true;                           // the browser drops it while the page is hidden
    doc.set('hidden');
    await tick();
    expect(nav.wakeLock!.request).toHaveBeenCalledTimes(1);
    doc.set('visible');
    await tick();
    expect(nav.wakeLock!.request).toHaveBeenCalledTimes(2);

    lock.stop();
    await tick();
    expect(sentinels[1].release).toHaveBeenCalled();
    expect(doc.listenerCount).toBe(0);
  });

  it('a browser without the lock, or one that refuses it, is ignored silently', async () => {
    const doc = new FakeDocument();
    expect(() => new ScreenWakeLock(doc, {}).start()).not.toThrow();
    expect(() => new ScreenWakeLock(doc, undefined).start()).not.toThrow();
    const refusing = new ScreenWakeLock(doc, { wakeLock: { request: vi.fn(() => Promise.reject(new Error('NotAllowedError'))) } });
    refusing.start();
    await tick();
    refusing.stop();
  });
});
