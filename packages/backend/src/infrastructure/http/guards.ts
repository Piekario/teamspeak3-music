import { roleSatisfies, type Role } from '@tsmusic/shared';
import type { FastifyRequest } from 'fastify';

import { mayTouchInstance, type PanelIdentity } from '../../contexts/access/domain/panel-access.ts';
import { httpError } from './errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook before any handler runs. */
    identity?: PanelIdentity;
  }
}

/**
 * The credential behind this request.
 *
 * Throws rather than returning undefined: every route runs behind the authentication hook,
 * so an absent identity is a wiring mistake, and continuing without one would mean serving a
 * request nobody authenticated.
 */
export function identityOf(request: FastifyRequest): PanelIdentity {
  const identity = request.identity;
  if (identity === undefined) throw httpError(401, 'unauthorized');
  return identity;
}

/**
 * Refuses a request whose credential is too weak.
 *
 * The same four roles as the chat commands, on purpose. Two permission models over one bot —
 * one for TeamSpeak, another for the panel — would drift apart the first time somebody was
 * promoted in one and forgotten in the other.
 */
export function requireRole(request: FastifyRequest, required: Role): PanelIdentity {
  const identity = identityOf(request);
  if (!roleSatisfies(identity.role, required)) {
    throw httpError(403, `this needs the ${required} role`);
  }
  return identity;
}

/**
 * Refuses a request aimed at a bot this credential is not scoped to.
 *
 * Answered as 404 rather than 403, deliberately: to somebody scoped to one bot, the others
 * should not exist, and a 403 would confirm which instance ids are real.
 */
export function requireInstance(request: FastifyRequest, instanceId: string, required: Role): void {
  const identity = requireRole(request, required);
  if (!mayTouchInstance(identity, instanceId)) {
    throw httpError(404, `no instance '${instanceId}'`);
  }
}

interface PolicyRule {
  readonly methods: readonly string[];
  readonly path: RegExp;
  readonly role: Role;
}

/**
 * What each route needs, in one table.
 *
 * A table rather than a guard call in every handler: twenty-five handlers each asserting
 * their own rule is twenty-five chances to forget one, and no way to read the policy without
 * reading all of them. The roles mirror the chat commands deliberately — `!skip` is a DJ
 * command, so the skip button is a DJ button.
 *
 * Order matters: the first match wins, so the specific paths come before the general ones.
 */
const POLICY: readonly PolicyRule[] = [
  // Anything to do with access itself is the owner's alone. A DJ who could mint an owner
  // token would make every other line in this table decorative.
  { methods: ['GET', 'POST', 'DELETE'], path: /^\/api\/panel-tokens/, role: 'owner' },

  { methods: ['POST'], path: /^\/api\/instances$/, role: 'owner' },
  { methods: ['PATCH', 'DELETE'], path: /^\/api\/instances\/[^/]+$/, role: 'owner' },
  { methods: ['POST'], path: /^\/api\/instances\/[^/]+\/(start|stop)$/, role: 'owner' },
  // The detail payload is the settings screen: addresses, permissions, who is granted what.
  { methods: ['GET'], path: /^\/api\/instances\/[^/]+$/, role: 'owner' },

  { methods: ['GET'], path: /^\/api\/instances\/[^/]+\/(channels|clients)$/, role: 'dj' },
  { methods: ['POST'], path: /^\/api\/instances\/[^/]+\/move$/, role: 'dj' },

  // Loading a playlist is queueing, not editing, so it sits with the other user actions.
  { methods: ['POST'], path: /^\/api\/instances\/[^/]+\/playlists\/[^/]+\/load$/, role: 'user' },
  { methods: ['GET'], path: /^\/api\/instances\/[^/]+\/playlists/, role: 'user' },
  { methods: ['POST', 'PATCH', 'DELETE'], path: /^\/api\/instances\/[^/]+\/playlists/, role: 'dj' },

  { methods: ['POST'], path: /^\/api\/instances\/[^/]+\/queue\/(move|shuffle|clear)$/, role: 'dj' },
  { methods: ['POST'], path: /^\/api\/instances\/[^/]+\/queue(\/playlist)?$/, role: 'user' },
  { methods: ['DELETE'], path: /^\/api\/instances\/[^/]+\/queue\/[^/]+$/, role: 'user' },
  { methods: ['POST'], path: /^\/api\/instances\/[^/]+\/player\//, role: 'dj' },
  { methods: ['GET'], path: /^\/api\/instances\/[^/]+\/(player|queue|search)$/, role: 'user' },

  { methods: ['GET'], path: /^\/api\/instances$/, role: 'user' },
  // The live feed is read-only and carries the same data the player screen shows.
  { methods: ['GET'], path: /^\/ws$/, role: 'user' },
  { methods: ['GET'], path: /^\/api\/me$/, role: 'user' },
];

/**
 * The role a request needs.
 *
 * Unmatched routes require `owner`, so a route added without a policy entry fails closed —
 * annoying for whoever adds it, which is the point. The alternative fails open, and nobody
 * notices an endpoint that quietly lets everybody in.
 */
export function requiredRoleFor(method: string, path: string): Role {
  const rule = POLICY.find(
    (candidate) => candidate.methods.includes(method) && candidate.path.test(path),
  );
  return rule?.role ?? 'owner';
}

/** The bot a request is aimed at, when it names one. */
export function instanceOf(path: string): string | undefined {
  return /^\/api\/instances\/([^/?]+)/.exec(path)?.[1];
}
