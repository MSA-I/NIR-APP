import { useEffect, useRef, useState } from 'react';
import { Link, matchPath, useLocation } from 'react-router-dom';
import { Loader2, Plus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useQuickCapture } from './QuickCapture';
import { quickActionsFor } from '../lib/quickActions';

/**
 * Global floating quick-actions button. Self-contained: reads role and route itself, owns
 * its own useQuickCapture (the hidden input mounts here), and renders nothing for roles
 * with no actions — Layout only wraps authed routes, so public pages never see it.
 * No backdrop/scrim (quiet room); dial closes on outside press, Escape, or navigation.
 */

// Screens where the FAB must not float: the receiving screen has its own fixed action bar
// in the same bottom band (z-30), and the two create screens ARE the FAB's destinations —
// a floating "create" over them would duplicate their purpose.
const FAB_SUPPRESSED_PATHS = ['/receiving/:orderId', '/orders/new', '/invoices/new'] as const;

export default function Fab() {
  const { profile } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const { openCapture, element, busy } = useQuickCapture();

  // Route change closes the dial — link selection navigates, and back/forward is covered too.
  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const actions = quickActionsFor(profile?.role);
  if (actions.length === 0 || FAB_SUPPRESSED_PATHS.some((p) => matchPath(p, pathname) != null)) return null;

  const itemCls =
    'flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface ps-4 pe-3 py-2.5 ' +
    'text-sm font-medium text-ink-body shadow-menu transition-colors hover:bg-surface-sunken ' +
    'active:bg-action-wash/70 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

  return (
    // bottom-20 clears the mobile bottom nav (bottom-0, ~56px); the margin mirrors the
    // nav's own env() safe-area handling so both shift together on notched devices.
    <div ref={rootRef} className="fixed end-4 bottom-20 z-40 no-print lg:end-8 lg:bottom-8"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
      {open && (
        <div role="menu" aria-label="פעולות מהירות"
          className="absolute bottom-full end-0 mb-3 flex flex-col items-end gap-2">
          {/* Label first, icon at the logical end — the label reads first in RTL. Items are
              plain-tabbable (small dial, no roving focus); Escape returns focus to the FAB. */}
          {actions.map(({ key, label, icon: Icon, kind, to }) =>
            kind === 'capture' ? (
              <button key={key} type="button" role="menuitem" className={itemCls} disabled={busy}
                onClick={() => { setOpen(false); openCapture(); }}>
                {label}
                {busy
                  ? <Loader2 size={16} className="animate-spin text-action" aria-hidden="true" />
                  : <Icon size={16} className="text-action" aria-hidden="true" />}
              </button>
            ) : (
              <Link key={key} role="menuitem" to={to!} className={itemCls} onClick={() => setOpen(false)}>
                {label}
                <Icon size={16} className="text-action" aria-hidden="true" />
              </Link>
            ),
          )}
        </div>
      )}
      <button ref={btnRef} type="button" aria-expanded={open} aria-haspopup="menu" aria-label="פעולות מהירות"
        onClick={() => setOpen((o) => !o)}
        className="grid h-14 w-14 place-items-center rounded-full bg-action text-white shadow-fab transition-colors hover:bg-action-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas">
        {busy && !open ? (
          <Loader2 size={24} className="animate-spin" aria-hidden="true" />
        ) : (
          // Plus rotates 45° into an X while open; motion-reduce drops the transition.
          <Plus size={24} aria-hidden="true"
            className={`transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? 'rotate-45' : ''}`} />
        )}
      </button>
      {element}
    </div>
  );
}
