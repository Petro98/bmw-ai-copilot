import { LISTEN_TIMEOUT_MS, RecognizerErrorCode, RecognizerEvent, SPEECH_LANG, SpeechRecognizer } from './speech.types';

/** One recognition result: its alternatives plus whether the browser has settled on it. */
export interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

export interface RecognitionResultEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResultLike>;
}

/** The part of the Web Speech API `SpeechRecognition` this adapter uses (so tests can supply a fake). */
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type RecognitionConstructor = new () => RecognitionLike;

/** The globals this adapter reads from `window`. */
export interface RecognitionWindow {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
}

function mapError(error: string): RecognizerErrorCode {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed';
    case 'no-speech':
      return 'no-speech';
    case 'network':
      return 'network';
    case 'aborted':
      return 'aborted';
    default:
      return 'other';
  }
}

/** One start() … end lifecycle; it emits exactly one `end`. */
class Session {
  private ended = false;
  private discarding = false;
  private finalDelivered = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `recognition` is null when it could not be created; `failure` then says why. */
  constructor(
    private readonly onEvent: (event: RecognizerEvent) => void,
    private readonly recognition: RecognitionLike | null,
    private readonly failure: RecognizerErrorCode,
  ) {}

  listen(): void {
    const recognition = this.recognition;
    if (!recognition) {
      this.failLater(this.failure);
      return;
    }
    recognition.lang = SPEECH_LANG;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => this.handleError(event.error);
    recognition.onend = () => this.finish();
    try {
      recognition.start();
    } catch {
      this.detach();
      this.failLater('other');
      return;
    }
    this.timer = setTimeout(() => this.stop(), LISTEN_TIMEOUT_MS);
  }

  stop(): void {
    if (this.ended || this.discarding) return;
    this.clearTimer();
    try {
      this.recognition?.stop();
    } catch {
      this.finish();
    }
  }

  /** Closes the microphone, drops whatever arrives afterwards and ends the session now. */
  abort(): void {
    if (this.ended || this.discarding) return;
    this.discarding = true;
    this.clearTimer();
    try {
      this.recognition?.abort();
    } catch {
      // The session ends below regardless.
    }
    this.detach();
    queueMicrotask(() => this.finish());
  }

  private handleResult(event: RecognitionResultEventLike): void {
    if (this.ended || this.discarding || this.finalDelivered) return;
    let text = '';
    let isFinal = event.results.length > 0;
    for (let i = 0; i < event.results.length; i += 1) {
      const result = event.results[i];
      text += result.length > 0 ? result[0].transcript : '';
      isFinal = isFinal && result.isFinal;
    }
    text = text.trim();
    if (isFinal) {
      this.finalDelivered = true;
      this.onEvent({ type: 'final', text });
    } else {
      this.onEvent({ type: 'partial', text });
    }
  }

  private handleError(error: string): void {
    if (this.ended || this.discarding) return;
    this.onEvent({ type: 'error', code: mapError(error) });
  }

  private failLater(code: RecognizerErrorCode): void {
    // Delivered asynchronously, like a real browser error, so callers never see events re-entrantly.
    queueMicrotask(() => {
      if (this.ended || this.discarding) return;
      this.onEvent({ type: 'error', code });
      this.finish();
    });
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimer();
    this.detach();
    this.onEvent({ type: 'end' });
  }

  private detach(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Push-to-talk recognition with the browser's own `SpeechRecognition`. It never opens the
 * microphone by itself: only `start()`, which the talk flow calls from a tap, does.
 */
export class BrowserSpeechRecognizer implements SpeechRecognizer {
  private session: Session | null = null;

  constructor(private readonly win: RecognitionWindow) {}

  isSupported(): boolean {
    return this.recognitionConstructor() !== null;
  }

  start(onEvent: (event: RecognizerEvent) => void): void {
    this.session?.abort();
    const Recognition = this.recognitionConstructor();
    let recognition: RecognitionLike | null = null;
    try {
      recognition = Recognition ? new Recognition() : null;
    } catch {
      recognition = null;
    }
    // No API at all is 'unsupported'; an API that failed to construct is a failed start ('other').
    const session = new Session(onEvent, recognition, Recognition ? 'other' : 'unsupported');
    this.session = session;
    session.listen();
  }

  stop(): void {
    this.session?.stop();
  }

  abort(): void {
    this.session?.abort();
  }

  private recognitionConstructor(): RecognitionConstructor | null {
    return this.win.SpeechRecognition ?? this.win.webkitSpeechRecognition ?? null;
  }
}
