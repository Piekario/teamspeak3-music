import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChannelClient } from '../domain/bot-client.ts';
import { SoloWatcher } from './solo-watcher.ts';

const silentLogger = { debug: () => {}, warn: () => {} };

function client(uid: string): ChannelClient {
  return { clid: 1, uid, nickname: uid, serverGroupIds: [] };
}

/** The bot is always in its own channel listing, so one entry means it is alone. */
const ALONE = [client('bot')];
const WITH_LISTENER = [client('bot'), client('alice')];

function build(options: { enabled?: boolean; clients?: readonly ChannelClient[] } = {}) {
  const state = {
    playing: true,
    paused: false,
    pauses: 0,
    resumes: 0,
    enabled: options.enabled ?? true,
    clients: options.clients ?? ALONE,
    failRead: false,
  };

  const watcher = new SoloWatcher({
    instanceId: 'party',
    logger: silentLogger,
    isEnabled: () => state.enabled,
    isPlaying: () => state.playing,
    isPaused: () => state.paused,
    listChannelClients: async () => {
      if (state.failRead) throw new Error('socket wedged');
      return state.clients;
    },
    pause: async () => {
      state.pauses += 1;
      state.playing = false;
      state.paused = true;
    },
    resume: async () => {
      state.resumes += 1;
      state.playing = true;
      state.paused = false;
    },
  });

  return { watcher, state };
}

describe('SoloWatcher pausing', () => {
  it('pauses when the bot is the only one left', async () => {
    const { watcher, state } = build({ clients: ALONE });

    await watcher.check();

    assert.equal(state.pauses, 1);
    assert.ok(state.paused);
  });

  it('does not pause while somebody is listening', async () => {
    const { watcher, state } = build({ clients: WITH_LISTENER });

    await watcher.check();

    assert.equal(state.pauses, 0);
  });

  it('does not pause twice while still alone', async () => {
    const { watcher, state } = build({ clients: ALONE });

    await watcher.check();
    await watcher.check();

    assert.equal(state.pauses, 1);
  });

  it('does nothing when nothing is playing', async () => {
    const { watcher, state } = build({ clients: ALONE });
    state.playing = false;

    await watcher.check();

    assert.equal(state.pauses, 0);
  });

  it('does nothing when the feature is switched off', async () => {
    const { watcher, state } = build({ clients: ALONE, enabled: false });

    await watcher.check();

    assert.equal(state.pauses, 0);
  });
});

describe('SoloWatcher resuming', () => {
  it('resumes when somebody comes back', async () => {
    const { watcher, state } = build({ clients: ALONE });
    await watcher.check();
    assert.equal(state.pauses, 1);

    state.clients = WITH_LISTENER;
    await watcher.check();

    assert.equal(state.resumes, 1);
    assert.ok(state.playing);
  });

  it('never resumes a pause somebody made deliberately', async () => {
    // The whole point of tracking who paused: a manual pause must survive people arriving.
    const { watcher, state } = build({ clients: WITH_LISTENER });
    state.playing = false;
    state.paused = true;

    await watcher.check();

    assert.equal(state.resumes, 0);
  });

  it('does not resume a track that was stopped while nobody was listening', async () => {
    const { watcher, state } = build({ clients: ALONE });
    await watcher.check();

    // Somebody stopped playback entirely in the meantime.
    state.paused = false;
    state.playing = false;
    state.clients = WITH_LISTENER;
    await watcher.check();

    assert.equal(state.resumes, 0, 'resuming here would restart something nobody asked for');
  });

  it('releases its own pause when the feature is switched off', async () => {
    const { watcher, state } = build({ clients: ALONE });
    await watcher.check();
    assert.ok(state.paused);

    state.enabled = false;
    await watcher.check();

    assert.equal(state.resumes, 1, 'turning the setting off must not strand the music paused');
  });
});

describe('SoloWatcher robustness', () => {
  it('treats a failed read as unknown rather than empty', async () => {
    // Pausing on a dropped request would stop the music for everyone over one glitch.
    const { watcher, state } = build({ clients: ALONE });
    state.failRead = true;

    await watcher.check();

    assert.equal(state.pauses, 0);
  });

  it('treats an empty listing as unknown, not as silence', async () => {
    // An empty list means the bot has not joined yet, not that a full channel emptied.
    const { watcher, state } = build({ clients: [] });

    await watcher.check();

    assert.equal(state.pauses, 0);
  });

  it('forgets its pause once stopped', async () => {
    const { watcher, state } = build({ clients: ALONE });
    await watcher.check();

    watcher.stop();
    state.clients = WITH_LISTENER;
    await watcher.check();

    assert.equal(state.resumes, 0, 'a stopped watcher owns no pause to release');
  });
});
