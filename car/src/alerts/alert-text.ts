/**
 * The words of the BMW small pop-up. Every pop-up names where the alert comes from (docs/design/README.md:
 * a limit the owner typed in is always called the owner's, never the manufacturer's): the car's own messages
 * (Check Control, a fault read, a service item) start «Авто повідомляє:», an owner limit «Ваш ліміт:».
 */
import type { AlertEvent, Provenance } from '@copilot/event-engine';

/** The pop-up text is cut to this many characters, at a word boundary. */
export const POPUP_TEXT_MAX = 160;

const PREFIX: Record<Provenance, string> = {
  'bmw-check-control': 'Авто повідомляє: ',
  'bmw-fault-status': 'Авто повідомляє: ',
  'bmw-service': 'Авто повідомляє: ',
  'owner-configured': 'Ваш ліміт: ',
};

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Cuts text to at most max UTF-16 units: at the last whitespace that keeps it within max, or hard at max when
 * the first word alone is longer (never through a surrogate pair). Trailing whitespace is removed.
 */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const space = text.lastIndexOf(' ', max);
  let cut = space > 0 ? space : max;
  if (cut === max && isHighSurrogate(text.charCodeAt(cut - 1))) cut--;
  return text.slice(0, cut).replace(/\s+$/, '');
}

/** One line: line breaks, tabs and runs of spaces become single spaces. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** «Авто повідомляє: <title>» or «Ваш ліміт: <title>», one line, at most POPUP_TEXT_MAX characters. */
export function popupText(event: AlertEvent): string {
  const prefix = PREFIX[event.provenance] || PREFIX['bmw-check-control'];
  const title = typeof event.title === 'string' ? oneLine(event.title) : '';
  return cutAtWord(prefix + title, POPUP_TEXT_MAX);
}
