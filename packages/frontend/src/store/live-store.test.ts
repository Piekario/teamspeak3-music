import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AppEvent, PlayerState, QueueItem } from '@tsmusic/shared';

import { EMPTY_INSTANCE, reduce } from './live-store.ts';

function playerState(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    status: 'playing',
    current: null,
    positionSec: 0,
    positionUpdatedAt: '2026-07-31T10:00:00.000Z',
    volume: 40,
    repeat: 'off',
    queue: [],
    error: null,
    ...overrides,
  };
}

function queueItem(id: string): QueueItem {
  return {
    id,
    track: {
      source: 'youtube',
      sourceId: id,
      url: `https://youtu.be/${id}`,
      title: `Track ${id}`,
      uploader: null,
      durationSec: 120,
      thumbnailUrl: null,
      isLive: false,
    },
    requestedBy: { uid: 'uid-alice', nickname: 'Alice' },
    enqueuedAt: '2026-07-31T10:00:00.000Z',
  };
}

function event<T extends AppEvent['type']>(
  type: T,
  payload: Extract<AppEvent, { type: T }>['payload'],
): AppEvent {
  return { type, payload, instanceId: 'party', at: '2026-07-31T10:00:00.000Z' } as AppEvent;
}

describe('live store reducer', () => {
  it('stores a full player state', () => {
    const next = reduce(EMPTY_INSTANCE, event('player.state', playerState({ volume: 80 })));
    assert.equal(next.player?.volume, 80);
  });

  it('merges a queue delta into the existing state', () => {
    const withPlayer = reduce(EMPTY_INSTANCE, event('player.state', playerState({ volume: 80 })));

    const next = reduce(withPlayer, event('queue.changed', { queue: [queueItem('q1')] }));

    assert.equal(next.player?.queue.length, 1);
    assert.equal(next.player?.volume, 80, 'a queue delta must not clobber the rest of the state');
  });

  it('ignores a queue delta arriving before any full state', () => {
    const next = reduce(EMPTY_INSTANCE, event('queue.changed', { queue: [queueItem('q1')] }));
    assert.equal(next.player, null);
  });

  it('records connection status and channel occupancy', () => {
    const next = reduce(
      EMPTY_INSTANCE,
      event('instance.status', {
        connection: 'connected',
        error: null,
        channel: { id: 5, name: 'Music' },
        clients: [{ clid: 7, uid: 'uid-alice', nickname: 'Alice', serverGroupIds: [6] }],
      }),
    );

    assert.equal(next.connection, 'connected');
    assert.equal(next.channel?.name, 'Music');
    assert.equal(next.clients.length, 1);
  });

  it('surfaces a connection error rather than silently showing disconnected', () => {
    const next = reduce(
      EMPTY_INSTANCE,
      event('instance.status', {
        connection: 'error',
        error: 'ClientQuery socket closed',
        channel: null,
        clients: [],
      }),
    );

    assert.equal(next.connection, 'error');
    assert.equal(next.connectionError, 'ClientQuery socket closed');
  });

  it('prepends command log entries so the newest is first', () => {
    const first = reduce(
      EMPTY_INSTANCE,
      event('command.executed', {
        uid: 'uid-alice',
        nickname: 'Alice',
        command: 'play',
        args: 'a song',
        allowed: true,
        reply: 'Queued',
      }),
    );
    const second = reduce(
      first,
      event('command.executed', {
        uid: 'uid-bob',
        nickname: 'Bob',
        command: 'skip',
        args: '',
        allowed: false,
        reply: 'You need the dj role',
      }),
    );

    assert.equal(second.commandLog[0]?.command, 'skip');
    assert.equal(second.commandLog[1]?.command, 'play');
  });

  it('bounds the command log so a long party cannot grow it without limit', () => {
    let state = EMPTY_INSTANCE;
    for (let i = 0; i < 150; i += 1) {
      state = reduce(
        state,
        event('command.executed', {
          uid: 'uid-alice',
          nickname: 'Alice',
          command: `cmd${i}`,
          args: '',
          allowed: true,
          reply: null,
        }),
      );
    }

    assert.equal(state.commandLog.length, 100);
    assert.equal(state.commandLog[0]?.command, 'cmd149', 'the newest entries are kept');
  });

  it('leaves state untouched for events the read model does not need', () => {
    const withPlayer = reduce(EMPTY_INSTANCE, event('player.state', playerState()));

    const afterLog = reduce(
      withPlayer,
      event('log', { level: 'warn', message: 'yt-dlp is behaving oddly' }),
    );

    assert.equal(afterLog, withPlayer, 'identity is preserved so React skips a re-render');
  });
});
