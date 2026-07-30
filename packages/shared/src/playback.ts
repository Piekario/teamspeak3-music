/**
 * The playback read model — what the backend broadcasts and the UI renders.
 * These are transport shapes, deliberately dumb. Behaviour and invariants live in the
 * backend's playback domain; nothing here should grow a method.
 */

export const PLAYBACK_STATUSES = ['idle', 'resolving', 'playing', 'paused', 'stopping'] as const;
export type PlaybackStatus = (typeof PLAYBACK_STATUSES)[number];

export const REPEAT_MODES = ['off', 'track', 'queue'] as const;
export type RepeatMode = (typeof REPEAT_MODES)[number];

export const TRACK_SOURCES = ['youtube', 'direct'] as const;
export type TrackSource = (typeof TRACK_SOURCES)[number];

export interface Track {
  readonly source: TrackSource;
  /** Source-native id (YouTube video id); for `direct` this is the URL hash. */
  readonly sourceId: string;
  readonly url: string;
  readonly title: string;
  readonly uploader: string | null;
  readonly durationSec: number | null;
  readonly thumbnailUrl: string | null;
  readonly isLive: boolean;
}

export interface Requester {
  readonly uid: string;
  readonly nickname: string;
}

export interface QueueItem {
  readonly id: string;
  readonly track: Track;
  readonly requestedBy: Requester;
  readonly enqueuedAt: string;
}

export interface PlayerState {
  readonly status: PlaybackStatus;
  readonly current: QueueItem | null;
  /**
   * Playback position at `positionUpdatedAt`. The UI interpolates locally from these two
   * fields, so the server never has to tick position over the wire.
   */
  readonly positionSec: number;
  readonly positionUpdatedAt: string;
  readonly volume: number;
  readonly repeat: RepeatMode;
  readonly queue: readonly QueueItem[];
  readonly error: string | null;
}

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 150;
export const VOLUME_DEFAULT = 40;
