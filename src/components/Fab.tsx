import { Link, useLocation } from 'react-router';
import type { CSSProperties } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { isFocusPath, isRouteFamilyActive, quickActionsFor } from '../lib/quickActions';
import type { Role } from '../lib/types';
import { useQuickCapture } from './QuickCapture';
import { ACTIVE_ORGANIZATION_ACCESS } from '../lib/trial';

/**
 * G1, finding 7 — a filter where there used to be `[]`.
 *
 * The three suppressed paths are long forms a stray navigation would destroy, so hiding the
 * *navigating* actions is right. Hiding the whole bar also took the camera away, and the worst
 * place to lose it is `/receiving/:orderId`: the receiving user is standing at the truck holding
 * both the goods and the invoice, and that screen admitted it in prose — "צילום החשבונית יתאפשר
 * מיד לאחר סיום הקבלה" (Receiving.tsx:788). Capture navigates nowhere: `QuickCapture` uploads into
 * the inbox and contains no `navigate`, so it cannot cost the user the form they are filling.
 */
export function quickActionsForPath(role: Role | undefined, pathname: string) {
  const actions = quickActionsFor(role);
  return isFocusPath(pathname)
    ? actions.filter((action) => action.kind === 'capture')
    : actions;
}

/**
 * Quick actions, phone only.
 *
 * The desktop speed-dial was removed by owner decision (09.08.2026). It duplicated an action every
 * page already carries in its own header, it offered "צילום מסמך" — a camera — on a desktop, and it
 * sat flush in the top corner with no inset, colliding with the header band. Everything that went
 * with it went too: the trigger, the roving-focus menu, the focus hand-off between two surfaces,
 * and the `matchMedia` listener that closed the menu when the viewport crossed `lg`. One surface
 * needs none of it.
 *
 * The mobile bar is unchanged, and it is the only quick-action surface now. The drawer remains the
 * full navigation source (DESIGN.md); this bar exposes frequent actions, not a parallel menu.
 */
export default function Fab() {
  const { profile, organizationAccess = ACTIVE_ORGANIZATION_ACCESS } = useAuth();
  const { pathname } = useLocation();
  const { openCapture, element, busy, retryCount } = useQuickCapture();

  // A read-only tenant (trial expired, or offboarding requested) gets no write affordances. The
  // desktop speed-dial the campaign gated here no longer exists — it was removed by owner decision
  // on 09.08.2026 — so the gate applies to the one surface that remains.
  const mobileActions = organizationAccess.canWrite ? quickActionsForPath(profile?.role, pathname) : [];
  if (!mobileActions.length) return <>{element}</>;

  const mobileItemClass =
    'mobile-action min-w-0 text-xs font-medium text-ink-soft transition-colors hover:bg-action-wash ' +
    'active:bg-action-wash/70 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-focus';

  return (
    <>
      <div role="group" aria-label="פעולות מהירות"
        style={{ '--mobile-action-count': mobileActions.length } as CSSProperties}
        className="mobile-action-bar fixed z-40 border-t border-line bg-surface shadow-menu no-print lg:hidden">
        {mobileActions.map(({ key, label, icon: Icon, kind, to }) => {
          const content = (
            <>
              <Icon size={20} className="shrink-0 text-action" aria-hidden="true" />
              <span className="mobile-action-label">{label}</span>
            </>
          );
          return kind === 'capture' ? (
            <button key={key} type="button" className={`${mobileItemClass} mobile-action-raised`} data-quick-action-key={key}
              disabled={busy} aria-busy={busy || undefined}
              aria-label={busy ? 'מעלה מסמך' : retryCount ? `ניסיון חוזר להעלאת ${retryCount} מסמכים` : label}
              title={retryCount ? `ניסיון חוזר לנכשלים בלבד (${retryCount})` : label}
              onClick={openCapture}>
              <span className="mobile-action-puck" aria-hidden="true">
                {busy
                  ? <Loader2 size={26} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : <Icon size={26} aria-hidden="true" />}
              </span>
              <span className="mobile-action-label">{label}</span>
            </button>
          ) : (
            <Link key={key} to={to!}
              aria-current={isRouteFamilyActive(pathname, to!) ? 'page' : undefined}
              className={`${mobileItemClass} ${isRouteFamilyActive(pathname, to!) ? 'bg-action-wash text-action-on-soft' : ''}`}
              data-quick-action-key={key}>{content}</Link>
          );
        })}
      </div>
      {element}
    </>
  );
}
