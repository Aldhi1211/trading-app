// src/core/indicators/ema.ts

import { EMA } from 'technicalindicators';

/**
 * Returns the latest EMA value, or null if closes is too short.
 * Minimum input length: period (EMA seed = SMA of first `period` values).
 */
export function computeEma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;

  const values = EMA.calculate({ values: closes, period });
  return values[values.length - 1] ?? null;
}

/**
 * Returns { current, prev } EMA for crossover detection,
 * or null if closes is too short for two consecutive outputs.
 * Minimum input length: period + 1.
 *
 * Preferred over calling computeEma twice on different slices because it
 * runs EMA.calculate once and reads the last two values — no array allocation.
 */
export function computeEmaWithPrev(
  closes: number[],
  period: number,
): { current: number; prev: number } | null {
  if (closes.length < period + 1) return null;

  const values = EMA.calculate({ values: closes, period });
  if (values.length < 2) return null;

  return {
    current: values[values.length - 1]!,
    prev:    values[values.length - 2]!,
  };
}
