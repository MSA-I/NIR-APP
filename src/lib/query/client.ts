import { QueryClient } from '@tanstack/react-query';
import { orgRoot, type OrgScope } from './keys';

/**
 * Financial writes that may never be shown as done before the server says so.
 *
 * An optimistic update on any of these is a claim about money that the server has not agreed to.
 * The list is duplicated in `docs/adr/0003-tanstack-query-data-layer.md`; it is stated here as
 * code so a reviewer meets it in the file where mutations are configured.
 */
export const NEVER_OPTIMISTIC = [
  'payment execution',
  'invoice approval',
  'supplier bank detail change',
  'credit application',
  'final goods-receipt submission',
  'permission change',
] as const;

/**
 * Retrying a write is not free here. Every financial command already carries a client-generated
 * idempotency UUID, so a retry is *safe*, but an automatic one with no human behind it turns a
 * timeout into a second attempt at moving money. Reads retry; writes do not.
 */
const RETRYABLE_READ_ATTEMPTS = 2;

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Long enough that navigating back to a screen does not refetch, short enough that a
        // financial figure is never minutes old. Screens that need stricter freshness override it.
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        retry: RETRYABLE_READ_ATTEMPTS,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        // Postgres/PostgREST strings must never reach a Hebrew-speaking user. `errors.ts` holds
        // ~70 domain mappings that are business knowledge, not formatting.
        throwOnError: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Drop everything cached for a tenant.
 *
 * Called on sign-out, on a user switch, and whenever `auth_org()` can have changed — a suspended
 * organisation starts returning null, and the rows cached under the previous root must not survive
 * that transition.
 */
export function invalidateOrg(client: QueryClient, org: OrgScope) {
  return client.invalidateQueries({ queryKey: orgRoot(org) });
}

/** Remove, not invalidate: on sign-out the data must leave memory rather than be refetched. */
export function clearOrg(client: QueryClient, org: OrgScope) {
  client.removeQueries({ queryKey: orgRoot(org) });
}
