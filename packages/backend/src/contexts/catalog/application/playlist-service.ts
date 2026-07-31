import type { QueueItem, Requester, Track } from '@tsmusic/shared';

import { err, ok, type Result } from '../../../shared-kernel/result.ts';
import type { ResolveError, TrackResolver } from '../../playback/domain/ports.ts';
import type {
  PlaylistDetail,
  PlaylistRepository,
  PlaylistSummary,
} from '../domain/repositories.ts';

export type PlaylistError =
  | { readonly kind: 'playlist/not-found'; readonly name: string }
  | { readonly kind: 'playlist/name-taken'; readonly name: string }
  | { readonly kind: 'playlist/empty'; readonly name: string }
  | { readonly kind: 'playlist/nothing-to-save' }
  | ResolveError;

export interface PlaylistImportResult {
  readonly added: number;
  /** Entries the source had beyond the import limit; reported rather than silently dropped. */
  readonly omitted: number;
}

export interface PlaylistLoadResult {
  readonly playlist: PlaylistSummary;
  readonly queued: number;
  readonly rejected: number;
}

/**
 * The slice of playback a playlist needs: somewhere to put tracks, and a view of what is
 * already there so a queue can be saved.
 *
 * Declared here rather than importing the playback service, so this context depends on a
 * handful of methods instead of on another context's application service — and so the whole
 * of it can be tested without a queue, an audio output or a resolver.
 */
export interface QueueSink {
  readonly queueItems: readonly QueueItem[];
  readonly session: { readonly current: QueueItem | null };
  enqueueTracks(
    tracks: readonly Track[],
    requester: Requester,
  ): Promise<{ readonly queued: number; readonly rejected: readonly Track[] }>;
}

export interface PlaylistServiceOptions {
  readonly instanceId: string;
  readonly repository: PlaylistRepository;
  readonly resolvers: readonly TrackResolver[];
  readonly playback: QueueSink;
  /** How many entries a single YouTube playlist import may contribute. */
  readonly importLimit?: number;
}

const DEFAULT_IMPORT_LIMIT = 200;

/**
 * Playlists as saved sets of tracks, and the things worth doing with them.
 *
 * Deliberately separate from the queue: a queue is what is about to play and is destroyed by
 * playing it, while a playlist survives. Loading one copies its tracks into the queue rather
 * than handing the queue a reference, so shuffling or skipping does not quietly rewrite what
 * somebody saved.
 *
 * The instance is fixed at construction because playlists are scoped to one bot — two bots on
 * two TeamSpeak servers share neither identities nor an audience, and "the default playlist"
 * has to mean one thing per bot.
 */
export class PlaylistService {
  readonly #options: PlaylistServiceOptions;

  constructor(options: PlaylistServiceOptions) {
    this.#options = options;
  }

  list(): Promise<readonly PlaylistSummary[]> {
    return this.#options.repository.list(this.#options.instanceId);
  }

  findById(id: string): Promise<PlaylistDetail | undefined> {
    return this.#options.repository.findById(id);
  }

  async create(
    name: string,
    description: string | null,
    ownerUid: string | null,
  ): Promise<Result<PlaylistSummary, PlaylistError>> {
    const existing = await this.#options.repository.findByName(this.#options.instanceId, name);
    if (existing !== undefined) return err({ kind: 'playlist/name-taken', name });

    return ok(
      await this.#options.repository.create({
        instanceId: this.#options.instanceId,
        name,
        description,
        ownerUid,
      }),
    );
  }

  async rename(id: string, name: string): Promise<Result<void, PlaylistError>> {
    const clash = await this.#options.repository.findByName(this.#options.instanceId, name);
    if (clash !== undefined && clash.id !== id) return err({ kind: 'playlist/name-taken', name });

    await this.#options.repository.rename(id, name);
    return ok(undefined);
  }

  async delete(id: string): Promise<void> {
    await this.#options.repository.delete(id);
  }

  async setDefault(playlistId: string | null): Promise<void> {
    await this.#options.repository.setDefault(this.#options.instanceId, playlistId);
  }

  /**
   * Adds whatever a link names — one track or a whole YouTube playlist.
   *
   * Playlist entries are stored as metadata, without stream URLs: those are bound to an IP
   * and expire within hours, so a saved one would be worthless by the time anybody played it.
   */
  async addFromUrl(
    playlistId: string,
    url: string,
  ): Promise<Result<PlaylistImportResult, PlaylistError>> {
    const limit = this.#options.importLimit ?? DEFAULT_IMPORT_LIMIT;
    const playlistResolver = this.#options.resolvers.find((resolver) => resolver.isPlaylist(url));

    if (playlistResolver !== undefined) {
      const listing = await playlistResolver.resolvePlaylist(url, limit);
      if (!listing.ok) return listing;

      const added = await this.#options.repository.addTracks(playlistId, listing.value.tracks);
      return ok({ added, omitted: listing.value.omitted });
    }

    const resolver = this.#options.resolvers.find((candidate) => candidate.supports(url));
    if (resolver === undefined) return err({ kind: 'resolve/unsupported-url', url });

    const resolved = await resolver.resolveUrl(url);
    if (!resolved.ok) return resolved;

    const added = await this.#options.repository.addTracks(playlistId, [resolved.value.track]);
    return ok({ added, omitted: 0 });
  }

  async addTracks(playlistId: string, tracks: readonly Track[]): Promise<number> {
    return this.#options.repository.addTracks(playlistId, tracks);
  }

  async removeTrack(playlistId: string, trackId: string): Promise<void> {
    await this.#options.repository.removeTrack(playlistId, trackId);
  }

  async reorder(playlistId: string, trackId: string, toIndex: number): Promise<void> {
    await this.#options.repository.reorder(playlistId, trackId, toIndex);
  }

  /**
   * Saves what is playing and what is waiting, under a name.
   *
   * The current track is included and comes first: somebody saving a session mid-song means
   * the song they are hearing, and leaving it out would be a surprise nobody wants twice.
   */
  async saveCurrentQueue(
    name: string,
    ownerUid: string | null,
  ): Promise<Result<PlaylistSummary, PlaylistError>> {
    const current = this.#options.playback.session.current;
    const queued = this.#options.playback.queueItems.map((item) => item.track);
    const tracks = current === null ? queued : [current.track, ...queued];

    if (tracks.length === 0) return err({ kind: 'playlist/nothing-to-save' });

    const created = await this.create(name, null, ownerUid);
    if (!created.ok) return created;

    await this.#options.repository.addTracks(created.value.id, tracks);
    return ok(created.value);
  }

  /** Resolves the name people type in chat, falling back to the id the panel uses. */
  async find(nameOrId: string): Promise<PlaylistDetail | undefined> {
    const byName = await this.#options.repository.findByName(this.#options.instanceId, nameOrId);
    return byName ?? (await this.#options.repository.findById(nameOrId));
  }

  /** Queues every track of a playlist the queue will accept, and starts playing if idle. */
  async load(
    nameOrId: string,
    requester: Requester,
  ): Promise<Result<PlaylistLoadResult, PlaylistError>> {
    const playlist = await this.find(nameOrId);
    if (playlist === undefined) return err({ kind: 'playlist/not-found', name: nameOrId });
    if (playlist.tracks.length === 0) {
      return err({ kind: 'playlist/empty', name: playlist.name });
    }

    const result = await this.#options.playback.enqueueTracks(
      playlist.tracks.map((item) => item.track),
      requester,
    );

    return ok({ playlist, queued: result.queued, rejected: result.rejected.length });
  }

  /**
   * Tops the queue up from the instance's default playlist.
   *
   * Reports whether anything was queued so the caller can stay quiet when there is no
   * default — a bot that announced "nothing to play" every time a queue ran out would be
   * unbearable on a busy server.
   */
  async loadDefault(requester: Requester): Promise<PlaylistLoadResult | undefined> {
    const playlist = await this.#options.repository.findDefault(this.#options.instanceId);
    if (playlist === undefined || playlist.tracks.length === 0) return undefined;

    const result = await this.#options.playback.enqueueTracks(
      playlist.tracks.map((item) => item.track),
      requester,
    );

    return result.queued === 0
      ? undefined
      : { playlist, queued: result.queued, rejected: result.rejected.length };
  }
}

export function describePlaylistError(error: PlaylistError): string {
  switch (error.kind) {
    case 'playlist/not-found':
      return `There is no playlist called "${error.name}".`;
    case 'playlist/name-taken':
      return `A playlist called "${error.name}" already exists.`;
    case 'playlist/empty':
      return `"${error.name}" has no tracks in it yet.`;
    case 'playlist/nothing-to-save':
      return 'Nothing is playing and the queue is empty, so there is nothing to save.';
    case 'resolve/unsupported-url':
      return `I do not know how to read ${error.url}.`;
    case 'resolve/not-found':
      return `Nothing found for "${error.query}".`;
    case 'resolve/age-restricted':
      return 'That one is age-restricted — YouTube only serves it to a signed-in, verified account.';
    case 'resolve/blocked':
      return `That source refused the request: ${error.detail}`;
    case 'resolve/timeout':
      return 'Looking that up took too long.';
    case 'resolve/tool-failure':
      return `Could not read that: ${error.detail}`;
  }
}
