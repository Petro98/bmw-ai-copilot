import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AskSource, AskStyle, DialogTurn } from '@copilot/shared';

type Row = Record<string, unknown>;

/** SQLite treats a negative LIMIT as "no limit": clamp to a non-negative integer, NaN → 0. */
function rowLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}

function toTurn(row: Row): DialogTurn {
  return {
    id: String(row.id),
    at: Number(row.at),
    question: String(row.question),
    answer: String(row.answer),
    style: row.style as AskStyle,
    source: row.source as AskSource,
    model: String(row.model),
    snapshotAt: row.snapshot_at === null ? null : Number(row.snapshot_at),
  };
}

/** Turns kept; the oldest beyond this are deleted as new ones arrive (the panel lists 50, the prompt takes a few). */
export const MAX_DIALOG_TURNS = 1000;
/** Before every stored turn: the default start of `lastTurns`. */
const ALL_TIME = Number.MIN_SAFE_INTEGER;

/** Stored question/answer turns. Only successful turns are ever added (Task 12). */
export class DialogStore {
  private readonly insert: StatementSync;
  private readonly newest: StatementSync;
  private readonly newestSince: StatementSync;
  private readonly prune: StatementSync;

  constructor(db: DatabaseSync) {
    this.insert = db.prepare(
      `INSERT INTO dialog_turns (id, at, question, answer, style, source, model, snapshot_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.newest = db.prepare('SELECT * FROM dialog_turns ORDER BY at DESC, rowid DESC LIMIT ?');
    this.newestSince = db.prepare('SELECT * FROM dialog_turns WHERE at >= ? ORDER BY at DESC, rowid DESC LIMIT ?');
    this.prune = db.prepare(
      `DELETE FROM dialog_turns WHERE rowid IN
         (SELECT rowid FROM dialog_turns ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ${MAX_DIALOG_TURNS})`,
    );
  }

  /** Stores a turn, then deletes the oldest beyond MAX_DIALOG_TURNS. */
  add(turn: DialogTurn): void {
    this.insert.run(turn.id, turn.at, turn.question, turn.answer, turn.style, turn.source, turn.model, turn.snapshotAt);
    this.prune.run();
  }

  /** Newest first. */
  recent(limit: number): DialogTurn[] {
    const n = rowLimit(limit);
    return n === 0 ? [] : this.newest.all(n).map(toTurn);
  }

  /**
   * The last `n` turns, oldest first (conversation order for the prompt). With `since`, only turns at or after it:
   * turns from before a change of vehicle source never reach the prompt (db/vehicle-source.ts).
   */
  lastTurns(n: number, since: number = ALL_TIME): DialogTurn[] {
    const limit = rowLimit(n);
    if (limit === 0) return [];
    const from = Number.isFinite(since) ? since : ALL_TIME;
    return this.newestSince.all(from, limit).map(toTurn).reverse();
  }
}
