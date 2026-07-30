import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { looksLikeUrl, parseCommand, parseTimecode } from './command-parser.ts';

describe('parseCommand', () => {
  it('splits a command from its arguments', () => {
    const parsed = parseCommand('!play https://youtu.be/abc', '!');

    assert.ok(parsed);
    assert.equal(parsed.name, 'play');
    assert.equal(parsed.argumentText, 'https://youtu.be/abc');
    assert.deepEqual(parsed.arguments, ['https://youtu.be/abc']);
  });

  it('keeps the argument text intact for search phrases', () => {
    const parsed = parseCommand('!play some band - some song', '!');

    assert.ok(parsed);
    assert.equal(parsed.argumentText, 'some band - some song');
  });

  it('lowercases the command name but not the arguments', () => {
    const parsed = parseCommand('!PLAY SomeArtist', '!');

    assert.ok(parsed);
    assert.equal(parsed.name, 'play');
    assert.equal(parsed.argumentText, 'SomeArtist');
  });

  it('parses a bare command', () => {
    const parsed = parseCommand('!skip', '!');

    assert.ok(parsed);
    assert.equal(parsed.name, 'skip');
    assert.equal(parsed.argumentText, '');
    assert.deepEqual(parsed.arguments, []);
  });

  it('tolerates the padding people actually type', () => {
    const parsed = parseCommand('   !volume    60   ', '!');

    assert.ok(parsed);
    assert.equal(parsed.name, 'volume');
    assert.deepEqual(parsed.arguments, ['60']);
  });

  it('ignores ordinary chatter', () => {
    assert.equal(parseCommand('hello everyone', '!'), undefined);
    assert.equal(parseCommand('', '!'), undefined);
  });

  it('ignores a lone prefix', () => {
    assert.equal(parseCommand('!', '!'), undefined);
    assert.equal(parseCommand('!   ', '!'), undefined);
  });

  it('honours a configured prefix', () => {
    assert.equal(parseCommand('.play x', '.')?.name, 'play');
    assert.equal(parseCommand('!play x', '.'), undefined);
    assert.equal(parseCommand('$$play x', '$$')?.name, 'play');
  });
});

describe('parseTimecode', () => {
  it('reads plain seconds', () => {
    assert.equal(parseTimecode('90'), 90);
    assert.equal(parseTimecode('12.5'), 12.5);
  });

  it('reads mm:ss', () => {
    assert.equal(parseTimecode('1:30'), 90);
    assert.equal(parseTimecode('0:05'), 5);
  });

  it('reads h:mm:ss', () => {
    assert.equal(parseTimecode('1:02:03'), 3_723);
  });

  it('rejects nonsense rather than guessing', () => {
    assert.equal(parseTimecode('abc'), undefined);
    assert.equal(parseTimecode(''), undefined);
    assert.equal(parseTimecode('1:2:3:4'), undefined);
  });
});

describe('looksLikeUrl', () => {
  it('accepts http and https', () => {
    assert.ok(looksLikeUrl('https://youtu.be/abc'));
    assert.ok(looksLikeUrl('http://example.com/a.mp3'));
  });

  it('treats free text as a search phrase, not a URL', () => {
    assert.ok(!looksLikeUrl('some band some song'));
    assert.ok(!looksLikeUrl('youtube'));
  });

  it('rejects non-web protocols', () => {
    assert.ok(!looksLikeUrl('file:///etc/passwd'));
    assert.ok(!looksLikeUrl('javascript:alert(1)'));
  });
});
