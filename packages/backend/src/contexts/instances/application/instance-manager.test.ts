import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createInstanceConfig } from '../domain/instance.ts';
import { InstanceManager } from './instance-manager.ts';
import type { InstanceRuntime } from './instance-runtime.ts';

function config(id: string, overrides: Record<string, unknown> = {}) {
  const created = createInstanceConfig({
    id,
    name: `Bot ${id}`,
    teamspeak: { host: `ts-${id}.example.com` },
    clientQuery: { host: `client-${id}`, apiKey: 'AAAA-BBBB' },
    audio: { pulseServer: `tcp:client-${id}:4713` },
    ...overrides,
  });
  assert.ok(created.ok, 'test fixture must be valid');
  return created.value;
}

/** Stands in for a real runtime; records the lifecycle calls the manager makes. */
function fakeRuntime(cfg: ReturnType<typeof config>) {
  const calls = { start: 0, stop: 0, applyConfig: 0 };
  let requiresRestart = false;

  const runtime = {
    id: cfg.id,
    config: cfg,
    connectionState: 'disconnected' as const,
    start() {
      calls.start += 1;
    },
    async stop() {
      calls.stop += 1;
    },
    applyConfig() {
      calls.applyConfig += 1;
      return { requiresRestart };
    },
  };

  return {
    runtime: runtime as unknown as InstanceRuntime,
    calls,
    demandRestart(value: boolean) {
      requiresRestart = value;
    },
  };
}

function managerWithFakes() {
  const fakes = new Map<string, ReturnType<typeof fakeRuntime>>();
  const manager = new InstanceManager((cfg) => {
    const fake = fakeRuntime(cfg);
    fakes.set(cfg.id, fake);
    return fake.runtime;
  });
  return { manager, fakes };
}

describe('InstanceManager registry', () => {
  it('holds several bots side by side', () => {
    const { manager } = managerWithFakes();

    assert.ok(manager.add(config('party')).ok);
    assert.ok(manager.add(config('chill')).ok);

    assert.deepEqual([...manager.ids].sort(), ['chill', 'party']);
  });

  it('refuses a duplicate id rather than shadowing a running bot', () => {
    const { manager } = managerWithFakes();
    manager.add(config('party'));

    const second = manager.add(config('party'));

    assert.ok(!second.ok);
    assert.equal(second.error.kind, 'instance/duplicate-id');
  });

  it('reports an unknown id as an ordinary error', () => {
    const { manager } = managerWithFakes();
    const found = manager.get('nope');

    assert.ok(!found.ok);
    assert.equal(found.error.kind, 'instance/not-found');
  });

  it('keeps each bot’s configuration separate', () => {
    const { manager } = managerWithFakes();
    manager.add(config('party', { teamspeak: { host: 'party.example.com' } }));
    manager.add(config('chill', { teamspeak: { host: 'chill.example.com' } }));

    const party = manager.get('party');
    const chill = manager.get('chill');
    assert.ok(party.ok && chill.ok);
    assert.equal(party.value.config.teamspeak.host, 'party.example.com');
    assert.equal(chill.value.config.teamspeak.host, 'chill.example.com');
  });
});

describe('InstanceManager lifecycle', () => {
  it('starts every instance', () => {
    const { manager, fakes } = managerWithFakes();
    manager.add(config('party'));
    manager.add(config('chill'));

    manager.startAll();

    assert.equal(fakes.get('party')?.calls.start, 1);
    assert.equal(fakes.get('chill')?.calls.start, 1);
  });

  it('stops the others even when one fails to shut down', async () => {
    const { manager, fakes } = managerWithFakes();
    manager.add(config('broken'));
    manager.add(config('healthy'));

    const broken = fakes.get('broken');
    assert.ok(broken);
    (broken.runtime as unknown as { stop: () => Promise<void> }).stop = async () => {
      throw new Error('socket wedged');
    };

    await manager.stopAll();

    assert.equal(fakes.get('healthy')?.calls.stop, 1, 'one bad instance must not block the rest');
  });

  it('removes an instance and stops it', async () => {
    const { manager, fakes } = managerWithFakes();
    manager.add(config('party'));

    const removed = await manager.remove('party');

    assert.ok(removed.ok);
    assert.ok(!manager.has('party'));
    assert.equal(fakes.get('party')?.calls.stop, 1);
  });

  it('refuses to remove something that is not there', async () => {
    const { manager } = managerWithFakes();
    const removed = await manager.remove('ghost');
    assert.ok(!removed.ok);
  });
});

describe('InstanceManager reconfiguration', () => {
  it('applies a harmless change without restarting the bot', async () => {
    const { manager, fakes } = managerWithFakes();
    manager.add(config('party'));
    fakes.get('party')?.demandRestart(false);

    await manager.reconfigure(config('party', { playback: { maxTrackSeconds: 1_200 } }));

    const calls = fakes.get('party')?.calls;
    assert.equal(calls?.applyConfig, 1);
    assert.equal(calls?.stop, 0, 'adjusting a limit must not interrupt playback');
    assert.equal(calls?.start, 0);
  });

  it('restarts the bot when the endpoint itself changed', async () => {
    const { manager, fakes } = managerWithFakes();
    manager.add(config('party'));
    fakes.get('party')?.demandRestart(true);

    await manager.reconfigure(config('party', { clientQuery: { host: 'elsewhere', apiKey: 'X' } }));

    const calls = fakes.get('party')?.calls;
    assert.equal(calls?.stop, 1);
    assert.equal(calls?.start, 1);
  });

  it('reconfiguring one bot leaves the others alone', async () => {
    const { manager, fakes } = managerWithFakes();
    manager.add(config('party'));
    manager.add(config('chill'));
    fakes.get('party')?.demandRestart(true);

    await manager.reconfigure(config('party'));

    assert.equal(fakes.get('chill')?.calls.stop, 0);
    assert.equal(fakes.get('chill')?.calls.applyConfig, 0);
  });
});

describe('createInstanceConfig', () => {
  it('fills in the defaults an operator should not have to state', () => {
    const created = createInstanceConfig({
      id: 'party',
      name: 'Party',
      teamspeak: { host: 'ts.example.com' },
      clientQuery: { host: 'client', apiKey: 'KEY' },
      audio: { pulseServer: 'tcp:client:4713' },
    });

    assert.ok(created.ok);
    assert.equal(created.value.teamspeak.port, 9987);
    assert.equal(created.value.clientQuery.port, 25639);
    assert.equal(created.value.audio.sinkName, 'bot_sink');
    assert.equal(created.value.commands.prefix, '!');
    assert.ok(created.value.enabled);
  });

  it('names the field that is missing, so startup failures are actionable', () => {
    const created = createInstanceConfig({
      id: 'party',
      name: 'Party',
      teamspeak: { host: 'ts.example.com' },
      clientQuery: { host: 'client', apiKey: '' },
      audio: { pulseServer: 'tcp:client:4713' },
    });

    assert.ok(!created.ok);
    assert.equal(created.error.kind, 'instance/missing-field');
    assert.ok(created.error.kind === 'instance/missing-field' && created.error.field === 'clientQuery.apiKey');
  });

  it('rejects an impossible port', () => {
    const created = createInstanceConfig({
      id: 'party',
      name: 'Party',
      teamspeak: { host: 'ts.example.com', port: 70_000 },
      clientQuery: { host: 'client', apiKey: 'KEY' },
      audio: { pulseServer: 'tcp:client:4713' },
    });

    assert.ok(!created.ok);
    assert.equal(created.error.kind, 'instance/invalid-port');
  });
});
