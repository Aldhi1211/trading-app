// src/core/indicators/bollinger.ts

import { BollingerBands } from 'technicalindicators';
import type { BollingerResult } from '../../types/index.js';

/**
 * Returns the latest Bollinger Bands snapshot, or null if closes is too short.
 * Minimum input length: period.
 *
 * BollingerResult also includes derived fields:
 *   width   = (upper - lower) / middle  → volatility measure
 *   percentB = (price - lower) / (upper - lower)  → 0..1 where the price sits
 *
 * These are computed here once rather than making callers re-derive them.
 */
export function computeBollingerBands(
  closes: number[],
  period: number,
  stdDev: number,
): BollingerResult | null {
  if (closes.length < period) return null;

  const results = BollingerBands.calculate({ values: closes, period, stdDev });
  const last = results[results.length - 1];
  if (!last) return null;

  const { upper, middle, lower } = last;
  const latestClose = closes[closes.length - 1] ?? middle;

  return {
    upper,
    middle,
    lower,
    width:    (upper - lower) / middle,
    percentB: upper !== lower ? (latestClose - lower) / (upper - lower) : 0.5,
  };
}
