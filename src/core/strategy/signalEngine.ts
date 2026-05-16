// src/core/strategy/signalEngine.ts

import type {
  IndicatorSnapshot,
  Position,
  Signal,
  BuySignal,
  SellSignal,
} from '../../types/index.js';

export interface StrategyConfig {
  takeProfitPct: number;
  stopLossPct:   number;
}

export type SignalEvaluator = (
  snapshot: IndicatorSnapshot,
  openPosition: Position | null,
) => Signal | null;

// RSI ranges for entry — fixed by strategy, not user-configurable
const RSI_BUY_MIN  = 40;
const RSI_BUY_MAX  = 65;
const RSI_EXIT_OVERBOUGHT = 75;

export function createSignalEngine(config: StrategyConfig): SignalEvaluator {
  return function evaluate(
    snapshot: IndicatorSnapshot,
    openPosition: Position | null,
  ): Signal | null {
    if (openPosition !== null) {
      return evaluateExit(snapshot, openPosition, config);
    }
    return evaluateEntry(snapshot);
  };
}

// ---------------------------------------------------------------------------
// Exit logic
// ---------------------------------------------------------------------------

function evaluateExit(
  snapshot: IndicatorSnapshot,
  position: Position,
  config: StrategyConfig,
): SellSignal | null {
  const { price, symbol, timestamp, rsi, emaFast, macd, prevMacd } = snapshot;

  // 1. Take profit / stop loss (price-based, always evaluated first)
  const takeProfitPrice = position.entryPrice * (1 + config.takeProfitPct);
  const stopLossPrice   = position.entryPrice * (1 - config.stopLossPct);

  if (price >= takeProfitPrice) {
    return { type: 'SELL', symbol, price, timestamp, reason: 'TAKE_PROFIT', rsi };
  }

  if (price <= stopLossPrice) {
    return { type: 'SELL', symbol, price, timestamp, reason: 'STOP_LOSS', rsi };
  }

  // 2. RSI overbought reversal
  if (rsi !== null && rsi > RSI_EXIT_OVERBOUGHT) {
    return { type: 'SELL', symbol, price, timestamp, reason: 'RSI_OVERBOUGHT', rsi };
  }

  // 3. MACD histogram flipped from positive to negative (momentum reversal)
  if (
    macd !== null && prevMacd !== null &&
    prevMacd.histogram >= 0 && macd.histogram < 0
  ) {
    return { type: 'SELL', symbol, price, timestamp, reason: 'MACD_REVERSAL', rsi };
  }

  return null; // hold
}

// ---------------------------------------------------------------------------
// Entry logic — confluence of 4 conditions
// ---------------------------------------------------------------------------

function evaluateEntry(snapshot: IndicatorSnapshot): BuySignal | null {
  const {
    price, symbol, timestamp, rsi,
    emaFast, emaSlow, prevEmaFast, prevEmaSlow,
    ema200, prevEma200,
    macd, prevMacd,
  } = snapshot;

  // All indicators must be available
  if (
    rsi === null ||
    emaFast === null || emaSlow === null ||
    prevEmaFast === null || prevEmaSlow === null ||
    ema200 === null || prevEma200 === null ||
    macd === null || prevMacd === null
  ) {
    return null;
  }

  // Condition 1: price above EMA 200, slope flat or rising
  const aboveTrend   = price > ema200;
  const ema200Rising = ema200 >= prevEma200;

  if (!aboveTrend || !ema200Rising) return null;

  // Condition 2: bullish EMA alignment — EMA20 > EMA50 > EMA200
  const bullishAlignment = emaFast > emaSlow && emaSlow > ema200;

  if (!bullishAlignment) return null;

  // Condition 3: MACD momentum confirmation (cross up OR histogram flip to positive)
  const macdCrossUp     = prevMacd.macdLine <= prevMacd.signalLine && macd.macdLine > macd.signalLine;
  const histogramFlipUp = prevMacd.histogram < 0 && macd.histogram >= 0;

  if (!macdCrossUp && !histogramFlipUp) return null;

  // Condition 4: RSI in valid entry range (40–65)
  const rsiInRange = rsi >= RSI_BUY_MIN && rsi <= RSI_BUY_MAX;

  if (!rsiInRange) return null;

  return { type: 'BUY', symbol, price, timestamp, rsi };
}
