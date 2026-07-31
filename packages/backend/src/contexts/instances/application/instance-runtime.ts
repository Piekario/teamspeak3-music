import type { AppEvent, ConnectionState } from '@tsmusic/shared';

/** The payload of an `instance.status` event, kept as a type so it can be cached. */
export type InstanceStatusPayload = Extract<
  AppEvent,
  { type: 'instance.status' }
>['payload'];

import type { Clock } from '../../../shared-kernel/clock.ts';
import type { EventPublisher } from '../../../shared-kernel/event-bus.ts';
import { PermissionResolver } from '../../access/domain/permission-resolver.ts';
import { PlaylistService } from '../../catalog/application/playlist-service.ts';
import type { PlaylistRepository } from '../../catalog/domain/repositories.ts';
import { CommandDispatcher } from '../../chat/application/command-dispatcher.ts';
import { CooldownTracker } from '../../chat/application/cooldown-tracker.ts';
import { createMusicCommands } from '../../chat/application/music-commands.ts';
import { PendingSearches } from '../../chat/application/pending-searches.ts';
import { CommandRegistry } from '../../chat/domain/command-definition.ts';
import { PlaybackService } from '../../playback/application/playback-service.ts';
import { PlaybackSession } from '../../playback/domain/playback-session.ts';
import type { TrackResolver, VolumeController } from '../../playback/domain/ports.ts';
import { Queue } from '../../playback/domain/queue.ts';
import { Volume } from '../../playback/domain/values.ts';
import type { BotClient } from '../domain/bot-client.ts';
import type { InstanceConfig } from '../domain/instance.ts';
import type { InstanceTransport } from '../domain/instance-transport.ts';
import { ConnectionSupervisor } from './connection-supervisor.ts';
import { SoloWatcher } from './solo-watcher.ts';

export interface InstanceRuntimeDependencies {
  readonly config: InstanceConfig;
  readonly clock: Clock;
  readonly events: EventPublisher;
  readonly resolvers: readonly TrackResolver[];
  readonly binaries: { readonly ffmpeg: string; readonly pactl: string };
  /** Must match the resolver's proxy: media URLs are bound to the requesting IP. */
  readonly proxy?: string | undefined;
  /**
   * Builds the TeamSpeak transport for this instance, together with the volume control that
   * belongs to it. Which one is in use — a headless client over ClientQuery or a bot inside
   * the TSLib gateway — is a configuration choice the runtime never sees.
   *
   * Volume comes back from the same call rather than separately because the two are not
   * independent: PulseAudio sets a level on a sink, the gateway scales samples ahead of its
   * encoder, and pairing the wrong one with a transport would silently do nothing.
   */
  readonly buildTransport: (
    config: InstanceConfig,
    onReady: () => Promise<void>,
  ) => { readonly transport: InstanceTransport; readonly volume: VolumeController };
  /**
   * Playlist storage. Optional: an instance can run without it, losing only the playlist
   * commands and the default that refills an exhausted queue.
   */
  readonly playlists?: PlaylistRepository | undefined;
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
  readonly #transport: InstanceTransport;
  readonly #supervisor: ConnectionSupervisor;
  readonly #soloWatcher: SoloWatcher;
  readonly #bot: BotClient;
  readonly #playback: PlaybackService;
  readonly #dispatcher: CommandDispatcher;
  readonly #queue: Queue;
  readonly #playlists: PlaylistService | undefined;

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

    const built = deps.buildTransport(this.#config, () => this.#onConnectionReady());
    this.#transport = built.transport;
    this.#bot = built.transport.bot;

    // A separate concern from the transport's own socket reconnect: this one notices the bot
    // being off the TeamSpeak *server* — a server restart, a network drop, a kick — where the
    // transport itself is perfectly healthy and reports nothing wrong.
    this.#supervisor = new ConnectionSupervisor({
      instanceId: this.#config.id,
      clock: deps.clock,
      logger: deps.logger,
      reconnect: () => this.#transport.start(),
      isEnabled: () => this.#config.connection.autoReconnect,
    });

    this.#transport.onConnectionChange((state, error) => {
      this.#setConnectionState(state, error);
      this.#supervisor.observe(state);
    });

    this.#soloWatcher = new SoloWatcher({
      instanceId: this.#config.id,
      logger: deps.logger,
      listChannelClients: () => this.#bot.listChannelClients(),
      // Read through a getter rather than captured, so toggling the setting takes effect
      // without restarting the instance.
      isEnabled: () => this.#config.playback.pauseWhenAlone,
      isPlaying: () => this.#playback.session.status === 'playing',
      isPaused: () => this.#playback.session.status === 'paused',
      pause: async () => {
        await this.#playback.pause();
      },
      resume: async () => {
        await this.#playback.resume();
      },
    });

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
      audio: built.transport.audio,
      volume: built.volume,
      events: deps.events,
      clock: deps.clock,
      logger: deps.logger,
      // Lazy: the playlist service needs the playback service that is being built here.
      onQueueExhausted: async () => {
        await this.#refillFromDefaultPlaylist();
      },
    });

    this.#playlists =
      deps.playlists === undefined
        ? undefined
        : new PlaylistService({
            instanceId: this.#config.id,
            repository: deps.playlists,
            resolvers: deps.resolvers,
            playback: this.#playback,
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
        playlists: () => this.#playlists,
        // Lazy: `!help` describes the registry it is being registered into, which does not
        // exist yet at this point.
        registry: () => registry,
        // The dispatcher's own rule, so help never lists a command it would then refuse.
        canUse: (invoker, command) =>
          this.#permissions().can(
            { uid: invoker.uid, serverGroupIds: invoker.serverGroupIds },
            command,
          ).allowed,
      }),
    );

    this.#dispatcher = new CommandDispatcher({
      instanceId: this.#config.id,
      registry,
      permissions: () => this.#permissions(),
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

    this.#transport.onMessage((message) => {
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

  get bot(): BotClient {
    return this.#bot;
  }

  get connectionState(): ConnectionState {
    return this.#connectionState;
  }

  /** Current status, for handing to a client that connects after the fact. */
  /** The panel's playlist screen goes through here, so it edits the same instance's set. */
  get playlists(): PlaylistService | undefined {
    return this.#playlists;
  }

  get status(): InstanceStatusPayload {
    return this.#lastStatus;
  }

  start(): void {
    if (!this.#config.enabled) {
      this.#deps.logger.info('instance disabled, not connecting', { instance: this.#config.id });
      return;
    }
    this.#supervisor.start();
    this.#soloWatcher.start();
    this.#transport.start();
  }

  async stop(): Promise<void> {
    // Stopped before the transport, so the disconnect that follows is not mistaken for a
    // failure and immediately undone.
    this.#supervisor.stop();
    this.#soloWatcher.stop();
    await this.#playback.shutdown();
    await this.#transport.stop();
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

    // Storing the new configuration is not the same as applying it. Settings read through a
    // getter — limits, prefix, permissions — take effect on their next use, but anything the
    // TeamSpeak client already holds has to be pushed, or saving a nickname would change the
    // record and leave the bot on the server under its old name until the next reconnect.
    if (!requiresRestart) void this.#applyLiveChanges(previous, config);

    return { requiresRestart };
  }

  async #applyLiveChanges(previous: InstanceConfig, config: InstanceConfig): Promise<void> {
    if (this.#connectionState !== 'connected') return;

    if (previous.teamspeak.nickname !== config.teamspeak.nickname) {
      await this.#bot.setNickname(config.teamspeak.nickname).catch((error: unknown) => {
        this.#deps.logger.warn('could not apply the new nickname', {
          instance: config.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (previous.teamspeak.channel !== config.teamspeak.channel && config.teamspeak.channel !== null) {
      await this.#moveToNamedChannel(config.teamspeak.channel).catch((error: unknown) => {
        this.#deps.logger.warn('could not move to the new channel', {
          instance: config.id,
          channel: config.teamspeak.channel,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    await this.#publishStatus();
  }

  /**
   * Moves to a channel by name.
   *
   * The configuration names channels rather than numbering them, because ids change when a
   * channel is recreated — so the id has to be looked up at the moment of the move.
   */
  async #moveToNamedChannel(name: string): Promise<void> {
    const channels = await this.#bot.listChannels();
    const target = channels.find(
      (channel) => channel.name.toLowerCase() === name.toLowerCase(),
    );

    if (target === undefined) {
      this.#deps.logger.warn('no channel by that name', { instance: this.#config.id, name });
      return;
    }

    await this.#bot.moveToChannel(target.id, this.#config.teamspeak.channelPassword ?? undefined);
  }

  /**
   * Tops an exhausted queue up from the default playlist, and says so on the channel.
   *
   * Announced because the alternative is music appearing from nowhere: on a channel where
   * everybody has been queueing tracks by hand, a bot that suddenly plays something nobody
   * asked for looks broken rather than helpful.
   */
  async #refillFromDefaultPlaylist(): Promise<void> {
    if (this.#playlists === undefined) return;

    const loaded = await this.#playlists.loadDefault({
      uid: 'bot',
      nickname: this.#config.teamspeak.nickname,
    });
    if (loaded === undefined) return;

    this.#deps.logger.info('refilled the queue from the default playlist', {
      instance: this.#config.id,
      playlist: loaded.playlist.name,
      queued: loaded.queued,
    });

    await this.#bot
      .sendChannelMessage(`Queue empty — playing the default playlist "${loaded.playlist.name}".`)
      .catch(() => {
        // Not worth failing a refill over: the music matters more than the announcement.
      });
  }

  async #onConnectionReady(): Promise<void> {
    // Notification registration, where it is needed at all, belongs to the transport: the
    // ClientQuery one has to re-register after every reconnect, the gateway pushes events
    // unprompted.
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

  /**
   * Built fresh on each use rather than cached, so a reconfigured instance takes effect
   * without a reconnect. Shared by the dispatcher and by `!help`, which must agree.
   */
  #permissions(): PermissionResolver {
    return new PermissionResolver({
      policy: this.#config.permissions,
      identityGrants: new Map(Object.entries(this.#config.grants.identities)),
      groupGrants: this.#config.grants.serverGroups,
    });
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
