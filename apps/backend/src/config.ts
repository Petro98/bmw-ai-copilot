import type { Effort } from '@copilot/ai-core';
import { SCENARIOS, type ScenarioId } from '@copilot/vehicle-core';
import type { AssistantConfig } from './assistant/assistant-service';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/** The backend's configuration: one field per environment variable (`.env.example` lists them with defaults). */
export interface Config {
  port: number;                       // PORT=3000
  host: string;                       // HOST=127.0.0.1
  databasePath: string;               // DATABASE_PATH=./data/copilot.sqlite
  anthropicApiKey: string | null;     // ANTHROPIC_API_KEY= (never logged, never in a response)
  claudeMode: 'live' | 'mock';        // CLAUDE_MODE=auto, resolved: live when a key is set, otherwise mock
  claudeModel: string;                // CLAUDE_MODEL=claude-opus-5-5
  claudeModelVoice: string;           // CLAUDE_MODEL_VOICE= (empty → CLAUDE_MODEL)
  claudeEffort: Effort;               // CLAUDE_EFFORT=medium
  claudeEffortVoice: Effort;          // CLAUDE_EFFORT_VOICE=low
  claudeMaxTokens: number;            // CLAUDE_MAX_TOKENS=16000
  claudeTimeoutMs: number;            // CLAUDE_TIMEOUT_MS=60000
  budgetDailyUsd: number;             // BUDGET_DAILY_USD=1
  budgetMonthlyUsd: number;           // BUDGET_MONTHLY_USD=20
  rateLimitPerMinute: number;         // RATE_LIMIT_PER_MINUTE=10
  historyTurns: number;               // HISTORY_TURNS=4
  vehicleSource: 'mock' | 'car';      // VEHICLE_SOURCE=mock ('car' arrives with Plan 2)
  mockScenario: ScenarioId;           // MOCK_SCENARIO=steady-cruise
  vehicleLabel: string | null;        // VEHICLE_LABEL= (no VIN, no personal data)
  telemetrySampleIntervalMs: number;  // TELEMETRY_SAMPLE_INTERVAL_MS=60000
  telemetryRetentionDays: number;     // TELEMETRY_RETENTION_DAYS=90
  corsOrigin: string;                 // CORS_ORIGIN=http://localhost:4200
  logLevel: LogLevel;                 // LOG_LEVEL=info
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];
const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const MAX_VEHICLE_LABEL_CHARS = 80;

/**
 * Reads and validates the environment. Every invalid variable is collected and reported in one error.
 * Messages name the variable and what it accepts, never the value given (it may be a mistyped key).
 * An empty value counts as unset and takes the default.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];

  const raw = (name: string): string | null => {
    const value = env[name];
    if (value === undefined) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  const text = (name: string, fallback: string): string => {
    const value = raw(name);
    if (value === null) return fallback;
    if (/\s/.test(value)) {
      problems.push(`${name}: must not contain spaces`);
      return fallback;
    }
    return value;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = raw(name);
    if (value === null) return fallback;
    const n = /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      problems.push(`${name}: must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return n;
  };
  const amount = (name: string, fallback: number): number => {
    const value = raw(name);
    if (value === null) return fallback;
    const n = /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isFinite(n) || n < 0) {
      problems.push(`${name}: must be a number of US dollars, 0 or more`);
      return fallback;
    }
    return n;
  };
  const oneOf = <T extends string>(name: string, fallback: T, allowed: readonly T[]): T => {
    const value = raw(name);
    if (value === null) return fallback;
    if (!(allowed as readonly string[]).includes(value)) {
      problems.push(`${name}: must be one of ${allowed.join(', ')}`);
      return fallback;
    }
    return value as T;
  };

  const apiKey = raw('ANTHROPIC_API_KEY');
  if (apiKey !== null && /\s/.test(apiKey)) problems.push('ANTHROPIC_API_KEY: must not contain spaces');
  const mode = oneOf('CLAUDE_MODE', 'auto', ['auto', 'live', 'mock'] as const);
  if (mode === 'live' && apiKey === null) problems.push('CLAUDE_MODE: live needs ANTHROPIC_API_KEY to be set');

  const claudeModel = text('CLAUDE_MODEL', 'claude-opus-5-5');

  const vehicleSource = oneOf('VEHICLE_SOURCE', 'mock', ['mock', 'car'] as const);
  if (vehicleSource === 'car') problems.push('VEHICLE_SOURCE: car is not available yet (the car link comes with Plan 2); use mock');

  const vehicleLabel = raw('VEHICLE_LABEL');
  if (vehicleLabel !== null && vehicleLabel.length > MAX_VEHICLE_LABEL_CHARS) {
    problems.push(`VEHICLE_LABEL: at most ${MAX_VEHICLE_LABEL_CHARS} characters`);
  }

  const corsOrigin = text('CORS_ORIGIN', 'http://localhost:4200');
  if (!isOrigin(corsOrigin)) problems.push('CORS_ORIGIN: must be one origin such as http://localhost:4200 (scheme, host and port, no path)');

  const config: Config = {
    port: integer('PORT', 3000, 0, 65535),
    host: text('HOST', '127.0.0.1'),
    databasePath: raw('DATABASE_PATH') ?? './data/copilot.sqlite',
    anthropicApiKey: apiKey,
    claudeMode: mode === 'mock' || (mode === 'auto' && apiKey === null) ? 'mock' : 'live',
    claudeModel,
    claudeModelVoice: text('CLAUDE_MODEL_VOICE', claudeModel),
    claudeEffort: oneOf('CLAUDE_EFFORT', 'medium', EFFORTS),
    claudeEffortVoice: oneOf('CLAUDE_EFFORT_VOICE', 'low', EFFORTS),
    claudeMaxTokens: integer('CLAUDE_MAX_TOKENS', 16000, 1, 128_000),
    claudeTimeoutMs: integer('CLAUDE_TIMEOUT_MS', 60_000, 1000, 600_000),
    budgetDailyUsd: amount('BUDGET_DAILY_USD', 1),
    budgetMonthlyUsd: amount('BUDGET_MONTHLY_USD', 20),
    rateLimitPerMinute: integer('RATE_LIMIT_PER_MINUTE', 10, 1, 1000),
    historyTurns: integer('HISTORY_TURNS', 4, 0, 50),
    vehicleSource,
    mockScenario: oneOf('MOCK_SCENARIO', 'steady-cruise', SCENARIOS.map((s) => s.id)),
    vehicleLabel,
    telemetrySampleIntervalMs: integer('TELEMETRY_SAMPLE_INTERVAL_MS', 60_000, 1000, 86_400_000),
    telemetryRetentionDays: integer('TELEMETRY_RETENTION_DAYS', 90, 1, 3650),
    corsOrigin,
    logLevel: oneOf('LOG_LEVEL', 'info', LOG_LEVELS),
  };

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return config;
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

/** The assistant's part of the configuration. */
export function assistantConfigFrom(config: Config): AssistantConfig {
  return {
    model: config.claudeModel,
    voiceModel: config.claudeModelVoice,
    effort: config.claudeEffort,
    voiceEffort: config.claudeEffortVoice,
    maxTokens: config.claudeMaxTokens,
    timeoutMs: config.claudeTimeoutMs,
    historyTurns: config.historyTurns,
    vehicleLabel: config.vehicleLabel,
  };
}
