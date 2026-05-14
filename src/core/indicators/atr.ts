// src/core/indicators/atr.ts

import { ATR } from 'technicalindicators';

export function computeAtr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number | null {
  if (closes.length < period + 1) return null;

  const values = ATR.calculate({ high: highs, low: lows, close: closes, period });
  return values[values.length - 1] ?? null;
}
