import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QueueItem, Requester, Track } from '@tsmusic/shared';

import { ok, type Result } from '../../../shared-kernel/result.ts';
import type {
  PlaylistListing,
  ResolvedTrack,
  ResolveError,
  TrackResolver,
} from '../../playback/domain/ports.ts';
import type {
  PlaylistDetail,
  PlaylistRepository,
  PlaylistSummary,
} from '../domain/repositories.ts';
import { PlaylistService, type QueueSink } from './playlist-service.ts';

const requester: Requester = { uid: 'uid-1', nickname: 'Someone' };

function track(title: string): Track {
  return {
    source: 'youtube',
    sourceId: title,
    url: `https://youtu.be/${title}`,
    title,
    uploader: null,
    durationSec: 100,
    thumbnailUrl: null,
    isLive: false,
  };
}

function queueItem(title: string): QueueItem {
  return {
    id: `q-${title}`,
    track: track(title),
    requestedBy: requester,
    queuedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** An in-memory stand-in that keeps the parts of the contract the service leans on. */
class FakeRepository implements PlaylistRepository {
  readonly playlists = new Map<string, PlaylistDetail>();
  #nextId = 1;

  async list(instanceId: string): Promise<readonly PlaylistSummary[]> {
    return [...this.playlists.values()].filter((item) => item.instanceId === instanceId);
  }

  async findById(id: string): Promise<PlaylistDetail | undefined> {
    return this.playlists.get(id);
  }

  async findByName(instanceId: string, name: string): Promise<PlaylistDetail | undefined> {
    return [...this.playlists.values()].find(
      (item) => item.instanceId === instanceId && item.name.toLowerCase() === name.toLowerCase(),
    );
  }

  async findDefault(instanceId: string): Promise<PlaylistDetail | undefined> {
    return [...this.playlists.values()].find(
      (item) => item.instanceId === instanceId && item.isDefault,
    );
  }

  async create(input: {
    instanceId: string;
    name: string;
    description: string | null;
    ownerUid: string | null;
  }): Promise<PlaylistSummary> {
    const created: PlaylistDetail = {
      id: `pl-${this.#nextId++}`,
      instanceId: input.instanceId,
      name: input.name,
      description: input.description,
      ownerUid: input.ownerUid,
      isDefault: false,
      trackCount: 0,
      totalDurationSec: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
      tracks: [],
    };
    this.playlists.set(created.id, created);
    return created;
  }

  async rename(id: string, name: string): Promise<void> {
    const found = this.playlists.get(id);
    if (found !== undefined) this.playlists.set(id, { ...found, name });
  }

  async delete(id: string): Promise<void> {
    this.playlists.delete(id);
  }

  async setDefault(instanceId: string, playlistId: string | null): Promise<void> {
    for (const [id, item] of this.playlists) {
      if (item.instanceId !== instanceId) continue;
      this.playlists.set(id, { ...item, isDefault: id === playlistId });
    }
  }

  async addTracks(playlistId: string, tracks: readonly Track[]): Promise<number> {
    const found = this.playlists.get(playlistId);
    if (found === undefined) return 0;

    const added = tracks.map((item, index) => ({
      id: `t-${found.tracks.length + index}`,
      position: found.tracks.length + index,
      track: item,
      addedAt: '2026-01-01T00:00:00.000Z',
    }));

    this.playlists.set(playlistId, {
      ...found,
      tracks: [...found.tracks, ...added],
      trackCount: found.tracks.length + added.length,
    });
    return tracks.length;
  }

  async removeTrack(): Promise<void> {}
  async reorder(): Promise<void> {}
}

class FakeQueue implements QueueSink {
  queueItems: readonly QueueItem[] = [];
  session: { current: QueueItem | null } = { current: null };
  readonly enqueued: Track[] = [];
  /** Tracks beyond this are refused, standing in for the queue's own limits. */
  capacity = Number.POSITIVE_INFINITY;

  async enqueueTracks(tracks: readonly Track[]) {
    const accepted = tracks.slice(0, Math.max(0, this.capacity - this.enqueued.length));
    this.enqueued.push(...accepted);
    return { queued: accepted.length, rejected: tracks.slice(accepted.length) };
  }
}

class FakeResolver implements TrackResolver {
  playlistUrls = new Set<string>();

  supports(url: string): boolean {
    return url.startsWith('https://');
  }

  isPlaylist(url: string): boolean {
    return this.playlistUrls.has(url);
  }

  async resolveUrl(url: string): Promise<Result<ResolvedTrack, ResolveError>> {
    return ok({ track: track(url), streamUrl: `${url}/stream`, expiresAt: null });
  }

  async resolvePlaylist(): Promise<Result<PlaylistListing, ResolveError>> {
    return ok({ title: 'Imported', tracks: [track('a'), track('b')], omitted: 3 });
  }

  async search(): Promise<Result<readonly Track[], ResolveError>> {
    return ok([]);
  }

  async refresh(item: Track): Promise<Result<ResolvedTrack, ResolveError>> {
    return ok({ track: item, streamUrl: item.url, expiresAt: null });
  }
}

function build() {
  const repository = new FakeRepository();
  const playback = new FakeQueue();
  const resolver = new FakeResolver();
  const service = new PlaylistService({
    instanceId: 'party',
    repository,
    resolvers: [resolver],
    playback,
  });

  return { service, repository, playback, resolver };
}

describe('PlaylistService naming', () => {
  it('refuses a name that is already taken', async () => {
    const { service } = build();
    await service.create('Party', null, null);

    const second = await service.create('party', null, null);

    // Case-insensitively: the name is how chat addresses a playlist, so two that differ only
    // in case would make `!playlist load party` ambiguous.
    assert.equal(second.ok, false);
  });

  it('lets a playlist keep its own name when renamed', async () => {
    const { service } = build();
    const created = await service.create('Party', null, null);
    assert.ok(created.ok);

    const renamed = await service.rename(created.value.id, 'Party');

    assert.equal(renamed.ok, true);
  });

  it('finds a playlist by name or by id', async () => {
    const { service } = build();
    const created = await service.create('Party', null, null);
    assert.ok(created.ok);

    assert.equal((await service.find('PARTY'))?.id, created.value.id);
    assert.equal((await service.find(created.value.id))?.id, created.value.id);
  });
});

describe('PlaylistService loading', () => {
  it('queues every track of a playlist', async () => {
    const { service, repository, playback } = build();
    const created = await service.create('Party', null, null);
    assert.ok(created.ok);
    await repository.addTracks(created.value.id, [track('a'), track('b')]);

    const loaded = await service.load('Party', requester);

    assert.ok(loaded.ok);
    assert.equal(loaded.value.queued, 2);
    assert.equal(playback.enqueued.length, 2);
  });

  it('reports the tracks the queue refused rather than failing', async () => {
    // Partial success is the normal outcome — a per-user cap stops some entries — and a
    // caller that saw only "failed" would have no way to say "queued 1 of 2".
    const { service, repository, playback } = build();
    playback.capacity = 1;
    const created = await service.create('Party', null, null);
    assert.ok(created.ok);
    await repository.addTracks(created.value.id, [track('a'), track('b')]);

    const loaded = await service.load('Party', requester);

    assert.ok(loaded.ok);
    assert.equal(loaded.value.queued, 1);
    assert.equal(loaded.value.rejected, 1);
  });

  it('refuses to load a playlist with nothing in it', async () => {
    const { service } = build();
    await service.create('Empty', null, null);

    const loaded = await service.load('Empty', requester);

    assert.equal(loaded.ok, false);
  });

  it('says which playlist was not found', async () => {
    const { service } = build();

    const loaded = await service.load('nope', requester);

    assert.equal(loaded.ok, false);
    assert.deepEqual(loaded.ok ? null : loaded.error, {
      kind: 'playlist/not-found',
      name: 'nope',
    });
  });
});

describe('PlaylistService default playlist', () => {
  it('refills from the default', async () => {
    const { service, repository, playback } = build();
    const created = await service.create('Fallback', null, null);
    assert.ok(created.ok);
    await repository.addTracks(created.value.id, [track('a')]);
    await service.setDefault(created.value.id);

    const refilled = await service.loadDefault(requester);

    assert.equal(refilled?.queued, 1);
    assert.equal(playback.enqueued.length, 1);
  });

  it('stays quiet when no default is set', async () => {
    // The caller announces a refill on the channel, so "nothing happened" has to be
    // distinguishable from "happened with zero tracks" or the bot talks for no reason.
    const { service } = build();

    assert.equal(await service.loadDefault(requester), undefined);
  });

  it('stays quiet when the default is empty', async () => {
    const { service } = build();
    const created = await service.create('Fallback', null, null);
    assert.ok(created.ok);
    await service.setDefault(created.value.id);

    assert.equal(await service.loadDefault(requester), undefined);
  });

  it('moves the default rather than adding a second one', async () => {
    const { service, repository } = build();
    const first = await service.create('One', null, null);
    const second = await service.create('Two', null, null);
    assert.ok(first.ok && second.ok);

    await service.setDefault(first.value.id);
    await service.setDefault(second.value.id);

    const defaults = [...repository.playlists.values()].filter((item) => item.isDefault);
    assert.deepEqual(
      defaults.map((item) => item.name),
      ['Two'],
    );
  });
});

describe('PlaylistService saving and importing', () => {
  it('saves the current track ahead of the queue', async () => {
    // Somebody saving a session mid-song means the song they are hearing.
    const { service, repository, playback } = build();
    playback.session.current = queueItem('playing');
    playback.queueItems = [queueItem('next')];

    const saved = await service.saveCurrentQueue('Session', null);

    assert.ok(saved.ok);
    assert.deepEqual(
      repository.playlists.get(saved.value.id)?.tracks.map((item) => item.track.title),
      ['playing', 'next'],
    );
  });

  it('refuses to save when nothing is playing and the queue is empty', async () => {
    const { service } = build();

    const saved = await service.saveCurrentQueue('Session', null);

    assert.equal(saved.ok, false);
  });

  it('adds a single track from a link', async () => {
    const { service, repository } = build();
    const created = await service.create('Party', null, null);
    assert.ok(created.ok);

    const added = await service.addFromUrl(created.value.id, 'https://youtu.be/one');

    assert.ok(added.ok);
    assert.equal(added.value.added, 1);
    assert.equal(repository.playlists.get(created.value.id)?.tracks.length, 1);
  });

  it('adds every entry of a playlist link and reports what was left out', async () => {
    const { service, resolver } = build();
    resolver.playlistUrls.add('https://youtube.com/playlist?list=x');
    const created = await service.create('Party', null, null);
    assert.ok(created.ok);

    const added = await service.addFromUrl(created.value.id, 'https://youtube.com/playlist?list=x');

    assert.ok(added.ok);
    assert.equal(added.value.added, 2);
    assert.equal(added.value.omitted, 3);
  });

  it('refuses a link no resolver claims', async () => {
    const { service } = build();
    const created = await service.create('Party', null, null);
    assert.ok(created.ok);

    const added = await service.addFromUrl(created.value.id, 'ftp://example.com/song.mp3');

    assert.equal(added.ok, false);
  });
});
