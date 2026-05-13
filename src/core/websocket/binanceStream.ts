// src/core/websocket/binanceStream.ts

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  BINANCE_WS_BASE,
  WS_RECONNECT_INITIAL_DELAY_MS,
  WS_RECONNECT_MAX_DELAY_MS,
  WS_RECONNECT_BACKOFF_FACTOR,
  WS_MAX_RETRIES,
  computeBufferCapacity,
} from '../../config/constants.js';
import type { Candle, CandleBuffer } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Binance kline WebSocket message shape
// All price/volume fields arrive as strings — we parse them at the boundary.
// ---------------------------------------------------------------------------

interface BinanceKlinePayload {
  e: 'kline';
  E: number;   // event time (ms)
  s: string;   // symbol
  k: {
    t: number;    // candle open time (ms)
    T: number;    // candle close time (ms)
    s: string;    // symbol
    i: string;    // interval ("1m", "5m", ...)
    o: string;    // open price (string)
    h: string;    // high price (string)
    l: string;    // low price (string)
    c: string;    // close price (string)
    v: string;    // base asset volume (string)
    x: boolean;   // true only on the FINAL tick of a completed candle
    n: number;    // number of trades
  };
}

// ---------------------------------------------------------------------------
// Typed event map — all four EventEmitter methods (on/once/off/emit) are
// overloaded against this map so callers get autocomplete and compile-time
// argument checking with no runtime cost.
// ---------------------------------------------------------------------------

type BinanceStreamEventMap = {
  /** Fires once per completed candle (k.x === true). Buffer is already updated. */
  'candle:closed': [candle: Candle, buffer: Readonly<CandleBuffer>];
  /** Fires on successful (re)connection. retry count is reset to 0 at this point. */
  connected: [];
  /** Fires when the socket closes and a retry is scheduled. */
  disconnected: [attempt: number, delayMs: number];
  /** Fires when WS_MAX_RETRIES is exhausted. No further reconnects will occur. */
  'max-retries-reached': [];
  error: [err: Error];
};

// Module-augmentation pattern: overload the four EventEmitter methods against
// the concrete event map. The class itself still works via the base EventEmitter
// at runtime; this purely adds compile-time safety.
export declare interface BinanceStream {
  on<K extends keyof BinanceStreamEventMap>(
    event: K,
    listener: (...args: BinanceStreamEventMap[K]) => void,
  ): this;
  once<K extends keyof BinanceStreamEventMap>(
    event: K,
    listener: (...args: BinanceStreamEventMap[K]) => void,
  ): this;
  off<K extends keyof BinanceStreamEventMap>(
    event: K,
    listener: (...args: BinanceStreamEventMap[K]) => void,
  ): this;
  emit<K extends keyof BinanceStreamEventMap>(
    event: K,
    ...args: BinanceStreamEventMap[K]
  ): boolean;
}

// ---------------------------------------------------------------------------
// BinanceStream
//
// Responsibilities:
//   1. Maintain a WebSocket connection to Binance kline stream.
//   2. Emit `candle:closed` ONLY for confirmed closed candles (k.x === true),
//      with the current buffer already appended — no filtering in callers.
//   3. Retry on disconnect with exponential backoff, stopping after MAX_RETRIES.
//   4. Own the rolling candle buffer (capacity = max indicator period + 10).
// ---------------------------------------------------------------------------

export class BinanceStream extends EventEmitter {
  private readonly streamUrl: string;
  private readonly bufferCapacity: number;
  private readonly minCandlesRequired: number;

  private ws: WebSocket | null = null;
  private retryCount = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  private readonly buffer: CandleBuffer;

  constructor(
    private readonly symbol: string,
    private readonly interval: string,
  ) {
    super();

    const streamName = `${symbol.toLowerCase()}@kline_${interval}`;
    this.streamUrl = `${BINANCE_WS_BASE}/${streamName}`;

    // Buffer capacity derived from indicator periods — not a hardcoded constant.
    this.bufferCapacity = computeBufferCapacity(env.RSI_PERIOD, env.EMA_SLOW_PERIOD);
    // "Ready" when enough closed candles have accumulated for ALL indicators to
    // produce valid outputs (capacity minus the +10 safety margin).
    this.minCandlesRequired = this.bufferCapacity - 10;

    this.buffer = { symbol, closes: [], highs: [], lows: [], volumes: [] };

    logger.debug(
      { bufferCapacity: this.bufferCapacity, minCandlesRequired: this.minCandlesRequired },
      'BinanceStream buffer sizes computed',
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearRetryTimer();
    this.terminateSocket();
    logger.info('BinanceStream stopped');
  }

  isReady(): boolean {
    return this.buffer.closes.length >= this.minCandlesRequired;
  }

  getBuffer(): Readonly<CandleBuffer> {
    return this.buffer;
  }

  getBufferSize(): number {
    return this.buffer.closes.length;
  }

  // ── Connection lifecycle ────────────────────────────────────────────────────

  private connect(): void {
    logger.info(
      { url: this.streamUrl, attempt: this.retryCount + 1, maxRetries: WS_MAX_RETRIES },
      'Connecting to Binance WebSocket',
    );

    this.ws = new WebSocket(this.streamUrl);

    this.ws.on('open', this.handleOpen.bind(this));
    this.ws.on('message', this.handleMessage.bind(this));
    this.ws.on('error', this.handleError.bind(this));
    this.ws.on('close', this.handleClose.bind(this));
  }

  private handleOpen(): void {
    // Reset retry state on successful connection.
    this.retryCount = 0;
    logger.info({ symbol: this.symbol, interval: this.interval }, 'WebSocket connected');
    this.emit('connected');
  }

  private handleMessage(raw: WebSocket.Data): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      logger.warn('Received non-JSON WebSocket frame — ignoring');
      return;
    }

    if (!isBinanceKlinePayload(msg)) return;

    const k = msg.k;
    const candle: Candle = {
      symbol:    k.s,
      interval:  k.i,
      openTime:  k.t,
      closeTime: k.T,
      open:      parseFloat(k.o),
      high:      parseFloat(k.h),
      low:       parseFloat(k.l),
      close:     parseFloat(k.c),
      volume:    parseFloat(k.v),
      isClosed:  k.x,
    };

    // Only emit for confirmed closed candles. Live ticks are intentionally
    // discarded here — the strategy engine works on completed OHLCV candles.
    if (!candle.isClosed) return;

    this.pushToBuffer(candle);
    this.emit('candle:closed', candle, this.buffer);

    logger.debug(
      { close: candle.close, bufferSize: this.buffer.closes.length, ready: this.isReady() },
      'Candle closed',
    );
  }

  private handleError(err: Error): void {
    logger.error({ err }, 'WebSocket error');
    this.emit('error', err);
    // The `close` event always follows an `error` event for ws sockets,
    // so we let handleClose drive the reconnect logic — no double-scheduling.
  }

  private handleClose(code: number, reason: Buffer): void {
    const reasonStr = reason.toString() || 'no reason given';
    logger.warn({ code, reason: reasonStr, retryCount: this.retryCount }, 'WebSocket closed');
    this.ws = null;

    if (this.stopped) return;
    this.scheduleRetry();
  }

  // ── Reconnect with exponential backoff ─────────────────────────────────────

  private scheduleRetry(): void {
    if (this.retryCount >= WS_MAX_RETRIES) {
      logger.error({ maxRetries: WS_MAX_RETRIES }, 'Max WebSocket retries reached — giving up');
      this.emit('max-retries-reached');
      return;
    }

    // Delay grows as 2^attempt: 1s → 2s → 4s → 8s → 16s, capped at MAX_DELAY.
    const delayMs = Math.min(
      WS_RECONNECT_INITIAL_DELAY_MS * Math.pow(WS_RECONNECT_BACKOFF_FACTOR, this.retryCount),
      WS_RECONNECT_MAX_DELAY_MS,
    );

    this.retryCount += 1;

    logger.info(
      { attempt: this.retryCount, delayMs, maxRetries: WS_MAX_RETRIES },
      'Scheduling WebSocket reconnect',
    );

    this.emit('disconnected', this.retryCount, delayMs);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delayMs);
  }

  // ── Buffer management ───────────────────────────────────────────────────────

  private pushToBuffer(candle: Candle): void {
    this.buffer.closes.push(candle.close);
    this.buffer.highs.push(candle.high);
    this.buffer.lows.push(candle.low);
    this.buffer.volumes.push(candle.volume);

    // Rolling window: drop the oldest entry once capacity is reached.
    if (this.buffer.closes.length > this.bufferCapacity) {
      this.buffer.closes.shift();
      this.buffer.highs.shift();
      this.buffer.lows.shift();
      this.buffer.volumes.shift();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private terminateSocket(): void {
    if (this.ws !== null) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Type guard — validates that an unknown JSON value is a Binance kline message.
// Avoids casting with `as` and gives the compiler a narrowed type inside the
// `handleMessage` path.
// ---------------------------------------------------------------------------

function isBinanceKlinePayload(value: unknown): value is BinanceKlinePayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj['e'] !== 'kline') return false;
  if (typeof obj['k'] !== 'object' || obj['k'] === null) return false;
  const k = obj['k'] as Record<string, unknown>;
  return (
    typeof k['c'] === 'string' &&
    typeof k['x'] === 'boolean' &&
    typeof k['t'] === 'number'
  );
}
