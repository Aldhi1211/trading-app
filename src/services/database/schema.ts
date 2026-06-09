// src/services/database/schema.ts

import type Database from 'better-sqlite3';
import { logger } from '../../config/logger.js';

// ---------------------------------------------------------------------------
// Migration runner
//
// Each migration is identified by a unique name. The schema_migrations table
// records which migrations have already been applied, so every migration runs
// exactly once — even if runMigrations() is called on every startup.
//
// Order matters: migrations are applied in array order. Never edit an existing
// migration; always append a new one.
// ---------------------------------------------------------------------------

interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  // ── v1: core tables ───────────────────────────────────────────────────────
  {
    name: '001_initial_schema',
    sql: `
      -- Completed trades: immutable records of closed positions.
      -- TEXT PRIMARY KEY uses UUID generated in application layer so the id
      -- is known before the INSERT (no need to read lastInsertRowid).
      -- REAL for prices: 64-bit IEEE 754 gives 15-17 significant digits,
      -- sufficient for crypto prices at cent precision.
      -- INTEGER for timestamps: Unix ms, directly sortable in SQL.
      CREATE TABLE IF NOT EXISTS trades (
        id          TEXT    PRIMARY KEY,
        symbol      TEXT    NOT NULL,
        entry_price REAL    NOT NULL CHECK (entry_price > 0),
        exit_price  REAL    NOT NULL CHECK (exit_price > 0),
        quantity    REAL    NOT NULL CHECK (quantity > 0),
        entry_time  INTEGER NOT NULL,
        exit_time   INTEGER NOT NULL CHECK (exit_time >= entry_time),
        entry_rsi   REAL    NOT NULL,
        pnl_percent REAL    NOT NULL,
        pnl_usdt    REAL    NOT NULL,
        reason      TEXT    NOT NULL
          CHECK (reason IN ('TAKE_PROFIT', 'STOP_LOSS', 'RSI_OVERBOUGHT'))
      );

      -- Fast lookup of trades for a given symbol (most common read path).
      CREATE INDEX IF NOT EXISTS idx_trades_symbol
        ON trades (symbol);

      -- Recent-first pagination: matches ORDER BY exit_time DESC LIMIT N.
      CREATE INDEX IF NOT EXISTS idx_trades_exit_time
        ON trades (exit_time DESC);

      -- Periodic snapshots of portfolio state for equity-curve analysis.
      -- Uses AUTOINCREMENT integer PK because we never need to predict the
      -- id before insertion.
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_time  INTEGER NOT NULL,
        balance        REAL    NOT NULL,
        total_pnl_usdt REAL    NOT NULL,
        total_pnl_pct  REAL    NOT NULL,
        total_trades   INTEGER NOT NULL,
        winning_trades INTEGER NOT NULL
      );

      -- Open position persisted for crash recovery.
      -- At most one row should ever exist (enforced by the bot, not a DB
      -- constraint, since SQLite lacks a native "max one row" constraint).
      -- On startup the bot reads this table; if a row exists it resumes
      -- the position rather than treating it as closed.
      CREATE TABLE IF NOT EXISTS open_positions (
        id          TEXT    PRIMARY KEY,
        symbol      TEXT    NOT NULL,
        entry_price REAL    NOT NULL CHECK (entry_price > 0),
        quantity    REAL    NOT NULL CHECK (quantity > 0),
        entry_time  INTEGER NOT NULL,
        entry_rsi   REAL    NOT NULL
      );
    `,
  },
  // ── v2: relax reason CHECK to support new exit types ─────────────────────
  {
    name: '002_expand_sell_reasons',
    sql: `
      CREATE TABLE trades_new (
        id          TEXT    PRIMARY KEY,
        symbol      TEXT    NOT NULL,
        entry_price REAL    NOT NULL CHECK (entry_price > 0),
        exit_price  REAL    NOT NULL CHECK (exit_price > 0),
        quantity    REAL    NOT NULL CHECK (quantity > 0),
        entry_time  INTEGER NOT NULL,
        exit_time   INTEGER NOT NULL CHECK (exit_time >= entry_time),
        entry_rsi   REAL    NOT NULL,
        pnl_percent REAL    NOT NULL,
        pnl_usdt    REAL    NOT NULL,
        reason      TEXT    NOT NULL
      );
      INSERT INTO trades_new SELECT * FROM trades;
      DROP TABLE trades;
      ALTER TABLE trades_new RENAME TO trades;
      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades (symbol);
      CREATE INDEX IF NOT EXISTS idx_trades_exit_time ON trades (exit_time DESC);
    `,
  },
  // ── v3: risk-management fields on open_positions ──────────────────────────
  // ATR-based stop/target levels and trailing-stop state. Added as nullable
  // columns (no DEFAULT) so any position carried over from a pre-v3 session is
  // detected by NULL and back-filled in the repository from the entry price.
  {
    name: '003_position_risk_fields',
    sql: `
      ALTER TABLE open_positions ADD COLUMN stop_price        REAL;
      ALTER TABLE open_positions ADD COLUMN take_profit_price REAL;
      ALTER TABLE open_positions ADD COLUMN highest_price     REAL;
      ALTER TABLE open_positions ADD COLUMN atr_at_entry      REAL;
      ALTER TABLE open_positions ADD COLUMN initial_risk      REAL;
    `,
  },
  // ── v4: trade direction (LONG / SHORT) ────────────────────────────────────
  // Existing rows predate short-selling, so they default to LONG. The
  // highest_price column (added in v3) now stores the favorable extreme — the
  // highest price for a LONG, the lowest for a SHORT.
  {
    name: '004_position_side',
    sql: `
      ALTER TABLE open_positions ADD COLUMN side TEXT NOT NULL DEFAULT 'LONG';
      ALTER TABLE trades         ADD COLUMN side TEXT NOT NULL DEFAULT 'LONG';
    `,
  },
];

// ---------------------------------------------------------------------------
// Bootstrap: create the migrations tracking table, then run any pending ones.
// ---------------------------------------------------------------------------

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT    PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set<string>(
    (
      db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]
    ).map((r) => r.name)
  );

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)'
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;

    // Run each migration in its own transaction so a partial failure does not
    // corrupt the schema.
    db.transaction(() => {
      db.exec(migration.sql);
      insertMigration.run(migration.name, Date.now());
    })();

    logger.info({ migration: migration.name }, 'Applied DB migration');
  }
}
