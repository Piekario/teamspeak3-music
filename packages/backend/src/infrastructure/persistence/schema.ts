import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Persistence schema.
 *
 * The scoping rule runs through everything here: anything that belongs to a *server* is
 * keyed by `instanceId`, because two bots on two TeamSpeak servers share no identities, no
 * server groups and no sensible history. Playlists are the deliberate exception — a playlist
 * is content, not a server, so it is shared and any bot can load it.
 */

/**
 * Panel access, one row per person.
 *
 * A shared operator token cannot express "this person may queue but not delete a bot", and
 * revoking it revokes everybody. A row each means a role each, a revocation each, and a
 * record of who last used what.
 *
 * Only the hash is stored. A token is a password in every way that matters, and a panel
 * database that leaks should not hand over working credentials along with it.
 */
export const panelTokens = sqliteTable(
  'panel_tokens',
  {
    id: text('id').primaryKey(),
    /** Who this is for. Free text, because it is for the operator's eyes only. */
    label: text('label').notNull(),
    tokenHash: text('token_hash').notNull(),
    role: text('role').notNull(),
    /** Null means every bot; otherwise the one instance this token may touch. */
    instanceId: text('instance_id').references(() => instances.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (table) => ({
    byHash: uniqueIndex('panel_tokens_hash').on(table.tokenHash),
  }),
);

export const instances = sqliteTable('instances', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

  teamspeakHost: text('teamspeak_host').notNull(),
  teamspeakPort: integer('teamspeak_port').notNull().default(9987),
  serverPassword: text('server_password'),
  nickname: text('nickname').notNull().default('MusicBot'),
  homeChannelId: integer('home_channel_id'),

  // ClientQuery transport: one headless client per bot, addressed over a socket.
  clientQueryHost: text('client_query_host'),
  clientQueryPort: integer('client_query_port').default(25639),
  clientQueryApiKey: text('client_query_api_key'),

  pulseServer: text('pulse_server'),
  sinkName: text('sink_name').default('bot_sink'),

  /**
   * Gateway transport: the bot's TeamSpeak identity, generated in code on first connect.
   *
   * This is the single most important thing to persist. A bot's unique id is derived from
   * this key, and server groups and permissions are granted against that id — so losing it
   * means the bot comes back as a stranger and every grant an admin made has to be redone.
   */
  /**
   * Everything that is a *tunable* rather than an address: channel, playback limits, command
   * settings, permissions and grants.
   *
   * One JSON column instead of a column per field, for the same reason the settings table is
   * key/value — these change often, and a new toggle should not need a migration. Addresses
   * stay as real columns because they are queried and defaulted.
   */
  settingsJson: text('settings_json'),

  identityKey: text('identity_key'),
  identityOffset: integer('identity_offset').notNull().default(0),
  identityUid: text('identity_uid'),

  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Settings are key/value rather than columns so a new tunable does not need a migration.
 * A NULL `instanceId` marks a global default; an instance row overrides it.
 */
export const settings = sqliteTable(
  'settings',
  {
    instanceId: text('instance_id').references(() => instances.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(), // JSON
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.instanceId, table.key] }),
  }),
);

/**
 * A person, per instance. Keyed by TeamSpeak client UID — never by nickname, which anyone
 * can change to impersonate anyone else.
 */
export const identities = sqliteTable(
  'identities',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    uid: text('uid').notNull(),
    lastNickname: text('last_nickname'),
    role: text('role').notNull().default('user'),
    note: text('note'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (table) => ({
    uniqueUid: uniqueIndex('identities_instance_uid').on(table.instanceId, table.uid),
  }),
);

/** Maps a TeamSpeak server group to a role, for granting access in bulk. */
export const groupRoles = sqliteTable(
  'group_roles',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    serverGroupId: integer('server_group_id').notNull(),
    role: text('role').notNull(),
  },
  (table) => ({
    uniqueGroup: uniqueIndex('group_roles_instance_group').on(table.instanceId, table.serverGroupId),
  }),
);

/** Per-command overrides of the shipped defaults. Absent means "use the default". */
export const commandPolicies = sqliteTable(
  'command_policies',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    command: text('command').notNull(),
    minRole: text('min_role').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.instanceId, table.command] }),
  }),
);

/**
 * Playlists belong to an instance.
 *
 * Originally global, on the theory that content is worth sharing. In practice a preset is
 * tied to a room's taste and to the server groups allowed to load it, and a bot offering
 * another community's playlists is noise rather than a feature.
 */
export const playlists = sqliteTable(
  'playlists',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    ownerUid: text('owner_uid'),
    /**
     * Played when the queue runs dry. At most one per instance, enforced when setting it
     * rather than by a constraint, so promoting a playlist demotes the previous one in the
     * same operation instead of failing.
     */
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    uniqueName: uniqueIndex('playlists_instance_name').on(table.instanceId, table.name),
  }),
);

export const playlistTracks = sqliteTable(
  'playlist_tracks',
  {
    id: text('id').primaryKey(),
    playlistId: text('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    uploader: text('uploader'),
    durationSec: integer('duration_sec'),
    thumbnailUrl: text('thumbnail_url'),
    addedAt: text('added_at').notNull(),
  },
  (table) => ({
    byPlaylist: index('playlist_tracks_playlist').on(table.playlistId, table.position),
  }),
);

export const history = sqliteTable(
  'history',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    uploader: text('uploader'),
    durationSec: integer('duration_sec'),
    thumbnailUrl: text('thumbnail_url'),
    requestedByUid: text('requested_by_uid'),
    requestedByNickname: text('requested_by_nickname'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    endedReason: text('ended_reason'),
  },
  (table) => ({
    byStarted: index('history_started').on(table.instanceId, table.startedAt),
    bySource: index('history_source').on(table.sourceId),
  }),
);

/**
 * A write-behind mirror of the in-memory queue, so a container restart mid-party restores
 * what was lined up instead of losing it.
 */
export const queueSnapshots = sqliteTable(
  'queue_snapshots',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    payload: text('payload').notNull(), // JSON QueueItem
  },
  (table) => ({
    pk: primaryKey({ columns: [table.instanceId, table.position] }),
  }),
);
