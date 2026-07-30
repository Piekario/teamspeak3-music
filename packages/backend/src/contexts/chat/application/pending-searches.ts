import type { Track } from '@tsmusic/shared';

import type { Clock } from '../../../shared-kernel/clock.ts';

/**
 * Remembers what each person was last offered by `!search`, so `!pick 3` means something.
 *
 * Entries expire: a pick made twenty minutes after the search almost certainly refers to a
 * newer list the person has since forgotten about, and silently queueing a stale result is
 * worse than asking them to search again.
 */
const DEFAULT_TTL_MS = 60_000;

interface PendingSearch {
  readonly tracks: readonly Track[];
  readonly offeredAtMs: number;
}

export class PendingSearches {
  readonly #byUid = new Map<string, PendingSearch>();
  readonly #clock: Clock;
  readonly #ttlMs: number;

  constructor(clock: Clock, ttlMs: number = DEFAULT_TTL_MS) {
    this.#clock = clock;
    this.#ttlMs = ttlMs;
  }

  remember(uid: string, tracks: readonly Track[]): void {
    this.#byUid.set(uid, { tracks, offeredAtMs: this.#clock.epochMillis() });
  }

  /**
   * Consumes a one-based choice. Returns undefined when the offer expired, never existed,
   * or the number is out of range — the caller reports all three the same way.
   */
  take(uid: string, choice: number): Track | undefined {
    const pending = this.#byUid.get(uid);
    if (pending === undefined) return undefined;

    if (this.#clock.epochMillis() - pending.offeredAtMs > this.#ttlMs) {
      this.#byUid.delete(uid);
      return undefined;
    }

    const track = pending.tracks[choice - 1];
    if (track === undefined) return undefined;

    this.#byUid.delete(uid);
    return track;
  }

  prune(): void {
    const cutoff = this.#clock.epochMillis() - this.#ttlMs;
    for (const [uid, pending] of this.#byUid) {
      if (pending.offeredAtMs < cutoff) this.#byUid.delete(uid);
    }
  }
}
