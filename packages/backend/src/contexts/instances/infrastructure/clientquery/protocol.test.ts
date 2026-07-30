import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ERROR_ID_OK,
  escape,
  isErrorLine,
  isNotificationLine,
  parseError,
  parseNotification,
  parseResponse,
  serialize,
  unescape,
} from './protocol.ts';

describe('escaping', () => {
  it('escapes the characters the query protocol reserves', () => {
    assert.equal(escape('hello world'), 'hello\\sworld');
    assert.equal(escape('a|b'), 'a\\pb');
    assert.equal(escape('path/to'), 'path\\/to');
    assert.equal(escape('back\\slash'), 'back\\\\slash');
    assert.equal(escape('line\nbreak'), 'line\\nbreak');
  });

  it('escapes the backslash before anything else, so escapes are not double-escaped', () => {
    // A naive implementation that escapes spaces first would turn this into `a\\sb`,
    // which unescapes to a literal backslash followed by `sb`.
    assert.equal(escape('a\\ b'), 'a\\\\\\sb');
    assert.equal(unescape(escape('a\\ b')), 'a\\ b');
  });

  it('round-trips arbitrary text', () => {
    const samples = [
      'Artist – Track (Official Video)',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'tab\there|pipe/slash\\back',
      'nick with  double  spaces',
    ];
    for (const sample of samples) {
      assert.equal(unescape(escape(sample)), sample, sample);
    }
  });

  it('leaves an unknown escape as its literal character', () => {
    assert.equal(unescape('\\q'), 'q');
  });

  it('keeps a trailing lone backslash rather than dropping data', () => {
    assert.equal(unescape('abc\\'), 'abc\\');
  });
});

describe('parseResponse', () => {
  it('parses a single item', () => {
    const { items } = parseResponse('clid=7 cid=3 client_nickname=MusicBot');
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], { clid: '7', cid: '3', client_nickname: 'MusicBot' });
  });

  it('splits pipe-separated items of a list response', () => {
    const { items } = parseResponse(
      'clid=1 client_nickname=Alice|clid=2 client_nickname=Bob\\sthe\\sBuilder',
    );
    assert.equal(items.length, 2);
    assert.equal(items[0]?.['client_nickname'], 'Alice');
    assert.equal(items[1]?.['client_nickname'], 'Bob the Builder');
  });

  it('returns no items for an empty payload', () => {
    assert.deepEqual(parseResponse('').items, []);
    assert.deepEqual(parseResponse('   ').items, []);
  });

  it('records a bare flag as a key with an empty value', () => {
    const { items } = parseResponse('cid=3 -uid');
    assert.equal(items[0]?.['-uid'], '');
  });

  it('keeps a value containing an equals sign intact', () => {
    // YouTube URLs carry `?v=` — splitting on every `=` would corrupt them.
    const { items } = parseResponse('msg=https:\\/\\/youtu.be\\/x?v=abc=def');
    assert.equal(items[0]?.['msg'], 'https://youtu.be/x?v=abc=def');
  });
});

describe('parseNotification', () => {
  it('parses a channel text message', () => {
    const line =
      'notifytextmessage schandlerid=1 targetmode=2 msg=!play\\shttps:\\/\\/youtu.be\\/abc ' +
      'invokerid=7 invokername=Alice invokeruid=aBcD1234=';
    const notification = parseNotification(line);

    assert.ok(notification);
    assert.equal(notification.name, 'notifytextmessage');
    const item = notification.items[0];
    assert.equal(item?.['targetmode'], '2');
    assert.equal(item?.['msg'], '!play https://youtu.be/abc');
    assert.equal(item?.['invokeruid'], 'aBcD1234=');
  });

  it('parses a notification that carries no parameters', () => {
    const notification = parseNotification('notifyconnectstatuschange');
    assert.ok(notification);
    assert.equal(notification.name, 'notifyconnectstatuschange');
    assert.deepEqual(notification.items, []);
  });

  it('rejects lines that are not notifications', () => {
    assert.equal(parseNotification('error id=0 msg=ok'), undefined);
    assert.equal(parseNotification('clid=7'), undefined);
  });
});

describe('parseError', () => {
  it('recognises the success sentinel', () => {
    const parsed = parseError('error id=0 msg=ok');
    assert.ok(parsed);
    assert.equal(parsed.id, ERROR_ID_OK);
    assert.equal(parsed.message, 'ok');
  });

  it('unescapes the error message', () => {
    const parsed = parseError('error id=1794 msg=invalid\\sloginname\\sor\\spassword');
    assert.ok(parsed);
    assert.equal(parsed.id, 1794);
    assert.equal(parsed.message, 'invalid loginname or password');
  });

  it('captures the failed permission id when present', () => {
    const parsed = parseError('error id=2568 msg=insufficient\\sclient\\spermissions failed_permid=133');
    assert.ok(parsed);
    assert.equal(parsed.failedPermissionId, 133);
  });

  it('leaves the permission id undefined when absent', () => {
    assert.equal(parseError('error id=0 msg=ok')?.failedPermissionId, undefined);
  });
});

describe('line classification', () => {
  it('distinguishes errors, notifications and payloads', () => {
    assert.ok(isErrorLine('error id=0 msg=ok'));
    assert.ok(!isErrorLine('errorprone=1'));

    assert.ok(isNotificationLine('notifytextmessage msg=hi'));
    assert.ok(!isNotificationLine('error id=0 msg=ok'));
    assert.ok(!isNotificationLine('clid=7'));
  });
});

describe('serialize', () => {
  it('renders a command with escaped parameters', () => {
    const line = serialize('sendtextmessage', {
      params: { targetmode: 2, msg: 'now playing: Artist – Song' },
    });
    assert.equal(line, 'sendtextmessage targetmode=2 msg=now\\splaying:\\sArtist\\s–\\sSong');
  });

  it('appends bare flags and normalises a missing dash', () => {
    assert.equal(serialize('clientlist', { flags: ['-uid', 'groups'] }), 'clientlist -uid -groups');
  });

  it('skips undefined parameters so optional arguments can be passed through', () => {
    const line = serialize('clientmove', { params: { cid: 5, cpw: undefined } });
    assert.equal(line, 'clientmove cid=5');
  });

  it('renders a bare command', () => {
    assert.equal(serialize('whoami'), 'whoami');
  });
});
