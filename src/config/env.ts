// src/config/env.ts

import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // ── Telegram (required) ───────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_CHAT_ID:   z.string().min(1, 'TELEGRAM_CHAT_ID is required'),

  // ── Trading config ────────────────────────────────────────────────────────
  SYMBOL:   z.string().default('BTCUSDT'),
  INTERVAL: z.string().default('1m'),

  INITIAL_BALANCE_USDT:  z.coerce.number().positive().default(1000),
  TAKE_PROFIT_PCT:       z.coerce.number().positive().default(0.02),
  STOP_LOSS_PCT:         z.coerce.number().positive().default(0.01),

  // ── Position sizing ───────────────────────────────────────────────────────
  // POSITION_SIZING_MODE: 'percent' allocates TRADE_ALLOCATION_PCT of the
  // available balance. 'fixed' always allocates exactly POSITION_FIXED_USDT.
  POSITION_SIZING_MODE:  z.enum(['percent', 'fixed']).default('percent'),
  TRADE_ALLOCATION_PCT:  z.coerce.number().min(0.01).max(1).default(0.95),
  POSITION_FIXED_USDT:   z.coerce.number().positive().default(950),

  // ── Indicator parameters ──────────────────────────────────────────────────
  RSI_PERIOD:     z.coerce.number().int().positive().default(14),
  RSI_OVERSOLD:   z.coerce.number().default(35),
  RSI_OVERBOUGHT: z.coerce.number().default(70),
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
