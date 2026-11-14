import { expect, test } from 'vitest';
import type { FsApi } from '../platform';
import { LEASE_FILE_NAME, readLease } from './lease';

/** An in-memory FsApi holding the given files; a read of anything else throws like Node's ENOENT. */
function memoryFs(files: Record<string, string>): FsApi {
  return {
    existsSync: (path) => Object.prototype.hasOwnProperty.call(files, path),
    readFileSync: (path) => {
      if (!Object.prototype.hasOwnProperty.call(files, path)) throw Object.assign(new Error('ENOENT: ' + path), { code: 'ENOENT' });
      return files[path];
    },
    writeFileSync: () => {
      throw new Error('readLease must not write');
    },
    renameSync: () => {
      throw new Error('readLease must not rename');
    },
  };
}

const DIR = '/data/app';
const PATH = DIR + '/' + LEASE_FILE_NAME;
// The shape mgu-uplink writes (.research/repos/mgu-store@f4daf7a/native/mgu-uplink/state.go, Lease);
// documentation-range addresses only.
const LEASE = {
  interface: 'vethuplink',
  ip: '192.0.2.10',
  prefix: 24,
  router: '192.0.2.1',
  dns: ['192.0.2.53', '198.51.100.53'],
  leaseSeconds: 3600,
  updated: '2026-11-13T10:00:00Z',
};

test('the lease file is uplink.json in the app data directory', () => {
  expect(LEASE_FILE_NAME).toBe('uplink.json');
});

test('a valid lease is online with its DNS servers', () => {
  expect(readLease(DIR, memoryFs({ [PATH]: JSON.stringify(LEASE) }))).toEqual({ online: true, dns: ['192.0.2.53', '198.51.100.53'] });
  expect(readLease(DIR + '/', memoryFs({ [PATH]: JSON.stringify(LEASE) })).online).toBe(true);
});

test('readLease treats a missing or malformed file as offline', () => {
  const offline = { online: false, dns: [] };
  expect(readLease(DIR, memoryFs({}))).toEqual(offline);
  for (const junk of ['', '{', 'null', '42', '"x"', '[]', '{}', JSON.stringify({ ...LEASE, ip: '' }), JSON.stringify({ ...LEASE, ip: 7 })])
    expect(readLease(DIR, memoryFs({ [PATH]: junk }))).toEqual(offline);
});

test('a throwing file system is offline, never an exception', () => {
  const fs = memoryFs({});
  fs.readFileSync = () => {
    throw new Error('EACCES');
  };
  fs.existsSync = () => {
    throw new Error('EACCES');
  };
  expect(readLease(DIR, fs)).toEqual({ online: false, dns: [] });
});

test('DNS entries that are not IP addresses are dropped and the list is bounded', () => {
  const dns = ['192.0.2.53', 'dns.example.invalid', 42, null, '2001:db8::53', '1.2.3', ...Array.from({ length: 20 }, (_, i) => '192.0.2.' + i)];
  const lease = readLease(DIR, memoryFs({ [PATH]: JSON.stringify({ ...LEASE, dns }) }));
  expect(lease.online).toBe(true);
  expect(lease.dns.slice(0, 2)).toEqual(['192.0.2.53', '2001:db8::53']);
  expect(lease.dns.length).toBeLessThanOrEqual(4);
});

test('a lease without a DNS list is online with no servers', () => {
  const noDns: Partial<typeof LEASE> = { ...LEASE };
  delete noDns.dns;
  expect(readLease(DIR, memoryFs({ [PATH]: JSON.stringify(noDns) }))).toEqual({ online: true, dns: [] });
});
