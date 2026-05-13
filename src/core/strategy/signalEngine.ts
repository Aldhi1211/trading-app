// src/core/strategy/signalEngine.ts

import type {
  IndicatorSnapshot,
  Position,
  Signal,
  BuySignal,
  SellSignal,
} from '../../types/index.js';

// ---------------------------------------------------------------------------
// Configuration — all thresholds needed by the strategy.
// Passed in at factory time, never imported from env.
// This is what makes the evaluator a genuinely pure function: calling it with
// the same snapshot and position always yields the same signal, regardless of
// any global state.
// ---------------------------------------------------------------------------

export interface StrategyConfig {
  /** Price must reach entryPrice * (1 + takeProfitPct) to trigger TAKE_PROFIT. */
  takeProfitPct: number;
  /** Price must fall to entryPrice * (1 - stopLossPct) to trigger STOP_LOSS. */
  stopLossPct: number;
  /** RSI below this value is required for a BUY entry. */
  rsiOversold: number;
  /** RSI above this value triggers a SELL exit (RSI_OVERBOUGHT reason). */
  rsiOverbought: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The type of the evaluator returned by createSignalEngine.
 * Exported so callers can annotate DI parameters without importing the factory.
 */
export type SignalEvaluator = (
  snapshot: IndicatorSnapshot,
  openPosition: Position | null,
) => Signal | null;

/**
 * Factory: closes config over the evaluator and returns a plain function.
 *
 * Why factory-over-class:
 *   - The returned function carries no `this` — it can be stored, passed, and
 *     called without binding concerns.
 *   - Testing is `createSignalEngine(testConfig)(snapshot, position)` — no
 *     mock setup, no module imports to patch.
 *   - Multiple strategies can coexist with different configs in the same
 *     process without any global state conflict.
 */
export function createSignalEngine(config: StrategyConfig): SignalEvaluator {
  return function evaluate(
    snapshot: IndicatorSnapshot,
    openPosition: Position | null,
  ): Signal | null {
    // Exit is evaluated before entry. This means: if an EMA crossover BUY
    // signal fires on the same candle where the price hits a stop/target,
    // we exit first. Re-entry on the next candle is handled by the caller.
    if (openPosition !== null) {
      return evaluateExit(snapshot, openPosition, config);
    }

    return evaluateEntry(snapshot, config);
  };
}

// ---------------------------------------------------------------------------
// Exit logic — private to this module
//
// Receives only the fields it reads, not the full snapshot, so a unit test
// can construct a minimal object without satisfying the full IndicatorSnapshot
// interface.
// ---------------------------------------------------------------------------

interface ExitInputs {
  price: number;
  symbol: string;
  timestamp: number;
  rsi: number | null;
}

function evaluateExit(
  { price, symbol, timestamp, rsi }: ExitInputs,
  position: Position,
  config: StrategyConfig,
): SellSignal | null {
  const takeProfitPrice = position.entryPrice * (1 + config.takeProfitPct);
  const stopLossPrice   = position.entryPrice * (1 - config.stopLossPct);

  if (price >= takeProfitPrice) {
    return { type: 'SELL', symbol, price, timestamp, reason: 'TAKE_PROFIT', rsi };
  }

  if (price <= stopLossPrice) {
    return { type: 'SELL', symbol, price, timestamp, reason: 'STOP_LOSS', rsi };
  }

  // RSI overbought exit: only fires when RSI is available and exceeds threshold.
  // If RSI is still null (buffer warming up), we stay in the position and rely
  // on price-based exits only.
  if (rsi !== null && rsi > config.rsiOverbought) {
    return { type: 'SELL', symbol, price, timestamp, reason: 'RSI_OVERBOUGHT', rsi };
  }

  return null; // hold
}

// ---------------------------------------------------------------------------
// Entry logic — private to this module
// ---------------------------------------------------------------------------

interface EntryInputs {
  rsi: number | null;
  prevRsi: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  prevEmaFast: number | null;
  prevEmaSlow: number | null;
  price: number;
  symbol: string;
  timestamp: number;
}

function evaluateEntry(
  { rsi, emaFast, emaSlow, prevEmaFast, prevEmaSlow, price, symbol, timestamp }: EntryInputs,
  config: StrategyConfig,
): BuySignal | null {
  // All indicators must be computed before we can evaluate entry conditions.
  // Returning null here means "not enough data yet" — the caller should not
  // interpret this as "no signal"; the next closed candle will be evaluated too.
  if (
    rsi       === null ||
    emaFast   === null || emaSlow   === null ||
    prevEmaFast === null || prevEmaSlow === null
  ) {
    return null;
  }

  // Condition 1: RSI in oversold zone
  const rsiIsOversold = rsi < config.rsiOversold;

  // Condition 2: EMA golden cross — fast was BELOW slow last candle,
  // crossed to AT-OR-ABOVE slow on this candle.
  //
  // Using >= (not >) on the current side: a candle where fast === slow
  // counts as a cross because it represents the transition point.
  const emaCrossedUp = prevEmaFast < prevEmaSlow && emaFast >= emaSlow;

  if (rsiIsOversold && emaCrossedUp) {
    // rsi is narrowed to number here — TypeScript knows it's non-null
    // because we checked above, so BuySignal.rsi: number is satisfied.
    return { type: 'BUY', symbol, price, timestamp, rsi };
  }

  return null;
}
