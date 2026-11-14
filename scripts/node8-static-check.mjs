// Static fallback for scripts/run-node8.sh when no Node 8.16.2 runtime is available.
// Parses files as ES2017 CommonJS with ESLint's own parser and no lint rules. This proves only that
// the syntax is ES2017; it is not a runtime test (newer built-in APIs are not detected).
//
//   node scripts/node8-static-check.mjs [--no-follow] <file.js>
//
// Starting from <file.js>, it follows relative string-literal requires (`require('./…')`,
// `require('../…')`) recursively, resolving them like Node does for files (exact path, then `.js`,
// then `/index.js`), and parses every .js file it reaches once. Other requires (built-in or package
// names, non-literal arguments) are not followed; a followed file outside the repository is refused.
// `--no-follow` parses only <file.js>, like `node --check`.
// Exit codes: 0 everything parses, 1 syntax error, 2 usage, read or resolution error.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

const args = process.argv.slice(2);
let follow = true;
if (args[0] === '--no-follow') {
  follow = false;
  args.shift();
}
if (args.length !== 1) fail(2, 'usage: node scripts/node8-static-check.mjs [--no-follow] <file.js>');

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function insideRepo(path) {
  return path === repoRoot || path.startsWith(repoRoot + sep);
}

/** Node's file resolution for a relative specifier: exact file, then `.js`, then `/index.js`. */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, base + '.js', join(base, 'index.js')]) {
    if (isFile(candidate)) return realpathSync(candidate);
  }
  return null;
}

/** An inline rule that records the string-literal argument of every `require(…)` call. */
function requireCollector(found) {
  return {
    create() {
      return {
        CallExpression(node) {
          const [arg] = node.arguments;
          if (node.callee.type !== 'Identifier' || node.callee.name !== 'require' || node.arguments.length !== 1) return;
          if (arg.type === 'Literal' && typeof arg.value === 'string') found.push({ specifier: arg.value, line: node.loc.start.line });
        },
      };
    },
  };
}

const linter = new Linter({ configType: 'flat' });

/** Parses one file; returns the relative specifiers it requires, or exits on a syntax error. */
function parseFile(file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    fail(2, `node8-static-check: cannot read ${file}: ${error.message}`);
  }
  const found = [];
  const messages = linter.verify(source, {
    languageOptions: { ecmaVersion: 2017, sourceType: 'commonjs' },
    plugins: { node8: { rules: { 'collect-requires': requireCollector(found) } } },
    rules: { 'node8/collect-requires': 'error' },
  });
  const fatal = messages.filter((m) => m.fatal);
  if (fatal.length > 0) {
    for (const m of fatal) console.error(`${file}:${m.line}:${m.column}: ${m.message}`);
    fail(1, `node8-static-check: ${file} is not valid ES2017`);
  }
  return found.filter((r) => r.specifier.startsWith('./') || r.specifier.startsWith('../'));
}

let start;
try {
  start = realpathSync(args[0]);
} catch (error) {
  fail(2, `node8-static-check: cannot read ${args[0]}: ${error.message}`);
}

const visited = new Set([start]);
const queue = [start];
while (queue.length > 0) {
  const file = queue.shift();
  const requires = parseFile(file);
  if (!follow) continue;
  for (const { specifier, line } of requires) {
    const target = resolveRelative(file, specifier);
    if (target === null) fail(2, `${file}:${line}: node8-static-check: cannot resolve require('${specifier}')`);
    if (!insideRepo(target)) {
      fail(2, `${file}:${line}: node8-static-check: require('${specifier}') leaves the repository (${target})`);
    }
    if (!target.endsWith('.js') || visited.has(target)) continue;
    visited.add(target);
    queue.push(target);
  }
}

const shown = insideRepo(start) ? relative(repoRoot, start) : start;
console.log(`node8-static-check: ${visited.size} file(s) parse as ES2017 CommonJS (from ${shown}${follow ? ', relative requires followed' : ''})`);
