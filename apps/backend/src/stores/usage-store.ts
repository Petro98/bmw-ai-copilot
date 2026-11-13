import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Usage, UsageStore } from '@copilot/ai-core';

/** 'YYYY-MM-01' of the month before the month of `day` ('YYYY-MM-DD'), or null for a malformed day. */
function previousMonthStart(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);   // 1-12
  const [y, m] = month === 1 ? [year - 1, 12] : [year, month - 1];
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

/**
 * Claude spend per request, keyed by UTC day ('YYYY-MM-DD'); read by the cost guard (Task 9). The guard reads the
 * current day and month only, so each add deletes the rows from before the previous month.
 */
export class SqliteUsageStore implements UsageStore {
  private readonly insert: StatementSync;
  private readonly prune: StatementSync;
  private readonly dayTotal: StatementSync;
  private readonly monthTotal: StatementSync;

  constructor(db: DatabaseSync) {
    this.insert = db.prepare(
      `INSERT INTO usage (day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.dayTotal = db.prepare('SELECT TOTAL(usd) AS usd FROM usage WHERE day = ?');
    this.monthTotal = db.prepare('SELECT TOTAL(usd) AS usd FROM usage WHERE substr(day, 1, 7) = ?');
    this.prune = db.prepare('DELETE FROM usage WHERE day < ?');
  }

  add(day: string, model: string, usage: Usage, usd: number): void {
    this.insert.run(day, model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usd);
    const keepFrom = previousMonthStart(day);
    if (keepFrom !== null) this.prune.run(keepFrom);
  }

  usdForDay(day: string): number {
    return Number(this.dayTotal.get(day)?.usd ?? 0);
  }

  /** `month` is 'YYYY-MM' (UTC). */
  usdForMonth(month: string): number {
    return Number(this.monthTotal.get(month)?.usd ?? 0);
  }
}
