import { SPEECH_LANG, SpeechSpeaker } from './speech.types';

export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
}

/** The part of `SpeechSynthesisUtterance` this adapter uses. */
export interface UtteranceLike {
  text: string;
  lang: string;
  voice: VoiceLike | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

/** The part of `speechSynthesis` this adapter uses (so tests can supply a fake). */
export interface SynthesisLike {
  readonly speaking: boolean;
  getVoices(): VoiceLike[];
  addEventListener(type: 'voiceschanged', listener: () => void): void;
  speak(utterance: UtteranceLike): void;
  cancel(): void;
}

/** The globals this adapter reads from `window`. */
export interface SpeakerWindow {
  speechSynthesis?: SynthesisLike;
  SpeechSynthesisUtterance?: new (text?: string) => UtteranceLike;
}

function isUkrainian(voice: VoiceLike): boolean {
  return voice.lang.toLowerCase().startsWith('uk');
}

/**
 * Speaks answers with the browser's own `speechSynthesis`, one utterance per call, in Ukrainian.
 * It only speaks what it is given; it never listens and never speaks on its own.
 */
export class BrowserSpeechSpeaker implements SpeechSpeaker {
  private readonly synthesis: SynthesisLike | null;
  private readonly Utterance: (new (text?: string) => UtteranceLike) | null;
  private voicesLoaded = false;
  /** Resolvers of utterances that have neither ended nor been cancelled. */
  private readonly pending = new Map<UtteranceLike, () => void>();

  constructor(win: SpeakerWindow) {
    this.synthesis = win.speechSynthesis ?? null;
    this.Utterance = win.SpeechSynthesisUtterance ?? null;
    if (!this.synthesis) return;
    // Chrome loads voices asynchronously: until `voiceschanged` fires the list may be empty.
    this.voicesLoaded = this.voices().length > 0;
    try {
      this.synthesis.addEventListener('voiceschanged', () => { this.voicesLoaded = true; });
    } catch {
      // Without the event, hasVoice() relies on getVoices() returning a non-empty list.
    }
  }

  isSupported(): boolean {
    return this.synthesis !== null && this.Utterance !== null;
  }

  hasVoice(): boolean {
    return this.ukrainianVoice() !== null;
  }

  prime(): void {
    const utterance = this.utterance('');
    if (!utterance || !this.synthesis) return;
    try {
      this.synthesis.speak(utterance);
    } catch {
      // Priming is best effort.
    }
  }

  speak(text: string): Promise<void> {
    const utterance = text.trim() ? this.utterance(text) : null;
    const synthesis = this.synthesis;
    if (!utterance || !synthesis) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        if (!this.pending.has(utterance)) return;
        this.pending.delete(utterance);
        resolve();
      };
      // Holding the utterance in `pending` also keeps it from being garbage-collected mid-speech.
      this.pending.set(utterance, done);
      utterance.onend = done;
      utterance.onerror = done;
      try {
        synthesis.speak(utterance);
      } catch {
        done();
      }
    });
  }

  cancel(): void {
    try {
      this.synthesis?.cancel();
    } catch {
      // Pending promises are resolved below regardless.
    }
    for (const done of [...this.pending.values()]) done();
  }

  speaking(): boolean {
    return this.pending.size > 0;
  }

  private utterance(text: string): UtteranceLike | null {
    if (!this.Utterance) return null;
    const utterance = new this.Utterance(text);
    utterance.lang = SPEECH_LANG;
    const voice = this.ukrainianVoice();
    if (voice) utterance.voice = voice;
    return utterance;
  }

  private ukrainianVoice(): VoiceLike | null {
    if (!this.synthesis) return null;
    const voices = this.voices();
    if (!this.voicesLoaded && voices.length === 0) return null;
    this.voicesLoaded = true;
    return voices.find(isUkrainian) ?? null;
  }

  private voices(): VoiceLike[] {
    try {
      return this.synthesis?.getVoices() ?? [];
    } catch {
      return [];
    }
  }
}
