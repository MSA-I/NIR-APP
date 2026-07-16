import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Organization, Profile } from '../lib/types';
import { unwrap } from '../lib/useQuery';

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  org: Organization | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [org, setOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); setOrg(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const p = unwrap(await supabase.from('profiles').select('*').eq('id', session.user.id).single()) as Profile;
        const o = unwrap(await supabase.from('organizations').select('*').eq('id', p.org_id).single()) as Organization;
        if (!cancelled) { setProfile(p); setOrg(o); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [session]);

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider value={{ session, profile, org, loading, signIn, signOut }}>
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
