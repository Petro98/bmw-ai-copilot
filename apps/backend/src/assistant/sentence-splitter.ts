/** A fragment shorter than this is held and joined with the next sentence, so speech does not stutter. */
export const MIN_SENTENCE_CHARS = 12;
/** Text this long without a sentence end is cut at the last space before the limit; it bounds the buffer. */
export const MAX_SENTENCE_CHARS = 300;

const TERMINATORS = new Set(['.', '!', '?', '…']);

/**
 * Words whose following full stop is an abbreviation, not a sentence end (compared in lower case):
 * «напр.», «тис.», «хв.», «год.», «км.», «див.», «тощо.», «т. ін.», «т. д.», «р.».
 */
const ABBREVIATIONS = new Set(['напр', 'тис', 'хв', 'год', 'км', 'див', 'тощо', 'ін', 'т', 'д', 'р']);

const WHITESPACE = /\s/;
const UPPERCASE = /\p{Lu}/u;
const LAST_WORD = /\p{L}+$/u;

/**
 * Turns a streamed answer into whole sentences for speech, as the text arrives.
 *
 * A sentence ends at `.`, `!`, `?` or `…` followed by whitespace. A full stop between digits (`2.4`) is never
 * followed by whitespace, so it never ends one. A "weak" end (a full stop after an abbreviation such as «напр.»
 * or «км/год.», or an ellipsis `…`/`...`) ends a sentence only when the next word starts with a capital letter.
 * A fragment shorter than {@link MIN_SENTENCE_CHARS} is joined with the next one; text longer than
 * {@link MAX_SENTENCE_CHARS} without an end is cut at the last whitespace before the limit (hard cut only for a
 * single word longer than the limit). The result does not depend on where the chunk boundaries fall, and the
 * returned sentences joined by single spaces equal the input with its whitespace normalised.
 */
export class SentenceSplitter {
  /** Not yet returned text; it starts at a non-whitespace character and stays near MAX_SENTENCE_CHARS. */
  private buffer = '';

  /** Sentences completed by this delta, trimmed. */
  push(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  /** Whatever is left, as one or more sentences; the splitter is then empty. */
  flush(): string[] {
    const out = this.drain(true);
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest !== '') out.push(rest);
    return out;
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      this.buffer = this.buffer.replace(/^\s+/, '');
      const cut = this.nextCut(final);
      if (cut === null) return out;
      out.push(this.buffer.slice(0, cut).trimEnd());
      this.buffer = this.buffer.slice(cut);
    }
  }

  /** Length of the next sentence at the start of the buffer, or null when more text is needed to decide. */
  private nextCut(final: boolean): number | null {
    const text = this.buffer;
    const window = Math.min(text.length, MAX_SENTENCE_CHARS);
    for (let i = 0; i < window; i++) {
      if (!TERMINATORS.has(text[i]!)) continue;
      const end = isEnd(text, i, final);
      if (end === undefined) {
        // Only whitespace follows a weak end; when the buffer is over the limit the cut below lands in that
        // whitespace and returns the same text the end would.
        if (text.length > MAX_SENTENCE_CHARS) break;
        return null;
      }
      if (end && i + 1 >= MIN_SENTENCE_CHARS) return i + 1;
    }
    if (text.length <= MAX_SENTENCE_CHARS) return null;
    for (let c = MAX_SENTENCE_CHARS; c > 0; c--) if (WHITESPACE.test(text[c]!)) return c;
    return MAX_SENTENCE_CHARS;   // a single "word" longer than the limit: the buffer stays bounded
  }
}

/** Whether the terminator at `i` ends a sentence; undefined when the text that decides it has not arrived. */
function isEnd(text: string, i: number, final: boolean): boolean | undefined {
  const next = i + 1;
  if (next >= text.length) return final ? true : undefined;
  if (!WHITESPACE.test(text[next]!)) return false;
  if (!isWeak(text, i)) return true;
  let k = next;
  while (k < text.length && WHITESPACE.test(text[k]!)) k++;
  if (k >= text.length) return final ? true : undefined;
  return UPPERCASE.test(text[k]!);
}

/** An ellipsis, or a full stop right after a listed abbreviation. */
function isWeak(text: string, i: number): boolean {
  const char = text[i];
  if (char === '…') return true;
  if (char !== '.') return false;
  if (i > 0 && text[i - 1] === '.') return true;
  const word = LAST_WORD.exec(text.slice(Math.max(0, i - 8), i));
  return word !== null && ABBREVIATIONS.has(word[0].toLowerCase());
}
