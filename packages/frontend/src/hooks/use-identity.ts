import { useQuery } from '@tanstack/react-query';
import { roleSatisfies, type Role } from '@tsmusic/shared';

import { api, type PanelIdentity } from '../lib/api.ts';

/**
 * Who is holding the panel open.
 *
 * Cached for the session: a token's role does not change under it — revoking one signs that
 * person out entirely rather than demoting them — so refetching on every screen would be
 * noise.
 */
export function useIdentity(): PanelIdentity | undefined {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    staleTime: Number.POSITIVE_INFINITY,
  }).data;
}

/**
 * Whether the current credential clears a bar.
 *
 * The answer for an identity that has not loaded yet is no. Showing a control and taking it
 * away a moment later is worse than showing it a moment late, and the server refuses either
 * way — this only decides what is worth offering.
 */
export function useCan(required: Role): boolean {
  const identity = useIdentity();
  return identity !== undefined && roleSatisfies(identity.role, required);
}
