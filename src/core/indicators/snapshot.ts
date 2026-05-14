// src/core/indicators/snapshot.ts

import { env } from '../../config/env.js';
import {
  MACD_FAST_PERIOD,
  MACD_SLOW_PERIOD,
  MACD_SIGNAL_PERIOD,
  BOLLINGER_PERIOD,
  BOLLINGER_STD_DEV,
  EMA_200_PERIOD,
  ATR_PERIOD,
} from '../../config/constants.js';
import { computeRsiWithPrev } from './rsi.js';
import { computeEmaWithPrev } from './ema.js';
import { computeMacdWithPrev } from './macd.js';
import { computeBollingerBands } from './bollinger.js';
import { computeAtr } from './atr.js';
import type { CandleBuffer, IndicatorSnapshot } from '../../types/index.js';

/**
 * Computes every indicator from the current buffer in one pass and returns a
 * typed snapshot.  Pure function — no side effects, safe to call from tests.
 *
 * `price`     — the current close (may be a live tick or the last closed candle)
 * `timestamp` — Unix ms of the event that triggered this computation
 */
export function buildIndicatorSnapshot(
  buffer: Readonly<CandleBuffer>,
  price: number,
  timestamp: number,
): IndicatorSnapshot {
  const closes = buffer.closes;

  // RSI — computeRsiWithPrev runs RSI.calculate() once and reads the last two
  // values. This avoids the old pattern of calling the library twice or slicing
  // the array.
  const rsiResult    = computeRsiWithPrev(closes, env.RSI_PERIOD);
  const emaFastResult = computeEmaWithPrev(closes, env.EMA_FAST_PERIOD);
  const emaSlowResult = computeEmaWithPrev(closes, env.EMA_SLOW_PERIOD);
  const ema200Result  = computeEmaWithPrev(closes, EMA_200_PERIOD);
  const macdResult    = computeMacdWithPrev(closes, MACD_FAST_PERIOD, MACD_SLOW_PERIOD, MACD_SIGNAL_PERIOD);
  const bollingerBands = computeBollingerBands(closes, BOLLINGER_PERIOD, BOLLINGER_STD_DEV);
  const atr           = computeAtr(buffer.highs, buffer.lows, closes, ATR_PERIOD);

  return {
    symbol:   buffer.symbol,
    timestamp,
    price,

    rsi:     rsiResult?.current ?? null,
    prevRsi: rsiResult?.prev    ?? null,

    emaFast:     emaFastResult?.current ?? null,
    prevEmaFast: emaFastResult?.prev    ?? null,

    emaSlow:     emaSlowResult?.current ?? null,
    prevEmaSlow: emaSlowResult?.prev    ?? null,

    ema200:     ema200Result?.current ?? null,
    prevEma200: ema200Result?.prev    ?? null,

    macd:     macdResult?.current ?? null,
    prevMacd: macdResult?.prev    ?? null,

    bollingerBands,
    atr,
  };
}
