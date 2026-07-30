import type { AppEvent, ConnectionState } from '@tsmusic/shared';

/** The payload of an `instance.status` event, kept as a type so it can be cached. */
export type InstanceStatusPayload = Extract<
  AppEvent,
  { type: 'instance.status' }
>['payload'];

import type { Clock } from '../../../shared-kernel/clock.ts';
import type { EventPublisher } from '../../../shared-kernel/event-bus.ts';
import { PermissionResolver } from '../../access/domain/permission-resolver.ts';
import { CommandDispatcher } from '../../chat/application/command-dispatcher.ts';
import { CooldownTracker } from '../../chat/application/cooldown-tracker.ts';
import { createMusicCommands } from '../../chat/application/music-commands.ts';
import { PendingSearches } from '../../chat/application/pending-searches.ts';
import { CommandRegistry } from '../../chat/domain/command-definition.ts';
import { PlaybackService } from '../../playback/application/playback-service.ts';
import { PlaybackSession } from '../../playback/domain/playback-session.ts';
import type { TrackResolver } from '../../playback/domain/ports.ts';
import { Queue } from '../../playback/domain/queue.ts';
import { Volume } from '../../playback/domain/values.ts';
import { FfmpegAudioOutput } from '../../playback/infrastructure/ffmpeg-audio-output.ts';
import { PactlVolumeController } from '../../playback/infrastructure/pactl-volume-controller.ts';
import type { InstanceConfig } from '../domain/instance.ts';
import { ClientQueryBotClient } from '../infrastructure/clientquery/clientquery-bot-client.ts';
import { ClientQueryConnection } from '../infrastructure/clientquery/connection.ts';

export interface InstanceRuntimeDependencies {
  readonly config: InstanceConfig;
  readonly clock: Clock;
  readonly events: EventPublisher;
  readonly resolvers: readonly TrackResolver[];
  readonly binaries: { readonly ffmpeg: string; readonly pactl: string };
  /** Must match the resolver's proxy: media URLs are bound to the requesting IP. */
  readonly proxy?: string | undefined;
  readonly webUrl?: string | undefined;
  readonly logger: RuntimeLogger;
  readonly onIdentitySeen?: (instanceId: string, uid: string, nickname: string) => void;
}

export interface RuntimeLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/**
 * Everything one bot needs, assembled and owned as a unit.
 *
 * Each runtime holds its own ClientQuery socket, its own queue and playback session, and its
 * own ffmpeg process writing to its own sink. Nothing is shared between instances except the
 * event bus — which is why one bot crashing, losing its TeamSpeak connection or being
 * reconfigured leaves the others untouched.
 */
export class InstanceRuntime {
  readonly #deps: InstanceRuntimeDependencies;
  readonly #connection: ClientQueryConnection;
  readonly #bot: ClientQueryBotClient;
  readonly #playback: PlaybackService;
  readonly #dispatcher: CommandDispatcher;
  readonly #queue: Queue;

  #config: InstanceConfig;
  #connectionState: ConnectionState = 'disconnected';
  #connectionError: string | null = null;
  /**
   * The last status broadcast, kept so a client connecting later can be handed the current
   * picture. Status events fire on change, so without this a panel opened after the bot came
   * up would sit showing "disconnected" — with every control disabled — until something
   * happened to change the state.
   */
  #lastStatus: InstanceStatusPayload = {
    connection: 'disconnected',
    error: null,
    channel: null,
    clients: [],
  };

  constructor(deps: InstanceRuntimeDependencies) {
    this.#deps = deps;
    this.#config = deps.config;

    this.#connection = new ClientQueryConnection({
      host: this.#config.clientQuery.host,
      port: this.#config.clientQuery.port,
      apiKey: this.#config.clientQuery.apiKey,
      clock: deps.clock,
      logger: deps.logger,
      onReady: () => this.#onConnectionReady(),
      onNotification: (notification) => this.#bot.handleNotification(notification),
      onPhaseChange: (phase, error) => this.#onPhaseChange(phase, error),
    });

    this.#bot = new ClientQueryBotClient(this.#connection);

    this.#queue = new Queue(this.#config.playback);
    const session = new PlaybackSession({
      queue: this.#queue,
      clock: deps.clock,
      initialVolume: Volume.clamp(this.#config.playback.defaultVolume),
    });

    this.#playback = new PlaybackService({
      instanceId: this.#config.id,
      session,
      queue: this.#queue,
      resolvers: deps.resolvers,
      audio: new FfmpegAudioOutput({
        binary: deps.binaries.ffmpeg,
        pulseServer: this.#config.audio.pulseServer,
        sinkName: this.#config.audio.sinkName,
        // Namespaced per instance so `pactl list sink-inputs` can tell several bots apart
        // on one host.
        applicationName: `tsmusic-${this.#config.id}`,
        proxy: deps.proxy,
        logger: deps.logger,
      }),
      volume: new PactlVolumeController({
        binary: deps.binaries.pactl,
        pulseServer: this.#config.audio.pulseServer,
        sinkName: this.#config.audio.sinkName,
      }),
      events: deps.events,
      clock: deps.clock,
      logger: deps.logger,
    });

    const registry = new CommandRegistry();
    registry.registerAll(
      createMusicCommands({
        playback: this.#playback,
        bot: this.#bot,
        pendingSearches: new PendingSearches(deps.clock),
        clock: deps.clock,
        settings: () => ({
          prefix: this.#config.commands.prefix,
          homeChannelId: this.#config.teamspeak.homeChannelId,
        }),
        webUrl: deps.webUrl,
      }),
    );

    this.#dispatcher = new CommandDispatcher({
      instanceId: this.#config.id,
      registry,
      // Rebuilt per dispatch so a reconfigured instance takes effect without a reconnect.
      permissions: () =>
        new PermissionResolver({
          policy: this.#config.permissions,
          identityGrants: new Map(Object.entries(this.#config.grants.identities)),
          groupGrants: this.#config.grants.serverGroups,
        }),
      settings: () => ({
        prefix: this.#config.commands.prefix,
        requireSameChannel: this.#config.commands.requireSameChannel,
      }),
      cooldowns: new CooldownTracker(deps.clock),
      clock: deps.clock,
      events: deps.events,
      channelClients: () => this.#bot.listChannelClients(),
      respond: async (message, text, forcePrivate) => {
        // A reply always returns the way the command arrived: a poke or a private message
        // is answered privately, so the channel is not filled with one person's business.
        if (forcePrivate || message.target !== 'channel') {
          await this.#bot.sendPrivateMessage(message.senderClientId, text);
          return;
        }
        await this.#bot.sendChannelMessage(text);
      },
      onIdentitySeen: (uid, nickname) =>
        deps.onIdentitySeen?.(this.#config.id, uid, nickname),
      logger: deps.logger,
    });

    this.#bot.onMessage((message) => {
      void this.#dispatcher.handle(message).catch((error: unknown) => {
        deps.logger.error('dispatch failed', {
          instance: this.#config.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  get id(): string {
    return this.#config.id;
  }

  get config(): InstanceConfig {
    return this.#config;
  }

  get playback(): PlaybackService {
    return this.#playback;
  }

  get bot(): ClientQueryBotClient {
    return this.#bot;
  }

  get connectionState(): ConnectionState {
    return this.#connectionState;
  }

  /** Current status, for handing to a client that connects after the fact. */
  get status(): InstanceStatusPayload {
    return this.#lastStatus;
  }

  start(): void {
    if (!this.#config.enabled) {
      this.#deps.logger.info('instance disabled, not connecting', { instance: this.#config.id });
      return;
    }
    this.#connection.connect();
  }

  async stop(): Promise<void> {
    await this.#playback.shutdown();
    await this.#connection.close();
    this.#setConnectionState('disconnected', null);
  }

  /**
   * Applies changed settings in place. Only a change to the TeamSpeak or ClientQuery
   * endpoint needs a reconnect; volume limits and command settings take effect immediately,
   * so an operator adjusting a limit does not interrupt the music.
   */
  applyConfig(config: InstanceConfig): { readonly requiresRestart: boolean } {
    const previous = this.#config;
    this.#config = config;
    this.#queue.applyLimits(config.playback);

    const requiresRestart =
      previous.clientQuery.host !== config.clientQuery.host ||
      previous.clientQuery.port !== config.clientQuery.port ||
      previous.clientQuery.apiKey !== config.clientQuery.apiKey ||
      previous.enabled !== config.enabled;

    return { requiresRestart };
  }

  async #onConnectionReady(): Promise<void> {
    await this.#bot.registerNotifications();

    if (this.#config.teamspeak.nickname.length > 0) {
      await this.#bot.setNickname(this.#config.teamspeak.nickname).catch(() => {
        // A nickname clash is not worth failing the connection over.
      });
    }

    // The bot must NOT mute its output, however tempting that looks for a client that has
    // nothing to listen to. TeamSpeak treats muted speakers as muting the microphone too, so
    // an output-muted bot transmits nothing at all and goes silently, confusingly dead.
    // Verified the hard way: with output muted a tone played into the sink was inaudible in
    // the channel, and became audible the moment the mute was lifted.
    //
    // Nothing is lost by leaving it unmuted. The bot cannot relay other people's voices
    // because the client's playback goes to `bot_void`, a sink whose monitor feeds nothing —
    // the feedback loop is prevented by the audio routing, not by a mute flag.
    await this.#bot.setOutputMuted(false).catch(() => {
      // Non-fatal: the routing already guarantees nothing is relayed.
    });
    await this.#bot.setInputMuted(false).catch(() => {
      // Its microphone is the music; if this fails the audio simply will not be heard.
    });

    this.#setConnectionState('connected', null);
    await this.#publishStatus();
  }

  #onPhaseChange(phase: string, error: Error | undefined): void {
    switch (phase) {
      case 'connecting':
        this.#setConnectionState('connecting', null);
        return;
      case 'ready':
        return; // `onReady` reports connected once the bootstrap has finished.
      case 'closed':
        this.#setConnectionState('disconnected', null);
        return;
      default:
        this.#setConnectionState('error', error?.message ?? null);
    }
  }

  #setConnectionState(state: ConnectionState, error: string | null): void {
    if (this.#connectionState === state && this.#connectionError === error) return;
    this.#connectionState = state;
    this.#connectionError = error;
    void this.#publishStatus();
  }

  async #publishStatus(): Promise<void> {
    const [channel, clients] = await Promise.all([
      this.#connectionState === 'connected'
        ? this.#bot.currentChannel().catch(() => null)
        : Promise.resolve(null),
      this.#connectionState === 'connected'
        ? this.#bot.listChannelClients().catch(() => [])
        : Promise.resolve([]),
    ]);

    this.#lastStatus = {
      connection: this.#connectionState,
      error: this.#connectionError,
      channel,
      clients,
    };

    this.#deps.events.publish({
      type: 'instance.status',
      instanceId: this.#config.id,
      at: this.#deps.clock.now().toISOString(),
      payload: this.#lastStatus,
    });
  }
}
