import { NavLink, Outlet, useLocation } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { LogOut, X } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { ICON, useToast } from '../components/ui';
import { APP_NAME } from '../lib/branding';
import { useGlowPointer } from '../lib/glowPointer';
import { toHebrewError } from '../lib/errors';

/**
 * The operator console's own chrome — deliberately NOT the tenant `Layout`. Layout is a tenant
 * surface: role-aware navigation, the requires-attention strip, inbox counts, quick actions.
 * None of that has meaning for a cross-tenant operator, and importing it here would drag the
 * whole tenant shell into the operator bundle.
 *
 * What it DOES share is the design system, because a second application in the same product that
 * invents its own chrome reads as a different product. So this file speaks T7.2 verbatim: the
 * wheat canvas with the single pointer orb, a transparent sticky header rather than a bar, a
 * paper logo pill at the start, the white navigation capsule in the middle with the active
 * destination in the OCEANIC pill, and — under `lg` — the `topbar/75` blurred phone bar with an
 * opaque drawer. The vocabulary is DESIGN.md §5 "Navigation — גלולה צפה"; nothing here is a new
 * shape, and that is the point.
 */
const NAV = [
  { to: '/admin', label: 'מרכז בקרה', end: true },
  { to: '/admin/customers', label: 'לקוחות', end: false },
  { to: '/admin/users', label: 'משתמשים', end: false },
  { to: '/admin/team', label: 'צוות', end: false },
  { to: '/admin/funnel', label: 'משפך', end: false },
  { to: '/admin/platform', label: 'ניהול פלטפורמה', end: false },
  { to: '/admin/autonomy', label: 'אוטונומיית מסמכים', end: false },
  { to: '/admin/signups', label: 'הרשמות', end: false },
  { to: '/admin/purge', label: 'מחיקה סופית', end: false },
] as const;

/** T7.2/T7.3: not selected = quiet ink on the paper capsule; selected = the small oceanic pill.
    `min-h-11` because a navigation item is a touch target like any other. */
const pillCls = ({ isActive }: { isActive: boolean }) =>
  `relative flex min-h-11 items-center whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
    isActive ? 'bg-action font-medium text-on-solid' : 'text-ink-soft hover:bg-surface-hover hover:text-ink'
  }`;

/** The drawer runs the same two states on an opaque surface — the phone's language in T7.3k. */
const drawerCls = ({ isActive }: { isActive: boolean }) =>
  `flex min-h-11 items-center rounded-full px-3.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
    isActive ? 'bg-action font-medium text-on-solid' : 'text-ink-soft hover:bg-surface-hover hover:text-ink'
  }`;

/** Three paths that rotate into an X rather than two swapped icons: what reads as a fold has to
    be the same three nodes in both states (Layout carries the same control, same reasoning). */
function MenuGlyph() {
  return (
    <svg width={ICON.lg} height={ICON.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16" className="origin-center transition-transform duration-200 group-aria-expanded:rotate-[315deg] group-aria-expanded:translate-y-[5px]" />
      <path d="M4 12h16" className="origin-center transition-opacity duration-200 group-aria-expanded:opacity-0" />
      <path d="M4 17h16" className="origin-center transition-transform duration-200 group-aria-expanded:rotate-45 group-aria-expanded:-translate-y-[5px]" />
    </svg>
  );
}

export default function OperatorShell() {
  const { signOut, session } = useAuth();
  const location = useLocation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useGlowPointer();

  // A destination change closes the drawer; it is a navigation surface, not a mode.
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    drawerRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

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

  const email = session?.user.email ?? '';
  const initials = email.slice(0, 2).toUpperCase();

  return (
    <div className="min-h-dvh">
      {/* T7.3f: the pointer's oceanic wash drifts on the background itself — one orb, fixed,
          behind everything. The console is a screen of the same product, so it breathes the
          same canvas. */}
      <div aria-hidden="true" className="app-glow no-print" />

      {/* ===== Desktop: floating pills, no bar (T7.2) ===== */}
      <header className="sticky top-0 z-40 hidden bg-canvas/70 backdrop-blur lg:block no-print">
        <div className="mx-auto flex min-h-[4.25rem] max-w-[1400px] items-center gap-3 px-4 py-2">
          <span className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-surface/85 px-3 shadow-card ring-1 ring-line-soft">
            <img src="/favicon.svg" alt="" width={28} height={28} className="size-7 shrink-0 object-contain" />
            <span className="text-sm font-semibold text-ink">{APP_NAME}</span>
            {/* The console is a different application of the same product, and the header is the
                only place that can say so without a screen having to repeat it. */}
            <span className="text-sm text-ink-muted">· תפעול</span>
          </span>

          <div className="flex min-w-0 flex-1 justify-center">
            <nav aria-label="ניווט מסוף התפעול"
              className="flex min-w-0 flex-wrap items-center justify-center gap-0.5 rounded-[1.625rem] bg-surface/90 p-1.5 shadow-card ring-1 ring-line-soft backdrop-blur">
              {NAV.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={pillCls}>{item.label}</NavLink>
              ))}
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className="btn-ghost btn-icon rounded-full" disabled={busy}
              onClick={() => void handleSignOut()} aria-label="התנתקות">
              <LogOut size={ICON.md} aria-hidden="true" />
            </button>
            {/* The account disc of T7.2: initials on the oceanic, and the address itself as its
                accessible name — an operator signs in as themselves and needs to see which. */}
            <span title={email} aria-label={email}
              className="grid size-10 place-items-center rounded-full bg-action text-sm font-medium text-on-solid shadow-card">
              <span aria-hidden="true" dir="ltr">{initials}</span>
            </span>
          </div>
        </div>
      </header>

      {/* ===== Phone: the topbar/blur bar with bare round icons (T7.3k) ===== */}
      <header className="sticky top-0 z-40 bg-topbar/75 backdrop-blur lg:hidden no-print"
        style={{ paddingBlockStart: 'env(safe-area-inset-top)' }}>
        <div className="flex min-h-14 items-center gap-2 px-3">
          <button ref={triggerRef} type="button" className="btn-ghost btn-icon group rounded-full"
            aria-expanded={menuOpen} aria-controls="operator-navigation" aria-label="תפריט"
            onClick={() => setMenuOpen((open) => !open)}>
            <MenuGlyph />
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
            {APP_NAME} · תפעול פלטפורמה
          </span>
          <button type="button" className="btn-ghost btn-icon rounded-full" disabled={busy}
            onClick={() => void handleSignOut()} aria-label="התנתקות">
            <LogOut size={ICON.md} aria-hidden="true" />
          </button>
        </div>
      </header>

      {menuOpen && (
        <div className="drawer-scrim fixed inset-0 z-50 bg-shell/50 no-print lg:hidden"
          onClick={() => setMenuOpen(false)}>
          {/* Opaque, not translucent: over the dark scrim a see-through panel reads as a murky
              blue tint — the same finding that made the tenant drawer opaque (T7.3k). */}
          <aside id="operator-navigation" ref={drawerRef} role="dialog" aria-modal="true"
            aria-label="ניווט מסוף התפעול" tabIndex={-1}
            className="drawer-enter absolute inset-y-0 start-0 w-72 border-e border-line-soft bg-topbar focus:outline-none"
            onClick={(event) => event.stopPropagation()}>
            <button type="button" className="btn-ghost btn-icon absolute end-2 rounded-full"
              style={{ insetBlockStart: 'max(0.5rem, env(safe-area-inset-top))' }}
              onClick={() => { setMenuOpen(false); triggerRef.current?.focus(); }} aria-label="סגירת תפריט">
              <X size={ICON.lg} aria-hidden="true" />
            </button>
            <nav aria-label="יעדי מסוף התפעול" className="flex flex-col gap-1 p-3 pt-14">
              {NAV.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={drawerCls}>{item.label}</NavLink>
              ))}
              {email && (
                <span dir="ltr" className="mt-3 truncate border-t border-line-soft px-3.5 pt-3 text-xs text-ink-muted">
                  {email}
                </span>
              )}
            </nav>
          </aside>
        </div>
      )}

      <main id="main" tabIndex={-1} className="min-w-0 px-4 pb-8 pt-5 focus:outline-none sm:px-6">
        <div className="mx-auto min-w-0 max-w-[1400px]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
