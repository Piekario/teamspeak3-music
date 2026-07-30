import type { Clock } from '../../../../shared-kernel/clock.ts';

/**
 * Token bucket guarding outbound chat.
 *
 * ClientQuery itself has no flood limit, but the *server* still applies its client anti-flood
 * to whatever the bot says — and unlike ServerQuery there is no whitelist to escape it. A bot
 * that answers a burst of commands at full speed gets itself kicked, so replies are paced.
 *
 * Burst capacity exists because the common case is legitimate: a `!queue` reply split into
 * three chunks should go out immediately, not over two seconds.
 */
export class TokenBucket {
  readonly #capacity: number;
  readonly #refillIntervalMs: number;
  readonly #clock: Clock;
  #tokens: number;
  #lastRefillMs: number;

  constructor(options: { capacity: number; refillIntervalMs: number; clock: Clock }) {
    this.#capacity = options.capacity;
    this.#refillIntervalMs = options.refillIntervalMs;
    this.#clock = options.clock;
    this.#tokens = options.capacity;
    this.#lastRefillMs = options.clock.epochMillis();
  }

  /** Milliseconds until a token is available; 0 when one can be spent right now. */
  delayUntilAvailableMs(): number {
    this.#refill();
    if (this.#tokens >= 1) return 0;
    const elapsedSinceRefill = this.#clock.epochMillis() - this.#lastRefillMs;
    return Math.max(0, this.#refillIntervalMs - elapsedSinceRefill);
  }

  tryConsume(): boolean {
    this.#refill();
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  #refill(): void {
    const now = this.#clock.epochMillis();
    const elapsed = now - this.#lastRefillMs;
    if (elapsed < this.#refillIntervalMs) return;

    const earned = Math.floor(elapsed / this.#refillIntervalMs);
    this.#tokens = Math.min(this.#capacity, this.#tokens + earned);
    this.#lastRefillMs += earned * this.#refillIntervalMs;
  }
}
