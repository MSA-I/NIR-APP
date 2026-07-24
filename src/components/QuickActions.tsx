import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { quickActionsFor } from '../lib/quickActions';

export default function QuickActionsRow({ onCapture, busy = false }: { onCapture: () => void; busy?: boolean }) {
  const { profile } = useAuth();
  const actions = quickActionsFor(profile?.role);
  if (!actions.length) return null;

  const actionClass =
    'group flex min-h-14 items-center gap-3 border-t border-line-soft px-3 py-2.5 text-start text-sm font-medium text-ink-body ' +
    'transition-colors first:border-t-0 hover:bg-surface-sunken active:bg-action-wash/60 disabled:opacity-60 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ' +
    'md:min-h-16 md:border-s md:border-t-0 md:first:border-s-0';

  return (
    <section aria-labelledby="operations-title" className="border-y border-line-strong bg-surface">
      <div className="border-b border-line-soft px-3 py-2.5 sm:px-4">
        <h2 id="operations-title" className="text-sm font-semibold text-ink">פעולות שוטפות</h2>
        <p className="text-xs text-ink-muted">מסלולי העבודה המרכזיים</p>
      </div>
      <div role="group" aria-label="פעולות שוטפות" className="grid md:grid-cols-5">
        {actions.map(({ key, label, icon: Icon, kind, to }) => {
          const content = (
            <>
              <span className="grid size-8 shrink-0 place-items-center border border-line text-action transition-colors group-hover:border-action-line" aria-hidden="true">
                {kind === 'capture' && busy ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
              </span>
              <span>{label}</span>
            </>
          );
          return kind === 'capture' ? (
            <button key={key} type="button" className={actionClass} onClick={onCapture} disabled={busy}>{content}</button>
          ) : (
            <Link key={key} to={to!} className={actionClass}>{content}</Link>
          );
        })}
      </div>
    </section>
  );
}
