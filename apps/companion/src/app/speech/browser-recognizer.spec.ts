import { BrowserSpeechRecognizer, RecognitionLike, RecognitionResultEventLike, RecognitionWindow } from './browser-recognizer';
import { LISTEN_TIMEOUT_MS, RecognizerEvent, SPEECH_LANG } from './speech.types';

/** A scripted stand-in for the browser's `SpeechRecognition`; no microphone, no audio. */
class FakeRecognition implements RecognitionLike {
  static instances: FakeRecognition[] = [];

  lang = '';
  continuous = true;
  interimResults = false;
  maxAlternatives = 5;
  onresult: ((event: RecognitionResultEventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  private heard: Array<{ text: string; isFinal: boolean }> = [];

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void { this.started += 1; }

  /** Like Chrome: what was heard so far becomes final, then the session ends. */
  stop(): void {
    this.stopped += 1;
    const last = this.heard[this.heard.length - 1];
    if (last && !last.isFinal) this.hear(last.text, true);
    else if (!last) this.onerror?.({ error: 'no-speech' });
    this.onend?.();
  }

  /** Like Chrome: an `aborted` error, then the session ends. */
  abort(): void {
    this.aborted += 1;
    this.onerror?.({ error: 'aborted' });
    this.onend?.();
  }

  hear(text: string, isFinal: boolean): void {
    this.heard = [{ text, isFinal }];
    const result = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }

  fail(error: string): void {
    this.onerror?.({ error });
    this.onend?.();
  }
}

function fakeWindow(): RecognitionWindow {
  return { SpeechRecognition: FakeRecognition };
}

function recorder(): { events: RecognizerEvent[]; onEvent: (event: RecognizerEvent) => void } {
  const events: RecognizerEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

const flushMicrotasks = () => Promise.resolve();

describe('BrowserSpeechRecognizer', () => {
  beforeEach(() => {
    FakeRecognition.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports unsupported when the browser has no recognition API and start() emits error then end', async () => {
    const recognizer = new BrowserSpeechRecognizer({});
    const { events, onEvent } = recorder();

    expect(recognizer.isSupported()).toBe(false);
    expect(() => recognizer.start(onEvent)).not.toThrow();
    await flushMicrotasks();

    expect(events).toEqual([{ type: 'error', code: 'unsupported' }, { type: 'end' }]);
    expect(() => recognizer.stop()).not.toThrow();
    expect(() => recognizer.abort()).not.toThrow();
  });

  it('uses the prefixed constructor when only webkitSpeechRecognition exists', () => {
    const recognizer = new BrowserSpeechRecognizer({ webkitSpeechRecognition: FakeRecognition });
    expect(recognizer.isSupported()).toBe(true);
    recognizer.start(() => undefined);
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it('does not touch the microphone until start() is called', () => {
    const recognizer = new BrowserSpeechRecognizer(fakeWindow());
    expect(recognizer.isSupported()).toBe(true);
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it('configures uk-UA, single shot, interim results', () => {
    const recognizer = new BrowserSpeechRecognizer(fakeWindow());
    recognizer.start(() => undefined);

    const recognition = FakeRecognition.instances[0];
    expect(recognition.lang).toBe(SPEECH_LANG);
    expect(SPEECH_LANG).toBe('uk-UA');
    expect(recognition.continuous).toBe(false);
    expect(recognition.interimResults).toBe(true);
    expect(recognition.maxAlternatives).toBe(1);
    expect(recognition.started).toBe(1);
  });

  it('emits partials, then one final, then end', () => {
    const recognizer = new BrowserSpeechRecognizer(fakeWindow());
    const { events, onEvent } = recorder();
    recognizer.start(onEvent);
    const recognition = FakeRecognition.instances[0];

    recognition.hear('Як', false);
    recognition.hear('Як авто', false);
    recognition.hear('Як авто?', true);
    recognition.hear('Як авто?', true);
    recognition.onend?.();
    recognition.onend?.();

    expect(events).toEqual([
      { type: 'partial', text: 'Як' },
      { type: 'partial', text: 'Як авто' },
      { type: 'final', text: 'Як авто?' },
      { type: 'end' },
    ]);
  });

  it('stop() finishes and delivers what was heard', () => {
    const recognizer = new BrowserSpeechRecognizer(fakeWindow());
    const { events, onEvent } = recorder();
    recognizer.start(onEvent);
    FakeRecognition.instances[0].hear('Скільки пального', false);

    recognizer.stop();

    expect(FakeRecognition.instances[0].stopped).toBe(1);
    expect(events).toEqual([
      { type: 'partial', text: 'Скільки пального' },
      { type: 'final', text: 'Скільки пального' },
      { type: 'end' },
    ]);
  });

  it.each([
    ['not-allowed', 'not-allowed'],
    ['service-not-allowed', 'not-allowed'],
    ['no-speech', 'no-speech'],
    ['network', 'network'],
    ['aborted', 'aborted'],
    ['bad-grammar', 'other'],
  ])('maps browser error %s to %s', (browserError, code) => {
    const recognizer = new BrowserSpeechRecognizer(fakeWindow());
    const { events, onEvent } = recorder();
    recognizer.start(onEvent);

    FakeRecognition.instances[0].fail(browserError);

    expect(events).toEqual([{ type: 'error', code }, { type: 'end' }]);
  });

  it('reports a start() that throws as an error followed by end', async () => {
    class ThrowingRecognition extends FakeRecognition {
      override start(): void { throw new Error('InvalidStateError'); }
    }
    const recognizer = new BrowserSpeechRecognizer({ SpeechRecognition: ThrowingRecognition });
    const { events, onEvent } = recorder();

    expect(() => recognizer.start(onEvent)).not.toThrow();
    await flushMicrotasks();

    expect(events).toEqual([{ type: 'error', code: 'other' }, { type: 'end' }]);
  });

  it('stops itself after ten seconds of silence', () => {
    vi.useFakeTimers();
    const recognizer = new BrowserSpeechRecognizer(fakeWindow());
    const { events, onEvent } = recorder();
    recognizer.start(onEvent);
    const recognition = FakeRecognition.instances[0];

    expect(LISTEN_TIMEOUT_MS).toBe(10_000);
    vi.advanceTimersByTime(LISTEN_TIMEOUT_MS - 1);
    expect(recognition.stopped).toBe(0);
    vi.advanceTimersByTime(1);

    expect(recognition.stopped).toBe(1);
    expect(events).toEqual([{ type: 'error', code: 'no-speech' }, { type: 'end' }]);
  });

  it('leaves no timer running once the session has ended', () => {
    vi.useFakeTimers();
    const recognizer = new BrowserSpeechRecognizer(fakeWindow());
    recognizer.start(() => undefined);
    FakeRecognition.instances[0].fail('network');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('abort() delivers no final result', async () => {
    const recognizer = new BrowserSpeechRecognizer(fakeWindow());
    const { events, onEvent } = recorder();
    recognizer.start(onEvent);
    const recognition = FakeRecognition.instances[0];
    recognition.hear('Як ав', false);

    recognizer.abort();
    recognition.hear('Як авто?', true);
    await flushMicrotasks();

    expect(recognition.aborted).toBe(1);
    expect(events).toEqual([{ type: 'partial', text: 'Як ав' }, { type: 'end' }]);
  });

  it('a new start() ends the previous session exactly once before listening again', async () => {
    const recognizer = new BrowserSpeechRecognizer(fakeWindow());
    const first = recorder();
    const second = recorder();
    recognizer.start(first.onEvent);
    recognizer.start(second.onEvent);
    await flushMicrotasks();

    expect(FakeRecognition.instances).toHaveLength(2);
    expect(FakeRecognition.instances[0].aborted).toBe(1);
    expect(first.events).toEqual([{ type: 'end' }]);

    FakeRecognition.instances[1].hear('Тиск у шинах', true);
    expect(second.events).toEqual([{ type: 'final', text: 'Тиск у шинах' }]);
  });
});
