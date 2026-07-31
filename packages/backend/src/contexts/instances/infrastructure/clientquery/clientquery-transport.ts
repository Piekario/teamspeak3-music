import type { ConnectionState } from '@tsmusic/shared';

import type { Clock } from '../../../../shared-kernel/clock.ts';
import type { AudioOutput } from '../../../playback/domain/ports.ts';
import { FfmpegAudioOutput } from '../../../playback/infrastructure/ffmpeg-audio-output.ts';
import type { BotClient, MessageListener } from '../../domain/bot-client.ts';
import type { InstanceConfig } from '../../domain/instance.ts';
import type { InstanceTransport } from '../../domain/instance-transport.ts';
import { ClientQueryBotClient } from './clientquery-bot-client.ts';
import { ClientQueryConnection, type ClientQueryLogger } from './connection.ts';

export interface ClientQueryTransportOptions {
  readonly config: InstanceConfig;
  readonly clock: Clock;
  readonly logger: ClientQueryLogger;
  readonly ffmpegBinary: string;
  readonly pactlBinary: string;
  readonly proxy?: string | undefined;
  readonly onReady: () => Promise<void>;
}

/**
 * The original transport: a headless TeamSpeak client per bot, driven over ClientQuery, with
 * audio pushed into a PulseAudio sink that the client captures as its microphone.
 *
 * Kept intact after the move to TSLib rather than deleted. It is the only path that has run
 * against a real server for any length of time, so it stays available as a fallback while
 * the new one earns that confidence.
 */
export class ClientQueryTransport implements InstanceTransport {
  readonly #connection: ClientQueryConnection;
  readonly #bot: ClientQueryBotClient;
  readonly #audio: AudioOutput;
  #onConnectionChange: ((state: ConnectionState, error: string | null) => void) | undefined;

  constructor(options: ClientQueryTransportOptions) {
    const { config } = options;

    this.#connection = new ClientQueryConnection({
      host: config.clientQuery.host,
      port: config.clientQuery.port,
      apiKey: config.clientQuery.apiKey,
      clock: options.clock,
      logger: options.logger,
      onReady: async () => {
        await this.#bot.registerNotifications();
        await options.onReady();
      },
      onNotification: (notification) => this.#bot.handleNotification(notification),
      onPhaseChange: (phase, error) => this.#onPhase(phase, error),
    });

    this.#bot = new ClientQueryBotClient(this.#connection);

    this.#audio = new FfmpegAudioOutput({
      binary: options.ffmpegBinary,
      pulseServer: config.audio.pulseServer,
      sinkName: config.audio.sinkName,
      applicationName: `tsmusic-${config.id}`,
      proxy: options.proxy,
      logger: options.logger,
    });
  }

  get bot(): BotClient {
    return this.#bot;
  }

  get audio(): AudioOutput {
    return this.#audio;
  }

  start(): void {
    this.#connection.connect();
  }

  async stop(): Promise<void> {
    await this.#connection.close();
  }

  onMessage(listener: MessageListener): () => void {
    return this.#bot.onMessage(listener);
  }

  onConnectionChange(listener: (state: ConnectionState, error: string | null) => void): void {
    this.#onConnectionChange = listener;
  }

  #onPhase(phase: string, error: Error | undefined): void {
    switch (phase) {
      case 'connecting':
        this.#onConnectionChange?.('connecting', null);
        return;
      case 'ready':
        // `onReady` reports connected once the bootstrap has finished.
        return;
      case 'closed':
        this.#onConnectionChange?.('disconnected', null);
        return;
      default:
        this.#onConnectionChange?.('error', error?.message ?? null);
    }
  }
}
