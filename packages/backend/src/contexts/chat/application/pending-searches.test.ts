import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Track } from '@tsmusic/shared';

import { FakeClock } from '../../../shared-kernel/clock.ts';
import { PendingSearches } from './pending-searches.ts';

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

const results = [track('One'), track('Two'), track('Three')];

describe('PendingSearches', () => {
  it('returns the track at a one-based position', () => {
    const clock = new FakeClock(0);
    const searches = new PendingSearches(clock);
    searches.remember('uid-alice', results);

    assert.equal(searches.take('uid-alice', 2)?.title, 'Two');
  });

  it('consumes the offer so the same pick cannot be replayed', () => {
    const clock = new FakeClock(0);
    const searches = new PendingSearches(clock);
    searches.remember('uid-alice', results);

    assert.ok(searches.take('uid-alice', 1));
    assert.equal(searches.take('uid-alice', 1), undefined);
  });

  it('keeps each person’s offer separate', () => {
    const clock = new FakeClock(0);
    const searches = new PendingSearches(clock);
    searches.remember('uid-alice', [track('AliceResult')]);
    searches.remember('uid-bob', [track('BobResult')]);

    assert.equal(searches.take('uid-bob', 1)?.title, 'BobResult');
    assert.equal(searches.take('uid-alice', 1)?.title, 'AliceResult');
  });

  it('expires an offer rather than queueing a stale result', () => {
    const clock = new FakeClock(0);
    const searches = new PendingSearches(clock, 60_000);
    searches.remember('uid-alice', results);

    clock.advance(60_001);

    assert.equal(searches.take('uid-alice', 1), undefined);
  });

  it('still honours a pick made just inside the window', () => {
    const clock = new FakeClock(0);
    const searches = new PendingSearches(clock, 60_000);
    searches.remember('uid-alice', results);

    clock.advance(59_000);

    assert.equal(searches.take('uid-alice', 1)?.title, 'One');
  });

  it('rejects a position outside the offered list', () => {
    const clock = new FakeClock(0);
    const searches = new PendingSearches(clock);
    searches.remember('uid-alice', results);

    assert.equal(searches.take('uid-alice', 0), undefined);
    assert.equal(searches.take('uid-alice', 99), undefined);
  });

  it('returns nothing for someone who never searched', () => {
    const searches = new PendingSearches(new FakeClock(0));
    assert.equal(searches.take('uid-nobody', 1), undefined);
  });
});
