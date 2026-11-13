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

/** Stored question/answer turns. Only successful turns are ever added (Task 12). */
export class DialogStore {
  private readonly insert: StatementSync;
  private readonly newest: StatementSync;

  constructor(db: DatabaseSync) {
    this.insert = db.prepare(
      `INSERT INTO dialog_turns (id, at, question, answer, style, source, model, snapshot_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.newest = db.prepare('SELECT * FROM dialog_turns ORDER BY at DESC, rowid DESC LIMIT ?');
  }

  add(turn: DialogTurn): void {
    this.insert.run(turn.id, turn.at, turn.question, turn.answer, turn.style, turn.source, turn.model, turn.snapshotAt);
  }

  /** Newest first. */
  recent(limit: number): DialogTurn[] {
    const n = rowLimit(limit);
    return n === 0 ? [] : this.newest.all(n).map(toTurn);
  }

  /** The last `n` turns, oldest first (conversation order for the prompt). */
  lastTurns(n: number): DialogTurn[] {
    return this.recent(n).reverse();
  }
}
