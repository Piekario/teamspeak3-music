import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeClock } from '../../../shared-kernel/clock.ts';
import { ConnectionSupervisor } from './connection-supervisor.ts';

const silentLogger = { info: () => {}, warn: () => {} };

function build(options: { minDelayMs?: number; maxDelayMs?: number } = {}) {
  let reconnects = 0;
  let enabled = true;
  const supervisor = new ConnectionSupervisor({
    instanceId: 'party',
    clock: new FakeClock(0),
    logger: silentLogger,
    reconnect: () => {
      reconnects += 1;
    },
    isEnabled: () => enabled,
    minDelayMs: options.minDelayMs ?? 10,
    maxDelayMs: options.maxDelayMs ?? 80,
  });

  return {
    supervisor,
    attempts: () => reconnects,
    setEnabled: (next: boolean) => {
      enabled = next;
    },
  };
}

/** The supervisor schedules with real timers, so tests wait rather than fake the clock. */
const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ConnectionSupervisor', () => {
  it('retries when the bot drops off the server', async () => {
    const { supervisor, attempts } = build();
    supervisor.start();

    supervisor.observe('disconnected');
    await after(30);

    assert.ok(attempts() >= 1, 'a dropped bot must be brought back');
  });

  it('does not retry while auto-reconnect is switched off', async () => {
    const { supervisor, attempts, setEnabled } = build();
    supervisor.start();
    setEnabled(false);

    supervisor.observe('disconnected');
    await after(40);

    assert.equal(attempts(), 0);
  });

  it('abandons a retry loop the moment the setting is switched off', async () => {
    // Switching it off during an outage means "stop trying now", not "stop trying next time".
    const { supervisor, attempts, setEnabled } = build();
    supervisor.start();
    supervisor.observe('disconnected');
    await after(30);

    const before = attempts();
    setEnabled(false);
    supervisor.observe('disconnected');
    await after(60);

    assert.equal(attempts(), before);
  });

  it('does nothing until started', async () => {
    const { supervisor, attempts } = build();

    supervisor.observe('disconnected');
    await after(30);

    assert.equal(attempts(), 0);
  });

  it('stops retrying once deliberately stopped', async () => {
    // Otherwise pressing "disconnect" in the panel makes the bot reappear moments later.
    const { supervisor, attempts } = build();
    supervisor.start();
    supervisor.observe('disconnected');

    supervisor.stop();
    await after(40);

    assert.equal(attempts(), 0);
  });

  it('ignores `connecting`, which is an attempt already in flight', async () => {
    const { supervisor, attempts } = build();
    supervisor.start();

    supervisor.observe('connecting');
    await after(30);

    assert.equal(attempts(), 0, 'scheduling on top of an in-flight attempt stacks them up');
  });

  it('treats an error state as a reason to retry', async () => {
    const { supervisor, attempts } = build();
    supervisor.start();

    supervisor.observe('error');
    await after(30);

    assert.ok(attempts() >= 1);
  });

  it('stops retrying once the bot is back', async () => {
    const { supervisor, attempts } = build();
    supervisor.start();

    supervisor.observe('disconnected');
    await after(25);
    const afterDrop = attempts();

    supervisor.observe('connected');
    await after(60);

    assert.equal(attempts(), afterDrop, 'no further attempts once connected');
  });

  it('backs off between attempts rather than hammering the server', async () => {
    const { supervisor, attempts } = build({ minDelayMs: 20, maxDelayMs: 200 });
    supervisor.start();

    supervisor.observe('disconnected');
    await after(10);
    assert.equal(attempts(), 0, 'the first retry waits for the delay to elapse');

    await after(25);
    assert.equal(attempts(), 1);
  });

  it('caps the delay so a rebooting server is noticed quickly', async () => {
    // Unbounded backoff would leave a bot absent for many minutes after a brief restart.
    const { supervisor, attempts } = build({ minDelayMs: 10, maxDelayMs: 20 });
    supervisor.start();

    for (let i = 0; i < 4; i += 1) {
      supervisor.observe('disconnected');
      await after(30);
    }

    assert.ok(attempts() >= 3, 'the delay must not grow without bound');
  });
});
