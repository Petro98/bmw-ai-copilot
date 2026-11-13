/**
 * Test-only bundle entry: exposes the uplink modules so that car/test/node8-uplink-smoke.js can run
 * them, bundled exactly as the app is (ES2017, CommonJS), on Node 8.16.2. Built to
 * car/build/test-entry.js (git-ignored, never shipped) by car/scripts/build-car.mjs, next to the app
 * bundle and with the same esbuild settings:
 *
 *   npm run build:car
 */
export { HttpsClient, UplinkError, classifyError } from './uplink/https-client';
export { UplinkClient } from './uplink/uplink-client';
export { RingBuffer } from './uplink/ring-buffer';
export { readLease } from './uplink/lease';
export { createLeaseLookup } from './uplink/resolver';
