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
  vehicleSource: 'mock' | 'car';      // VEHICLE_SOURCE=mock (car: the head unit reports through /car/v1)
  allowVehicleSourceReset: boolean;   // ALLOW_VEHICLE_SOURCE_RESET=false (1/true: a demo start may reset the car's data)
  mockScenario: ScenarioId;           // MOCK_SCENARIO=steady-cruise
  vehicleLabel: string | null;        // VEHICLE_LABEL= (no VIN, no personal data)
  telemetrySampleIntervalMs: number;  // TELEMETRY_SAMPLE_INTERVAL_MS=60000
  telemetryRetentionDays: number;     // TELEMETRY_RETENTION_DAYS=90
  corsOrigin: string;                 // CORS_ORIGIN=http://localhost:4200
  logLevel: LogLevel;                 // LOG_LEVEL=info
  ownerToken: string | null;          // OWNER_TOKEN= (never logged, never in a response; unset: open API, loopback HOST only)
  sessionSecret: string | null;       // SESSION_SECRET= (signs the owner's session cookie; required with OWNER_TOKEN)
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];
const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const MAX_VEHICLE_LABEL_CHARS = 80;
/**
 * A vehicle identification number: 17 letters and digits without I, O and Q (ISO 3779). VEHICLE_LABEL reaches every
 * prompt sent to Claude, so a label holding one is refused.
 */
const VIN_SHAPE = /\b[A-HJ-NPR-Z0-9]{17}\b/i;
/** Below this an answer (and adaptive thinking, which spends from the same limit) is cut off or comes back empty. */
export const MIN_CLAUDE_MAX_TOKENS = 1024;
const MIN_OWNER_TOKEN_CHARS = 24;
const MIN_SESSION_SECRET_CHARS = 32;
const MAX_SECRET_CHARS = 512;

/** True for an address that only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

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

  const flag = (name: string, fallback: boolean): boolean => {
    const value = raw(name)?.toLowerCase() ?? null;
    if (value === null) return fallback;
    if (value === '1' || value === 'true') return true;
    if (value === '0' || value === 'false') return false;
    problems.push(`${name}: must be 1, true, 0 or false`);
    return fallback;
  };

  const apiKey = raw('ANTHROPIC_API_KEY');
  if (apiKey !== null && /\s/.test(apiKey)) problems.push('ANTHROPIC_API_KEY: must not contain spaces');
  const mode = oneOf('CLAUDE_MODE', 'auto', ['auto', 'live', 'mock'] as const);
  if (mode === 'live' && apiKey === null) problems.push('CLAUDE_MODE: live needs ANTHROPIC_API_KEY to be set');

  const claudeModel = text('CLAUDE_MODEL', 'claude-opus-5-5');

  const vehicleSource = oneOf('VEHICLE_SOURCE', 'mock', ['mock', 'car'] as const);
  // Off by default: a demo start on a database the car wrote is refused at startup (db/vehicle-source.ts).
  const allowVehicleSourceReset = flag('ALLOW_VEHICLE_SOURCE_RESET', false);

  // Secrets: the messages name the variable and the rule, never the value.
  const secret = (name: string, minChars: number): string | null => {
    const value = raw(name);
    if (value === null) return null;
    if (/\s/.test(value) || value.length < minChars || value.length > MAX_SECRET_CHARS) {
      problems.push(`${name}: must be ${minChars} to ${MAX_SECRET_CHARS} characters without spaces`);
      return null;
    }
    return value;
  };
  const ownerTokenGiven = raw('OWNER_TOKEN') !== null;
  const ownerToken = secret('OWNER_TOKEN', MIN_OWNER_TOKEN_CHARS);
  const sessionSecret = secret('SESSION_SECRET', MIN_SESSION_SECRET_CHARS);
  if (ownerTokenGiven && raw('SESSION_SECRET') === null) {
    problems.push(`SESSION_SECRET: must be set (at least ${MIN_SESSION_SECRET_CHARS} characters) when OWNER_TOKEN is set`);
  }
  const host = text('HOST', '127.0.0.1');
  if (!ownerTokenGiven && !isLoopbackHost(host)) {
    problems.push('HOST: a non-loopback address needs OWNER_TOKEN and SESSION_SECRET (without OWNER_TOKEN the API is open)');
  }

  const vehicleLabel = raw('VEHICLE_LABEL');
  if (vehicleLabel !== null && vehicleLabel.length > MAX_VEHICLE_LABEL_CHARS) {
    problems.push(`VEHICLE_LABEL: at most ${MAX_VEHICLE_LABEL_CHARS} characters`);
  }
  // The message names the rule, never the value.
  if (vehicleLabel !== null && VIN_SHAPE.test(vehicleLabel)) {
    problems.push('VEHICLE_LABEL: must not contain a vehicle identification number');
  }

  const corsOrigin = text('CORS_ORIGIN', 'http://localhost:4200');
  if (!isOrigin(corsOrigin)) problems.push('CORS_ORIGIN: must be one origin such as http://localhost:4200 (scheme, host and port, no path)');

  const config: Config = {
    port: integer('PORT', 3000, 0, 65535),
    host,
    databasePath: raw('DATABASE_PATH') ?? './data/copilot.sqlite',
    anthropicApiKey: apiKey,
    claudeMode: mode === 'mock' || (mode === 'auto' && apiKey === null) ? 'mock' : 'live',
    claudeModel,
    claudeModelVoice: text('CLAUDE_MODEL_VOICE', claudeModel),
    claudeEffort: oneOf('CLAUDE_EFFORT', 'medium', EFFORTS),
    claudeEffortVoice: oneOf('CLAUDE_EFFORT_VOICE', 'low', EFFORTS),
    claudeMaxTokens: integer('CLAUDE_MAX_TOKENS', 16000, MIN_CLAUDE_MAX_TOKENS, 128_000),
    claudeTimeoutMs: integer('CLAUDE_TIMEOUT_MS', 60_000, 1000, 600_000),
    budgetDailyUsd: amount('BUDGET_DAILY_USD', 1),
    budgetMonthlyUsd: amount('BUDGET_MONTHLY_USD', 20),
    rateLimitPerMinute: integer('RATE_LIMIT_PER_MINUTE', 10, 1, 1000),
    historyTurns: integer('HISTORY_TURNS', 4, 0, 50),
    vehicleSource,
    allowVehicleSourceReset,
    mockScenario: oneOf('MOCK_SCENARIO', 'steady-cruise', SCENARIOS.map((s) => s.id)),
    vehicleLabel,
    telemetrySampleIntervalMs: integer('TELEMETRY_SAMPLE_INTERVAL_MS', 60_000, 1000, 86_400_000),
    telemetryRetentionDays: integer('TELEMETRY_RETENTION_DAYS', 90, 1, 3650),
    corsOrigin,
    logLevel: oneOf('LOG_LEVEL', 'info', LOG_LEVELS),
    ownerToken: ownerToken !== null && sessionSecret !== null ? ownerToken : null,
    sessionSecret: ownerToken !== null && sessionSecret !== null ? sessionSecret : null,
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
    demo: config.vehicleSource === 'mock',
  };
}
