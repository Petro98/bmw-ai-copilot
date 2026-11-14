import type { FastifyInstance } from 'fastify';
import type { DialogTurn } from '@copilot/shared';
import type { RouteContext } from '../app';
import { parseLimit } from '../schemas';

const DEFAULT_DIALOG_LIMIT = 20;

/** `GET /api/dialog?limit=`: stored turns, newest first. */
export function dialogRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/dialog', async (request): Promise<DialogTurn[]> => {
    const limit = parseLimit(request.query, DEFAULT_DIALOG_LIMIT);
    return ctx.dialog.recent(limit);
  });
}
