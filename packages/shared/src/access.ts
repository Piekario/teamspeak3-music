/**
 * Roles are totally ordered. Comparing roles is comparing their rank — never their name,
 * and never the requester's nickname, which is freely changeable on TeamSpeak.
 * Identity is always keyed by client UID.
 */
export const ROLES = ['blocked', 'user', 'dj', 'owner'] as const;

export type Role = (typeof ROLES)[number];

const ROLE_RANK: Readonly<Record<Role, number>> = Object.freeze({
  blocked: 0,
  user: 10,
  dj: 50,
  owner: 100,
});

export function rankOf(role: Role): number {
  return ROLE_RANK[role];
}

export function roleSatisfies(actual: Role, required: Role): boolean {
  if (actual === 'blocked') return false;
  return rankOf(actual) >= rankOf(required);
}

export function highestRole(roles: readonly Role[]): Role | undefined {
  return roles.reduce<Role | undefined>(
    (best, role) => (best === undefined || rankOf(role) > rankOf(best) ? role : best),
    undefined,
  );
}

export const COMMAND_NAMES = [
  'play',
  'search',
  'pick',
  'playnext',
  'skip',
  'voteskip',
  'pause',
  'resume',
  'stop',
  'queue',
  'np',
  'remove',
  'clear',
  'shuffle',
  'repeat',
  'volume',
  'seek',
  'join',
  'leave',
  'playlist',
  'history',
  'help',
  'ping',
  'ytupdate',
  'perm',
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

/**
 * Shipping defaults. Persisted per-instance overrides in `command_policies` win over these,
 * so an operator can hand `!skip` to everyone on one server and lock it to DJs on another.
 */
export const DEFAULT_COMMAND_ROLES: Readonly<Record<CommandName, Role>> = Object.freeze({
  play: 'user',
  search: 'user',
  pick: 'user',
  playnext: 'dj',
  skip: 'dj',
  voteskip: 'user',
  pause: 'dj',
  resume: 'dj',
  stop: 'dj',
  queue: 'user',
  np: 'user',
  remove: 'user',
  clear: 'dj',
  shuffle: 'dj',
  repeat: 'dj',
  volume: 'dj',
  seek: 'dj',
  join: 'dj',
  leave: 'dj',
  playlist: 'user',
  history: 'user',
  help: 'user',
  ping: 'user',
  ytupdate: 'owner',
  perm: 'owner',
});
