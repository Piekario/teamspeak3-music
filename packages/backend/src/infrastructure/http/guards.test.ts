import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { roleSatisfies, type Role } from '@tsmusic/shared';

import { mayTouchInstance } from '../../contexts/access/domain/panel-access.ts';
import { instanceOf, requiredRoleFor } from './guards.ts';

/** Reads as the question the hook actually asks. */
function allows(role: Role, method: string, path: string): boolean {
  return roleSatisfies(role, requiredRoleFor(method, path));
}

describe('panel route policy', () => {
  it('lets a user queue and watch', () => {
    assert.ok(allows('user', 'GET', '/api/instances'));
    assert.ok(allows('user', 'GET', '/api/instances/party/player'));
    assert.ok(allows('user', 'GET', '/api/instances/party/queue'));
    assert.ok(allows('user', 'POST', '/api/instances/party/queue'));
    assert.ok(allows('user', 'POST', '/api/instances/party/queue/playlist'));
    assert.ok(allows('user', 'DELETE', '/api/instances/party/queue/item-1'));
    assert.ok(allows('user', 'GET', '/ws'));
  });

  it('keeps the transport controls for DJs', () => {
    // The same split as the chat commands: !skip is a DJ command, so the skip button is too.
    for (const action of ['skip', 'pause', 'resume', 'stop', 'seek', 'volume', 'repeat']) {
      assert.ok(!allows('user', 'POST', `/api/instances/party/player/${action}`), action);
      assert.ok(allows('dj', 'POST', `/api/instances/party/player/${action}`), action);
    }
  });

  it('keeps queue-wide edits for DJs', () => {
    for (const action of ['move', 'shuffle', 'clear']) {
      assert.ok(!allows('user', 'POST', `/api/instances/party/queue/${action}`), action);
      assert.ok(allows('dj', 'POST', `/api/instances/party/queue/${action}`), action);
    }
  });

  it('separates loading a playlist from editing one', () => {
    // Loading is queueing; a user who may queue a track may queue a saved set of them.
    assert.ok(allows('user', 'POST', '/api/instances/party/playlists/pl-1/load'));
    assert.ok(allows('user', 'GET', '/api/instances/party/playlists'));

    assert.ok(!allows('user', 'POST', '/api/instances/party/playlists'));
    assert.ok(!allows('user', 'DELETE', '/api/instances/party/playlists/pl-1'));
    assert.ok(allows('dj', 'POST', '/api/instances/party/playlists'));
  });

  it('keeps every instance setting for owners', () => {
    for (const [method, path] of [
      ['GET', '/api/instances/party'],
      ['PATCH', '/api/instances/party'],
      ['DELETE', '/api/instances/party'],
      ['POST', '/api/instances'],
      ['POST', '/api/instances/party/start'],
      ['POST', '/api/instances/party/stop'],
    ] as const) {
      assert.ok(!allows('dj', method, path), `${method} ${path}`);
      assert.ok(allows('owner', method, path), `${method} ${path}`);
    }
  });

  it('keeps access management for owners', () => {
    // A DJ who could mint an owner token would make the whole table decorative.
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      assert.ok(!allows('dj', method, '/api/panel-tokens'));
      assert.ok(allows('owner', method, '/api/panel-tokens'));
    }
  });

  it('refuses a blocked role everywhere, including what everyone else may read', () => {
    assert.ok(!allows('blocked', 'GET', '/api/instances'));
    assert.ok(!allows('blocked', 'GET', '/ws'));
  });

  it('demands owner for a route nobody wrote a rule for', () => {
    // Failing closed is the point: a new endpoint is unreachable until somebody decides who
    // may reach it, rather than quietly open to everyone.
    assert.equal(requiredRoleFor('POST', '/api/instances/party/something-new'), 'owner');
    assert.equal(requiredRoleFor('GET', '/api/whatever'), 'owner');
  });
});

describe('instance scoping', () => {
  it('reads the bot out of the path', () => {
    assert.equal(instanceOf('/api/instances/party/player'), 'party');
    assert.equal(instanceOf('/api/instances/party'), 'party');
    assert.equal(instanceOf('/api/instances'), undefined);
    assert.equal(instanceOf('/ws?token=abc'), undefined);
  });

  it('ignores a query string when reading the bot', () => {
    assert.equal(instanceOf('/api/instances/party?x=1'), 'party');
  });

  it('confines a scoped credential to its own bot', () => {
    const scoped = { label: 'Ala', role: 'dj' as const, instanceId: 'party', isRootToken: false };

    assert.ok(mayTouchInstance(scoped, 'party'));
    assert.ok(!mayTouchInstance(scoped, 'chill'));
  });

  it('lets an unscoped credential touch every bot', () => {
    const global = { label: 'op', role: 'owner' as const, instanceId: null, isRootToken: true };

    assert.ok(mayTouchInstance(global, 'party'));
    assert.ok(mayTouchInstance(global, 'chill'));
  });
});
