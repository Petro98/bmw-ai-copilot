import type { FastifyInstance } from 'fastify';
import type { LiveEvent } from '@copilot/shared';
import type { RouteContext } from '../app';
import { HttpError } from '../errors';

/** Open `/api/events` streams at most; a further one is refused until one closes (a phone and a laptop need a few). */
export const MAX_EVENT_STREAMS = 20;

// Ukrainian, sentence case (docs/design/README.md → Content).
const TOO_MANY_STREAMS = 'Забагато відкритих зʼєднань із сервером. Закрийте зайві вкладки панелі.';

/**
 * `GET /api/events`: the live bus as server-sent events (`snapshot`, `alert`, `status`). The client first gets
 * the current status; its bus subscription ends when the client disconnects or the server shuts down.
 */
export function eventsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/events', async (_request, reply) => {
    if (ctx.sse.count('events') >= MAX_EVENT_STREAMS) throw new HttpError('rate-limited', TOO_MANY_STREAMS);
    const stream = ctx.sse.open(reply, 'events');
    const send = (event: LiveEvent): void => stream.send(event.type, event);
    try {
      send({ type: 'status', status: ctx.status() });
    } catch (error) {
      reply.log.warn({ err: error }, 'initial status not sent');
    }
    const unsubscribe = ctx.bus.subscribe(send);
    stream.onClose(unsubscribe);
  });
}
