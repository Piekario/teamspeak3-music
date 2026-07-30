import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AppEvent, Role } from '@tsmusic/shared';

import { FakeClock } from '../../../shared-kernel/clock.ts';
import { PermissionResolver } from '../../access/domain/permission-resolver.ts';
import type { ChannelClient, IncomingMessage, MessageTarget } from '../../instances/domain/bot-client.ts';
import {
  CommandRegistry,
  defineCommand,
  reply,
  type CommandContext,
} from '../domain/command-definition.ts';
import { CommandDispatcher } from './command-dispatcher.ts';
import { CooldownTracker } from './cooldown-tracker.ts';

interface Sent {
  readonly text: string;
  readonly private: boolean;
}

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    target: 'channel',
    text: '!ping',
    senderClientId: 7,
    senderUid: 'uid-alice',
    senderNickname: 'Alice',
    ...overrides,
  };
}

function channelClient(overrides: Partial<ChannelClient> = {}): ChannelClient {
  return { clid: 7, uid: 'uid-alice', nickname: 'Alice', serverGroupIds: [], ...overrides };
}

function build(options: {
  identities?: Record<string, Role>;
  requireSameChannel?: boolean;
  clients?: readonly ChannelClient[];
  clientsThrow?: boolean;
  handler?: (context: CommandContext) => Promise<ReturnType<typeof reply>>;
  cooldownMs?: number;
  sources?: readonly MessageTarget[];
} = {}) {
  const clock = new FakeClock(0);
  const sent: Sent[] = [];
  const events: AppEvent[] = [];
  const seenIdentities: { uid: string; nickname: string }[] = [];

  const registry = new CommandRegistry();
  registry.register(
    defineCommand({
      name: 'ping',
      defaultRole: 'user',
      usage: '!ping',
      summary: 'Check the bot is alive',
      cooldownMs: options.cooldownMs ?? 0,
      ...(options.sources !== undefined ? { sources: options.sources } : {}),
      handler: options.handler ?? (async () => reply('pong')),
    }),
  );
  registry.register(
    defineCommand({
      name: 'stop',
      defaultRole: 'dj',
      usage: '!stop',
      summary: 'Stop playback',
      cooldownMs: 0,
      handler: async () => reply('stopped'),
    }),
  );

  const dispatcher = new CommandDispatcher({
    instanceId: 'party',
    registry,
    permissions: () =>
      new PermissionResolver({
        identityGrants: new Map(Object.entries(options.identities ?? {})),
      }),
    settings: () => ({
      prefix: '!',
      requireSameChannel: options.requireSameChannel ?? false,
    }),
    cooldowns: new CooldownTracker(clock),
    clock,
    events: { publish: (event) => events.push(event) },
    channelClients: async () => {
      if (options.clientsThrow === true) throw new Error('ClientQuery is wedged');
      return options.clients ?? [channelClient()];
    },
    respond: async (_message, text, forcePrivate) => {
      sent.push({ text, private: forcePrivate });
    },
    onIdentitySeen: (uid, nickname) => seenIdentities.push({ uid, nickname }),
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  return { dispatcher, sent, events, clock, seenIdentities };
}

describe('CommandDispatcher routing', () => {
  it('runs a permitted command and returns its reply', async () => {
    const { dispatcher, sent } = build();

    await dispatcher.handle(message({ text: '!ping' }));

    assert.deepEqual(sent, [{ text: 'pong', private: false }]);
  });

  it('stays silent on ordinary chatter', async () => {
    const { dispatcher, sent } = build();

    await dispatcher.handle(message({ text: 'hello everyone' }));

    assert.equal(sent.length, 0);
  });

  it('stays silent on an unknown command — the channel is a chat, not a console', async () => {
    const { dispatcher, sent } = build();

    await dispatcher.handle(message({ text: '!nonsense' }));

    assert.equal(sent.length, 0);
  });

  it('ignores messages with no sender UID, so it cannot answer itself', async () => {
    const { dispatcher, sent } = build();

    await dispatcher.handle(message({ senderUid: '' }));

    assert.equal(sent.length, 0);
  });

  it('records the nickname seen for a UID, for the permissions UI', async () => {
    const { dispatcher, seenIdentities } = build();

    await dispatcher.handle(message({ senderNickname: 'Alice v2' }));

    assert.deepEqual(seenIdentities, [{ uid: 'uid-alice', nickname: 'Alice v2' }]);
  });

  it('refuses a command invoked from a source it does not allow', async () => {
    const { dispatcher, sent } = build({ sources: ['channel'] });

    await dispatcher.handle(message({ target: 'private' }));

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? '', /cannot be used here/);
  });
});

describe('CommandDispatcher authorisation', () => {
  it('refuses a command above the caller’s role and names what is needed', async () => {
    const { dispatcher, sent } = build();

    await dispatcher.handle(message({ text: '!stop' }));

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? '', /need the dj role/);
  });

  it('allows the same command once the caller has the role', async () => {
    const { dispatcher, sent } = build({ identities: { 'uid-alice': 'dj' } });

    await dispatcher.handle(message({ text: '!stop' }));

    assert.deepEqual(sent, [{ text: 'stopped', private: false }]);
  });

  it('gives a blocked user nothing at all, not even a refusal', async () => {
    // Answering a blocked user hands them a probe for what exists.
    const { dispatcher, sent, events } = build({ identities: { 'uid-alice': 'blocked' } });

    await dispatcher.handle(message({ text: '!ping' }));

    assert.equal(sent.length, 0);
    const logged = events.filter((event) => event.type === 'command.executed');
    assert.equal(logged.length, 1, 'the attempt is still recorded for the operator');
    assert.ok(logged[0]?.type === 'command.executed' && !logged[0].payload.allowed);
  });

  it('takes server groups from the channel listing', async () => {
    const { dispatcher, sent } = build({
      clients: [channelClient({ serverGroupIds: [12] })],
      identities: {},
    });

    // No explicit grant, no group mapping configured -> default role, so `!stop` is refused.
    await dispatcher.handle(message({ text: '!stop' }));
    assert.match(sent[0]?.text ?? '', /need the dj role/);
  });

  it('refuses commands from outside the bot’s channel when configured to', async () => {
    const { dispatcher, sent } = build({ requireSameChannel: true, clients: [] });

    await dispatcher.handle(message({ text: '!ping' }));

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? '', /in my channel/);
  });

  it('allows commands from outside the channel when the check is off', async () => {
    const { dispatcher, sent } = build({ requireSameChannel: false, clients: [] });

    await dispatcher.handle(message({ text: '!ping' }));

    assert.deepEqual(sent, [{ text: 'pong', private: false }]);
  });

  it('degrades gracefully when the channel listing fails', async () => {
    // A wedged ClientQuery must not make every command unusable.
    const { dispatcher, sent } = build({ clientsThrow: true, requireSameChannel: false });

    await dispatcher.handle(message({ text: '!ping' }));

    assert.deepEqual(sent, [{ text: 'pong', private: false }]);
  });
});

describe('CommandDispatcher throttling', () => {
  it('refuses a repeat within the cooldown and says how long to wait', async () => {
    const { dispatcher, sent } = build({ cooldownMs: 5_000 });

    await dispatcher.handle(message({ text: '!ping' }));
    await dispatcher.handle(message({ text: '!ping' }));

    assert.equal(sent.length, 2);
    assert.match(sent[1]?.text ?? '', /try again in 5s/);
  });

  it('allows the command again once the cooldown expires', async () => {
    const { dispatcher, sent, clock } = build({ cooldownMs: 5_000 });

    await dispatcher.handle(message({ text: '!ping' }));
    clock.advance(5_000);
    await dispatcher.handle(message({ text: '!ping' }));

    assert.deepEqual(sent[1], { text: 'pong', private: false });
  });

  it('cools down per user, not globally', async () => {
    const { dispatcher, sent } = build({ cooldownMs: 5_000 });

    await dispatcher.handle(message({ senderUid: 'uid-alice' }));
    await dispatcher.handle(message({ senderUid: 'uid-bob', senderNickname: 'Bob' }));

    assert.equal(sent[1]?.text, 'pong', 'Bob must not inherit Alice’s cooldown');
  });
});

describe('CommandDispatcher failure isolation', () => {
  it('survives a handler that throws and apologises instead of dying', async () => {
    const { dispatcher, sent } = build({
      handler: async () => {
        throw new Error('yt-dlp exploded');
      },
    });

    await dispatcher.handle(message({ text: '!ping' }));

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? '', /something went wrong/i);
  });

  it('does not leak the internal error into chat', async () => {
    const { dispatcher, sent } = build({
      handler: async () => {
        throw new Error('/data/secrets/cookies.txt is unreadable');
      },
    });

    await dispatcher.handle(message({ text: '!ping' }));

    assert.ok(!(sent[0]?.text ?? '').includes('cookies.txt'));
  });
});

describe('CommandDispatcher observability', () => {
  it('publishes every attempt so the web UI shows a live command log', async () => {
    const { dispatcher, events } = build();

    await dispatcher.handle(message({ text: '!ping' }));

    const logged = events.filter((event) => event.type === 'command.executed');
    assert.equal(logged.length, 1);
    assert.ok(logged[0]?.type === 'command.executed');
    assert.equal(logged[0].payload.command, 'ping');
    assert.equal(logged[0].payload.nickname, 'Alice');
    assert.equal(logged[0].instanceId, 'party');
  });

  it('records refusals too, so an operator can see who is being turned away', async () => {
    const { dispatcher, events } = build();

    await dispatcher.handle(message({ text: '!stop' }));

    const logged = events.filter((event) => event.type === 'command.executed');
    assert.ok(logged[0]?.type === 'command.executed' && !logged[0].payload.allowed);
  });
});
