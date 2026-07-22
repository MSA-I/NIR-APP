import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Organization, Profile } from '../lib/types';
import { unwrap } from '../lib/useQuery';
import { APP_NAME } from '../lib/branding';
import { resolveRoleLabels } from '../lib/status';
import { cleanupPushBeforeSignOut } from '../lib/push';
import { toHebrewError } from '../lib/errors';

export interface SignOutResult {
  error: string | null;
  pushWarning: string | null;
}

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  org: Organization | null;
  loading: boolean;
  bootstrapError: string | null;
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
}

const AuthContext = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [org, setOrg] = useState<Organization | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const sessionUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    function applySession(next: Session | null) {
      const nextUserId = next?.user.id ?? null;
      if (nextUserId !== sessionUserId.current) {
        sessionUserId.current = nextUserId;
        setProfile(null);
        setOrg(null);
        setIsPlatformAdmin(false);
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
    if (!session) { setProfile(null); setOrg(null); setIsPlatformAdmin(false); return; }
    let cancelled = false;
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
        // Deliberately not gated on `p`: an operator with no tenant profile is valid.
        const admin = unwrap(
          await supabase.from('platform_admins').select('user_id').eq('user_id', session.user.id).maybeSingle(),
        ) as { user_id: string } | null;
        if (!cancelled) {
          setProfile(p);
          setOrg(o);
          setIsPlatformAdmin(!!admin);
          setBootstrapError(null);
        }
      } catch (error) {
        // Never leave the app spinning on a failed bootstrap.
        if (!cancelled) {
          setProfile(null);
          setOrg(null);
          setIsPlatformAdmin(false);
          setBootstrapError(toHebrewError(error));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [session, bootstrapAttempt]);

  // index.html ships a tenant-neutral <title> (the product name) because the database
  // is unreachable at parse time. We prefix the tenant only once it is actually known,
  // so the tab never shows one customer's name to another, and it reverts on sign-out.
  useEffect(() => {
    document.title = org ? `${org.name} — ${APP_NAME}` : APP_NAME;
  }, [org]);

  const roleLabels = useMemo(() => resolveRoleLabels(org?.settings), [org?.settings]);

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
    <AuthContext.Provider value={{ session, profile, org, loading, bootstrapError, isPlatformAdmin, roleLabels, signIn, signOut, retryBootstrap }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

/** Landing route per role */
export function homeFor(role: string | undefined): string {
  switch (role) {
    case 'kitchen': return '/receiving';
    case 'payer': return '/pay';
    case 'accountant': return '/reports';
    case 'supplier': return '/my-prices';
    default: return '/dashboard';
  }
}
