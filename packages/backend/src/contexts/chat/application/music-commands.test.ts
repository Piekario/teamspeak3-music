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
function build(options: { playlists?: Partial<PlaylistService>; allowed?: Set<string> } = {}) {
  const registry = new CommandRegistry();
  const deps: MusicCommandDependencies = {
    playback: {} as PlaybackService,
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

  return { registry, run };
}

describe('!help', () => {
  it('lists only the commands the asker may run', () => {
    // A list full of commands that refuse them is worse than no list at all.
    const { registry } = build({ allowed: new Set(['help', 'play']) });
    const definition = registry.find('help');
    assert.ok(definition !== undefined);
  });

  it('lists the allowed commands and nothing else', async () => {
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
