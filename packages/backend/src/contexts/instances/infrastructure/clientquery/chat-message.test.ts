import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chunkMessage, stripBbCode, TS3_MESSAGE_LIMIT } from './chat-message.ts';

describe('stripBbCode', () => {
  it('unwraps a URL that TeamSpeak decorated', () => {
    assert.equal(
      stripBbCode('!play [URL]https://youtu.be/abc[/URL]'),
      '!play https://youtu.be/abc',
    );
  });

  it('unwraps the labelled URL form', () => {
    assert.equal(
      stripBbCode('[URL=https://youtu.be/abc]https://youtu.be/abc[/URL]'),
      'https://youtu.be/abc',
    );
  });

  it('removes formatting tags around a command', () => {
    assert.equal(stripBbCode('[B]!skip[/B]'), '!skip');
    assert.equal(stripBbCode('[COLOR=#ff0000]!stop[/COLOR]'), '!stop');
  });

  it('leaves a plain command untouched', () => {
    assert.equal(stripBbCode('!volume 40'), '!volume 40');
  });
});

describe('chunkMessage', () => {
  it('returns a short message as a single chunk', () => {
    assert.deepEqual(chunkMessage('now playing: something'), ['now playing: something']);
  });

  it('returns nothing for an empty message', () => {
    assert.deepEqual(chunkMessage(''), []);
  });

  it('splits on line boundaries so queue entries stay intact', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `${i + 1}. Track number ${i + 1}`);
    const chunks = chunkMessage(lines.join('\n'), 200);

    for (const chunk of chunks) {
      assert.ok(chunk.length <= 200, `chunk too long: ${chunk.length}`);
    }
    // No entry may be torn in half.
    assert.deepEqual(chunks.join('\n').split('\n'), lines);
  });

  it('hard-splits a single line that exceeds the limit on its own', () => {
    const chunks = chunkMessage('x'.repeat(2_500), TS3_MESSAGE_LIMIT);
    assert.equal(chunks.length, 3);
    for (const chunk of chunks) assert.ok(chunk.length <= TS3_MESSAGE_LIMIT);
    assert.equal(chunks.join('').length, 2_500);
  });

  it('respects the TeamSpeak limit by default', () => {
    const chunks = chunkMessage(Array.from({ length: 200 }, () => 'a track title').join('\n'));
    for (const chunk of chunks) assert.ok(chunk.length <= TS3_MESSAGE_LIMIT);
  });
});
