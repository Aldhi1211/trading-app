// src/core/indicators/snapshot.ts

import { env } from '../../config/env.js';
import {
  MACD_FAST_PERIOD,
  MACD_SLOW_PERIOD,
  MACD_SIGNAL_PERIOD,
  BOLLINGER_PERIOD,
  BOLLINGER_STD_DEV,
} from '../../config/constants.js';
import { computeRsiWithPrev } from './rsi.js';
import { computeEmaWithPrev } from './ema.js';
import { computeMacd } from './macd.js';
import { computeBollingerBands } from './bollinger.js';
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
  const rsiResult = computeRsiWithPrev(closes, env.RSI_PERIOD);

  // EMA crossover — computeEmaWithPrev also runs EMA.calculate() once per period,
  // returning both current and prev without allocating a slice array.
  const emaFastResult = computeEmaWithPrev(closes, env.EMA_FAST_PERIOD);
  const emaSlowResult = computeEmaWithPrev(closes, env.EMA_SLOW_PERIOD);

  const macd          = computeMacd(closes, MACD_FAST_PERIOD, MACD_SLOW_PERIOD, MACD_SIGNAL_PERIOD);
  const bollingerBands = computeBollingerBands(closes, BOLLINGER_PERIOD, BOLLINGER_STD_DEV);

  return {
    symbol:   buffer.symbol,
    timestamp,
    price,

    rsi:     rsiResult?.current    ?? null,
    prevRsi: rsiResult?.prev       ?? null,

    emaFast:     emaFastResult?.current ?? null,
    prevEmaFast: emaFastResult?.prev    ?? null,

    emaSlow:     emaSlowResult?.current ?? null,
    prevEmaSlow: emaSlowResult?.prev    ?? null,

    macd,
    bollingerBands,
  };
}
