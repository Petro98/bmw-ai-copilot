import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrations';

export type { DatabaseSync } from 'node:sqlite';

/** How long a statement waits for a lock another connection holds (a backup, the sqlite3 shell) before it fails. */
export const DATABASE_BUSY_TIMEOUT_MS = 2000;

/**
 * Opens (or creates) the history database and brings its schema up to date. `':memory:'` in tests; WAL for files.
 * A file database holds the dialog, the vehicle history and device-secret hashes, so it is made readable by its owner
 * only (SQLite gives its -wal and -shm files the same permissions).
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
    if (path !== ':memory:') {
      chmodSync(path, 0o600);
      db.exec('PRAGMA journal_mode = WAL');
    }
    applyMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
