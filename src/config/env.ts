// src/config/env.ts

import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

// z.coerce.boolean() is unsafe for env vars: the STRING "false" is truthy and
// coerces to `true`. This parser treats the usual falsy spellings as false.
const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      return !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase());
    });

const envSchema = z.object({
  // ── Telegram (required) ───────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_CHAT_ID:   z.string().min(1, 'TELEGRAM_CHAT_ID is required'),

  // ── Trading config ────────────────────────────────────────────────────────
  SYMBOL:   z.string().default('BTCUSDT'),
  INTERVAL: z.string().default('1m'),

  INITIAL_BALANCE_USDT:  z.coerce.number().positive().default(1000),

  // Percentage stops — used as a FALLBACK when ATR is unavailable, and as the
  // exit levels when ATR-based risk management is disabled.
  TAKE_PROFIT_PCT:       z.coerce.number().positive().default(0.02),
  STOP_LOSS_PCT:         z.coerce.number().positive().default(0.01),

  // ── ATR-based risk management (volatility-adaptive stops & targets) ─────────
  // When USE_ATR_RISK=true, the stop/target distances scale with current ATR
  // instead of using fixed percentages. This is the recommended mode for BTC,
  // whose volatility varies several-fold between calm and active regimes.
  USE_ATR_RISK:          boolFromEnv(true),
  ATR_SL_MULT:           z.coerce.number().positive().default(1.5),  // stop  = entry - 1.5*ATR
  ATR_TP_MULT:           z.coerce.number().positive().default(3.0),  // target = entry + 3.0*ATR (2:1 R:R)

  // Trailing stop: once price reaches +BREAKEVEN_AT_R risk-multiples of profit,
  // the stop jumps to breakeven (risk-free), then trails the peak by
  // TRAIL_ATR_MULT*ATR so winners are allowed to run.
  USE_TRAILING_STOP:     boolFromEnv(true),
  TRAIL_ATR_MULT:        z.coerce.number().positive().default(1.5),
  BREAKEVEN_AT_R:        z.coerce.number().positive().default(1.0),

  // ── Position sizing ───────────────────────────────────────────────────────
  // 'risk'    : size so a stop-out loses RISK_PER_TRADE_PCT of equity (recommended).
  // 'percent' : allocate TRADE_ALLOCATION_PCT of the available balance.
  // 'fixed'   : always allocate exactly POSITION_FIXED_USDT.
  POSITION_SIZING_MODE:  z.enum(['risk', 'percent', 'fixed']).default('risk'),
  RISK_PER_TRADE_PCT:    z.coerce.number().min(0.001).max(1).default(0.01),  // risk 1% of equity per trade
  MAX_ALLOCATION_PCT:    z.coerce.number().min(0.01).max(1).default(0.95),   // never deploy more than 95% of balance
  TRADE_ALLOCATION_PCT:  z.coerce.number().min(0.01).max(1).default(0.95),
  POSITION_FIXED_USDT:   z.coerce.number().positive().default(950),

  // ── Entry-quality filters ───────────────────────────────────────────────────
  // VOL_MA_MULT: require the entry candle's volume >= this * average volume.
  //   1.0 = above-average volume; 0 disables the filter.
  // MIN_ATR_PCT: require ATR/price >= this (skip dead, untradeable markets).
  //   0 disables the filter.
  // ENTRY_COOLDOWN_BARS: after a LOSING trade, skip new entries for this many
  //   closed candles — prevents revenge re-entries into the same chop.
  VOL_MA_MULT:           z.coerce.number().min(0).default(1.0),
  MIN_ATR_PCT:           z.coerce.number().min(0).default(0),
  ENTRY_COOLDOWN_BARS:   z.coerce.number().int().min(0).default(3),

  // ── Trade direction ─────────────────────────────────────────────────────────
  // ALLOW_LONG  : take long  positions (buy uptrends).
  // ALLOW_SHORT : take short positions (sell-to-open downtrends).
  // Shorting is a futures/margin simulation — impossible on a spot account.
  ALLOW_LONG:            boolFromEnv(true),
  ALLOW_SHORT:           boolFromEnv(true),

  // ── Indicator parameters ──────────────────────────────────────────────────
  RSI_PERIOD:     z.coerce.number().int().positive().default(14),
  RSI_OVERSOLD:   z.coerce.number().default(35),
  RSI_OVERBOUGHT: z.coerce.number().default(70),
  // Entry window: buy only when RSI sits between these bounds — not so low that
  // the trend is broken, not so high that the move is already exhausted.
  RSI_BUY_MIN:    z.coerce.number().default(40),
  RSI_BUY_MAX:    z.coerce.number().default(65),
  EMA_FAST_PERIOD: z.coerce.number().int().positive().default(20),
  EMA_SLOW_PERIOD: z.coerce.number().int().positive().default(50),

  // ── Database ──────────────────────────────────────────────────────────────
  DB_PATH: z.string().default('./data/trading.db'),

  // ── Logging ───────────────────────────────────────────────────────────────
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment configuration:');
  result.error.errors.forEach((err) => {
    console.error(`  ${err.path.join('.')}: ${err.message}`);
  });
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
