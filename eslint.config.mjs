import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Node globals, listed here so no extra package is needed.
const nodeGlobals = {
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  exports: 'writable',
  module: 'writable',
  process: 'readonly',
  require: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
};

export default defineConfig([
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/coverage/',
    '.research/',
    '.idea/',
    // The Angular panel has its own toolchain and lockfile (Plan 1 Task 14).
    'apps/companion/',
    // Vendored MIT kit, generated bundle and build/preview output (Plan 2).
    'car/kit/',
    'car/apps/',
    'car/build/',
    'car/preview/',
  ]),
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: nodeGlobals },
  },
  {
    // Plain JavaScript that must also run on the head unit's Node 8.16.2: ES2017 CommonJS only.
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2017, sourceType: 'commonjs', globals: nodeGlobals },
  },
]);
