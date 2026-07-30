import { DEFAULT_COMMAND_ROLES, highestRole, roleSatisfies, type CommandName, type Role } from '@tsmusic/shared';

/**
 * Decides whether a person may run a command.
 *
 * Two rules matter more than the rest, and both are here rather than in the dispatcher so
 * they can be reasoned about in one place:
 *
 *  - Identity is the client UID, never the nickname. Nicknames are freely changeable, so
 *    keying permissions on them means somebody impersonates the owner within a week.
 *  - `blocked` short-circuits everything, including `!help`. A blocked user gets no surface
 *    to probe at all.
 */

export interface IdentityGrant {
  readonly uid: string;
  readonly role: Role;
}

export interface PermissionPolicy {
  /** Applied to anyone with no explicit grant and no matching group. */
  readonly defaultRole: Role;
  /** When true, only explicitly granted identities or groups may use the bot at all. */
  readonly whitelistOnly: boolean;
}

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = Object.freeze({
  defaultRole: 'user',
  whitelistOnly: false,
});

export interface CommandPolicy {
  readonly minRole: Role;
  readonly enabled: boolean;
}

export interface PermissionQuery {
  readonly uid: string;
  /** Server groups from `clientlist -groups` — the only source, as ServerQuery is not used. */
  readonly serverGroupIds: readonly number[];
}

export type PermissionDecision =
  | { readonly allowed: true; readonly role: Role }
  | { readonly allowed: false; readonly reason: DenialReason; readonly role: Role };

export type DenialReason =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'not-whitelisted' }
  | { readonly kind: 'command-disabled'; readonly command: CommandName }
  | { readonly kind: 'insufficient-role'; readonly required: Role; readonly actual: Role };

export class PermissionResolver {
  readonly #identityGrants: ReadonlyMap<string, Role>;
  readonly #groupGrants: ReadonlyMap<number, Role>;
  readonly #commandPolicies: ReadonlyMap<CommandName, CommandPolicy>;
  readonly #policy: PermissionPolicy;

  constructor(options: {
    identityGrants?: ReadonlyMap<string, Role>;
    groupGrants?: ReadonlyMap<number, Role>;
    commandPolicies?: ReadonlyMap<CommandName, CommandPolicy>;
    policy?: PermissionPolicy;
  }) {
    this.#identityGrants = options.identityGrants ?? new Map();
    this.#groupGrants = options.groupGrants ?? new Map();
    this.#commandPolicies = options.commandPolicies ?? new Map();
    this.#policy = options.policy ?? DEFAULT_PERMISSION_POLICY;
  }

  /**
   * Resolves an effective role. First an explicit grant for the UID, then the highest role
   * among the person's server groups, then the configured default.
   */
  roleOf(query: PermissionQuery): Role {
    const explicit = this.#identityGrants.get(query.uid);
    if (explicit !== undefined) return explicit;

    const fromGroups = highestRole(
      query.serverGroupIds
        .map((groupId) => this.#groupGrants.get(groupId))
        .filter((role): role is Role => role !== undefined),
    );
    if (fromGroups !== undefined) return fromGroups;

    return this.#policy.whitelistOnly ? 'blocked' : this.#policy.defaultRole;
  }

  can(query: PermissionQuery, command: CommandName): PermissionDecision {
    const role = this.roleOf(query);

    if (role === 'blocked') {
      const reason: DenialReason =
        this.#policy.whitelistOnly && !this.#hasExplicitGrant(query)
          ? { kind: 'not-whitelisted' }
          : { kind: 'blocked' };
      return { allowed: false, reason, role };
    }

    const policy = this.#commandPolicies.get(command);
    if (policy !== undefined && !policy.enabled) {
      return { allowed: false, reason: { kind: 'command-disabled', command }, role };
    }

    const required = policy?.minRole ?? DEFAULT_COMMAND_ROLES[command];
    if (!roleSatisfies(role, required)) {
      return { allowed: false, reason: { kind: 'insufficient-role', required, actual: role }, role };
    }

    return { allowed: true, role };
  }

  #hasExplicitGrant(query: PermissionQuery): boolean {
    if (this.#identityGrants.has(query.uid)) return true;
    return query.serverGroupIds.some((groupId) => this.#groupGrants.has(groupId));
  }
}
