/* eslint-disable @typescript-eslint/no-explicit-any -- the fakes stand in for Node's loosely typed request, response and callback APIs */
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import type { AlertEvent } from '@copilot/event-engine';
import type { Log } from '../safe';
import { HttpsClient, MAX_RESPONSE_BYTES, UplinkError, type HttpsClientOptions, type HttpsModuleLike } from './https-client';
import type { Lease } from './lease';
import { DNS_CACHE_MAX, DNS_CACHE_MS, DNS_LOOKUP_TIMEOUT_MS, createLeaseLookup, type DnsModuleLike, type LookupFn, type TimeoutApi } from './resolver';
import { UplinkClient } from './uplink-client';

// Most tests use fake https and dns modules. The close() and long-poll tests run Node's real http
// module and Agent against a server on 127.0.0.1 (nothing leaves the machine; names resolve through
// the fake dns module), because the bugs they guard against live in the Agent's queueing.

const quietLog: Log = { info() {}, warn() {}, error() {} };
const ONLINE: Lease = { online: true, dns: ['192.0.2.53'] };
const BASE = 'https://api.example.invalid/copilot';

class FakeRequest extends EventEmitter {
  chunks: string[] = [];
  ended = false;
  aborted = false;
  write(chunk: string | Buffer): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) this.chunks.push(String(chunk));
    this.ended = true;
  }
  abort(): void {
    this.aborted = true;
  }
  body(): string {
    return this.chunks.join('');
  }
}

interface Exchange {
  options: Record<string, any>;
  req: FakeRequest;
  respond(status: number, body?: string): void;
  fail(code: string, message?: string): void;
}

/** A stand-in for Node's https module: each request is handed to `serve` after the client has sent it. */
function fakeHttps(serve: (exchange: Exchange) => void) {
  const exchanges: Exchange[] = [];
  const agents: Array<{ options: Record<string, unknown>; destroyed: boolean }> = [];
  const module: HttpsModuleLike & { exchanges: Exchange[]; agents: typeof agents } = {
    exchanges,
    agents,
    Agent: class {
      options: Record<string, unknown>;
      destroyed = false;
      constructor(options: Record<string, unknown>) {
        this.options = options;
        agents.push(this);
      }
      destroy(): void {
        this.destroyed = true;
      }
    } as unknown as HttpsModuleLike['Agent'],
    request(options: Record<string, any>, onResponse: (res: any) => void) {
      const req = new FakeRequest();
      const exchange: Exchange = {
        options,
        req,
        respond(status, body) {
          const res = Object.assign(new EventEmitter(), { statusCode: status, resume() {} });
          onResponse(res);
          if (body !== undefined && body !== '') res.emit('data', Buffer.from(body, 'utf8'));
          res.emit('end');
        },
        fail(code, message) {
          req.emit('error', Object.assign(new Error(message || code), { code }));
        },
      };
      exchanges.push(exchange);
      setImmediate(() => serve(exchange));
      return req as any;
    },
  };
  return module;
}

function client(https: HttpsModuleLike, overrides: Partial<HttpsClientOptions> = {}): HttpsClient {
  return new HttpsClient({ baseUrl: BASE, lease: () => ONLINE, log: quietLog, https, dns: fakeDns().module, ...overrides });
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UplinkError);
    return (error as UplinkError).kind;
  }
  return 'resolved';
}

afterEach(() => {
  vi.useRealTimers();
});

test('a POST sends compact JSON with the bearer header to the base path and resolves the parsed reply', async () => {
  const https = fakeHttps((x) => x.respond(200, '{"turn":{"id":"t1"}}'));
  const reply = await client(https).request<{ turn: { id: string } }>('POST', '/car/v1/ask', { text: 'Як справи?', style: 'full' }, 'device-1.secret-1');
  expect(reply).toEqual({ turn: { id: 't1' } });
  const { options, req } = https.exchanges[0];
  expect(options.method).toBe('POST');
  expect(options.hostname).toBe('api.example.invalid');
  expect(options.port).toBe(443);
  expect(options.path).toBe('/copilot/car/v1/ask');
  expect(options.headers.Authorization).toBe('Bearer device-1.secret-1');
  expect(options.headers['Content-Type']).toBe('application/json');
  expect(options.headers['Content-Length']).toBe(Buffer.byteLength(req.body(), 'utf8'));
  expect(req.body()).toBe('{"text":"Як справи?","style":"full"}');
  expect(req.ended).toBe(true);
});

test('a GET carries no body and a 204 resolves undefined', async () => {
  const https = fakeHttps((x) => x.respond(204));
  await expect(client(https).request('GET', '/car/v1/config', null, 'd.s')).resolves.toBeUndefined();
  expect(https.exchanges[0].req.body()).toBe('');
  expect(https.exchanges[0].options.headers['Content-Length']).toBeUndefined();
});

test('one keep-alive agent with a single socket and strict certificate checks', async () => {
  const https = fakeHttps((x) => x.respond(204));
  const c = client(https, { extraCaPem: ['-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'] });
  await c.request('POST', '/a', {}, 'd.s');
  await c.request('POST', '/b', {}, 'd.s');
  expect(https.agents).toHaveLength(1);
  expect(https.agents[0].options).toMatchObject({ keepAlive: true, maxSockets: 1 });
  for (const { options } of https.exchanges) {
    expect(options.agent).toBe(https.agents[0]);
    expect(options.rejectUnauthorized).not.toBe(false);
    expect(typeof options.lookup).toBe('function');
    expect(options.ca).toEqual(['-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n']);
  }
  expect(https.agents[0].options.rejectUnauthorized).not.toBe(false);
});

test('without extra CAs the platform roots are used (no ca option)', async () => {
  const https = fakeHttps((x) => x.respond(204));
  await client(https).request('POST', '/a', {}, 'd.s');
  expect('ca' in https.exchanges[0].options).toBe(false);
});

test.each([
  ['EHOSTUNREACH', 'offline'],
  ['ENETUNREACH', 'offline'],
  ['CERT_HAS_EXPIRED', 'clock'],
  ['CERT_NOT_YET_VALID', 'clock'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
  ['SELF_SIGNED_CERT_IN_CHAIN', 'tls'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
  ['EPROTO', 'tls'],
  ['ECONNREFUSED', 'server-error'],
  ['ECONNRESET', 'server-error'],
])('error %s maps to %s', async (code, kind) => {
  const https = fakeHttps((x) => x.fail(code));
  expect(await kindOf(client(https).request('POST', '/car/v1/snapshots', { snapshots: [] }, 'd.s'))).toBe(kind);
});

test.each([
  [401, 'unauthorized'],
  [403, 'unauthorized'],
  [400, 'client-error'],
  [404, 'client-error'],
  [413, 'client-error'],
  [500, 'server-error'],
  [503, 'server-error'],
])('HTTP %d maps to %s', async (status, kind) => {
  const https = fakeHttps((x) => x.respond(status, '{"error":{"code":"internal","message":"x"}}'));
  expect(await kindOf(client(https).request('POST', '/car/v1/snapshots', { snapshots: [] }, 'd.s'))).toBe(kind);
});

test('a reply that is not JSON or is too large is a server error', async () => {
  const notJson = fakeHttps((x) => x.respond(200, '<html>'));
  expect(await kindOf(client(notJson).request('GET', '/x', null, 'd.s'))).toBe('server-error');
  const huge = fakeHttps((x) => x.respond(200, '"' + 'a'.repeat(MAX_RESPONSE_BYTES) + '"'));
  expect(await kindOf(client(huge).request('GET', '/x', null, 'd.s'))).toBe('server-error');
  expect(huge.exchanges[0].req.aborted).toBe(true);
});

test('no lease means offline and no request at all', async () => {
  const https = fakeHttps((x) => x.respond(204));
  const c = client(https, { lease: () => ({ online: false, dns: [] }) });
  expect(c.online()).toBe(false);
  expect(await kindOf(c.request('POST', '/a', {}, 'd.s'))).toBe('offline');
  expect(https.exchanges).toHaveLength(0);
  expect(https.agents).toHaveLength(0);
});

test('a throwing lease reader counts as offline', async () => {
  const https = fakeHttps((x) => x.respond(204));
  const c = client(https, {
    lease: () => {
      throw new Error('EACCES');
    },
  });
  expect(c.online()).toBe(false);
  expect(await kindOf(c.request('POST', '/a', {}, 'd.s'))).toBe('offline');
});

test('a request that hangs is abandoned after the timeout', async () => {
  const https = fakeHttps(() => {});
  const c = client(https, { timeoutMs: 30 });
  const started = Date.now();
  expect(await kindOf(c.request('POST', '/car/v1/snapshots', { snapshots: [] }, 'd.s'))).toBe('timeout');
  expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  expect(https.exchanges[0].req.aborted).toBe(true);
  // a late error from the aborted request is swallowed, not thrown
  expect(() => https.exchanges[0].fail('ECONNRESET')).not.toThrow();
});

test('the default timeout is 15 s and a request may ask for a longer one', async () => {
  vi.useFakeTimers();
  const https = fakeHttps(() => {});
  const c = client(https);
  let shortKind = '';
  let longKind = '';
  void kindOf(c.request('GET', '/a', null, 'd.s')).then((k) => (shortKind = k));
  void kindOf(c.request('GET', '/b', null, 'd.s', { timeoutMs: 35_000 })).then((k) => (longKind = k));
  await vi.advanceTimersByTimeAsync(14_999);
  expect(shortKind).toBe('');
  await vi.advanceTimersByTimeAsync(1);
  expect(shortKind).toBe('timeout');
  expect(longKind).toBe('');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(longKind).toBe('timeout');
});

test('close() destroys the agent and closes the client until reopen(); then a fresh agent is used', async () => {
  const https = fakeHttps((x) => x.respond(204));
  const timers = trackedTimers();
  const c = client(https, { timers: timers.api });
  await c.request('POST', '/a', {}, 'd.s');
  c.close();
  expect(https.agents[0].destroyed).toBe(true);
  // closed for good: refused at once, no request, no agent, no timer
  expect(await kindOf(c.request('POST', '/a', {}, 'd.s'))).toBe('offline');
  expect(https.exchanges).toHaveLength(1);
  expect(https.agents).toHaveLength(1);
  expect(timers.pending()).toBe(0);
  c.close();
  c.reopen();
  await c.request('POST', '/a', {}, 'd.s');
  expect(https.agents).toHaveLength(2);
  expect(https.agents[1].destroyed).toBe(false);
  c.reopen(); // reopening an open client changes nothing
  await c.request('POST', '/b', {}, 'd.s');
  expect(https.agents).toHaveLength(2);
  c.close();
  c.close();
  expect(https.agents[1].destroyed).toBe(true);
});

test('after close() the lookup given to the sockets answers with an error at once: no DNS query, no timer', async () => {
  const dns = fakeDns();
  const timers = trackedTimers();
  const https = fakeHttps((x) => x.respond(204));
  const c = client(https, { dns: dns.module, timers: timers.api });
  await c.request('POST', '/a', {}, 'd.s');
  const lookup = https.exchanges[0].options.lookup as LookupFn;
  c.close();
  const answer = await lookupOnce(lookup, 'api.example.invalid');
  expect(answer.err).toBeInstanceOf(Error);
  expect(dns.calls).toHaveLength(0);
  expect(timers.pending()).toBe(0);
  // a lookup handed out before a reopen stays dead after it
  c.reopen();
  expect((await lookupOnce(lookup, 'api.example.invalid')).err).toBeInstanceOf(Error);
  expect(dns.calls).toHaveLength(0);
});

test('close() clears a resolver timer that is already running and ends that lookup with an error', async () => {
  const dns = fakeDns(() => ({ hang: true }));
  const timers = trackedTimers();
  const lookupErrors: unknown[] = [];
  const https = fakeHttps((x) => (x.options.lookup as LookupFn)(x.options.hostname, {}, (err) => lookupErrors.push(err)));
  const c = client(https, { dns: dns.module, timers: timers.api });
  const pending = kindOf(c.request('POST', '/a', {}, 'd.s'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  expect(dns.calls).toHaveLength(1);
  expect(timers.pending()).toBe(2); // the request's timeout and the resolver's 10 s timer
  c.close();
  expect(timers.pending()).toBe(0);
  expect(await pending).toBe('offline');
  await Promise.resolve();
  await Promise.resolve();
  expect(lookupErrors).toHaveLength(1);
  expect(lookupErrors[0]).toBeInstanceOf(Error);
  expect(dns.resolvers[0].cancelled).toBe(1);
});

test('the dialog long-poll gets its own single-socket agent, created on first use and destroyed by close()', async () => {
  const https = fakeHttps((x) => x.respond(204));
  const c = client(https);
  await c.request('POST', '/car/v1/alerts', {}, 'd.s');
  expect(https.agents).toHaveLength(1);
  await c.request('GET', '/car/v1/dialog', null, 'd.s', { timeoutMs: 35_000, longPoll: true });
  await c.request('GET', '/car/v1/dialog', null, 'd.s', { timeoutMs: 35_000, longPoll: true });
  await c.request('POST', '/car/v1/ask', {}, 'd.s');
  expect(https.agents).toHaveLength(2);
  expect(https.agents[1].options).toMatchObject({ keepAlive: true, maxSockets: 1 });
  expect(https.exchanges.map((x) => https.agents.indexOf(x.options.agent))).toEqual([0, 1, 1, 0]);
  c.close();
  expect(https.agents.map((a) => a.destroyed)).toEqual([true, true]);
});

test('a request given a cancel handle can be ended alone: rejected as offline, aborted, its timer cleared, the rest untouched', async () => {
  const https = fakeHttps(() => {});
  const timers = trackedTimers();
  const c = client(https, { timers: timers.api });
  let cancel: (() => void) | null = null;
  const poll = kindOf(c.request('GET', '/car/v1/dialog', null, 'd.s', { timeoutMs: 35_000, longPoll: true, cancelHandle: (fn) => (cancel = fn) }));
  const alerts = c.request('POST', '/car/v1/alerts', { alerts: [] }, 'd.s');
  expect(cancel).not.toBeNull();
  expect(timers.pending()).toBe(2);
  cancel!();
  expect(await poll).toBe('offline');
  expect(https.exchanges[0].req.aborted).toBe(true);
  expect(https.exchanges[1].req.aborted).toBe(false);
  expect(timers.pending()).toBe(1);
  expect(https.agents.map((a) => a.destroyed)).toEqual([false, false]);
  await new Promise((resolve) => setImmediate(resolve));
  https.exchanges[1].respond(204);
  await expect(alerts).resolves.toBeUndefined();
  expect(() => cancel!()).not.toThrow();                      // after it settled: nothing happens
  // the client is still open: the next poll goes out on the same poll agent
  const next = c.request('GET', '/car/v1/dialog', null, 'd.s', { timeoutMs: 35_000, longPoll: true });
  await new Promise((resolve) => setImmediate(resolve));
  https.exchanges[2].respond(200, '{"turns":[]}');
  await expect(next).resolves.toEqual({ turns: [] });
  expect(https.exchanges[2].options.agent).toBe(https.exchanges[0].options.agent);
  expect(timers.pending()).toBe(0);

  // a handle that throws does not break the request
  const ok = fakeHttps((x) => x.respond(204));
  const handleThrows = () => {
    throw new Error('caller bug');
  };
  await expect(client(ok).request('GET', '/car/v1/dialog', null, 'd.s', { longPoll: true, cancelHandle: handleThrows })).resolves.toBeUndefined();
});

// ---- Node's real Agent against a local server ---------------------------------------------------

/** A timer API that knows how many of its timers are still pending. */
function trackedTimers(): { api: TimeoutApi; pending(): number } {
  const live: unknown[] = [];
  const api: TimeoutApi = {
    setTimeout(fn, ms) {
      const handle: ReturnType<typeof setTimeout> = setTimeout(() => {
        const at = live.indexOf(handle);
        if (at >= 0) live.splice(at, 1);
        fn();
      }, ms);
      live.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      const at = live.indexOf(handle);
      if (at >= 0) live.splice(at, 1);
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  return { api, pending: () => live.length };
}

interface Arrival { method: string; url: string; res: http.ServerResponse }
const servers: http.Server[] = [];

/** A plain-HTTP server on 127.0.0.1; `answer` replies to a request or returns false to hold it open. */
async function loopback(answer: (a: Arrival) => boolean = () => false): Promise<{ port: number; arrivals: Arrival[]; connections: () => number }> {
  const arrivals: Arrival[] = [];
  let connections = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const arrival = { method: req.method || '', url: req.url || '', res };
      arrivals.push(arrival);
      answer(arrival);
    });
  });
  server.on('connection', () => connections++);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, arrivals, connections: () => connections };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!condition()) throw new Error('timed out waiting for ' + what);
}

/** Gives the sockets time to close and the Agent time to act on its queue. */
async function letSocketsSettle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

function realClient(port: number, extra: Partial<HttpsClientOptions>): HttpsClient {
  return new HttpsClient({
    baseUrl: 'http://copilot.example.invalid:' + port,
    plainHttpForTests: true,
    https: http as unknown as HttpsModuleLike,
    lease: () => ONLINE,
    log: quietLog,
    ...extra,
  });
}

test('close() with a request held and one queued behind the single socket: no DNS query and no timer afterwards, even with the DNS cache expired', async () => {
  const server = await loopback(); // holds every request
  const dns = fakeDns(() => ({ addresses: ['127.0.0.1'] }));
  const timers = trackedTimers();
  const now = { t: 1_000_000 };
  const c = realClient(server.port, { dns: dns.module, timers: timers.api, clock: { now: () => now.t } });
  const held = kindOf(c.request('GET', '/car/v1/config', null, 'd.s'));
  await waitFor(() => server.arrivals.length === 1, 'the first request');
  const queued = kindOf(c.request('POST', '/car/v1/alerts', { alerts: [] }, 'd.s'));
  await letSocketsSettle();
  expect(server.arrivals).toHaveLength(1); // the second one waits in the Agent's queue
  expect(dns.calls).toHaveLength(1);
  now.t += DNS_CACHE_MS + 1;

  c.close();
  expect(timers.pending()).toBe(0);
  expect(await held).toBe('offline');
  expect(await queued).toBe('offline');
  await letSocketsSettle();
  expect(dns.calls).toHaveLength(1);
  expect(timers.pending()).toBe(0);
  expect(server.arrivals).toHaveLength(1);
});

test('with a dialog poll held open, an alert POST and a question go out at once on the other socket', async () => {
  const turn = { id: 't1', at: 1, question: 'Стан авто', answer: 'Усе гаразд.', style: 'full', source: 'car', model: 'm', snapshotAt: null };
  const server = await loopback((a) => {
    if (a.url.indexOf('/car/v1/dialog') === 0) return false;
    if (a.url === '/car/v1/ask') {
      a.res.setHeader('Content-Type', 'application/json');
      a.res.end(JSON.stringify({ turn }));
    } else {
      a.res.statusCode = 204;
      a.res.end();
    }
    return true;
  });
  const timers = trackedTimers();
  const dns = fakeDns(() => ({ addresses: ['127.0.0.1'] }));
  const http1 = realClient(server.port, { dns: dns.module, timers: timers.api });
  const uplink = new UplinkClient({ http: http1, device: () => ({ id: 'device-0001', secret: 'secret-0001' }), clock: { now: () => 1_000_000 }, log: quietLog });

  const poll = uplink.pollDialog(null).then(
    () => 'resolved',
    (error: UplinkError) => error.kind,
  );
  await waitFor(() => server.arrivals.length === 1, 'the dialog poll');
  const alert: AlertEvent = {
    id: 'a1', ruleId: 'r', dedupKey: 'k1', provenance: 'owner-configured', severity: 'warning',
    title: 'Ліміт', detail: null, at: 1, active: true, clearedAt: null,
  };
  uplink.sendAlerts([alert]);
  await expect(uplink.ask('Стан авто', 'full')).resolves.toEqual(turn);
  await waitFor(() => uplink.queued().alerts === 0 && server.arrivals.length === 3, 'the alert');
  expect(server.arrivals.map((a) => a.method + ' ' + a.url)).toEqual(['GET /car/v1/dialog', 'POST /car/v1/alerts', 'POST /car/v1/ask']);
  expect(server.connections()).toBe(2); // the poll's socket and one for everything else

  uplink.close();
  expect(await poll).toBe('offline');
  expect(timers.pending()).toBe(0);
});

test('a plain http:// address is refused unless the test-only plain mode is on; a bad address never throws', async () => {
  const https = fakeHttps((x) => x.respond(204));
  expect(await kindOf(client(https, { baseUrl: 'http://api.example.invalid' }).request('POST', '/a', {}, 'd.s'))).toBe('client-error');
  expect(await kindOf(client(https, { baseUrl: 'not a url' }).request('POST', '/a', {}, 'd.s'))).toBe('client-error');
  expect(await kindOf(client(https, { baseUrl: 'https://api.example.invalid', plainHttpForTests: true }).request('POST', '/a', {}, 'd.s'))).toBe('client-error');
  expect(https.exchanges).toHaveLength(0);
  const plain = client(https, { baseUrl: 'http://127.0.0.1:8080', plainHttpForTests: true });
  await plain.request('POST', '/a', {}, 'd.s');
  expect(https.exchanges[0].options).toMatchObject({ hostname: '127.0.0.1', port: 8080, path: '/a' });
});

// ---- the lease's DNS servers ---------------------------------------------------------------------

function fakeDns(answer: (host: string, family: 4 | 6) => { error?: string; addresses?: string[]; hang?: boolean } = () => ({ addresses: ['203.0.113.7'] })) {
  const calls: Array<{ host: string; family: 4 | 6; servers: string[] }> = [];
  const resolvers: Array<{ servers: string[]; cancelled: number }> = [];
  const module: DnsModuleLike = {
    Resolver: class {
      servers: string[] = [];
      cancelled = 0;
      constructor() {
        resolvers.push(this);
      }
      setServers(servers: string[]): void {
        this.servers = servers.slice();
      }
      cancel(): void {
        this.cancelled++;
      }
      resolve4(host: string, cb: (err: Error | null, addresses?: string[]) => void): void {
        this.answer(host, 4, cb);
      }
      resolve6(host: string, cb: (err: Error | null, addresses?: string[]) => void): void {
        this.answer(host, 6, cb);
      }
      private answer(host: string, family: 4 | 6, cb: (err: Error | null, addresses?: string[]) => void): void {
        calls.push({ host, family, servers: this.servers.slice() });
        const a = answer(host, family);
        if (a.hang) return;
        setImmediate(() => (a.error ? cb(Object.assign(new Error(a.error), { code: a.error })) : cb(null, a.addresses || [])));
      }
    } as unknown as DnsModuleLike['Resolver'],
  };
  return { module, calls, resolvers };
}

function lookupOnce(lookup: LookupFn, host: string, options: Record<string, unknown> = {}): Promise<{ err: any; address: any; family: any }> {
  return new Promise((resolve) => lookup(host, options, (err: any, address: any, family: any) => resolve({ err, address, family })));
}

function leaseLookup(dns: DnsModuleLike, lease: () => Lease = () => ONLINE, now = { t: 1_000_000 }): LookupFn {
  return createLeaseLookup({ dns, lease, clock: { now: () => now.t }, timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as any) } });
}

test('names resolve through the lease DNS servers, IPv4 first then IPv6', async () => {
  const dns = fakeDns((host, family) => (host === 'v6.example.invalid' && family === 4 ? { error: 'ENODATA' } : { addresses: [family === 4 ? '203.0.113.7' : '2001:db8::7'] }));
  const lookup = leaseLookup(dns.module);
  expect(await lookupOnce(lookup, 'api.example.invalid')).toEqual({ err: null, address: '203.0.113.7', family: 4 });
  expect(dns.calls[0]).toEqual({ host: 'api.example.invalid', family: 4, servers: ['192.0.2.53'] });
  expect(await lookupOnce(lookup, 'v6.example.invalid')).toEqual({ err: null, address: '2001:db8::7', family: 6 });
  const all = await lookupOnce(lookup, 'api.example.invalid', { all: true });
  expect(all.err).toBeNull();
  expect(all.address).toEqual([{ address: '203.0.113.7', family: 4 }]);
});

test('an IP address needs no lookup', async () => {
  const dns = fakeDns();
  expect(await lookupOnce(leaseLookup(dns.module), '192.0.2.80')).toEqual({ err: null, address: '192.0.2.80', family: 4 });
  expect(await lookupOnce(leaseLookup(dns.module), '2001:db8::80')).toEqual({ err: null, address: '2001:db8::80', family: 6 });
  expect(dns.calls).toHaveLength(0);
});

test('answers are cached for five minutes, for at most 32 names', async () => {
  const dns = fakeDns();
  const now = { t: 1_000_000 };
  const lookup = leaseLookup(dns.module, () => ONLINE, now);
  await lookupOnce(lookup, 'api.example.invalid');
  await lookupOnce(lookup, 'api.example.invalid');
  expect(dns.calls).toHaveLength(1);
  now.t += DNS_CACHE_MS + 1;
  await lookupOnce(lookup, 'api.example.invalid');
  expect(dns.calls).toHaveLength(2);
  expect(DNS_CACHE_MS).toBe(300_000);
  expect(DNS_CACHE_MAX).toBe(32);
  for (let i = 0; i < 100; i++) await lookupOnce(lookup, 'n' + i + '.example.invalid');
  const before = dns.calls.length;
  for (let i = 68; i < 100; i++) await lookupOnce(lookup, 'n' + i + '.example.invalid'); // the newest 32 are still cached
  expect(dns.calls.length).toBe(before);
  await lookupOnce(lookup, 'n0.example.invalid'); // long evicted
  expect(dns.calls.length).toBe(before + 1);
});

test('new DNS servers in the lease are used and empty the cache', async () => {
  const dns = fakeDns();
  let lease: Lease = ONLINE;
  const lookup = leaseLookup(dns.module, () => lease);
  await lookupOnce(lookup, 'api.example.invalid');
  lease = { online: true, dns: ['198.51.100.53'] };
  await lookupOnce(lookup, 'api.example.invalid');
  expect(dns.calls.map((c) => c.servers)).toEqual([['192.0.2.53'], ['198.51.100.53']]);
});

test('a failed, empty or missing DNS answer is a dns failure', async () => {
  const failing = leaseLookup(fakeDns(() => ({ error: 'ENOTFOUND' })).module);
  const r1 = await lookupOnce(failing, 'api.example.invalid');
  expect(r1.err).toBeInstanceOf(Error);
  const empty = leaseLookup(fakeDns(() => ({ addresses: [] })).module);
  expect((await lookupOnce(empty, 'api.example.invalid')).err).toBeInstanceOf(Error);
  const noServers = leaseLookup(fakeDns().module, () => ({ online: true, dns: [] }));
  expect((await lookupOnce(noServers, 'api.example.invalid')).err).toBeInstanceOf(Error);
});

test('a DNS server that never answers fails the lookup after 10 s, once', async () => {
  vi.useFakeTimers();
  const lookup = leaseLookup(fakeDns(() => ({ hang: true })).module);
  const callback = vi.fn();
  lookup('api.example.invalid', {}, callback);
  await vi.advanceTimersByTimeAsync(DNS_LOOKUP_TIMEOUT_MS - 1);
  expect(callback).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
  expect(DNS_LOOKUP_TIMEOUT_MS).toBe(10_000);
});

test('a resolver failure reported by the socket maps to dns', async () => {
  const dns = fakeDns(() => ({ error: 'ESERVFAIL' }));
  // the fake socket runs the client's lookup the way net.connect does and fails with its error
  const https = fakeHttps((x) =>
    x.options.lookup(x.options.hostname, {}, (err: Error | null) => {
      if (err) x.req.emit('error', err);
      else x.respond(204);
    }),
  );
  const c = new HttpsClient({ baseUrl: BASE, lease: () => ONLINE, log: quietLog, https, dns: dns.module });
  expect(await kindOf(c.request('POST', '/a', {}, 'd.s'))).toBe('dns');
  expect(dns.calls[0].servers).toEqual(['192.0.2.53']);
});

test('a refused connection is not mistaken for a DNS failure', async () => {
  const https = fakeHttps((x) =>
    x.options.lookup(x.options.hostname, {}, (err: Error | null) => {
      if (err) x.req.emit('error', err);
      else x.fail('ECONNREFUSED');
    }),
  );
  expect(await kindOf(client(https).request('POST', '/a', {}, 'd.s'))).toBe('server-error');
});
