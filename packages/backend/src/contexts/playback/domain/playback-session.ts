import type { PlaybackStatus, PlayerState, QueueItem, RepeatMode, TrackEndReason } from '@tsmusic/shared';

import type { Clock } from '../../../shared-kernel/clock.ts';
import { AggregateRoot } from '../../../shared-kernel/domain-event.ts';
import { err, ok, type Result } from '../../../shared-kernel/result.ts';
import type { Queue } from './queue.ts';
import { Volume } from './values.ts';

/**
 * The playback session — the aggregate root of this context and the only place playback
 * state may change.
 *
 *     IDLE ──enqueue──► RESOLVING ──started──► PLAYING ⇄ PAUSED
 *       ▲                   │ failed              │
 *       └───────────────────┴─────────ended───────┘
 *
 * Modelled as an explicit state machine rather than a handful of booleans, because
 * `isPlaying && !isPaused && !isStopping` is exactly the kind of condition that grows a bug
 * the first time two events race. Illegal transitions are refused as values, not thrown.
 *
 * The session is pure: it performs no I/O and spawns no processes. Driving ffmpeg is the
 * application service's job, which is what makes every rule below testable in microseconds.
 */

export type TransitionError = {
  readonly kind: 'playback/illegal-transition';
  readonly from: PlaybackStatus;
  readonly attempted: string;
};

export interface PlaybackSnapshot {
  readonly status: PlaybackStatus;
  readonly current: QueueItem | null;
  readonly positionSec: number;
  readonly volume: number;
  readonly repeat: RepeatMode;
}

export class PlaybackSession extends AggregateRoot {
  readonly #queue: Queue;
  readonly #clock: Clock;

  #status: PlaybackStatus = 'idle';
  #current: QueueItem | null = null;
  #volume: Volume;
  #repeat: RepeatMode = 'off';
  #error: string | null = null;

  /** Wall-clock at which the current playing stretch began. */
  #startedAtMs: number | null = null;
  /** Offset the current stretch started from — non-zero after a seek or a resume. */
  #offsetSec = 0;

  constructor(options: { queue: Queue; clock: Clock; initialVolume?: Volume }) {
    super();
    this.#queue = options.queue;
    this.#clock = options.clock;
    this.#volume = options.initialVolume ?? Volume.clamp(40);
  }

  get status(): PlaybackStatus {
    return this.#status;
  }

  get current(): QueueItem | null {
    return this.#current;
  }

  get volume(): Volume {
    return this.#volume;
  }

  get repeat(): RepeatMode {
    return this.#repeat;
  }

  get isActive(): boolean {
    return this.#status === 'playing' || this.#status === 'paused';
  }

  /**
   * Position is computed, never stored: storing it would need a ticker, and a ticker drifts.
   * The UI interpolates from this value plus its timestamp, so nothing has to tick over the
   * wire either.
   */
  positionSec(): number {
    if (this.#status !== 'playing' || this.#startedAtMs === null) return this.#offsetSec;
    const elapsedMs = this.#clock.epochMillis() - this.#startedAtMs;
    return this.#offsetSec + Math.max(0, elapsedMs) / 1000;
  }

  // ─── transitions ──────────────────────────────────────────────────────────

  /** Claims the next queued item and moves to RESOLVING. */
  beginResolving(): Result<QueueItem, TransitionError | { kind: 'playback/queue-empty' }> {
    if (this.#status === 'playing' || this.#status === 'paused' || this.#status === 'resolving') {
      return err({ kind: 'playback/illegal-transition', from: this.#status, attempted: 'beginResolving' });
    }

    const next = this.#queue.dequeue();
    if (next === undefined) {
      this.#status = 'idle';
      this.#current = null;
      return err({ kind: 'playback/queue-empty' });
    }

    this.#status = 'resolving';
    this.#current = next;
    this.#offsetSec = 0;
    this.#startedAtMs = null;
    this.#error = null;
    return ok(next);
  }

  /** Audio is flowing. `fromSec` is non-zero when resuming or seeking. */
  markStarted(fromSec = 0): Result<void, TransitionError> {
    if (this.#current === null || (this.#status !== 'resolving' && this.#status !== 'paused')) {
      return err({ kind: 'playback/illegal-transition', from: this.#status, attempted: 'markStarted' });
    }

    this.#status = 'playing';
    this.#offsetSec = fromSec;
    this.#startedAtMs = this.#clock.epochMillis();
    this.#error = null;
    return ok();
  }

  /**
   * Freezes playback, banking the position reached so far. Pause and seek share one
   * mechanism upstream — kill the process, respawn with `-ss` — so the session only has to
   * remember where it got to.
   */
  pause(): Result<number, TransitionError> {
    if (this.#status !== 'playing') {
      return err({ kind: 'playback/illegal-transition', from: this.#status, attempted: 'pause' });
    }

    const position = this.positionSec();
    this.#status = 'paused';
    this.#offsetSec = position;
    this.#startedAtMs = null;
    return ok(position);
  }

  /** Reports where playback must resume from; the caller respawns audio, then marks started. */
  prepareResume(): Result<number, TransitionError> {
    if (this.#status !== 'paused') {
      return err({ kind: 'playback/illegal-transition', from: this.#status, attempted: 'resume' });
    }
    return ok(this.#offsetSec);
  }

  /** Same shape as resume: the session banks the target, the caller respawns from it. */
  prepareSeek(positionSec: number): Result<number, TransitionError> {
    if (!this.isActive) {
      return err({ kind: 'playback/illegal-transition', from: this.#status, attempted: 'seek' });
    }

    const duration = this.#current?.track.durationSec ?? null;
    const upperBound = duration === null ? positionSec : Math.max(0, duration - 1);
    const target = Math.min(Math.max(0, positionSec), upperBound);

    this.#offsetSec = target;
    this.#startedAtMs = this.#status === 'playing' ? this.#clock.epochMillis() : null;
    return ok(target);
  }

  /**
   * Ends the current track and decides what follows.
   *
   * `repeat: 'track'` re-queues the same item at the front — but only on a natural finish.
   * A skip during repeat-one must move on, or the bot becomes impossible to steer.
   */
  endCurrent(reason: TrackEndReason): QueueItem | null {
    const ended = this.#current;
    this.#current = null;
    this.#startedAtMs = null;
    this.#offsetSec = 0;
    this.#status = 'idle';

    if (ended === null) return null;

    if (this.#repeat === 'track' && reason === 'finished') {
      this.#queue.enqueueExisting(ended, 0);
    } else if (this.#repeat === 'queue' && reason !== 'stopped') {
      this.#queue.enqueueExisting(ended);
    }

    return ended;
  }

  /** Hard stop: clears the queue and abandons the current track. */
  stop(): QueueItem | null {
    const ended = this.#current;
    this.#queue.clear();
    this.#current = null;
    this.#status = 'idle';
    this.#startedAtMs = null;
    this.#offsetSec = 0;
    return ended;
  }

  failCurrent(message: string): QueueItem | null {
    this.#error = message;
    const ended = this.#current;
    this.#current = null;
    this.#status = 'idle';
    this.#startedAtMs = null;
    this.#offsetSec = 0;
    return ended;
  }

  setVolume(volume: Volume): void {
    this.#volume = volume;
  }

  setRepeat(mode: RepeatMode): void {
    this.#repeat = mode;
  }

  // ─── read model ───────────────────────────────────────────────────────────

  snapshot(): PlaybackSnapshot {
    return {
      status: this.#status,
      current: this.#current,
      positionSec: this.positionSec(),
      volume: this.#volume.value,
      repeat: this.#repeat,
    };
  }

  toPlayerState(): PlayerState {
    return {
      status: this.#status,
      current: this.#current,
      positionSec: this.positionSec(),
      positionUpdatedAt: this.#clock.now().toISOString(),
      volume: this.#volume.value,
      repeat: this.#repeat,
      queue: this.#queue.items,
      error: this.#error,
    };
  }
}
