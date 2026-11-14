import type { RecognizerErrorCode } from '../../speech/speech.types';

/**
 * The push-to-talk flow of the assistant screen as a pure state machine (plan 3, Task 3). It decides what happens;
 * `TalkController` carries the effects out. Listening starts only from a tap in `idle`.
 */

export type TalkState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface TalkModel {
  state: TalkState;
  /** What the recogniser heard (partial while listening, the question afterwards). */
  transcript: string;
  /** A Ukrainian instruction or error message to show, or null. */
  message: string | null;
  /** Utterances handed to the speaker that have not ended yet. */
  pendingSpeech: number;
  /** The answer stream has finished; `idle` follows once the last utterance ends. */
  answerDone: boolean;
}

export type TalkInput =
  | { type: 'tap' } | { type: 'stop' }
  | { type: 'partial'; text: string } | { type: 'final'; text: string }
  | { type: 'rec-error'; code: RecognizerErrorCode } | { type: 'rec-end' }
  | { type: 'sentence'; text: string } | { type: 'answer-done' } | { type: 'answer-error'; message: string }
  | { type: 'speech-ended' };

export type TalkEffect =
  | { type: 'prime-speaker' } | { type: 'start-listening' } | { type: 'stop-listening' } | { type: 'abort-listening' }
  | { type: 'ask'; text: string } | { type: 'cancel-ask' } | { type: 'speak'; text: string } | { type: 'cancel-speech' };

/** Ukrainian copy given by the plan (plan 3, Task 3, Transitions). */
export const TALK_TEXT = {
  notHeard: 'Не почув запитання. Натисніть і скажіть ще раз.',
  notAllowed: 'Дозвольте доступ до мікрофона для цієї сторінки в налаштуваннях браузера.',
  network: 'Немає мережі для розпізнавання мовлення.',
  unsupported: 'Цей браузер не розпізнає мовлення. Напишіть запитання текстом.',
  failed: 'Не вдалося розпізнати. Спробуйте ще раз.',
} as const;

export const INITIAL_TALK: TalkModel = {
  state: 'idle', transcript: '', message: null, pendingSpeech: 0, answerDone: false,
};

type Step = { model: TalkModel; effects: TalkEffect[] };

function unchanged(model: TalkModel): Step {
  return { model, effects: [] };
}

/** Back to idle: nothing is spoken or awaited any more. */
function idle(model: TalkModel, message: string | null, effects: TalkEffect[] = [], transcript = model.transcript): Step {
  return { model: { ...model, state: 'idle', transcript, message, pendingSpeech: 0, answerDone: false }, effects };
}

function recognizerMessage(code: RecognizerErrorCode): string {
  switch (code) {
    case 'not-allowed':
      return TALK_TEXT.notAllowed;
    case 'network':
      return TALK_TEXT.network;
    case 'no-speech':
      return TALK_TEXT.notHeard;
    case 'unsupported':
      return TALK_TEXT.unsupported;
    default:
      return TALK_TEXT.failed;
  }
}

function reduceIdle(model: TalkModel, input: TalkInput): Step {
  if (input.type !== 'tap') return unchanged(model);
  return {
    model: { state: 'listening', transcript: '', message: null, pendingSpeech: 0, answerDone: false },
    effects: [{ type: 'prime-speaker' }, { type: 'start-listening' }],
  };
}

function reduceListening(model: TalkModel, input: TalkInput): Step {
  switch (input.type) {
    case 'partial':
      return { model: { ...model, transcript: input.text }, effects: [] };
    case 'tap':
      // The recogniser finishes and delivers what it heard; the state changes when that result arrives.
      return { model, effects: [{ type: 'stop-listening' }] };
    case 'stop':
      // Page hidden or screen left: close the microphone and discard what was heard, without a message.
      return idle(model, null, [{ type: 'abort-listening' }], '');
    case 'final': {
      const text = input.text.trim();
      if (!text) return idle(model, TALK_TEXT.notHeard);
      return { model: { ...model, state: 'thinking', transcript: text, message: null }, effects: [{ type: 'ask', text }] };
    }
    case 'rec-end':
      return idle(model, TALK_TEXT.notHeard);
    case 'rec-error':
      return idle(model, recognizerMessage(input.code));
    default:
      return unchanged(model);
  }
}

/** `thinking` and `speaking`: an answer is on its way or being spoken. */
function reduceAnswering(model: TalkModel, input: TalkInput): Step {
  switch (input.type) {
    case 'sentence':
      return {
        model: { ...model, state: 'speaking', pendingSpeech: model.pendingSpeech + 1 },
        effects: [{ type: 'speak', text: input.text }],
      };
    case 'speech-ended': {
      if (model.state !== 'speaking') return unchanged(model);
      const pendingSpeech = Math.max(0, model.pendingSpeech - 1);
      if (pendingSpeech === 0 && model.answerDone) return idle(model, null);
      return { model: { ...model, pendingSpeech }, effects: [] };
    }
    case 'answer-done':
      if (model.pendingSpeech === 0) return idle(model, null);
      return { model: { ...model, answerDone: true }, effects: [] };
    case 'answer-error':
      return idle(model, input.message, [{ type: 'cancel-speech' }]);
    case 'tap':
    case 'stop':
      return idle(model, null, [{ type: 'cancel-ask' }, { type: 'cancel-speech' }]);
    default:
      return unchanged(model);
  }
}

/** One step of the talk flow. Any input not listed for a state leaves the model unchanged with no effects. */
export function reduce(model: TalkModel, input: TalkInput): Step {
  switch (model.state) {
    case 'idle':
      return reduceIdle(model, input);
    case 'listening':
      return reduceListening(model, input);
    default:
      return reduceAnswering(model, input);
  }
}
