import type { FastifyInstance } from 'fastify';
import type { ScenarioDto } from '@copilot/shared';
import { SCENARIOS, type MockVehicleDataProvider, type ScenarioId } from '@copilot/vehicle-core';
import type { RouteContext } from '../app';
import { HttpError, MESSAGES } from '../errors';
import { parseScenarioRequest } from '../schemas';

/** `GET /api/mock/scenarios` and `POST /api/mock/scenario`; 404 unless the vehicle source is the mock. */
export function mockRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const requireMock = (): MockVehicleDataProvider => {
    if (!ctx.mock || ctx.config.vehicleSource !== 'mock') throw new HttpError('not-found', MESSAGES.mockOnly);
    return ctx.mock;
  };

  app.get('/api/mock/scenarios', async (): Promise<ScenarioDto[]> => {
    requireMock();
    return SCENARIOS.map((s) => ({ id: s.id, title: s.title }));
  });

  app.post('/api/mock/scenario', async (request): Promise<{ id: ScenarioId }> => {
    const mock = requireMock();
    const { id } = parseScenarioRequest(request.body);
    mock.setScenario(id);
    ctx.publishStatus();
    return { id };
  });
}
