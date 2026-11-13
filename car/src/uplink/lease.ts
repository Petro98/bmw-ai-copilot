/**
 * The Store's internet uplink (mgu-uplink) tells an app that declares internet whether it is online
 * through a lease file in the app's data directory:
 *
 *   /var/opt/public/oap/oap_<uid>/data/uplink.json
 *   { interface, ip, prefix, router, dns[], leaseSeconds, updated }, present only while online
 *
 * (.research/repos/mgu-store@f4daf7a/native/mgu-uplink/README.md, table "Lease for apps", and
 * state.go, `appStateName` and `type Lease`). The unit's own resolver does not reach the internet, so
 * names are resolved through the lease's `dns` servers (same README, below the table).
 */
import type { FsApi } from '../platform';

export interface Lease { online: boolean; dns: string[] }

export const LEASE_FILE_NAME = 'uplink.json';
/** More DNS servers than a DHCP lease carries in practice; the cap only keeps the list bounded. */
const MAX_DNS_SERVERS = 4;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:.]+$/;

/** True for an IPv4 or IPv6 address literal (no host name). */
export function isIpAddress(text: string): boolean {
  return IPV4.test(text) || (text.indexOf(':') >= 0 && IPV6.test(text));
}

function offline(): Lease {
  return { online: false, dns: [] };
}

/** Reads the lease. Any problem (missing, unreadable, malformed, no address) means offline; never throws. */
export function readLease(dataDir: string, fs: FsApi): Lease {
  try {
    const dir = dataDir.replace(/\/+$/, '');
    const parsed: unknown = JSON.parse(fs.readFileSync(dir + '/' + LEASE_FILE_NAME, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return offline();
    const lease = parsed as { ip?: unknown; dns?: unknown };
    if (typeof lease.ip !== 'string' || lease.ip === '') return offline();
    const dns: string[] = [];
    if (Array.isArray(lease.dns)) {
      for (const server of lease.dns) {
        if (dns.length >= MAX_DNS_SERVERS) break;
        if (typeof server === 'string' && isIpAddress(server)) dns.push(server);
      }
    }
    return { online: true, dns };
  } catch {
    return offline();
  }
}
