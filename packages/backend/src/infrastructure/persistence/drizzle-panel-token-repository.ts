import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';
import { ROLES, type Role } from '@tsmusic/shared';

import type {
  PanelToken,
  PanelTokenRepository,
} from '../../contexts/access/domain/panel-access.ts';
import type { Db } from './database.ts';
import { panelTokens } from './schema.ts';

type TokenRow = typeof panelTokens.$inferSelect;

/**
 * Hashing, not encryption.
 *
 * A panel token is a password: it is presented on every request and never needs to be read
 * back, so the database keeps only a digest. SHA-256 without a salt is the right choice here
 * and a wrong one for user passwords — these are 32 bytes of `randomBytes`, so there is no
 * dictionary to attack and no low-entropy secret for a slow KDF to protect.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Long enough that guessing is hopeless, and URL-safe so it survives a copy-paste. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export class DrizzlePanelTokenRepository implements PanelTokenRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<readonly PanelToken[]> {
    const rows = this.#db.select().from(panelTokens).orderBy(asc(panelTokens.label)).all();
    return rows.map(toToken);
  }

  async findByToken(token: string): Promise<PanelToken | undefined> {
    const row = this.#db
      .select()
      .from(panelTokens)
      .where(eq(panelTokens.tokenHash, hashToken(token)))
      .get();

    if (row === undefined) return undefined;

    // Stamped on use so an operator can tell a live credential from one nobody has touched
    // in months — the only signal available for deciding what is safe to revoke.
    this.#db
      .update(panelTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(panelTokens.id, row.id))
      .run();

    return toToken(row);
  }

  async create(input: {
    label: string;
    role: Role;
    instanceId: string | null;
    token: string;
  }): Promise<PanelToken> {
    const row = {
      id: randomUUID(),
      label: input.label,
      tokenHash: hashToken(input.token),
      role: input.role,
      instanceId: input.instanceId,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };

    this.#db.insert(panelTokens).values(row).run();
    return toToken(row);
  }

  async delete(id: string): Promise<void> {
    this.#db.delete(panelTokens).where(eq(panelTokens.id, id)).run();
  }
}

function toToken(row: TokenRow): PanelToken {
  return {
    id: row.id,
    label: row.label,
    // A role written by hand into the database should not become a role nobody recognises.
    role: (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : 'blocked',
    instanceId: row.instanceId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
