// src/core/strategy/signalEngine.ts

import type {
  IndicatorSnapshot,
  Position,
  Signal,
  BuySignal,
  SellSignal,
} from '../../types/index.js';

// ---------------------------------------------------------------------------
// Strategy configuration
//
// Note: stop-loss / take-profit LEVELS are no longer computed here. They are
// derived from volatility (ATR) and stored on the Position when it is opened
// (see PositionManager), so the engine only has to compare the live price to
// the levels the position already carries. This keeps the engine a pure,
// stateless price→signal function and puts all risk math in one place.
// ---------------------------------------------------------------------------

export interface StrategyConfig {
  /** Lower bound of the RSI entry window (inclusive). */
  rsiBuyMin: number;
  /** Upper bound of the RSI entry window (inclusive). */
  rsiBuyMax: number;
  /**
   * Volume confirmation: require candle volume >= volMaMult * avgVolume.
   * 0 disables the filter.
   */
  volMaMult: number;
  /**
   * Volatility floor: require ATR/price >= minAtrPct (skip dead markets).
   * 0 disables the filter.
   */
  minAtrPct: number;
}

export type SignalEvaluator = (
  snapshot: IndicatorSnapshot,
  openPosition: Position | null,
) => Signal | null;

export function createSignalEngine(config: StrategyConfig): SignalEvaluator {
  return function evaluate(
    snapshot: IndicatorSnapshot,
    openPosition: Position | null,
  ): Signal | null {
    if (openPosition !== null) {
      return evaluateExit(snapshot, openPosition);
    }
    return evaluateEntry(snapshot, config);
  };
}

// ---------------------------------------------------------------------------
// Exit logic — compares live price to the volatility-adaptive levels that the
// PositionManager placed (and, for the stop, keeps trailing) on the position.
// ---------------------------------------------------------------------------

function evaluateExit(
  snapshot: IndicatorSnapshot,
  position: Position,
): SellSignal | null {
  const { price, symbol, timestamp, rsi } = snapshot;

  // Take profit — hard target backstop.
  if (price >= position.takeProfitPrice) {
    return { type: 'SELL', symbol, price, timestamp, reason: 'TAKE_PROFIT', rsi };
  }

  // Stop — a single comparison covers both the initial protective stop and the
  // trailing stop, since the trailing logic only ever raises stopPrice. We label
  // it TRAILING_STOP once the stop has been ratcheted to or above breakeven
  // (i.e. the exit locks in profit / scratch), and STOP_LOSS otherwise.
  if (price <= position.stopPrice) {
    const reason = position.stopPrice >= position.entryPrice ? 'TRAILING_STOP' : 'STOP_LOSS';
    return { type: 'SELL', symbol, price, timestamp, reason, rsi };
  }

  return null; // hold
}

// ---------------------------------------------------------------------------
// Entry logic — confluence of trend, momentum, location, and participation.
// ---------------------------------------------------------------------------

function evaluateEntry(snapshot: IndicatorSnapshot, config: StrategyConfig): BuySignal | null {
  const {
    price, symbol, timestamp, rsi,
    emaFast, emaSlow,
    ema200, prevEma200,
    macd, prevMacd,
    atr, volume, avgVolume,
  } = snapshot;

  // All indicators must be available.
  if (
    rsi === null ||
    emaFast === null || emaSlow === null ||
    ema200 === null || prevEma200 === null ||
    macd === null || prevMacd === null ||
    atr === null
  ) {
    return null;
  }

  // Condition 1: trend — price above EMA200 and EMA200 flat-to-rising.
  const aboveTrend   = price > ema200;
  const ema200Rising = ema200 >= prevEma200;
  if (!aboveTrend || !ema200Rising) return null;

  // Condition 2: bullish EMA alignment — fast > slow > EMA200.
  const bullishAlignment = emaFast > emaSlow && emaSlow > ema200;
  if (!bullishAlignment) return null;

  // Condition 3: MACD momentum confirmation (cross up OR histogram flip positive).
  const macdCrossUp     = prevMacd.macdLine <= prevMacd.signalLine && macd.macdLine > macd.signalLine;
  const histogramFlipUp = prevMacd.histogram < 0 && macd.histogram >= 0;
  if (!macdCrossUp && !histogramFlipUp) return null;

  // Condition 4: RSI inside the entry window (not exhausted, not weak).
  const rsiInRange = rsi >= config.rsiBuyMin && rsi <= config.rsiBuyMax;
  if (!rsiInRange) return null;

  // Condition 5: volatility floor — skip dead, untradeable markets.
  if (config.minAtrPct > 0 && atr / price < config.minAtrPct) return null;

  // Condition 6: volume confirmation — real breakouts carry participation.
  if (
    config.volMaMult > 0 &&
    volume !== null &&
    avgVolume !== null &&
    volume < config.volMaMult * avgVolume
  ) {
    return null;
  }

  return { type: 'BUY', symbol, price, timestamp, rsi, atr };
}
