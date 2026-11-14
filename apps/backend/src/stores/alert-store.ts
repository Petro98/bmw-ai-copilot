import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AlertEvent, Provenance } from '@copilot/event-engine';
import type { Severity } from '@copilot/vehicle-core';

type Row = Record<string, unknown>;

/** SQLite treats a negative LIMIT as "no limit": clamp to a non-negative integer, NaN → 0. */
function rowLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}

function toEvent(row: Row): AlertEvent {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id),
    dedupKey: String(row.dedup_key),
    provenance: row.provenance as Provenance,
    severity: row.severity as Severity,
    title: String(row.title),
    detail: row.detail === null ? null : String(row.detail),
    at: Number(row.at),
    active: Number(row.active) === 1,
    clearedAt: row.cleared_at === null ? null : Number(row.cleared_at),
  };
}

/**
 * Cleared events kept; the oldest beyond this are deleted as events are stored. Active events are never deleted here
 * (the panel lists the newest 50).
 */
export const MAX_CLEARED_ALERTS = 1000;

/** Alert events. The engine reports a raise and its later clear under the same id; the row holds the latest state. */
export class AlertStore {
  private readonly upsertStatement: StatementSync;
  private readonly newest: StatementSync;
  private readonly activeStatement: StatementSync;
  private readonly byId: StatementSync;
  private readonly clearActiveStatement: StatementSync;
  private readonly prune: StatementSync;

  constructor(db: DatabaseSync) {
    this.upsertStatement = db.prepare(
      `INSERT INTO alert_events (id, rule_id, dedup_key, provenance, severity, title, detail, at, active, cleared_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         rule_id = excluded.rule_id, dedup_key = excluded.dedup_key, provenance = excluded.provenance,
         severity = excluded.severity, title = excluded.title, detail = excluded.detail, at = excluded.at,
         active = excluded.active, cleared_at = excluded.cleared_at`,
    );
    this.newest = db.prepare('SELECT * FROM alert_events ORDER BY at DESC, rowid DESC LIMIT ?');
    this.activeStatement = db.prepare('SELECT * FROM alert_events WHERE active = 1 ORDER BY at DESC, rowid DESC');
    // `id` is the table's primary key (migration 1), so this is a key search: no further index is needed.
    this.byId = db.prepare('SELECT * FROM alert_events WHERE id = ?');
    this.clearActiveStatement = db.prepare('UPDATE alert_events SET active = 0, cleared_at = ? WHERE active = 1 RETURNING *');
    this.prune = db.prepare(
      `DELETE FROM alert_events WHERE rowid IN
         (SELECT rowid FROM alert_events WHERE active = 0 ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ${MAX_CLEARED_ALERTS})`,
    );
  }

  /** The event with this id, however old, or null. */
  get(id: string): AlertEvent | null {
    const row = this.byId.get(id);
    return row ? toEvent(row) : null;
  }

  upsert(event: AlertEvent): void {
    this.upsertStatement.run(
      event.id, event.ruleId, event.dedupKey, event.provenance, event.severity, event.title, event.detail,
      event.at, event.active ? 1 : 0, event.clearedAt,
    );
    this.prune.run();
  }

  /** Clears every active event at `now` and returns them as cleared, newest first. */
  clearActive(now: number): AlertEvent[] {
    return this.clearActiveStatement.all(now).map(toEvent).sort((a, b) => b.at - a.at);
  }

  /** Newest first. */
  recent(limit: number): AlertEvent[] {
    const n = rowLimit(limit);
    return n === 0 ? [] : this.newest.all(n).map(toEvent);
  }

  /** Events not cleared yet, newest first. */
  active(): AlertEvent[] {
    return this.activeStatement.all().map(toEvent);
  }
}
