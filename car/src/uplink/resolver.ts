/**
 * Name resolution for the uplink. The head unit's own resolver does not reach the internet; an app
 * behind the Store's uplink resolves names through the DNS servers its lease names
 * (.research/repos/mgu-store@f4daf7a/native/mgu-uplink/README.md, below the table).
 *
 * createLeaseLookup() returns a function with the shape of Node's `dns.lookup`, given to
 * `https.request` as its `lookup` option (Node 8.16: net.Socket#connect honours `options.lookup`).
 * It uses `dns.Resolver` (Node >= 8.3) with the lease's servers, caches answers for five minutes, keeps
 * at most 32 names, and gives up on a lookup after 10 s. Its `cancelPending()` ends every lookup still
 * waiting for an answer (timer cleared, outstanding queries cancelled), for HttpsClient.close().
 */
import type { Clock } from '@copilot/vehicle-core';
import { isIpAddress, type Lease } from './lease';

export const DNS_CACHE_MS = 300_000;
export const DNS_CACHE_MAX = 32;
export const DNS_LOOKUP_TIMEOUT_MS = 10_000;

type ResolveCallback = (err: Error | null, addresses?: string[]) => void;
/** The part of Node's `dns.Resolver` used here (all of it exists in Node 8.16). */
export interface DnsResolverLike {
  setServers(servers: string[]): void;
  resolve4(hostname: string, callback: ResolveCallback): void;
  resolve6(hostname: string, callback: ResolveCallback): void;
  /** Cancels the outstanding queries (Node >= 8.3); optional so that a minimal stand-in needs none. */
  cancel?(): void;
}
export interface DnsModuleLike { Resolver: new () => DnsResolverLike }
export interface TimeoutApi { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }

export interface LookupAddress { address: string; family: number }
export type LookupCallback = (err: Error | null, address?: string | LookupAddress[], family?: number) => void;
export type LookupFn = (hostname: string, options: unknown, callback: LookupCallback) => void;
/** A lookup whose pending queries can be ended at once. */
export interface LeaseLookup extends LookupFn {
  /** Ends every lookup still waiting with an error (delivered as a promise job): no timer is left running. */
  cancelPending(): void;
}

/** Marks an error as a failure of our resolver, so that the client reports `dns` for it. */
const DNS_FAILURE_MARK = 'uplinkDnsFailure';

export function isDnsFailure(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as Record<string, unknown>)[DNS_FAILURE_MARK] === true;
}

interface CacheEntry { address: string; family: number; at: number }

export interface LeaseLookupOptions { dns: DnsModuleLike; lease: () => Lease; clock: Clock; timers: TimeoutApi }

export function createLeaseLookup(options: LeaseLookupOptions): LeaseLookup {
  const { dns, lease, clock, timers } = options;
  /** The lookups waiting for an answer; each leaves within 10 s (its timer), so the list stays bounded. */
  const pending: Array<() => void> = [];
  let resolver: DnsResolverLike | null = null;
  let serversKey = '';
  let cache: Record<string, CacheEntry> = Object.create(null);
  let order: string[] = []; // cached names, oldest first; never longer than DNS_CACHE_MAX

  const forgetAll = (): void => {
    cache = Object.create(null);
    order = [];
  };

  const remember = (name: string, entry: CacheEntry): void => {
    const at = order.indexOf(name);
    if (at >= 0) order.splice(at, 1);
    while (order.length >= DNS_CACHE_MAX) delete cache[order.shift() as string];
    cache[name] = entry;
    order.push(name);
  };

  const cached = (name: string, now: number): CacheEntry | null => {
    const entry = cache[name];
    if (entry === undefined) return null;
    if (now >= entry.at && now - entry.at < DNS_CACHE_MS) return entry;
    return null; // expired (or the clock went backwards): asked again, and replaced when answered
  };

  /** The resolver set to the lease's servers; a change of servers empties the cache. */
  const resolverFor = (servers: string[]): DnsResolverLike => {
    const key = servers.join(',');
    if (resolver === null || key !== serversKey) {
      const next = new dns.Resolver();
      next.setServers(servers);
      resolver = next;
      serversKey = key;
      forgetAll();
    }
    return resolver;
  };

  const leaseLookup = function leaseLookup(hostname: string, lookupOptions: unknown, callback: LookupCallback): void {
    if (typeof lookupOptions === 'function') {
      callback = lookupOptions as LookupCallback;
      lookupOptions = {};
    }
    const opts = (lookupOptions !== null && typeof lookupOptions === 'object' ? lookupOptions : {}) as { all?: unknown; family?: unknown };
    const all = opts.all === true;
    const wantFamily = opts.family === 6 || opts.family === 'IPv6' ? 6 : 0;

    let done = false;
    let timer: unknown = null;
    const finish = (err: Error | null, address?: string, family?: number): void => {
      if (done) return;
      done = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      const at = pending.indexOf(cancel);
      if (at >= 0) pending.splice(at, 1);
      if (err) callback(err);
      else if (all) callback(null, [{ address: address as string, family: family as number }]);
      else callback(null, address, family);
    };
    const fail = (reason: string, code: string): void => {
      const error = new Error('DNS lookup failed: ' + reason) as Error & Record<string, unknown>;
      error.code = code;
      error.hostname = hostname;
      error[DNS_FAILURE_MARK] = true;
      finish(error);
    };

    // Node calls back asynchronously; so do we (a promise job, not a timer).
    const later = (fn: () => void): void => {
      Promise.resolve().then(fn).then(undefined, () => undefined);
    };
    /** Ends this lookup: its timer is cleared now, the error is delivered as a promise job. */
    function cancel(): void {
      if (done) return;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      later(() => fail('the uplink was closed', 'ECANCELLED'));
    }

    try {
      const name = String(hostname).toLowerCase();
      if (isIpAddress(name)) {
        later(() => finish(null, name, name.indexOf(':') >= 0 ? 6 : 4));
        return;
      }
      let current: Lease;
      try {
        current = lease();
      } catch {
        current = { online: false, dns: [] };
      }
      if (!current.online) {
        // the uplink went away: that is "offline", not a DNS failure (the uplink's own wording:
        // "While the uplink is down they get EHOSTUNREACH")
        later(() => finish(Object.assign(new Error('no uplink lease'), { code: 'EHOSTUNREACH' })));
        return;
      }
      if (current.dns.length === 0) {
        later(() => fail('the lease names no DNS server', 'ENOTFOUND'));
        return;
      }
      const active = resolverFor(current.dns);
      const now = clock.now();
      const hit = cached(name, now);
      if (hit !== null) {
        later(() => finish(null, hit.address, hit.family));
        return;
      }

      timer = timers.setTimeout(() => {
        timer = null;
        fail('no answer within ' + DNS_LOOKUP_TIMEOUT_MS + ' ms', 'ETIMEOUT');
      }, DNS_LOOKUP_TIMEOUT_MS);
      pending.push(cancel);

      const answered = (family: number, fallback: (() => void) | null) => (err: Error | null, addresses?: string[]): void => {
        if (done) return;
        const address = !err && Array.isArray(addresses) && typeof addresses[0] === 'string' ? addresses[0] : null;
        if (address !== null) {
          // only answers from the servers still in use are kept
          if (active === resolver) remember(name, { address, family, at: clock.now() });
          finish(null, address, family);
        } else if (fallback !== null) {
          fallback();
        } else {
          fail(err ? err.message : 'no address', (err && (err as Error & { code?: string }).code) || 'ENOTFOUND');
        }
      };
      const ask6 = (): void => active.resolve6(name, answered(6, null));
      if (wantFamily === 6) ask6();
      else active.resolve4(name, answered(4, () => {
        try {
          ask6();
        } catch (error) {
          fail(error instanceof Error ? error.message : 'resolver error', 'ENOTFOUND');
        }
      }));
    } catch (error) {
      fail(error instanceof Error ? error.message : 'resolver error', 'ENOTFOUND');
    }
  } as LeaseLookup;

  leaseLookup.cancelPending = (): void => {
    const waiting = pending.splice(0, pending.length);
    for (const cancel of waiting) cancel();
    if (waiting.length > 0 && resolver !== null && typeof resolver.cancel === 'function') {
      try {
        resolver.cancel();
      } catch {
        // nothing outstanding
      }
    }
  };
  return leaseLookup;
}
