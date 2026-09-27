import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { roleSatisfies } from '@tsmusic/shared';
import { ZodError, z } from 'zod';

import { CooldownTracker } from '../../contexts/chat/application/cooldown-tracker.ts';
import type { InstanceManager } from '../../contexts/instances/application/instance-manager.ts';
import type { Clock } from '../../shared-kernel/clock.ts';
import type { EventSubscriber } from '../../shared-kernel/event-bus.ts';
import type { Logger, ScopedLogger } from '../logging/logger.ts';
import { clearedSessionCookie, extractToken, sessionCookie, tokenMatches } from './auth.ts';
import { HttpError, toErrorResponse } from './errors.ts';
import type { InstanceRepository } from '../../contexts/instances/domain/instance-repository.ts';
import {
  mayTouchInstance,
  type PanelIdentity,
  type PanelTokenRepository,
} from '../../contexts/access/domain/panel-access.ts';
import { registerPanelTokenRoutes } from './routes/panel-token-routes.ts';
import { instanceOf, requiredRoleFor } from './guards.ts';
import { registerInstanceAdminRoutes } from './routes/instance-admin-routes.ts';
import { registerInstanceRoutes } from './routes/instance-routes.ts';
import { registerPlayerRoutes } from './routes/player-routes.ts';
import { registerPlaylistRoutes } from './routes/playlist-routes.ts';
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
  /**
   * Per-person panel credentials. Absent means only the environment's operator token is
   * accepted, which is the single-operator setup this started as.
   */
  readonly panelTokens?: PanelTokenRepository | undefined;
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

/**
 * Turns a presented token into who is holding it.
 *
 * The environment's operator token is tried first and never touches the database: it is the
 * bootstrap credential, so it has to work before any other has been issued and must keep
 * working if every one of them is revoked.
 */
async function resolveIdentity(
  token: string | undefined,
  options: HttpServerOptions,
): Promise<PanelIdentity | undefined> {
  if (tokenMatches(token, options.adminToken)) {
    return { label: 'operator', role: 'owner', instanceId: null, isRootToken: true };
  }

  if (token === undefined || options.panelTokens === undefined) return undefined;

  const found = await options.panelTokens.findByToken(token);
  if (found === undefined || found.role === 'blocked') return undefined;

  return {
    label: found.label,
    role: found.role,
    instanceId: found.instanceId,
    isRootToken: false,
  };
}

const sessionSchema = z.object({ token: z.string().min(1).max(500) });

/** Three months: long enough that a streamer signs in once a season, short enough to lapse. */
const SESSION_MAX_AGE_SEC = 90 * 24 * 60 * 60;

/**
 * Whether the browser reached us over HTTPS.
 *
 * Read from the forwarded header because nothing here terminates TLS: the tunnel and nginx
 * both sit in front, so the connection Fastify sees is plain HTTP even when the browser's
 * was not.
 */
function isSecure(request: { headers: Record<string, unknown> }): boolean {
  const forwarded = request.headers['x-forwarded-proto'];
  return typeof forwarded === 'string' && forwarded.split(',')[0]?.trim() === 'https';
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

  /**
   * Signing in: the token is exchanged for a cookie the browser keeps.
   *
   * Unauthenticated by necessity — this is where a credential is first presented — and
   * therefore the one route that has to verify it itself.
   */
  app.post('/api/session', async (request, reply) => {
    const body = sessionSchema.parse(request.body);
    const identity = await resolveIdentity(body.token, options);

    if (identity === undefined) {
      return await reply.status(401).send({ error: { message: 'unauthorized' } });
    }

    return await reply
      .header('Set-Cookie', sessionCookie(body.token, {
        secure: isSecure(request),
        maxAgeSec: SESSION_MAX_AGE_SEC,
      }))
      .send({ label: identity.label, role: identity.role, instanceId: identity.instanceId });
  });

  app.delete('/api/session', async (request, reply) => {
    return await reply
      .header('Set-Cookie', clearedSessionCookie(isSecure(request)))
      .status(204)
      .send();
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/api/health') return;
    // Signing in and out are the two things that cannot require being signed in.
    if (request.url === '/api/session') return;

    const query = request.query as { token?: string } | undefined;
    const token = extractToken(request.headers.authorization, query?.token, request.headers.cookie);
    const identity = await resolveIdentity(token, options);

    if (identity === undefined) {
      await reply.status(401).send({ error: { message: 'unauthorized' } });
      return;
    }

    request.identity = identity;

    // Authorisation in the same place as authentication, from one table, so a route cannot
    // be reachable without somebody having decided who may reach it.
    const path = request.url.split('?')[0] ?? '';
    const required = requiredRoleFor(request.method, path);
    if (!roleSatisfies(identity.role, required)) {
      await reply.status(403).send({ error: { message: `this needs the ${required} role` } });
      return;
    }

    // A credential scoped to one bot is told the others do not exist, rather than that it
    // may not touch them: a 403 would confirm which instance ids are real.
    const instanceId = instanceOf(path);
    if (instanceId !== undefined && !mayTouchInstance(identity, instanceId)) {
      await reply.status(404).send({ error: { message: `no instance '${instanceId}'` } });
    }
  });

  if (options.panelTokens !== undefined) {
    registerPanelTokenRoutes(app, options.panelTokens, options.instances);
  }

  // Shared across every credential rather than one per instance: the resource being paced
  // (yt-dlp/ffmpeg processes) is the whole host's, not any one bot's.
  const httpCooldowns = new CooldownTracker(options.clock);

  registerInstanceRoutes(app, options.instances);
  registerPlayerRoutes(app, options.instances, httpCooldowns);
  registerPlaylistRoutes(app, options.instances, httpCooldowns);
  if (options.instanceRepository !== undefined) {
    registerInstanceAdminRoutes(app, {
      instances: options.instances,
      repository: options.instanceRepository,
    });
  }

  app.get('/ws', { websocket: true }, (socket, request) => {
    const client = socket as unknown as WebSocketLike;
    const scope = request.identity?.instanceId ?? null;
    hub.add(client, scope);

    // Push a full snapshot immediately, so the panel never renders an empty shell while it
    // waits for something to happen.
    //
    // The instance status matters as much as the player state here. Status events fire only
    // on change, so a panel opened after the bots came up would otherwise show every one of
    // them as disconnected — with all controls disabled — until something happened to change
    // it, which on a healthy system could be hours.
    const at = options.clock.now().toISOString();
    const visible = options.instances.all.filter(
      (runtime) => scope === null || scope === runtime.id,
    );
    hub.sendTo(
      client,
      visible.flatMap((runtime) => [
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
