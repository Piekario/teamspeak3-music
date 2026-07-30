import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Requester, Track } from '@tsmusic/shared';

import { FakeClock } from '../../../shared-kernel/clock.ts';
import { PlaybackSession } from './playback-session.ts';
import { DEFAULT_QUEUE_LIMITS, Queue } from './queue.ts';
import { Volume } from './values.ts';

const AT = new Date('2026-07-30T20:00:00.000Z');

function track(overrides: Partial<Track> = {}): Track {
  return {
    source: 'youtube',
    sourceId: 'abc123',
    url: 'https://youtu.be/abc123',
    title: 'A Track',
    uploader: 'An Uploader',
    durationSec: 240,
    thumbnailUrl: null,
    isLive: false,
    ...overrides,
  };
}

const alice: Requester = { uid: 'uid-alice', nickname: 'Alice' };

function sessionWith(titles: string[] = []) {
  const clock = new FakeClock(0);
  const queue = new Queue(DEFAULT_QUEUE_LIMITS);
  for (const title of titles) queue.enqueue(track({ title }), alice, AT);
  const session = new PlaybackSession({ queue, clock });
  return { clock, queue, session };
}

/** Drives a session to PLAYING, the state most rules are about. */
function playing(titles: string[] = ['One']) {
  const context = sessionWith(titles);
  const claimed = context.session.beginResolving();
  assert.ok(claimed.ok);
  assert.ok(context.session.markStarted().ok);
  return context;
}

describe('PlaybackSession transitions', () => {
  it('starts idle with nothing playing', () => {
    const { session } = sessionWith();
    assert.equal(session.status, 'idle');
    assert.equal(session.current, null);
    assert.ok(!session.isActive);
  });

  it('claims the next queued item and moves to resolving', () => {
    const { session, queue } = sessionWith(['One', 'Two']);

    const claimed = session.beginResolving();
    assert.ok(claimed.ok);
    assert.equal(claimed.value.track.title, 'One');
    assert.equal(session.status, 'resolving');
    assert.equal(queue.length, 1, 'the claimed item leaves the queue');
  });

  it('reports an empty queue instead of pretending to start', () => {
    const { session } = sessionWith();
    const claimed = session.beginResolving();

    assert.ok(!claimed.ok);
    assert.equal(claimed.error.kind, 'playback/queue-empty');
    assert.equal(session.status, 'idle');
  });

  it('refuses to claim a second track while one is already playing', () => {
    const { session } = playing(['One', 'Two']);

    const claimed = session.beginResolving();
    assert.ok(!claimed.ok);
    assert.equal(claimed.error.kind, 'playback/illegal-transition');
    assert.equal(session.current?.track.title, 'One', 'the playing track is untouched');
  });

  it('refuses to pause when nothing is playing', () => {
    const { session } = sessionWith(['One']);
    const paused = session.pause();
    assert.ok(!paused.ok);
    assert.equal(paused.error.kind, 'playback/illegal-transition');
  });

  it('refuses to resume when not paused', () => {
    const { session } = playing();
    assert.ok(!session.prepareResume().ok);
  });
});

describe('PlaybackSession position', () => {
  it('advances with the clock while playing', () => {
    const { session, clock } = playing();

    assert.equal(session.positionSec(), 0);
    clock.advance(30_000);
    assert.equal(session.positionSec(), 30);
  });

  it('freezes while paused and does not drift', () => {
    const { session, clock } = playing();

    clock.advance(30_000);
    const paused = session.pause();
    assert.ok(paused.ok);
    assert.equal(paused.value, 30);

    // Time passes while paused; position must not move.
    clock.advance(120_000);
    assert.equal(session.positionSec(), 30);
  });

  it('continues from where it was paused, not from the start', () => {
    const { session, clock } = playing();

    clock.advance(30_000);
    assert.ok(session.pause().ok);
    clock.advance(60_000);

    const resumeFrom = session.prepareResume();
    assert.ok(resumeFrom.ok);
    assert.equal(resumeFrom.value, 30);

    assert.ok(session.markStarted(resumeFrom.value).ok);
    clock.advance(10_000);
    assert.equal(session.positionSec(), 40, 'a pause must not be counted as playback');
  });

  it('seeks to an absolute position and keeps counting from there', () => {
    const { session, clock } = playing();

    const target = session.prepareSeek(90);
    assert.ok(target.ok);
    assert.equal(target.value, 90);

    clock.advance(5_000);
    assert.equal(session.positionSec(), 95);
  });

  it('clamps a seek past the end of a track of known length', () => {
    const { session } = playing();
    const target = session.prepareSeek(99_999);
    assert.ok(target.ok);
    assert.equal(target.value, 239, 'clamped to just before the 240s end');
  });

  it('clamps a negative seek to the start', () => {
    const { session } = playing();
    const target = session.prepareSeek(-30);
    assert.ok(target.ok);
    assert.equal(target.value, 0);
  });

  it('allows any seek target when the duration is unknown', () => {
    const clock = new FakeClock(0);
    const queue = new Queue(DEFAULT_QUEUE_LIMITS);
    queue.enqueue(track({ durationSec: null }), alice, AT);
    const session = new PlaybackSession({ queue, clock });
    assert.ok(session.beginResolving().ok);
    assert.ok(session.markStarted().ok);

    const target = session.prepareSeek(5_000);
    assert.ok(target.ok);
    assert.equal(target.value, 5_000);
  });
});

describe('PlaybackSession repeat behaviour', () => {
  it('does not re-queue anything when repeat is off', () => {
    const { session, queue } = playing(['One']);
    session.endCurrent('finished');
    assert.equal(queue.length, 0);
    assert.equal(session.status, 'idle');
  });

  it('repeat=track puts the finished track back at the front', () => {
    const { session, queue } = playing(['One', 'Two']);
    session.setRepeat('track');

    session.endCurrent('finished');

    assert.equal(queue.peek()?.track.title, 'One');
    assert.equal(queue.length, 2);
  });

  it('repeat=track still lets a skip move on', () => {
    // Otherwise repeat-one makes the bot unsteerable: every skip replays the same song.
    const { session, queue } = playing(['One', 'Two']);
    session.setRepeat('track');

    session.endCurrent('skipped');

    assert.equal(queue.peek()?.track.title, 'Two');
    assert.equal(queue.length, 1);
  });

  it('repeat=queue sends the finished track to the back', () => {
    const { session, queue } = playing(['One', 'Two']);
    session.setRepeat('queue');

    session.endCurrent('finished');

    assert.deepEqual(
      queue.items.map((item) => item.track.title),
      ['Two', 'One'],
    );
  });

  it('a stop never re-queues, whatever the repeat mode', () => {
    const { session, queue } = playing(['One', 'Two']);
    session.setRepeat('queue');

    session.endCurrent('stopped');

    assert.equal(queue.length, 1);
    assert.deepEqual(
      queue.items.map((item) => item.track.title),
      ['Two'],
    );
  });

  it('a repeated track survives a per-user cap that is already full', () => {
    const clock = new FakeClock(0);
    const queue = new Queue({ ...DEFAULT_QUEUE_LIMITS, maxPerUser: 1 });
    queue.enqueue(track({ title: 'Only' }), alice, AT);
    const session = new PlaybackSession({ queue, clock });

    assert.ok(session.beginResolving().ok);
    assert.ok(session.markStarted().ok);
    session.setRepeat('track');
    session.endCurrent('finished');

    assert.equal(queue.length, 1, 'repeat must not be defeated by the enqueue limit');
  });
});

describe('PlaybackSession stop and failure', () => {
  it('stop clears the queue and the current track', () => {
    const { session, queue } = playing(['One', 'Two', 'Three']);

    const ended = session.stop();

    assert.equal(ended?.track.title, 'One');
    assert.equal(queue.length, 0);
    assert.equal(session.status, 'idle');
    assert.equal(session.current, null);
  });

  it('a failure surfaces in the player state and leaves the queue intact', () => {
    const { session, queue } = playing(['One', 'Two']);

    session.failCurrent('yt-dlp: Sign in to confirm you are not a bot');

    assert.equal(session.status, 'idle');
    assert.equal(queue.length, 1, 'the rest of the queue must survive one bad track');
    assert.match(session.toPlayerState().error ?? '', /Sign in to confirm/);
  });

  it('clears a previous error once the next track starts', () => {
    const { session } = playing(['One', 'Two']);
    session.failCurrent('boom');

    assert.ok(session.beginResolving().ok);
    assert.ok(session.markStarted().ok);
    assert.equal(session.toPlayerState().error, null);
  });
});

describe('PlaybackSession read model', () => {
  it('exposes volume and repeat', () => {
    const { session } = sessionWith();
    const volume = Volume.create(80);
    assert.ok(volume.ok);

    session.setVolume(volume.value);
    session.setRepeat('queue');

    const state = session.toPlayerState();
    assert.equal(state.volume, 80);
    assert.equal(state.repeat, 'queue');
  });

  it('stamps the position so the UI can interpolate from it', () => {
    const { session, clock } = playing();
    clock.advance(12_000);

    const state = session.toPlayerState();
    assert.equal(state.positionSec, 12);
    assert.equal(state.positionUpdatedAt, new Date(12_000).toISOString());
  });
});
