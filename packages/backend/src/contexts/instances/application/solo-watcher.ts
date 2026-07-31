import type { ChannelClient } from '../domain/bot-client.ts';

export interface SoloWatcherLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
}

export interface SoloWatcherOptions {
  readonly instanceId: string;
  /** Re-read on a timer rather than on events: both transports answer this cheaply. */
  readonly listChannelClients: () => Promise<readonly ChannelClient[]>;
  readonly isEnabled: () => boolean;
  readonly isPlaying: () => boolean;
  readonly isPaused: () => boolean;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly logger: SoloWatcherLogger;
  readonly intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 10_000;

/**
 * Pauses playback while nobody is listening, and resumes when somebody returns.
 *
 * The rule that makes this safe is remembering *why* it is paused. A pause somebody made
 * deliberately must survive people coming and going — resuming it because a listener walked
 * in would override an explicit instruction. So this only ever resumes a pause it caused
 * itself, tracked in `#pausedByUs`.
 *
 * Occupancy is polled rather than driven by join and leave events. Both transports answer
 * `listChannelClients` cheaply — for the gateway it is a local read of TSLib's book — and a
 * ten-second reaction is entirely adequate for "nobody is here". Wiring enter and leave
 * notifications through two different transports would be considerably more surface for no
 * practical gain.
 */
export class SoloWatcher {
  readonly #options: Required<Pick<SoloWatcherOptions, 'intervalMs'>> & SoloWatcherOptions;
  #timer: NodeJS.Timeout | undefined;
  #pausedByUs = false;

  constructor(options: SoloWatcherOptions) {
    this.#options = { ...options, intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS };
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.check(), this.#options.intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#pausedByUs = false;
  }

  /** Exposed so tests can drive it without waiting on a timer. */
  async check(): Promise<void> {
    if (!this.#options.isEnabled()) {
      // Turning the setting off must not strand a pause this watcher caused.
      if (this.#pausedByUs) await this.#resume();
      return;
    }

    let clients: readonly ChannelClient[];
    try {
      clients = await this.#options.listChannelClients();
    } catch (error) {
      // A momentary read failure is not evidence the channel is empty; pausing on it would
      // stop the music for everyone because of one dropped request.
      this.#options.logger.debug('could not read channel occupancy', {
        instance: this.#options.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // The bot is in its own channel listing, so anyone else at all means it is not alone.
    // An empty listing means the read told us nothing useful — the bot is not connected, or
    // it has not joined yet — and is treated as "not alone" rather than as silence.
    const listeners = clients.length === 0 ? 1 : clients.length - 1;

    if (listeners <= 0) {
      await this.#pauseIfPlaying();
      return;
    }
    if (this.#pausedByUs) await this.#resume();
  }

  async #pauseIfPlaying(): Promise<void> {
    if (this.#pausedByUs || !this.#options.isPlaying()) return;

    await this.#options.pause();
    this.#pausedByUs = true;
    this.#options.logger.debug('paused: nobody left in the channel', {
      instance: this.#options.instanceId,
    });
  }

  async #resume(): Promise<void> {
    this.#pausedByUs = false;
    // Only resume what is actually paused: the track may have been stopped or skipped in
    // the meantime, and resuming then would restart something nobody asked for.
    if (!this.#options.isPaused()) return;

    await this.#options.resume();
    this.#options.logger.debug('resumed: somebody joined the channel', {
      instance: this.#options.instanceId,
    });
  }
}
