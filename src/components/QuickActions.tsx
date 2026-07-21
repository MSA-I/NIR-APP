import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { quickActionsFor } from '../lib/quickActions';

/**
 * Dashboard quick-actions band — the FAB's vocabulary (lib/quickActions) laid flat: one
 * quiet card of equal segments, separated with logical border-s dividers (never divide-x,
 * which is physical left/right and breaks under RTL — see BandStat). Below sm the row
 * scrolls horizontally instead of wrapping into a card grid. The capture callback is
 * injected so the page owns useQuickCapture and mounts its hidden input exactly once.
 * Renders nothing for roles with no actions.
 */
export default function QuickActionsRow({ onCapture, busy = false }: { onCapture: () => void; busy?: boolean }) {
  const { profile } = useAuth();
  const actions = quickActionsFor(profile?.role);
  if (actions.length === 0) return null;

  // Ring is inset so the mobile scroll container (overflow-x-auto) can never clip it —
  // the same variant the Layout brand link uses.
  const segmentCls =
    'flex min-h-11 min-w-28 shrink-0 items-center justify-center gap-2.5 border-s border-line-soft px-4 py-3 ' +
    'text-sm font-medium text-ink-body transition-colors first:border-s-0 hover:bg-surface-sunken ' +
    'active:bg-action-wash/70 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-focus sm:min-w-0 sm:flex-1 sm:shrink';

  return (
    <div role="group" aria-label="פעולות מהירות" className="card flex overflow-x-auto">
      {actions.map(({ key, label, icon: Icon, kind, to }) => {
        // BandStat's chip anatomy (grid size-8 rounded-lg) on the count-pill colors.
        const chip = (
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-action-soft text-action-on-soft" aria-hidden="true">
            {kind === 'capture' && busy ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
          </span>
        );
        return kind === 'capture' ? (
          <button key={key} type="button" className={segmentCls} onClick={onCapture} disabled={busy}>
            {chip}{label}
          </button>
        ) : (
          <Link key={key} to={to!} className={segmentCls}>
            {chip}{label}
          </Link>
        );
      })}
    </div>
  );
}
