import { randomUUID } from 'node:crypto';

import { and, asc, eq, sql } from 'drizzle-orm';
import type { Track } from '@tsmusic/shared';

import type {
  PlaylistDetail,
  PlaylistRepository,
  PlaylistSummary,
  PlaylistTrack,
} from '../../contexts/catalog/domain/repositories.ts';
import type { Db } from './database.ts';
import { playlistTracks, playlists } from './schema.ts';

type PlaylistRow = typeof playlists.$inferSelect;
type TrackRow = typeof playlistTracks.$inferSelect;

/**
 * SQLite-backed playlist storage.
 *
 * Positions are kept contiguous rather than sparse. Sparse ordering keys are cheaper to
 * insert into, but a playlist is small and read constantly, and contiguous positions mean
 * "track 4" in chat means the same thing as the fourth row on screen.
 */
export class DrizzlePlaylistRepository implements PlaylistRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(instanceId: string): Promise<readonly PlaylistSummary[]> {
    const rows = this.#db
      .select()
      .from(playlists)
      .where(eq(playlists.instanceId, instanceId))
      .orderBy(asc(playlists.name))
      .all();

    return rows.map((row) => this.#toSummary(row));
  }

  async findById(id: string): Promise<PlaylistDetail | undefined> {
    const row = this.#db.select().from(playlists).where(eq(playlists.id, id)).get();
    return row === undefined ? undefined : this.#toDetail(row);
  }

  async findByName(instanceId: string, name: string): Promise<PlaylistDetail | undefined> {
    // Case-insensitive: nobody types `!playlist load Party` with the capital in the right
    // place, and refusing on case would be a poor reason to fail.
    const row = this.#db
      .select()
      .from(playlists)
      .where(
        and(
          eq(playlists.instanceId, instanceId),
          sql`lower(${playlists.name}) = lower(${name})`,
        ),
      )
      .get();

    return row === undefined ? undefined : this.#toDetail(row);
  }

  async findDefault(instanceId: string): Promise<PlaylistDetail | undefined> {
    const row = this.#db
      .select()
      .from(playlists)
      .where(and(eq(playlists.instanceId, instanceId), eq(playlists.isDefault, true)))
      .get();

    return row === undefined ? undefined : this.#toDetail(row);
  }

  async create(input: {
    instanceId: string;
    name: string;
    description: string | null;
    ownerUid: string | null;
  }): Promise<PlaylistSummary> {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      instanceId: input.instanceId,
      name: input.name,
      description: input.description,
      ownerUid: input.ownerUid,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };

    this.#db.insert(playlists).values(row).run();
    return this.#toSummary(row);
  }

  async rename(id: string, name: string): Promise<void> {
    this.#db
      .update(playlists)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(eq(playlists.id, id))
      .run();
  }

  async delete(id: string): Promise<void> {
    // Tracks go with it through the schema's cascade.
    this.#db.delete(playlists).where(eq(playlists.id, id)).run();
  }

  async setDefault(instanceId: string, playlistId: string | null): Promise<void> {
    const now = new Date().toISOString();

    // Demote first, then promote, in one transaction: doing it in two steps outside a
    // transaction leaves a window where two playlists both claim to be the default.
    this.#db.transaction((tx) => {
      tx.update(playlists)
        .set({ isDefault: false, updatedAt: now })
        .where(and(eq(playlists.instanceId, instanceId), eq(playlists.isDefault, true)))
        .run();

      if (playlistId !== null) {
        tx.update(playlists)
          .set({ isDefault: true, updatedAt: now })
          .where(and(eq(playlists.id, playlistId), eq(playlists.instanceId, instanceId)))
          .run();
      }
    });
  }

  async addTracks(playlistId: string, tracks: readonly Track[]): Promise<number> {
    if (tracks.length === 0) return 0;

    const now = new Date().toISOString();
    const start = this.#nextPosition(playlistId);

    this.#db
      .insert(playlistTracks)
      .values(
        tracks.map((track, offset) => ({
          id: randomUUID(),
          playlistId,
          position: start + offset,
          source: track.source,
          sourceId: track.sourceId,
          url: track.url,
          title: track.title,
          uploader: track.uploader,
          durationSec: track.durationSec,
          thumbnailUrl: track.thumbnailUrl,
          addedAt: now,
        })),
      )
      .run();

    this.#touch(playlistId, now);
    return tracks.length;
  }

  async removeTrack(playlistId: string, trackId: string): Promise<void> {
    this.#db.transaction((tx) => {
      tx.delete(playlistTracks).where(eq(playlistTracks.id, trackId)).run();

      // Renumbered so positions stay contiguous; leaving a hole would make the numbers in
      // chat disagree with the numbers on screen.
      const remaining = tx
        .select({ id: playlistTracks.id })
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, playlistId))
        .orderBy(asc(playlistTracks.position))
        .all();

      remaining.forEach((row, index) => {
        tx.update(playlistTracks)
          .set({ position: index })
          .where(eq(playlistTracks.id, row.id))
          .run();
      });
    });

    this.#touch(playlistId, new Date().toISOString());
  }

  async reorder(playlistId: string, trackId: string, toIndex: number): Promise<void> {
    this.#db.transaction((tx) => {
      const rows = tx
        .select({ id: playlistTracks.id })
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, playlistId))
        .orderBy(asc(playlistTracks.position))
        .all();

      const from = rows.findIndex((row) => row.id === trackId);
      if (from === -1) return;

      const [moved] = rows.splice(from, 1);
      if (moved === undefined) return;
      rows.splice(Math.min(Math.max(0, toIndex), rows.length), 0, moved);

      rows.forEach((row, index) => {
        tx.update(playlistTracks)
          .set({ position: index })
          .where(eq(playlistTracks.id, row.id))
          .run();
      });
    });

    this.#touch(playlistId, new Date().toISOString());
  }

  // ─── internals ──────────────────────────────────────────────────────────

  #nextPosition(playlistId: string): number {
    const row = this.#db
      .select({ max: sql<number | null>`max(${playlistTracks.position})` })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlistId))
      .get();

    return (row?.max ?? -1) + 1;
  }

  #touch(playlistId: string, at: string): void {
    this.#db.update(playlists).set({ updatedAt: at }).where(eq(playlists.id, playlistId)).run();
  }

  #tracksOf(playlistId: string): PlaylistTrack[] {
    const rows = this.#db
      .select()
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlistId))
      .orderBy(asc(playlistTracks.position))
      .all();

    return rows.map((row) => toPlaylistTrack(row));
  }

  #toSummary(row: PlaylistRow): PlaylistSummary {
    const tracks = this.#tracksOf(row.id);
    return {
      id: row.id,
      instanceId: row.instanceId,
      name: row.name,
      description: row.description,
      ownerUid: row.ownerUid,
      isDefault: row.isDefault,
      trackCount: tracks.length,
      totalDurationSec: tracks.reduce((sum, item) => sum + (item.track.durationSec ?? 0), 0),
      updatedAt: row.updatedAt,
    };
  }

  #toDetail(row: PlaylistRow): PlaylistDetail {
    return { ...this.#toSummary(row), tracks: this.#tracksOf(row.id) };
  }
}

function toPlaylistTrack(row: TrackRow): PlaylistTrack {
  return {
    id: row.id,
    position: row.position,
    addedAt: row.addedAt,
    track: {
      source: row.source === 'direct' ? 'direct' : 'youtube',
      sourceId: row.sourceId,
      url: row.url,
      title: row.title,
      uploader: row.uploader,
      durationSec: row.durationSec,
      thumbnailUrl: row.thumbnailUrl,
      // Nothing playable is stored as a livestream: a stream has no fixed content to save.
      isLive: false,
    },
  };
}
