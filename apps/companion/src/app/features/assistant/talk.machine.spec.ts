import { INITIAL_TALK, TALK_TEXT, TalkEffect, TalkInput, TalkModel, reduce } from './talk.machine';

/** Feeds the inputs in order and collects every effect. */
function run(inputs: TalkInput[], from: TalkModel = INITIAL_TALK): { model: TalkModel; effects: TalkEffect[] } {
  let model = from;
  const effects: TalkEffect[] = [];
  for (const input of inputs) {
    const step = reduce(model, input);
    model = step.model;
    effects.push(...step.effects);
  }
  return { model, effects };
}

const LISTENING = run([{ type: 'tap' }]).model;
const THINKING = run([{ type: 'tap' }, { type: 'final', text: 'Як авто?' }]).model;
const SPEAKING = run([{ type: 'sentence', text: 'Двигун прогрітий.' }], THINKING).model;

describe('talk machine', () => {
  it('walks idle → listening → thinking → speaking → idle for a normal exchange', () => {
    const states: string[] = [];
    let model = INITIAL_TALK;
    const effects: TalkEffect[] = [];
    const inputs: TalkInput[] = [
      { type: 'tap' }, { type: 'partial', text: 'Як' }, { type: 'final', text: 'Як авто?' },
      { type: 'sentence', text: 'Двигун прогрітий.' }, { type: 'sentence', text: 'Помилок немає.' },
      { type: 'answer-done' }, { type: 'speech-ended' }, { type: 'speech-ended' },
    ];
    for (const input of inputs) {
      const step = reduce(model, input);
      model = step.model;
      effects.push(...step.effects);
      states.push(model.state);
    }
    expect(states).toEqual(['listening', 'listening', 'thinking', 'speaking', 'speaking', 'speaking', 'speaking', 'idle']);
    expect(effects).toEqual([
      { type: 'prime-speaker' }, { type: 'start-listening' }, { type: 'ask', text: 'Як авто?' },
      { type: 'speak', text: 'Двигун прогрітий.' }, { type: 'speak', text: 'Помилок немає.' },
    ]);
    expect(model.message).toBeNull();
    expect(model.pendingSpeech).toBe(0);
  });

  it('a tap from idle clears the transcript and the message', () => {
    const failed = run([{ type: 'tap' }, { type: 'partial', text: 'Як' }, { type: 'rec-end' }]).model;
    expect(failed.message).toBe(TALK_TEXT.notHeard);
    const again = reduce(failed, { type: 'tap' }).model;
    expect(again).toMatchObject({ state: 'listening', transcript: '', message: null });
  });

  it('partial results update the transcript while listening', () => {
    expect(reduce(LISTENING, { type: 'partial', text: 'Як ав' }).model.transcript).toBe('Як ав');
  });

  it('a second tap while listening asks the recogniser to finish and waits for its result', () => {
    const step = reduce(LISTENING, { type: 'tap' });
    expect(step.effects).toEqual([{ type: 'stop-listening' }]);
    expect(step.model.state).toBe('listening');
  });

  it('a stop while listening closes the microphone, discards what was heard and returns to idle', () => {
    const step = reduce({ ...LISTENING, transcript: 'Як' }, { type: 'stop' });
    expect(step.effects).toEqual([{ type: 'abort-listening' }]);
    expect(step.model).toMatchObject({ state: 'idle', transcript: '', message: null });
  });

  it('a blank result returns to idle with the "did not hear" message and asks nothing', () => {
    for (const ending of [
      [{ type: 'final', text: '   ' }], [{ type: 'rec-end' }], [{ type: 'rec-error', code: 'no-speech' }],
    ] as TalkInput[][]) {
      const { model, effects } = run(ending, LISTENING);
      expect(model.state).toBe('idle');
      expect(model.message).toBe('Не почув запитання. Натисніть і скажіть ще раз.');
      expect(effects.some((e) => e.type === 'ask')).toBe(false);
    }
  });

  it.each([
    ['not-allowed', 'Дозвольте доступ до мікрофона'],
    ['network', 'Немає мережі'],
    ['unsupported', 'Напишіть запитання текстом'],
    ['other', 'Не вдалося розпізнати'],
    ['aborted', 'Не вдалося розпізнати'],
  ] as const)('recogniser error %s shows the right instruction', (code, words) => {
    const { model, effects } = run([{ type: 'rec-error', code }, { type: 'rec-end' }], LISTENING);
    expect(model.state).toBe('idle');
    expect(model.message).toContain(words);
    expect(effects).toEqual([]);
  });

  it('the exact Ukrainian instructions', () => {
    expect(TALK_TEXT).toEqual({
      notHeard: 'Не почув запитання. Натисніть і скажіть ще раз.',
      notAllowed: 'Дозвольте доступ до мікрофона для цієї сторінки в налаштуваннях браузера.',
      network: 'Немає мережі для розпізнавання мовлення.',
      unsupported: 'Цей браузер не розпізнає мовлення. Напишіть запитання текстом.',
      failed: 'Не вдалося розпізнати. Спробуйте ще раз.',
    });
  });

  it('a tap while speaking cancels speech and the request and returns to idle', () => {
    for (const input of [{ type: 'tap' }, { type: 'stop' }] as TalkInput[]) {
      for (const from of [THINKING, SPEAKING]) {
        const step = reduce(from, input);
        expect(step.effects).toEqual([{ type: 'cancel-ask' }, { type: 'cancel-speech' }]);
        expect(step.model).toMatchObject({ state: 'idle', pendingSpeech: 0, answerDone: false });
      }
    }
  });

  it('an answer error cancels speech and shows the server message', () => {
    for (const from of [THINKING, SPEAKING]) {
      const step = reduce(from, { type: 'answer-error', message: 'Денний бюджет вичерпано.' });
      expect(step.effects).toEqual([{ type: 'cancel-speech' }]);
      expect(step.model).toMatchObject({ state: 'idle', message: 'Денний бюджет вичерпано.', pendingSpeech: 0 });
    }
  });

  it('stays speaking until the last utterance ends even if the answer finished earlier', () => {
    let model = run([{ type: 'sentence', text: 'Друге речення.' }, { type: 'answer-done' }], SPEAKING).model;
    expect(model).toMatchObject({ state: 'speaking', pendingSpeech: 2, answerDone: true });
    model = reduce(model, { type: 'speech-ended' }).model;
    expect(model).toMatchObject({ state: 'speaking', pendingSpeech: 1 });
    model = reduce(model, { type: 'speech-ended' }).model;
    expect(model).toMatchObject({ state: 'idle', pendingSpeech: 0 });
  });

  it('stays speaking while sentences are still being spoken and the answer is not finished', () => {
    const model = reduce(SPEAKING, { type: 'speech-ended' }).model;
    expect(model).toMatchObject({ state: 'speaking', pendingSpeech: 0, answerDone: false });
    expect(reduce(model, { type: 'answer-done' }).model.state).toBe('idle');
  });

  it('an answer without sentences returns to idle when it is done', () => {
    expect(reduce(THINKING, { type: 'answer-done' }).model.state).toBe('idle');
  });

  it('inputs that do not apply to the current state change nothing', () => {
    const cases: Array<[TalkModel, TalkInput[]]> = [
      [INITIAL_TALK, [
        { type: 'stop' }, { type: 'partial', text: 'x' }, { type: 'final', text: 'x' }, { type: 'rec-end' },
        { type: 'rec-error', code: 'network' }, { type: 'sentence', text: 'x' }, { type: 'answer-done' },
        { type: 'answer-error', message: 'x' }, { type: 'speech-ended' },
      ]],
      [LISTENING, [{ type: 'sentence', text: 'x' }, { type: 'answer-done' }, { type: 'answer-error', message: 'x' }, { type: 'speech-ended' }]],
      [THINKING, [{ type: 'partial', text: 'x' }, { type: 'final', text: 'x' }, { type: 'rec-end' }, { type: 'rec-error', code: 'network' }, { type: 'speech-ended' }]],
      [SPEAKING, [{ type: 'partial', text: 'x' }, { type: 'final', text: 'x' }, { type: 'rec-end' }, { type: 'rec-error', code: 'not-allowed' }]],
    ];
    for (const [model, inputs] of cases) {
      for (const input of inputs) {
        const step = reduce(model, input);
        expect(step.model).toBe(model);
        expect(step.effects).toEqual([]);
      }
    }
  });

  it('never starts listening except on a tap from idle', () => {
    const inputs: TalkInput[] = [
      { type: 'stop' }, { type: 'partial', text: 'x' }, { type: 'final', text: 'x' }, { type: 'rec-end' },
      { type: 'rec-error', code: 'no-speech' }, { type: 'sentence', text: 'x' }, { type: 'answer-done' },
      { type: 'answer-error', message: 'x' }, { type: 'speech-ended' }, { type: 'tap' },
    ];
    for (const from of [INITIAL_TALK, LISTENING, THINKING, SPEAKING]) {
      for (const input of inputs) {
        const starts = reduce(from, input).effects.some((e) => e.type === 'start-listening');
        expect(starts).toBe(from === INITIAL_TALK && input.type === 'tap');
      }
    }
  });
});
