import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import type { AskRequest, AskStreamEvent, DialogTurn } from '@copilot/shared';
import { AssistantError } from '../assistant/assistant-service';
import type { RouteContext } from './app';
import { askRoutes } from './routes/ask';
import { SseRegistry } from './sse';

/** A spoken answer streamed in uneven chunks: decimals, an abbreviation, a short fragment, no final full stop. */
const CHUNKS = [
  'Так. Двигун прогр', 'ітий: масло 92 °C, тиск 2,', '4 бар. Активних повідомлень немає, напр. про', ' оливу. ',
  'Перевірте шини після поїздки',
];

type Script = { chunks: string[]; fail?: AssistantError };

const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** The ask routes alone, on a bare Fastify instance, with an assistant that streams a fixed script. */
async function streamApp(script: Script): Promise<{ app: FastifyInstance; requests: AskRequest[] }> {
  const requests: AskRequest[] = [];
  const assistant = {
    async ask(request: AskRequest, onDelta?: (text: string) => void): Promise<DialogTurn> {
      requests.push(request);
      for (const chunk of script.chunks) onDelta?.(chunk);
      if (script.fail) throw script.fail;
      return {
        id: 'turn-1', at: 0, question: request.text, answer: script.chunks.join(''),
        style: request.style ?? 'full', source: request.source ?? 'panel', model: 'mock', snapshotAt: null,
      };
    },
  };
  const ctx = { sse: new SseRegistry(), assistant, publishStatus: () => undefined } as unknown as RouteContext;
  const app = Fastify();
  askRoutes(app, ctx);
  await app.ready();
  apps.push(app);
  return { app, requests };
}

function parseSse(text: string): AskStreamEvent[] {
  const out: AskStreamEvent[] = [];
  for (const block of text.split('\n\n')) {
    let data = '';
    let event = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (data === '') continue;
    const parsed = JSON.parse(data) as AskStreamEvent;
    expect(parsed.type).toBe(event);
    out.push(parsed);
  }
  return out;
}

const textsOf = (events: AskStreamEvent[], type: 'delta' | 'sentence'): string[] =>
  events.flatMap((event) => (event.type === type ? [event.text] : []));

describe('POST /api/ask/stream sentence events', () => {
  test('the spoken stream carries sentence events and the full stream does not', async () => {
    const { app } = await streamApp({ chunks: CHUNKS });

    const spoken = await app.inject({
      method: 'POST', url: '/api/ask/stream', payload: { text: 'Як авто?', style: 'spoken', source: 'voice' },
    });
    expect(spoken.statusCode).toBe(200);
    const events = parseSse(spoken.body);
    expect(textsOf(events, 'delta')).toEqual(CHUNKS);
    expect(textsOf(events, 'sentence')).toEqual([
      'Так. Двигун прогрітий: масло 92 °C, тиск 2,4 бар.',
      'Активних повідомлень немає, напр. про оливу.',
      'Перевірте шини після поїздки',
    ]);
    // The remainder is flushed before done, and done is last.
    const last = events.at(-1)!;
    expect(last.type).toBe('done');
    expect(events.at(-2)).toEqual({ type: 'sentence', text: 'Перевірте шини після поїздки' });
    const done = last as Extract<AskStreamEvent, { type: 'done' }>;
    expect(textsOf(events, 'sentence').join(' ')).toBe(done.turn.answer.replace(/\s+/g, ' ').trim());
    // A sentence goes out as soon as the delta that completes it: right after that delta, before the next one.
    const firstSentence = events.findIndex((event) => event.type === 'sentence');
    expect(events[firstSentence - 1]).toEqual({ type: 'delta', text: CHUNKS[2] });

    for (const payload of [{ text: 'Як авто?', style: 'full' }, { text: 'Як авто?' }]) {
      const full = await app.inject({ method: 'POST', url: '/api/ask/stream', payload });
      const fullEvents = parseSse(full.body);
      expect(fullEvents.filter((event) => event.type === 'sentence')).toEqual([]);
      expect(textsOf(fullEvents, 'delta')).toEqual(CHUNKS);
      expect(fullEvents.at(-1)!.type).toBe('done');
    }
  });

  test('after an error nothing more is sent: the held remainder is not flushed', async () => {
    const fail = new AssistantError('claude-unavailable', 'Claude зараз недоступний.');
    const { app } = await streamApp({ chunks: ['Двигун прогрітий нормально. Тиск у ши', 'нах 2,'], fail });
    const response = await app.inject({
      method: 'POST', url: '/api/ask/stream', payload: { text: 'Як авто?', style: 'spoken', source: 'voice' },
    });
    const events = parseSse(response.body);
    expect(textsOf(events, 'sentence')).toEqual(['Двигун прогрітий нормально.']);
    expect(events.at(-1)).toEqual({ type: 'error', error: { code: 'claude-unavailable', message: 'Claude зараз недоступний.' } });
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });
});
