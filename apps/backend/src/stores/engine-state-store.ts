import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { EngineState } from '@copilot/event-engine';

type Row = Record<string, unknown>;

/** What decides whether a state is worth writing: the set of keys and their active flags. */
function signature(state: EngineState): string {
  return state.keys
    .map((key) => `${key.ruleId}\u0000${key.dedupKey}\u0000${key.active ? 1 : 0}`)
    .sort()
    .join('\u0001');
}

function isEngineState(value: unknown): value is EngineState {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Array.isArray((value as { keys?: unknown }).keys);
}

/**
 * The event engine's memory across restarts (EngineState as JSON, one row). Without it a standing warning
 * would be cleared and raised again under a new id at every restart. `save` writes only when the set of keys
 * or their active flags changed, not on every provider change. The engine's `restore` skips malformed entries;
 * a row that is not readable at all loads as null.
 */
export class EngineStateStore {
  private readonly select: StatementSync;
  private readonly upsert: StatementSync;
  private lastSignature: string | null = null;

  constructor(db: DatabaseSync) {
    this.select = db.prepare('SELECT state FROM engine_state WHERE id = 1');
    this.upsert = db.prepare(
      'INSERT INTO engine_state (id, state) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state',
    );
  }

  load(): EngineState | null {
    const row = this.select.get() as Row | undefined;
    if (!row || typeof row.state !== 'string') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.state);
    } catch {
      return null;
    }
    if (!isEngineState(parsed)) return null;
    this.lastSignature = signature(parsed);
    return parsed;
  }

  save(state: EngineState): void {
    const next = signature(state);
    if (next === this.lastSignature) return;
    this.upsert.run(JSON.stringify(state));
    this.lastSignature = next;
  }
}
