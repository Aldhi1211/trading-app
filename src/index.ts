// src/index.ts

import { createServer } from 'http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { BinanceStream } from './core/websocket/binanceStream.js';
import { fetchHistoricalCandles } from './core/websocket/historicalLoader.js';
import { buildIndicatorSnapshot } from './core/indicators/snapshot.js';
import { createSignalEngine } from './core/strategy/signalEngine.js';
import { PositionManager, computeRestoredBalance } from './core/portfolio/positionManager.js';
import type { SizingMode } from './core/portfolio/positionManager.js';
import { TradeRepository } from './services/database/repository.js';
import { TelegramNotifier } from './services/telegram/notifier.js';

// ---------------------------------------------------------------------------
// Composition root
//
// Responsibilities of main():
//   1. Validate and load all configuration (via env, already validated by zod).
//   2. Construct all dependencies in the right order (DB → portfolio → stream).
//   3. Wire event listeners.
//   4. Register the error boundary (uncaughtException + unhandledRejection).
//   5. Register graceful shutdown handlers (SIGINT, SIGTERM).
//   6. Start the stream and send the startup notification.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info(
    { symbol: env.SYMBOL, interval: env.INTERVAL, balance: env.INITIAL_BALANCE_USDT },
    'Paper Trading Bot starting',
  );

  // ── 1. Database ────────────────────────────────────────────────────────────
  const repo = new TradeRepository();

  // ── 2. Restore portfolio state from DB (crash / restart recovery) ──────────
  const { totalPnlUsdt, totalTrades, winningTrades } = repo.getTotalPnl(env.SYMBOL);
  const openPosition    = repo.getOpenPosition();
  const restoredBalance = computeRestoredBalance(
    env.INITIAL_BALANCE_USDT,
    totalPnlUsdt,
    openPosition,
  );

  // ── 3. Construct services ──────────────────────────────────────────────────
  const telegram = new TelegramNotifier({
    config: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId:   env.TELEGRAM_CHAT_ID,
    },
    logger,
  });

  const sizing: SizingMode =
    env.POSITION_SIZING_MODE === 'fixed'
      ? { mode: 'fixed',   amountUsdt: env.POSITION_FIXED_USDT }
      : env.POSITION_SIZING_MODE === 'percent'
        ? { mode: 'percent', fraction: env.TRADE_ALLOCATION_PCT }
        : { mode: 'risk', riskPerTradePct: env.RISK_PER_TRADE_PCT, maxAllocationPct: env.MAX_ALLOCATION_PCT };

  const portfolio = new PositionManager(
    {
      initialBalance: env.INITIAL_BALANCE_USDT,
      sizing,
      risk: {
        useAtrRisk:    env.USE_ATR_RISK,
        atrSlMult:     env.ATR_SL_MULT,
        atrTpMult:     env.ATR_TP_MULT,
        useTrailing:   env.USE_TRAILING_STOP,
        trailAtrMult:  env.TRAIL_ATR_MULT,
        breakevenAtR:  env.BREAKEVEN_AT_R,
        takeProfitPct: env.TAKE_PROFIT_PCT,
        stopLossPct:   env.STOP_LOSS_PCT,
      },
    },
    { repo, logger },
    { balance: restoredBalance, openPosition, totalTrades, winningTrades, totalPnlUsdt },
  );

  const evaluate = createSignalEngine({
    rsiBuyMin:  env.RSI_BUY_MIN,
    rsiBuyMax:  env.RSI_BUY_MAX,
    volMaMult:  env.VOL_MA_MULT,
    minAtrPct:  env.MIN_ATR_PCT,
    allowLong:  env.ALLOW_LONG,
    allowShort: env.ALLOW_SHORT,
  });

  // Cooldown counter: after a losing trade, suppress new entries for
  // ENTRY_COOLDOWN_BARS closed candles to avoid revenge-trading the same chop.
  let cooldownRemaining = 0;

  const stream = new BinanceStream(env.SYMBOL, env.INTERVAL);

  // ── 4. Graceful shutdown ───────────────────────────────────────────────────
  // isShuttingDown prevents re-entrant shutdown if multiple signals arrive
  // or if the stream fires an error after SIGTERM has been received.
  let isShuttingDown = false;

  async function shutdown(trigger: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ trigger }, 'Shutdown initiated');
    stream.stop();

    const state = portfolio.getState();
    await telegram.notifyShutdown(env.SYMBOL, state);

    repo.savePortfolioSnapshot(state);
    repo.close();

    logger.info({ trigger }, 'Shutdown complete');
    process.exit(0);
  }

  // Synchronous signals: launch the async shutdown but don't await —
  // Node signal handlers cannot be async. Errors surface via unhandledRejection.
  process.on('SIGINT',  () => { shutdown('SIGINT').catch(finalFallback); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(finalFallback); });

  // ── 5. Error boundary ──────────────────────────────────────────────────────
  // Covers both synchronous throws that escape the event loop and promises
  // that were rejected without a .catch() handler.
  //
  // These handlers exist as a last resort — individual pipeline steps have
  // their own try/catch. If something reaches here it is genuinely unexpected.

  process.on('uncaughtException', (err: Error) => {
    logger.fatal({ err }, 'Uncaught exception — initiating emergency shutdown');
    telegram
      .notifyError('Uncaught Exception', err.message)
      .finally(() => shutdown('uncaughtException').catch(finalFallback));
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.fatal({ reason }, 'Unhandled promise rejection — initiating emergency shutdown');
    telegram
      .notifyError('Unhandled Rejection', message)
      .finally(() => shutdown('unhandledRejection').catch(finalFallback));
  });

  // ── 6. WebSocket event handlers ────────────────────────────────────────────

  // `connected` fires on every (re)connection — use for "reconnected" messages,
  // not for the initial startup message (which is sent once below after start()).
  let isFirstConnection = true;

  stream.on('connected', async () => {
    if (isFirstConnection) {
      // Suppress; startup message is sent explicitly after stream.start().
      isFirstConnection = false;
      return;
    }
    // Subsequent connections are reconnections.
    logger.info('WebSocket reconnected');
    await telegram.notifyReconnect(env.SYMBOL, 1);
  });

  stream.on('disconnected', (attempt, delayMs) => {
    logger.warn({ attempt, delayMs }, 'WebSocket disconnected — retry scheduled');
  });

  stream.on('error', async (err) => {
    logger.error({ err }, 'WebSocket error');
    await telegram.notifyError('WebSocket Error', err.message);
  });

  stream.on('max-retries-reached', () => {
    logger.fatal('WebSocket max retries exhausted — shutting down');
    telegram
      .notifyError('WebSocket Disconnected', 'Max reconnection attempts reached.')
      .finally(() => shutdown('max-retries-reached').catch(finalFallback));
  });

  // ── 7. Core trading pipeline ───────────────────────────────────────────────
  //
  // Each candle:closed event runs: buffer → indicators → strategy → portfolio
  // → telegram notification. The try/catch prevents one bad tick from crashing
  // the process — errors are logged and the next candle is still processed.

  stream.on('candle:closed', async (candle, buffer) => {
    if (!stream.isReady()) {
      logger.debug(
        { buffered: stream.getBufferSize() },
        'Warming up indicator buffer',
      );
      return;
    }

    try {
      if (cooldownRemaining > 0) cooldownRemaining -= 1;

      const snapshot = buildIndicatorSnapshot(buffer, candle.close, candle.closeTime);

      // Advance the trailing stop BEFORE reading state, so the exit evaluation
      // sees the freshly-ratcheted stop level for this candle.
      if (portfolio.getState().openPosition !== null) {
        portfolio.updateTrailing(candle.close);
      }

      const state  = portfolio.getState();
      const signal = evaluate(snapshot, state.openPosition);

      logger.info({
        price:   candle.close,
        rsi:     snapshot.rsi?.toFixed(2),
        ema20:   snapshot.emaFast?.toFixed(2),
        ema50:   snapshot.emaSlow?.toFixed(2),
        ema200:  snapshot.ema200?.toFixed(2),
        side:    state.openPosition?.side,
        stop:    state.openPosition?.stopPrice.toFixed(2),
        signal:  signal ? (signal.type === 'ENTRY' ? `ENTRY ${signal.side}` : 'EXIT') : 'none',
        cooldown: cooldownRemaining,
      }, 'Candle snapshot');

      if (!signal) return;

      if (signal.type === 'ENTRY') {
        if (cooldownRemaining > 0) {
          logger.info({ cooldownRemaining, side: signal.side }, 'ENTRY signal suppressed — in post-loss cooldown');
          return;
        }
        const position = portfolio.openPosition(signal);
        if (position) {
          await telegram.notifyEntry(signal);
        }
      } else {
        const trade = portfolio.closePosition(signal);
        if (trade) {
          // Arm the cooldown only after a losing exit.
          if (trade.pnlUsdt < 0) cooldownRemaining = env.ENTRY_COOLDOWN_BARS;
          await telegram.notifyExit(signal, trade.pnlPercent, trade.pnlUsdt);
        }
      }
    } catch (err) {
      logger.error({ err, symbol: candle.symbol }, 'Pipeline error on candle:closed');
    }
  });

  // ── 8. Health check server (required for Render free tier) ────────────────
  const port = process.env['PORT'] ?? 3000;
  createServer((_, res) => { res.writeHead(200); res.end('OK'); }).listen(port);

  // ── 9. Periodic 6-hour report ──────────────────────────────────────────────
  const REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;
  setInterval(async () => {
    const sinceMs = Date.now() - REPORT_INTERVAL_MS;
    const stats   = repo.getTradesSince(sinceMs);
    const state   = portfolio.getState();
    await telegram.notifyPeriodicReport(env.SYMBOL, 6, stats, state);
  }, REPORT_INTERVAL_MS);

  // ── 10. Prefill buffer with historical candles ─────────────────────────────
  try {
    const historical = await fetchHistoricalCandles(env.SYMBOL, env.INTERVAL, stream.getBufferCapacity());
    stream.prefill(historical);
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch historical candles — warming up from live data');
  }

  // ── 10. Start ──────────────────────────────────────────────────────────────
  stream.start();

  // Send the startup message exactly once, after the stream is started but
  // before the first candle arrives. If the network is down at startup,
  // this will be retried per the notifier's retry logic and logged on failure.
  const state = portfolio.getState();
  await telegram.notifyStartup(env.SYMBOL, state.balance, env.INTERVAL);

  logger.info(
    {
      symbol:    env.SYMBOL,
      interval:  env.INTERVAL,
      balance:   state.balance.toFixed(2),
      openPos:   openPosition !== null,
      prevTrades: totalTrades,
    },
    'Bot running — waiting for candles',
  );
}

// Last-resort sync error handler — avoids infinite loops in error reporting.
function finalFallback(err: unknown): void {
  console.error('Fatal error during shutdown:', err);
  process.exit(1);
}

main().catch(finalFallback);
