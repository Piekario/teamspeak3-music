import type { Track, TrackEndReason } from '@tsmusic/shared';

/**
 * Repository ports for the catalog context.
 *
 * The application layer depends on these interfaces only, which keeps playlist and history
 * behaviour testable against in-memory implementations and leaves SQLite as a detail of the
 * infrastructure layer rather than an assumption baked into the domain.
 */

export interface PlaylistSummary {
  readonly id: string;
  readonly instanceId: string;
  readonly name: string;
  readonly description: string | null;
  readonly ownerUid: string | null;
  /** Loaded automatically when the queue runs dry. At most one per instance. */
  readonly isDefault: boolean;
  readonly trackCount: number;
  readonly totalDurationSec: number;
  readonly updatedAt: string;
}

export interface PlaylistTrack {
  readonly id: string;
  readonly position: number;
  readonly track: Track;
  readonly addedAt: string;
}

export interface PlaylistDetail extends PlaylistSummary {
  readonly tracks: readonly PlaylistTrack[];
}

export interface PlaylistRepository {
  list(instanceId: string): Promise<readonly PlaylistSummary[]>;
  findById(id: string): Promise<PlaylistDetail | undefined>;
  /** Names are unique per instance, which is what makes `!playlist load party` work. */
  findByName(instanceId: string, name: string): Promise<PlaylistDetail | undefined>;
  findDefault(instanceId: string): Promise<PlaylistDetail | undefined>;

  create(input: {
    instanceId: string;
    name: string;
    description: string | null;
    ownerUid: string | null;
  }): Promise<PlaylistSummary>;

  rename(id: string, name: string): Promise<void>;
  delete(id: string): Promise<void>;

  /**
   * Marks one playlist as the instance's default, demoting whichever held it.
   *
   * Passing null clears the default entirely. Doing both in one operation is what stops two
   * playlists ever claiming it at once.
   */
  setDefault(instanceId: string, playlistId: string | null): Promise<void>;

  addTracks(playlistId: string, tracks: readonly Track[]): Promise<number>;
  removeTrack(playlistId: string, trackId: string): Promise<void>;
  /** Reorders within the playlist; positions are renumbered so they stay contiguous. */
  reorder(playlistId: string, trackId: string, toIndex: number): Promise<void>;
}

export interface HistoryEntry {
  readonly id: string;
  readonly track: Track;
  readonly requestedByUid: string | null;
  readonly requestedByNickname: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endedReason: TrackEndReason | null;
}

export interface HistoryQuery {
  readonly limit: number;
  readonly offset: number;
  readonly search?: string | undefined;
  readonly uid?: string | undefined;
}

export interface HistoryRepository {
  /** Records a track as it starts; the id returned is closed out when it ends. */
  recordStart(input: {
    instanceId: string;
    track: Track;
    requestedByUid: string | null;
    requestedByNickname: string | null;
    startedAt: string;
  }): Promise<string>;

  recordEnd(id: string, endedAt: string, reason: TrackEndReason): Promise<void>;

  list(instanceId: string, query: HistoryQuery): Promise<readonly HistoryEntry[]>;
  findById(id: string): Promise<HistoryEntry | undefined>;
  count(instanceId: string): Promise<number>;
}
