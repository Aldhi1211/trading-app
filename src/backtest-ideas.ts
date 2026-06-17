// src/backtest-ideas.ts
//
// Entry-idea explorer with proper IN-SAMPLE / OUT-OF-SAMPLE validation
// (dev tool — excluded from the production build; run with `npm run ideas`).
//
// Method: one continuous walk through ~2.3 years of 1h candles. The series is
// split by date into an in-sample (IS) development half and an out-of-sample
// (OOS) validation half. Each candidate ENTRY strategy is run through the SAME
// position engine (ATR stop/target, trailing, risk sizing, fees, intrabar
// fills) — only the entry decision differs. We report IS vs OOS separately.
//
// A strategy is only worth anything if it is profitable on BOTH halves. Picking
// the best IS score and ignoring OOS = overfitting = losing real money.

process.env['TELEGRAM_BOT_TOKEN'] ||= 'backtest';
process.env['TELEGRAM_CHAT_ID']  ||= 'backtest';

import type { Candle, CandleBuffer, IndicatorSnapshot, PositionSide } from './types/index.js';

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

// An entry decision: given the indicator snapshot and raw buffer, return a side
// to open, or null to stay flat.
type EntryFn = (s: IndicatorSnapshot, buf: CandleBuffer) => PositionSide | null;

interface SimCfg {
  cost: number; useAtr: boolean; atrSl: number; atrTp: number; slPct: number; tpPct: number;
  useTrailing: boolean; trailMult: number; beR: number;
  sizingMode: string; riskPct: number; maxAllocPct: number; tradeAllocPct: number; fixedUsdt: number;
  cooldownBars: number; initialBalance: number; capacity: number;
}

interface SegMetrics { ret: number; pf: number; n: number; winRate: number; }

function seg(trades: { pnl: number }[], startEq: number, endEq: number): SegMetrics {
  const wins = trades.filter((t) => t.pnl > 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  return {
    ret: startEq > 0 ? ((endEq - startEq) / startEq) * 100 : 0,
    pf: gl !== 0 ? gp / Math.abs(gl) : (gp > 0 ? Infinity : 0),
    n: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
  };
}

function simulate(
  candles: Candle[],
  buildSnap: (b: CandleBuffer, price: number, ts: number) => IndicatorSnapshot,
  entry: EntryFn,
  cfg: SimCfg,
  boundaryTime: number,
): { is: SegMetrics; oos: SegMetrics } {
  const buf: CandleBuffer = { symbol: candles[0]!.symbol, closes: [], highs: [], lows: [], volumes: [] };
  let equity = cfg.initialBalance;
  let eqAtBoundary: number | null = null;
  let cooldown = 0;

  interface Pos { side: PositionSide; entry: number; qty: number; stop: number; tp: number; extreme: number; atr: number; risk: number; entryFee: number; entryTime: number }
  let pos: Pos | null = null;
  const isTrades: { pnl: number }[] = [];
  const oosTrades: { pnl: number }[] = [];

  const push = (c: Candle) => {
    buf.closes.push(c.close); buf.highs.push(c.high); buf.lows.push(c.low); buf.volumes.push(c.volume);
    if (buf.closes.length > cfg.capacity) { buf.closes.shift(); buf.highs.shift(); buf.lows.shift(); buf.volumes.shift(); }
  };

  for (const c of candles) {
    push(c);
    if (eqAtBoundary === null && c.openTime >= boundaryTime) eqAtBoundary = equity;
    if (buf.closes.length < cfg.capacity) continue;
    if (cooldown > 0) cooldown--;

    if (pos) {
      const dir = pos.side === 'LONG' ? 1 : -1;
      let exit: number | null = null;
      if (pos.side === 'LONG') {
        if (c.low <= pos.stop) exit = c.open <= pos.stop ? c.open : pos.stop;
        else if (c.high >= pos.tp) exit = c.open >= pos.tp ? c.open : pos.tp;
      } else {
        if (c.high >= pos.stop) exit = c.open >= pos.stop ? c.open : pos.stop;
        else if (c.low <= pos.tp) exit = c.open <= pos.tp ? c.open : pos.tp;
      }
      if (exit !== null) {
        const fee = pos.qty * exit * cfg.cost;
        const pnl = pos.qty * (exit - pos.entry) * dir - pos.entryFee - fee;
        equity += pnl;
        (pos.entryTime < boundaryTime ? isTrades : oosTrades).push({ pnl });
        if (pnl < 0) cooldown = cfg.cooldownBars;
        pos = null;
      } else if (cfg.useTrailing) {
        const td = cfg.trailMult * pos.atr;
        if (pos.side === 'LONG') {
          pos.extreme = Math.max(pos.extreme, c.close);
          if (pos.extreme >= pos.entry + cfg.beR * pos.risk) pos.stop = Math.max(pos.stop, pos.entry, pos.extreme - td);
        } else {
          pos.extreme = Math.min(pos.extreme, c.close);
          if (pos.extreme <= pos.entry - cfg.beR * pos.risk) pos.stop = Math.min(pos.stop, pos.entry, pos.extreme + td);
        }
      }
    }

    if (!pos && cooldown === 0) {
      const snap = buildSnap(buf, c.close, c.closeTime);
      if (snap.atr !== null && snap.atr > 0) {
        const side = entry(snap, buf);
        if (side) {
          const atr = snap.atr, dir = side === 'LONG' ? 1 : -1;
          const stopDist = cfg.useAtr ? cfg.atrSl * atr : c.close * cfg.slPct;
          const tpDist = cfg.useAtr ? cfg.atrTp * atr : c.close * cfg.tpPct;
          let alloc: number;
          if (cfg.sizingMode === 'risk') {
            const maxA = equity * cfg.maxAllocPct;
            alloc = stopDist <= 0 ? maxA : Math.min((equity * cfg.riskPct / stopDist) * c.close, maxA);
          } else if (cfg.sizingMode === 'percent') alloc = equity * cfg.tradeAllocPct;
          else alloc = Math.min(cfg.fixedUsdt, equity);
          if (alloc > 0 && equity > 0) {
            const qty = alloc / c.close;
            pos = { side, entry: c.close, qty, stop: c.close - dir * stopDist, tp: c.close + dir * tpDist, extreme: c.close, atr, risk: stopDist, entryFee: qty * c.close * cfg.cost, entryTime: c.closeTime };
          }
        }
      }
    }
  }

  const finalBoundary = eqAtBoundary ?? equity;
  return {
    is: seg(isTrades, cfg.initialBalance, finalBoundary),
    oos: seg(oosTrades, finalBoundary, equity),
  };
}

// Rolling extreme of the PRIOR n bars (excludes the current candle).
function priorHigh(buf: CandleBuffer, n: number): number | null {
  const len = buf.highs.length; if (len < n + 1) return null;
  let m = -Infinity; for (let i = len - 1 - n; i < len - 1; i++) m = Math.max(m, buf.highs[i]!); return m;
}
function priorLow(buf: CandleBuffer, n: number): number | null {
  const len = buf.lows.length; if (len < n + 1) return null;
  let m = Infinity; for (let i = len - 1 - n; i < len - 1; i++) m = Math.min(m, buf.lows[i]!); return m;
}

async function main(): Promise<void> {
  const { env } = await import('./config/env.js');
  const { buildIndicatorSnapshot } = await import('./core/indicators/snapshot.js');
  const { createSignalEngine } = await import('./core/strategy/signalEngine.js');
  const { computeBufferCapacity } = await import('./config/constants.js');

  const interval = process.argv[2] ?? '1h';
  const count = parseInt(process.argv[3] ?? '20000', 10);
  const symbol = env.SYMBOL;

  console.log(`\nFetching ${count} × ${interval} ${symbol} candles ...`);
  const candles = await fetchKlines(symbol, interval, count);
  const splitIdx = Math.floor(candles.length * 0.6);
  const boundaryTime = candles[splitIdx]!.openTime;
  const d = (t: number) => new Date(t).toISOString().slice(0, 10);
  console.log(`Range: ${d(candles[0]!.openTime)} → ${d(candles[candles.length - 1]!.closeTime)}`);
  console.log(`IN-SAMPLE : ${d(candles[0]!.openTime)} → ${d(boundaryTime)}`);
  console.log(`OUT-SAMPLE: ${d(boundaryTime)} → ${d(candles[candles.length - 1]!.closeTime)}\n`);

  const cfg: SimCfg = {
    cost: parseFloat(process.env['BACKTEST_COST'] ?? '0.0006'),
    useAtr: env.USE_ATR_RISK, atrSl: env.ATR_SL_MULT, atrTp: env.ATR_TP_MULT, slPct: env.STOP_LOSS_PCT, tpPct: env.TAKE_PROFIT_PCT,
    useTrailing: env.USE_TRAILING_STOP, trailMult: env.TRAIL_ATR_MULT, beR: env.BREAKEVEN_AT_R,
    sizingMode: env.POSITION_SIZING_MODE, riskPct: env.RISK_PER_TRADE_PCT, maxAllocPct: env.MAX_ALLOCATION_PCT,
    tradeAllocPct: env.TRADE_ALLOCATION_PCT, fixedUsdt: env.POSITION_FIXED_USDT,
    cooldownBars: env.ENTRY_COOLDOWN_BARS, initialBalance: env.INITIAL_BALANCE_USDT,
    capacity: computeBufferCapacity(env.RSI_PERIOD, env.EMA_SLOW_PERIOD),
  };

  // Baseline trend-pullback reuses the live signal engine.
  const liveEval = createSignalEngine({ rsiBuyMin: env.RSI_BUY_MIN, rsiBuyMax: env.RSI_BUY_MAX, volMaMult: env.VOL_MA_MULT, minAtrPct: env.MIN_ATR_PCT, allowLong: true, allowShort: true });
  const liveEvalLong = createSignalEngine({ rsiBuyMin: env.RSI_BUY_MIN, rsiBuyMax: env.RSI_BUY_MAX, volMaMult: env.VOL_MA_MULT, minAtrPct: env.MIN_ATR_PCT, allowLong: true, allowShort: false });

  const strategies: { name: string; entry: EntryFn }[] = [
    { name: 'A. Trend-pullback L+S (current)', entry: (s) => { const sig = liveEval(s, null); return sig && sig.type === 'ENTRY' ? sig.side : null; } },
    { name: 'B. Trend-pullback LONG-only', entry: (s) => { const sig = liveEvalLong(s, null); return sig && sig.type === 'ENTRY' ? sig.side : null; } },
    { name: 'C. Mean-reversion BB+RSI', entry: (s) => {
        if (s.rsi === null || s.bollingerBands === null || s.ema200 === null) return null;
        if (s.rsi < 30 && s.bollingerBands.percentB <= 0.05 && s.price > s.ema200) return 'LONG';
        if (s.rsi > 70 && s.bollingerBands.percentB >= 0.95 && s.price < s.ema200) return 'SHORT';
        return null;
      } },
    { name: 'D. Mean-reversion LONG-only', entry: (s) => {
        if (s.rsi === null || s.bollingerBands === null || s.ema200 === null) return null;
        if (s.rsi < 30 && s.bollingerBands.percentB <= 0.05 && s.price > s.ema200) return 'LONG';
        return null;
      } },
    { name: 'E. Donchian-20 breakout L+S', entry: (s, b) => {
        const ph = priorHigh(b, 20), pl = priorLow(b, 20);
        if (ph !== null && s.price > ph) return 'LONG';
        if (pl !== null && s.price < pl) return 'SHORT';
        return null;
      } },
    { name: 'F. Donchian-20 LONG-only', entry: (s, b) => {
        const ph = priorHigh(b, 20);
        if (ph !== null && s.price > ph && s.ema200 !== null && s.price > s.ema200) return 'LONG';
        return null;
      } },
  ];

  console.log('Strategy                          │   IN-SAMPLE          │   OUT-OF-SAMPLE');
  console.log('                                  │  ret    PF    n  win │  ret    PF    n  win');
  console.log('─'.repeat(82));
  const fmt = (m: SegMetrics) => `${(m.ret >= 0 ? '+' : '') + m.ret.toFixed(1)}%`.padStart(6) + ' ' + (m.pf === Infinity ? ' inf' : m.pf.toFixed(2)).padStart(5) + ' ' + String(m.n).padStart(3) + ' ' + (m.winRate.toFixed(0) + '%').padStart(4);

  const results: { name: string; is: SegMetrics; oos: SegMetrics }[] = [];
  for (const st of strategies) {
    const r = simulate(candles, buildIndicatorSnapshot, st.entry, cfg, boundaryTime);
    results.push({ name: st.name, ...r });
    console.log(st.name.padEnd(33) + ' │ ' + fmt(r.is) + ' │ ' + fmt(r.oos));
  }
  console.log('─'.repeat(82));

  console.log('\nVerdict (only trust strategies POSITIVE on BOTH halves with PF>1.2 and n>=25):');
  let any = false;
  for (const r of results) {
    const ok = r.is.ret > 0 && r.oos.ret > 0 && r.is.pf > 1.2 && r.oos.pf > 1.2 && r.is.n >= 25 && r.oos.n >= 25;
    if (ok) { console.log(`  ✅ ${r.name} — survives out-of-sample. Worth deeper testing.`); any = true; }
  }
  if (!any) console.log('  ❌ None survived. No candidate showed a robust edge on unseen data.');
}

main().catch((e) => { console.error(e); process.exit(1); });
