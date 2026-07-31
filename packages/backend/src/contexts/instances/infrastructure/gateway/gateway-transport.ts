import type { ConnectionState } from '@tsmusic/shared';

import type { AudioOutput } from '../../../playback/domain/ports.ts';
import { PcmStreamAudioOutput } from '../../../playback/infrastructure/pcm-stream-audio-output.ts';
import type { BotClient, MessageListener } from '../../domain/bot-client.ts';
import type { InstanceConfig } from '../../domain/instance.ts';
import type { InstanceTransport } from '../../domain/instance-transport.ts';
import { GatewayBotClient } from './gateway-bot-client.ts';
import {
  describeGatewayError,
  type GatewayConnection,
  type GatewayLogger,
} from './gateway-connection.ts';

export interface GatewayTransportOptions {
  readonly config: InstanceConfig;
  /** Shared by every instance: the gateway holds all bots in one process. */
  readonly connection: GatewayConnection;
  readonly logger: GatewayLogger;
  readonly ffmpegBinary: string;
  readonly pcmHost: string;
  readonly pcmPort: number;
  readonly proxy?: string | undefined;
  readonly onReady: () => Promise<void>;
  /**
   * Persisted TeamSpeak identity. A bot without one is a stranger on every restart, losing
   * whatever server groups an admin granted it, so the caller is expected to store what the
   * gateway hands back the first time.
   */
  readonly identity: { readonly key: string | null; readonly offset: number };
  readonly onIdentityIssued: (key: string, offset: number, uid: string) => void;
}

/**
 * The TSLib transport: the bot is an object inside a shared gateway process rather than a
 * TeamSpeak client of its own.
 *
 * Creating a bot is a request, not a container: no image to emulate, no virtual sound card,
 * no first-run wizard, and no identity file to look after on disk.
 */
export class GatewayTransport implements InstanceTransport {
  readonly #options: GatewayTransportOptions;
  readonly #bot: GatewayBotClient;
  readonly #audio: AudioOutput;
  readonly #unsubscribeStatus: () => void;
  #onConnectionChange: ((state: ConnectionState, error: string | null) => void) | undefined;

  constructor(options: GatewayTransportOptions) {
    this.#options = options;
    this.#bot = new GatewayBotClient(options.connection, options.config.id);

    this.#audio = new PcmStreamAudioOutput({
      binary: options.ffmpegBinary,
      host: options.pcmHost,
      port: options.pcmPort,
      botId: options.config.id,
      proxy: options.proxy,
      logger: options.logger,
    });

    this.#unsubscribeStatus = options.connection.onEvent((event) => {
      if (event.botId !== options.config.id || event.type !== 'status') return;
      const payload = event.payload as { connection?: string; error?: string | null };
      this.#onConnectionChange?.(toConnectionState(payload.connection), payload.error ?? null);
    });
  }

  get bot(): BotClient {
    return this.#bot;
  }

  get audio(): AudioOutput {
    return this.#audio;
  }

  start(): void {
    void this.#createBot();
  }

  async stop(): Promise<void> {
    this.#unsubscribeStatus();
    this.#bot.dispose();
    await this.#options.connection.send('bot.destroy', this.#options.config.id);
  }

  onMessage(listener: MessageListener): () => void {
    return this.#bot.onMessage(listener);
  }

  onConnectionChange(listener: (state: ConnectionState, error: string | null) => void): void {
    this.#onConnectionChange = listener;
  }

  /**
   * Asks the gateway to bring this bot into being. Runs on every start, including after a
   * gateway restart — the bots live in that process, so when it goes they go with it.
   */
  async #createBot(): Promise<void> {
    const { config, identity } = this.#options;
    this.#onConnectionChange?.('connecting', null);

    const created = await this.#options.connection.send<{
      identity: string;
      identityOffset: number;
      uid: string;
    }>('bot.create', config.id, {
      host: config.teamspeak.host,
      port: config.teamspeak.port,
      nickname: config.teamspeak.nickname,
      serverPassword: config.serverPassword,
      // Passed on every create, which is also every reconnect: a server restart drops the
      // bot into the default channel, so rejoining has to be part of connecting rather than
      // a one-off at first start.
      channel: config.teamspeak.channel,
      channelPassword: config.teamspeak.channelPassword,
      identity: identity.key,
      identityOffset: identity.offset,
    });

    if (!created.ok) {
      const detail = describeGatewayError(created.error);
      this.#options.logger.error('could not create bot on the gateway', {
        instance: config.id,
        detail,
      });
      this.#onConnectionChange?.('error', detail);
      return;
    }

    // Issued on first creation and unchanged afterwards; storing it is what keeps the bot
    // the same person to the server across restarts.
    if (identity.key === null) {
      this.#options.onIdentityIssued(
        created.value.identity,
        created.value.identityOffset,
        created.value.uid,
      );
    }

    await this.#options.onReady();
  }
}

function toConnectionState(raw: string | undefined): ConnectionState {
  switch (raw) {
    case 'connected':
    case 'connecting':
    case 'error':
      return raw;
    default:
      return 'disconnected';
  }
}
