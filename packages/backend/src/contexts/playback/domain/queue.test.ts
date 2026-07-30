import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Requester, Track } from '@tsmusic/shared';

import { ClientUid } from './values.ts';
import { DEFAULT_QUEUE_LIMITS, Queue, type QueueLimits } from './queue.ts';

const AT = new Date('2026-07-30T20:00:00.000Z');

function track(overrides: Partial<Track> = {}): Track {
  return {
    source: 'youtube',
    sourceId: 'abc123',
    url: 'https://youtu.be/abc123',
    title: 'A Track',
    uploader: 'An Uploader',
    durationSec: 210,
    thumbnailUrl: null,
    isLive: false,
    ...overrides,
  };
}

function requester(uid = 'uid-alice', nickname = 'Alice'): Requester {
  return { uid, nickname };
}

function queueWith(limits: Partial<QueueLimits> = {}): Queue {
  return new Queue({ ...DEFAULT_QUEUE_LIMITS, ...limits });
}

describe('Queue enqueue rules', () => {
  it('appends by default and assigns distinct ids', () => {
    const queue = queueWith();
    const first = queue.enqueue(track({ title: 'One' }), requester(), AT);
    const second = queue.enqueue(track({ title: 'Two' }), requester(), AT);

    assert.ok(first.ok && second.ok);
    assert.notEqual(first.value.id, second.value.id);
    assert.deepEqual(
      queue.items.map((item) => item.track.title),
      ['One', 'Two'],
    );
  });

  it('inserts at a position so `playnext` jumps the queue', () => {
    const queue = queueWith();
    queue.enqueue(track({ title: 'One' }), requester(), AT);
    queue.enqueue(track({ title: 'Two' }), requester(), AT);
    queue.enqueue(track({ title: 'Urgent' }), requester(), AT, 0);

    assert.deepEqual(
      queue.items.map((item) => item.track.title),
      ['Urgent', 'One', 'Two'],
    );
  });

  it('rejects a track longer than the limit', () => {
    const queue = queueWith({ maxTrackSeconds: 600 });
    const result = queue.enqueue(track({ durationSec: 3_600 }), requester(), AT);

    assert.ok(!result.ok);
    assert.equal(result.error.kind, 'queue/track-too-long');
    assert.equal(queue.length, 0);
  });

  it('accepts any length when the limit is disabled', () => {
    const queue = queueWith({ maxTrackSeconds: 0 });
    assert.ok(queue.enqueue(track({ durationSec: 36_000 }), requester(), AT).ok);
  });

  it('accepts a track of unknown duration rather than guessing', () => {
    const queue = queueWith({ maxTrackSeconds: 600 });
    assert.ok(queue.enqueue(track({ durationSec: null }), requester(), AT).ok);
  });

  it('rejects live streams unless explicitly allowed', () => {
    const blocked = queueWith({ allowLiveStreams: false });
    const result = blocked.enqueue(track({ isLive: true, durationSec: null }), requester(), AT);
    assert.ok(!result.ok);
    assert.equal(result.error.kind, 'queue/live-not-allowed');

    const permissive = queueWith({ allowLiveStreams: true });
    assert.ok(permissive.enqueue(track({ isLive: true, durationSec: null }), requester(), AT).ok);
  });

  it('caps pending items per requester without affecting anyone else', () => {
    const queue = queueWith({ maxPerUser: 2 });
    const alice = requester('uid-alice', 'Alice');
    const bob = requester('uid-bob', 'Bob');

    assert.ok(queue.enqueue(track(), alice, AT).ok);
    assert.ok(queue.enqueue(track(), alice, AT).ok);

    const rejected = queue.enqueue(track(), alice, AT);
    assert.ok(!rejected.ok);
    assert.equal(rejected.error.kind, 'queue/user-limit-reached');

    assert.ok(queue.enqueue(track(), bob, AT).ok, "Bob's limit is his own");
  });

  it('frees a slot again once the user’s item leaves the queue', () => {
    const queue = queueWith({ maxPerUser: 1 });
    const alice = requester();
    const first = queue.enqueue(track(), alice, AT);
    assert.ok(first.ok);
    assert.ok(!queue.enqueue(track(), alice, AT).ok);

    queue.dequeue();
    assert.ok(queue.enqueue(track(), alice, AT).ok);
  });
});

describe('Queue mutation', () => {
  it('dequeues in order and reports emptiness', () => {
    const queue = queueWith();
    queue.enqueue(track({ title: 'One' }), requester(), AT);
    queue.enqueue(track({ title: 'Two' }), requester(), AT);

    assert.equal(queue.dequeue()?.track.title, 'One');
    assert.equal(queue.dequeue()?.track.title, 'Two');
    assert.equal(queue.dequeue(), undefined);
    assert.ok(queue.isEmpty);
  });

  it('lets a DJ remove anyone’s item', () => {
    const queue = queueWith();
    const enqueued = queue.enqueue(track(), requester('uid-bob', 'Bob'), AT);
    assert.ok(enqueued.ok);

    const removed = queue.remove(enqueued.value.id);
    assert.ok(removed.ok);
    assert.equal(queue.length, 0);
  });

  it('stops a user from removing someone else’s item', () => {
    const queue = queueWith();
    const bobsItem = queue.enqueue(track(), requester('uid-bob', 'Bob'), AT);
    assert.ok(bobsItem.ok);

    const alice = ClientUid.create('uid-alice');
    assert.ok(alice.ok);

    const removed = queue.remove(bobsItem.value.id, alice.value);
    assert.ok(!removed.ok);
    assert.equal(removed.error.kind, 'queue/not-owned-by-requester');
    assert.equal(queue.length, 1, 'the item must survive a refused removal');
  });

  it('lets a user remove their own item', () => {
    const queue = queueWith();
    const item = queue.enqueue(track(), requester('uid-alice', 'Alice'), AT);
    assert.ok(item.ok);

    const alice = ClientUid.create('uid-alice');
    assert.ok(alice.ok);
    assert.ok(queue.remove(item.value.id, alice.value).ok);
  });

  it('reports a missing item rather than silently doing nothing', () => {
    const queue = queueWith();
    const result = queue.remove('does-not-exist');
    assert.ok(!result.ok);
    assert.equal(result.error.kind, 'queue/item-not-found');
  });

  it('moves an item and clamps an out-of-range target', () => {
    const queue = queueWith();
    queue.enqueue(track({ title: 'One' }), requester(), AT);
    queue.enqueue(track({ title: 'Two' }), requester(), AT);
    const third = queue.enqueue(track({ title: 'Three' }), requester(), AT);
    assert.ok(third.ok);

    assert.ok(queue.move(third.value.id, 0).ok);
    assert.deepEqual(
      queue.items.map((item) => item.track.title),
      ['Three', 'One', 'Two'],
    );

    assert.ok(queue.move(third.value.id, 999).ok);
    assert.deepEqual(
      queue.items.map((item) => item.track.title),
      ['One', 'Two', 'Three'],
    );
  });

  it('shuffles deterministically when randomness is injected', () => {
    const queue = queueWith();
    for (const title of ['One', 'Two', 'Three', 'Four']) {
      queue.enqueue(track({ title }), requester(), AT);
    }

    const scripted = [0.99, 0.01, 0.5];
    let call = 0;
    queue.shuffle(() => scripted[call++] ?? 0);

    assert.equal(queue.length, 4, 'shuffling must not lose or duplicate items');
    assert.deepEqual(
      [...queue.items.map((item) => item.track.title)].sort(),
      ['Four', 'One', 'Three', 'Two'],
    );
  });

  it('restores a persisted queue and keeps generating fresh ids', () => {
    const queue = queueWith();
    queue.restore([
      {
        id: 'q7',
        track: track({ title: 'Restored' }),
        requestedBy: requester(),
        enqueuedAt: AT.toISOString(),
      },
    ]);

    assert.equal(queue.length, 1);
    const added = queue.enqueue(track(), requester(), AT);
    assert.ok(added.ok);
    assert.notEqual(added.value.id, 'q7', 'a restored id must never be reused');
  });
});
