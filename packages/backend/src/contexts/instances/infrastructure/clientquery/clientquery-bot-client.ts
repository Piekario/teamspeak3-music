import type { ChannelClient, ChannelRef } from '@tsmusic/shared';

import type {
  BotClient,
  BotIdentity,
  IncomingMessage,
  MessageListener,
  MessageTarget,
} from '../../domain/bot-client.ts';
import { chunkMessage, stripBbCode } from './chat-message.ts';
import type { ClientQueryConnection } from './connection.ts';
import type { ParamMap, ParsedNotification } from './protocol.ts';

/**
 * TeamSpeak's `targetmode`: 1 addresses a client, 2 the current channel, 3 the whole server.
 */
const TARGET_MODE_CLIENT = 1;
const TARGET_MODE_CHANNEL = 2;

const NOTIFICATIONS_TO_REGISTER = [
  'notifytextmessage',
  'notifyclientpoke',
  'notifycliententerview',
  'notifyclientleftview',
  'notifyclientmoved',
  'notifyconnectstatuschange',
] as const;

/**
 * Adapts the raw ClientQuery socket to the `BotClient` port.
 *
 * Everything awkward about the protocol is absorbed here: numeric target modes, BBCode on
 * the way in, the 1024-character cap on the way out, and the fact that "send a message to
 * the channel" implicitly means whichever channel the client currently occupies — which is
 * why channel moves go through this class, so the cached channel can be invalidated.
 */
export class ClientQueryBotClient implements BotClient {
  readonly #connection: ClientQueryConnection;
  readonly #listeners = new Set<MessageListener>();
  #cachedChannel: ChannelRef | undefined;

  constructor(connection: ClientQueryConnection) {
    this.#connection = connection;
  }

  /** Called from the connection's `onReady` hook, so it re-runs after every reconnect. */
  async registerNotifications(): Promise<void> {
    this.#cachedChannel = undefined;
    for (const event of NOTIFICATIONS_TO_REGISTER) {
      await this.#connection.send('clientnotifyregister', {
        params: { schandlerid: 1, event },
      });
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Wired to the connection's `onNotification`; translates wire events into domain ones. */
  handleNotification(notification: ParsedNotification): void {
    const item = notification.items[0];
    if (item === undefined) {
      if (notification.name === 'notifyconnectstatuschange') this.#cachedChannel = undefined;
      return;
    }

    switch (notification.name) {
      case 'notifytextmessage':
        this.#emitMessage(item, targetModeToTarget(item['targetmode']));
        return;
      case 'notifyclientpoke':
        this.#emitMessage(item, 'poke');
        return;
      case 'notifyclientmoved':
      case 'notifyconnectstatuschange':
        // The bot itself may have been dragged elsewhere; re-read the channel on next use.
        this.#cachedChannel = undefined;
        return;
      default:
        return;
    }
  }

  async whoami(): Promise<BotIdentity> {
    const { items } = await this.#connection.send('whoami');
    const item = items[0] ?? {};
    const clientId = toInt(item['clid']);
    const channelId = toInt(item['cid']);

    // `whoami` reports ids but not the UID, which permissions and self-identification need.
    const info = await this.#connection.send('clientvariable', {
      params: { clid: clientId, client_unique_identifier: '' },
    });
    const infoItem = info.items[0] ?? {};

    return {
      clientId,
      channelId,
      uid: infoItem['client_unique_identifier'] ?? '',
      nickname: infoItem['client_nickname'] ?? '',
    };
  }

  async currentChannel(): Promise<ChannelRef> {
    if (this.#cachedChannel !== undefined) return this.#cachedChannel;

    const { channelId } = await this.whoami();
    const { items } = await this.#connection.send('channelvariable', {
      params: { cid: channelId, channel_name: '' },
    });

    const channel: ChannelRef = {
      id: channelId,
      name: items[0]?.['channel_name'] ?? '',
    };
    this.#cachedChannel = channel;
    return channel;
  }

  async listChannels(): Promise<readonly ChannelRef[]> {
    const { items } = await this.#connection.send('channellist');
    return items.map((item) => ({
      id: toInt(item['cid']),
      name: item['channel_name'] ?? '',
    }));
  }

  async listChannelClients(): Promise<readonly ChannelClient[]> {
    const { id: channelId } = await this.currentChannel();
    const { items } = await this.#connection.send('clientlist', {
      flags: ['-uid', '-groups'],
    });

    return items
      .filter((item) => toInt(item['cid']) === channelId)
      .map((item) => ({
        clid: toInt(item['clid']),
        uid: item['client_unique_identifier'] ?? '',
        nickname: item['client_nickname'] ?? '',
        serverGroupIds: parseServerGroups(item['client_servergroups']),
      }));
  }

  async sendChannelMessage(text: string): Promise<void> {
    for (const chunk of chunkMessage(text)) {
      await this.#connection.sendPaced('sendtextmessage', {
        params: { targetmode: TARGET_MODE_CHANNEL, msg: chunk },
      });
    }
  }

  async sendPrivateMessage(clientId: number, text: string): Promise<void> {
    for (const chunk of chunkMessage(text)) {
      await this.#connection.sendPaced('sendtextmessage', {
        params: { targetmode: TARGET_MODE_CLIENT, target: clientId, msg: chunk },
      });
    }
  }

  async moveToChannel(channelId: number, password?: string): Promise<void> {
    const { clientId } = await this.whoami();
    await this.#connection.send('clientmove', {
      params: { clid: clientId, cid: channelId, cpw: password },
    });
    this.#cachedChannel = undefined;
  }

  async setNickname(nickname: string): Promise<void> {
    await this.#connection.send('clientupdate', {
      params: { client_nickname: nickname },
    });
  }

  #emitMessage(item: ParamMap, target: MessageTarget): void {
    const message: IncomingMessage = {
      target,
      text: stripBbCode(item['msg'] ?? ''),
      senderClientId: toInt(item['invokerid']),
      senderUid: item['invokeruid'] ?? '',
      senderNickname: item['invokername'] ?? '',
    };
    for (const listener of this.#listeners) listener(message);
  }
}

function targetModeToTarget(rawTargetMode: string | undefined): MessageTarget {
  return toInt(rawTargetMode) === TARGET_MODE_CLIENT ? 'private' : 'channel';
}

/** `client_servergroups` is a comma-separated list, e.g. `6,12,143`. */
function parseServerGroups(raw: string | undefined): readonly number[] {
  if (raw === undefined || raw.length === 0) return [];
  return raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => !Number.isNaN(value));
}

function toInt(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isNaN(value) ? 0 : value;
}
