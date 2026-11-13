import { pino, type DestinationStream, type Logger } from 'pino';
import type { Config } from './config';

export type { Logger } from 'pino';

/**
 * Paths pino replaces before a line is written. The key is also kept away from the logger by construction
 * (only main.ts and the SDK client hold it); this is the second line.
 */
export const REDACT_PATHS: readonly string[] = [
  'authorization', 'apiKey', 'anthropicApiKey', 'secret', '["x-api-key"]',
  '*.authorization', '*.apiKey', '*.anthropicApiKey', '*.secret', '*["x-api-key"]',
  '*.*.authorization', '*.*.apiKey', '*.*.anthropicApiKey', '*.*.secret', '*.*["x-api-key"]',
  'req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie',
];

/** Structured JSON logger. `destination` is for tests; the default is stdout. */
export function createLogger(config: Config, destination?: DestinationStream): Logger {
  const options = {
    level: config.logLevel,
    base: null,
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
  };
  return destination ? pino(options, destination) : pino(options);
}
