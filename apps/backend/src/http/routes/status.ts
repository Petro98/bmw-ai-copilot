import type { FastifyInstance } from 'fastify';
import type { StatusDto } from '@copilot/shared';
import packageJson from '../../../package.json';
import type { AppDeps, RouteContext } from '../app';

/** The backend's status as the panel shows it. Contains no secret: the key is only named by the mode. */
export function buildStatus(deps: Pick<AppDeps, 'config' | 'hub' | 'mock' | 'guard'>): StatusDto {
  const { config } = deps;
  const lastSnapshotAt = deps.hub.lastSnapshotAt();
  const totals = deps.guard.totals();
  return {
    version: packageJson.version,
    vehicle: {
      source: config.vehicleSource,
      // Connected once the provider has delivered a snapshot while the hub runs.
      connected: lastSnapshotAt !== null,
      lastSnapshotAt,
      scenario: deps.mock ? deps.mock.scenarioId() : null,
    },
    claude: { mode: config.claudeMode, model: config.claudeModel, voiceModel: config.claudeModelVoice },
    budget: {
      dayUsd: totals.dayUsd,
      dayLimitUsd: config.budgetDailyUsd,
      monthUsd: totals.monthUsd,
      monthLimitUsd: config.budgetMonthlyUsd,
    },
  };
}

/** `GET /api/status`. */
export function statusRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/status', async (): Promise<StatusDto> => ctx.status());
}
