import { ROLES, instanceIdParamSchema } from '@tsmusic/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { InstanceManager } from '../../../contexts/instances/application/instance-manager.ts';
import type { InstanceRepository } from '../../../contexts/instances/domain/instance-repository.ts';
import { createInstanceConfig } from '../../../contexts/instances/domain/instance.ts';
import { httpError } from '../errors.ts';

/**
 * Creating, editing and deleting bots from the panel.
 *
 * On the gateway transport this is the whole of "add a bot": a row and a request. Nothing is
 * provisioned, because a bot is an object inside a process that is already running — which is
 * exactly why this became worth building only after the transport changed.
 */

const createInstanceSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    // Ids end up in container names, sink names and log lines, so they are kept to something
    // safe everywhere rather than sanitised differently in each place.
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase letters, digits and dashes'),
  name: z.string().min(1).max(60),
  enabled: z.boolean().default(true),
  teamspeak: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(9987),
    nickname: z.string().min(1).max(30).default('MusicBot'),
    channel: z.string().max(200).nullable().default(null),
    channelPassword: z.string().max(200).nullable().default(null),
    homeChannelId: z.number().int().min(0).nullable().default(null),
  }),
  serverPassword: z.string().nullable().default(null),
  playback: z
    .object({
      pauseWhenAlone: z.boolean(),
      /** 0 means no limit; the cap is a day, which is longer than anything anyone queues. */
      maxTrackSeconds: z.number().int().min(0).max(86_400),
      maxPerUser: z.number().int().min(0).max(500),
      allowLiveStreams: z.boolean(),
    })
    .partial()
    .optional(),
  connectionSettings: z
    .object({
      autoReconnect: z.boolean(),
    })
    .partial()
    .optional(),
  /** Which TeamSpeak server groups may use the bot, and in what role. */
  grants: z
    .object({
      serverGroups: z.record(z.string(), z.enum(ROLES)).default({}),
      identities: z.record(z.string(), z.enum(ROLES)).default({}),
    })
    .optional(),
});

/**
 * An update names only what is changing, all the way down.
 *
 * A shallow `.partial()` is not enough: it makes `teamspeak` optional but leaves `host`
 * required inside it, so `{"teamspeak":{"nickname":"…"}}` — the obvious way to rename a bot —
 * is rejected. The handler already treats every absent field as "leave it alone", so the
 * nested objects are made partial to match.
 */
export const updateInstanceSchema = createInstanceSchema
  .partial()
  .omit({ id: true })
  .extend({ teamspeak: createInstanceSchema.shape.teamspeak.partial().optional() });

export interface InstanceAdminDependencies {
  readonly instances: InstanceManager;
  readonly repository: InstanceRepository;
}

export function registerInstanceAdminRoutes(
  app: FastifyInstance,
  deps: InstanceAdminDependencies,
): void {
  app.post('/api/instances', async (request, response) => {
    const body = createInstanceSchema.parse(request.body);

    if (deps.instances.has(body.id)) {
      throw httpError(409, `an instance called '${body.id}' already exists`);
    }

    const config = createInstanceConfig({
      id: body.id,
      name: body.name,
      enabled: body.enabled,
      teamspeak: body.teamspeak,
      serverPassword: body.serverPassword,
      // Defaulted from the id: on the gateway transport these are unused, and on the
      // ClientQuery transport they match how the compose services are named.
      clientQuery: { host: `tsmusic-client-${body.id}`, apiKey: 'unset' },
      audio: { pulseServer: `tcp:tsmusic-client-${body.id}:4713` },
    });

    if (!config.ok) {
      throw httpError(422, describeConfigError(config.error), config.error);
    }

    await deps.repository.save(config.value);

    const added = deps.instances.add(config.value);
    if (!added.ok) throw httpError(409, `an instance called '${body.id}' already exists`);

    added.value.start();
    return response.status(201).send({ id: config.value.id });
  });

  app.patch('/api/instances/:instanceId', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const body = updateInstanceSchema.parse(request.body);

    const existing = deps.instances.get(instanceId);
    if (!existing.ok) throw httpError(404, `no instance '${instanceId}'`);

    const current = existing.value.config;
    const config = createInstanceConfig({
      id: current.id,
      name: body.name ?? current.name,
      enabled: body.enabled ?? current.enabled,
      teamspeak: {
        host: body.teamspeak?.host ?? current.teamspeak.host,
        port: body.teamspeak?.port ?? current.teamspeak.port,
        nickname: body.teamspeak?.nickname ?? current.teamspeak.nickname,
        channel:
          body.teamspeak?.channel === undefined
            ? current.teamspeak.channel
            : body.teamspeak.channel,
        channelPassword:
          body.teamspeak?.channelPassword === undefined
            ? current.teamspeak.channelPassword
            : body.teamspeak.channelPassword,
        homeChannelId:
          body.teamspeak?.homeChannelId === undefined
            ? current.teamspeak.homeChannelId
            : body.teamspeak.homeChannelId,
      },
      serverPassword:
        body.serverPassword === undefined ? current.serverPassword : body.serverPassword,
      clientQuery: current.clientQuery,
      audio: current.audio,
      playback: {
        ...current.playback,
        pauseWhenAlone: body.playback?.pauseWhenAlone ?? current.playback.pauseWhenAlone,
        maxTrackSeconds: body.playback?.maxTrackSeconds ?? current.playback.maxTrackSeconds,
        maxPerUser: body.playback?.maxPerUser ?? current.playback.maxPerUser,
        allowLiveStreams: body.playback?.allowLiveStreams ?? current.playback.allowLiveStreams,
      },
      connection: {
        ...current.connection,
        autoReconnect:
          body.connectionSettings?.autoReconnect ?? current.connection.autoReconnect,
      },
      commands: current.commands,
      permissions: current.permissions,
      // Absent means "leave the grants alone"; an empty object means "revoke everything",
      // and conflating the two would silently strip access on any unrelated edit.
      grants:
        body.grants === undefined
          ? {
              identities: current.grants.identities,
              serverGroups: Object.fromEntries(current.grants.serverGroups),
            }
          : body.grants,
    });

    if (!config.ok) throw httpError(422, describeConfigError(config.error), config.error);

    await deps.repository.save(config.value);
    // Reconfiguring restarts the instance only when the change demands it, so adjusting a
    // nickname does not interrupt whatever is playing.
    await deps.instances.reconfigure(config.value);

    return response.status(204).send();
  });

  app.delete('/api/instances/:instanceId', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);

    const removed = await deps.instances.remove(instanceId);
    if (!removed.ok) throw httpError(404, `no instance '${instanceId}'`);

    // Removed from storage after the runtime has stopped, so a failure to stop leaves the
    // row behind rather than orphaning a running bot with no record of it.
    await deps.repository.delete(instanceId);
    return response.status(204).send();
  });

  app.post('/api/instances/:instanceId/start', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const runtime = deps.instances.get(instanceId);
    if (!runtime.ok) throw httpError(404, `no instance '${instanceId}'`);

    runtime.value.start();
    return response.status(204).send();
  });

  app.post('/api/instances/:instanceId/stop', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const runtime = deps.instances.get(instanceId);
    if (!runtime.ok) throw httpError(404, `no instance '${instanceId}'`);

    await runtime.value.stop();
    return response.status(204).send();
  });
}

function describeConfigError(error: { kind: string; [key: string]: unknown }): string {
  return error.kind === 'instance/missing-field'
    ? `missing ${String(error['field'])}`
    : `invalid ${String(error['field'])}`;
}
