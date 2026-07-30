import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeClock } from '../../../../shared-kernel/clock.ts';
import { TokenBucket } from './rate-limiter.ts';

function bucket(capacity: number, refillIntervalMs: number) {
  const clock = new FakeClock(0);
  return { clock, bucket: new TokenBucket({ capacity, refillIntervalMs, clock }) };
}

describe('TokenBucket', () => {
  it('allows an immediate burst up to capacity', () => {
    const { bucket: limiter } = bucket(3, 600);

    assert.ok(limiter.tryConsume());
    assert.ok(limiter.tryConsume());
    assert.ok(limiter.tryConsume());
    assert.ok(!limiter.tryConsume(), 'fourth message in a burst must be held back');
  });

  it('refills one token per interval', () => {
    const { clock, bucket: limiter } = bucket(3, 600);
    for (let i = 0; i < 3; i += 1) limiter.tryConsume();

    clock.advance(599);
    assert.ok(!limiter.tryConsume(), 'must not refill early');

    clock.advance(1);
    assert.ok(limiter.tryConsume(), 'one token after one full interval');
    assert.ok(!limiter.tryConsume(), 'but only one');
  });

  it('never accumulates beyond capacity while idle', () => {
    const { clock, bucket: limiter } = bucket(3, 600);
    for (let i = 0; i < 3; i += 1) limiter.tryConsume();

    clock.advance(600 * 50);

    assert.ok(limiter.tryConsume());
    assert.ok(limiter.tryConsume());
    assert.ok(limiter.tryConsume());
    assert.ok(!limiter.tryConsume(), 'a long idle period must not buy an unlimited burst');
  });

  it('reports how long the caller must wait', () => {
    const { clock, bucket: limiter } = bucket(1, 600);

    assert.equal(limiter.delayUntilAvailableMs(), 0);
    limiter.tryConsume();
    assert.equal(limiter.delayUntilAvailableMs(), 600);

    clock.advance(250);
    assert.equal(limiter.delayUntilAvailableMs(), 350);

    clock.advance(350);
    assert.equal(limiter.delayUntilAvailableMs(), 0);
  });
});
