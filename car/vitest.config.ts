import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `@copilot/<name>` resolves to the package's TypeScript source, as in tsconfig.base.json `paths`.
const packagesDir = fileURLToPath(new URL('../packages/', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@copilot\/([a-z0-9-]+)$/, replacement: `${packagesDir}$1/src/index.ts` }],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
