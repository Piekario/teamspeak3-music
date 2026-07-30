import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { after, describe, it } from 'node:test';

import { systemClock } from '../../../../shared-kernel/clock.ts';
import { ClientQueryConnection } from './connection.ts';
import { ClientQueryError, type ParsedNotification } from './protocol.ts';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * A stand-in for the ClientQuery plugin: greets like the real one and lets each test script
 * the reply to every command it receives. This exercises the real socket, the real line
 * framing and the real serialisation — everything except the TeamSpeak client itself.
 */
class FakeClientQueryServer {
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly received: string[] = [];
  #respond: (command: string, socket: Socket) => void = () => {};

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(): Promise<FakeClientQueryServer> {
    const server = createServer();
    const fake = new FakeClientQueryServer(server);

    server.on('connection', (socket) => {
      fake.#sockets.add(socket);
      socket.setEncoding('utf8');
      socket.write('TS3 Client\nWelcome to the TeamSpeak 3 ClientQuery interface\n');

      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.length > 0) {
            fake.received.push(line);
            fake.#respond(line, socket);
          }
          index = buffer.indexOf('\n');
        }
      });
      socket.on('error', () => {});
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  get port(): number {
    const address = this.#server.address();
    assert.ok(address !== null && typeof address === 'object');
    return address.port;
  }

  respondWith(handler: (command: string, socket: Socket) => void): void {
    this.#respond = handler;
  }

  pushToAll(line: string): void {
    for (const socket of this.#sockets) socket.write(`${line}\n`);
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

/** Answers `auth` with success and anything else through the supplied handler. */
function authThen(handler: (command: string, socket: Socket) => void) {
  return (command: string, socket: Socket) => {
    if (command.startsWith('auth ')) {
      socket.write('error id=0 msg=ok\n');
      return;
    }
    handler(command, socket);
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ClientQueryConnection', () => {
  const servers: FakeClientQueryServer[] = [];
  const connections: ClientQueryConnection[] = [];

  after(async () => {
    await Promise.all(connections.map((connection) => connection.close()));
    await Promise.all(servers.map((server) => server.stop()));
  });

  async function connect(
    options: {
      onNotification?: (notification: ParsedNotification) => void;
      onReady?: () => Promise<void>;
    } = {},
  ): Promise<{ server: FakeClientQueryServer; connection: ClientQueryConnection }> {
    const server = await FakeClientQueryServer.start();
    servers.push(server);

    const connection = new ClientQueryConnection({
      host: '127.0.0.1',
      port: server.port,
      apiKey: 'AAAA-BBBB-CCCC-DDDD-EEEE',
      clock: systemClock,
      logger: silentLogger,
      ...options,
    });
    connections.push(connection);
    return { server, connection };
  }

  it('authenticates before anything else and reports ready', async () => {
    const { server, connection } = await connect();
    server.respondWith(authThen((_, socket) => socket.write('error id=0 msg=ok\n')));

    connection.connect();
    await waitFor(() => connection.isReady);

    assert.equal(server.received[0], 'auth apikey=AAAA-BBBB-CCCC-DDDD-EEEE');
  });

  it('resolves a command with its parsed payload', async () => {
    const { server, connection } = await connect();
    server.respondWith(
      authThen((command, socket) => {
        if (command === 'whoami') {
          socket.write('clid=7 cid=3\n');
          socket.write('error id=0 msg=ok\n');
        }
      }),
    );

    connection.connect();
    await waitFor(() => connection.isReady);

    const response = await connection.send('whoami');
    assert.equal(response.items[0]?.['clid'], '7');
    assert.equal(response.items[0]?.['cid'], '3');
  });

  it('rejects with ClientQueryError when the client refuses a command', async () => {
    const { server, connection } = await connect();
    server.respondWith(
      authThen((_, socket) =>
        socket.write('error id=2568 msg=insufficient\\sclient\\spermissions\n'),
      ),
    );

    connection.connect();
    await waitFor(() => connection.isReady);

    await assert.rejects(
      () => connection.send('clientkick', { params: { clid: 5 } }),
      (error: unknown) => {
        assert.ok(error instanceof ClientQueryError);
        assert.equal(error.id, 2568);
        assert.equal(error.rawMessage, 'insufficient client permissions');
        assert.equal(error.command, 'clientkick');
        return true;
      },
    );
  });

  it('serialises requests: the second command is not sent until the first is answered', async () => {
    const { server, connection } = await connect();
    const inFlight: string[] = [];
    let releaseFirst: (() => void) | undefined;

    server.respondWith(
      authThen((command, socket) => {
        inFlight.push(command);
        if (command === 'slow') {
          releaseFirst = () => {
            socket.write('done=1\n');
            socket.write('error id=0 msg=ok\n');
          };
          return;
        }
        socket.write('error id=0 msg=ok\n');
      }),
    );

    connection.connect();
    await waitFor(() => connection.isReady);

    const first = connection.send('slow');
    const second = connection.send('fast');

    await waitFor(() => inFlight.includes('slow'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(!inFlight.includes('fast'), '`fast` must wait for `slow` to be answered');

    releaseFirst?.();
    await first;
    await second;
    assert.deepEqual(inFlight, ['slow', 'fast']);
  });

  it('routes a notification that interleaves a pending response out of band', async () => {
    const notifications: ParsedNotification[] = [];
    const { server, connection } = await connect({
      onNotification: (notification) => notifications.push(notification),
    });

    server.respondWith(
      authThen((command, socket) => {
        if (command === 'clientlist') {
          socket.write('clid=1 client_nickname=Alice\n');
          // The plugin pushes an event right in the middle of the reply.
          socket.write('notifytextmessage targetmode=2 msg=!ping invokeruid=abc=\n');
          socket.write('error id=0 msg=ok\n');
        }
      }),
    );

    connection.connect();
    await waitFor(() => connection.isReady);

    const response = await connection.send('clientlist');

    // The notification must not have contaminated the response payload.
    assert.equal(response.items.length, 1);
    assert.equal(response.items[0]?.['client_nickname'], 'Alice');
    assert.equal(response.items[0]?.['msg'], undefined);

    await waitFor(() => notifications.length === 1);
    assert.equal(notifications[0]?.name, 'notifytextmessage');
    assert.equal(notifications[0]?.items[0]?.['msg'], '!ping');
  });

  it('delivers unsolicited notifications that arrive while idle', async () => {
    const notifications: ParsedNotification[] = [];
    const { server, connection } = await connect({
      onNotification: (notification) => notifications.push(notification),
    });
    server.respondWith(authThen(() => {}));

    connection.connect();
    await waitFor(() => connection.isReady);

    server.pushToAll('notifyclientpoke invokeruid=xyz= msg=hello');
    await waitFor(() => notifications.length === 1);
    assert.equal(notifications[0]?.name, 'notifyclientpoke');
  });

  it('reassembles lines split across TCP chunks', async () => {
    const { server, connection } = await connect();
    server.respondWith(
      authThen((command, socket) => {
        if (command !== 'whoami') return;
        // A single logical line arriving in three writes.
        socket.write('clid=');
        setTimeout(() => socket.write('42 cid=9'), 5);
        setTimeout(() => socket.write('\nerror id=0 msg=ok\n'), 10);
      }),
    );

    connection.connect();
    await waitFor(() => connection.isReady);

    const response = await connection.send('whoami');
    assert.equal(response.items[0]?.['clid'], '42');
    assert.equal(response.items[0]?.['cid'], '9');
  });

  it('runs the onReady hook after every connect so notifications can be re-registered', async () => {
    let readyCalls = 0;
    const { server, connection } = await connect({
      onReady: async () => {
        readyCalls += 1;
      },
    });
    server.respondWith(authThen((_, socket) => socket.write('error id=0 msg=ok\n')));

    connection.connect();
    await waitFor(() => readyCalls === 1);
    assert.equal(readyCalls, 1);
  });

  it('fails pending requests when the socket drops', async () => {
    const { server, connection } = await connect();
    let liveSocket: Socket | undefined;
    server.respondWith(
      authThen((command, socket) => {
        liveSocket = socket;
        if (command === 'hang') return; // never answered
        socket.write('error id=0 msg=ok\n');
      }),
    );

    connection.connect();
    await waitFor(() => connection.isReady);

    const pending = connection.send('hang');
    await waitFor(() => liveSocket !== undefined);
    liveSocket?.destroy();

    await assert.rejects(() => pending);
    await connection.close();
  });
});
