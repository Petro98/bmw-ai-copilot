import type { FastifyInstance } from 'fastify';
import type { SettingsDto } from '@copilot/shared';
import type { RouteContext } from '../app';
import { parseSettings } from '../schemas';

/**
 * `GET /api/settings` and `PUT /api/settings`. The hub reads the owner limits on every evaluation, so a change
 * applies to the very next one. An invalid body is a 400 and leaves the stored settings as they were.
 */
export function settingsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/settings', async (): Promise<SettingsDto> => ctx.settings.get());

  app.put('/api/settings', async (request): Promise<SettingsDto> => {
    const next = parseSettings(request.body);
    const saved = ctx.settings.set(next);
    ctx.publishStatus();
    return saved;
  });
}
