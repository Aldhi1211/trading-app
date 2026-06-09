// src/services/database/repository.ts

import BetterSqlite3 from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { runMigrations } from './schema.js';
import type { Trade, Position, PortfolioState, PositionSide } from '../../types/index.js';

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
  getTradesSince(sinceMs: number): { profitUsdt: number; lossUsdt: number; trades: number; wins: number };
  savePortfolioSnapshot(state: PortfolioState): void;
  close(): void;
}

interface TradeRow {
  id: string;
  symbol: string;
  side: string;
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
  side: string;
  entry_price: number;
  quantity: number;
  entry_time: number;
  entry_rsi: number;
  // Nullable: rows written before migration 003 won't have these.
  stop_price: number | null;
  take_profit_price: number | null;
  highest_price: number | null;   // stores the favorable extreme (see Position.extremePrice)
  atr_at_entry: number | null;
  initial_risk: number | null;
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
        id, symbol, side, entry_price, exit_price, quantity,
        entry_time, exit_time, entry_rsi, pnl_percent, pnl_usdt, reason
      ) VALUES (
        @id, @symbol, @side, @entry_price, @exit_price, @quantity,
        @entry_time, @exit_time, @entry_rsi, @pnl_percent, @pnl_usdt, @reason
      )
    `);

    stmt.run({
      id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
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
          `INSERT INTO open_positions (
             id, symbol, side, entry_price, quantity, entry_time, entry_rsi,
             stop_price, take_profit_price, highest_price, atr_at_entry, initial_risk
           ) VALUES (
             @id, @symbol, @side, @entry_price, @quantity, @entry_time, @entry_rsi,
             @stop_price, @take_profit_price, @highest_price, @atr_at_entry, @initial_risk
           )`
        )
        .run({
          id: position.id,
          symbol: position.symbol,
          side: position.side,
          entry_price: position.entryPrice,
          quantity: position.quantity,
          entry_time: position.entryTime,
          entry_rsi: position.entryRsi,
          stop_price: position.stopPrice,
          take_profit_price: position.takeProfitPrice,
          highest_price: position.extremePrice,
          atr_at_entry: position.atrAtEntry,
          initial_risk: position.initialRisk,
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

    // Back-fill risk fields for positions written before migration 003. We
    // derive conservative levels from the entry price using the configured
    // fallback percentages so a recovered legacy position still has a valid
    // stop/target and can be trailed. Legacy rows are always LONG (shorts
    // didn't exist before migration 004), so the back-fill is long-oriented.
    const side: PositionSide = row.side === 'SHORT' ? 'SHORT' : 'LONG';
    const dir = side === 'LONG' ? 1 : -1;
    const entryPrice   = row.entry_price;
    const initialRisk  = row.initial_risk  ?? entryPrice * env.STOP_LOSS_PCT;
    const stopPrice    = row.stop_price    ?? entryPrice - dir * initialRisk;
    const takeProfit   = row.take_profit_price ?? entryPrice + dir * entryPrice * env.TAKE_PROFIT_PCT;
    const extremePrice = row.highest_price ?? entryPrice;
    const atrAtEntry   = row.atr_at_entry  ?? initialRisk / env.ATR_SL_MULT;

    return {
      id: row.id,
      symbol: row.symbol,
      side,
      entryPrice,
      quantity: row.quantity,
      entryTime: row.entry_time,
      entryRsi: row.entry_rsi,
      stopPrice,
      takeProfitPrice: takeProfit,
      extremePrice,
      atrAtEntry,
      initialRisk,
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

  getTradesSince(sinceMs: number): { profitUsdt: number; lossUsdt: number; trades: number; wins: number } {
    const row = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN pnl_usdt > 0 THEN pnl_usdt ELSE 0 END) as profit_usdt,
          SUM(CASE WHEN pnl_usdt < 0 THEN pnl_usdt ELSE 0 END) as loss_usdt,
          COUNT(*) as trades,
          SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END) as wins
        FROM trades WHERE exit_time >= ?`
      )
      .get(sinceMs) as {
        profit_usdt: number | null;
        loss_usdt: number | null;
        trades: number;
        wins: number;
      };

    return {
      profitUsdt: row.profit_usdt ?? 0,
      lossUsdt:   row.loss_usdt   ?? 0,
      trades:     row.trades,
      wins:       row.wins,
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
      side: row.side === 'SHORT' ? 'SHORT' : 'LONG',
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
