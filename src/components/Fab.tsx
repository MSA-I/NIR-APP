import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, matchPath, useLocation } from 'react-router-dom';
import { Loader2, Plus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { quickActionsFor } from '../lib/quickActions';
import { useQuickCapture } from './QuickCapture';

const FAB_SUPPRESSED_PATHS = ['/orders/new', '/invoices/new', '/receiving/:orderId'] as const;
const QUICK_ACTIONS_MENU_ID = 'global-quick-actions';

export default function Fab() {
  const { profile } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLElement | null>(null);
  const { openCapture, element, busy, retryCount } = useQuickCapture();

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => { if (open) firstItemRef.current?.focus(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (current + 1) % items.length
            : (current <= 0 ? items.length : current) - 1;
      event.preventDefault();
      items[next].focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const actions = quickActionsFor(profile?.role);
  if (!actions.length || FAB_SUPPRESSED_PATHS.some((path) => matchPath(path, pathname) != null)) return null;

  const itemClass =
    'speed-dial-item flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface ps-4 pe-3 py-2.5 ' +
    'whitespace-nowrap text-xs sm:text-sm font-medium text-ink-body shadow-menu transition-colors hover:bg-surface-sunken ' +
    'active:bg-action-wash/70 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

  return (
    <div ref={rootRef} className="phone-fab fixed z-40 no-print">
      <button ref={triggerRef} type="button" aria-expanded={open} aria-haspopup="menu"
        aria-controls={open ? QUICK_ACTIONS_MENU_ID : undefined}
        aria-label={open ? 'סגירת פעולות מהירות' : 'פתיחת פעולות מהירות'}
        onClick={() => setOpen((current) => !current)}
        className="speed-dial-trigger grid size-12 place-items-center border border-action-line bg-action text-white shadow-fab transition-colors hover:bg-action-hover active:bg-action-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas">
        {busy && !open
          ? <Loader2 size={21} className="animate-spin" aria-hidden="true" />
          : <Plus size={21} aria-hidden="true" className="speed-dial-trigger-icon" />}
      </button>
      {open && (
        <div id={QUICK_ACTIONS_MENU_ID} role="menu" aria-label="פעולות מהירות"
          className="speed-dial-menu absolute flex flex-col items-end gap-2">
          {actions.map(({ key, label, icon: Icon, kind, to }, index) => {
            const itemRef = index === 0 ? (node: HTMLElement | null) => { firstItemRef.current = node; } : undefined;
            const content = <>{label}<Icon size={16} className="text-action" aria-hidden="true" /></>;
            return kind === 'capture' ? (
              <button key={key} ref={itemRef} type="button" role="menuitem" className={itemClass} disabled={busy}
                style={{ '--speed-dial-index': index } as CSSProperties}
                aria-label={busy ? 'מעלה מסמך' : retryCount ? `ניסיון חוזר להעלאת ${retryCount} מסמכים` : label}
                title={retryCount ? `ניסיון חוזר לנכשלים בלבד (${retryCount})` : label}
                onClick={() => { setOpen(false); openCapture(); }}>
                {busy ? <>{label}<Loader2 size={16} className="animate-spin text-action" aria-hidden="true" /></> : content}
              </button>
            ) : (
              <Link key={key} ref={itemRef} role="menuitem" to={to!} className={itemClass}
                style={{ '--speed-dial-index': index } as CSSProperties} onClick={() => setOpen(false)}>
                {content}
              </Link>
            );
          })}
        </div>
      )}
      {element}
    </div>
  );
}
