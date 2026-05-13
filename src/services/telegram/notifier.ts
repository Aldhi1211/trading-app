// src/services/telegram/notifier.ts

import type { BuySignal, SellSignal, PortfolioState, ILogger, SellReason } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Config & deps — injected, never imported from env.
// Keeps the class constructable in tests without env setup.
// ---------------------------------------------------------------------------

export interface TelegramConfig {
  botToken: string;
  chatId:   string;
}

export interface TelegramDeps {
  config: TelegramConfig;
  logger: ILogger;
  /** Injectable for tests to intercept outgoing HTTP calls. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Message template functions — pure, exported for unit testing.
//
// All messages use plain text (no parse_mode). MarkdownV2 requires escaping
// dozens of characters; HTML fails if symbol/reason contains < > &.
// Plain text renders emojis correctly and has no injection risk.
// ---------------------------------------------------------------------------

const SEP = '━━━━━━━━━━━━━━━━━━━━';

function formatUsd(amount: number): string {
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatTs(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function pnlSign(pct: number): string {
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
}

function reasonLabel(reason: SellReason): string {
  const labels: Record<SellReason, string> = {
    TAKE_PROFIT:    'Take Profit ✅',
    STOP_LOSS:      'Stop Loss ❌',
    RSI_OVERBOUGHT: 'RSI Overbought 📈',
  };
  return labels[reason];
}

export function buildStartupMessage(symbol: string, balance: number, interval: string): string {
  return [
    `🤖 Paper Trading Bot started — ${symbol}`,
    `💵 Balance  : $${formatUsd(balance)}`,
    `⏱ Interval  : ${interval}`,
    SEP,
  ].join('\n');
}

export function buildReconnectMessage(symbol: string, attempt: number): string {
  return `🔄 Reconnected to ${symbol} stream (attempt ${attempt})`;
}

export function buildBuyMessage(signal: BuySignal): string {
  return [
    `🟢 FAKE BUY — ${signal.symbol}`,
    `📈 Entry  : $${formatUsd(signal.price)}`,
    `🕐 Time   : ${formatTs(signal.timestamp)}`,
    `📊 RSI    : ${signal.rsi.toFixed(2)}`,
    SEP,
  ].join('\n');
}

export function buildSellMessage(
  signal: SellSignal,
  pnlPercent: number,
  pnlUsdt: number,
): string {
  const lines = [
    `🔴 FAKE SELL — ${signal.symbol}`,
    `📉 Exit   : $${formatUsd(signal.price)}`,
    `💰 PnL    : ${pnlSign(pnlPercent)} ($${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(2)})`,
    `📋 Reason : ${reasonLabel(signal.reason)}`,
  ];

  // Show RSI only when it caused the exit — meaningless to show it on TP/SL.
  if (signal.reason === 'RSI_OVERBOUGHT' && signal.rsi !== null) {
    lines.push(`📊 RSI    : ${signal.rsi.toFixed(2)}`);
  }

  lines.push(SEP);
  return lines.join('\n');
}

export function buildPortfolioSummary(state: PortfolioState): string {
  const winRate =
    state.totalTrades > 0
      ? ((state.winningTrades / state.totalTrades) * 100).toFixed(1) + '%'
      : 'n/a';

  const pnlColor = state.totalPnlUsdt >= 0 ? '📈' : '📉';

  return [
    `📊 Portfolio Summary`,
    `💵 Balance   : $${formatUsd(state.balance)}`,
    `${pnlColor} Total PnL : ${pnlSign(state.totalPnlPercent)} ($${state.totalPnlUsdt.toFixed(2)})`,
    `🏆 Win Rate  : ${winRate} (${state.winningTrades}/${state.totalTrades} trades)`,
    SEP,
  ].join('\n');
}

export function buildErrorMessage(context: string, detail: string): string {
  return [`⚠️ Bot Error — ${context}`, detail, SEP].join('\n');
}

export function buildShutdownMessage(symbol: string, state: PortfolioState): string {
  return [
    `🛑 Bot shutting down — ${symbol}`,
    buildPortfolioSummary(state),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// TelegramNotifier
//
// Responsibilities:
//   1. Send formatted messages to a Telegram chat via Bot API.
//   2. Retry automatically on HTTP 429 (rate-limit) using the Retry-After
//      header, up to MAX_RETRIES times.
//   3. Log but never throw on API failures — notifications are best-effort.
//      A failed notification must never interrupt the trading pipeline.
// ---------------------------------------------------------------------------

const MAX_RETRIES   = 2;
const MAX_RETRY_DELAY_MS = 30_000;

export class TelegramNotifier {
  private readonly apiUrl: string;
  private readonly chatId: string;
  private readonly logger: ILogger;
  private readonly fetch: typeof globalThis.fetch;

  constructor(deps: TelegramDeps) {
    this.apiUrl  = `https://api.telegram.org/bot${deps.config.botToken}/sendMessage`;
    this.chatId  = deps.config.chatId;
    this.logger  = deps.logger;
    this.fetch   = deps.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ── High-level notification methods ────────────────────────────────────────

  async notifyStartup(symbol: string, balance: number, interval: string): Promise<void> {
    await this.send(buildStartupMessage(symbol, balance, interval));
  }

  async notifyReconnect(symbol: string, attempt: number): Promise<void> {
    await this.send(buildReconnectMessage(symbol, attempt));
  }

  async notifyBuy(signal: BuySignal): Promise<void> {
    await this.send(buildBuyMessage(signal));
  }

  async notifySell(signal: SellSignal, pnlPercent: number, pnlUsdt: number): Promise<void> {
    await this.send(buildSellMessage(signal, pnlPercent, pnlUsdt));
  }

  async notifyPortfolioSummary(state: PortfolioState): Promise<void> {
    await this.send(buildPortfolioSummary(state));
  }

  async notifyError(context: string, detail: string): Promise<void> {
    await this.send(buildErrorMessage(context, detail));
  }

  async notifyShutdown(symbol: string, state: PortfolioState): Promise<void> {
    await this.send(buildShutdownMessage(symbol, state));
  }

  /** Low-level escape hatch — send any arbitrary text. */
  async send(text: string): Promise<void> {
    await this.sendWithRetry(text, 0);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async sendWithRetry(text: string, attempt: number): Promise<void> {
    let response: Response;

    try {
      response = await this.fetch(this.apiUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: this.chatId, text }),
      });
    } catch (err) {
      // Network-level failure (DNS, connection refused, timeout).
      this.logger.error(
        { err, attempt },
        'Telegram: network error sending message',
      );
      return;
    }

    if (response.ok) return;

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const retryAfterSec = parseInt(
        response.headers.get('retry-after') ?? '5',
        10,
      );
      const delayMs = Math.min(retryAfterSec * 1000, MAX_RETRY_DELAY_MS);

      this.logger.warn(
        { attempt: attempt + 1, delayMs },
        'Telegram: rate-limited, retrying',
      );

      await sleep(delayMs);
      return this.sendWithRetry(text, attempt + 1);
    }

    // Any non-429 error, or 429 after max retries: log and give up.
    const body = await response.text().catch(() => '');
    this.logger.error(
      { status: response.status, body: body.slice(0, 200) },
      'Telegram: API error sending message',
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
