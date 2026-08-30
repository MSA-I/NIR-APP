import { Bell } from 'lucide-react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useUnreadNotifications } from '../lib/notifications';
import { ICON } from './ui';
import { useT } from '../lib/i18n/LocaleProvider';

/**
 * The alert door, in the desktop end-cluster and in the phone header.
 *
 * An `onShell` prop used to switch the bell onto the dark Onyx ramp (`shell-ink-soft`, a `shell`
 * ring on the badge). T7.3k made both clusters light — no caller has passed it since — so the two
 * branches were one live style and one that nothing could reach.
 */
export default function NotificationBell() {
  const { t } = useT();
  const { profile } = useAuth();
  const allowed = profile?.role === 'owner' || profile?.role === 'office';
  const { count: unread, failed } = useUnreadNotifications(allowed);
  if (!allowed) return null;

  /* THREE states, not two (26.08.2026 audit). A bell with no chip is a claim — "nothing is
     waiting" — and the hook used to make that claim after a FAILED read as readily as after a
     successful empty one. The count itself stays absent, because inventing a number would be
     worse; what changes is the name the control answers to, so a person who hovers, or a screen
     reader, is told the difference. Loading deliberately keeps the plain name: it lasts a moment,
     and a skeleton in the chrome would flash on every route change. */
  const label = failed ? t('notificationBell.unknown')
    : unread && unread > 0 ? t('notificationBell.unread', { count: unread })
      : t('notificationBell.plain');
  return (
    <Link to="/alerts" aria-label={label} title={label}
      data-notification-state={failed ? 'unknown' : unread == null ? 'loading' : unread > 0 ? 'unread' : 'clear'}
      className="btn-ghost btn-icon relative rounded-full">
      <Bell size={ICON.xl} aria-hidden="true" />
      {!!unread && unread > 0 && (
        /* `.badge-alert` IS this pair — `badge bg-alert-solid text-on-solid` (index.css) — so the
           count chip stops being the one badge in the product written out by hand. What it was
           before: a square with no radius class, no `badge` geometry, and a `border` in a
           vocabulary that has no border token for a count chip; the border existed only to cut the
           chip out of the surface behind it, which a `ring` in a real token does honestly. */
        <span aria-hidden="true" className="badge-alert num absolute -end-1 -top-1 min-w-5 justify-center px-1 ring-2 ring-topbar">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
