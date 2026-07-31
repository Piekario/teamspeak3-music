import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createInstanceConfig, type InstanceConfig } from '../../contexts/instances/domain/instance.ts';
import { openDatabase } from './database.ts';
import { DrizzleInstanceRepository } from './drizzle-instance-repository.ts';

const silentLogger = { warn: () => {} };

function repository(): DrizzleInstanceRepository {
  const { db } = openDatabase(':memory:');
  return new DrizzleInstanceRepository(db, silentLogger);
}

function config(overrides: Parameters<typeof createInstanceConfig>[0]): InstanceConfig {
  const created = createInstanceConfig(overrides);
  assert.ok(created.ok, 'the fixture must be a valid configuration');
  return created.value;
}

const base = {
  id: 'party',
  name: 'Party bot',
  teamspeak: { host: 'ts.example.com' },
  clientQuery: { host: 'client', apiKey: 'key' },
  audio: { pulseServer: 'tcp:client:4713' },
};

describe('DrizzleInstanceRepository', () => {
  it('round-trips the settings that have no column of their own', async () => {
    // These live in a JSON blob rather than columns, which is exactly why they need a test:
    // before it existed, every one of them was silently lost on restart.
    const repo = repository();
    await repo.save(
      config({
        ...base,
        teamspeak: { ...base.teamspeak, channel: 'Music', channelPassword: 'hunter2' },
        playback: { pauseWhenAlone: true },
        connection: { autoReconnect: false },
        permissions: { defaultRole: 'blocked', whitelistOnly: true },
        grants: { serverGroups: { 6: 'owner' }, identities: { 'abc=': 'dj' } },
      }),
    );

    const loaded = await repo.findById('party');

    assert.ok(loaded !== undefined);
    assert.equal(loaded.teamspeak.channel, 'Music');
    assert.equal(loaded.teamspeak.channelPassword, 'hunter2');
    assert.equal(loaded.playback.pauseWhenAlone, true);
    assert.equal(loaded.connection.autoReconnect, false);
    assert.equal(loaded.permissions.defaultRole, 'blocked');
    assert.equal(loaded.permissions.whitelistOnly, true);
    // Server group ids are numbers everywhere but JSON, where the keys become strings.
    assert.equal(loaded.grants.serverGroups.get(6), 'owner');
    assert.equal(loaded.grants.identities['abc='], 'dj');
  });

  it('applies defaults to a row saved before the settings existed', async () => {
    const repo = repository();
    await repo.save(config(base));

    const loaded = await repo.findById('party');

    assert.ok(loaded !== undefined);
    assert.equal(loaded.connection.autoReconnect, true);
    assert.equal(loaded.playback.pauseWhenAlone, false);
  });

  it('keeps the identity when a configuration change is saved over it', async () => {
    // The identity is what a bot's UID and every server-group grant hang off, so a settings
    // save that cleared it would silently turn the bot into a stranger.
    const repo = repository();
    await repo.save(config(base));
    await repo.saveIdentity('party', { key: 'secret', offset: 42, uid: 'uid=' });

    await repo.save(config({ ...base, name: 'Renamed' }));

    assert.deepEqual(await repo.readIdentity('party'), {
      key: 'secret',
      offset: 42,
      uid: 'uid=',
    });
  });

  it('overwrites settings rather than merging them', async () => {
    const repo = repository();
    await repo.save(config({ ...base, connection: { autoReconnect: false } }));
    await repo.save(config({ ...base, connection: { autoReconnect: true } }));

    const loaded = await repo.findById('party');

    assert.equal(loaded?.connection.autoReconnect, true);
  });
});
