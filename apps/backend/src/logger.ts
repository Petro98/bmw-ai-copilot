import { pino, type DestinationStream, type Logger } from 'pino';
import type { Config } from './config';

export type { Logger } from 'pino';

/**
 * Paths pino replaces before a line is written. The key is also kept away from the logger by construction
 * (only main.ts and the SDK client hold it); this is the second line.
 */
const SECRET_FIELDS: readonly string[] = [
  'authorization', 'apiKey', 'anthropicApiKey', 'secret', '["x-api-key"]',
  // Plan 2 Task 7: the owner token, the session secret, a device secret and the session cookie.
  'token', 'ownerToken', 'sessionSecret', 'cookie', '["set-cookie"]',
];

function nested(field: string, depth: number): string {
  const prefix = '*.'.repeat(depth);
  return field.startsWith('[') ? `${prefix.slice(0, -1)}${field}` : `${prefix}${field}`;
}

export const REDACT_PATHS: readonly string[] = [
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((field) => nested(field, 1)),
  ...SECRET_FIELDS.map((field) => nested(field, 2)),
  'req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie',
  'res.headers["set-cookie"]',
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
