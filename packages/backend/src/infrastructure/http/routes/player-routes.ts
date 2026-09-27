import {
  instanceIdParamSchema,
  repeatSchema,
  playlistImportSchema,
  searchQuerySchema,
  seekSchema,
  trackRequestSchema,
  volumeSchema,
  queueMoveSchema,
} from '@tsmusic/shared';
import type { FastifyInstance } from 'fastify';

import type { InstanceManager } from '../../../contexts/instances/application/instance-manager.ts';
import { Volume } from '../../../contexts/playback/domain/values.ts';
import { httpError } from '../errors.ts';
import { identityOf } from '../guards.ts';

/**
 * Playback routes.
 *
 * Controllers here do three things and nothing else: resolve the instance, hand the request
 * to the application layer, and translate the `Result` into a status code. Any rule that
 * looks like it belongs here — queue limits, legal transitions, volume bounds — lives in the
 * domain, so the panel and a chat command cannot disagree about it.
 */
export function registerPlayerRoutes(app: FastifyInstance, instances: InstanceManager): void {
  /** Every route in this file addresses one bot, so resolving it is factored out. */
  const runtimeOf = (instanceId: string) => {
    const found = instances.get(instanceId);
    if (!found.ok) throw httpError(404, `no instance '${instanceId}'`);
    return found.value;
  };

  app.get('/api/instances/:instanceId/player', async (request) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    return runtimeOf(instanceId).playback.session.toPlayerState();
  });

  app.get('/api/instances/:instanceId/queue', async (request) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    return { queue: runtimeOf(instanceId).playback.session.toPlayerState().queue };
  });

  app.post('/api/instances/:instanceId/queue', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const body = trackRequestSchema.parse(request.body);

    const queued = await runtimeOf(instanceId).playback.request(body, {
      // Attributed to the signed-in panel identity, so history shows who actually queued it
      // rather than the panel as an undifferentiated whole.
      uid: 'panel',
      nickname: identityOf(request).label,
    });

    if (!queued.ok) throw httpError(422, describe(queued.error), queued.error);
    return response.status(201).send({ track: queued.value });
  });

  app.delete('/api/instances/:instanceId/queue/:itemId', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const { itemId } = request.params as { itemId: string };

    // No requester restriction: reaching this route already required the admin token.
    const removed = runtimeOf(instanceId).playback.removeFromQueue(itemId);
    if (!removed.ok) throw httpError(404, describe(removed.error), removed.error);
    return response.status(204).send();
  });

  app.post('/api/instances/:instanceId/queue/move', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const { itemId, toIndex } = queueMoveSchema.parse(request.body);

    const moved = runtimeOf(instanceId).playback.moveInQueue(itemId, toIndex);
    if (!moved.ok) throw httpError(404, describe(moved.error), moved.error);
    return response.status(204).send();
  });

  app.post('/api/instances/:instanceId/queue/playlist', async (request) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const { url, limit } = playlistImportSchema.parse(request.body);

    const imported = await runtimeOf(instanceId).playback.requestPlaylist(
      url,
      { uid: 'panel', nickname: identityOf(request).label },
      limit,
    );

    if (!imported.ok) throw httpError(422, describe(imported.error), imported.error);
    // Partial success is the normal outcome, so the counts are the response rather than a
    // bare 204 that hides how much was actually queued.
    return imported.value;
  });

  app.post('/api/instances/:instanceId/queue/shuffle', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    runtimeOf(instanceId).playback.shuffleQueue();
    return response.status(204).send();
  });

  app.post('/api/instances/:instanceId/queue/clear', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    runtimeOf(instanceId).playback.clearQueue();
    return response.status(204).send();
  });

  app.post('/api/instances/:instanceId/player/skip', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const skipped = await runtimeOf(instanceId).playback.skip();
    if (!skipped.ok) throw httpError(409, 'nothing is playing');
    return response.status(204).send();
  });

  app.post('/api/instances/:instanceId/player/pause', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const paused = await runtimeOf(instanceId).playback.pause();
    if (!paused.ok) throw httpError(409, 'nothing is playing');
    return response.status(204).send();
  });

  app.post('/api/instances/:instanceId/player/resume', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const resumed = await runtimeOf(instanceId).playback.resume();
    if (!resumed.ok) throw httpError(409, 'nothing is paused');
    return response.status(204).send();
  });

  app.post('/api/instances/:instanceId/player/stop', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    await runtimeOf(instanceId).playback.stop();
    return response.status(204).send();
  });

  app.post('/api/instances/:instanceId/player/seek', async (request) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const { positionSec } = seekSchema.parse(request.body);

    const sought = await runtimeOf(instanceId).playback.seek(positionSec);
    if (!sought.ok) throw httpError(409, 'nothing is playing');
    return { positionSec: sought.value };
  });

  app.post('/api/instances/:instanceId/player/volume', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const { volume } = volumeSchema.parse(request.body);

    const requested = Volume.create(volume);
    if (!requested.ok) throw httpError(422, 'volume out of range');

    const applied = await runtimeOf(instanceId).playback.setVolume(requested.value);
    if (!applied.ok) throw httpError(502, applied.error.detail);
    return response.status(204).send();
  });

  app.post('/api/instances/:instanceId/player/repeat', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const { mode } = repeatSchema.parse(request.body);
    runtimeOf(instanceId).playback.setRepeat(mode);
    return response.status(204).send();
  });

  app.get('/api/instances/:instanceId/search', async (request) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const { q, limit } = searchQuerySchema.parse(request.query);

    const results = await runtimeOf(instanceId).playback.search(q, limit);
    // A failing search is upstream's fault, not the caller's — 502 says so honestly.
    if (!results.ok) throw httpError(502, describe(results.error), results.error);
    return { results: results.value };
  });
}

/** Turns a domain error into a sentence a person can act on. */
function describe(error: { readonly kind: string; readonly [key: string]: unknown }): string {
  switch (error.kind) {
    case 'queue/track-too-long':
      return `track is longer than the ${String(error['limitSec'])}s limit`;
    case 'queue/live-not-allowed':
      return 'live streams are not allowed on this instance';
    case 'queue/user-limit-reached':
      return `requester already has ${String(error['limit'])} tracks queued`;
    case 'queue/item-not-found':
      return 'no such queue item';
    case 'queue/not-owned-by-requester':
      return 'that queue item belongs to someone else';
    case 'resolve/not-found':
      return `nothing found for "${String(error['query'])}"`;
    case 'resolve/unsupported-url':
    case 'playback/no-resolver':
      return 'unsupported link';
    case 'resolve/age-restricted':
      return 'age-restricted: YouTube serves this only to a signed-in, verified account (set YTDLP_COOKIES_FILE)';
    case 'resolve/blocked':
      return `YouTube blocked the request: ${String(error['detail'])}`;
    case 'resolve/timeout':
      return 'yt-dlp timed out';
    case 'resolve/tool-failure':
      return `yt-dlp error: ${String(error['detail'])}`;
    default:
      return error.kind;
  }
}
