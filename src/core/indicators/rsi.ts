// src/core/indicators/rsi.ts

import { RSI } from 'technicalindicators';

/**
 * Returns the latest RSI value, or null if closes is too short.
 * Minimum input length: period + 1 (Wilder smoothing needs period+1 for first output).
 */
export function computeRsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;

  const values = RSI.calculate({ values: closes, period });
  return values[values.length - 1] ?? null;
}

/**
 * Returns { current, prev } RSI for crossover / threshold-cross detection,
 * or null if closes is too short for two consecutive outputs.
 * Minimum input length: period + 2.
 */
export function computeRsiWithPrev(
  closes: number[],
  period: number,
): { current: number; prev: number } | null {
  if (closes.length < period + 2) return null;

  const values = RSI.calculate({ values: closes, period });
  if (values.length < 2) return null;

  // Non-null assertion safe: length >= 2 checked above.
  return {
    current: values[values.length - 1]!,
    prev:    values[values.length - 2]!,
  };
}
