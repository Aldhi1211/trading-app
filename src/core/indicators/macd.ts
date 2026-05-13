// src/core/indicators/macd.ts

import { MACD } from 'technicalindicators';
import type { MacdResult } from '../../types/index.js';

/**
 * Minimum closes needed for the first complete MACD signal output:
 *   slowPeriod + signalPeriod - 1
 * Derivation: slowEMA needs `slowPeriod` closes → 1 MACD value.
 *   signalEMA needs `signalPeriod` MACD values → (signalPeriod - 1) more closes.
 *   Total = slowPeriod + (signalPeriod - 1).
 */
function macdMinLength(slowPeriod: number, signalPeriod: number): number {
  return slowPeriod + signalPeriod - 1;
}

/**
 * Returns the latest MACD snapshot, or null if closes is too short.
 */
export function computeMacd(
  closes: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): MacdResult | null {
  if (closes.length < macdMinLength(slowPeriod, signalPeriod)) return null;

  const results = MACD.calculate({
    values: closes,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  const last = results[results.length - 1];
  if (
    last === undefined   ||
    last.MACD      === undefined ||
    last.signal    === undefined ||
    last.histogram === undefined
  ) {
    return null;
  }

  return {
    macdLine:   last.MACD,
    signalLine: last.signal,
    histogram:  last.histogram,
  };
}

/**
 * Returns { current, prev } MACD for crossover detection,
 * or null if closes is too short for two consecutive signal outputs.
 * Minimum input length: slowPeriod + signalPeriod (one more than computeMacd).
 */
export function computeMacdWithPrev(
  closes: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): { current: MacdResult; prev: MacdResult } | null {
  if (closes.length < macdMinLength(slowPeriod, signalPeriod) + 1) return null;

  const results = MACD.calculate({
    values: closes,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  if (results.length < 2) return null;

  const last = results[results.length - 1];
  const prev = results[results.length - 2];

  if (
    last?.MACD === undefined || last.signal === undefined || last.histogram === undefined ||
    prev?.MACD === undefined || prev.signal === undefined || prev.histogram === undefined
  ) {
    return null;
  }

  return {
    current: { macdLine: last.MACD, signalLine: last.signal, histogram: last.histogram },
    prev:    { macdLine: prev.MACD, signalLine: prev.signal, histogram: prev.histogram },
  };
}
