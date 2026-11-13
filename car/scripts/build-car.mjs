// Bundles the head-unit app: car/src/main.ts -> car/apps/p98_copilot/main.js, one ES2017 CommonJS file
// for the head unit's Node 8.16.2. The kit's modules stay outside the bundle and are required as the
// kit's own apps require them ('./kit/mgu', ...): car/kit/tools/build.py puts the kit's runtime next
// to the app's javascript. The output is committed: the MGU Store builds from the repository and has
// no bundler.
//
// It also bundles the test-only entry car/src/test-entry.ts -> car/build/test-entry.js with the same
// settings, for the Node 8.16.2 smoke test (car/test/node8-uplink-smoke.js). car/build/ is git-ignored
// and never shipped.
//
//   node car/scripts/build-car.mjs          (npm run build:car)
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const carDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const shared = {
  absWorkingDir: carDir,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2017',
  // `@copilot/*` resolve to the packages' TypeScript sources through tsconfig.base.json `paths`
  tsconfig: 'tsconfig.json',
  external: ['./kit/*'],
  minify: false,
  sourcemap: false,
  charset: 'utf8',
  legalComments: 'inline',
  banner: { js: '/* generated from car/src — do not edit */' },
  logLevel: 'info',
};

await build({ ...shared, entryPoints: ['src/main.ts'], outfile: 'apps/p98_copilot/main.js' });
await build({ ...shared, entryPoints: ['src/test-entry.ts'], outfile: 'build/test-entry.js' });
