import { Socket } from 'node:net';

import type { Clock } from '../../../../shared-kernel/clock.ts';
import { TokenBucket } from './rate-limiter.ts';
import {
  ClientQueryError,
  ERROR_ID_OK,
  isErrorLine,
  isNotificationLine,
  parseError,
  parseNotification,
  parseResponse,
  serialize,
  type ParsedNotification,
  type ParsedResponse,
  type SerializeOptions,
} from './protocol.ts';

export type ConnectionPhase = 'idle' | 'connecting' | 'ready' | 'closed';

export interface ClientQueryLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface ClientQueryConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly apiKey: string;
  readonly clock: Clock;
  readonly logger: ClientQueryLogger;
  /** Runs after every successful (re)connect — re-register notifications here. */
  readonly onReady?: () => Promise<void>;
  readonly onNotification?: (notification: ParsedNotification) => void;
  readonly onPhaseChange?: (phase: ConnectionPhase, error: Error | undefined) => void;
}

interface PendingRequest {
  readonly command: string;
  readonly line: string;
  readonly resolve: (response: ParsedResponse) => void;
  readonly reject: (error: Error) => void;
  readonly payloadLines: string[];
}

const CONNECT_TIMEOUT_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const KEEPALIVE_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** The server's own anti-flood still applies to whatever the bot says out loud. */
const CHAT_BURST = 3;
const CHAT_REFILL_INTERVAL_MS = 600;

/**
 * A single ClientQuery socket, owned by exactly one bot instance.
 *
 * Three things make this harder than a plain request/response client, and each is handled
 * explicitly below:
 *
 *  1. **The protocol is strictly serial.** One command may be in flight at a time; the reply
 *     is every line up to the terminating `error id=…`. Requests are therefore queued rather
 *     than multiplexed.
 *  2. **Notifications interleave.** A `notify*` line can arrive in the middle of a pending
 *     response and must be routed out-of-band, never appended to the response buffer.
 *  3. **The socket can wedge without closing.** It lives inside a GUI application; a hung
 *     plugin leaves a TCP connection that accepts writes and never answers. Only an
 *     application-level keepalive detects that.
 */
export class ClientQueryConnection {
  readonly #options: ClientQueryConnectionOptions;
  readonly #chatLimiter: TokenBucket;

  #socket: Socket | undefined;
  #phase: ConnectionPhase = 'idle';
  #receiveBuffer = '';
  #queue: PendingRequest[] = [];
  #inFlight: PendingRequest | undefined;
  #requestTimer: NodeJS.Timeout | undefined;
  #keepAliveTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #reconnectAttempt = 0;
  #shuttingDown = false;

  constructor(options: ClientQueryConnectionOptions) {
    this.#options = options;
    this.#chatLimiter = new TokenBucket({
      capacity: CHAT_BURST,
      refillIntervalMs: CHAT_REFILL_INTERVAL_MS,
      clock: options.clock,
    });
  }

  get phase(): ConnectionPhase {
    return this.#phase;
  }

  get isReady(): boolean {
    return this.#phase === 'ready';
  }

  connect(): void {
    if (this.#phase === 'connecting' || this.#phase === 'ready') return;
    this.#shuttingDown = false;
    this.#openSocket();
  }

  async close(): Promise<void> {
    this.#shuttingDown = true;
    this.#clearTimers();
    this.#failAllPending(new Error('ClientQuery connection closed'));

    const socket = this.#socket;
    this.#socket = undefined;
    this.#setPhase('closed', undefined);

    if (socket === undefined) return;
    await new Promise<void>((resolve) => {
      socket.end(() => {
        socket.destroy();
        resolve();
      });
    });
  }

  /**
   * Sends a command and resolves with its response. Rejects with `ClientQueryError` when the
   * client answers with a non-zero error id — a refusal is a real outcome the caller must
   * handle, not a transport fault.
   */
  send(command: string, options: SerializeOptions = {}): Promise<ParsedResponse> {
    const line = serialize(command, options);
    return new Promise<ParsedResponse>((resolve, reject) => {
      this.#queue.push({ command, line, resolve, reject, payloadLines: [] });
      this.#pump();
    });
  }

  /**
   * Sends a command that is paced by the chat token bucket. Used for anything the bot says
   * out loud, so a burst of chat commands cannot get it kicked for flooding.
   */
  async sendPaced(command: string, options: SerializeOptions = {}): Promise<ParsedResponse> {
    for (;;) {
      if (this.#chatLimiter.tryConsume()) break;
      await delay(this.#chatLimiter.delayUntilAvailableMs());
    }
    return this.send(command, options);
  }

  // ─── socket lifecycle ─────────────────────────────────────────────────────

  #openSocket(): void {
    this.#setPhase('connecting', undefined);

    const socket = new Socket();
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      socket.setTimeout(0);
      void this.#bootstrap();
    });
    socket.on('data', (chunk: string) => this.#onData(chunk));
    socket.once('timeout', () => {
      socket.destroy(new Error(`ClientQuery connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
    });
    socket.once('error', (error: Error) => this.#onSocketFailure(error));
    socket.once('close', () => this.#onSocketFailure(new Error('ClientQuery socket closed')));

    socket.connect({ host: this.#options.host, port: this.#options.port });
  }

  async #bootstrap(): Promise<void> {
    try {
      // The banner arrives unsolicited; `auth` must be the first command regardless.
      await this.send('auth', { params: { apikey: this.#options.apiKey } });

      this.#reconnectAttempt = 0;
      this.#setPhase('ready', undefined);
      this.#startKeepAlive();

      await this.#options.onReady?.();
      this.#options.logger.info('ClientQuery ready', {
        host: this.#options.host,
        port: this.#options.port,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#options.logger.error('ClientQuery bootstrap failed', { reason: failure.message });
      this.#socket?.destroy(failure);
    }
  }

  #onSocketFailure(error: Error): void {
    if (this.#phase === 'closed') return;

    this.#clearTimers();
    this.#socket?.removeAllListeners();
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#receiveBuffer = '';
    this.#failAllPending(error);
    this.#setPhase('idle', error);

    if (this.#shuttingDown) return;
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== undefined) return;

    const delayMs = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_MIN_DELAY_MS * 2 ** this.#reconnectAttempt,
    );
    this.#reconnectAttempt += 1;
    this.#options.logger.warn('ClientQuery reconnecting', {
      attempt: this.#reconnectAttempt,
      delayMs,
    });

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#openSocket();
    }, delayMs);
    this.#reconnectTimer.unref?.();
  }

  // ─── line handling ────────────────────────────────────────────────────────

  #onData(chunk: string): void {
    this.#receiveBuffer += chunk;

    let newlineIndex = this.#receiveBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.#receiveBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.#receiveBuffer = this.#receiveBuffer.slice(newlineIndex + 1);
      if (line.length > 0) this.#onLine(line);
      newlineIndex = this.#receiveBuffer.indexOf('\n');
    }
  }

  #onLine(line: string): void {
    // Out-of-band first: a notification must never land in a pending response buffer.
    if (isNotificationLine(line)) {
      const notification = parseNotification(line);
      if (notification !== undefined) this.#options.onNotification?.(notification);
      return;
    }

    const pending = this.#inFlight;
    if (pending === undefined) {
      // The welcome banner and anything else unsolicited.
      this.#options.logger.debug('ClientQuery unsolicited line', { line });
      return;
    }

    if (!isErrorLine(line)) {
      pending.payloadLines.push(line);
      return;
    }

    const error = parseError(line);
    this.#completeInFlight(pending, error);
  }

  #completeInFlight(pending: PendingRequest, error: ReturnType<typeof parseError>): void {
    this.#inFlight = undefined;
    this.#clearRequestTimer();

    if (error !== undefined && error.id !== ERROR_ID_OK) {
      pending.reject(new ClientQueryError(error.id, error.message, pending.command));
    } else {
      pending.resolve(parseResponse(pending.payloadLines.join('|')));
    }

    this.#pump();
  }

  #pump(): void {
    if (this.#inFlight !== undefined) return;
    if (this.#socket === undefined || this.#socket.destroyed) return;
    // `auth` has to go out before the connection counts as ready, so it bypasses the gate.
    if (this.#phase !== 'ready' && this.#queue[0]?.command !== 'auth') return;

    const next = this.#queue.shift();
    if (next === undefined) return;

    this.#inFlight = next;
    this.#requestTimer = setTimeout(() => {
      this.#options.logger.warn('ClientQuery request timed out', { command: next.command });
      this.#socket?.destroy(new Error(`ClientQuery request '${next.command}' timed out`));
    }, REQUEST_TIMEOUT_MS);
    this.#requestTimer.unref?.();

    this.#socket.write(`${next.line}\n`, (writeError) => {
      if (writeError) this.#onSocketFailure(writeError);
    });
  }

  // ─── keepalive ────────────────────────────────────────────────────────────

  /**
   * A hung ClientQuery plugin keeps the TCP connection open while answering nothing. Polling
   * `whoami` is the only way to notice, and destroying the socket on silence lets the normal
   * reconnect path recover it.
   */
  #startKeepAlive(): void {
    this.#clearKeepAlive();
    this.#keepAliveTimer = setInterval(() => {
      const probe = this.send('whoami');
      const timeout = delay(KEEPALIVE_TIMEOUT_MS).then(() => {
        throw new Error('ClientQuery keepalive timed out');
      });

      void Promise.race([probe, timeout]).catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        // A ClientQueryError still proves the socket is alive and answering.
        if (failure instanceof ClientQueryError) return;
        this.#options.logger.warn('ClientQuery keepalive failed', { reason: failure.message });
        this.#socket?.destroy(failure);
      });
    }, KEEPALIVE_INTERVAL_MS);
    this.#keepAliveTimer.unref?.();
  }

  // ─── teardown helpers ─────────────────────────────────────────────────────

  #failAllPending(error: Error): void {
    const inFlight = this.#inFlight;
    this.#inFlight = undefined;
    inFlight?.reject(error);

    const queued = this.#queue;
    this.#queue = [];
    for (const request of queued) request.reject(error);
  }

  #clearTimers(): void {
    this.#clearRequestTimer();
    this.#clearKeepAlive();
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
  }

  #clearRequestTimer(): void {
    if (this.#requestTimer !== undefined) {
      clearTimeout(this.#requestTimer);
      this.#requestTimer = undefined;
    }
  }

  #clearKeepAlive(): void {
    if (this.#keepAliveTimer !== undefined) {
      clearInterval(this.#keepAliveTimer);
      this.#keepAliveTimer = undefined;
    }
  }

  #setPhase(phase: ConnectionPhase, error: Error | undefined): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.#options.onPhaseChange?.(phase, error);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
