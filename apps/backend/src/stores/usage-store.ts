import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Usage, UsageStore } from '@copilot/ai-core';

/** Claude spend per request, keyed by UTC day ('YYYY-MM-DD'); read by the cost guard (Task 9). */
export class SqliteUsageStore implements UsageStore {
  private readonly insert: StatementSync;
  private readonly dayTotal: StatementSync;
  private readonly monthTotal: StatementSync;

  constructor(db: DatabaseSync) {
    this.insert = db.prepare(
      `INSERT INTO usage (day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.dayTotal = db.prepare('SELECT TOTAL(usd) AS usd FROM usage WHERE day = ?');
    this.monthTotal = db.prepare('SELECT TOTAL(usd) AS usd FROM usage WHERE substr(day, 1, 7) = ?');
  }

  add(day: string, model: string, usage: Usage, usd: number): void {
    this.insert.run(day, model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usd);
  }

  usdForDay(day: string): number {
    return Number(this.dayTotal.get(day)?.usd ?? 0);
  }

  /** `month` is 'YYYY-MM' (UTC). */
  usdForMonth(month: string): number {
    return Number(this.monthTotal.get(month)?.usd ?? 0);
  }
}
