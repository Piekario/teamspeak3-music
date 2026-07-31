import { randomUUID } from 'node:crypto';

import { err, ok, type Result } from '../../../../shared-kernel/result.ts';

/**
 * The single control connection to the TSLib gateway.
 *
 * One socket serves every bot, because the gateway holds them all in one process — that is
 * the whole point of the transport change. Requests are correlated by id rather than
 * serialised the way ClientQuery forced: the gateway is a real server and handles
 * concurrent commands, so a slow `listChannels` for one bot no longer blocks a `!play` for
 * another.
 */

export interface GatewayLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface GatewayEvent {
  readonly type: string;
  readonly botId: string;
  readonly payload: unknown;
}

export type GatewayEventListener = (event: GatewayEvent) => void;

export type GatewayError =
  | { readonly kind: 'gateway/not-connected' }
  | { readonly kind: 'gateway/timeout'; readonly command: string }
  | { readonly kind: 'gateway/refused'; readonly command: string; readonly detail: string };

interface PendingRequest {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: GatewayError) => void;
  readonly timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export interface GatewayConnectionOptions {
  /** e.g. `ws://ts3-gateway:8080/control` */
  readonly url: string;
  readonly logger: GatewayLogger;
  /** Runs after every successful (re)connect, to recreate the bots the gateway lost. */
  readonly onReady?: () => Promise<void>;
}

export class GatewayConnection {
  readonly #options: GatewayConnectionOptions;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<GatewayEventListener>();

  #socket: WebSocket | undefined;
  #reconnectAttempt = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #shuttingDown = false;

  constructor(options: GatewayConnectionOptions) {
    this.#options = options;
  }

  get isReady(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.#socket !== undefined) return;
    this.#shuttingDown = false;
    this.#open();
  }

  onEvent(listener: GatewayEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#failAllPending({ kind: 'gateway/not-connected' });
    this.#socket?.close();
    this.#socket = undefined;
  }

  /**
   * Sends a command and resolves with its result. A refusal from the gateway — an unknown
   * bot, a TeamSpeak permission error — comes back as an `Err`, not a thrown exception:
   * these are outcomes the caller has to handle, not faults.
   */
  send<T>(command: string, botId?: string, payload?: unknown): Promise<Result<T, GatewayError>> {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve(err({ kind: 'gateway/not-connected' }));
    }

    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve(err({ kind: 'gateway/timeout', command }));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();

      this.#pending.set(id, {
        command,
        timer,
        resolve: (value) => resolve(ok(value as T)),
        reject: (error) => resolve(err(error)),
      });

      socket.send(JSON.stringify({ id, command, botId, payload }));
    });
  }

  #open(): void {
    const socket = new WebSocket(this.#options.url);
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#reconnectAttempt = 0;
      this.#options.logger.info('gateway connected', { url: this.#options.url });
      void this.#options.onReady?.();
    });

    socket.addEventListener('message', (message) => {
      this.#onMessage(String(message.data));
    });

    socket.addEventListener('close', () => {
      this.#socket = undefined;
      // Every bot lives inside the gateway process, so losing this socket means losing the
      // ability to steer them — and if the gateway itself restarted, the bots are gone and
      // must be recreated. `onReady` is where that happens.
      this.#failAllPending({ kind: 'gateway/not-connected' });
      if (!this.#shuttingDown) this.#scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' always follows; reconnection is handled there.
    });
  }

  #onMessage(raw: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.#options.logger.warn('gateway sent malformed JSON');
      return;
    }

    // An event has no correlation id; a response always does.
    if (typeof parsed['id'] !== 'string') {
      const type = parsed['type'];
      const botId = parsed['botId'];
      if (typeof type === 'string' && typeof botId === 'string') {
        const event: GatewayEvent = { type, botId, payload: parsed['payload'] };
        for (const listener of this.#listeners) listener(event);
      }
      return;
    }

    const pending = this.#pending.get(parsed['id']);
    if (pending === undefined) return;
    this.#pending.delete(parsed['id']);
    clearTimeout(pending.timer);

    if (parsed['ok'] === true) {
      pending.resolve(parsed['result']);
      return;
    }
    pending.reject({
      kind: 'gateway/refused',
      command: pending.command,
      detail: typeof parsed['error'] === 'string' ? parsed['error'] : 'unknown error',
    });
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== undefined) return;

    const delayMs = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_MIN_DELAY_MS * 2 ** this.#reconnectAttempt,
    );
    this.#reconnectAttempt += 1;
    this.#options.logger.warn('gateway reconnecting', { attempt: this.#reconnectAttempt, delayMs });

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#open();
    }, delayMs);
    this.#reconnectTimer.unref?.();
  }

  #failAllPending(error: GatewayError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export function describeGatewayError(error: GatewayError): string {
  switch (error.kind) {
    case 'gateway/not-connected':
      return 'the TeamSpeak gateway is not connected';
    case 'gateway/timeout':
      return `gateway command '${error.command}' timed out`;
    case 'gateway/refused':
      return `gateway refused '${error.command}': ${error.detail}`;
  }
}
