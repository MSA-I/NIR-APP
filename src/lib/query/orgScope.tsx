import { createContext, useContext, type ReactNode } from 'react';
import type { OrgScope } from './keys';

/**
 * The tenant id, exposed to the cache layer without importing `AuthContext`.
 *
 * `src/auth/AuthContext.tsx` imports `unwrap` from `src/lib/useQuery.ts`. If `useQuery` reached
 * back into `AuthContext` for the org, the two modules would import each other. This context
 * imports nothing from auth, so the dependency stays one-directional: AuthProvider fills it,
 * the cache layer reads it.
 *
 * The default is `null`, which is a real value and not a placeholder: `auth_org()` returns null
 * for a suspended organisation and before a profile has loaded, and those results must not share
 * a cache entry with a live tenant's.
 */
const OrgScopeContext = createContext<OrgScope>(null);

export function OrgScopeProvider({ org, children }: { org: OrgScope; children: ReactNode }) {
  return <OrgScopeContext.Provider value={org}>{children}</OrgScopeContext.Provider>;
}

export const useOrgScope = () => useContext(OrgScopeContext);
