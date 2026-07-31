import type { AudioEndpoint, ClientQueryEndpoint, TeamSpeakTarget } from '@tsmusic/shared';

import type { Role } from '@tsmusic/shared';

import { err, ok, type Result } from '../../../shared-kernel/result.ts';
import type { QueueLimits } from '../../playback/domain/queue.ts';
import type { PermissionPolicy } from '../../access/domain/permission-resolver.ts';

/**
 * A bot instance: one TeamSpeak identity, on one server, backed by its own headless client.
 *
 * The endpoints are addresses, never assumptions. Nothing here says "localhost", which is
 * what makes running several bots a matter of configuration and what allows a client
 * container to sit on a remote x86 host while the backend runs natively.
 */
export interface InstanceConfig {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly teamspeak: TeamSpeakTarget;
  readonly serverPassword: string | null;
  readonly clientQuery: ClientQueryEndpoint;
  readonly audio: AudioEndpoint;
  readonly playback: PlaybackSettings;
  readonly commands: CommandSettings;
  readonly connection: ConnectionSettings;
  readonly permissions: PermissionPolicy;
  readonly grants: RoleGrants;
}

/**
 * Who gets which role.
 *
 * Without these the permission policy can only ever hand out its default role, which leaves
 * even the bot's owner unable to run a DJ command on their own server. Grants by server
 * group are the practical form — one entry covers everyone in an admin group — while grants
 * by UID cover individuals. UIDs, never nicknames: a nickname is not identity.
 */
export interface RoleGrants {
  readonly identities: Readonly<Record<string, Role>>;
  readonly serverGroups: ReadonlyMap<number, Role>;
}

export interface PlaybackSettings extends QueueLimits {
  readonly defaultVolume: number;
  readonly voteSkipEnabled: boolean;
  readonly voteSkipRatio: number;
  /**
   * Pause while the bot is the only one in its channel, and resume when somebody returns.
   *
   * Off by default: a bot that is deliberately broadcasting to an empty room — a radio
   * channel people drop into — would otherwise fall silent exactly when nobody is there to
   * notice why.
   */
  readonly pauseWhenAlone: boolean;
}

export interface ConnectionSettings {
  /**
   * Bring the bot back automatically when it drops off the server.
   *
   * On by default: a music bot that quietly stays gone after a server restart is worse than
   * useless. Turning it off is for when somebody wants the bot to stay where they put it.
   */
  readonly autoReconnect: boolean;
}

export interface CommandSettings {
  readonly prefix: string;
  readonly requireSameChannel: boolean;
}

export type InstanceConfigError =
  | { readonly kind: 'instance/missing-field'; readonly field: string }
  | { readonly kind: 'instance/invalid-port'; readonly field: string; readonly value: number };

/**
 * Validates raw configuration into an `InstanceConfig`.
 *
 * Failing here — at startup, naming the instance and the field — is far cheaper than an
 * instance that connects to nothing and reports only that it is "disconnected".
 */
export function createInstanceConfig(raw: {
  id: string;
  name: string;
  enabled?: boolean;
  teamspeak: {
    host: string;
    port?: number;
    nickname?: string;
    channel?: string | null;
    channelPassword?: string | null;
    homeChannelId?: number | null;
  };
  serverPassword?: string | null;
  clientQuery: { host: string; port?: number; apiKey: string };
  audio: { pulseServer: string; sinkName?: string };
  playback?: Partial<PlaybackSettings>;
  commands?: Partial<CommandSettings>;
  connection?: Partial<ConnectionSettings>;
  permissions?: Partial<PermissionPolicy>;
  grants?: {
    identities?: Record<string, Role>;
    serverGroups?: Record<string | number, Role>;
  };
}): Result<InstanceConfig, InstanceConfigError> {
  for (const [field, value] of [
    ['id', raw.id],
    ['name', raw.name],
    ['teamspeak.host', raw.teamspeak?.host],
    ['clientQuery.host', raw.clientQuery?.host],
    ['clientQuery.apiKey', raw.clientQuery?.apiKey],
    ['audio.pulseServer', raw.audio?.pulseServer],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return err({ kind: 'instance/missing-field', field });
    }
  }

  const teamspeakPort = raw.teamspeak.port ?? 9987;
  const clientQueryPort = raw.clientQuery.port ?? 25639;
  for (const [field, port] of [
    ['teamspeak.port', teamspeakPort],
    ['clientQuery.port', clientQueryPort],
  ] as const) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return err({ kind: 'instance/invalid-port', field, value: port });
    }
  }

  return ok({
    id: raw.id,
    name: raw.name,
    enabled: raw.enabled ?? true,
    teamspeak: {
      host: raw.teamspeak.host,
      port: teamspeakPort,
      nickname: raw.teamspeak.nickname ?? 'MusicBot',
      channel: raw.teamspeak.channel ?? null,
      channelPassword: raw.teamspeak.channelPassword ?? null,
      homeChannelId: raw.teamspeak.homeChannelId ?? null,
    },
    serverPassword: raw.serverPassword ?? null,
    clientQuery: {
      host: raw.clientQuery.host,
      port: clientQueryPort,
      apiKey: raw.clientQuery.apiKey,
    },
    audio: {
      pulseServer: raw.audio.pulseServer,
      sinkName: raw.audio.sinkName ?? 'bot_sink',
    },
    playback: {
      defaultVolume: raw.playback?.defaultVolume ?? 40,
      maxTrackSeconds: raw.playback?.maxTrackSeconds ?? 0,
      maxPerUser: raw.playback?.maxPerUser ?? 10,
      allowLiveStreams: raw.playback?.allowLiveStreams ?? false,
      voteSkipEnabled: raw.playback?.voteSkipEnabled ?? false,
      voteSkipRatio: raw.playback?.voteSkipRatio ?? 0.5,
      pauseWhenAlone: raw.playback?.pauseWhenAlone ?? false,
    },
    connection: {
      autoReconnect: raw.connection?.autoReconnect ?? true,
    },
    commands: {
      prefix: raw.commands?.prefix ?? '!',
      requireSameChannel: raw.commands?.requireSameChannel ?? true,
    },
    permissions: {
      defaultRole: raw.permissions?.defaultRole ?? 'user',
      whitelistOnly: raw.permissions?.whitelistOnly ?? false,
    },
    grants: {
      identities: raw.grants?.identities ?? {},
      // JSON object keys are strings; server group ids are numbers everywhere else.
      serverGroups: new Map(
        Object.entries(raw.grants?.serverGroups ?? {})
          .map(([groupId, role]) => [Number.parseInt(groupId, 10), role] as const)
          .filter(([groupId]) => !Number.isNaN(groupId)),
      ),
    },
  });
}
