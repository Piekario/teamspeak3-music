import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyFailure, expiryOf, toTrack, YtDlpResolver } from './ytdlp-resolver.ts';

function resolver(): YtDlpResolver {
  return new YtDlpResolver({ binary: 'yt-dlp' });
}

function execError(overrides: Partial<NodeJS.ErrnoException> = {}): NodeJS.ErrnoException {
  return Object.assign(new Error('command failed'), overrides);
}

describe('YtDlpResolver.supports', () => {
  it('claims the YouTube hosts users actually paste', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=abc',
      'https://youtu.be/abc',
      'https://music.youtube.com/watch?v=abc',
      'https://m.youtube.com/watch?v=abc',
    ]) {
      assert.ok(resolver().supports(url), url);
    }
  });

  it('declines other sources so another resolver can claim them', () => {
    assert.ok(!resolver().supports('https://soundcloud.com/artist/track'));
    assert.ok(!resolver().supports('https://example.com/audio.mp3'));
  });

  it('declines malformed input without throwing', () => {
    assert.ok(!resolver().supports('not a url'));
    assert.ok(!resolver().supports(''));
  });
});

describe('classifyFailure', () => {
  it('recognises a bot challenge, the failure an operator must act on', () => {
    const error = classifyFailure(
      execError(),
      'ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies.',
      ['https://youtu.be/abc'],
    );

    assert.equal(error.kind, 'resolve/blocked');
    assert.ok(error.kind === 'resolve/blocked' && error.detail.includes('Sign in to confirm'));
  });

  it('recognises an unavailable video', () => {
    const error = classifyFailure(execError(), 'ERROR: Video unavailable', ['https://youtu.be/x']);
    assert.equal(error.kind, 'resolve/not-found');
  });

  it('recognises an unsupported URL', () => {
    const error = classifyFailure(execError(), 'ERROR: Unsupported URL: https://example.com', [
      'https://example.com',
    ]);
    assert.equal(error.kind, 'resolve/unsupported-url');
  });

  it('reports a missing binary distinctly from a extraction failure', () => {
    const error = classifyFailure(execError({ code: 'ENOENT' }), '', ['x']);
    assert.equal(error.kind, 'resolve/tool-failure');
    assert.ok(error.kind === 'resolve/tool-failure' && error.detail.includes('not found'));
  });

  it('reports a timeout when the process was killed', () => {
    const error = classifyFailure(execError({ killed: true, signal: 'SIGTERM' }), '', ['x']);
    assert.equal(error.kind, 'resolve/timeout');
  });

  it('keeps yt-dlp’s own wording for unclassified failures', () => {
    const error = classifyFailure(execError(), 'ERROR: some novel breakage', ['x']);
    assert.equal(error.kind, 'resolve/tool-failure');
    assert.ok(error.kind === 'resolve/tool-failure' && error.detail === 'some novel breakage');
  });
});

describe('toTrack', () => {
  it('maps a normal video', () => {
    const track = toTrack({
      id: 'dQw4',
      title: 'Some Song',
      uploader: 'Some Channel',
      duration: 213,
      thumbnail: 'https://i.ytimg.com/vi/dQw4/hq.jpg',
      webpage_url: 'https://www.youtube.com/watch?v=dQw4',
    });

    assert.equal(track.sourceId, 'dQw4');
    assert.equal(track.title, 'Some Song');
    assert.equal(track.uploader, 'Some Channel');
    assert.equal(track.durationSec, 213);
    assert.ok(!track.isLive);
  });

  it('treats a missing duration as unknown rather than zero', () => {
    assert.equal(toTrack({ id: 'x', duration: 0 }).durationSec, null);
    assert.equal(toTrack({ id: 'x' }).durationSec, null);
  });

  it('detects a livestream from either field', () => {
    assert.ok(toTrack({ id: 'x', is_live: true }).isLive);
    assert.ok(toTrack({ id: 'x', live_status: 'is_live' }).isLive);
  });

  it('falls back to the channel when no uploader is given', () => {
    assert.equal(toTrack({ id: 'x', channel: 'A Channel' }).uploader, 'A Channel');
  });

  it('reconstructs the page URL when yt-dlp omits it', () => {
    assert.equal(toTrack({ id: 'abc' }).url, 'https://www.youtube.com/watch?v=abc');
  });
});

describe('expiryOf', () => {
  it('reads the expiry a media URL carries', () => {
    const expiry = expiryOf('https://rr1.googlevideo.com/videoplayback?expire=1800000000&id=x');
    assert.deepEqual(expiry, new Date(1_800_000_000_000));
  });

  it('returns null when there is no expiry to read', () => {
    assert.equal(expiryOf('https://example.com/audio.mp3'), null);
    assert.equal(expiryOf('not a url'), null);
    assert.equal(expiryOf('https://x.test/?expire=soon'), null);
  });
});
