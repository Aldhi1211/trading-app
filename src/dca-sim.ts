// src/dca-sim.ts
//
// Long-term accumulation simulator (dev tool — excluded from build; `npm run dca`).
//
// Compares three ways to build a BTC position over time on DAILY candles:
//   1. LUMP SUM      — invest the entire eventual budget on day one (benchmark).
//   2. PURE DCA      — invest a fixed amount every week, ignore price.
//   3. DCA + AVG-DOWN — invest a fixed weekly budget, but buy LESS near all-time
//      highs (saving the rest as dry powder) and MORE during drawdowns, deploying
//      the reserve. This is "averaging down": cheaper average cost in bear markets.
//
// Self-financing: the avg-down version uses the SAME total contributions as pure
// DCA — it just times them by how far price has fallen from its peak. It reports
// money invested, BTC accumulated, average cost, final value, ROI and the worst
// portfolio drawdown you'd have had to stomach.

import type { Candle } from './types/index.js';

const REST = 'https://data-api.binance.vision/api/v3';
type KlineRow = [number, string, string, string, string, string, number, ...unknown[]];

async function fetchKlines(symbol: string, interval: string, total: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime: number | undefined;
  while (out.length < total) {
    const limit = Math.min(1000, total - out.length);
    const url = `${REST}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}` + (endTime ? `&endTime=${endTime}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance REST ${res.status}`);
    const rows = (await res.json()) as KlineRow[];
    if (rows.length === 0) break;
    const chunk: Candle[] = rows.map((r) => ({
      symbol, interval, openTime: r[0], closeTime: r[6],
      open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5], isClosed: true,
    }));
    out.unshift(...chunk);
    endTime = chunk[0]!.openTime - 1;
    if (rows.length < limit) break;
  }
  out.sort((a, b) => a.openTime - b.openTime);
  return out.slice(-total);
}

interface Result {
  name: string; invested: number; btc: number; cashLeft: number;
  value: number; roi: number; avgCost: number; maxDD: number;
}

function maxDrawdownPct(series: number[]): number {
  let peak = -Infinity, maxDD = 0;
  for (const v of series) { peak = Math.max(peak, v); if (peak > 0) maxDD = Math.max(maxDD, (peak - v) / peak * 100); }
  return maxDD;
}

// multiplierFn maps drawdown-from-ATH (0..1) to how many "weekly budgets" to
// spend this week. null = pure DCA (always 1x). Reserve self-funds the >1x weeks.
function simulate(name: string, candles: Candle[], weekly: number, lumpSum: boolean, multiplierFn: ((dd: number) => number) | null): Result {
  let cash = 0, btc = 0, invested = 0, ath = 0;
  const values: number[] = [];
  const DAY_PER_WEEK = 7;

  if (lumpSum) {
    const weeks = Math.floor(candles.length / DAY_PER_WEEK);
    invested = weekly * weeks;
    btc = invested / candles[0]!.close;
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    ath = Math.max(ath, c.close);

    if (!lumpSum && i % DAY_PER_WEEK === 0) {
      cash += weekly; invested += weekly;
      const dd = ath > 0 ? (ath - c.close) / ath : 0;
      const mult = multiplierFn ? multiplierFn(dd) : 1;
      const spend = Math.min(weekly * mult, cash);
      if (spend > 0) { btc += spend / c.close; cash -= spend; }
    }
    values.push(btc * c.close + cash);
  }

  const last = candles[candles.length - 1]!.close;
  const value = btc * last + cash;
  return {
    name, invested, btc, cashLeft: cash, value,
    roi: invested > 0 ? (value - invested) / invested * 100 : 0,
    avgCost: btc > 0 ? (invested - cash) / btc : 0,
    maxDD: maxDrawdownPct(values),
  };
}

// Averaging-down schedule: near highs buy 0.5x (save dry powder); the deeper the
// drawdown, the harder you buy (up to 3x), spending the accumulated reserve.
function avgDownMultiplier(dd: number): number {
  if (dd >= 0.50) return 3.0;
  if (dd >= 0.35) return 2.5;
  if (dd >= 0.20) return 2.0;
  if (dd >= 0.10) return 1.3;
  return 0.5;
}

async function main(): Promise<void> {
  const symbol = process.argv[2] ?? 'BTCUSDT';
  const weekly = parseFloat(process.argv[3] ?? '50');     // $ per week
  const days   = parseInt(process.argv[4] ?? '3000', 10); // ~8 years

  console.log(`\nFetching ${days} daily ${symbol} candles ...`);
  const candles = await fetchKlines(symbol, '1d', days);
  const d = (t: number) => new Date(t).toISOString().slice(0, 10);
  const weeks = Math.floor(candles.length / 7);
  console.log(`Range: ${d(candles[0]!.openTime)} → ${d(candles[candles.length - 1]!.closeTime)}  (${candles.length} days, ${weeks} weekly buys)`);
  console.log(`Budget: $${weekly}/week  →  total contributed over period: $${(weekly * weeks).toLocaleString()}`);
  console.log(`BTC price: $${candles[0]!.close.toFixed(0)} (start) → $${candles[candles.length - 1]!.close.toFixed(0)} (end)\n`);

  const results = [
    simulate('Lump sum (all-in day 1)', candles, weekly, true, null),
    simulate('Pure DCA (weekly)',       candles, weekly, false, null),
    simulate('DCA + averaging down',    candles, weekly, false, avgDownMultiplier),
  ];

  const money = (n: number) => '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  console.log('Strategy                  Invested    Value      ROI      AvgCost     MaxDrawdown');
  console.log('─'.repeat(82));
  for (const r of results) {
    console.log(
      r.name.padEnd(25) +
      money(r.invested).padStart(9) + '  ' +
      money(r.value).padStart(9) + '  ' +
      ((r.roi >= 0 ? '+' : '') + r.roi.toFixed(0) + '%').padStart(7) + '  ' +
      money(r.avgCost).padStart(9) + '  ' +
      ('-' + r.maxDD.toFixed(0) + '%').padStart(9),
    );
  }
  console.log('─'.repeat(82));
  console.log(`(BTC accumulated — DCA: ${results[1]!.btc.toFixed(4)} | Avg-down: ${results[2]!.btc.toFixed(4)}, leftover cash ${money(results[2]!.cashLeft)})`);
  console.log('\nNote: results depend heavily on start/end dates. A period ending after a rally');
  console.log('flatters everything. Max drawdown = the worst paper loss you had to hold through.');
}

main().catch((e) => { console.error(e); process.exit(1); });
