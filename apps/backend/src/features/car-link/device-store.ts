import { timingSafeEqual } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { DeviceDto, DeviceRegistration } from '@copilot/shared';
import { sha256 } from '../access/session';

type Row = Record<string, unknown>;

/** `deviceId`: 16–64 URL-safe characters (Plan 2 Task 7). The car makes 24 hex characters (car/src/app.ts). */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/** `secret`: at least 32 printable characters without spaces; the car makes 64 hex characters. */
export const MIN_SECRET_CHARS = 32;
export const MAX_SECRET_CHARS = 256;
const SECRET_PATTERN = /^[\x21-\x7e]+$/;

/** Compared against when the device is unknown, so a miss takes as long as a wrong secret. */
const NO_HASH = Buffer.alloc(32);

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
}

export function isDeviceSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_SECRET_CHARS && value.length <= MAX_SECRET_CHARS && SECRET_PATTERN.test(value);
}

function toDto(row: Row): DeviceDto {
  return {
    deviceId: String(row.device_id),
    label: String(row.label),
    createdAt: Number(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
  };
}

/**
 * Paired head units. The secret is stored only as a SHA-256 (it is 32 random bytes, so a plain hash is enough) and
 * compared in constant time. Validation of the label lives in the HTTP layer; id and secret are checked here too.
 */
export class DeviceStore {
  private readonly upsert: StatementSync;
  private readonly hashOf: StatementSync;
  private readonly touchStatement: StatementSync;
  private readonly all: StatementSync;
  private readonly deleteStatement: StatementSync;
  private readonly one: StatementSync;

  constructor(db: DatabaseSync) {
    // Registering a known id again (the owner pairs the same car anew) replaces its secret and label.
    this.upsert = db.prepare(
      `INSERT INTO devices (device_id, label, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT (device_id) DO UPDATE SET label = excluded.label, secret_hash = excluded.secret_hash,
         created_at = excluded.created_at, last_seen_at = NULL`,
    );
    this.hashOf = db.prepare('SELECT secret_hash FROM devices WHERE device_id = ?');
    this.touchStatement = db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?');
    this.all = db.prepare('SELECT * FROM devices ORDER BY created_at DESC, rowid DESC');
    this.deleteStatement = db.prepare('DELETE FROM devices WHERE device_id = ?');
    this.one = db.prepare('SELECT * FROM devices WHERE device_id = ?');
  }

  register(r: DeviceRegistration, now: number): DeviceDto {
    if (!isDeviceId(r.deviceId) || !isDeviceSecret(r.secret)) throw new Error('invalid device registration');
    this.upsert.run(r.deviceId, r.label, sha256(r.secret).toString('hex'), now);
    return toDto(this.one.get(r.deviceId) as Row);
  }

  /** The device id when `bearer` is `<deviceId>.<secret>` of a registered device; otherwise null. */
  verify(bearer: string): string | null {
    if (typeof bearer !== 'string') return null;
    const dot = bearer.indexOf('.');
    if (dot < 0) return null;
    const deviceId = bearer.slice(0, dot);
    const secret = bearer.slice(dot + 1);
    if (!isDeviceId(deviceId) || !isDeviceSecret(secret)) return null;
    const row = this.hashOf.get(deviceId) as Row | undefined;
    const stored = row ? Buffer.from(String(row.secret_hash), 'hex') : NO_HASH;
    const given = sha256(secret);
    const match = stored.length === given.length && timingSafeEqual(stored, given);
    return row && match ? deviceId : null;
  }

  touch(deviceId: string, now: number): void {
    this.touchStatement.run(now, deviceId);
  }

  /** Newest pairing first. */
  list(): DeviceDto[] {
    return this.all.all().map((row) => toDto(row as Row));
  }

  remove(deviceId: string): boolean {
    return Number(this.deleteStatement.run(deviceId).changes) > 0;
  }
}
