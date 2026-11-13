/**
 * HTTPS to the backend on the head unit's Node 8.16.2: `https.request` (no fetch, no global URL), one
 * keep-alive agent with a single socket, names resolved through the uplink lease's DNS servers, normal
 * certificate verification (never weakened: a wrong head-unit clock is reported as `clock`), and one
 * timeout per request. No retry happens here: the caller decides when to try again.
 */
import * as nodeDns from 'dns';
import * as nodeHttps from 'https';
import type { Clock } from '@copilot/vehicle-core';
import type { Log } from '../safe';
import type { Lease } from './lease';
import { createLeaseLookup, isDnsFailure, type DnsModuleLike, type LookupFn, type TimeoutApi } from './resolver';

export type UplinkErrorKind = 'offline' | 'dns' | 'timeout' | 'clock' | 'tls' | 'unauthorized' | 'client-error' | 'server-error';

export class UplinkError extends Error {
  constructor(readonly kind: UplinkErrorKind, message: string) {
    super(message);
    this.name = 'UplinkError';
  }
}

export const HTTPS_TIMEOUT_MS = 15_000;
/** A reply larger than this is refused (the largest legitimate one is a page of dialog turns). */
export const MAX_RESPONSE_BYTES = 1_048_576;

interface ClientRequestLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  end(chunk?: string): unknown;
  abort?(): void;
  destroy?(error?: Error): unknown;
}
interface IncomingMessageLike {
  statusCode?: number;
  on(event: string, listener: (...args: never[]) => void): unknown;
  resume?(): unknown;
}
interface AgentLike { destroy(): void }

/** The part of Node's `https` module (or, in the test-only plain mode, `http`) used here. */
export interface HttpsModuleLike {
  request(options: Record<string, unknown>, onResponse: (res: IncomingMessageLike) => void): ClientRequestLike;
  Agent: new (options: Record<string, unknown>) => AgentLike;
}

export interface HttpsClientOptions {
  baseUrl: string;
  lease: () => Lease;
  timeoutMs?: number;            // default 15000
  extraCaPem?: string[];
  log: Log;
  /** Injected for tests; default: Node's `https` module. */
  https?: HttpsModuleLike;
  /** Injected for tests; default: Node's `dns` module. */
  dns?: DnsModuleLike;
  /** Injected for tests; default: the global timers. */
  timers?: TimeoutApi;
  /** For the DNS cache's age; default: Date.now. */
  clock?: Clock;
  /**
   * Test-only: allow an `http://` base address, with Node's `http` module passed as `https`. Used by the
   * Node 8 smoke test against a local server; never set by the app.
   */
  plainHttpForTests?: boolean;
}

export interface RequestOptions { timeoutMs?: number }

interface Target { hostname: string; port: number; basePath: string }

const URL_PATTERN = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?(\/[^?#\s]*)?$/;

function parseBaseUrl(baseUrl: string, plain: boolean): Target | string {
  const match = URL_PATTERN.exec(String(baseUrl).trim());
  if (match === null) return 'the backend address is not a valid URL';
  const scheme = match[1];
  if (plain ? scheme !== 'http' : scheme !== 'https') return plain ? 'the plain test mode needs an http:// address' : 'the backend address must be https://';
  const port = match[3] === undefined ? (scheme === 'https' ? 443 : 80) : Number(match[3]);
  if (!(port >= 1 && port <= 65535)) return 'the backend port is out of range';
  const host = match[2];
  return {
    hostname: host.charAt(0) === '[' ? host.slice(1, -1) : host,
    port,
    basePath: (match[4] || '').replace(/\/+$/, ''),
  };
}

const OFFLINE_CODES = ['EHOSTUNREACH', 'ENETUNREACH'];
// OpenSSL's verify results as Node reports them in `error.code`.
const CLOCK_CODES = ['CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED'];
const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|ERR_OSSL_)|CERT|SIGNATURE|^UNABLE_TO_|^EPROTO$|^HOSTNAME_MISMATCH$/;

/** Maps a socket, TLS or resolver error to its kind. */
export function classifyError(error: unknown): UplinkErrorKind {
  if (error instanceof UplinkError) return error.kind;
  if (isDnsFailure(error)) return 'dns';
  const e = (error !== null && typeof error === 'object' ? error : {}) as { code?: unknown; message?: unknown; cert?: unknown; reason?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (OFFLINE_CODES.indexOf(code) >= 0) return 'offline';
  if (CLOCK_CODES.indexOf(code) >= 0) return 'clock';
  if (code !== '' && TLS_CODE.test(code)) return 'tls';
  // Node 8 reports a host name that does not match the certificate without a code (tls.checkServerIdentity)
  const message = typeof e.message === 'string' ? e.message : '';
  if (code === '' && (e.cert !== undefined || /certificate|altnames|ssl|tls/i.test(message))) return 'tls';
  return 'server-error'; // refused, reset, hang-up: the backend side is not answering properly
}

function statusKind(status: number): UplinkErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status >= 500) return 'server-error';
  return 'client-error'; // other 4xx, and anything that is neither 2xx nor 5xx
}

function toUplinkError(error: unknown): UplinkError {
  if (error instanceof UplinkError) return error;
  const kind = classifyError(error);
  const code = error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
  return new UplinkError(kind, 'request failed (' + (code || kind) + ')');
}

function abortRequest(req: ClientRequestLike | null): void {
  if (req === null) return;
  try {
    if (typeof req.abort === 'function') req.abort();
    else if (typeof req.destroy === 'function') req.destroy();
  } catch {
    // already gone
  }
}

const globalTimers: TimeoutApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class HttpsClient {
  private readonly https: HttpsModuleLike;
  private readonly timers: TimeoutApi;
  private readonly lease: () => Lease;
  private readonly timeoutMs: number;
  private readonly ca: string[] | null;
  private readonly target: Target | null;
  private readonly targetProblem: string;
  private readonly lookup: LookupFn;
  private agent: AgentLike | null = null;
  /**
   * Requests not yet settled, so `close()` can end them. Without this, a request waiting in the agent's
   * queue (one socket) would be given a new socket on the orphaned agent once the old one is destroyed,
   * and be sent after `close()`. Bounded by the callers: every entry has its own timeout and leaves the
   * list when it settles.
   */
  private readonly inFlight: Array<() => void> = [];

  constructor(o: HttpsClientOptions) {
    this.https = o.https || (nodeHttps as unknown as HttpsModuleLike);
    this.timers = o.timers || globalTimers;
    this.lease = o.lease;
    this.timeoutMs = typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? o.timeoutMs : HTTPS_TIMEOUT_MS;
    this.ca = Array.isArray(o.extraCaPem) && o.extraCaPem.length > 0 ? o.extraCaPem.slice() : null;
    const parsed = parseBaseUrl(o.baseUrl, o.plainHttpForTests === true);
    this.target = typeof parsed === 'string' ? null : parsed;
    this.targetProblem = typeof parsed === 'string' ? parsed : '';
    if (this.target === null) {
      try {
        o.log.warn('uplink: ' + this.targetProblem);
      } catch {
        // logging is best effort
      }
    }
    this.lookup = createLeaseLookup({
      dns: o.dns || (nodeDns as unknown as DnsModuleLike),
      lease: () => this.currentLease(),
      clock: o.clock || { now: () => Date.now() },
      timers: this.timers,
    });
  }

  /** Whether the uplink has a lease right now. Never throws. */
  online(): boolean {
    return this.currentLease().online;
  }

  request<T>(method: 'GET' | 'POST', path: string, body: unknown, bearer: string, options?: RequestOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: unknown = null;
      let req: ClientRequestLike | null = null;
      const cancel = (): void => {
        finish(new UplinkError('offline', 'the uplink was closed'));
        abortRequest(req);
      };
      const finish = (error: UplinkError | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.timers.clearTimeout(timer);
        timer = null;
        const index = this.inFlight.indexOf(cancel);
        if (index >= 0) this.inFlight.splice(index, 1);
        if (error !== null) reject(error);
        else resolve(value as T);
      };

      const target = this.target;
      if (target === null) return finish(new UplinkError('client-error', this.targetProblem));
      if (!this.online()) return finish(new UplinkError('offline', 'no uplink lease'));

      let payload: string | null = null;
      if (body !== null && body !== undefined) {
        try {
          payload = JSON.stringify(body); // no indentation
        } catch {
          return finish(new UplinkError('client-error', 'the request body is not JSON'));
        }
      }
      const headers: Record<string, string | number> = { Accept: 'application/json', Authorization: 'Bearer ' + bearer };
      if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload, 'utf8');
      }
      const requestOptions: Record<string, unknown> = {
        method,
        hostname: target.hostname,
        port: target.port,
        path: target.basePath + path,
        headers,
        agent: this.currentAgent(),
        lookup: this.lookup,
      };
      // On Node 8 `ca` replaces the bundled roots (tls.rootCertificates only exists from Node 12), so a
      // backend reached with extra CAs must chain to one of them. Verification itself stays on.
      if (this.ca !== null) requestOptions.ca = this.ca;

      this.inFlight.push(cancel);
      try {
        req = this.https.request(requestOptions, (res) => this.readResponse(res, () => req, finish));
        req.on('error', (error: unknown) => finish(toUplinkError(error)));
      } catch (error) {
        abortRequest(req);
        return finish(toUplinkError(error));
      }

      const timeoutMs = options && typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : this.timeoutMs;
      timer = this.timers.setTimeout(() => {
        timer = null;
        finish(new UplinkError('timeout', 'no reply within ' + timeoutMs + ' ms'));
        abortRequest(req);
      }, timeoutMs);

      try {
        if (payload !== null) req.end(payload);
        else req.end();
      } catch (error) {
        finish(toUplinkError(error));
        abortRequest(req);
      }
    });
  }

  /**
   * Ends every request still in flight (rejected as `offline`, aborted, its timer cleared) before the
   * agent's sockets are destroyed, so nothing queued behind the single socket is sent afterwards. The
   * next request opens a new connection.
   */
  close(): void {
    const pending = this.inFlight.splice(0, this.inFlight.length);
    for (const cancel of pending) cancel();
    const agent = this.agent;
    this.agent = null;
    if (agent === null) return;
    try {
      agent.destroy();
    } catch {
      // nothing more to close
    }
  }

  private currentLease(): Lease {
    try {
      const lease = this.lease();
      if (lease && lease.online === true) return { online: true, dns: Array.isArray(lease.dns) ? lease.dns : [] };
    } catch {
      // unreadable lease: offline
    }
    return { online: false, dns: [] };
  }

  private currentAgent(): AgentLike {
    if (this.agent === null) this.agent = new this.https.Agent({ keepAlive: true, maxSockets: 1 });
    return this.agent;
  }

  private readResponse(res: IncomingMessageLike, req: () => ClientRequestLike | null, finish: (error: UplinkError | null, value?: unknown) => void): void {
    const status = typeof res.statusCode === 'number' ? res.statusCode : 0;
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    res.on('data', (chunk: Buffer | string) => {
      if (tooLarge) return;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += buffer.length;
      if (size > MAX_RESPONSE_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        finish(new UplinkError('server-error', 'reply larger than ' + MAX_RESPONSE_BYTES + ' bytes'));
        abortRequest(req());
        return;
      }
      if (status >= 200 && status < 300) chunks.push(buffer); // an error reply's body is read and dropped
    });
    res.on('error', (error: unknown) => finish(toUplinkError(error)));
    res.on('aborted', () => finish(new UplinkError('server-error', 'the reply was cut off')));
    res.on('end', () => {
      if (status < 200 || status >= 300) return finish(new UplinkError(statusKind(status), 'HTTP ' + status));
      const text = Buffer.concat(chunks).toString('utf8');
      if (status === 204 || text.trim() === '') return finish(null, undefined);
      try {
        finish(null, JSON.parse(text));
      } catch {
        finish(new UplinkError('server-error', 'the reply is not JSON'));
      }
    });
  }
}
