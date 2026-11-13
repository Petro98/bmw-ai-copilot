// Static fallback for scripts/run-node8.sh when no Node 8.16.2 runtime is available.
// Parses one file as ES2017 CommonJS with ESLint's own parser and no rules. This proves only
// that the syntax is ES2017; it is not a runtime test (newer built-in APIs are not detected).
// Exit codes: 0 parses, 1 syntax error, 2 usage or read error.
import { readFileSync } from 'node:fs';
import { Linter } from 'eslint';

const file = process.argv[2];
if (!file || process.argv.length > 3) {
  console.error('usage: node scripts/node8-static-check.mjs <file.js>');
  process.exit(2);
}

let source;
try {
  source = readFileSync(file, 'utf8');
} catch (error) {
  console.error(`node8-static-check: cannot read ${file}: ${error.message}`);
  process.exit(2);
}

const linter = new Linter({ configType: 'flat' });
const messages = linter.verify(source, {
  languageOptions: { ecmaVersion: 2017, sourceType: 'commonjs' },
  rules: {},
});
const fatal = messages.filter((m) => m.fatal);

if (fatal.length > 0) {
  for (const m of fatal) console.error(`${file}:${m.line}:${m.column}: ${m.message}`);
  console.error(`node8-static-check: ${file} is not valid ES2017`);
  process.exit(1);
}
console.log(`node8-static-check: ${file} parses as ES2017 CommonJS`);
