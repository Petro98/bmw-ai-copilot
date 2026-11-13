import type { FastifyInstance } from 'fastify';
import type { AskResponse, AskStreamEvent } from '@copilot/shared';
import type { RouteContext } from '../app';
import { toApiError } from '../errors';
import { parseAskRequest } from '../schemas';

/**
 * `POST /api/ask` (one JSON answer) and `POST /api/ask/stream` (SSE: `delta`… then `done`, or one `error`).
 * The question text is never logged at info level: it is the owner's words.
 */
export function askRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/api/ask', async (request, reply): Promise<AskResponse> => {
    const ask = parseAskRequest(request.body);
    const controller = new AbortController();
    // The caller went away before the answer: stop the Claude request rather than pay for an answer nobody reads.
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    const turn = await ctx.assistant.ask(ask, undefined, controller.signal);
    ctx.publishStatus();   // the spend changed
    return { turn };
  });

  app.post('/api/ask/stream', async (request, reply) => {
    // Invalid input is a plain 400 before any stream opens.
    const ask = parseAskRequest(request.body);
    const stream = ctx.sse.open(reply, 'ask');
    const controller = new AbortController();
    let finished = false;
    stream.onClose(() => {
      if (!finished) controller.abort();   // a client that disconnects aborts the Claude request
    });
    const send = (event: AskStreamEvent): void => stream.send(event.type, event);

    try {
      const turn = await ctx.assistant.ask(ask, (text) => send({ type: 'delta', text }), controller.signal);
      finished = true;
      send({ type: 'done', turn });
      ctx.publishStatus();
    } catch (error) {
      finished = true;
      const { body, internal } = toApiError(error);
      if (internal) request.log.error({ err: error }, 'streamed question failed');
      else request.log.info({ code: body.error.code }, 'streamed question refused');
      send({ type: 'error', error: body.error });
    } finally {
      stream.close();
    }
  });
}
