import type { ConnectionState } from '@tsmusic/shared';

import type { Clock } from '../../../shared-kernel/clock.ts';

export interface SupervisorLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
}

export interface ConnectionSupervisorOptions {
  readonly instanceId: string;
  readonly clock: Clock;
  readonly logger: SupervisorLogger;
  /** Attempts to bring the bot back onto the TeamSpeak server. */
  readonly reconnect: () => void;
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
}

const DEFAULT_MIN_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

/**
 * Keeps a bot on its TeamSpeak server.
 *
 * This is a different failure from the one the transports already handle. Those reconnect a
 * *socket* — a ClientQuery connection, or the control channel to the gateway. This one
 * handles the bot being off the *server*: the TeamSpeak server restarted, the network
 * dropped, or an admin kicked it. In every one of those cases the transport is perfectly
 * healthy and reports nothing wrong, so nothing would otherwise bring the bot back.
 *
 * Backoff is capped rather than unbounded because the common cause is a server that is
 * rebooting and will be back shortly; waiting half an hour to notice would be worse than a
 * little extra traffic.
 */
export class ConnectionSupervisor {
  readonly #options: Required<Pick<ConnectionSupervisorOptions, 'minDelayMs' | 'maxDelayMs'>> &
    ConnectionSupervisorOptions;

  #timer: NodeJS.Timeout | undefined;
  #attempt = 0;
  #enabled = false;

  constructor(options: ConnectionSupervisorOptions) {
    this.#options = {
      ...options,
      minDelayMs: options.minDelayMs ?? DEFAULT_MIN_DELAY_MS,
      maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    };
  }

  /** Called when the instance is started; retries continue until `stop`. */
  start(): void {
    this.#enabled = true;
    this.#attempt = 0;
  }

  /**
   * Called when the instance is deliberately stopped. Without this an operator pressing
   * "disconnect" would watch the bot reappear a few seconds later.
   */
  stop(): void {
    this.#enabled = false;
    this.#clear();
  }

  /** Feeds the supervisor the connection state the transport reports. */
  observe(state: ConnectionState): void {
    if (!this.#enabled) return;

    if (state === 'connected') {
      if (this.#attempt > 0) {
        this.#options.logger.info('bot is back on the server', {
          instance: this.#options.instanceId,
          afterAttempts: this.#attempt,
        });
      }
      this.#attempt = 0;
      this.#clear();
      return;
    }

    // `connecting` is an attempt already in flight; scheduling another would stack them up.
    if (state === 'connecting') return;

    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (this.#timer !== undefined) return;

    const delayMs = Math.min(
      this.#options.maxDelayMs,
      this.#options.minDelayMs * 2 ** this.#attempt,
    );
    this.#attempt += 1;

    this.#options.logger.warn('bot is off the server; retrying', {
      instance: this.#options.instanceId,
      attempt: this.#attempt,
      delayMs,
    });

    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#enabled) this.#options.reconnect();
    }, delayMs);
    this.#timer.unref?.();
  }

  #clear(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
