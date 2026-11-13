import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrations';

export type { DatabaseSync } from 'node:sqlite';

/** Opens (or creates) the history database and brings its schema up to date. `':memory:'` in tests; WAL for files. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    applyMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
