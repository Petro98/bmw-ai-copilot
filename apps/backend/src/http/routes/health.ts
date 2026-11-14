import type { FastifyInstance } from 'fastify';
import type { MetricsDto } from '@copilot/shared';
import type { RouteContext } from '../app';

const MB = 1024 * 1024;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `GET /api/health` (liveness) and `GET /api/metrics` (process figures, open live-event streams). */
export function healthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/health', async () => ({ status: 'ok' as const }));

  app.get('/api/metrics', async (): Promise<MetricsDto> => {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      rssMb: round1(memory.rss / MB),
      heapUsedMb: round1(memory.heapUsed / MB),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      uptimeS: Math.round(process.uptime()),
      sseClients: ctx.sse.count('events'),
    };
  });
}
