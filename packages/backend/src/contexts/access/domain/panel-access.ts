import type { Role } from '@tsmusic/shared';

/**
 * Who is holding the panel open.
 *
 * The owner's environment token is deliberately part of this type rather than a special case
 * outside it: bootstrapping has to work before any token has been issued, and the rest of the
 * application should never have to ask which kind of credential it is looking at.
 */
export interface PanelIdentity {
  readonly label: string;
  readonly role: Role;
  /** Null means every bot; otherwise the only instance this credential may touch. */
  readonly instanceId: string | null;
  /** True for the operator token from the environment, which no one can revoke from the UI. */
  readonly isRootToken: boolean;
}

export interface PanelToken {
  readonly id: string;
  readonly label: string;
  readonly role: Role;
  readonly instanceId: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface PanelTokenRepository {
  list(): Promise<readonly PanelToken[]>;
  /** Resolves a presented token. Also stamps last use, so a stale entry can be spotted. */
  findByToken(token: string): Promise<PanelToken | undefined>;
  create(input: {
    label: string;
    role: Role;
    instanceId: string | null;
    token: string;
  }): Promise<PanelToken>;
  delete(id: string): Promise<void>;
}

/**
 * Whether this credential may act on that instance.
 *
 * Scope is checked separately from role because they answer different questions: the role
 * says what a person may do, the scope says to which bot. A DJ on one server has no business
 * skipping tracks on another one, and two bots on two TeamSpeak servers share no audience.
 */
export function mayTouchInstance(identity: PanelIdentity, instanceId: string): boolean {
  return identity.instanceId === null || identity.instanceId === instanceId;
}
