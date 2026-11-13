import type { FastifyInstance } from 'fastify';
import type { LiveEvent } from '@copilot/shared';
import type { RouteContext } from '../app';

/**
 * `GET /api/events`: the live bus as server-sent events (`snapshot`, `alert`, `status`). The client first gets
 * the current status; its bus subscription ends when the client disconnects or the server shuts down.
 */
export function eventsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/events', async (_request, reply) => {
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
