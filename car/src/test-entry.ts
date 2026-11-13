/**
 * Test-only bundle entry: exposes the uplink modules so that car/test/node8-uplink-smoke.js can run
 * them, bundled exactly as the app is (ES2017, CommonJS), on Node 8.16.2. Built to
 * car/build/test-entry.js (git-ignored, never shipped):
 *
 *   node_modules/.bin/esbuild car/src/test-entry.ts --bundle --platform=node --format=cjs \
 *     --target=es2017 --tsconfig=car/tsconfig.json --outfile=car/build/test-entry.js
 */
export { HttpsClient, UplinkError, classifyError } from './uplink/https-client';
export { UplinkClient } from './uplink/uplink-client';
export { RingBuffer } from './uplink/ring-buffer';
export { readLease } from './uplink/lease';
export { createLeaseLookup } from './uplink/resolver';
