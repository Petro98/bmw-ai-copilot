import type { AskStyle, DialogTurn } from '@copilot/shared';
import type { AskOptions } from '../../core/ask.service';
import { LISTEN_TIMEOUT_MS, RecognizerEvent, SpeechRecognizer, SpeechSpeaker } from '../../speech/speech.types';
import { MAX_QUEUED_SPEECH, TalkAsker, TalkController } from './talk.controller';
import { TALK_TEXT } from './talk.machine';

/** Every adapter call, in order, so a spec can check what happened first. */
type Log = string[];

class FakeRecognizer implements SpeechRecognizer {
  supported = true;
  listener: ((event: RecognizerEvent) => void) | null = null;
  readonly start = vi.fn((onEvent: (event: RecognizerEvent) => void) => { this.log.push('start'); this.listener = onEvent; });
  readonly stop = vi.fn(() => { this.log.push('stop'); });
  readonly abort = vi.fn(() => { this.log.push('abort'); });
  constructor(private readonly log: Log) {}
  isSupported(): boolean { return this.supported; }
  emit(event: RecognizerEvent): void { this.listener?.(event); }
}

class FakeSpeaker implements SpeechSpeaker {
  supported = true;
  voice = true;
  private resolvers: Array<() => void> = [];
  readonly spoken: string[] = [];
  readonly prime = vi.fn(() => { this.log.push('prime'); });
  readonly cancel = vi.fn(() => {
    this.log.push('cancel-speech');
    const pending = this.resolvers;
    this.resolvers = [];
    for (const resolve of pending) resolve();
  });
  readonly speak = vi.fn((text: string) => {
    this.log.push(`speak:${text}`);
    this.spoken.push(text);
    return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
  });
  constructor(private readonly log: Log) {}
  isSupported(): boolean { return this.supported; }
  hasVoice(): boolean { return this.voice; }
  speaking(): boolean { return this.resolvers.length > 0; }
  get queued(): number { return this.resolvers.length; }
  /** The utterance at the head of the queue ends. */
  async finishOne(): Promise<void> {
    this.resolvers.shift()?.();
    await flush();
  }
}

class FakeAsker implements TalkAsker {
  message: string | null = null;
  options: AskOptions | null = null;
  private resolve: (turn: DialogTurn | null) => void = () => undefined;
  readonly ask = vi.fn((text: string, _style: AskStyle, options: AskOptions) => {
    this.log.push(`ask:${text}`);
    this.options = options;
    this.message = null;
    return new Promise<DialogTurn | null>((resolve) => { this.resolve = resolve; });
  });
  readonly cancel = vi.fn(() => { this.log.push('cancel-ask'); });
  constructor(private readonly log: Log) {}
  error(): string | null { return this.message; }
  sentence(text: string): void { this.options?.onSentence?.(text); }
  async finish(turn: DialogTurn | null, message: string | null = null): Promise<void> {
    this.message = message;
    this.resolve(turn);
    await flush();
  }
}

const TURN: DialogTurn = {
  id: 't1', at: 1000, question: 'Як авто?', answer: 'Двигун прогрітий. Помилок немає.',
  style: 'spoken', source: 'voice', model: 'claude-opus-5-5', snapshotAt: 900,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('TalkController', () => {
  let log: Log;
  let recognizer: FakeRecognizer;
  let speaker: FakeSpeaker;
  let asker: FakeAsker;
  let talk: TalkController;

  beforeEach(() => {
    log = [];
    recognizer = new FakeRecognizer(log);
    speaker = new FakeSpeaker(log);
    asker = new FakeAsker(log);
    talk = new TalkController(recognizer, speaker, asker);
  });

  afterEach(() => {
    talk.destroy();
    vi.useRealTimers();
  });

  /** Tap, hear «Як авто?», and the recogniser finishes. */
  function askAloud(text = 'Як авто?'): void {
    talk.tap();
    recognizer.emit({ type: 'partial', text: 'Як' });
    recognizer.emit({ type: 'final', text });
    recognizer.emit({ type: 'end' });
  }

  it('the controller never starts recognition without a tap', () => {
    vi.useFakeTimers();
    const fresh = new TalkController(recognizer, speaker, asker);
    fresh.pageHidden();
    vi.advanceTimersByTime(10 * LISTEN_TIMEOUT_MS);
    fresh.destroy();
    expect(recognizer.start).not.toHaveBeenCalled();
    expect(speaker.speak).not.toHaveBeenCalled();
    expect(asker.ask).not.toHaveBeenCalled();
  });

  it('a tap primes the speaker and opens the microphone, in that order', () => {
    talk.tap();
    expect(log).toEqual(['prime', 'start']);
    expect(talk.model().state).toBe('listening');
  });

  it('a second tap stops listening and delivers what was heard', () => {
    talk.tap();
    talk.tap();
    expect(recognizer.stop).toHaveBeenCalledTimes(1);
    expect(recognizer.start).toHaveBeenCalledTimes(1);
    recognizer.emit({ type: 'final', text: 'Як авто?' });
    expect(asker.ask).toHaveBeenCalledWith('Як авто?', 'spoken', expect.anything());
  });

  it('stops listening after the listen timeout', () => {
    vi.useFakeTimers();
    talk.tap();
    vi.advanceTimersByTime(LISTEN_TIMEOUT_MS - 1);
    expect(recognizer.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recognizer.stop).toHaveBeenCalledTimes(1);
    recognizer.emit({ type: 'end' });
    expect(talk.model()).toMatchObject({ state: 'idle', message: TALK_TEXT.notHeard });
    vi.advanceTimersByTime(10 * LISTEN_TIMEOUT_MS);
    expect(recognizer.start).toHaveBeenCalledTimes(1);
  });

  it('closes the microphone when the page is hidden', () => {
    talk.tap();
    recognizer.emit({ type: 'partial', text: 'Як' });
    talk.pageHidden();
    expect(recognizer.abort).toHaveBeenCalledTimes(1);
    expect(talk.model()).toMatchObject({ state: 'idle', message: null, transcript: '' });
    recognizer.emit({ type: 'final', text: 'Як авто?' });    // late events of the aborted session are ignored
    recognizer.emit({ type: 'end' });
    expect(asker.ask).not.toHaveBeenCalled();
    expect(talk.model()).toMatchObject({ state: 'idle', message: null });
  });

  it('closes the microphone when destroyed', () => {
    talk.tap();
    talk.destroy();
    expect(recognizer.abort).toHaveBeenCalledTimes(1);
    expect(talk.model().state).toBe('idle');
    talk.tap();                                               // a destroyed controller does nothing
    expect(recognizer.start).toHaveBeenCalledTimes(1);
  });

  it('destroyed while answering, it cancels the request and silences speech', async () => {
    askAloud();
    asker.sentence('Двигун прогрітий.');
    talk.destroy();
    expect(asker.cancel).toHaveBeenCalled();
    expect(speaker.cancel).toHaveBeenCalled();
    await asker.finish(null);
    expect(talk.model().state).toBe('idle');
  });

  it('questions are sent with style spoken and source voice', () => {
    askAloud();
    expect(asker.ask).toHaveBeenCalledWith('Як авто?', 'spoken', expect.objectContaining({ source: 'voice' }));
    expect(talk.model()).toMatchObject({ state: 'thinking', transcript: 'Як авто?' });
  });

  it('speaks each sentence as it arrives, before the answer is complete', async () => {
    askAloud();
    asker.sentence('Двигун прогрітий.');
    expect(speaker.spoken).toEqual(['Двигун прогрітий.']);
    expect(talk.model().state).toBe('speaking');
    asker.sentence('Помилок немає.');
    expect(speaker.spoken).toEqual(['Двигун прогрітий.', 'Помилок немає.']);
    await asker.finish(TURN);
    expect(talk.model().state).toBe('speaking');
    await speaker.finishOne();
    expect(talk.model().state).toBe('speaking');
    await speaker.finishOne();
    expect(talk.model()).toMatchObject({ state: 'idle', message: null, pendingSpeech: 0 });
  });

  it('never opens the microphone again after the answer has been spoken', async () => {
    vi.useFakeTimers();
    askAloud();
    asker.sentence('Двигун прогрітий.');
    await asker.finish(TURN);
    await speaker.finishOne();
    expect(talk.model().state).toBe('idle');
    vi.advanceTimersByTime(10 * LISTEN_TIMEOUT_MS);
    await flush();
    expect(recognizer.start).toHaveBeenCalledTimes(1);
  });

  it('the controller closes the microphone before speaking', () => {
    talk.tap();
    recognizer.emit({ type: 'final', text: 'Як авто?' });   // the recogniser has not ended yet
    asker.sentence('Двигун прогрітий.');
    expect(log.indexOf('abort')).toBeGreaterThan(-1);
    expect(log.indexOf('abort')).toBeLessThan(log.indexOf('speak:Двигун прогрітий.'));
  });

  it('does not touch a microphone that has already closed', () => {
    askAloud();
    asker.sentence('Двигун прогрітий.');
    expect(recognizer.abort).not.toHaveBeenCalled();
  });

  it('a tap while speaking cancels speech and the pending request at once', async () => {
    askAloud();
    asker.sentence('Двигун прогрітий.');
    talk.tap();
    expect(asker.cancel).toHaveBeenCalledTimes(1);
    expect(speaker.cancel).toHaveBeenCalledTimes(1);
    expect(talk.model().state).toBe('idle');
    asker.sentence('Пізнє речення.');                         // a sentence already on its way is not spoken
    await asker.finish(null);
    expect(speaker.spoken).toEqual(['Двигун прогрітий.']);
    expect(talk.model()).toMatchObject({ state: 'idle', message: null });
    expect(recognizer.start).toHaveBeenCalledTimes(1);        // the barge-in tap does not reopen the microphone
  });

  it('a tap while thinking cancels the request', async () => {
    askAloud();
    talk.tap();
    expect(asker.cancel).toHaveBeenCalledTimes(1);
    expect(talk.model().state).toBe('idle');
    await asker.finish(TURN);                                 // a late answer changes nothing
    expect(talk.model().state).toBe('idle');
  });

  it('an error stops speaking and shows the message', async () => {
    askAloud();
    asker.sentence('Двигун прогрітий.');
    await asker.finish(null, 'Денний бюджет вичерпано.');
    expect(speaker.cancel).toHaveBeenCalled();
    expect(talk.model()).toMatchObject({ state: 'idle', message: 'Денний бюджет вичерпано.' });
  });

  it('a request that ends without an answer or message (cancelled elsewhere, sign-in needed) returns to idle quietly', async () => {
    askAloud();
    asker.sentence('Двигун прогрітий.');
    await asker.finish(null, null);
    expect(speaker.cancel).toHaveBeenCalled();
    expect(talk.model()).toMatchObject({ state: 'idle', message: null });
  });

  it('a rejected request shows the generic failure message', async () => {
    asker.ask.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    askAloud();
    await flush();
    expect(talk.model().state).toBe('idle');
    expect(talk.model().message).toBe('Не вдалося отримати відповідь. Перевірте з\'єднання і спробуйте ще раз.');
  });

  it('without a Ukrainian voice the answer is shown, not spoken, and the note appears', async () => {
    speaker.voice = false;
    askAloud();
    expect(talk.voiceMissing()).toBe(false);
    asker.sentence('Двигун прогрітий.');
    expect(speaker.speak).not.toHaveBeenCalled();
    expect(talk.voiceMissing()).toBe(true);
    await asker.finish(TURN);
    expect(talk.model()).toMatchObject({ state: 'idle', pendingSpeech: 0 });
  });

  it('without speech synthesis it behaves as without a voice', async () => {
    speaker.supported = false;
    askAloud();
    asker.sentence('Двигун прогрітий.');
    expect(speaker.speak).not.toHaveBeenCalled();
    expect(talk.voiceMissing()).toBe(true);
    await asker.finish(TURN);
    expect(talk.model().state).toBe('idle');
  });

  it('caps the speech queue: sentences beyond it are shown, not queued', async () => {
    askAloud();
    for (let i = 0; i < MAX_QUEUED_SPEECH + 5; i += 1) asker.sentence(`Речення номер ${i}.`);
    expect(speaker.queued).toBe(MAX_QUEUED_SPEECH);
    await speaker.finishOne();
    asker.sentence('Ще одне речення.');                       // once cut, the rest of this answer is not spoken
    expect(speaker.speak).toHaveBeenCalledTimes(MAX_QUEUED_SPEECH);
    await asker.finish(TURN);
    while (speaker.queued > 0) await speaker.finishOne();
    expect(talk.model()).toMatchObject({ state: 'idle', pendingSpeech: 0 });
  });

  it('a recogniser error shows its instruction and the next tap tries again', () => {
    talk.tap();
    recognizer.emit({ type: 'error', code: 'not-allowed' });
    recognizer.emit({ type: 'end' });
    expect(talk.model()).toMatchObject({ state: 'idle', message: TALK_TEXT.notAllowed });
    talk.tap();
    expect(recognizer.start).toHaveBeenCalledTimes(2);
    expect(talk.model()).toMatchObject({ state: 'listening', message: null });
  });

  it('a new tap starts a fresh exchange with the note cleared', async () => {
    speaker.voice = false;
    askAloud();
    asker.sentence('Двигун прогрітий.');
    await asker.finish(TURN);
    expect(talk.voiceMissing()).toBe(true);
    talk.tap();
    expect(talk.voiceMissing()).toBe(false);
  });
});
