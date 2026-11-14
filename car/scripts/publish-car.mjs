#!/usr/bin/env node
// Prepares the owner's private MGU Store source: copies what the Store builds the car app from (mgu-repo.json,
// car/kit, car/apps) into a separate git checkout the owner controls, writes the backend address into the
// copied app.json "config" only, prints a summary of what changed there, and stops.
//
// It never commits, never pushes, runs no git command and no network command, and never writes into this
// repository: the backend address must not reach the public source repository (spec §6.4 "Backend address").
// It knows no device secret (the car makes its own on its first run) and does not print the address.
//
//   node car/scripts/publish-car.mjs [--drop-reading <reading>]
//
// Settings, from the environment or from .env.car at the repository root (git-ignored; see .env.car.example):
//   CAR_DEPLOY_DIR    the private deploy checkout (an existing directory outside this repository)
//   CAR_BACKEND_URL   the backend's https:// address, as the phone opens it
//
// --drop-reading battery12vCharge: leaves that reading's signal out of the deployed app.json (and tells the app,
// in "config".droppedReadings, to report it as not on this vehicle). The fallback for firmware that lacks the
// field, if the Store refuses to install the app because of it (docs/CAR_INSTALL.md).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_ID = 'p98_copilot';
const APP_JSON = `car/apps/${APP_ID}/app.json`;
/** What the Store needs (mgu-repo.json: apps under car/apps, built with car/kit/tools/build.py). */
const COPIED = ['mgu-repo.json', 'car/kit', 'car/apps'];
/** Never copied: editor and interpreter litter. */
const SKIPPED = new Set(['.DS_Store', '__pycache__']);

/**
 * Readings whose signal may be left out, each with the one field that feeds it and nothing else
 * (packages/vehicle-core/src/catalogue.ts: battery12vCharge is CDS.statusBattery2.conditionBatteryChargingCondition).
 */
const DROPPABLE = {
  battery12vCharge: { iface: 'de.bmw.infotainment.vehicle.CDS', field: 'statusBattery2' },
};

/** As car/src/uplink/https-client.ts accepts it: https, a host name or a bracketed IPv6 address, a port, a path. */
const URL_PATTERN = /^https:\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?(\/[^?#\s]*)?$/;

function fail(message) {
  console.error('publish-car: ' + message);
  process.exitCode = 1;
  throw new Error(message);
}

function usage() {
  console.log('usage: node car/scripts/publish-car.mjs [--drop-reading <reading>]');
  console.log('  reads CAR_DEPLOY_DIR and CAR_BACKEND_URL from the environment or from .env.car');
  console.log('  droppable readings: ' + Object.keys(DROPPABLE).join(', '));
}

function parseArgs(argv) {
  const drops = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true, drops };
    let value = null;
    if (arg === '--drop-reading') value = argv[++i];
    else if (arg.startsWith('--drop-reading=')) value = arg.slice('--drop-reading='.length);
    else fail('unknown argument ' + JSON.stringify(arg) + ' (--help lists the options)');
    if (!value || !Object.prototype.hasOwnProperty.call(DROPPABLE, value)) {
      fail('--drop-reading needs one of: ' + Object.keys(DROPPABLE).join(', '));
    }
    if (drops.indexOf(value) < 0) drops.push(value);
  }
  return { help: false, drops };
}

/** KEY=VALUE lines, # comments, optional single or double quotes. Values are never printed. */
function readEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[m[1]] = value;
  }
  return values;
}

function setting(name, file) {
  const fromEnv = process.env[name];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const fromFile = file[name];
  return typeof fromFile === 'string' && fromFile.trim() !== '' ? fromFile.trim() : null;
}

function backendUrlFrom(raw) {
  if (raw === null) fail('CAR_BACKEND_URL is not set (environment or .env.car)');
  const url = raw.replace(/\/+$/, '');
  const m = URL_PATTERN.exec(url);
  if (!m) fail('CAR_BACKEND_URL must be an https:// address without user name, query or fragment');
  if (m[2] !== undefined && !(Number(m[2]) >= 1 && Number(m[2]) <= 65535)) fail('CAR_BACKEND_URL has a port out of range');
  if (/(^|\.)invalid$/i.test(m[1])) fail('CAR_BACKEND_URL is still the example address; put your own backend address in .env.car');
  return url;
}

function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..' && !/^[A-Za-z]:/.test(rel));
}

function deployDirFrom(raw) {
  if (raw === null) fail('CAR_DEPLOY_DIR is not set (environment or .env.car)');
  const dir = resolve(process.cwd(), raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail('CAR_DEPLOY_DIR is not an existing directory; create and clone your private deploy repository first');
  const real = realpathSync(dir);
  const repo = realpathSync(repoDir);
  if (inside(real, repo)) fail('CAR_DEPLOY_DIR is inside this source repository; it must be a separate checkout');
  if (inside(repo, real)) fail('CAR_DEPLOY_DIR contains this source repository; it must be a separate checkout');
  if (existsSync(join(real, 'car', 'src')) || existsSync(join(real, 'packages', 'vehicle-core'))) {
    fail('CAR_DEPLOY_DIR looks like a copy of the source repository (it has car/src or packages/); use a separate, private repository');
  }
  // only a git checkout, an empty directory or an earlier publish: never scatter files into an unrelated directory
  const known = existsSync(join(real, '.git')) || existsSync(join(real, 'mgu-repo.json')) || readdirSync(real).length === 0;
  if (!known) fail('CAR_DEPLOY_DIR is neither a git checkout, nor empty, nor an earlier publish; clone your private deploy repository there first');
  return real;
}

/** relative path -> SHA-256 of every file under the copied paths in dir. */
function fingerprint(dir) {
  const out = new Map();
  const walk = (abs) => {
    if (!existsSync(abs)) return;
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) if (!SKIPPED.has(name)) walk(join(abs, name));
    } else if (st.isFile()) {
      out.set(relative(dir, abs).split(sep).join('/'), createHash('sha256').update(readFileSync(abs)).digest('hex'));
    }
  };
  for (const p of COPIED) walk(join(dir, p));
  return out;
}

function copyTree(deployDir) {
  const filter = (src) => !SKIPPED.has(src.split(sep).pop()) && !src.endsWith('.pyc');
  mkdirSync(join(deployDir, 'car'), { recursive: true });
  for (const p of COPIED) {
    const from = join(repoDir, p);
    const to = join(deployDir, p);
    if (!existsSync(from)) fail('missing in the source repository: ' + p);
    rmSync(to, { recursive: true, force: true });   // only the copied paths: files deleted here go away there too
    cpSync(from, to, { recursive: true, filter });
  }
}

/** The deployed app.json: the backend address in "config", and any dropped reading's signal left out. */
function configure(deployDir, backendUrl, drops) {
  const path = join(deployDir, APP_JSON);
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  const config = spec.config && typeof spec.config === 'object' ? spec.config : {};
  config.backendUrl = backendUrl;
  if (drops.length > 0) {
    for (const name of drops) {
      const { iface, field } = DROPPABLE[name];
      const fields = spec.signals && spec.signals[iface];
      if (!fields || !Object.prototype.hasOwnProperty.call(fields, field)) fail(`app.json declares no ${iface}.${field}`);
      delete fields[field];
      if (Object.keys(fields).every((k) => k.startsWith('_'))) delete spec.signals[iface];
    }
    config.droppedReadings = drops.slice();
  } else {
    delete config.droppedReadings;
  }
  spec.config = config;
  writeFileSync(path, JSON.stringify(spec, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  const file = readEnvFile(join(repoDir, '.env.car'));
  const backendUrl = backendUrlFrom(setting('CAR_BACKEND_URL', file));
  const deployDir = deployDirFrom(setting('CAR_DEPLOY_DIR', file));
  if (!existsSync(join(repoDir, `car/apps/${APP_ID}/main.js`))) fail('car/apps/' + APP_ID + '/main.js is missing; run npm run build:car first');

  const before = fingerprint(deployDir);
  copyTree(deployDir);
  configure(deployDir, backendUrl, args.drops);
  const after = fingerprint(deployDir);

  const added = [...after.keys()].filter((p) => !before.has(p));
  const removed = [...before.keys()].filter((p) => !after.has(p));
  const changed = [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p));

  console.log('publish-car: the Store source is in ' + deployDir);
  console.log('  backend address: written into ' + APP_JSON + ' "config" there (not printed, not in this repository)');
  for (const name of args.drops) console.log(`  dropped reading: ${name} (${DROPPABLE[name].iface}.${DROPPABLE[name].field} left out of app.json)`);
  console.log(`  changes: ${added.length} added, ${changed.length} changed, ${removed.length} removed`);
  const show = (mark, list) => {
    for (const p of list.slice(0, 40)) console.log(`    ${mark} ${p}`);
    if (list.length > 40) console.log(`    ${mark} ... and ${list.length - 40} more`);
  };
  show('+', added);
  show('~', changed);
  show('-', removed);
  if (!existsSync(join(deployDir, '.git'))) console.log('  note: this directory is not a git checkout yet (no .git)');
  console.log('Nothing was committed or pushed. Review the changes there, then commit and push them yourself (docs/CAR_INSTALL.md).');
}

try {
  main();
} catch (error) {
  if (process.exitCode !== 1) {
    console.error('publish-car: ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  }
}
