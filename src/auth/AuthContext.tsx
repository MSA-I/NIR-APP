import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Organization, Profile } from '../lib/types';
import { unwrap } from '../lib/useQuery';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { resolveRoleLabels } from '../lib/status';
import { cleanupPushBeforeSignOut } from '../lib/push';
import { toHebrewError } from '../lib/errors';
import {
  getRememberedOfflineBootstrap,
  offlineAccessProjectionFromServer,
  organizationAccessFromOfflineBootstrap,
  rememberOfflineBootstrap,
} from '../lib/offlineDb';
import {
  organizationAccessFromServer,
  READ_ONLY_ORGANIZATION_ACCESS,
  type OrganizationAccess,
  type OrganizationAccessStateRow,
} from '../lib/trial';

export interface SignOutResult {
  error: string | null;
  pushWarning: string | null;
}

/**
 * How long the account bootstrap may run before it is treated as failed.
 *
 * Generous on purpose — four round trips on a slow phone are normal, and overshooting is
 * self-healing (see the watchdog in the bootstrap effect: a late success still fills the
 * profile and clears the error). Undershooting is not: it would show a failure screen to a
 * user whose account was about to load.
 */
export const BOOTSTRAP_TIMEOUT_MS = 15_000;
export const BOOTSTRAP_TIMEOUT_MESSAGE = 'טעינת פרטי החשבון נמשכה זמן רב מדי.';

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  org: Organization | null;
  loading: boolean;
  bootstrapError: string | null;
  offlineBootstrap: boolean;
  organizationAccess: OrganizationAccess;
  /**
   * Platform operator, a separate axis from `profile.role` — an operator administers
   * tenants, a role administers within one. Checked against `platform_admins`, whose
   * policy runs through is_platform_admin() and never through auth_org(), so it still
   * answers for an operator whose own org is suspended.
   *
   * This is UX only. The security boundary is the RLS policies on `platform_admins` /
   * `organizations` and the caller check inside the admin-provision function.
   */
  isPlatformAdmin: boolean;
  /** Role → display label for the signed-in tenant. Drop-in replacement for ROLE_LABEL. */
  roleLabels: Record<string, string>;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<SignOutResult>;
  retryBootstrap: () => void;
  refreshOrganizationAccess: () => Promise<void>;
}

const AuthContext = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [org, setOrg] = useState<Organization | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [offlineBootstrap, setOfflineBootstrap] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [access, setAccess] = useState<OrganizationAccess>(READ_ONLY_ORGANIZATION_ACCESS);
  const sessionUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    function applySession(next: Session | null) {
      const nextUserId = next?.user.id ?? null;
      if (nextUserId !== sessionUserId.current) {
        sessionUserId.current = nextUserId;
        setProfile(null);
        setOrg(null);
        setIsPlatformAdmin(false);
        setOfflineBootstrap(false);
        setAccess(READ_ONLY_ORGANIZATION_ACCESS);
        setBootstrapError(null);
        setLoading(!!next);
      }
      setSession(next);
    }

    void supabase.auth.getSession().then(({ data }) => {
      applySession(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => applySession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); setOrg(null); setIsPlatformAdmin(false); setOfflineBootstrap(false); return; }
    let cancelled = false;
    // A watchdog rather than a Promise.race, because the only requirement is that `loading`
    // cannot stick. supabase-js resolves the auth token before it issues *any* request, so a
    // wedged token refresh hangs every call below without ever rejecting — the `finally` that
    // clears `loading` is then never reached, and `Guard` renders PageLoader forever on every
    // route. That is exactly what stranded sessions held open across the 10.08 deploy.
    // Firing this converts the hang into the ordinary bootstrap failure the `catch` below
    // already renders, which carries both "ניסיון חוזר" and sign-out. It does not cure the
    // wedge; it makes the app recoverable without devtools.
    const watchdog = setTimeout(() => {
      if (cancelled) return;
      setBootstrapError(BOOTSTRAP_TIMEOUT_MESSAGE);
      setLoading(false);
    }, BOOTSTRAP_TIMEOUT_MS);
    (async () => {
      try {
        // maybeSingle, not single: zero rows is an expected outcome, not an error.
        // profiles_select and organizations both filter through auth_org(), which 0006
        // makes return null for a suspended org -- so a suspended tenant reads nothing,
        // including their own rows. .single() threw there, and the rejection escaped this
        // IIFE and dumped the user at /login with no explanation. Now profile stays null
        // with a live session, which App renders as "account unavailable".
        const p = unwrap(
          await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle(),
        ) as Profile | null;
        const o = p
          ? (unwrap(
              await supabase.from('organizations').select('*').eq('id', p.org_id).maybeSingle(),
            ) as Organization | null)
          : null;
        const accessRows = p && o
          ? (unwrap(await supabase.rpc('organization_access_state')) as OrganizationAccessStateRow[])
          : [];
        if (p && o && accessRows.length !== 1) {
          throw new Error('organization_access_state_unavailable');
        }
        const serverAccess = organizationAccessFromServer(accessRows[0]);
        // Deliberately not gated on `p`: an operator with no tenant profile is valid.
        const admin = unwrap(
          await supabase.from('platform_admins').select('user_id').eq('user_id', session.user.id).maybeSingle(),
        ) as { user_id: string } | null;
        if (!cancelled) {
          setProfile(p);
          setOrg(o);
          setIsPlatformAdmin(!!admin);
          setOfflineBootstrap(false);
          setAccess(serverAccess);
          setBootstrapError(null);
          if (p && o) {
            try {
              await rememberOfflineBootstrap({
                actorUserId: session.user.id,
                orgId: p.org_id,
                role: p.role,
                access: offlineAccessProjectionFromServer(accessRows[0], serverAccess),
                cachedAt: Date.now(),
              });
            } catch {
              // Online bootstrap remains authoritative even when this device cannot cache it.
            }
          }
        }
      } catch (error) {
        // Never leave the app spinning on a failed bootstrap.
        if (!cancelled) {
          const expiresAt = (session.expires_at ?? 0) * 1000;
          const canUseDeviceContext = typeof navigator !== 'undefined'
            && navigator.onLine === false && expiresAt > Date.now();
          let cached = null;
          if (canUseDeviceContext) {
            try {
              cached = await getRememberedOfflineBootstrap(session.user.id);
            } catch {
              // The unavailable cache is reported through the normal bootstrap failure below.
            }
          }
          if (cached) {
            // IndexedDB holds only scope keys, role and the server access projection. A minimal
            // profile is enough for the receiving guard; no Organization object is synthesized.
            setProfile({
              id: cached.actorUserId,
              org_id: cached.orgId,
              role: cached.role,
              full_name: '',
              phone: null,
              active: true,
              supplier_id: null,
            });
            setOrg(null);
            setIsPlatformAdmin(false);
            setOfflineBootstrap(true);
            setAccess(organizationAccessFromOfflineBootstrap(cached, Date.now()));
            setBootstrapError(null);
          } else {
            setProfile(null);
            setOrg(null);
            setIsPlatformAdmin(false);
            setOfflineBootstrap(false);
            setAccess(READ_ONLY_ORGANIZATION_ACCESS);
            setBootstrapError(toHebrewError(error));
          }
        }
      } finally {
        clearTimeout(watchdog);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; clearTimeout(watchdog); };
  }, [session, bootstrapAttempt]);

  const roleLabels = useMemo(() => resolveRoleLabels(org?.settings), [org?.settings]);

  async function refreshOrganizationAccess() {
    if (!session || !profile || !org || offlineBootstrap) return;
    const result = await supabase.rpc('organization_access_state');
    if (result.error) throw result.error;
    const rows = result.data as OrganizationAccessStateRow[] | null;
    if (rows?.length !== 1) throw new Error('organization_access_state_unavailable');
    const serverAccess = organizationAccessFromServer(rows[0]);
    setAccess(serverAccess);
    try {
      await rememberOfflineBootstrap({
        actorUserId: session.user.id,
        orgId: profile.org_id,
        role: profile.role,
        access: offlineAccessProjectionFromServer(rows[0], serverAccess),
        cachedAt: Date.now(),
      });
    } catch {
      // The live server projection remains authoritative when the local cache is unavailable.
    }
  }

  // Open tabs re-read the canonical server clock instead of crossing trial/grace boundaries with
  // Date.now from a potentially skewed device. The database still rejects every stale write; this
  // poll keeps the controls/countdown aligned without pretending an offline response exists.
  useEffect(() => {
    if (!session || !profile || !org || offlineBootstrap) return;
    const refreshAccess = async () => {
      try {
        await refreshOrganizationAccess();
      } catch {
        // A stale visual state is safer than guessing; the next poll retries and the DB remains
        // the write boundary throughout.
      }
    };
    const timer = window.setInterval(() => void refreshAccess(), 60_000);
    return () => { window.clearInterval(timer); };
  }, [session, profile, org, offlineBootstrap]);

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }

  async function signOut() {
    const push = await cleanupPushBeforeSignOut();
    const { error } = await supabase.auth.signOut();
    return { error: error?.message ?? null, pushWarning: push.warning };
  }

  function retryBootstrap() {
    if (!session) return;
    setBootstrapError(null);
    setLoading(true);
    setBootstrapAttempt((attempt) => attempt + 1);
  }

  return (
    <AuthContext.Provider value={{ session, profile, org, loading, bootstrapError, offlineBootstrap, organizationAccess: access, isPlatformAdmin, roleLabels, signIn, signOut, retryBootstrap, refreshOrganizationAccess }}>
      {/* Every cache key opens with this value. It is deliberately `org?.id ?? null` and not the
          profile's org_id: a suspended organisation makes auth_org() return null server-side, and
          the cache root must move with it so rows read under the live tenant are not served after
          the tenant stopped being readable. */}
      <OrgScopeProvider org={org?.id ?? null}>{children}</OrgScopeProvider>
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

/** Landing route per role. Every role now lands on its own role-tailored /dashboard. */
export function homeFor(_role: string | undefined): string {
  return '/dashboard';
}
