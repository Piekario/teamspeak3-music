import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AppEvent } from '@tsmusic/shared';

import { EventBus } from '../../shared-kernel/event-bus.ts';
import { WebSocketHub, type WebSocketLike } from './websocket-hub.ts';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
  readyState = 1;
  closedWith: number | undefined;
  throwOnSend = false;

  send(data: string): void {
    if (this.throwOnSend) throw new Error('socket is wedged');
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  get events(): AppEvent[] {
    return this.sent.map((raw) => JSON.parse(raw) as AppEvent);
  }
}

function event(instanceId: string, message = 'hello'): AppEvent {
  return {
    type: 'log',
    instanceId,
    at: '2026-07-31T10:00:00.000Z',
    payload: { level: 'info', message },
  };
}

describe('WebSocketHub broadcasting', () => {
  it('sends an event to every connected client', () => {
    const hub = new WebSocketHub(silentLogger);
    const first = new FakeSocket();
    const second = new FakeSocket();
    hub.add(first);
    hub.add(second);

    hub.broadcast(event('party'));

    assert.equal(first.events.length, 1);
    assert.equal(second.events.length, 1);
    assert.equal(first.events[0]?.instanceId, 'party');
  });

  it('multiplexes several bots down one socket', () => {
    // The panel's instance switcher filters this stream; it does not reconnect.
    const hub = new WebSocketHub(silentLogger);
    const socket = new FakeSocket();
    hub.add(socket);

    hub.broadcast(event('party'));
    hub.broadcast(event('chill'));

    assert.deepEqual(
      socket.events.map((e) => e.instanceId),
      ['party', 'chill'],
    );
  });

  it('drops a client that is no longer open', () => {
    const hub = new WebSocketHub(silentLogger);
    const socket = new FakeSocket();
    hub.add(socket);
    socket.readyState = 3;

    hub.broadcast(event('party'));

    assert.equal(socket.sent.length, 0);
    assert.equal(hub.clientCount, 0);
  });

  it('drops a wedged client instead of letting it stall playback', () => {
    const hub = new WebSocketHub(silentLogger);
    const wedged = new FakeSocket();
    const healthy = new FakeSocket();
    wedged.throwOnSend = true;
    hub.add(wedged);
    hub.add(healthy);

    hub.broadcast(event('party'));

    assert.equal(hub.clientCount, 1, 'the wedged client is removed');
    assert.equal(healthy.events.length, 1, 'the healthy client still received the event');
  });

  it('does nothing when nobody is listening', () => {
    const hub = new WebSocketHub(silentLogger);
    assert.doesNotThrow(() => hub.broadcast(event('party')));
  });
});

describe('WebSocketHub bus integration', () => {
  it('forwards events published on the bus', () => {
    const bus = new EventBus(() => {});
    const hub = new WebSocketHub(silentLogger);
    const socket = new FakeSocket();
    hub.add(socket);
    hub.attach(bus);

    bus.publish(event('party', 'from the bus'));

    assert.equal(socket.events.length, 1);
    assert.ok(socket.sent[0]?.includes('from the bus'));
  });

  it('stops forwarding once detached', () => {
    const bus = new EventBus(() => {});
    const hub = new WebSocketHub(silentLogger);
    const socket = new FakeSocket();
    hub.add(socket);
    const detach = hub.attach(bus);

    detach();
    bus.publish(event('party'));

    assert.equal(socket.sent.length, 0);
  });
});

describe('WebSocketHub connection lifecycle', () => {
  it('sends a snapshot to one client without touching the others', () => {
    const hub = new WebSocketHub(silentLogger);
    const joining = new FakeSocket();
    const existing = new FakeSocket();
    hub.add(joining);
    hub.add(existing);

    hub.sendTo(joining, [event('party'), event('chill')]);

    assert.equal(joining.events.length, 2, 'the new client gets the current state immediately');
    assert.equal(existing.events.length, 0);
  });

  it('closes every client on shutdown', () => {
    const hub = new WebSocketHub(silentLogger);
    const socket = new FakeSocket();
    hub.add(socket);

    hub.closeAll();

    assert.equal(socket.closedWith, 1001);
    assert.equal(hub.clientCount, 0);
  });
});
