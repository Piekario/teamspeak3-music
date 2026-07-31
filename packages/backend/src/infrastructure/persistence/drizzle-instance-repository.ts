import { eq } from 'drizzle-orm';

import type { Role } from '@tsmusic/shared';

import type {
  InstanceRepository,
  StoredIdentity,
} from '../../contexts/instances/domain/instance-repository.ts';
import {
  createInstanceConfig,
  type InstanceConfig,
} from '../../contexts/instances/domain/instance.ts';
import type { Db } from './database.ts';
import { instances } from './schema.ts';

type InstanceRow = typeof instances.$inferSelect;

/**
 * SQLite-backed instance storage.
 *
 * Rows are mapped back through `createInstanceConfig` rather than cast into shape. A row
 * written by an older version of the schema, or edited by hand, is then validated on the way
 * in exactly like a fresh configuration — and a bad one is reported with the field that is
 * wrong instead of failing later as an unexplained connection error.
 */
export class DrizzleInstanceRepository implements InstanceRepository {
  readonly #db: Db;
  readonly #logger: { warn(message: string, details?: Record<string, unknown>): void };

  constructor(db: Db, logger: { warn(message: string, details?: Record<string, unknown>): void }) {
    this.#db = db;
    this.#logger = logger;
  }

  async list(): Promise<readonly InstanceConfig[]> {
    const rows = this.#db.select().from(instances).all();
    return rows
      .map((row) => this.#toConfig(row))
      .filter((config): config is InstanceConfig => config !== undefined);
  }

  async findById(id: string): Promise<InstanceConfig | undefined> {
    const row = this.#db.select().from(instances).where(eq(instances.id, id)).get();
    return row === undefined ? undefined : this.#toConfig(row);
  }

  async save(config: InstanceConfig): Promise<void> {
    const now = new Date().toISOString();

    // The identity columns are deliberately absent from the update set: saving a
    // configuration change must never clear an identity the gateway already issued.
    this.#db
      .insert(instances)
      .values({
        id: config.id,
        name: config.name,
        enabled: config.enabled,
        teamspeakHost: config.teamspeak.host,
        teamspeakPort: config.teamspeak.port,
        serverPassword: config.serverPassword,
        nickname: config.teamspeak.nickname,
        homeChannelId: config.teamspeak.homeChannelId,
        clientQueryHost: config.clientQuery.host,
        clientQueryPort: config.clientQuery.port,
        clientQueryApiKey: config.clientQuery.apiKey,
        pulseServer: config.audio.pulseServer,
        sinkName: config.audio.sinkName,
        settingsJson: serialiseSettings(config),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: instances.id,
        set: {
          name: config.name,
          enabled: config.enabled,
          teamspeakHost: config.teamspeak.host,
          teamspeakPort: config.teamspeak.port,
          serverPassword: config.serverPassword,
          nickname: config.teamspeak.nickname,
          homeChannelId: config.teamspeak.homeChannelId,
          clientQueryHost: config.clientQuery.host,
          clientQueryPort: config.clientQuery.port,
          clientQueryApiKey: config.clientQuery.apiKey,
          pulseServer: config.audio.pulseServer,
          sinkName: config.audio.sinkName,
          settingsJson: serialiseSettings(config),
          updatedAt: now,
        },
      })
      .run();
  }

  async delete(id: string): Promise<void> {
    this.#db.delete(instances).where(eq(instances.id, id)).run();
  }

  async readIdentity(instanceId: string): Promise<StoredIdentity> {
    const row = this.#db
      .select({
        key: instances.identityKey,
        offset: instances.identityOffset,
        uid: instances.identityUid,
      })
      .from(instances)
      .where(eq(instances.id, instanceId))
      .get();

    return {
      key: row?.key ?? null,
      offset: row?.offset ?? 0,
      uid: row?.uid ?? null,
    };
  }

  async saveIdentity(instanceId: string, identity: StoredIdentity): Promise<void> {
    this.#db
      .update(instances)
      .set({
        identityKey: identity.key,
        identityOffset: identity.offset,
        identityUid: identity.uid,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(instances.id, instanceId))
      .run();
  }

  #toConfig(row: InstanceRow): InstanceConfig | undefined {
    const settings = this.#parseSettings(row);

    const created = createInstanceConfig({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      teamspeak: {
        host: row.teamspeakHost,
        port: row.teamspeakPort,
        nickname: row.nickname,
        homeChannelId: row.homeChannelId,
        channel: settings.channel ?? null,
        channelPassword: settings.channelPassword ?? null,
      },
      playback: settings.playback ?? {},
      commands: settings.commands ?? {},
      connection: settings.connection ?? {},
      permissions: settings.permissions ?? {},
      grants: settings.grants ?? {},
      serverPassword: row.serverPassword,
      clientQuery: {
        // Defaulted from the id, matching how the compose services are named, so a row
        // created through the panel needs no ClientQuery details at all when the gateway
        // transport is in use.
        host: row.clientQueryHost ?? `tsmusic-client-${row.id}`,
        port: row.clientQueryPort ?? 25639,
        apiKey: row.clientQueryApiKey ?? 'unset',
      },
      audio: {
        pulseServer: row.pulseServer ?? `tcp:tsmusic-client-${row.id}:4713`,
        sinkName: row.sinkName ?? 'bot_sink',
      },
    });

    if (!created.ok) {
      this.#logger.warn('skipping an unusable instance row', {
        id: row.id,
        error: created.error.kind,
      });
      return undefined;
    }
    return created.value;
  }

  /**
   * Reads the tunables back, tolerating anything.
   *
   * A malformed blob costs the instance its settings, which `createInstanceConfig` then
   * refills with defaults — annoying but recoverable. Throwing here would instead take the
   * whole instance out of the listing, so a single bad character would look like a bot that
   * had vanished.
   */
  #parseSettings(row: InstanceRow): StoredSettings {
    if (row.settingsJson === null || row.settingsJson.length === 0) return {};

    try {
      const parsed: unknown = JSON.parse(row.settingsJson);
      return typeof parsed === 'object' && parsed !== null ? (parsed as StoredSettings) : {};
    } catch (error) {
      this.#logger.warn('ignoring unreadable instance settings', {
        id: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }
}

/** The shape stored in `settings_json`; every field optional, since older rows lack them. */
type StoredSettings = Partial<{
  channel: string | null;
  channelPassword: string | null;
  playback: Partial<InstanceConfig['playback']>;
  commands: Partial<InstanceConfig['commands']>;
  connection: Partial<InstanceConfig['connection']>;
  permissions: Partial<InstanceConfig['permissions']>;
  grants: { identities?: Record<string, Role>; serverGroups?: Record<string, Role> };
}>;

function serialiseSettings(config: InstanceConfig): string {
  return JSON.stringify({
    channel: config.teamspeak.channel,
    channelPassword: config.teamspeak.channelPassword,
    playback: config.playback,
    commands: config.commands,
    connection: config.connection,
    permissions: config.permissions,
    grants: {
      identities: config.grants.identities,
      // A Map does not survive JSON; the numeric keys come back as strings, which is exactly
      // what `createInstanceConfig` expects to parse.
      serverGroups: Object.fromEntries(config.grants.serverGroups),
    },
  });
}
