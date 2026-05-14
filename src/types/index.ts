// src/types/index.ts

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Minimal logger interface. Property syntax (not method syntax) means
 * `{ info: () => {}, warn: () => {}, error: () => {} }` satisfies this in
 * tests via TypeScript's function arity compatibility — no mocking library
 * needed. Pino, Winston, and console all satisfy it structurally.
 */
type LogMethod = (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
export interface ILogger {
  info:  LogMethod;
  warn:  LogMethod;
  error: LogMethod;
  fatal?: LogMethod;
}

/** No-op implementation for tests. */
export const silentLogger: ILogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export interface Candle {
  symbol: string;
  interval: string;
  openTime: number;   // Unix ms
  closeTime: number;  // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;  // true only on the final tick of a completed candle
}

// Parallel number[] arrays for efficient O(1) appends and direct pass to
// technicalindicators functions, which all expect `{ values: number[] }`.
export interface CandleBuffer {
  symbol: string;
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

export interface MacdResult {
  macdLine: number;
  signalLine: number;
  histogram: number;
}

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  width: number;      // (upper - lower) / middle — volatility proxy
  percentB: number;   // (price - lower) / (upper - lower) — 0..1 position within bands
}

// All indicator values for one point in time. Null means the buffer does not
// yet have enough candles to compute that indicator (warm-up period).
// prevEmaFast / prevEmaSlow are the values from the previous closed candle —
// required by the strategy engine to detect EMA crossovers without keeping
// its own history.
export interface IndicatorSnapshot {
  symbol: string;
  timestamp: number;  // Unix ms of the candle close
  price: number;      // current close price

  rsi: number | null;
  prevRsi: number | null;

  emaFast: number | null;     // EMA(20) — short-term trend
  emaSlow: number | null;     // EMA(50) — medium-term trend
  prevEmaFast: number | null;
  prevEmaSlow: number | null;

  ema200: number | null;      // EMA(200) — primary trend filter
  prevEma200: number | null;

  macd: MacdResult | null;
  prevMacd: MacdResult | null;
  bollingerBands: BollingerResult | null;

  atr: number | null;
}

// ---------------------------------------------------------------------------
// Trading signals — discriminated union so TypeScript narrows automatically.
//
// BuySignal.rsi is number (not null) because a BUY only fires when RSI is
// valid and below the oversold threshold — it is definitionally non-null.
//
// SellSignal.rsi is number | null because price-based exits (TAKE_PROFIT,
// STOP_LOSS) can fire before the indicator buffer is fully warmed up.
// ---------------------------------------------------------------------------

export type SellReason =
  | 'TAKE_PROFIT'
  | 'STOP_LOSS'
  | 'RSI_OVERBOUGHT'
  | 'EMA20_BREAKDOWN'
  | 'MACD_REVERSAL';

export interface BuySignal {
  type: 'BUY';
  symbol: string;
  price: number;
  timestamp: number;
  rsi: number;
}

export interface SellSignal {
  type: 'SELL';
  symbol: string;
  price: number;
  timestamp: number;
  reason: SellReason;
  rsi: number | null;
}

export type Signal = BuySignal | SellSignal;

// ---------------------------------------------------------------------------
// Portfolio domain
//
// Position  = live open trade, held in memory only.
// Trade     = completed trade, persisted to SQLite.
// The two are separate types so the compiler prevents treating an open
// position as a closed trade or vice-versa.
// ---------------------------------------------------------------------------

export interface Position {
  id: string;         // UUID, same id will become Trade.id on close
  symbol: string;
  entryPrice: number;
  quantity: number;   // units of base asset (e.g. BTC)
  entryTime: number;  // Unix ms
  entryRsi: number;
}

export interface Trade {
  id: string;
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryTime: number;
  exitTime: number;
  entryRsi: number;   // preserved from Position for analysis
  pnlPercent: number; // (exitValue - entryValue) / entryValue * 100
  pnlUsdt: number;    // absolute PnL in USDT
  reason: SellReason;
}

export interface PortfolioState {
  balance: number;          // USDT currently available (not in any position)
  totalDeposited: number;   // original starting capital, never changes
  openPosition: Position | null;
  totalTrades: number;
  winningTrades: number;
  totalPnlUsdt: number;
  totalPnlPercent: number;  // ((balance - totalDeposited) / totalDeposited) * 100
}
