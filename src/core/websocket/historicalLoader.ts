// src/core/websocket/historicalLoader.ts

import type { Candle } from '../../types/index.js';

const BINANCE_REST_BASE = 'https://api.binance.com/api/v3';

type KlineRow = [
  number, string, string, string, string, string,
  number, string, number, string, string, string,
];

export async function fetchHistoricalCandles(
  symbol: string,
  interval: string,
  limit: number,
): Promise<Candle[]> {
  const url = `${BINANCE_REST_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Binance REST error: ${res.status} ${res.statusText}`);
  }

  const rows = await res.json() as KlineRow[];

  return rows.map((row) => ({
    symbol,
    interval,
    openTime:  row[0],
    closeTime: row[6],
    open:      parseFloat(row[1]),
    high:      parseFloat(row[2]),
    low:       parseFloat(row[3]),
    close:     parseFloat(row[4]),
    volume:    parseFloat(row[5]),
    isClosed:  true,
  }));
}
