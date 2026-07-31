import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import type { InstanceManager } from '../../contexts/instances/application/instance-manager.ts';
import type { Clock } from '../../shared-kernel/clock.ts';
import type { EventSubscriber } from '../../shared-kernel/event-bus.ts';
import type { Logger, ScopedLogger } from '../logging/logger.ts';
import { extractToken, tokenMatches } from './auth.ts';
import { HttpError, toErrorResponse } from './errors.ts';
import type { InstanceRepository } from '../../contexts/instances/domain/instance-repository.ts';
import { registerInstanceAdminRoutes } from './routes/instance-admin-routes.ts';
import { registerInstanceRoutes } from './routes/instance-routes.ts';
import { registerPlayerRoutes } from './routes/player-routes.ts';
import { WebSocketHub, type WebSocketLike } from './websocket-hub.ts';

export interface HttpServerOptions {
  readonly host: string;
  readonly port: number;
  readonly adminToken: string;
  readonly instances: InstanceManager;
  /**
   * Enables the instance management routes. Omitted when instances come from a read-only
   * file, so the panel cannot offer to create bots that would vanish on the next restart.
   */
  readonly instanceRepository?: InstanceRepository | undefined;
  readonly events: EventSubscriber;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly scoped: ScopedLogger;
}

export interface HttpServer {
  readonly app: FastifyInstance;
  readonly hub: WebSocketHub;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export async function createHttpServer(options: HttpServerOptions): Promise<HttpServer> {
  // Typed as Fastify's own logger interface rather than pino's concrete `Logger`. Both are
  // structurally compatible at runtime, but pino's type carries extra members that would
  // otherwise infect the FastifyInstance generic and make every route module depend on pino.
  const app = Fastify({
    loggerInstance: options.logger as FastifyBaseLogger,
    disableRequestLogging: true,
  });
  const hub = new WebSocketHub(options.scoped);

  await app.register(websocket);

  /**
   * Health is intentionally the only unauthenticated route: container orchestration has to
   * be able to probe it, and it reveals nothing beyond "the process is up".
   */
  app.get('/api/health', async () => ({ status: 'ok', at: options.clock.now().toISOString() }));

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/api/health') return;

    const query = request.query as { token?: string } | undefined;
    const token = extractToken(request.headers.authorization, query?.token);
    if (!tokenMatches(token, options.adminToken)) {
      await reply.status(401).send({ error: { message: 'unauthorized' } });
    }
  });

  registerInstanceRoutes(app, options.instances);
  registerPlayerRoutes(app, options.instances);
  if (options.instanceRepository !== undefined) {
    registerInstanceAdminRoutes(app, {
      instances: options.instances,
      repository: options.instanceRepository,
    });
  }

  app.get('/ws', { websocket: true }, (socket) => {
    const client = socket as unknown as WebSocketLike;
    hub.add(client);

    // Push a full snapshot immediately, so the panel never renders an empty shell while it
    // waits for something to happen.
    //
    // The instance status matters as much as the player state here. Status events fire only
    // on change, so a panel opened after the bots came up would otherwise show every one of
    // them as disconnected — with all controls disabled — until something happened to change
    // it, which on a healthy system could be hours.
    const at = options.clock.now().toISOString();
    hub.sendTo(
      client,
      options.instances.all.flatMap((runtime) => [
        {
          type: 'instance.status' as const,
          instanceId: runtime.id,
          at,
          payload: runtime.status,
        },
        {
          type: 'player.state' as const,
          instanceId: runtime.id,
          at,
          payload: runtime.playback.session.toPlayerState(),
        },
      ]),
    );

    socket.on('close', () => hub.remove(client));
    socket.on('error', () => hub.remove(client));
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send(toErrorResponse(error));
    }
    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: {
          message: 'invalid request',
          issues: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
      });
    }

    // Anything reaching here is a bug: log it fully, tell the caller nothing that could
    // expose internals such as file paths.
    options.scoped.error('unhandled route error', {
      url: request.url,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return reply.status(500).send({ error: { message: 'internal error' } });
  });

  hub.attach(options.events);

  return {
    app,
    hub,
    async listen() {
      return app.listen({ host: options.host, port: options.port });
    },
    async close() {
      hub.closeAll();
      await app.close();
    },
  };
}
