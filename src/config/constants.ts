// src/config/constants.ts

export const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';

// WebSocket reconnection
export const WS_RECONNECT_INITIAL_DELAY_MS = 1_000;
export const WS_RECONNECT_MAX_DELAY_MS     = 30_000;
export const WS_RECONNECT_BACKOFF_FACTOR   = 2;
export const WS_MAX_RETRIES                = 5;

// Fixed indicator periods (not configurable via env — strategy-level constants)
export const MACD_FAST_PERIOD    = 12;
export const MACD_SLOW_PERIOD    = 26;
export const MACD_SIGNAL_PERIOD  = 9;
export const BOLLINGER_PERIOD    = 20;
export const BOLLINGER_STD_DEV   = 2;

/**
 * Derives the rolling buffer capacity from the configured indicator periods.
 *
 * Each indicator has a minimum data requirement to produce a valid output:
 *   RSI(p)            → needs p+1 closes for current, p+2 for prevRsi
 *   EMA(p)            → needs p closes for current, p+1 for prevEma
 *   MACD(12, slow, sig) → needs slow + sig - 1 closes for first signal output
 *   BB(p)             → needs p closes
 *
 * We take the strictest requirement across all indicators then add +10 as a
 * rolling safety margin, which is also what the spec calls "N = max period + 10".
 *
 * The return value is used both as the rolling-window cap AND to derive
 * minCandlesRequired (capacity - 10), which is when isReady() returns true.
 */
export function computeBufferCapacity(rsiPeriod: number, emaSlowPeriod: number): number {
  const rsiMin  = rsiPeriod + 2;                               // current + prevRsi
  const emaMin  = emaSlowPeriod + 2;                           // current + prevEma
  const macdMin = MACD_SLOW_PERIOD + MACD_SIGNAL_PERIOD;       // 35 for prev MACD signal
  const bbMin   = BOLLINGER_PERIOD;

  return Math.max(rsiMin, emaMin, macdMin, bbMin) + 10;
}
