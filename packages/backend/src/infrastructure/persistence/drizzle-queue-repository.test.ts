import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QueueItem } from '@tsmusic/shared';

import { createInstanceConfig } from '../../contexts/instances/domain/instance.ts';
import { openDatabase, type Db } from './database.ts';
import { DrizzleInstanceRepository } from './drizzle-instance-repository.ts';
import { DrizzleQueueRepository } from './drizzle-queue-repository.ts';

const silentLogger = { warn: () => {} };

/** `queue_snapshots.instance_id` is a foreign key, so a row needs a real instance behind it. */
async function seededDb(instanceId: string): Promise<Db> {
  const { db } = openDatabase(':memory:');
  const instances = new DrizzleInstanceRepository(db, silentLogger);
  const created = createInstanceConfig({
    id: instanceId,
    name: 'Party bot',
    teamspeak: { host: 'ts.example.com' },
    clientQuery: { host: 'client', apiKey: 'key' },
    audio: { pulseServer: 'tcp:client:4713' },
  });
  assert.ok(created.ok, 'the fixture must be a valid configuration');
  await instances.save(created.value);
  return db;
}

function item(id: string, title: string): QueueItem {
  return {
    id,
    track: {
      source: 'youtube',
      sourceId: id,
      url: `https://youtu.be/${id}`,
      title,
      uploader: null,
      durationSec: null,
      thumbnailUrl: null,
      isLive: false,
    },
    requestedBy: { uid: 'uid-1', nickname: 'Listener' },
    enqueuedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('DrizzleQueueRepository', () => {
  it('reads back what was saved, in position order', async () => {
    const repo = new DrizzleQueueRepository(await seededDb('party'));
    const items = [item('a', 'First'), item('b', 'Second'), item('c', 'Third')];

    await repo.save('party', items);

    assert.deepEqual(await repo.load('party'), items);
  });

  it('replaces the whole queue rather than merging with what was there', async () => {
    const repo = new DrizzleQueueRepository(await seededDb('party'));
    await repo.save('party', [item('a', 'First'), item('b', 'Second')]);

    await repo.save('party', [item('c', 'Third')]);

    assert.deepEqual(await repo.load('party'), [item('c', 'Third')]);
  });

  it('clears a persisted queue when saved empty', async () => {
    const repo = new DrizzleQueueRepository(await seededDb('party'));
    await repo.save('party', [item('a', 'First')]);

    await repo.save('party', []);

    assert.deepEqual(await repo.load('party'), []);
  });

  it('keeps each instance on its own queue', async () => {
    const db = await seededDb('party');
    const instances = new DrizzleInstanceRepository(db, silentLogger);
    const other = createInstanceConfig({
      id: 'other',
      name: 'Other bot',
      teamspeak: { host: 'ts.example.com' },
      clientQuery: { host: 'client', apiKey: 'key' },
      audio: { pulseServer: 'tcp:client:4713' },
    });
    assert.ok(other.ok, 'the fixture must be a valid configuration');
    await instances.save(other.value);

    const repo = new DrizzleQueueRepository(db);
    await repo.save('party', [item('a', 'First')]);
    await repo.save('other', [item('b', 'Second')]);

    assert.deepEqual(await repo.load('party'), [item('a', 'First')]);
    assert.deepEqual(await repo.load('other'), [item('b', 'Second')]);
  });

  it('answers nothing for an instance that never had a queue saved', async () => {
    const repo = new DrizzleQueueRepository(await seededDb('party'));

    assert.deepEqual(await repo.load('party'), []);
  });
});
