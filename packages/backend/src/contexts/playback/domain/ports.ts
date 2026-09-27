import type { QueueItem, Track } from '@tsmusic/shared';

import type { Result } from '../../../shared-kernel/result.ts';
import type { Volume } from './values.ts';

/**
 * Ports of the playback context.
 *
 * Declared here, in the domain, and implemented in infrastructure. The playback service
 * depends only on these interfaces, which is what allows the entire orchestration — retries,
 * skip handling, the crash-versus-intentional-kill distinction — to be tested with fakes,
 * spawning no processes and reaching no network.
 */

// ─── resolving ──────────────────────────────────────────────────────────────

export interface ResolvedTrack {
  readonly track: Track;
  /**
   * A directly playable media URL. Deliberately not a pipe: a piped stdin is not seekable,
   * which would make `!seek` impossible and cost ffmpeg its ability to reconnect.
   */
  readonly streamUrl: string;
  /**
   * Headers yt-dlp extracted, such as User-Agent. Required by sources like YouTube
   * which check if the streaming client uses the same headers as the extractor.
   */
  readonly httpHeaders?: Record<string, string> | undefined;
  /**
   * Media URLs are time-limited and bound to the requesting IP. A queued item may go stale
   * before it ever plays, so the service re-resolves lazily when this has passed.
   */
  readonly expiresAt: Date | null;
}

export interface PlaylistListing {
  readonly title: string;
  readonly tracks: readonly Track[];
  /**
   * How many entries the playlist has beyond those returned.
   *
   * Reported rather than silently dropped: a listener who queues a 500-track playlist and
   * gets 100 should be told, not left to wonder why it stopped.
   */
  readonly omitted: number;
}

export type ResolveError =
  | { readonly kind: 'resolve/not-found'; readonly query: string }
  /**
   * The source will only serve this to a signed-in, age-verified viewer.
   *
   * Kept apart from `blocked` because the remedies differ: a bot challenge can be answered
   * with a proxy or a PO token, while an age gate can only be answered with cookies from an
   * account that has been verified. Telling somebody to try a proxy for an 18+ track would
   * send them a long way down the wrong road.
   */
  | { readonly kind: 'resolve/age-restricted'; readonly url: string }
  | { readonly kind: 'resolve/unsupported-url'; readonly url: string }
  | { readonly kind: 'resolve/blocked'; readonly detail: string }
  | { readonly kind: 'resolve/tool-failure'; readonly detail: string }
  | { readonly kind: 'resolve/timeout' };

/**
 * Strategy: YouTube today, other sources later. Adding SoundCloud must not require touching
 * the player, so the player never learns what a "source" is beyond this interface.
 */
export interface TrackResolver {
  /** Whether this resolver claims a URL — the registry asks each in turn. */
  supports(url: string): boolean;
  resolveUrl(url: string): Promise<Result<ResolvedTrack, ResolveError>>;
  search(query: string, limit: number): Promise<Result<readonly Track[], ResolveError>>;

  /** Whether a URL names a collection of tracks rather than a single one. */
  isPlaylist(url: string): boolean;

  /**
   * Lists a playlist's entries without resolving each one.
   *
   * Metadata only: resolving a hundred stream URLs up front would take minutes and most of
   * them would expire before they played. Each entry is resolved when it reaches the front
   * of the queue, exactly as a single track is.
   */
  resolvePlaylist(
    url: string,
    limit: number,
  ): Promise<Result<PlaylistListing, ResolveError>>;
  /** Turns a queued track back into a fresh stream URL once the old one expired. */
  refresh(track: Track): Promise<Result<ResolvedTrack, ResolveError>>;
}

// ─── audio output ───────────────────────────────────────────────────────────

export type PlaybackEndReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly detail: string; readonly playedSec: number };

export interface AudioPlaybackHandle {
  /** Stops the stream. Idempotent, and never reported as a failure to the listener. */
  stop(): Promise<void>;
}

export interface StartPlaybackOptions {
  readonly streamUrl: string;
  readonly httpHeaders?: Record<string, string> | undefined;
  readonly startAtSec: number;
  /** Resolves when the stream ends, one way or another. */
  readonly onEnded: (reason: PlaybackEndReason) => void;
}

/**
 * Produces audio into the instance's sink. The single implementation drives ffmpeg, but the
 * player only knows "start", "stop" and "it ended, here is why".
 */
export interface AudioOutput {
  start(options: StartPlaybackOptions): Promise<Result<AudioPlaybackHandle, AudioOutputError>>;
  isHealthy(): Promise<boolean>;
}

export type AudioOutputError =
  | { readonly kind: 'audio/spawn-failed'; readonly detail: string }
  | { readonly kind: 'audio/sink-unavailable'; readonly sink: string };

// ─── volume ─────────────────────────────────────────────────────────────────

/**
 * Volume is applied to the sink, not to the encoder: changing an ffmpeg filter would mean
 * killing and respawning the process, which is audible. Sink volume is instant and gapless.
 */
export interface VolumeController {
  apply(volume: Volume): Promise<Result<void, VolumeControlError>>;
  read(): Promise<Result<number, VolumeControlError>>;
}

export type VolumeControlError = {
  readonly kind: 'volume/control-failed';
  readonly detail: string;
};

// ─── queue persistence ───────────────────────────────────────────────────────

/**
 * A write-behind mirror of the live queue, so a container restart mid-party restores what
 * was lined up instead of losing it. Whole-queue replace rather than incremental updates: a
 * move, a shuffle or a clear touches every position at once, so there is nothing to diff.
 */
export interface QueueRepository {
  load(instanceId: string): Promise<readonly QueueItem[]>;
  save(instanceId: string, items: readonly QueueItem[]): Promise<void>;
}
