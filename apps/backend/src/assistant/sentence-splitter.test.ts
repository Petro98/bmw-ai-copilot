import { describe, expect, test } from 'vitest';
import { MAX_SENTENCE_CHARS, MIN_SENTENCE_CHARS, SentenceSplitter } from './sentence-splitter';

/** Feeds `text` in chunks of `size` characters and returns everything `push` and `flush` returned, in order. */
function splitInChunks(text: string, size: number): string[] {
  const s = new SentenceSplitter();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)));
  out.push(...s.flush());
  return out;
}

const normalised = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A fixed 400-character answer with decimals, abbreviations, short fragments, an ellipsis and no final full stop. */
const ANSWER = (
  'Так. Двигун прогрітий: масло 92 °C, охолоджувальна рідина 0.3 бар понад норму. ' +
  'Тиск у шинах 2,4 бар спереду і 2,6 бар ззаду, див. розділ про шини. ' +
  'Фільтри, свічки тощо. Наступне ТО через 12 тис. км або 8 хв. роботи на холостому ходу… ' +
  'Швидкість 60 км/год. на трасі та 40 км/год. у місті! Чи все гаразд? Ні. ' +
  'Активних повідомлень немає, напр. про оливу, гальма, т. д. і т. ін. ' +
  'Перевірте тиск у шинах після поїздки'
);

describe('SentenceSplitter', () => {
  test('the limits are the planned constants', () => {
    expect(MIN_SENTENCE_CHARS).toBe(12);
    expect(MAX_SENTENCE_CHARS).toBe(300);
  });

  test('splits on sentence ends as text streams in', () => {
    const s = new SentenceSplitter();
    expect(s.push('Двигун прогрітий: масло 92 °C. Активних повідом')).toEqual(['Двигун прогрітий: масло 92 °C.']);
    expect(s.push('лень немає. ')).toEqual(['Активних повідомлень немає.']);
    expect(s.flush()).toEqual([]);
  });

  test('ends on !, ? and … followed by whitespace', () => {
    const s = new SentenceSplitter();
    expect(s.push('Тиск у шинах впав! Перевірте колеса? Зачекайте хвилинку… Двигун гарячий. ')).toEqual([
      'Тиск у шинах впав!', 'Перевірте колеса?', 'Зачекайте хвилинку…', 'Двигун гарячий.',
    ]);
  });

  test('does not split inside decimals or after abbreviations', () => {
    const s = new SentenceSplitter();
    expect(s.push('Тиск 2,3 бар спереду і 2.4 бар ззаду, напр. після поїздки. ')).toEqual(['Тиск 2,3 бар спереду і 2.4 бар ззаду, напр. після поїздки.']);
  });

  test('a decimal point split across two deltas is not a sentence end', () => {
    const s = new SentenceSplitter();
    expect(s.push('Відхилення тиску 0.')).toEqual([]);
    expect(s.push('3 бар у межах норми. ')).toEqual(['Відхилення тиску 0.3 бар у межах норми.']);
  });

  test.each([
    ['див.', 'Деталі в описі, див. розділ про шини. '],
    ['т. д.', 'Масло, фільтри, свічки, т. д. все в нормі. '],
    ['т. ін.', 'Масло, фільтри, свічки, т. ін. все в нормі. '],
    ['км/год.', 'Їдьте не швидше 60 км/год. на трасі сьогодні. '],
    ['тис.', 'Пробіг до ТО 12 тис. км за даними авто. '],
    ['хв.', 'Двигун прогрівався 8 хв. після запуску сьогодні. '],
  ])('an abbreviation (%s) followed by a lowercase letter does not end the sentence', (_name, text) => {
    expect(splitInChunks(text, 1)).toEqual([text.trim()]);
  });

  test('an abbreviation that closes a sentence before a capital letter ends it', () => {
    expect(splitInChunks('Швидкість на трасі 60 км/год. Двигун прогрітий нормально. ', 3)).toEqual([
      'Швидкість на трасі 60 км/год.', 'Двигун прогрітий нормально.',
    ]);
    expect(splitInChunks('Масло, фільтри, свічки тощо. Усе в нормі сьогодні. ', 5)).toEqual([
      'Масло, фільтри, свічки тощо.', 'Усе в нормі сьогодні.',
    ]);
  });

  test('an ellipsis inside a sentence does not end it', () => {
    expect(splitInChunks('Тиск у шинах… нормальний для зими. Двигун... теж у нормі. ', 1)).toEqual([
      'Тиск у шинах… нормальний для зими.', 'Двигун... теж у нормі.',
    ]);
  });

  test('a unit at the very end stays whole', () => {
    const s = new SentenceSplitter();
    expect(s.push('Температура масла 92 °C.')).toEqual([]);
    expect(s.flush()).toEqual(['Температура масла 92 °C.']);
  });

  test('joins a very short fragment with the next sentence', () => {
    const s = new SentenceSplitter();
    expect(s.push('Так. Двигун прогрітий. ')).toEqual(['Так. Двигун прогрітий.']);
    expect(s.flush()).toEqual([]);
  });

  test('a short last fragment is returned by flush', () => {
    const s = new SentenceSplitter();
    expect(s.push('Двигун прогрітий. Так.')).toEqual(['Двигун прогрітий.']);
    expect(s.flush()).toEqual(['Так.']);
  });

  test('flush returns an answer that has no final punctuation', () => {
    const s = new SentenceSplitter();
    expect(s.push('Активних повідомлень немає. Двигун прогрітий')).toEqual(['Активних повідомлень немає.']);
    expect(s.flush()).toEqual(['Двигун прогрітий']);
    expect(s.flush()).toEqual([]);
  });

  test('flush on an empty or whitespace-only stream returns nothing', () => {
    const s = new SentenceSplitter();
    expect(s.flush()).toEqual([]);
    expect(s.push('  \n ')).toEqual([]);
    expect(s.flush()).toEqual([]);
  });

  test('cuts a 600-character run without punctuation at spaces, losing nothing', () => {
    const words = ['тиск', 'масло', 'двигун', 'шина', 'гальма', 'охолодження', 'рідина'];
    let run = '';
    for (let i = 0; run.length < 600; i++) run += `${words[i % words.length]} `;
    run = run.trim();
    expect(run.length).toBeGreaterThanOrEqual(600);

    for (const size of [1, 7, 600]) {
      const s = new SentenceSplitter();
      const pushed: string[] = [];
      for (let i = 0; i < run.length; i += size) pushed.push(...s.push(run.slice(i, i + size)));
      // The buffer is bounded: long text comes out before the stream ends.
      expect(pushed.length).toBeGreaterThanOrEqual(1);
      const all = [...pushed, ...s.flush()];
      expect(all.length).toBeGreaterThanOrEqual(3);
      for (const piece of all) {
        expect(piece.length).toBeLessThanOrEqual(MAX_SENTENCE_CHARS);
        expect(piece).toBe(piece.trim());
        // Cut at spaces only: every piece is made of whole words.
        for (const word of piece.split(' ')) expect(words).toContain(word);
      }
      expect(all.join(' ')).toBe(normalised(run));
    }
  });

  test('a long sentence whose end arrives late is cut the same way however it is chunked', () => {
    const long = `${'двигун прогрітий '.repeat(25)}усе гаразд. Наступне речення тут. `;
    const whole = splitInChunks(long, long.length);
    expect(whole.every((piece) => piece.length <= MAX_SENTENCE_CHARS)).toBe(true);
    expect(whole.join(' ')).toBe(normalised(long));
    for (const size of [1, 2, 3, 7, 50]) expect(splitInChunks(long, size)).toEqual(whole);
  });

  test('every character is returned exactly once, in order, for random chunk boundaries', () => {
    expect(ANSWER.length).toBeGreaterThanOrEqual(380);
    expect(ANSWER.length).toBeLessThanOrEqual(420);
    const whole = splitInChunks(ANSWER, ANSWER.length);
    expect(whole).toEqual([
      'Так. Двигун прогрітий: масло 92 °C, охолоджувальна рідина 0.3 бар понад норму.',
      'Тиск у шинах 2,4 бар спереду і 2,6 бар ззаду, див. розділ про шини.',
      'Фільтри, свічки тощо.',
      'Наступне ТО через 12 тис. км або 8 хв. роботи на холостому ходу…',
      'Швидкість 60 км/год. на трасі та 40 км/год. у місті!',
      'Чи все гаразд?',
      'Ні. Активних повідомлень немає, напр. про оливу, гальма, т. д. і т. ін.',
      'Перевірте тиск у шинах після поїздки',
    ]);
    expect(whole.join(' ')).toBe(normalised(ANSWER));
    for (const size of [1, 2, 3, 7, 50]) expect(splitInChunks(ANSWER, size)).toEqual(whole);

    // Arbitrary (seeded) chunk boundaries give the same sentences.
    let seed = 7;
    const random = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 20; round++) {
      const s = new SentenceSplitter();
      const out: string[] = [];
      for (let i = 0; i < ANSWER.length;) {
        const size = 1 + Math.floor(random() * 40);
        out.push(...s.push(ANSWER.slice(i, i + size)));
        i += size;
      }
      out.push(...s.flush());
      expect(out).toEqual(whole);
    }
  });
});
