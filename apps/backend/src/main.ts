import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicGateway, CostGuard, MockClaudeGateway, type ClaudeGateway } from '@copilot/ai-core';
import { EventEngine, defaultEngineOptions } from '@copilot/event-engine';
import { MockVehicleDataProvider, type Clock, type TimerApi, type VehicleDataProvider } from '@copilot/vehicle-core';
import { pino } from 'pino';
import { AssistantService } from './assistant/assistant-service';
import { assistantConfigFrom, loadConfig, type Config } from './config';
import { openDatabase, type DatabaseSync } from './db/database';
import { buildApp } from './http/app';
import { createLogger, type Logger } from './logger';
import { AlertStore } from './stores/alert-store';
import { DialogStore } from './stores/dialog-store';
import { EngineStateStore } from './stores/engine-state-store';
import { SettingsStore } from './stores/settings-store';
import { TelemetryStore } from './stores/telemetry-store';
import { SqliteUsageStore } from './stores/usage-store';
import { LiveBus } from './vehicle/live-bus';
import { VehicleHub } from './vehicle/vehicle-hub';

/** Delay between the mock gateway's words, so the demo answer visibly streams. */
const MOCK_WORD_DELAY_MS = 25;

/**
 * Overrides for tests: the real clock and timers otherwise, and the mock vehicle built from the configuration.
 * A provider given here replaces the mock (the mock routes then answer 404).
 */
export interface StartRuntime { clock?: Clock; timers?: TimerApi; provider?: VehicleDataProvider }

const realClock: Clock = { now: () => Date.now() };
const realTimers: TimerApi = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function gatewayFor(config: Config): ClaudeGateway {
  if (config.claudeMode === 'live' && config.anthropicApiKey) {
    // The key goes to the SDK client only; it is never logged or returned. The SDK's own bounded retries apply.
    return new AnthropicGateway(new Anthropic({ apiKey: config.anthropicApiKey }));
  }
  return new MockClaudeGateway({ delayMs: MOCK_WORD_DELAY_MS });
}

/**
 * Wires the backend and starts listening. Throws on any startup failure after undoing what it opened; it does not
 * log the failure (the caller does, once) and never retries. Installs no signal handlers (see `run`).
 * The only vehicle access is reading the provider's snapshots; nothing here writes to or controls a vehicle.
 */
export async function start(env: NodeJS.ProcessEnv, runtime: StartRuntime = {}): Promise<{ close(): Promise<void> }> {
  const config = loadConfig(env);
  const logger = createLogger(config);
  const clock = runtime.clock ?? realClock;
  const timers = runtime.timers ?? realTimers;

  if (config.databasePath !== ':memory:') mkdirSync(dirname(resolve(config.databasePath)), { recursive: true });
  const db = openDatabase(config.databasePath);

  let close: () => Promise<void>;
  try {
    close = await wire(config, logger, db, clock, timers, runtime.provider);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Already closed by the partial shutdown.
    }
    throw error;
  }

  let closing: Promise<void> | null = null;
  return { close: () => (closing ??= close()) };
}

async function wire(
  config: Config, logger: Logger, db: DatabaseSync, clock: Clock, timers: TimerApi, injected: VehicleDataProvider | undefined,
): Promise<() => Promise<void>> {
  const alerts = new AlertStore(db);
  const dialog = new DialogStore(db);
  const settings = new SettingsStore(db);
  const telemetry = new TelemetryStore(db);
  const engineState = new EngineStateStore(db);

  // A fresh engine would clear a standing warning and raise it again under a new id: restore its memory.
  const engine = new EventEngine(defaultEngineOptions());
  const saved = engineState.load();
  if (saved) engine.restore(saved);

  const mock = injected ? null : new MockVehicleDataProvider({ clock, timers, scenario: config.mockScenario });
  const provider: VehicleDataProvider = injected ?? mock!;
  const bus = new LiveBus();
  const hub = new VehicleHub({
    provider, engine, alerts, telemetry, settings, bus, clock,
    sampleIntervalMs: config.telemetrySampleIntervalMs, retentionDays: config.telemetryRetentionDays,
  });
  const guard = new CostGuard({
    dailyUsdLimit: config.budgetDailyUsd, monthlyUsdLimit: config.budgetMonthlyUsd,
    requestsPerMinute: config.rateLimitPerMinute, clock, store: new SqliteUsageStore(db),
  });
  const assistant = new AssistantService({
    hub, dialog, alerts, settings, telemetry, gateway: gatewayFor(config), guard, clock,
    config: assistantConfigFrom(config), newId: randomUUID,
  });
  const app = buildApp({ config, logger, hub, bus, assistant, dialog, alerts, settings, guard, mock, clock });

  const saveEngineState = (): void => {
    try {
      engineState.save(engine.state());   // writes only when keys or active flags changed
    } catch (error) {
      logger.warn({ err: error }, 'engine state not saved');
    }
  };

  // The hub subscribes first, so this listener sees the state after the hub's evaluation of the same change.
  await hub.start();
  const unsubscribeState = provider.onChange(saveEngineState);
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    unsubscribeState();
    await app.close().catch(() => undefined);
    await hub.stop().catch(() => undefined);
    throw error;
  }
  logger.info({
    host: config.host, port: config.port, claudeMode: config.claudeMode, model: config.claudeModel,
    voiceModel: config.claudeModelVoice, vehicleSource: config.vehicleSource,
  }, 'backend started');

  return async () => {
    // Stop accepting and end the SSE streams, then stop the hub and provider, then close the database.
    try {
      await app.close();
    } finally {
      unsubscribeState();
      try {
        await hub.stop();
      } finally {
        saveEngineState();
        db.close();
        logger.info('backend stopped');
      }
    }
  };
}

/** Process entry: start, then shut down on SIGINT/SIGTERM. A startup failure logs once and exits 1. */
async function run(): Promise<void> {
  let handle: { close(): Promise<void> };
  try {
    handle = await start(process.env);
  } catch (error) {
    // The configured logger may not exist (invalid configuration): a plain one, and only the message.
    pino({ base: null }).fatal({ reason: error instanceof Error ? error.message : String(error) }, 'backend failed to start');
    process.exit(1);
  }
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    handle.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/**
 * True when `entry` (process.argv[1]) names `file`. Both sides are compared as real paths, so a start through a
 * symlinked directory (macOS /tmp, a `current` release link, node_modules/@copilot/backend) still counts.
 * A path that cannot be resolved (missing file) is never the entry.
 */
export function isEntryPath(entry: string | undefined, file: string | undefined): boolean {
  if (typeof entry !== 'string' || typeof file !== 'string') return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(file);
  } catch {
    return false;
  }
}

// `tsx src/main.ts` or `node dist/main.js` starts the process; an import (tests) does not.
if (isEntryPath(process.argv[1], typeof __filename === 'string' ? __filename : undefined)) void run();
