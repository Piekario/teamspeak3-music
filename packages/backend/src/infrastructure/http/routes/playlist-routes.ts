import { instanceIdParamSchema } from '@tsmusic/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { PlaylistService } from '../../../contexts/catalog/application/playlist-service.ts';
import { describePlaylistError } from '../../../contexts/catalog/application/playlist-service.ts';
import type { InstanceManager } from '../../../contexts/instances/application/instance-manager.ts';
import { httpError } from '../errors.ts';

const playlistParamsSchema = instanceIdParamSchema.extend({
  playlistId: z.string().min(1),
});

const trackParamsSchema = playlistParamsSchema.extend({
  trackId: z.string().min(1),
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().default(null),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(80),
    isDefault: z.literal(true),
  })
  .partial();

const addTracksSchema = z.object({ url: z.string().min(1) });

const reorderSchema = z.object({ toIndex: z.number().int().min(0) });

const loadSchema = z.object({
  requestedBy: z.string().max(60).default('the panel'),
});

/**
 * Playlist routes.
 *
 * Playlists belong to an instance, so every path is nested under one — two bots on two
 * TeamSpeak servers have separate audiences and separate defaults, and a flat `/playlists`
 * would invite exactly the mix-up the schema is scoped to prevent.
 */
export function registerPlaylistRoutes(app: FastifyInstance, instances: InstanceManager): void {
  const serviceOf = (instanceId: string): PlaylistService => {
    const found = instances.get(instanceId);
    if (!found.ok) throw httpError(404, `no instance '${instanceId}'`);

    const playlists = found.value.playlists;
    if (playlists === undefined) throw httpError(503, 'playlists are not available');
    return playlists;
  };

  const detailOf = async (instanceId: string, playlistId: string) => {
    const playlist = await serviceOf(instanceId).findById(playlistId);
    if (playlist === undefined) throw httpError(404, `no playlist '${playlistId}'`);
    return playlist;
  };

  app.get('/api/instances/:instanceId/playlists', async (request) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    return { playlists: await serviceOf(instanceId).list() };
  });

  app.get('/api/instances/:instanceId/playlists/:playlistId', async (request) => {
    const { instanceId, playlistId } = playlistParamsSchema.parse(request.params);
    return await detailOf(instanceId, playlistId);
  });

  app.post('/api/instances/:instanceId/playlists', async (request, reply) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const body = createSchema.parse(request.body);

    const created = await serviceOf(instanceId).create(body.name, body.description, null);
    if (!created.ok) throw httpError(409, describePlaylistError(created.error), created.error);

    return await reply.status(201).send(created.value);
  });

  app.patch('/api/instances/:instanceId/playlists/:playlistId', async (request) => {
    const { instanceId, playlistId } = playlistParamsSchema.parse(request.params);
    const body = updateSchema.parse(request.body);
    const service = serviceOf(instanceId);
    await detailOf(instanceId, playlistId);

    if (body.name !== undefined) {
      const renamed = await service.rename(playlistId, body.name);
      if (!renamed.ok) throw httpError(409, describePlaylistError(renamed.error), renamed.error);
    }

    // Only promotion is expressible here; clearing the default is a DELETE on the collection's
    // default, so that "leave it alone" and "clear it" cannot be confused with each other.
    if (body.isDefault === true) await service.setDefault(playlistId);

    return await detailOf(instanceId, playlistId);
  });

  app.delete('/api/instances/:instanceId/playlists/default', async (request, reply) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    await serviceOf(instanceId).setDefault(null);
    return await reply.status(204).send();
  });

  app.delete('/api/instances/:instanceId/playlists/:playlistId', async (request, reply) => {
    const { instanceId, playlistId } = playlistParamsSchema.parse(request.params);
    await detailOf(instanceId, playlistId);
    await serviceOf(instanceId).delete(playlistId);
    return await reply.status(204).send();
  });

  /** Accepts a single track or a whole YouTube playlist; the URL decides which. */
  app.post('/api/instances/:instanceId/playlists/:playlistId/tracks', async (request) => {
    const { instanceId, playlistId } = playlistParamsSchema.parse(request.params);
    const body = addTracksSchema.parse(request.body);
    await detailOf(instanceId, playlistId);

    const added = await serviceOf(instanceId).addFromUrl(playlistId, body.url);
    if (!added.ok) throw httpError(422, describePlaylistError(added.error), added.error);

    return { ...added.value, playlist: await detailOf(instanceId, playlistId) };
  });

  app.delete(
    '/api/instances/:instanceId/playlists/:playlistId/tracks/:trackId',
    async (request, reply) => {
      const { instanceId, playlistId, trackId } = trackParamsSchema.parse(request.params);
      await serviceOf(instanceId).removeTrack(playlistId, trackId);
      return await reply.status(204).send();
    },
  );

  app.patch(
    '/api/instances/:instanceId/playlists/:playlistId/tracks/:trackId',
    async (request) => {
      const { instanceId, playlistId, trackId } = trackParamsSchema.parse(request.params);
      const { toIndex } = reorderSchema.parse(request.body);

      await serviceOf(instanceId).reorder(playlistId, trackId, toIndex);
      return await detailOf(instanceId, playlistId);
    },
  );

  /** Queues the playlist, exactly as `!playlist load` does from chat. */
  app.post('/api/instances/:instanceId/playlists/:playlistId/load', async (request) => {
    const { instanceId, playlistId } = playlistParamsSchema.parse(request.params);
    const { requestedBy } = loadSchema.parse(request.body ?? {});

    const loaded = await serviceOf(instanceId).load(playlistId, {
      uid: 'panel',
      nickname: requestedBy,
    });
    if (!loaded.ok) throw httpError(422, describePlaylistError(loaded.error), loaded.error);

    return { queued: loaded.value.queued, rejected: loaded.value.rejected };
  });

  /** Saves whatever is playing and waiting, the panel's counterpart to `!playlist save`. */
  app.post('/api/instances/:instanceId/playlists/from-queue', async (request, reply) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const { name } = createSchema.parse(request.body);

    const saved = await serviceOf(instanceId).saveCurrentQueue(name, null);
    if (!saved.ok) throw httpError(409, describePlaylistError(saved.error), saved.error);

    return await reply.status(201).send(saved.value);
  });
}
