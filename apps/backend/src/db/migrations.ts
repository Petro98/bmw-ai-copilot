import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema migrations, applied in order. Migration `i` brings the schema to `PRAGMA user_version = i + 1`.
 * Append new migrations; never edit one that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE dialog_turns (
    id          TEXT PRIMARY KEY,
    at          INTEGER NOT NULL,
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL,
    style       TEXT NOT NULL,
    source      TEXT NOT NULL,
    model       TEXT NOT NULL,
    snapshot_at INTEGER
  );
  CREATE INDEX dialog_turns_at ON dialog_turns (at);

  CREATE TABLE alert_events (
    id         TEXT PRIMARY KEY,
    rule_id    TEXT NOT NULL,
    dedup_key  TEXT NOT NULL,
    provenance TEXT NOT NULL,
    severity   TEXT NOT NULL,
    title      TEXT NOT NULL,
    detail     TEXT,
    at         INTEGER NOT NULL,
    active     INTEGER NOT NULL,
    cleared_at INTEGER
  );
  CREATE INDEX alert_events_at ON alert_events (at);
  CREATE INDEX alert_events_active ON alert_events (active);

  CREATE TABLE telemetry_samples (
    id                 INTEGER PRIMARY KEY,
    at                 INTEGER NOT NULL,
    oil_temp           REAL,
    coolant_temp       REAL,
    battery12v_charge  REAL,
    fuel_level         REAL,
    range              REAL,
    odometer           REAL,
    speed              REAL,
    engine_rpm         REAL
  );
  CREATE INDEX telemetry_samples_at ON telemetry_samples (at);

  CREATE TABLE telemetry_daily (
    day   TEXT NOT NULL,
    key   TEXT NOT NULL,
    min   REAL NOT NULL,
    max   REAL NOT NULL,
    avg   REAL NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (day, key)
  );

  CREATE TABLE settings (
    id                          INTEGER PRIMARY KEY CHECK (id = 1),
    oil_temp_max_c              REAL,
    coolant_temp_max_c          REAL,
    battery12v_min_percent      REAL,
    tyre_pressure_deviation_bar REAL,
    popups_enabled              INTEGER NOT NULL,
    diagnostics_enabled         INTEGER NOT NULL
  );

  CREATE TABLE usage (
    id                 INTEGER PRIMARY KEY,
    day                TEXT NOT NULL,
    model              TEXT NOT NULL,
    input_tokens       INTEGER NOT NULL,
    output_tokens      INTEGER NOT NULL,
    cache_read_tokens  INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    usd                REAL NOT NULL
  );
  CREATE INDEX usage_day ON usage (day);
  `,
  // 2: the event engine's dwell/cooldown memory (EngineState as JSON), one row, so a restart keeps alert ids.
  `
  CREATE TABLE engine_state (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL
  );
  `,
  // 3: paired head units (Plan 2 Task 7). Only a SHA-256 of each device secret is kept, never the secret.
  `
  CREATE TABLE devices (
    device_id    TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    secret_hash  TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  `,
  // 4: which vehicle source (mock or car) the vehicle data in this file belongs to, and since when (db/vehicle-source.ts).
  // Before this migration the mock was the default source, so a database that already holds alerts or telemetry is
  // recorded as mock since 0: a first start with VEHICLE_SOURCE=car then resets its demo data.
  `
  CREATE TABLE vehicle_source (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    source TEXT NOT NULL,
    since  INTEGER NOT NULL
  );
  INSERT INTO vehicle_source (id, source, since)
    SELECT 1, 'mock', 0
    WHERE EXISTS (SELECT 1 FROM alert_events) OR EXISTS (SELECT 1 FROM telemetry_samples)
       OR EXISTS (SELECT 1 FROM telemetry_daily);
  `,
];

/** Applies every migration the database has not seen yet. Safe to call any number of times. */
export function applyMigrations(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get();
  const current = Number(row?.user_version ?? 0);
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
