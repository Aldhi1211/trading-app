// src/services/database/repository.ts

import BetterSqlite3 from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { runMigrations } from './schema.js';
import type { Trade, Position, PortfolioState } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Repository interface — the position manager depends on this, not on the
// concrete class. Tests can pass any object that satisfies this shape.
// ---------------------------------------------------------------------------
export interface ITradeRepository {
  insertTrade(trade: Trade): void;
  saveOpenPosition(position: Position): void;
  deleteOpenPosition(): void;
  getOpenPosition(): Position | null;
  getTotalPnl(symbol: string): { totalPnlUsdt: number; totalTrades: number; winningTrades: number };
  savePortfolioSnapshot(state: PortfolioState): void;
}

interface TradeRow {
  id: string;
  symbol: string;
  entry_price: number;
  exit_price: number;
  quantity: number;
  entry_time: number;
  exit_time: number;
  entry_rsi: number;
  pnl_percent: number;
  pnl_usdt: number;
  reason: string;
}

interface PositionRow {
  id: string;
  symbol: string;
  entry_price: number;
  quantity: number;
  entry_time: number;
  entry_rsi: number;
}

export class TradeRepository {
  private db: BetterSqlite3.Database;

  constructor() {
    const dbDir = path.dirname(env.DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new BetterSqlite3(env.DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    runMigrations(this.db);
    logger.info({ dbPath: env.DB_PATH }, 'Database initialized');
  }

  insertTrade(trade: Trade): void {
    const stmt = this.db.prepare(`
      INSERT INTO trades (
        id, symbol, entry_price, exit_price, quantity,
        entry_time, exit_time, entry_rsi, pnl_percent, pnl_usdt, reason
      ) VALUES (
        @id, @symbol, @entry_price, @exit_price, @quantity,
        @entry_time, @exit_time, @entry_rsi, @pnl_percent, @pnl_usdt, @reason
      )
    `);

    stmt.run({
      id: trade.id,
      symbol: trade.symbol,
      entry_price: trade.entryPrice,
      exit_price: trade.exitPrice,
      quantity: trade.quantity,
      entry_time: trade.entryTime,
      exit_time: trade.exitTime,
      entry_rsi: trade.entryRsi,
      pnl_percent: trade.pnlPercent,
      pnl_usdt: trade.pnlUsdt,
      reason: trade.reason,
    });
  }

  saveOpenPosition(position: Position): void {
    // Delete-then-insert: only one open position can exist at a time.
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM open_positions').run();
      this.db
        .prepare(
          `INSERT INTO open_positions (id, symbol, entry_price, quantity, entry_time, entry_rsi)
           VALUES (@id, @symbol, @entry_price, @quantity, @entry_time, @entry_rsi)`
        )
        .run({
          id: position.id,
          symbol: position.symbol,
          entry_price: position.entryPrice,
          quantity: position.quantity,
          entry_time: position.entryTime,
          entry_rsi: position.entryRsi,
        });
    })();
  }

  deleteOpenPosition(): void {
    this.db.prepare('DELETE FROM open_positions').run();
  }

  getOpenPosition(): Position | null {
    const row = this.db
      .prepare('SELECT * FROM open_positions LIMIT 1')
      .get() as PositionRow | undefined;

    if (!row) return null;

    return {
      id: row.id,
      symbol: row.symbol,
      entryPrice: row.entry_price,
      quantity: row.quantity,
      entryTime: row.entry_time,
      entryRsi: row.entry_rsi,
    };
  }

  getRecentTrades(symbol: string, limit = 10): Trade[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM trades WHERE symbol = ? ORDER BY exit_time DESC LIMIT ?`
      )
      .all(symbol, limit) as TradeRow[];

    return rows.map(this.rowToTrade);
  }

  getTotalPnl(symbol: string): { totalPnlUsdt: number; totalTrades: number; winningTrades: number } {
    const row = this.db
      .prepare(
        `SELECT
          SUM(pnl_usdt) as total_pnl_usdt,
          COUNT(*) as total_trades,
          SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END) as winning_trades
        FROM trades WHERE symbol = ?`
      )
      .get(symbol) as { total_pnl_usdt: number | null; total_trades: number; winning_trades: number };

    return {
      totalPnlUsdt: row.total_pnl_usdt ?? 0,
      totalTrades: row.total_trades,
      winningTrades: row.winning_trades,
    };
  }

  savePortfolioSnapshot(state: PortfolioState): void {
    this.db
      .prepare(
        `INSERT INTO portfolio_snapshots
          (snapshot_time, balance, total_pnl_usdt, total_pnl_pct, total_trades, winning_trades)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        Date.now(),
        state.balance,
        state.totalPnlUsdt,
        state.totalPnlPercent,
        state.totalTrades,
        state.winningTrades
      );
  }

  close(): void {
    this.db.close();
  }

  private rowToTrade(row: TradeRow): Trade {
    return {
      id: row.id,
      symbol: row.symbol,
      entryPrice: row.entry_price,
      exitPrice: row.exit_price,
      quantity: row.quantity,
      entryTime: row.entry_time,
      exitTime: row.exit_time,
      entryRsi: row.entry_rsi,
      pnlPercent: row.pnl_percent,
      pnlUsdt: row.pnl_usdt,
      reason: row.reason as Trade['reason'],
    };
  }
}
