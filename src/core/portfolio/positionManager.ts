// src/core/portfolio/positionManager.ts

import { randomUUID } from 'crypto';
import type { BuySignal, SellSignal, Position, Trade, PortfolioState, ILogger } from '../../types/index.js';
import type { ITradeRepository } from '../../services/database/repository.js';

// ---------------------------------------------------------------------------
// Sizing config — discriminated union
//
// 'percent': spend `fraction` of the current available balance.
//            Naturally compounds as balance grows or shrinks.
// 'fixed':   always spend exactly `amountUsdt`, capped at current balance.
//            Useful for fixed-risk-per-trade discipline.
// ---------------------------------------------------------------------------

export type SizingMode =
  | { mode: 'percent'; fraction: number }   // e.g. { mode: 'percent', fraction: 0.95 }
  | { mode: 'fixed';   amountUsdt: number }; // e.g. { mode: 'fixed', amountUsdt: 950 }

export interface PositionManagerConfig {
  initialBalance: number;
  sizing: SizingMode;
}

// ---------------------------------------------------------------------------
// Dependencies — injected at construction, not imported globally.
// ---------------------------------------------------------------------------

export interface PositionManagerDeps {
  repo:       ITradeRepository;
  logger:     ILogger;
  /** Injectable for tests that need deterministic IDs. Defaults to randomUUID. */
  generateId?: () => string;
}

// ---------------------------------------------------------------------------
// Initial state — loaded by the CALLER before constructing the manager.
//
// Separating DB reads from construction makes the manager independently
// testable: pass in any InitialPortfolioStats and the manager works.
// ---------------------------------------------------------------------------

export interface InitialPortfolioStats {
  /** Available USDT (after restoring any locked position funds). */
  balance: number;
  openPosition:  Position | null;
  totalTrades:   number;
  winningTrades: number;
  totalPnlUsdt:  number;
}

/**
 * Helper: reconstructs the available USDT balance from persisted data.
 * Call this before constructing PositionManager when recovering from a restart.
 *
 * Pure function — testable independently of the manager class.
 */
export function computeRestoredBalance(
  initialBalance: number,
  totalPnlUsdt: number,
  openPosition: Position | null,
): number {
  // All closed trade PnL is reflected in the balance.
  const balanceAfterClosedTrades = initialBalance + totalPnlUsdt;

  if (openPosition === null) return balanceAfterClosedTrades;

  // If a position was open when the process crashed, those funds are still
  // "locked". Subtract them to get the truly available balance.
  const lockedUsdt = openPosition.entryPrice * openPosition.quantity;
  return balanceAfterClosedTrades - lockedUsdt;
}

// ---------------------------------------------------------------------------
// PositionManager
// ---------------------------------------------------------------------------

export class PositionManager {
  private state: PortfolioState;
  private readonly generateId: () => string;

  constructor(
    private readonly config: PositionManagerConfig,
    private readonly deps: PositionManagerDeps,
    initial: InitialPortfolioStats,
  ) {
    this.generateId = deps.generateId ?? randomUUID;

    const totalPnlPercent =
      config.initialBalance > 0
        ? ((initial.balance - config.initialBalance) / config.initialBalance) * 100
        : 0;

    this.state = {
      balance:        initial.balance,
      totalDeposited: config.initialBalance,
      openPosition:   initial.openPosition,
      totalTrades:    initial.totalTrades,
      winningTrades:  initial.winningTrades,
      totalPnlUsdt:   initial.totalPnlUsdt,
      totalPnlPercent,
    };

    if (initial.openPosition) {
      deps.logger.info(
        { symbol: initial.openPosition.symbol, entryPrice: initial.openPosition.entryPrice },
        'Recovered open position from previous session',
      );
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  getState(): Readonly<PortfolioState> {
    return this.state;
  }

  /**
   * Returns unrealized PnL in USDT for the current open position at
   * `currentPrice`, or null if no position is open.
   * Pure computation — no state mutation.
   */
  getUnrealizedPnl(currentPrice: number): number | null {
    const pos = this.state.openPosition;
    if (pos === null) return null;
    return pos.quantity * (currentPrice - pos.entryPrice);
  }

  /**
   * Returns the total equity (available balance + open position market value)
   * at `currentPrice`.
   */
  getTotalEquity(currentPrice: number): number {
    const pos = this.state.openPosition;
    const positionValue = pos !== null ? pos.quantity * currentPrice : 0;
    return this.state.balance + positionValue;
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Opens a simulated position on a BUY signal.
   * Returns the new Position, or null if opening is not possible
   * (already open, insufficient balance, zero allocation).
   */
  openPosition(signal: BuySignal): Position | null {
    if (this.state.openPosition !== null) {
      this.deps.logger.warn('openPosition called while a position is already open — skipping');
      return null;
    }

    const allocation = this.computeAllocation();

    if (allocation <= 0) {
      this.deps.logger.warn('Insufficient balance to open position');
      return null;
    }

    const quantity = allocation / signal.price;

    const position: Position = {
      id:         this.generateId(),
      symbol:     signal.symbol,
      entryPrice: signal.price,
      quantity,
      entryTime:  signal.timestamp,
      entryRsi:   signal.rsi,
    };

    this.state = {
      ...this.state,
      balance:      this.state.balance - allocation,
      openPosition: position,
    };

    this.deps.repo.saveOpenPosition(position);

    this.deps.logger.info(
      {
        symbol:      signal.symbol,
        entryPrice:  signal.price,
        allocation:  allocation.toFixed(2),
        quantity:    quantity.toFixed(8),
        balance:     this.state.balance.toFixed(2),
        sizingMode:  this.config.sizing.mode,
      },
      'FAKE BUY — position opened',
    );

    return position;
  }

  /**
   * Closes the current open position on a SELL signal.
   * Persists the completed Trade and snapshots portfolio state to the DB.
   * Returns the completed Trade, or null if no position is open.
   */
  closePosition(signal: SellSignal): Trade | null {
    const position = this.state.openPosition;
    if (position === null) {
      this.deps.logger.warn('closePosition called but no position is open — skipping');
      return null;
    }

    const exitValue  = position.quantity * signal.price;
    const entryValue = position.quantity * position.entryPrice;
    const pnlUsdt    = exitValue - entryValue;
    const pnlPercent = (pnlUsdt / entryValue) * 100;

    const trade: Trade = {
      id:         position.id,   // same UUID as the position it closes
      symbol:     position.symbol,
      entryPrice: position.entryPrice,
      exitPrice:  signal.price,
      quantity:   position.quantity,
      entryTime:  position.entryTime,
      exitTime:   signal.timestamp,
      entryRsi:   position.entryRsi,
      pnlPercent,
      pnlUsdt,
      reason:     signal.reason,
    };

    const newBalance        = this.state.balance + exitValue;
    const newTotalPnlUsdt   = this.state.totalPnlUsdt + pnlUsdt;
    const newTotalTrades    = this.state.totalTrades + 1;
    const newWinningTrades  = this.state.winningTrades + (pnlUsdt > 0 ? 1 : 0);
    const newTotalPnlPct    =
      ((newBalance - this.state.totalDeposited) / this.state.totalDeposited) * 100;

    this.state = {
      ...this.state,
      balance:        newBalance,
      openPosition:   null,
      totalTrades:    newTotalTrades,
      winningTrades:  newWinningTrades,
      totalPnlUsdt:   newTotalPnlUsdt,
      totalPnlPercent: newTotalPnlPct,
    };

    // Persist atomically: trade record, then clear open position, then snapshot.
    this.deps.repo.insertTrade(trade);
    this.deps.repo.deleteOpenPosition();
    this.deps.repo.savePortfolioSnapshot(this.state);

    const winRate =
      newTotalTrades > 0
        ? ((newWinningTrades / newTotalTrades) * 100).toFixed(1)
        : '0.0';

    this.deps.logger.info(
      {
        symbol:     trade.symbol,
        exitPrice:  signal.price,
        pnlUsdt:    pnlUsdt.toFixed(4),
        pnlPercent: pnlPercent.toFixed(2) + '%',
        reason:     signal.reason,
        balance:    newBalance.toFixed(2),
        winRate:    winRate + '%',
        trades:     newTotalTrades,
      },
      'FAKE SELL — position closed',
    );

    return trade;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Computes how many USDT to allocate for the next trade based on the
   * configured sizing mode.
   */
  private computeAllocation(): number {
    const balance = this.state.balance;
    const { sizing } = this.config;

    switch (sizing.mode) {
      case 'percent':
        return balance * sizing.fraction;

      case 'fixed':
        // Never exceed available balance — graceful degradation when balance
        // has been eroded by losses below the fixed amount.
        return Math.min(sizing.amountUsdt, balance);
    }
  }
}
