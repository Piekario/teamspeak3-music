import type { QueueItem, Requester, Track } from '@tsmusic/shared';

import { err, ok, type Result } from '../../../shared-kernel/result.ts';
import { ClientUid, QueueItemId } from './values.ts';

/**
 * The queue: an ordered list of pending items plus the enqueue rules.
 *
 * Kept separate from the playback session so that "what plays next" and "how audio is
 * produced" stay independent concerns. The queue knows nothing about ffmpeg, and the
 * session knows nothing about per-user limits.
 */

export interface QueueLimits {
  /** Reject tracks longer than this, so nobody queues a ten-hour livestream. 0 disables. */
  readonly maxTrackSeconds: number;
  /** Cap on pending items per requester, so one person cannot monopolise the queue. 0 disables. */
  readonly maxPerUser: number;
  readonly allowLiveStreams: boolean;
}

export const DEFAULT_QUEUE_LIMITS: QueueLimits = Object.freeze({
  maxTrackSeconds: 900,
  maxPerUser: 10,
  allowLiveStreams: false,
});

export type EnqueueError =
  | { readonly kind: 'queue/track-too-long'; readonly durationSec: number; readonly limitSec: number }
  | { readonly kind: 'queue/live-not-allowed' }
  | { readonly kind: 'queue/user-limit-reached'; readonly limit: number };

export type QueueMutationError =
  | { readonly kind: 'queue/item-not-found'; readonly itemId: string }
  | { readonly kind: 'queue/not-owned-by-requester'; readonly itemId: string };

export class Queue {
  #items: QueueItem[] = [];
  #limits: QueueLimits;
  #nextId = 1;

  constructor(limits: QueueLimits = DEFAULT_QUEUE_LIMITS) {
    this.#limits = limits;
  }

  get items(): readonly QueueItem[] {
    return this.#items;
  }

  get length(): number {
    return this.#items.length;
  }

  get isEmpty(): boolean {
    return this.#items.length === 0;
  }

  applyLimits(limits: QueueLimits): void {
    this.#limits = limits;
  }

  canAccept(track: Track, requester: Requester): Result<void, EnqueueError> {
    if (track.isLive && !this.#limits.allowLiveStreams) {
      return err({ kind: 'queue/live-not-allowed' });
    }

    const limitSec = this.#limits.maxTrackSeconds;
    if (limitSec > 0 && track.durationSec !== null && track.durationSec > limitSec) {
      return err({ kind: 'queue/track-too-long', durationSec: track.durationSec, limitSec });
    }

    const perUser = this.#limits.maxPerUser;
    if (perUser > 0 && this.countFor(requester.uid) >= perUser) {
      return err({ kind: 'queue/user-limit-reached', limit: perUser });
    }

    return ok();
  }

  /**
   * Adds a track. `position` inserts ahead of the queue (`!playnext`); omitting it appends.
   * Out-of-range positions clamp rather than fail — the caller's intent is unambiguous.
   */
  enqueue(
    track: Track,
    requester: Requester,
    enqueuedAt: Date,
    position?: number,
  ): Result<QueueItem, EnqueueError> {
    const admissible = this.canAccept(track, requester);
    if (!admissible.ok) return admissible;

    const item: QueueItem = {
      id: this.#generateId(),
      track,
      requestedBy: requester,
      enqueuedAt: enqueuedAt.toISOString(),
    };

    if (position === undefined) {
      this.#items.push(item);
    } else {
      this.#items.splice(clampIndex(position, this.#items.length), 0, item);
    }
    return ok(item);
  }

  /** Removes and returns the next item, or undefined when the queue has run dry. */
  dequeue(): QueueItem | undefined {
    return this.#items.shift();
  }

  /**
   * Re-inserts an item that was already accepted once — the repeat modes putting a finished
   * track back. Limits are deliberately not re-checked: the item is not a new request, and
   * re-validating it would let `repeat` silently break when a per-user cap is reached.
   */
  enqueueExisting(item: QueueItem, position?: number): void {
    if (position === undefined) {
      this.#items.push(item);
      return;
    }
    this.#items.splice(clampIndex(position, this.#items.length), 0, item);
  }

  peek(): QueueItem | undefined {
    return this.#items[0];
  }

  /**
   * Removes an item. When `requestedBy` is supplied the removal is restricted to that
   * person's own entries — that is how `!remove` stays safe for ordinary users while a DJ
   * calls the same method without the restriction.
   */
  remove(itemId: string, requestedBy?: ClientUid): Result<QueueItem, QueueMutationError> {
    const index = this.#items.findIndex((item) => item.id === itemId);
    if (index === -1) return err({ kind: 'queue/item-not-found', itemId });

    const item = this.#items[index] as QueueItem;
    if (requestedBy !== undefined && item.requestedBy.uid !== requestedBy.value) {
      return err({ kind: 'queue/not-owned-by-requester', itemId });
    }

    this.#items.splice(index, 1);
    return ok(item);
  }

  move(itemId: string, toIndex: number): Result<void, QueueMutationError> {
    const from = this.#items.findIndex((item) => item.id === itemId);
    if (from === -1) return err({ kind: 'queue/item-not-found', itemId });

    const [item] = this.#items.splice(from, 1);
    this.#items.splice(clampIndex(toIndex, this.#items.length), 0, item as QueueItem);
    return ok();
  }

  /**
   * Fisher–Yates, with randomness injected so the shuffle is deterministic under test.
   */
  shuffle(random: () => number = Math.random): void {
    for (let i = this.#items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const a = this.#items[i] as QueueItem;
      const b = this.#items[j] as QueueItem;
      this.#items[i] = b;
      this.#items[j] = a;
    }
  }

  clear(): void {
    this.#items = [];
  }

  countFor(uid: string): number {
    return this.#items.filter((item) => item.requestedBy.uid === uid).length;
  }

  /** Restores a persisted queue after a restart, so a party survives a container bounce. */
  restore(items: readonly QueueItem[]): void {
    this.#items = [...items];
    const highest = items.reduce((max, item) => Math.max(max, parseIdSuffix(item.id)), 0);
    this.#nextId = highest + 1;
  }

  #generateId(): string {
    const id = QueueItemId.create(`q${this.#nextId}`);
    this.#nextId += 1;
    return id.value;
  }
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(0, Math.trunc(index)), length);
}

function parseIdSuffix(id: string): number {
  const parsed = Number.parseInt(id.replace(/^q/, ''), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}
