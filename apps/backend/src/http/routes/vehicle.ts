import type { FastifyInstance } from 'fastify';
import type { AlertEvent } from '@copilot/event-engine';
import type { VehicleSnapshot } from '@copilot/vehicle-core';
import type { RouteContext } from '../app';
import { parseLimit } from '../schemas';

const DEFAULT_ALERT_LIMIT = 50;

/** `GET /api/snapshot` and `GET /api/alerts?limit=`: read-only views of the vehicle state. */
export function vehicleRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/snapshot', async (): Promise<VehicleSnapshot> => ctx.hub.snapshot());

  app.get('/api/alerts', async (request): Promise<AlertEvent[]> => {
    const limit = parseLimit(request.query, DEFAULT_ALERT_LIMIT);
    return ctx.alerts.recent(limit);   // newest first
  });
}
