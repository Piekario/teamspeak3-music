import { z } from 'zod';
import { COMMAND_NAMES, ROLES } from './access.ts';
import { REPEAT_MODES, VOLUME_MAX, VOLUME_MIN } from './playback.ts';

/**
 * REST request shapes, shared verbatim between Fastify's type provider and the frontend's
 * API client. One definition, so the contract cannot drift between the two.
 */

export const instanceIdParamSchema = z.object({
  instanceId: z.string().min(1),
});

/** A track request is either a URL or free text to search for — never both, never neither. */
export const trackRequestSchema = z
  .object({
    url: z.string().url().optional(),
    query: z.string().min(1).max(200).optional(),
    position: z.number().int().min(0).optional(),
  })
  .refine((v) => (v.url === undefined) !== (v.query === undefined), {
    message: 'provide exactly one of `url` or `query`',
  });

export const volumeSchema = z.object({
  volume: z.number().int().min(VOLUME_MIN).max(VOLUME_MAX),
});

export const seekSchema = z.object({
  positionSec: z.number().min(0),
});

export const repeatSchema = z.object({
  mode: z.enum(REPEAT_MODES),
});

export const queueMoveSchema = z.object({
  itemId: z.string().min(1),
  toIndex: z.number().int().min(0),
});

/**
 * Importing a playlist. The limit is capped rather than open-ended: a thousand-entry
 * playlist would take minutes to list and swamp the queue for everyone else.
 */
export const playlistImportSchema = z.object({
  url: z.string().url(),
  limit: z.number().int().min(1).max(200).default(100),
});

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(25).default(5),
});

export const identityUpdateSchema = z.object({
  role: z.enum(ROLES),
  note: z.string().max(500).nullable().optional(),
});

export const groupRoleSchema = z.object({
  serverGroupId: z.number().int().min(0),
  role: z.enum(ROLES),
});

export const commandPolicySchema = z.object({
  minRole: z.enum(ROLES),
  enabled: z.boolean(),
});

export const commandNameParamSchema = z.object({
  command: z.enum(COMMAND_NAMES),
});

export const playlistCreateSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  isPublic: z.boolean().default(true),
});

export const playlistUpdateSchema = playlistCreateSchema.partial();

export const playlistAddTrackSchema = z
  .object({
    url: z.string().url().optional(),
    fromHistoryId: z.string().optional(),
    fromQueue: z.boolean().optional(),
  })
  .refine(
    (v) =>
      [v.url !== undefined, v.fromHistoryId !== undefined, v.fromQueue === true].filter(Boolean)
        .length === 1,
    { message: 'provide exactly one of `url`, `fromHistoryId` or `fromQueue`' },
  );

export const playlistReorderSchema = z.object({
  trackId: z.string().min(1),
  toIndex: z.number().int().min(0),
});

export const playlistEnqueueSchema = z.object({
  shuffle: z.boolean().default(false),
});

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().max(200).optional(),
  uid: z.string().optional(),
});

export const moveChannelSchema = z.object({
  channelId: z.number().int().min(0),
  password: z.string().optional(),
});

/**
 * Instance settings are patched partially — the UI sends only what changed, and anything
 * touching the TeamSpeak target triggers a reconnect of that instance alone.
 */
export const instanceSettingsPatchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
  teamspeak: z
    .object({
      host: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      password: z.string().nullable().optional(),
      nickname: z.string().min(1).max(30).optional(),
      homeChannelId: z.number().int().min(0).nullable().optional(),
    })
    .optional(),
  playback: z
    .object({
      defaultVolume: z.number().int().min(VOLUME_MIN).max(VOLUME_MAX).optional(),
      maxTrackSeconds: z.number().int().min(0).optional(),
      maxQueuePerUser: z.number().int().min(0).optional(),
      allowLiveStreams: z.boolean().optional(),
      voteSkipEnabled: z.boolean().optional(),
      voteSkipRatio: z.number().min(0.1).max(1).optional(),
    })
    .optional(),
  commands: z
    .object({
      prefix: z.string().min(1).max(3).optional(),
      defaultRole: z.enum(ROLES).optional(),
      whitelistOnly: z.boolean().optional(),
      requireSameChannel: z.boolean().optional(),
    })
    .optional(),
});

export type TrackRequestDto = z.infer<typeof trackRequestSchema>;
export type VolumeDto = z.infer<typeof volumeSchema>;
export type SeekDto = z.infer<typeof seekSchema>;
export type RepeatDto = z.infer<typeof repeatSchema>;
export type QueueMoveDto = z.infer<typeof queueMoveSchema>;
export type SearchQueryDto = z.infer<typeof searchQuerySchema>;
export type IdentityUpdateDto = z.infer<typeof identityUpdateSchema>;
export type GroupRoleDto = z.infer<typeof groupRoleSchema>;
export type CommandPolicyDto = z.infer<typeof commandPolicySchema>;
export type PlaylistCreateDto = z.infer<typeof playlistCreateSchema>;
export type PlaylistUpdateDto = z.infer<typeof playlistUpdateSchema>;
export type PlaylistAddTrackDto = z.infer<typeof playlistAddTrackSchema>;
export type PlaylistReorderDto = z.infer<typeof playlistReorderSchema>;
export type HistoryQueryDto = z.infer<typeof historyQuerySchema>;
export type MoveChannelDto = z.infer<typeof moveChannelSchema>;
export type InstanceSettingsPatchDto = z.infer<typeof instanceSettingsPatchSchema>;
