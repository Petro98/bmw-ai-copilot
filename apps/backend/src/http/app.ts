import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CostGuard } from '@copilot/ai-core';
import type { StatusDto } from '@copilot/shared';
import type { Clock, MockVehicleDataProvider } from '@copilot/vehicle-core';
import type { AssistantService } from '../assistant/assistant-service';
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { AlertStore } from '../stores/alert-store';
import type { DialogStore } from '../stores/dialog-store';
import type { SettingsStore } from '../stores/settings-store';
import type { LiveBus } from '../vehicle/live-bus';
import type { VehicleHub } from '../vehicle/vehicle-hub';
import { MESSAGES, apiError, toApiError } from './errors';
import { askRoutes } from './routes/ask';
import { dialogRoutes } from './routes/dialog';
import { eventsRoutes } from './routes/events';
import { healthRoutes } from './routes/health';
import { mockRoutes } from './routes/mock';
import { settingsRoutes } from './routes/settings';
import { buildStatus, statusRoutes } from './routes/status';
import { vehicleRoutes } from './routes/vehicle';
import { SseRegistry } from './sse';

/** Largest JSON body accepted (a question is at most 500 characters; settings are a few numbers). */
export const BODY_LIMIT_BYTES = 16 * 1024;

export interface AppDeps {
  config: Config;
  logger: Logger;
  hub: VehicleHub;
  bus: LiveBus;
  assistant: AssistantService;
  dialog: DialogStore;
  alerts: AlertStore;
  settings: SettingsStore;
  guard: CostGuard;
  mock: MockVehicleDataProvider | null;   // null unless the vehicle source is the mock
  clock: Clock;
}

/** What every route module receives: the dependencies plus the app's shared HTTP helpers. */
export interface RouteContext extends AppDeps {
  sse: SseRegistry;
  /** The current StatusDto. */
  status(): StatusDto;
  /** Publishes a `status` live event; a failure to build it is logged, never thrown into the caller. */
  publishStatus(): void;
}

export type RouteModule = (app: FastifyInstance, ctx: RouteContext) => void;

/** Every route module, registered in this order. Plans 2–3 add a module here with one entry. */
export const ROUTE_MODULES: readonly RouteModule[] = [
  healthRoutes,
  statusRoutes,
  vehicleRoutes,
  dialogRoutes,
  askRoutes,
  eventsRoutes,
  settingsRoutes,
  mockRoutes,
];

/**
 * The REST + SSE API. Reads the vehicle state only; no route writes to or controls a vehicle.
 * Errors leave as an ApiError body with the status from errors.ts; nothing echoes request headers.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: BODY_LIMIT_BYTES,
    // The id comes from the server only; a client-sent request-id header is not trusted or echoed.
    requestIdHeader: false,
    // The pino Logger type parameter makes the instance a different generic type; route modules use the default one.
  }) as unknown as FastifyInstance;

  const sse = new SseRegistry();
  const ctx: RouteContext = {
    ...deps,
    sse,
    status: () => buildStatus(deps),
    publishStatus: () => {
      try {
        deps.bus.publish({ type: 'status', status: buildStatus(deps) });
      } catch (error) {
        deps.logger.warn({ err: error }, 'status event not published');
      }
    },
  };

  // The plugin's default methods are GET,HEAD,POST; PUT /api/settings needs PUT in the preflight answer.
  void app.register(cors, { origin: deps.config.corsOrigin, methods: ['GET', 'HEAD', 'POST', 'PUT'] });

  app.setErrorHandler((error, request, reply) => {
    const { status, body, internal } = toApiError(error);
    if (internal) request.log.error({ err: error }, 'request failed');
    else request.log.info({ code: body.error.code }, 'request refused');
    return reply.code(status).send(body);
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(apiError('not-found', MESSAGES.notFound)));

  // Shutdown: end open event streams first, so closing the server does not wait for them.
  app.addHook('preClose', async () => {
    sse.closeAll();
  });

  for (const module of ROUTE_MODULES) module(app, ctx);
  return app;
}
