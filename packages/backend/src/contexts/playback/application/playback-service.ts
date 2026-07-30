import type { AppEvent, QueueItem, Requester, Track, TrackEndReason } from '@tsmusic/shared';

import type { Clock } from '../../../shared-kernel/clock.ts';
import type { EventPublisher } from '../../../shared-kernel/event-bus.ts';
import { err, ok, type Result } from '../../../shared-kernel/result.ts';
import { PlaybackSession } from '../domain/playback-session.ts';
import type { Queue, EnqueueError, QueueMutationError } from '../domain/queue.ts';
import type {
  AudioOutput,
  AudioOutputError,
  AudioPlaybackHandle,
  PlaybackEndReason,
  ResolveError,
  TrackResolver,
  VolumeController,
} from '../domain/ports.ts';
import { ClientUid, Volume } from '../domain/values.ts';

export type PlayRequestError = ResolveError | EnqueueError | { readonly kind: 'playback/no-resolver'; readonly url: string };
export type ControlError = { readonly kind: 'playback/nothing-playing' } | { readonly kind: 'playback/illegal-transition' };

export interface PlaybackServiceOptions {
  readonly instanceId: string;
  readonly session: PlaybackSession;
  readonly queue: Queue;
  readonly resolvers: readonly TrackResolver[];
  readonly audio: AudioOutput;
  readonly volume: VolumeController;
  readonly events: EventPublisher;
  readonly clock: Clock;
  readonly logger: {
    debug(message: string, details?: Record<string, unknown>): void;
    info(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
    error(message: string, details?: Record<string, unknown>): void;
  };
}

/**
 * A crash in the first few seconds means the stream never really started — usually an
 * expired media URL — so it is worth re-resolving. A crash later means playback was working
 * and something interrupted it, so resuming from the last position is the better answer.
 */
const EARLY_FAILURE_THRESHOLD_SEC = 3;
const MAX_MIDSTREAM_RETRIES = 2;

/**
 * Orchestrates the playback context: turns requests into domain transitions, and domain
 * transitions into process management.
 *
 * The division of labour is deliberate. `PlaybackSession` owns *what may happen* and holds
 * no I/O; this service owns *making it happen* and holds no rules. Every public method here
 * ends by publishing the new state, so the WebSocket layer never has to poll and no caller
 * can forget to notify.
 */
export class PlaybackService {
  readonly #options: PlaybackServiceOptions;

  #handle: AudioPlaybackHandle | undefined;
  #midstreamRetries = 0;
  /** Guards against two concurrent advances — a skip racing a natural end. */
  #advancing = false;

  constructor(options: PlaybackServiceOptions) {
    this.#options = options;
  }

  get session(): PlaybackSession {
    return this.#options.session;
  }

  // ─── requests ─────────────────────────────────────────────────────────────

  /**
   * Resolves a URL or search phrase, queues it, and starts playback if nothing is playing.
   * Resolution happens before enqueueing so limits are checked against real metadata rather
   * than a guess — a ten-hour livestream is refused up front, not after it starts.
   */
  async request(
    input: { readonly url?: string; readonly query?: string; readonly position?: number },
    requester: Requester,
  ): Promise<Result<Track, PlayRequestError>> {
    const resolved = await this.#resolveInput(input);
    if (!resolved.ok) return resolved;

    const enqueued = this.#options.queue.enqueue(
      resolved.value,
      requester,
      this.#options.clock.now(),
      input.position,
    );
    if (!enqueued.ok) return enqueued;

    this.#publishQueue();
    if (!this.#options.session.isActive) await this.#advance();
    else this.#publishState();

    return ok(resolved.value);
  }

  async search(query: string, limit: number): Promise<Result<readonly Track[], ResolveError>> {
    const resolver = this.#options.resolvers[0];
    if (resolver === undefined) {
      return err({ kind: 'resolve/tool-failure', detail: 'no resolver configured' });
    }
    return resolver.search(query, limit);
  }

  // ─── transport ────────────────────────────────────────────────────────────

  async skip(): Promise<Result<void, ControlError>> {
    if (!this.#options.session.isActive) return err({ kind: 'playback/nothing-playing' });
    await this.#endCurrent('skipped');
    await this.#advance();
    return ok();
  }

  async pause(): Promise<Result<void, ControlError>> {
    const paused = this.#options.session.pause();
    if (!paused.ok) return err({ kind: 'playback/illegal-transition' });

    await this.#stopAudio();
    this.#publishState();
    return ok();
  }

  async resume(): Promise<Result<void, ControlError>> {
    const from = this.#options.session.prepareResume();
    if (!from.ok) return err({ kind: 'playback/illegal-transition' });

    const current = this.#options.session.current;
    if (current === null) return err({ kind: 'playback/nothing-playing' });

    const started = await this.#startAudioFor(current.track, from.value);
    if (!started.ok) {
      await this.#failCurrent(started.error.detail);
      return ok();
    }

    this.#options.session.markStarted(from.value);
    this.#publishState();
    return ok();
  }

  async seek(positionSec: number): Promise<Result<number, ControlError>> {
    const target = this.#options.session.prepareSeek(positionSec);
    if (!target.ok) return err({ kind: 'playback/illegal-transition' });

    const current = this.#options.session.current;
    if (current === null) return err({ kind: 'playback/nothing-playing' });

    // Seek and resume share one mechanism: stop the encoder, start it again with an offset.
    await this.#stopAudio();
    const started = await this.#startAudioFor(current.track, target.value);
    if (!started.ok) {
      await this.#failCurrent(started.error.detail);
      return ok(target.value);
    }

    this.#options.session.markStarted(target.value);
    this.#publishState();
    return ok(target.value);
  }

  async stop(): Promise<void> {
    const ended = this.#options.session.stop();
    await this.#stopAudio();
    if (ended !== null) this.#publishTrackEnded(ended, 'stopped');
    this.#publishQueue();
    this.#publishState();
  }

  async setVolume(volume: Volume): Promise<Result<void, { kind: 'volume/control-failed'; detail: string }>> {
    const applied = await this.#options.volume.apply(volume);
    if (!applied.ok) return applied;

    this.#options.session.setVolume(volume);
    this.#publishState();
    return ok();
  }

  setRepeat(mode: Parameters<PlaybackSession['setRepeat']>[0]): void {
    this.#options.session.setRepeat(mode);
    this.#publishState();
  }

  // ─── queue management ─────────────────────────────────────────────────────

  removeFromQueue(itemId: string, requestedBy?: ClientUid): Result<void, QueueMutationError> {
    const removed = this.#options.queue.remove(itemId, requestedBy);
    if (!removed.ok) return removed;
    this.#publishQueue();
    this.#publishState();
    return ok();
  }

  moveInQueue(itemId: string, toIndex: number): Result<void, QueueMutationError> {
    const moved = this.#options.queue.move(itemId, toIndex);
    if (!moved.ok) return moved;
    this.#publishQueue();
    this.#publishState();
    return ok();
  }

  shuffleQueue(): void {
    this.#options.queue.shuffle();
    this.#publishQueue();
    this.#publishState();
  }

  clearQueue(): void {
    this.#options.queue.clear();
    this.#publishQueue();
    this.#publishState();
  }

  async shutdown(): Promise<void> {
    await this.#stopAudio();
  }

  // ─── internals ────────────────────────────────────────────────────────────

  async #resolveInput(input: {
    readonly url?: string;
    readonly query?: string;
  }): Promise<Result<Track, PlayRequestError>> {
    if (input.url !== undefined) {
      const resolver = this.#options.resolvers.find((candidate) => candidate.supports(input.url as string));
      if (resolver === undefined) return err({ kind: 'playback/no-resolver', url: input.url });

      const resolved = await resolver.resolveUrl(input.url);
      return resolved.ok ? ok(resolved.value.track) : resolved;
    }

    const query = input.query ?? '';
    const results = await this.search(query, 1);
    if (!results.ok) return results;

    const first = results.value[0];
    if (first === undefined) return err({ kind: 'resolve/not-found', query });
    return ok(first);
  }

  /** Claims the next queued item and gets audio flowing, skipping anything unplayable. */
  async #advance(): Promise<void> {
    if (this.#advancing) return;
    this.#advancing = true;
    try {
      for (;;) {
        const claimed = this.#options.session.beginResolving();
        if (!claimed.ok) {
          this.#publishQueue();
          this.#publishState();
          return;
        }

        this.#midstreamRetries = 0;
        const started = await this.#startCurrent(claimed.value.track, 0);
        if (started) {
          this.#publishQueue();
          this.#publishState();
          this.#options.events.publish(
            this.#envelope({ type: 'track.started', payload: { item: claimed.value } }),
          );
          return;
        }
        // Unplayable: the failure has already been reported, so move to the next item.
      }
    } finally {
      this.#advancing = false;
    }
  }

  async #startCurrent(track: Track, fromSec: number): Promise<boolean> {
    const started = await this.#startAudioFor(track, fromSec);
    if (!started.ok) {
      await this.#failCurrent(started.error.detail);
      return false;
    }
    this.#options.session.markStarted(fromSec);
    return true;
  }

  async #startAudioFor(
    track: Track,
    fromSec: number,
  ): Promise<Result<void, { readonly detail: string }>> {
    const stream = await this.#freshStreamUrl(track);
    if (!stream.ok) return err({ detail: describeResolveError(stream.error) });

    const audio = await this.#options.audio.start({
      streamUrl: stream.value,
      startAtSec: fromSec,
      onEnded: (reason) => {
        void this.#onPlaybackEnded(reason);
      },
    });
    if (!audio.ok) return err({ detail: describeAudioError(audio.error) });

    this.#handle = audio.value;
    return ok();
  }

  /**
   * Media URLs expire, and a track can sit in the queue for longer than its URL lives, so
   * the stream URL is always fetched at the moment of playback rather than at enqueue time.
   */
  async #freshStreamUrl(track: Track): Promise<Result<string, ResolveError>> {
    const resolver = this.#options.resolvers.find((candidate) => candidate.supports(track.url));
    if (resolver === undefined) {
      return err({ kind: 'resolve/unsupported-url', url: track.url });
    }

    const resolved = await resolver.refresh(track);
    return resolved.ok ? ok(resolved.value.streamUrl) : resolved;
  }

  async #onPlaybackEnded(reason: PlaybackEndReason): Promise<void> {
    // A cancellation is our own doing — a skip, a seek or a pause — and the code that caused
    // it is already handling what comes next.
    if (reason.kind === 'cancelled') return;

    if (reason.kind === 'completed') {
      await this.#endCurrent('finished');
      await this.#advance();
      return;
    }

    await this.#handleFailure(reason.detail, reason.playedSec);
  }

  async #handleFailure(detail: string, playedSec: number): Promise<void> {
    const current = this.#options.session.current;
    if (current === null) return;

    const failedEarly = playedSec < EARLY_FAILURE_THRESHOLD_SEC;

    if (!failedEarly && this.#midstreamRetries < MAX_MIDSTREAM_RETRIES) {
      this.#midstreamRetries += 1;
      this.#options.logger.warn('resuming after mid-stream failure', {
        detail,
        playedSec,
        attempt: this.#midstreamRetries,
      });

      const resumed = await this.#startAudioFor(current.track, playedSec);
      if (resumed.ok) {
        this.#options.session.markStarted(playedSec);
        this.#publishState();
        return;
      }
    }

    await this.#failCurrent(detail);
    await this.#advance();
  }

  async #failCurrent(detail: string): Promise<void> {
    const ended = this.#options.session.failCurrent(detail);
    await this.#stopAudio();

    this.#options.logger.warn('track failed', { detail });
    if (ended !== null) this.#publishTrackEnded(ended, 'error');
    this.#options.events.publish(
      this.#envelope({ type: 'log', payload: { level: 'warn', message: detail } }),
    );
    this.#publishState();
  }

  async #endCurrent(reason: TrackEndReason): Promise<void> {
    const ended = this.#options.session.endCurrent(reason);
    await this.#stopAudio();
    if (ended !== null) this.#publishTrackEnded(ended, reason);
  }

  async #stopAudio(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.stop();
  }

  // ─── event publishing ─────────────────────────────────────────────────────

  #publishState(): void {
    this.#options.events.publish(
      this.#envelope({ type: 'player.state', payload: this.#options.session.toPlayerState() }),
    );
  }

  #publishQueue(): void {
    this.#options.events.publish(
      this.#envelope({ type: 'queue.changed', payload: { queue: this.#options.queue.items } }),
    );
  }

  #publishTrackEnded(item: QueueItem, reason: TrackEndReason): void {
    this.#options.events.publish(
      this.#envelope({ type: 'track.ended', payload: { item, reason } }),
    );
  }

  #envelope<T extends Omit<AppEvent, 'instanceId' | 'at'>>(event: T): AppEvent {
    return {
      ...event,
      instanceId: this.#options.instanceId,
      at: this.#options.clock.now().toISOString(),
    } as AppEvent;
  }
}

function describeResolveError(error: ResolveError): string {
  switch (error.kind) {
    case 'resolve/not-found':
      return `nothing found for "${error.query}"`;
    case 'resolve/unsupported-url':
      return `unsupported URL: ${error.url}`;
    case 'resolve/blocked':
      return `YouTube blocked the request: ${error.detail}`;
    case 'resolve/timeout':
      return 'yt-dlp timed out';
    case 'resolve/tool-failure':
      return `yt-dlp error: ${error.detail}`;
  }
}

function describeAudioError(error: AudioOutputError): string {
  switch (error.kind) {
    case 'audio/spawn-failed':
      return `could not start ffmpeg: ${error.detail}`;
    case 'audio/sink-unavailable':
      return `audio sink '${error.sink}' unavailable`;
  }
}
