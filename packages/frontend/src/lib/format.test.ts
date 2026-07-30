import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatDuration, interpolatePosition, progressRatio } from './format.ts';

describe('formatDuration', () => {
  it('formats minutes and seconds with a padded seconds field', () => {
    assert.equal(formatDuration(245), '4:05');
    assert.equal(formatDuration(9), '0:09');
  });

  it('grows to hours only when needed', () => {
    assert.equal(formatDuration(3_599), '59:59');
    assert.equal(formatDuration(3_600), '1:00:00');
  });

  it('shows a placeholder rather than a misleading zero for unknown length', () => {
    assert.equal(formatDuration(null), '--:--');
    assert.equal(formatDuration(undefined), '--:--');
    assert.equal(formatDuration(Number.NaN), '--:--');
  });

  it('never renders a negative time', () => {
    assert.equal(formatDuration(-5), '0:00');
  });
});

describe('interpolatePosition', () => {
  const measuredAt = '2026-07-31T10:00:00.000Z';
  const measuredAtMs = Date.parse(measuredAt);

  it('advances with wall-clock time while playing', () => {
    // This is what lets the progress bar move at 60fps without the server ticking.
    const position = interpolatePosition(30, measuredAt, true, measuredAtMs + 5_000);
    assert.equal(position, 35);
  });

  it('stays put while paused, however long ago the measurement was', () => {
    const position = interpolatePosition(30, measuredAt, false, measuredAtMs + 600_000);
    assert.equal(position, 30);
  });

  it('never runs backwards if the clocks disagree', () => {
    // A browser clock behind the server's would otherwise produce a negative offset.
    const position = interpolatePosition(30, measuredAt, true, measuredAtMs - 10_000);
    assert.equal(position, 30);
  });

  it('falls back to the reported position when the timestamp is unusable', () => {
    assert.equal(interpolatePosition(42, 'not a date', true), 42);
  });
});

describe('progressRatio', () => {
  it('reports the fraction played', () => {
    assert.equal(progressRatio(60, 240), 0.25);
  });

  it('clamps to the track, so an overrun does not overflow the bar', () => {
    assert.equal(progressRatio(300, 240), 1);
    assert.equal(progressRatio(-10, 240), 0);
  });

  it('reports zero for a livestream of unknown length', () => {
    assert.equal(progressRatio(120, null), 0);
    assert.equal(progressRatio(120, 0), 0);
  });
});
