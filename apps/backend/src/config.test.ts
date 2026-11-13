import { Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { loadConfig } from './config';
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
