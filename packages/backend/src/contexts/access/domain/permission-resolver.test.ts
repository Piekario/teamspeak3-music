import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CommandName, Role } from '@tsmusic/shared';

import {
  DEFAULT_PERMISSION_POLICY,
  PermissionResolver,
  type CommandPolicy,
  type PermissionPolicy,
} from './permission-resolver.ts';

function resolver(options: {
  identities?: Record<string, Role>;
  groups?: Record<number, Role>;
  commands?: Partial<Record<CommandName, CommandPolicy>>;
  policy?: Partial<PermissionPolicy>;
} = {}): PermissionResolver {
  return new PermissionResolver({
    identityGrants: new Map(Object.entries(options.identities ?? {})),
    groupGrants: new Map(
      Object.entries(options.groups ?? {}).map(([id, role]) => [Number(id), role]),
    ),
    commandPolicies: new Map(Object.entries(options.commands ?? {}) as [CommandName, CommandPolicy][]),
    policy: { ...DEFAULT_PERMISSION_POLICY, ...options.policy },
  });
}

const anonymous = { uid: 'uid-someone', serverGroupIds: [] };

describe('role resolution', () => {
  it('prefers an explicit grant for the UID over everything else', () => {
    const decisions = resolver({
      identities: { 'uid-alice': 'owner' },
      groups: { 6: 'user' },
    });

    assert.equal(decisions.roleOf({ uid: 'uid-alice', serverGroupIds: [6] }), 'owner');
  });

  it('takes the highest role among a person’s server groups', () => {
    const decisions = resolver({ groups: { 6: 'user', 12: 'dj', 20: 'user' } });

    assert.equal(decisions.roleOf({ uid: 'uid-bob', serverGroupIds: [6, 12, 20] }), 'dj');
  });

  it('falls back to the default role', () => {
    assert.equal(resolver().roleOf(anonymous), 'user');
    assert.equal(resolver({ policy: { defaultRole: 'dj' } }).roleOf(anonymous), 'dj');
  });

  it('treats an unknown person as blocked in whitelist-only mode', () => {
    const decisions = resolver({ policy: { whitelistOnly: true } });
    assert.equal(decisions.roleOf(anonymous), 'blocked');
  });

  it('still honours grants in whitelist-only mode', () => {
    const decisions = resolver({
      identities: { 'uid-alice': 'dj' },
      policy: { whitelistOnly: true },
    });
    assert.equal(decisions.roleOf({ uid: 'uid-alice', serverGroupIds: [] }), 'dj');
  });

  it('ignores the nickname entirely — identity is the UID', () => {
    // Nothing in the query carries a nickname, by construction. This test exists to pin
    // that down: keying on a nickname would make impersonation trivial.
    const decisions = resolver({ identities: { 'uid-alice': 'owner' } });
    assert.equal(decisions.roleOf({ uid: 'uid-impostor', serverGroupIds: [] }), 'user');
  });
});

describe('command authorisation', () => {
  it('allows a command that the role satisfies', () => {
    const decision = resolver({ identities: { 'uid-alice': 'dj' } }).can(
      { uid: 'uid-alice', serverGroupIds: [] },
      'skip',
    );
    assert.ok(decision.allowed);
  });

  it('refuses a command above the caller’s role and says what was needed', () => {
    const decision = resolver().can(anonymous, 'stop');

    assert.ok(!decision.allowed);
    assert.equal(decision.reason.kind, 'insufficient-role');
    assert.ok(decision.reason.kind === 'insufficient-role' && decision.reason.required === 'dj');
  });

  it('lets ordinary users play but not stop, out of the box', () => {
    const decisions = resolver();
    assert.ok(decisions.can(anonymous, 'play').allowed);
    assert.ok(decisions.can(anonymous, 'queue').allowed);
    assert.ok(!decisions.can(anonymous, 'stop').allowed);
    assert.ok(!decisions.can(anonymous, 'perm').allowed);
  });

  it('blocks a blocked user from everything, including help', () => {
    const decisions = resolver({ identities: { 'uid-troll': 'blocked' } });
    const troll = { uid: 'uid-troll', serverGroupIds: [] };

    for (const command of ['help', 'ping', 'play', 'queue'] as CommandName[]) {
      const decision = decisions.can(troll, command);
      assert.ok(!decision.allowed, `${command} must be refused`);
      assert.equal(decision.reason.kind, 'blocked');
    }
  });

  it('distinguishes a blocked user from one who is merely not whitelisted', () => {
    const decision = resolver({ policy: { whitelistOnly: true } }).can(anonymous, 'play');

    assert.ok(!decision.allowed);
    assert.equal(decision.reason.kind, 'not-whitelisted');
  });

  it('honours a per-command override of the default role', () => {
    // Handing !skip to everyone on a friendly server.
    const decisions = resolver({ commands: { skip: { minRole: 'user', enabled: true } } });
    assert.ok(decisions.can(anonymous, 'skip').allowed);
  });

  it('honours a per-command override that tightens the default', () => {
    const decisions = resolver({ commands: { play: { minRole: 'dj', enabled: true } } });
    assert.ok(!decisions.can(anonymous, 'play').allowed);
  });

  it('refuses a disabled command even to an owner', () => {
    const decisions = resolver({
      identities: { 'uid-alice': 'owner' },
      commands: { seek: { minRole: 'user', enabled: false } },
    });

    const decision = decisions.can({ uid: 'uid-alice', serverGroupIds: [] }, 'seek');
    assert.ok(!decision.allowed);
    assert.equal(decision.reason.kind, 'command-disabled');
  });

  it('lets an owner run owner-only commands', () => {
    const decisions = resolver({ identities: { 'uid-alice': 'owner' } });
    const alice = { uid: 'uid-alice', serverGroupIds: [] };

    assert.ok(decisions.can(alice, 'perm').allowed);
    assert.ok(decisions.can(alice, 'ytupdate').allowed);
  });

  it('grants a role through a server group without an explicit identity', () => {
    const decisions = resolver({ groups: { 12: 'dj' } });
    assert.ok(decisions.can({ uid: 'uid-bob', serverGroupIds: [12] }, 'skip').allowed);
  });
});
