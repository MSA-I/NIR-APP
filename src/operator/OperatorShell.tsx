import { NavLink, Outlet } from 'react-router';
import { useState } from 'react';
import { LogOut, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/ui';
import { toHebrewError } from '../lib/errors';

/**
 * The operator console's own chrome — deliberately NOT the tenant Layout. Layout is a tenant
 * surface: role-aware navigation, the requires-attention strip, inbox counts, quick actions.
 * None of that has meaning for a cross-tenant operator, and importing it here would drag the
 * whole tenant shell into the operator bundle. Two links and a sign-out are the honest shape
 * of this application today.
 */
const NAV = [
  { to: '/admin/customers', label: 'לקוחות', end: false },
  { to: '/admin', label: 'ניהול פלטפורמה', end: true },
  { to: '/admin/autonomy', label: 'אוטונומיית מסמכים', end: false },
] as const;

export default function OperatorShell() {
  const { signOut, session } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    const result = await signOut();
    setBusy(false);
    if (result.error) {
      toast(toHebrewError(result.error), 'error');
      return;
    }
    if (result.pushWarning) toast(result.pushWarning, 'error');
    // No navigation here: the session change makes PlatformGuard hand the visitor to /login.
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <span className="flex items-center gap-2 font-medium text-ink">
            <ShieldCheck size={19} aria-hidden="true" /> תפעול פלטפורמה
          </span>
          <nav aria-label="ניווט מסוף התפעול" className="flex items-center gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  isActive
                    ? 'rounded-full bg-surface-sunken px-3 py-1.5 text-sm font-medium text-ink'
                    : 'rounded-full px-3 py-1.5 text-sm text-ink-soft transition-colors hover:text-ink'}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ms-auto flex items-center gap-3">
            {session?.user.email && (
              <span dir="ltr" className="text-sm text-ink-muted">{session.user.email}</span>
            )}
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void handleSignOut()}>
              <LogOut size={15} /> {busy ? 'מתנתק…' : 'התנתקות'}
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-5 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
