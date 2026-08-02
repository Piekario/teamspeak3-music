import { ROLES } from '@tsmusic/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { PanelTokenRepository } from '../../../contexts/access/domain/panel-access.ts';
import type { InstanceManager } from '../../../contexts/instances/application/instance-manager.ts';
import { httpError } from '../errors.ts';
import { generateToken } from '../../persistence/drizzle-panel-token-repository.ts';
import { identityOf, requireRole } from '../guards.ts';

const createTokenSchema = z.object({
  label: z.string().min(1).max(80),
  // `blocked` is deliberately not offered: a token nobody may use is a deleted token.
  role: z.enum(['user', 'dj', 'owner']),
  /** Null grants every bot; naming one confines the token to it. */
  instanceId: z.string().min(1).nullable().default(null),
});

const tokenIdParamSchema = z.object({ tokenId: z.string().min(1) });

/**
 * Panel access, managed from the panel.
 *
 * Owners only — issuing a credential is granting access, and a DJ who could mint an owner
 * token would make the role model decorative.
 */
export function registerPanelTokenRoutes(
  app: FastifyInstance,
  tokens: PanelTokenRepository,
  instances: InstanceManager,
): void {
  /** Who am I: the panel needs this to hide what the role cannot do. */
  app.get('/api/me', async (request) => {
    const identity = identityOf(request);
    return {
      label: identity.label,
      role: identity.role,
      instanceId: identity.instanceId,
      isRootToken: identity.isRootToken,
    };
  });

  app.get('/api/panel-tokens', async (request) => {
    requireRole(request, 'owner');
    return { tokens: await tokens.list() };
  });

  app.post('/api/panel-tokens', async (request, reply) => {
    requireRole(request, 'owner');
    const body = createTokenSchema.parse(request.body);

    if (body.instanceId !== null && !instances.has(body.instanceId)) {
      throw httpError(422, `no instance '${body.instanceId}'`);
    }

    // Returned once, in this response, and never again: only its hash is stored, so nothing
    // here or in the database can show it a second time.
    const token = generateToken();
    const created = await tokens.create({ ...body, token });

    return await reply.status(201).send({ ...created, token });
  });

  app.delete('/api/panel-tokens/:tokenId', async (request, reply) => {
    requireRole(request, 'owner');
    const { tokenId } = tokenIdParamSchema.parse(request.params);

    await tokens.delete(tokenId);
    return await reply.status(204).send();
  });

  /** The roles a token may be given, so the panel does not hard-code its own copy. */
  app.get('/api/panel-tokens/roles', async (request) => {
    requireRole(request, 'owner');
    return { roles: ROLES.filter((role) => role !== 'blocked') };
  });
}
