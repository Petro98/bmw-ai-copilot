import type { FastifyInstance } from 'fastify';
import type { AskResponse, AskStreamEvent } from '@copilot/shared';
import { SentenceSplitter } from '../../assistant/sentence-splitter';
import type { RouteContext } from '../app';
import { toApiError } from '../errors';
import { parseAskRequest } from '../schemas';

/**
 * `POST /api/ask` (one JSON answer) and `POST /api/ask/stream` (SSE: `delta`… then `done`, or one `error`).
 * For `style: 'spoken'` the stream also carries `sentence` events, each whole sentence as soon as it is complete;
 * the remainder is flushed before `done`, and nothing follows an `error`.
 * The question text is never logged at info level: it is the owner's words.
 */
export function askRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // Questions still waiting for Claude. Shutdown aborts them, so closing the server does not wait up to
  // CLAUDE_TIMEOUT_MS for answers (the container's stop grace period is shorter).
  const inFlight = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const controller of Array.from(inFlight)) controller.abort();
  });

  app.post('/api/ask', async (request, reply): Promise<AskResponse> => {
    const ask = parseAskRequest(request.body);
    const controller = new AbortController();
    // The caller went away before the answer: stop the Claude request rather than pay for an answer nobody reads.
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    inFlight.add(controller);
    try {
      const turn = await ctx.assistant.ask(ask, undefined, controller.signal);
      return { turn };
    } finally {
      inFlight.delete(controller);
      ctx.publishStatus();   // the spend may have changed, also by a billed refusal
    }
  });

  app.post('/api/ask/stream', async (request, reply) => {
    // Invalid input is a plain 400 before any stream opens.
    const ask = parseAskRequest(request.body);
    const stream = ctx.sse.open(reply, 'ask');
    const controller = new AbortController();
    inFlight.add(controller);
    let finished = false;
    stream.onClose(() => {
      if (!finished) controller.abort();   // a client that disconnects aborts the Claude request
    });
    const send = (event: AskStreamEvent): void => stream.send(event.type, event);
    // A spoken answer also goes out sentence by sentence, so the phone can start speaking before it is complete.
    const splitter = ask.style === 'spoken' ? new SentenceSplitter() : null;
    const sendSentences = (sentences: string[]): void => {
      for (const text of sentences) send({ type: 'sentence', text });
    };
    const onDelta = (text: string): void => {
      send({ type: 'delta', text });
      if (splitter) sendSentences(splitter.push(text));
    };

    try {
      const turn = await ctx.assistant.ask(ask, onDelta, controller.signal);
      finished = true;
      if (splitter) sendSentences(splitter.flush());   // the rest of the answer, before done; never after an error
      send({ type: 'done', turn });
    } catch (error) {
      finished = true;
      const { body, internal } = toApiError(error);
      if (internal) request.log.error({ err: error }, 'streamed question failed');
      else request.log.info({ code: body.error.code }, 'streamed question refused');
      send({ type: 'error', error: body.error });
    } finally {
      inFlight.delete(controller);
      stream.close();
      ctx.publishStatus();   // the spend may have changed, also by a billed refusal
    }
  });
}
