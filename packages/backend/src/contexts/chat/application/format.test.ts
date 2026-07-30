import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PlayerState, QueueItem, Track } from '@tsmusic/shared';

import { TS3_MESSAGE_LIMIT } from '../../instances/infrastructure/clientquery/chat-message.ts';
import { formatDuration, formatNowPlaying, formatQueuePage, formatTrack } from './format.ts';

function track(overrides: Partial<Track> = {}): Track {
  return {
    source: 'youtube',
    sourceId: 'abc',
    url: 'https://youtu.be/abc',
    title: 'A Track',
    uploader: 'An Uploader',
    durationSec: 245,
    thumbnailUrl: null,
    isLive: false,
    ...overrides,
  };
}

function item(index: number): QueueItem {
  return {
    id: `q${index}`,
    track: track({ title: `Track ${index}` }),
    requestedBy: { uid: `uid-${index}`, nickname: `User${index}` },
    enqueuedAt: '2026-07-30T20:00:00.000Z',
  };
}

function state(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    status: 'playing',
    current: item(1),
    positionSec: 60,
    positionUpdatedAt: '2026-07-30T20:00:00.000Z',
    volume: 40,
    repeat: 'off',
    queue: [],
    error: null,
    ...overrides,
  };
}

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    assert.equal(formatDuration(245), '4:05');
    assert.equal(formatDuration(59), '0:59');
  });

  it('formats past an hour', () => {
    assert.equal(formatDuration(3_723), '1:02:03');
  });

  it('calls an unknown duration live rather than zero', () => {
    assert.equal(formatDuration(null), 'live');
  });
});

describe('formatTrack', () => {
  it('includes uploader and duration', () => {
    assert.equal(formatTrack(track()), 'A Track — An Uploader [4:05]');
  });

  it('omits the uploader when there is none', () => {
    assert.equal(formatTrack(track({ uploader: null })), 'A Track [4:05]');
  });
});

describe('formatNowPlaying', () => {
  it('says so plainly when nothing is playing', () => {
    assert.equal(formatNowPlaying(state({ current: null })), 'Nothing is playing.');
  });

  it('shows a progress bar, position and requester', () => {
    const text = formatNowPlaying(state());

    assert.match(text, /Now playing: Track 1/);
    assert.match(text, /1:00 \/ 4:05/);
    assert.match(text, /\[=+-+\]/);
    assert.match(text, /Requested by User1/);
  });

  it('omits the bar for a livestream of unknown length', () => {
    const live = state({ current: { ...item(1), track: track({ durationSec: null, isLive: true }) } });
    const text = formatNowPlaying(live);

    assert.match(text, /\(live\)/);
    assert.ok(!text.includes('['), 'a progress bar over unknown length is meaningless');
  });

  it('mentions repeat only when it is on', () => {
    assert.ok(!formatNowPlaying(state()).includes('repeat'));
    assert.match(formatNowPlaying(state({ repeat: 'queue' })), /repeat queue/);
  });
});

describe('formatQueuePage', () => {
  it('says so when the queue is empty', () => {
    assert.equal(formatQueuePage([], 1).text, 'The queue is empty.');
  });

  it('numbers entries continuously across pages', () => {
    const items = Array.from({ length: 25 }, (_, i) => item(i + 1));

    const second = formatQueuePage(items, 2);

    assert.equal(second.page, 2);
    assert.equal(second.pageCount, 3);
    assert.match(second.text, /^11\. /m, 'page 2 starts at entry 11, not at 1');
    assert.match(second.text, /^20\. /m);
  });

  it('clamps a page beyond the end instead of showing nothing', () => {
    const items = Array.from({ length: 12 }, (_, i) => item(i + 1));
    assert.equal(formatQueuePage(items, 99).page, 2);
    assert.equal(formatQueuePage(items, -5).page, 1);
  });

  it('reports the total count and duration', () => {
    const items = Array.from({ length: 3 }, (_, i) => item(i + 1));
    assert.match(formatQueuePage(items, 1).text, /3 tracks, 12:15 total/);
  });

  it('points at the web UI when the queue spans pages', () => {
    const items = Array.from({ length: 25 }, (_, i) => item(i + 1));
    assert.match(formatQueuePage(items, 1, 'http://bot.local').text, /Full queue: http:\/\/bot\.local/);
  });

  it('keeps a page within the TeamSpeak message limit', () => {
    // Paging exists precisely because TeamSpeak refuses anything longer than 1024 chars.
    const items = Array.from({ length: 200 }, (_, i) => item(i + 1));
    assert.ok(formatQueuePage(items, 1).text.length <= TS3_MESSAGE_LIMIT);
  });
});
