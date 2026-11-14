import { BrowserSpeechSpeaker, SpeakerWindow, SynthesisLike, UtteranceLike, VoiceLike } from './browser-speaker';
import { SPEECH_LANG } from './speech.types';

class FakeUtterance implements UtteranceLike {
  lang = '';
  voice: VoiceLike | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(public text = '') {}
}

/** A stand-in for `speechSynthesis` with the browser's queue semantics; it makes no sound. */
class FakeSynthesis implements SynthesisLike {
  voices: VoiceLike[] = [];
  queue: FakeUtterance[] = [];
  spoken: string[] = [];
  cancelled = 0;
  private listeners: Array<() => void> = [];

  get speaking(): boolean { return this.queue.length > 0; }

  getVoices(): VoiceLike[] { return this.voices; }

  addEventListener(type: 'voiceschanged', listener: () => void): void {
    if (type === 'voiceschanged') this.listeners.push(listener);
  }

  speak(utterance: UtteranceLike): void {
    this.queue.push(utterance as FakeUtterance);
  }

  cancel(): void {
    this.cancelled += 1;
    const dropped = this.queue;
    this.queue = [];
    for (const utterance of dropped) utterance.onerror?.({ error: 'interrupted' });
  }

  /** The utterance at the head of the queue finishes; the next one starts. */
  finishCurrent(): void {
    const current = this.queue.shift();
    if (!current) return;
    this.spoken.push(current.text);
    current.onend?.();
  }

  loadVoices(voices: VoiceLike[]): void {
    this.voices = voices;
    for (const listener of this.listeners) listener();
  }
}

const UK_VOICE: VoiceLike = { name: 'Ukrainian', lang: 'uk-UA' };
const EN_VOICE: VoiceLike = { name: 'English', lang: 'en-US' };

function fakeWindow(synthesis = new FakeSynthesis()): { synthesis: FakeSynthesis; win: SpeakerWindow } {
  return { synthesis, win: { speechSynthesis: synthesis, SpeechSynthesisUtterance: FakeUtterance } };
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('BrowserSpeechSpeaker', () => {
  it('hasVoice is false until voices load and true when a uk voice exists', () => {
    const { synthesis, win } = fakeWindow();
    const speaker = new BrowserSpeechSpeaker(win);
    expect(speaker.isSupported()).toBe(true);
    expect(speaker.hasVoice()).toBe(false);

    synthesis.loadVoices([EN_VOICE, UK_VOICE]);
    expect(speaker.hasVoice()).toBe(true);
  });

  it('hasVoice is false when the loaded voices have no Ukrainian one', () => {
    const { synthesis, win } = fakeWindow();
    const speaker = new BrowserSpeechSpeaker(win);
    synthesis.loadVoices([EN_VOICE]);
    expect(speaker.hasVoice()).toBe(false);
  });

  it('answers at once when the voices were already loaded', () => {
    const synthesis = new FakeSynthesis();
    synthesis.voices = [{ name: 'Lesya', lang: 'uk_UA' }];
    const speaker = new BrowserSpeechSpeaker(fakeWindow(synthesis).win);
    expect(speaker.hasVoice()).toBe(true);
  });

  it('speaks queued sentences one after another and resolves each promise', async () => {
    const { synthesis, win } = fakeWindow();
    synthesis.voices = [EN_VOICE, UK_VOICE];
    const speaker = new BrowserSpeechSpeaker(win);

    const first = speaker.speak('Двигун прогрітий.');
    const second = speaker.speak('Активних повідомлень немає.');
    expect(synthesis.queue.map((u) => u.text)).toEqual(['Двигун прогрітий.', 'Активних повідомлень немає.']);
    expect(synthesis.queue.every((u) => u.lang === SPEECH_LANG && u.voice === UK_VOICE)).toBe(true);
    expect(speaker.speaking()).toBe(true);

    synthesis.finishCurrent();
    expect(await settled(first)).toBe(true);
    expect(await settled(second)).toBe(false);
    expect(speaker.speaking()).toBe(true);

    synthesis.finishCurrent();
    expect(await settled(second)).toBe(true);
    expect(synthesis.spoken).toEqual(['Двигун прогрітий.', 'Активних повідомлень немає.']);
    expect(speaker.speaking()).toBe(false);
  });

  it('cancel() silences at once and resolves pending promises', async () => {
    const { synthesis, win } = fakeWindow();
    const speaker = new BrowserSpeechSpeaker(win);
    const first = speaker.speak('Перше речення.');
    const second = speaker.speak('Друге речення.');

    speaker.cancel();

    expect(synthesis.cancelled).toBe(1);
    expect(synthesis.queue).toHaveLength(0);
    expect(speaker.speaking()).toBe(false);
    expect(await settled(first)).toBe(true);
    expect(await settled(second)).toBe(true);
  });

  it('resolves even when the browser never reports the end of a cancelled utterance', async () => {
    const { synthesis, win } = fakeWindow();
    synthesis.cancel = () => { synthesis.cancelled += 1; synthesis.queue = []; };
    const speaker = new BrowserSpeechSpeaker(win);
    const pending = speaker.speak('Речення.');

    speaker.cancel();

    expect(await settled(pending)).toBe(true);
    expect(speaker.speaking()).toBe(false);
  });

  it('a speech error resolves the promise instead of rejecting it', async () => {
    const { synthesis, win } = fakeWindow();
    const speaker = new BrowserSpeechSpeaker(win);
    const pending = speaker.speak('Речення.');

    synthesis.queue[0].onerror?.({ error: 'synthesis-failed' });

    expect(await settled(pending)).toBe(true);
    expect(speaker.speaking()).toBe(false);
  });

  it('prime() speaks an empty utterance and is not counted as speaking', () => {
    const { synthesis, win } = fakeWindow();
    const speaker = new BrowserSpeechSpeaker(win);

    speaker.prime();

    expect(synthesis.queue).toHaveLength(1);
    expect(synthesis.queue[0].text).toBe('');
    expect(synthesis.queue[0].lang).toBe(SPEECH_LANG);
    expect(speaker.speaking()).toBe(false);
  });

  it('without speech synthesis speak() resolves immediately and isSupported is false', async () => {
    const speaker = new BrowserSpeechSpeaker({});

    expect(speaker.isSupported()).toBe(false);
    expect(speaker.hasVoice()).toBe(false);
    expect(await settled(speaker.speak('Речення.'))).toBe(true);
    expect(() => speaker.prime()).not.toThrow();
    expect(() => speaker.cancel()).not.toThrow();
    expect(speaker.speaking()).toBe(false);
  });
});
