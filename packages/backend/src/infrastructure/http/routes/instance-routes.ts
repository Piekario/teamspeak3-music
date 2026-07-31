import { instanceIdParamSchema, moveChannelSchema } from '@tsmusic/shared';
import type { FastifyInstance } from 'fastify';

import type { InstanceManager } from '../../../contexts/instances/application/instance-manager.ts';
import { httpError } from '../errors.ts';

/**
 * Instance routes: what bots exist, what each is connected to, and where it sits.
 *
 * The listing deliberately never exposes the ClientQuery API key or the server password —
 * a panel that leaks the key would hand full control of the TeamSpeak client to anyone who
 * can read one HTTP response.
 */
export function registerInstanceRoutes(app: FastifyInstance, instances: InstanceManager): void {
  const runtimeOf = (instanceId: string) => {
    const found = instances.get(instanceId);
    if (!found.ok) throw httpError(404, `no instance '${instanceId}'`);
    return found.value;
  };

  app.get('/api/instances', async () => ({ instances: instances.summaries() }));

  app.get('/api/instances/:instanceId', async (request) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const runtime = runtimeOf(instanceId);
    const config = runtime.config;

    return {
      id: config.id,
      name: config.name,
      enabled: config.enabled,
      connection: runtime.connectionState,
      // Spread field by field rather than wholesale: `teamspeak` carries the channel
      // password, and returning the object as-is would publish it to anyone with the panel
      // open. `hasChannelPassword` tells the UI whether one is set without revealing it.
      teamspeak: {
        host: config.teamspeak.host,
        port: config.teamspeak.port,
        nickname: config.teamspeak.nickname,
        channel: config.teamspeak.channel,
        homeChannelId: config.teamspeak.homeChannelId,
      },
      hasChannelPassword: config.teamspeak.channelPassword !== null,
      hasServerPassword: config.serverPassword !== null,
      audio: config.audio,
      playback: config.playback,
      commands: config.commands,
      permissions: config.permissions,
      grants: {
        identities: config.grants.identities,
        // A Map does not survive JSON; the keys were strings on the way in anyway.
        serverGroups: Object.fromEntries(config.grants.serverGroups),
      },
      // clientQuery is omitted on purpose: it carries the API key.
      // The server and channel passwords are omitted for the same reason.
    };
  });

  app.get('/api/instances/:instanceId/channels', async (request) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const runtime = runtimeOf(instanceId);
    if (runtime.connectionState !== 'connected') {
      throw httpError(409, 'instance is not connected to a TeamSpeak server');
    }
    return { channels: await runtime.bot.listChannels() };
  });

  app.get('/api/instances/:instanceId/clients', async (request) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const runtime = runtimeOf(instanceId);
    if (runtime.connectionState !== 'connected') {
      throw httpError(409, 'instance is not connected to a TeamSpeak server');
    }
    return { clients: await runtime.bot.listChannelClients() };
  });

  app.post('/api/instances/:instanceId/move', async (request, response) => {
    const { instanceId } = instanceIdParamSchema.parse(request.params);
    const { channelId, password } = moveChannelSchema.parse(request.body);

    const runtime = runtimeOf(instanceId);
    if (runtime.connectionState !== 'connected') {
      throw httpError(409, 'instance is not connected to a TeamSpeak server');
    }

    await runtime.bot.moveToChannel(channelId, password);
    return response.status(204).send();
  });
}
