import { describe, expect, test } from 'vitest';
import type { AlertEvent, Provenance } from '@copilot/event-engine';
import { POPUP_TEXT_MAX, cutAtWord, popupText } from './alert-text';
import { toAscii } from './translit';

function event(provenance: Provenance, title: string): AlertEvent {
  return {
    id: 'r:k:1', ruleId: 'r', dedupKey: 'k', provenance, severity: 'warning',
    title, detail: null, at: 1, active: true, clearedAt: null,
  };
}
const ccEvent = (title: string) => event('bmw-check-control', title);
const limitEvent = (title: string) => event('owner-configured', title);

describe('popupText', () => {
  test('pop-up text names the source of the alert', () => {
    expect(popupText(ccEvent('Тиск у шинах: задня ліва'))).toBe('Авто повідомляє: Тиск у шинах: задня ліва');
    expect(popupText(limitEvent('Масло 116 °C — вище вашого ліміту 115 °C'))).toBe('Ваш ліміт: Масло 116 °C — вище вашого ліміту 115 °C');
  });

  test('fault-status and service alerts are the car speaking too', () => {
    expect(popupText(event('bmw-fault-status', 'Помилка 2A87 (DME)'))).toBe('Авто повідомляє: Помилка 2A87 (DME)');
    expect(popupText(event('bmw-service', 'Моторна олива: 1200 км'))).toBe('Авто повідомляє: Моторна олива: 1200 км');
  });

  test('line breaks and runs of spaces in the car text become single spaces', () => {
    expect(popupText(ccEvent('  Тиск\nу   шинах\t'))).toBe('Авто повідомляє: Тиск у шинах');
  });

  test('text is cut to 160 characters at a word boundary', () => {
    const long = ccEvent(Array(60).fill('слово').join(' '));
    const text = popupText(long);
    expect(text.length).toBeLessThanOrEqual(POPUP_TEXT_MAX);
    expect(text.startsWith('Авто повідомляє: слово')).toBe(true);
    expect(text.endsWith('слово')).toBe(true);           // no half word at the end
    expect(text).not.toMatch(/\s$/);
  });

  test('one word longer than the limit is cut hard, never left empty', () => {
    expect(cutAtWord('x'.repeat(200), POPUP_TEXT_MAX)).toBe('x'.repeat(160));
    expect(cutAtWord('', POPUP_TEXT_MAX)).toBe('');
  });

  test('a hard cut never splits a surrogate pair', () => {
    const text = 'a'.repeat(159) + '\u{1F600}' + 'b';
    const cut = cutAtWord(text, 160);
    expect(cut).toBe('a'.repeat(159));
  });
});

describe('toAscii', () => {
  test('toAscii transliterates Ukrainian and leaves no non-ASCII character', () => {
    expect(toAscii('Тиск у шинах: задня ліва')).toBe('Tysk u shynakh: zadnia liva');
    expect(toAscii('їжак ґанок є °C')).toMatch(/^[\x20-\x7e]+$/);
  });

  test('word-initial є ї й ю я start with Y; inside a word they do not', () => {
    expect(toAscii('Євген Їжакевич Йосипівка Юрій Яготин')).toBe('Yevhen Yizhakevych Yosypivka Yurii Yahotyn');
    expect(toAscii('Мар’яна Стрий Подвір’я')).toBe('Mariana Stryi Podviria');
  });

  test('зг becomes zgh and щ becomes shch', () => {
    expect(toAscii('Розгон Щастя')).toBe('Rozghon Shchastia');
  });

  test('an all-capital word stays all capital', () => {
    expect(toAscii('ШИНИ')).toBe('SHYNY');
  });

  test('typographic dashes and quotes become ASCII, anything else non-ASCII is dropped', () => {
    expect(toAscii('Масло 116 °C — вище')).toBe('Maslo 116 C - vyshche');
    expect(toAscii('«Тест» 中文')).toBe('"Test"');
    expect(toAscii('a b\nc')).toBe('a b c');
  });

  test('the pop-up text of a limit alert in ASCII is still legible and complete', () => {
    const text = toAscii(popupText(limitEvent('Масло 116 °C — вище вашого ліміту 115 °C')));
    expect(text).toBe('Vash limit: Maslo 116 C - vyshche vashoho limitu 115 C');
  });
});
