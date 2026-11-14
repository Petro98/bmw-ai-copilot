import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The owner's session cookie. Its value never appears in a response body, a log line or an error message. */
export const SESSION_COOKIE = 'copilot_session';
/** A session lasts 30 days (Plan 2 Task 7). */
export const SESSION_TTL_MS = 30 * 86_400_000;

const NONCE_BYTES = 16;
const MAC_BYTES = 32;
const MAX_COOKIE_CHARS = 256;

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

/**
 * A new session value `<expiresAt>.<nonce>.<mac>`: an HMAC-SHA256 with SESSION_SECRET over the expiry and a random
 * nonce. The server keeps no session table; rotating SESSION_SECRET ends every session.
 */
export function issueSessionValue(secret: string, now: number, nonce: Buffer = randomBytes(NONCE_BYTES)): string {
  const payload = `${now + SESSION_TTL_MS}.${base64url(nonce)}`;
  return `${payload}.${base64url(mac(secret, payload))}`;
}

/** True when `value` was issued with `secret`, is unaltered and has not expired at `now`. The MAC compare is constant-time. */
export function verifySessionValue(value: string, secret: string, now: number): boolean {
  if (typeof value !== 'string' || value.length > MAX_COOKIE_CHARS) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [expires, nonce, given] = parts;
  if (!/^\d{1,15}$/.test(expires) || !/^[A-Za-z0-9_-]{1,64}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(given)) return false;
  const expected = mac(secret, `${expires}.${nonce}`);
  const received = Buffer.from(given, 'base64url');
  if (received.length !== MAC_BYTES || !timingSafeEqual(received, expected)) return false;
  const expiresAt = Number(expires);
  // Unexpired, and not issued further ahead than one lifetime (a clock that jumped back would otherwise extend it).
  return now < expiresAt && expiresAt - now <= SESSION_TTL_MS;
}

const COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Strict';

/** The Set-Cookie header that starts a session. */
export function sessionSetCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_TTL_MS / 1000}`;
}

/** The Set-Cookie header that ends a session. */
export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}

/** The value of cookie `name` in a Cookie header, or null. */
export function readCookie(header: string | string[] | undefined, name: string): string | null {
  if (typeof header !== 'string' || header.length > 8192) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** SHA-256 of a secret: equal-length buffers for timingSafeEqual whatever was typed. */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison of a given secret with the expected one (both hashed first, so lengths match). */
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected)) && given.length > 0;
}

export interface LoginLimiterOptions { maxFailures?: number; windowMs?: number; lockMs?: number; maxTracked?: number }

interface Entry { windowStart: number; failures: number; lockedUntil: number }

/**
 * Wrong owner tokens per remote address: `maxFailures` (5) within `windowMs` (1 min) lock that address out for
 * `lockMs` (1 min). The address is the socket's peer: behind a reverse proxy every visitor shares the proxy's address.
 * At most `maxTracked` addresses are remembered; the oldest entry goes first.
 */
export class LoginLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly maxTracked: number;
  private readonly entries = new Map<string, Entry>();

  constructor(options: LoginLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.lockMs = options.lockMs ?? 60_000;
    this.maxTracked = options.maxTracked ?? 1000;
  }

  isLocked(address: string, now: number): boolean {
    const entry = this.entries.get(address);
    return entry !== undefined && now < entry.lockedUntil;
  }

  recordFailure(address: string, now: number): void {
    let entry = this.entries.get(address);
    if (!entry || now - entry.windowStart >= this.windowMs || now < entry.windowStart) {
      this.entries.delete(address);
      entry = { windowStart: now, failures: 0, lockedUntil: entry && now < entry.lockedUntil ? entry.lockedUntil : 0 };
    }
    entry.failures++;
    if (entry.failures >= this.maxFailures) entry.lockedUntil = now + this.lockMs;
    this.entries.set(address, entry);
    this.prune(now);
  }

  reset(address: string): void {
    this.entries.delete(address);
  }

  size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    if (this.entries.size <= this.maxTracked) return;
    for (const [address, entry] of this.entries) {
      if (now - entry.windowStart >= this.windowMs && now >= entry.lockedUntil) this.entries.delete(address);
    }
    // Map order is insertion order: drop the oldest until the bound holds.
    for (const address of this.entries.keys()) {
      if (this.entries.size <= this.maxTracked) break;
      this.entries.delete(address);
    }
  }
}
