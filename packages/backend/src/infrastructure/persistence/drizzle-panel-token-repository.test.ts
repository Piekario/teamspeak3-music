import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createInstanceConfig } from '../../contexts/instances/domain/instance.ts';
import { openDatabase } from './database.ts';
import { DrizzleInstanceRepository } from './drizzle-instance-repository.ts';
import {
  DrizzlePanelTokenRepository,
  generateToken,
  hashToken,
} from './drizzle-panel-token-repository.ts';

function repository(): DrizzlePanelTokenRepository {
  const { db } = openDatabase(':memory:');
  return new DrizzlePanelTokenRepository(db);
}

/** A repository pair over one database, for the tests that scope a token to a real bot. */
async function withInstance(id: string) {
  const { db } = openDatabase(':memory:');
  const instances = new DrizzleInstanceRepository(db, { warn: () => {} });
  const created = createInstanceConfig({
    id,
    name: id,
    teamspeak: { host: 'ts.example.com' },
    clientQuery: { host: 'client', apiKey: 'key' },
    audio: { pulseServer: 'tcp:client:4713' },
  });
  assert.ok(created.ok);
  await instances.save(created.value);

  return { tokens: new DrizzlePanelTokenRepository(db), instances };
}

describe('DrizzlePanelTokenRepository', () => {
  it('never stores the token itself', async () => {
    // A panel database that leaks should not hand over working credentials with it.
    const repo = repository();
    const token = generateToken();

    const created = await repo.create({
      label: 'Ala',
      role: 'dj',
      instanceId: null,
      token,
    });

    assert.ok(!JSON.stringify(created).includes(token));
    assert.ok(!JSON.stringify(await repo.list()).includes(token));
  });

  it('resolves a token to its holder', async () => {
    const { tokens } = await withInstance('party');
    const token = generateToken();
    await tokens.create({ label: 'Ala', role: 'dj', instanceId: 'party', token });

    const found = await tokens.findByToken(token);

    assert.equal(found?.label, 'Ala');
    assert.equal(found?.role, 'dj');
    assert.equal(found?.instanceId, 'party');
  });

  it('takes a scoped token with the bot it was scoped to', async () => {
    // Otherwise deleting a bot would leave credentials pointing at an id that gets reused,
    // silently handing somebody access to a different bot than the one they were given.
    const { tokens, instances } = await withInstance('party');
    const token = generateToken();
    await tokens.create({ label: 'Ala', role: 'dj', instanceId: 'party', token });

    await instances.delete('party');

    assert.equal(await tokens.findByToken(token), undefined);
  });

  it('does not resolve a token that was never issued', async () => {
    const repo = repository();
    await repo.create({ label: 'Ala', role: 'dj', instanceId: null, token: generateToken() });

    assert.equal(await repo.findByToken(generateToken()), undefined);
  });

  it('stops resolving a revoked token', async () => {
    const repo = repository();
    const token = generateToken();
    const created = await repo.create({ label: 'Ala', role: 'dj', instanceId: null, token });

    await repo.delete(created.id);

    assert.equal(await repo.findByToken(token), undefined);
  });

  it('records when a token was last used', async () => {
    // The only signal for deciding which credentials are safe to revoke.
    const repo = repository();
    const token = generateToken();
    const created = await repo.create({ label: 'Ala', role: 'dj', instanceId: null, token });
    assert.equal(created.lastUsedAt, null);

    await repo.findByToken(token);

    const [listed] = await repo.list();
    assert.ok(listed?.lastUsedAt !== null);
  });

  it('issues tokens nobody could guess or collide with', async () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));

    assert.equal(tokens.size, 200);
    for (const token of tokens) assert.ok(token.length >= 40, token);
  });

  it('reads an unrecognised stored role as blocked rather than trusting it', async () => {
    // Roles are text in SQLite, so a hand-edited row must not become a role with no rules.
    const { db } = openDatabase(':memory:');
    const repo = new DrizzlePanelTokenRepository(db);
    const token = generateToken();
    db.run(
      `INSERT INTO panel_tokens (id, label, token_hash, role, created_at)
       VALUES ('t1', 'Odd', '${hashToken(token)}', 'superuser', '2026-01-01T00:00:00.000Z')` as never,
    );

    assert.equal((await repo.findByToken(token))?.role, 'blocked');
  });
});
