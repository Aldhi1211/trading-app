// src/backtest.ts
//
// Standalone strategy backtester (dev tool — excluded from the production build
// in tsconfig.json; run with `npm run backtest`).
//
// It replays historical BTC klines through the SAME pure functions the live bot
// uses (buildIndicatorSnapshot + createSignalEngine), so entries are identical
// to production. Stops, targets, trailing, sizing and cooldown mirror the
// PositionManager formulas. Two things make it MORE realistic than the live
// paper bot:
//   1. Stop / take-profit fills are checked INTRABAR against each candle's
//      high/low (the live bot only checks the close, so it can blow past stops).
//   2. Trading cost (fee + slippage) is charged on both sides of every trade.
//
// Usage:
//   npm run backtest                 # uses env INTERVAL, 5000 candles
//   npm run backtest -- 15m 8000     # 15m timeframe, 8000 candles
//   BACKTEST_COST=0.001 npm run backtest -- 1h   # 0.1% cost per side
//
// All strategy parameters are read from the same env vars as the live bot, so
// the backtest reflects your current configuration.

// Provide dummy required env BEFORE importing anything that validates env
// (snapshot.ts pulls config/env.ts, which exits if Telegram vars are missing).
process.env['TELEGRAM_BOT_TOKEN'] ||= 'backtest';
process.env['TELEGRAM_CHAT_ID']  ||= 'backtest';

import type { Candle, CandleBuffer, PositionSide } from './types/index.js';

const REST = 'https://data-api.binance.vision/api/v3';

type KlineRow = [number, string, string, string, string, string, number, ...unknown[]];

/** Fetches `total` most-recent klines, paginating backwards (max 1000/request). */
async function fetchKlines(symbol: string, interval: string, total: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime: number | undefined;

  while (out.length < total) {
    const limit = Math.min(1000, total - out.length);
    const url =
      `${REST}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}` +
      (endTime ? `&endTime=${endTime}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance REST error: ${res.status} ${res.statusText}`);
    const rows = (await res.json()) as KlineRow[];
    if (rows.length === 0) break;

    const chunk: Candle[] = rows.map((r) => ({
      symbol, interval,
      openTime: r[0], closeTime: r[6],
      open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
      isClosed: true,
    }));
    out.unshift(...chunk);
    endTime = chunk[0]!.openTime - 1;
    if (rows.length < limit) break;
  }

  out.sort((a, b) => a.openTime - b.openTime);
  return out.slice(-total);
}

function pct(n: number): string { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function usd(n: number): string { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }

async function main(): Promise<void> {
  const { env } = await import('./config/env.js');
  const { buildIndicatorSnapshot } = await import('./core/indicators/snapshot.js');
  const { createSignalEngine } = await import('./core/strategy/signalEngine.js');
  const { computeBufferCapacity } = await import('./config/constants.js');

  const interval     = process.argv[2] ?? env.INTERVAL;
  const count        = parseInt(process.argv[3] ?? '5000', 10);
  const costPerSide  = parseFloat(process.env['BACKTEST_COST'] ?? '0.0006'); // fee+slippage, 0.06%/side
  const symbol       = env.SYMBOL;

  console.log(`\nFetching ${count} × ${interval} candles for ${symbol} from ${REST} ...`);
  const candles = await fetchKlines(symbol, interval, count);
  const first = candles[0]!, last = candles[candles.length - 1]!;
  console.log(
    `Got ${candles.length} candles: ` +
    `${new Date(first.openTime).toISOString().slice(0, 16)} → ${new Date(last.closeTime).toISOString().slice(0, 16)} UTC`,
  );

  const capacity = computeBufferCapacity(env.RSI_PERIOD, env.EMA_SLOW_PERIOD);
  const evaluate = createSignalEngine({
    rsiBuyMin:  env.RSI_BUY_MIN,
    rsiBuyMax:  env.RSI_BUY_MAX,
    volMaMult:  env.VOL_MA_MULT,
    minAtrPct:  env.MIN_ATR_PCT,
    allowLong:  env.ALLOW_LONG,
    allowShort: env.ALLOW_SHORT,
  });

  const buf: CandleBuffer = { symbol, closes: [], highs: [], lows: [], volumes: [] };
  const startEquity = env.INITIAL_BALANCE_USDT;
  let equity = startEquity;
  let peak = equity, maxDD = 0;
  let totalCost = 0;
  let cooldown = 0;
  let firstTestClose: number | null = null;

  interface Pos {
    side: PositionSide; entry: number; qty: number;
    stop: number; tp: number; extreme: number; atr: number; risk: number; entryFee: number;
  }
  let pos: Pos | null = null;

  interface ClosedTrade { side: PositionSide; pnl: number; reason: string }
  const trades: ClosedTrade[] = [];

  function pushBuffer(c: Candle): void {
    buf.closes.push(c.close); buf.highs.push(c.high); buf.lows.push(c.low); buf.volumes.push(c.volume);
    if (buf.closes.length > capacity) {
      buf.closes.shift(); buf.highs.shift(); buf.lows.shift(); buf.volumes.shift();
    }
  }

  for (const c of candles) {
    pushBuffer(c);
    if (buf.closes.length < capacity) continue; // warm-up
    if (firstTestClose === null) firstTestClose = c.close;
    if (cooldown > 0) cooldown--;

    // ── Manage open position: intrabar stop/TP fills (stop checked first) ────
    if (pos) {
      const dir = pos.side === 'LONG' ? 1 : -1;
      let exitPrice: number | null = null;
      let reason = '';

      if (pos.side === 'LONG') {
        if (c.low <= pos.stop) {
          exitPrice = c.open <= pos.stop ? c.open : pos.stop; // gap-through fills worse
          reason = pos.stop >= pos.entry ? 'TRAILING_STOP' : 'STOP_LOSS';
        } else if (c.high >= pos.tp) {
          exitPrice = c.open >= pos.tp ? c.open : pos.tp;
          reason = 'TAKE_PROFIT';
        }
      } else {
        if (c.high >= pos.stop) {
          exitPrice = c.open >= pos.stop ? c.open : pos.stop;
          reason = pos.stop <= pos.entry ? 'TRAILING_STOP' : 'STOP_LOSS';
        } else if (c.low <= pos.tp) {
          exitPrice = c.open <= pos.tp ? c.open : pos.tp;
          reason = 'TAKE_PROFIT';
        }
      }

      if (exitPrice !== null) {
        const exitFee = pos.qty * exitPrice * costPerSide;
        const pnl = pos.qty * (exitPrice - pos.entry) * dir - pos.entryFee - exitFee;
        equity += pnl;
        totalCost += pos.entryFee + exitFee;
        trades.push({ side: pos.side, pnl, reason });
        if (pnl < 0) cooldown = env.ENTRY_COOLDOWN_BARS;
        pos = null;
        peak = Math.max(peak, equity);
        maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100);
      } else if (env.USE_TRAILING_STOP) {
        // Trail on close (same cadence as the live bot).
        const trailDist = env.TRAIL_ATR_MULT * pos.atr;
        if (pos.side === 'LONG') {
          pos.extreme = Math.max(pos.extreme, c.close);
          if (pos.extreme >= pos.entry + env.BREAKEVEN_AT_R * pos.risk) {
            pos.stop = Math.max(pos.stop, pos.entry, pos.extreme - trailDist);
          }
        } else {
          pos.extreme = Math.min(pos.extreme, c.close);
          if (pos.extreme <= pos.entry - env.BREAKEVEN_AT_R * pos.risk) {
            pos.stop = Math.min(pos.stop, pos.entry, pos.extreme + trailDist);
          }
        }
      }
    }

    // ── Entry on close when flat ─────────────────────────────────────────────
    if (!pos && cooldown === 0) {
      const snap = buildIndicatorSnapshot(buf, c.close, c.closeTime);
      const sig = evaluate(snap, null);
      if (sig && sig.type === 'ENTRY' && sig.atr !== null && sig.atr > 0) {
        const atr = sig.atr;
        const dir = sig.side === 'LONG' ? 1 : -1;
        const stopDist = env.USE_ATR_RISK ? env.ATR_SL_MULT * atr : c.close * env.STOP_LOSS_PCT;
        const tpDist   = env.USE_ATR_RISK ? env.ATR_TP_MULT * atr : c.close * env.TAKE_PROFIT_PCT;

        let alloc: number;
        if (env.POSITION_SIZING_MODE === 'risk') {
          const maxA = equity * env.MAX_ALLOCATION_PCT;
          alloc = stopDist <= 0 ? maxA : Math.min((equity * env.RISK_PER_TRADE_PCT / stopDist) * c.close, maxA);
        } else if (env.POSITION_SIZING_MODE === 'percent') {
          alloc = equity * env.TRADE_ALLOCATION_PCT;
        } else {
          alloc = Math.min(env.POSITION_FIXED_USDT, equity);
        }

        if (alloc > 0 && equity > 0) {
          const qty = alloc / c.close;
          pos = {
            side: sig.side, entry: c.close, qty,
            stop: c.close - dir * stopDist,
            tp:   c.close + dir * tpDist,
            extreme: c.close, atr, risk: stopDist,
            entryFee: qty * c.close * costPerSide,
          };
        }
      }
    }
  }

  // ── Metrics ────────────────────────────────────────────────────────────────
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnl, 0); // negative
  const winRate = n > 0 ? (wins.length / n) * 100 : 0;
  const pf = grossLoss !== 0 ? grossProfit / Math.abs(grossLoss) : Infinity;
  const expectancy = n > 0 ? (equity - startEquity) / n : 0;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const netReturn = ((equity - startEquity) / startEquity) * 100;
  const buyHold = firstTestClose ? ((last.close - firstTestClose) / firstTestClose) * 100 : 0;

  const bySide = (s: PositionSide) => {
    const t = trades.filter((x) => x.side === s);
    const w = t.filter((x) => x.pnl > 0).length;
    const p = t.reduce((sum, x) => sum + x.pnl, 0);
    return { count: t.length, winRate: t.length ? (w / t.length) * 100 : 0, pnl: p };
  };
  const reasons = trades.reduce<Record<string, number>>((acc, t) => {
    acc[t.reason] = (acc[t.reason] ?? 0) + 1; return acc;
  }, {});

  const L = (label: string, value: string) => console.log('  ' + label.padEnd(22) + value);
  console.log('\n' + '═'.repeat(52));
  console.log(`  BACKTEST RESULT — ${symbol} ${interval}`);
  console.log('═'.repeat(52));
  L('Strategy config', `${env.ALLOW_LONG ? 'long' : ''}${env.ALLOW_LONG && env.ALLOW_SHORT ? '+' : ''}${env.ALLOW_SHORT ? 'short' : ''}, ${env.POSITION_SIZING_MODE} sizing`);
  L('Cost per side', (costPerSide * 100).toFixed(3) + '%');
  console.log('  ' + '─'.repeat(48));
  L('Net return', `${pct(netReturn)}   (${usd(equity - startEquity)})`);
  L('Buy & hold (benchmark)', pct(buyHold));
  L('Final equity', '$' + equity.toFixed(2));
  L('Max drawdown', '-' + maxDD.toFixed(2) + '%');
  console.log('  ' + '─'.repeat(48));
  L('Total trades', String(n));
  L('Win rate', winRate.toFixed(1) + '%  (' + wins.length + 'W / ' + losses.length + 'L)');
  L('Profit factor', pf === Infinity ? '∞' : pf.toFixed(2));
  L('Expectancy / trade', usd(expectancy));
  L('Avg win / avg loss', `${usd(avgWin)} / ${usd(avgLoss)}`);
  L('Total cost paid', '$' + totalCost.toFixed(2));
  console.log('  ' + '─'.repeat(48));
  const ls = bySide('LONG'), ss = bySide('SHORT');
  L('LONG', `${ls.count} trades, ${ls.winRate.toFixed(0)}% win, ${usd(ls.pnl)}`);
  L('SHORT', `${ss.count} trades, ${ss.winRate.toFixed(0)}% win, ${usd(ss.pnl)}`);
  L('Exit reasons', Object.entries(reasons).map(([k, v]) => `${k}:${v}`).join('  '));
  console.log('═'.repeat(52) + '\n');

  // Verdict
  if (n < 30) {
    console.log('⚠️  Sample too small (<30 trades) — results are mostly noise. Use more candles / lower timeframe.');
  } else if (pf > 1.3 && netReturn > buyHold) {
    console.log('✅ Positive edge in this sample AND beats buy & hold. Worth validating out-of-sample.');
  } else if (pf > 1.0) {
    console.log('🟡 Marginally positive before being sure — likely eaten by costs/variance. Not a reliable edge.');
  } else {
    console.log('❌ Negative expectancy: the strategy loses money on this data. The entry has no edge here.');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
