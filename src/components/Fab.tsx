import { useT } from '../lib/i18n/LocaleProvider';
import { Link, useLocation } from 'react-router';
import type { CSSProperties } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { isRouteFamilyActive, quickActionsFor } from '../lib/quickActions';
import { useQuickCapture } from './QuickCapture';
import { ICON } from './ui';
import { ACTIVE_ORGANIZATION_ACCESS } from '../lib/organizationAccess';

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
 *
 * `quickActionsForPath(role, _pathname)` used to wrap `quickActionsFor(role)` here, discarding its
 * second argument. It was a filter once — focused forms got `[]` — and G1 finding 7 turned that
 * into "keep the whole bar everywhere", which left a function whose entire body ignored the
 * parameter it was named for. The contract it stood for (a focused form keeps navigation AND
 * capture) is asserted directly on `quickActionsFor` and by rendering this bar at those routes.
 */
export default function Fab({ inboxCount = null }: {
  /**
   * Unfiled-documents count, passed down rather than re-queried: Layout already holds the live
   * value for the drawer and the desktop pill, and a second `useInboxCount` here would mean two
   * head-count round trips on every route change to render one number twice.
   */
  inboxCount?: number | null;
} = {}) {
  const { t } = useT();
  const { profile, organizationAccess = ACTIVE_ORGANIZATION_ACCESS } = useAuth();
  const { pathname } = useLocation();
  const { openCapture, element, busy, retryCount } = useQuickCapture();

  /**
   * A read-only tenant (suspended or offboarding) loses the ability to WRITE, not the ability to
   * read. Until 26.08.2026 this returned `[]` for such a tenant, which took the whole bar away —
   * מרכז הבקרה, קבלת סחורה and the documents door are pure read destinations, and a suspended
   * business was left with no bottom navigation at all on a phone, exactly when it most needs to
   * look at its own numbers and export them. Only the capture puck is a write.
   */
  const mobileActions = quickActionsFor(profile?.role)
    .filter((action) => organizationAccess.canWrite || action.kind !== 'capture');
  if (!mobileActions.length) return <>{element}</>;

  /**
   * "You are here" and "you are pressing this" were the SAME pixel: every item carried
   * `active:bg-surface-selected` and the current page carried `bg-surface-selected`, so pressing
   * any item made it look like the screen you were already on. And the bar had invented a third
   * dialect for the current page — `bg-surface-selected text-action-on-soft` — while the desktop
   * pill and the drawer both mark it with the oceanic fill (DESIGN.md:452).
   *
   * So: current page = the oceanic marker, the same one the other two surfaces use. Pressed = the
   * quiet selected wash, which is now free to mean only that. Each state is written on exactly one
   * of the two branches rather than layered, so nothing depends on which `:active` rule the
   * stylesheet happens to emit last.
   */
  const itemBase =
    'mobile-action min-w-0 text-xs font-medium transition-colors disabled:opacity-60 '
    + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus';
  const restClass = `${itemBase} text-ink-soft hover:bg-surface-hover active:bg-surface-selected`;
  /* The current page. It used to be `bg-action text-on-solid`, which is the camera puck's own
     colour — see the `--color-nav-current` block in index.css for the owner's report and for
     why a fill alone cannot fix it. The RING is not decoration: it is the part that separates
     this pill from the puck in the dark theme, where no fill can. */
  /* THE FOCUS RING IS OVERRIDDEN HERE because this is the one bar item with a solid fill, and
     `--color-focus` measured 1.57:1 against `nav-current` in the LIGHT theme — the ring vanished
     into the marker it was drawn on. `nav-current-ink` is the pill's own lettering colour, already
     measured against that fill at text strength, so the keyboard ring is the loudest thing on the
     pill. It is also a different COLOUR from the pressed state's `active:ring-2`, which is a width
     change in `nav-current-edge`, so focus and press stay two distinguishable states. */
  const currentClass = `${itemBase} bg-nav-current text-nav-current-ink ring-1 ring-inset ring-nav-current-edge active:ring-2 focus-visible:ring-nav-current-ink`;

  return (
    <>
      <div role="group" aria-label={t('fab.groupLabel')}
        style={{ '--mobile-action-count': mobileActions.length } as CSSProperties}
        className="mobile-action-bar fixed z-40 border-t border-line-soft bg-topbar/75 backdrop-blur-sm shadow-menu no-print lg:hidden">
        {mobileActions.map(({ key, labelKey, icon: Icon, kind, to }) => {
          const label = t(labelKey);
          if (kind === 'capture') {
            return (
              <button key={key} type="button" className={`${restClass} mobile-action-raised`} data-quick-action-key={key}
                disabled={busy} aria-busy={busy || undefined}
                aria-label={busy
                  ? t('fab.uploading')
                  : retryCount ? t('fab.retryUpload', { count: retryCount }) : label}
                title={retryCount ? t('fab.retryFailedOnly', { count: retryCount }) : label}
                onClick={openCapture}>
                <span className="mobile-action-puck" aria-hidden="true">
                  {/* 26px has no rung on the ICON scale and is deliberate: the puck is 3.5rem, and
                      the nearest rung (ICON.xl, 22) visibly shrinks the most-used control. Reported
                      to the integrator as a missing rung rather than silently rounded. */}
                  {busy
                  ? <Loader2 size={26} className="animate-spin" aria-hidden="true" />
                    : <Icon size={26} aria-hidden="true" />}
                </span>
                <span className="mobile-action-label">{label}</span>
              </button>
            );
          }
          const current = isRouteFamilyActive(pathname, to!);
          /* The unfiled-documents count reached the desktop pill and the drawer and stopped there.
             On a phone this bar IS the door to that queue for `office`, so the one surface that
             could tell a procurement manager work had arrived was the one that did not. Same rule
             as Layout's — the `/documents` link only, a KNOWN count above zero, never a
             fabricated 0. */
          const pending = to === '/documents' && inboxCount != null && inboxCount > 0 ? inboxCount : null;
          return (
            <Link key={key} to={to!}
              aria-current={current ? 'page' : undefined}
              aria-label={pending == null ? undefined : t('fab.pendingFiling', { label, count: pending })}
              className={current ? currentClass : restClass}
              data-quick-action-key={key}>
              <Icon size={ICON.lg} className={current ? 'shrink-0' : 'shrink-0 text-action'} aria-hidden="true" />
              <span className="mobile-action-label">{label}</span>
              {pending != null && (
                <span aria-hidden="true"
                  className="badge num absolute top-1 end-1.5 bg-action-soft text-action-on-soft">
                  {pending > 99 ? '99+' : pending}
                </span>
              )}
            </Link>
          );
        })}
      </div>
      {element}
    </>
  );
}
