import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CommandName } from '@tsmusic/shared';

import { FakeClock } from '../../../shared-kernel/clock.ts';
import type { PlaylistService } from '../../catalog/application/playlist-service.ts';
import type { PlaybackService } from '../../playback/application/playback-service.ts';
import type { BotClient } from '../../instances/domain/bot-client.ts';
import {
  CommandRegistry,
  type CommandContext,
  type CommandInvoker,
} from '../domain/command-definition.ts';
import { createMusicCommands, type MusicCommandDependencies } from './music-commands.ts';
import { PendingSearches } from './pending-searches.ts';

const clock = new FakeClock(0);

function invoker(role: CommandInvoker['role']): CommandInvoker {
  return { uid: 'uid-1', nickname: 'Someone', clientId: 1, role, serverGroupIds: [] };
}

function context(text: string, role: CommandInvoker['role'] = 'dj'): CommandContext {
  const [name = '', ...rest] = text.split(' ');
  return {
    invoker: invoker(role),
    command: { name, argumentText: rest.join(' '), arguments: rest },
    source: 'channel',
  };
}

/**
 * Builds the command set with only what the commands under test actually touch.
 *
 * `!help` and `!playlist` never reach playback or the TeamSpeak client, so those stay empty
 * stubs — filling them in would only obscure which collaborators these two really have.
 */
/** Records what the commands asked playback to do, without a queue or an audio output. */
class FakePlayback {
  isActive = false;
  readonly requests: Array<{ position?: number; url?: string; query?: string }> = [];
  skips = 0;

  get session() {
    return {
      isActive: this.isActive,
      current: null,
      toPlayerState: () => ({ status: 'idle', queue: [] }),
    };
  }

  isPlaylistUrl(): boolean {
    return false;
  }

  async request(input: { position?: number; url?: string; query?: string }) {
    this.requests.push(input);
    return {
      ok: true as const,
      value: { title: 'A Track', url: input.url ?? 'https://youtu.be/x', durationSec: 100 },
    };
  }

  async skip() {
    this.skips += 1;
    return { ok: true as const, value: undefined };
  }
}

function build(
  options: {
    playlists?: Partial<PlaylistService>;
    allowed?: Set<string>;
    playback?: FakePlayback;
  } = {},
) {
  const registry = new CommandRegistry();
  const playback = options.playback ?? new FakePlayback();
  const deps: MusicCommandDependencies = {
    playback: playback as unknown as PlaybackService,
    bot: {} as BotClient,
    pendingSearches: new PendingSearches(clock),
    clock,
    settings: () => ({ prefix: '!', homeChannelId: null }),
    registry: () => registry,
    canUse: (_who, command: CommandName) => options.allowed?.has(command) ?? true,
    playlists: () => options.playlists as PlaylistService | undefined,
  };

  registry.registerAll(createMusicCommands(deps));
  const run = async (text: string, role: CommandInvoker['role'] = 'dj') => {
    const parsed = context(text, role);
    const definition = registry.find(parsed.command.name);
    assert.ok(definition !== undefined, `no command '${parsed.command.name}'`);
    return (await definition.handler(parsed)).text;
  };

  return { run, playback };
}

describe('!play and !add', () => {
  it('puts !play at the front and cuts the current track short', async () => {
    // What people mean by "play this" is that they hear it now, not eventually.
    const playback = new FakePlayback();
    playback.isActive = true;
    const { run } = build({ playback });

    const answer = await run('play https://youtu.be/x');

    assert.equal(playback.requests[0]?.position, 0);
    assert.equal(playback.skips, 1);
    assert.match(answer, /Playing now/);
  });

  it('does not skip when nothing is playing', async () => {
    // The queue starts the track itself when the bot is idle, so a skip here would skip the
    // very track somebody just asked for.
    const playback = new FakePlayback();
    const { run } = build({ playback });

    const answer = await run('play https://youtu.be/x');

    assert.equal(playback.skips, 0);
    assert.match(answer, /Playing now/);
  });

  it('puts !add at the end and leaves the current track alone', async () => {
    const playback = new FakePlayback();
    playback.isActive = true;
    const { run } = build({ playback });

    const answer = await run('add https://youtu.be/x');

    assert.equal(playback.requests[0]?.position, undefined);
    assert.equal(playback.skips, 0);
    assert.match(answer, /Queued/);
  });

  it('says an added track is playing when the bot was idle', async () => {
    const playback = new FakePlayback();
    const { run } = build({ playback });

    assert.match(await run('add https://youtu.be/x'), /Playing now/);
  });

  it('leaves !playnext queueing at the front without interrupting', async () => {
    const playback = new FakePlayback();
    playback.isActive = true;
    const { run } = build({ playback });

    await run('playnext https://youtu.be/x');

    assert.equal(playback.requests[0]?.position, 0);
    assert.equal(playback.skips, 0);
  });

  it('asks what to play when given nothing', async () => {
    const { run, playback } = build();

    assert.match(await run('play'), /What should I play/);
    assert.equal(playback.requests.length, 0);
  });
});

describe('!help', () => {
  it('lists the allowed commands and nothing else', async () => {
    // A list full of commands that refuse them is worse than no list at all.
    const { run } = build({ allowed: new Set(['help', 'play']) });

    const answer = await run('help');

    assert.match(answer, /!play —/);
    assert.doesNotMatch(answer, /!skip/);
  });

  it('describes one command with its usage and aliases', async () => {
    const { run } = build();

    const answer = await run('help play');

    assert.match(answer, /Usage: !play/);
    assert.match(answer, /Also: !p/);
  });

  it('answers a forbidden command exactly as it answers an unknown one', async () => {
    // Telling somebody a command exists but is closed to them is an invitation to go looking
    // for a way in, so the two answers have to be indistinguishable.
    const { run } = build({ allowed: new Set(['help']) });

    const forbidden = await run('help skip');
    const unknown = await run('help nonsense');

    // Compared with the asked-for name substituted out: echoing back what somebody typed
    // reveals nothing, while any other difference would tell them the command exists.
    assert.equal(forbidden.replace('skip', 'X'), unknown.replace('nonsense', 'X'));
  });

  it('says so when the asker may run nothing at all', async () => {
    const { run } = build({ allowed: new Set() });

    assert.match(await run('help'), /cannot use any commands/i);
  });
});

describe('!playlist', () => {
  const playlist = {
    id: 'pl-1',
    instanceId: 'party',
    name: 'Party',
    description: null,
    ownerUid: null,
    isDefault: false,
    trackCount: 2,
    totalDurationSec: 200,
    updatedAt: '2026-01-01T00:00:00.000Z',
    tracks: [],
  };

  it('reports that playlists are unavailable rather than throwing', async () => {
    const { run } = build();

    assert.match(await run('playlist list'), /not available/i);
  });

  it('lists what is saved, marking the default', async () => {
    const { run } = build({
      playlists: { list: async () => [{ ...playlist, isDefault: true }] },
    });

    const answer = await run('playlist list');

    assert.match(answer, /Party — 2 tracks \(default\)/);
  });

  it('treats a bare !playlist as a listing', async () => {
    const { run } = build({ playlists: { list: async () => [] } });

    assert.match(await run('playlist'), /No playlists yet/);
  });

  it('queues a playlist by name', async () => {
    let requested: string | undefined;
    const { run } = build({
      playlists: {
        load: async (name: string) => {
          requested = name;
          return { ok: true, value: { playlist, queued: 2, rejected: 0 } };
        },
      },
    });

    const answer = await run('playlist load Party');

    assert.equal(requested, 'Party');
    assert.match(answer, /Queued 2 tracks from "Party"/);
  });

  it('keeps spaces in a playlist name', async () => {
    let requested: string | undefined;
    const { run } = build({
      playlists: {
        load: async (name: string) => {
          requested = name;
          return { ok: true, value: { playlist, queued: 1, rejected: 0 } };
        },
      },
    });

    await run('playlist load Friday Night');

    assert.equal(requested, 'Friday Night');
  });

  it('refuses to save for somebody who may not change playlists', async () => {
    let saved = false;
    const { run } = build({
      playlists: {
        saveCurrentQueue: async () => {
          saved = true;
          return { ok: true, value: playlist };
        },
      },
    });

    const answer = await run('playlist save Party', 'user');

    assert.equal(saved, false);
    assert.match(answer, /cannot change playlists/i);
  });

  it('lets a DJ save the queue', async () => {
    const { run } = build({
      playlists: { saveCurrentQueue: async () => ({ ok: true, value: playlist }) },
    });

    assert.match(await run('playlist save Party', 'dj'), /Saved the queue as "Party"/);
  });

  it('clears the default when asked for no playlist', async () => {
    // "Stop refilling" is a thing people want, and there is no other way to ask for it.
    let cleared: string | null | undefined;
    const { run } = build({
      playlists: {
        setDefault: async (id: string | null) => {
          cleared = id;
        },
      },
    });

    const answer = await run('playlist default', 'dj');

    assert.equal(cleared, null);
    assert.match(answer, /Cleared the default/);
  });

  it('reads the URL as the last word so names may contain spaces', async () => {
    let addedTo: string | undefined;
    let addedUrl: string | undefined;
    const { run } = build({
      playlists: {
        find: async () => playlist,
        addFromUrl: async (id: string, url: string) => {
          addedTo = id;
          addedUrl = url;
          return { ok: true, value: { added: 1, omitted: 0 } };
        },
      },
    });

    await run('playlist add Friday Night https://youtu.be/x', 'dj');

    assert.equal(addedTo, 'pl-1');
    assert.equal(addedUrl, 'https://youtu.be/x');
  });

  it('explains an unknown sub-command instead of failing silently', async () => {
    const { run } = build({ playlists: { list: async () => [] } });

    assert.match(await run('playlist frobnicate'), /do not know !playlist frobnicate/);
  });
});
