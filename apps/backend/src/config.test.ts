import { Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { assistantConfigFrom, MIN_CLAUDE_MAX_TOKENS, loadConfig } from './config';
import { createLogger } from './logger';

// A made-up key shape: never a real credential.
const FAKE_KEY = 'sk-ant-test-0000000000000000';

describe('loadConfig', () => {
  test('loadConfig applies defaults and reports all invalid variables at once', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      port: 3000,
      host: '127.0.0.1',
      databasePath: './data/copilot.sqlite',
      anthropicApiKey: null,
      claudeMode: 'mock',
      claudeModel: 'claude-opus-5-5',
      claudeModelVoice: 'claude-opus-5-5',
      claudeEffort: 'medium',
      claudeEffortVoice: 'low',
      claudeMaxTokens: 16000,
      claudeTimeoutMs: 60000,
      budgetDailyUsd: 1,
      budgetMonthlyUsd: 20,
      rateLimitPerMinute: 10,
      historyTurns: 4,
      vehicleSource: 'mock',
      allowVehicleSourceReset: false,
      mockScenario: 'steady-cruise',
      vehicleLabel: null,
      telemetrySampleIntervalMs: 60000,
      telemetryRetentionDays: 90,
      corsOrigin: 'http://localhost:4200',
      logLevel: 'info',
      ownerToken: null,
      sessionSecret: null,
    });

    let message = '';
    try {
      loadConfig({
        PORT: 'abc', CLAUDE_EFFORT: 'extreme', BUDGET_DAILY_USD: '-1', MOCK_SCENARIO: 'moon-landing',
        LOG_LEVEL: 'loud', HISTORY_TURNS: '1.5', CORS_ORIGIN: 'not a url', ANTHROPIC_API_KEY: 'sk-ant bad key',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of ['PORT', 'CLAUDE_EFFORT', 'BUDGET_DAILY_USD', 'MOCK_SCENARIO', 'LOG_LEVEL', 'HISTORY_TURNS', 'CORS_ORIGIN', 'ANTHROPIC_API_KEY']) {
      expect(message).toContain(name);
    }
    // The error names variables, never their values: a key typed with a mistake must not reach a log.
    expect(message).not.toContain('sk-ant');
  });

  test('empty values mean the default; an empty voice model follows CLAUDE_MODEL', () => {
    const config = loadConfig({ PORT: '', CLAUDE_MODEL: 'claude-sonnet-5-5', CLAUDE_MODEL_VOICE: '', VEHICLE_LABEL: '  ' });
    expect(config.port).toBe(3000);
    expect(config.claudeModelVoice).toBe('claude-sonnet-5-5');
    expect(config.vehicleLabel).toBeNull();
    expect(loadConfig({ CLAUDE_MODEL_VOICE: 'claude-haiku-5-5', VEHICLE_LABEL: 'X3 xDrive30i' })).toMatchObject({
      claudeModel: 'claude-opus-5-5', claudeModelVoice: 'claude-haiku-5-5', vehicleLabel: 'X3 xDrive30i',
    });
  });

  test('CLAUDE_MODE=live without a key is a startup error; auto without a key is mock', () => {
    expect(() => loadConfig({ CLAUDE_MODE: 'live' })).toThrow(/CLAUDE_MODE/);
    expect(loadConfig({ CLAUDE_MODE: 'auto' }).claudeMode).toBe('mock');
    expect(loadConfig({ ANTHROPIC_API_KEY: FAKE_KEY }).claudeMode).toBe('live');
    expect(loadConfig({ ANTHROPIC_API_KEY: FAKE_KEY, CLAUDE_MODE: 'mock' }).claudeMode).toBe('mock');
    expect(loadConfig({ ANTHROPIC_API_KEY: FAKE_KEY, CLAUDE_MODE: 'live' }).anthropicApiKey).toBe(FAKE_KEY);
  });

  test('the car source is accepted since the car link exists (Plan 2 Task 7); anything else is refused', () => {
    expect(loadConfig({ VEHICLE_SOURCE: 'car' }).vehicleSource).toBe('car');
    expect(() => loadConfig({ VEHICLE_SOURCE: 'bus' })).toThrow(/VEHICLE_SOURCE/);
  });

  test('the assistant is told it runs the demo vehicle exactly when the vehicle source is mock', () => {
    expect(assistantConfigFrom(loadConfig({})).demo).toBe(true);
    expect(assistantConfigFrom(loadConfig({ VEHICLE_SOURCE: 'car' })).demo).toBe(false);
  });

  test('ALLOW_VEHICLE_SOURCE_RESET is off by default, accepts 1/true (and 0/false) and refuses anything else', () => {
    expect(loadConfig({}).allowVehicleSourceReset).toBe(false);
    expect(loadConfig({ ALLOW_VEHICLE_SOURCE_RESET: '' }).allowVehicleSourceReset).toBe(false);
    expect(loadConfig({ ALLOW_VEHICLE_SOURCE_RESET: '1' }).allowVehicleSourceReset).toBe(true);
    expect(loadConfig({ ALLOW_VEHICLE_SOURCE_RESET: 'true' }).allowVehicleSourceReset).toBe(true);
    expect(loadConfig({ ALLOW_VEHICLE_SOURCE_RESET: 'TRUE' }).allowVehicleSourceReset).toBe(true);
    expect(loadConfig({ ALLOW_VEHICLE_SOURCE_RESET: '0' }).allowVehicleSourceReset).toBe(false);
    expect(loadConfig({ ALLOW_VEHICLE_SOURCE_RESET: 'false' }).allowVehicleSourceReset).toBe(false);
    expect(() => loadConfig({ ALLOW_VEHICLE_SOURCE_RESET: 'yes' })).toThrow(/ALLOW_VEHICLE_SOURCE_RESET/);
  });
});

describe('loadConfig: safety limits', () => {
  test('a VEHICLE_LABEL holding a vehicle identification number is refused without echoing it', () => {
    // A made-up value of the VIN shape (17 characters, no I, O or Q): never a real vehicle's.
    const vinShaped = 'TESTX00000A000000';
    for (const label of [vinShaped, `Мій X3 ${vinShaped}`, vinShaped.toLowerCase()]) {
      let message = '';
      try {
        loadConfig({ VEHICLE_LABEL: label });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('VEHICLE_LABEL');
      expect(message).not.toContain(vinShaped);
      expect(message.toLowerCase()).not.toContain(vinShaped.toLowerCase());
    }
    expect(loadConfig({ VEHICLE_LABEL: 'BMW X3 G01, 2019' }).vehicleLabel).toBe('BMW X3 G01, 2019');
    expect(loadConfig({ VEHICLE_LABEL: 'Мій сірий кросовер xDrive30d' }).vehicleLabel).toBe('Мій сірий кросовер xDrive30d');
  });

  test(`CLAUDE_MAX_TOKENS is at least ${MIN_CLAUDE_MAX_TOKENS}`, () => {
    expect(() => loadConfig({ CLAUDE_MAX_TOKENS: '1' })).toThrow(/CLAUDE_MAX_TOKENS/);
    expect(() => loadConfig({ CLAUDE_MAX_TOKENS: String(MIN_CLAUDE_MAX_TOKENS - 1) })).toThrow(/CLAUDE_MAX_TOKENS/);
    expect(loadConfig({ CLAUDE_MAX_TOKENS: String(MIN_CLAUDE_MAX_TOKENS) }).claudeMaxTokens).toBe(MIN_CLAUDE_MAX_TOKENS);
  });
});

describe('createLogger', () => {
  function capture(): { stream: Writable; text(): string } {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    return { stream, text: () => chunks.join('') };
  }

  test('the logger never prints the API key', () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: FAKE_KEY, LOG_LEVEL: 'trace' });
    const out = capture();
    const logger = createLogger(config, out.stream);
    logger.info({ config }, 'config');
    logger.info(config, 'config at the top level');
    logger.info({ req: { headers: { authorization: `Bearer ${FAKE_KEY}`, 'x-api-key': FAKE_KEY } } }, 'headers');
    logger.info({ deps: { client: { apiKey: FAKE_KEY, secret: FAKE_KEY } } }, 'nested');
    const text = out.text();
    expect(text).toContain('claude-opus-5-5');   // the rest of the config is logged
    expect(text).not.toContain('sk-ant');
  });

  test('the level comes from the configuration', () => {
    const out = capture();
    const logger = createLogger(loadConfig({ LOG_LEVEL: 'warn' }), out.stream);
    logger.info('hidden');
    logger.warn('shown');
    expect(out.text()).not.toContain('hidden');
    expect(out.text()).toContain('shown');
  });
});
