// src/core/strategy/signalEngine.ts

import type {
  IndicatorSnapshot,
  Position,
  Signal,
  EntrySignal,
  ExitSignal,
} from '../../types/index.js';

// ---------------------------------------------------------------------------
// Strategy configuration
//
// Note: stop-loss / take-profit LEVELS are not computed here. They are derived
// from volatility (ATR) and stored on the Position when it is opened (see
// PositionManager), so the engine only compares the live price to the levels
// the position already carries. This keeps the engine a pure, stateless
// price→signal function and puts all risk math in one place.
// ---------------------------------------------------------------------------

export interface StrategyConfig {
  /** Lower bound of the long RSI entry window (inclusive). */
  rsiBuyMin: number;
  /** Upper bound of the long RSI entry window (inclusive). */
  rsiBuyMax: number;
  /** Volume confirmation: require volume >= volMaMult * avgVolume. 0 disables. */
  volMaMult: number;
  /** Volatility floor: require ATR/price >= minAtrPct. 0 disables. */
  minAtrPct: number;
  /** Allow LONG entries (buy uptrends). */
  allowLong: boolean;
  /** Allow SHORT entries (sell-to-open downtrends). */
  allowShort: boolean;
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
// PositionManager placed (and keeps trailing) on the position. The geometry is
// mirrored by side: a LONG target is above entry and its stop below; a SHORT
// target is below entry and its stop above.
// ---------------------------------------------------------------------------

function evaluateExit(
  snapshot: IndicatorSnapshot,
  position: Position,
): ExitSignal | null {
  const { price, symbol, timestamp, rsi } = snapshot;

  if (position.side === 'LONG') {
    if (price >= position.takeProfitPrice) {
      return { type: 'EXIT', symbol, price, timestamp, reason: 'TAKE_PROFIT', rsi };
    }
    if (price <= position.stopPrice) {
      // Stop at-or-above entry means the trail locked in profit/scratch.
      const reason = position.stopPrice >= position.entryPrice ? 'TRAILING_STOP' : 'STOP_LOSS';
      return { type: 'EXIT', symbol, price, timestamp, reason, rsi };
    }
    return null;
  }

  // SHORT
  if (price <= position.takeProfitPrice) {
    return { type: 'EXIT', symbol, price, timestamp, reason: 'TAKE_PROFIT', rsi };
  }
  if (price >= position.stopPrice) {
    // Stop at-or-below entry means the trail locked in profit/scratch.
    const reason = position.stopPrice <= position.entryPrice ? 'TRAILING_STOP' : 'STOP_LOSS';
    return { type: 'EXIT', symbol, price, timestamp, reason, rsi };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry logic — confluence of trend, momentum, location, and participation.
// Long and short are exact mirrors of one another.
// ---------------------------------------------------------------------------

function evaluateEntry(snapshot: IndicatorSnapshot, config: StrategyConfig): EntrySignal | null {
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

  // Shared filters (side-independent).
  // Volatility floor — skip dead, untradeable markets.
  if (config.minAtrPct > 0 && atr / price < config.minAtrPct) return null;
  // Volume confirmation — real moves carry participation.
  const volumeOk =
    config.volMaMult <= 0 ||
    volume === null || avgVolume === null ||
    volume >= config.volMaMult * avgVolume;
  if (!volumeOk) return null;

  // ── LONG: uptrend pullback continuation ──────────────────────────────────
  if (config.allowLong) {
    const aboveTrend       = price > ema200 && ema200 >= prevEma200;
    const bullishAlignment = emaFast > emaSlow && emaSlow > ema200;
    const macdUp =
      (prevMacd.macdLine <= prevMacd.signalLine && macd.macdLine > macd.signalLine) ||
      (prevMacd.histogram < 0 && macd.histogram >= 0);
    const rsiOk = rsi >= config.rsiBuyMin && rsi <= config.rsiBuyMax;

    if (aboveTrend && bullishAlignment && macdUp && rsiOk) {
      return { type: 'ENTRY', side: 'LONG', symbol, price, timestamp, rsi, atr };
    }
  }

  // ── SHORT: downtrend rally continuation (mirror of LONG) ─────────────────
  if (config.allowShort) {
    const belowTrend       = price < ema200 && ema200 <= prevEma200;
    const bearishAlignment = emaFast < emaSlow && emaSlow < ema200;
    const macdDown =
      (prevMacd.macdLine >= prevMacd.signalLine && macd.macdLine < macd.signalLine) ||
      (prevMacd.histogram > 0 && macd.histogram <= 0);
    // RSI window mirrored around 50: long [min,max] → short [100-max, 100-min].
    const rsiOk = rsi >= 100 - config.rsiBuyMax && rsi <= 100 - config.rsiBuyMin;

    if (belowTrend && bearishAlignment && macdDown && rsiOk) {
      return { type: 'ENTRY', side: 'SHORT', symbol, price, timestamp, rsi, atr };
    }
  }

  return null;
}
