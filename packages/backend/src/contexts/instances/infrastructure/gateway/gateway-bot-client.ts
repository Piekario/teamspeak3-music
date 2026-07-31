import type { ChannelClient, ChannelRef } from '@tsmusic/shared';

import type {
  BotClient,
  BotIdentity,
  IncomingMessage,
  MessageListener,
  MessageTarget,
} from '../../domain/bot-client.ts';
import { chunkMessage, stripBbCode } from '../clientquery/chat-message.ts';
import {
  describeGatewayError,
  type GatewayConnection,
  type GatewayEvent,
} from './gateway-connection.ts';

/**
 * Implements the `BotClient` port over the TSLib gateway.
 *
 * This class is the entire cost of changing transport. Everything above it — the command
 * dispatcher, the permission resolver, the playback service, the REST API, the panel — is
 * untouched, because none of them ever knew what a TeamSpeak client was. Declaring the port
 * in the domain on day one is what turned "replace the transport" into "write one adapter".
 *
 * Two behaviours are kept from the ClientQuery adapter because they are properties of
 * TeamSpeak rather than of the transport: BBCode arrives wrapped around URLs, and messages
 * are capped at 1024 characters.
 */
export class GatewayBotClient implements BotClient {
  readonly #connection: GatewayConnection;
  readonly #botId: string;
  readonly #listeners = new Set<MessageListener>();
  #unsubscribe: (() => void) | undefined;

  constructor(connection: GatewayConnection, botId: string) {
    this.#connection = connection;
    this.#botId = botId;
    this.#unsubscribe = connection.onEvent((event) => this.#onGatewayEvent(event));
  }

  onMessage(listener: MessageListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#listeners.clear();
  }

  async whoami(): Promise<BotIdentity> {
    const result = await this.#send<{
      clientId: number;
      channelId: number;
      uid: string;
      nickname: string;
    }>('bot.whoami');

    return {
      clientId: result.clientId,
      channelId: result.channelId,
      uid: result.uid,
      nickname: result.nickname,
    };
  }

  async currentChannel(): Promise<ChannelRef> {
    const channel = await this.#send<ChannelRef | null>('bot.currentChannel');
    // A bot that has not finished joining has no channel; reporting id 0 keeps callers from
    // having to special-case a transient state they cannot act on anyway.
    return channel ?? { id: 0, name: '' };
  }

  async listChannels(): Promise<readonly ChannelRef[]> {
    return this.#send<ChannelRef[]>('bot.listChannels');
  }

  async listChannelClients(): Promise<readonly ChannelClient[]> {
    return this.#send<ChannelClient[]>('bot.listChannelClients');
  }

  async sendChannelMessage(text: string): Promise<void> {
    for (const chunk of chunkMessage(text)) {
      await this.#send('bot.sendChannelMessage', { text: chunk });
    }
  }

  async sendPrivateMessage(clientId: number, text: string): Promise<void> {
    for (const chunk of chunkMessage(text)) {
      await this.#send('bot.sendPrivateMessage', { clientId, text: chunk });
    }
  }

  async moveToChannel(channelId: number, password?: string): Promise<void> {
    await this.#send('bot.moveToChannel', { channelId, password: password ?? null });
  }

  async setNickname(nickname: string): Promise<void> {
    await this.#send('bot.setNickname', { nickname });
  }

  /**
   * Muting is a no-op on this transport, and that is the correct behaviour rather than an
   * omission. The GUI client needed it because its playback shared an audio chain with its
   * microphone; a TSLib bot has no speakers to mute — it never receives audio it could
   * retransmit — so the feedback loop the mute defended against cannot exist.
   */
  async setOutputMuted(): Promise<void> {}

  async setInputMuted(): Promise<void> {}

  async #send<T>(command: string, payload?: unknown): Promise<T> {
    const result = await this.#connection.send<T>(command, this.#botId, payload);
    if (!result.ok) throw new Error(describeGatewayError(result.error));
    return result.value;
  }

  #onGatewayEvent(event: GatewayEvent): void {
    if (event.botId !== this.#botId || event.type !== 'message') return;

    const payload = event.payload as {
      target?: string;
      text?: string;
      senderClientId?: number;
      senderUid?: string;
      senderNickname?: string;
    };

    const message: IncomingMessage = {
      target: toMessageTarget(payload.target),
      // TeamSpeak wraps pasted URLs in BBCode regardless of transport, and yt-dlp chokes on
      // the result.
      text: stripBbCode(payload.text ?? ''),
      senderClientId: payload.senderClientId ?? 0,
      senderUid: payload.senderUid ?? '',
      senderNickname: payload.senderNickname ?? '',
    };

    for (const listener of this.#listeners) listener(message);
  }
}

function toMessageTarget(raw: string | undefined): MessageTarget {
  return raw === 'private' || raw === 'poke' ? raw : 'channel';
}
