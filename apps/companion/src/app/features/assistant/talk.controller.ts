import { Signal, signal } from '@angular/core';
import type { AskStyle, DialogTurn } from '@copilot/shared';
import { ASK_FAILED_MESSAGE, AskOptions } from '../../core/ask.service';
import { LISTEN_TIMEOUT_MS, RecognizerEvent, SpeechRecognizer, SpeechSpeaker } from '../../speech/speech.types';
import { INITIAL_TALK, TalkEffect, TalkInput, TalkModel, reduce } from './talk.machine';

/** Shown when the phone cannot speak Ukrainian (plan 3, Task 3). */
export const NO_VOICE_TEXT = 'На цьому телефоні немає українського голосу. Відповідь показано текстом.';

/**
 * At most this many sentences wait in the speaker at once. A spoken answer is a few sentences of at most
 * 300 characters each (backend `MAX_SENTENCE_CHARS`); once an answer exceeds the cap, the rest of it is shown as
 * text only, so speech never runs out of order and nothing queues without bound.
 */
export const MAX_QUEUED_SPEECH = 8;

/** The part of `AskService` the talk flow uses (`AskService` itself satisfies it). */
export interface TalkAsker {
  ask(text: string, style: AskStyle, options: AskOptions): Promise<DialogTurn | null>;
  cancel(): void;
  /** The Ukrainian message of the last failed question, or null. */
  error(): string | null;
}

/**
 * Runs the effects of the talk machine against the speech adapters and the asker, and feeds their events back.
 * The microphone opens only from `tap()`; it closes on the result, a second tap, the listen timeout, a hidden page,
 * before any speech, and on `destroy()`.
 */
export class TalkController {
  private readonly modelState = signal<TalkModel>(INITIAL_TALK);
  private readonly voiceMissingState = signal(false);

  readonly model: Signal<TalkModel> = this.modelState.asReadonly();
  /** True once an answer could not be spoken because the phone has no Ukrainian voice. */
  readonly voiceMissing: Signal<boolean> = this.voiceMissingState.asReadonly();

  private readonly inbox: TalkInput[] = [];
  private draining = false;
  private destroyed = false;

  /** Bumped to ignore events from a listening session, a request or utterances that were dropped. */
  private listenRun = 0;
  private askRun = 0;
  private speechRun = 0;

  private micOpen = false;
  private listenTimer: ReturnType<typeof setTimeout> | null = null;
  private queuedSpeech = 0;
  private speechCut = false;

  constructor(
    private readonly recognizer: SpeechRecognizer,
    private readonly speaker: SpeechSpeaker,
    private readonly asker: TalkAsker,
  ) {}

  /** The owner tapped the talk button: start, finish listening, or stop the answer (barge-in). */
  tap(): void {
    if (this.destroyed) return;
    if (this.modelState().state === 'idle') this.voiceMissingState.set(false);
    this.dispatch({ type: 'tap' });
  }

  /** The page went to the background: the microphone closes; an answer already being spoken carries on. */
  pageHidden(): void {
    if (this.destroyed || this.modelState().state !== 'listening') return;
    this.dispatch({ type: 'stop' });
  }

  /** The screen is gone: close the microphone, cancel the request and silence speech. */
  destroy(): void {
    if (this.destroyed) return;
    this.dispatch({ type: 'stop' });
    this.destroyed = true;
    this.clearListenTimer();
    if (this.micOpen) this.closeMicrophone();
  }

  /** Inputs are queued so that an adapter answering synchronously never re-enters `reduce`. */
  private dispatch(input: TalkInput): void {
    if (this.destroyed) return;
    this.inbox.push(input);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.inbox.shift(); next; next = this.inbox.shift()) {
        const step = reduce(this.modelState(), next);
        this.modelState.set(step.model);
        for (const effect of step.effects) this.run(effect);
        if (step.model.state !== 'listening') this.clearListenTimer();
      }
    } finally {
      this.draining = false;
    }
  }

  private run(effect: TalkEffect): void {
    switch (effect.type) {
      case 'prime-speaker':
        if (this.speaker.isSupported()) this.speaker.prime();
        return;
      case 'start-listening':
        this.startListening();
        return;
      case 'stop-listening':
        this.recognizer.stop();
        return;
      case 'abort-listening':
        this.closeMicrophone();
        return;
      case 'ask':
        this.askQuestion(effect.text);
        return;
      case 'cancel-ask':
        this.askRun += 1;
        this.asker.cancel();
        return;
      case 'speak':
        this.speak(effect.text);
        return;
      case 'cancel-speech':
        this.speechRun += 1;
        this.queuedSpeech = 0;
        this.speaker.cancel();
        return;
    }
  }

  private startListening(): void {
    const run = ++this.listenRun;
    this.micOpen = true;
    this.clearListenTimer();
    // The recogniser has its own limit too; this one holds for any recogniser behind the adapter.
    this.listenTimer = setTimeout(() => {
      this.listenTimer = null;
      if (run === this.listenRun && this.modelState().state === 'listening') this.recognizer.stop();
    }, LISTEN_TIMEOUT_MS);
    this.recognizer.start((event) => {
      if (run === this.listenRun) this.onRecognizer(event);
    });
  }

  private onRecognizer(event: RecognizerEvent): void {
    switch (event.type) {
      case 'partial':
        this.dispatch({ type: 'partial', text: event.text });
        return;
      case 'final':
        this.dispatch({ type: 'final', text: event.text });
        return;
      case 'error':
        this.dispatch({ type: 'rec-error', code: event.code });
        return;
      case 'end':
        this.micOpen = false;
        this.dispatch({ type: 'rec-end' });
        return;
    }
  }

  /** Discards the listening session and ignores whatever it still reports. */
  private closeMicrophone(): void {
    this.listenRun += 1;
    this.micOpen = false;
    this.recognizer.abort();
  }

  private askQuestion(text: string): void {
    const run = ++this.askRun;
    this.speechCut = false;
    this.queuedSpeech = 0;
    const current = () => run === this.askRun && !this.destroyed;
    const options: AskOptions = {
      source: 'voice',
      onSentence: (sentence) => { if (current()) this.dispatch({ type: 'sentence', text: sentence }); },
    };
    let answer: Promise<DialogTurn | null>;
    try {
      answer = this.asker.ask(text, 'spoken', options);
    } catch {
      answer = Promise.reject(new Error('ask failed'));
    }
    answer.then(
      (turn) => {
        if (!current()) return;
        if (turn) {
          this.dispatch({ type: 'answer-done' });
          return;
        }
        const message = this.asker.error();
        // No message: the request was cancelled elsewhere or the owner is being sent to sign in.
        this.dispatch(message ? { type: 'answer-error', message } : { type: 'stop' });
      },
      () => {
        if (current()) this.dispatch({ type: 'answer-error', message: ASK_FAILED_MESSAGE });
      },
    );
  }

  private speak(text: string): void {
    // The microphone is closed while the phone is speaking.
    if (this.micOpen) this.closeMicrophone();
    if (!this.speaker.isSupported() || !this.speaker.hasVoice()) {
      this.voiceMissingState.set(true);
      this.dispatch({ type: 'speech-ended' });
      return;
    }
    if (this.speechCut || this.queuedSpeech >= MAX_QUEUED_SPEECH) {
      this.speechCut = true;
      this.dispatch({ type: 'speech-ended' });
      return;
    }
    const run = this.speechRun;
    this.queuedSpeech += 1;
    this.speaker.speak(text).then(() => {
      if (run !== this.speechRun) return;
      this.queuedSpeech = Math.max(0, this.queuedSpeech - 1);
      this.dispatch({ type: 'speech-ended' });
    }, () => {
      if (run !== this.speechRun) return;
      this.queuedSpeech = Math.max(0, this.queuedSpeech - 1);
      this.dispatch({ type: 'speech-ended' });
    });
  }

  private clearListenTimer(): void {
    if (this.listenTimer !== null) {
      clearTimeout(this.listenTimer);
      this.listenTimer = null;
    }
  }
}
