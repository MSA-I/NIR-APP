import { Bell } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useUnreadNotifications } from '../lib/notifications';

export default function NotificationBell({ onShell = false }: { onShell?: boolean }) {
  const { profile } = useAuth();
  const allowed = profile?.role === 'owner' || profile?.role === 'office';
  const unread = useUnreadNotifications(allowed);
  if (!allowed) return null;

  const label = unread && unread > 0 ? `${unread} התראות חדשות` : 'התראות';
  return (
    <Link to="/alerts" aria-label={label} title={label}
      className={`relative grid size-11 shrink-0 place-items-center border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        onShell
          ? 'border-shell-ink/15 text-shell-ink-soft hover:bg-shell-ink/10 hover:text-shell-ink'
          : 'border-line text-ink-soft hover:bg-surface-sunken hover:text-ink'
      }`}>
      <Bell size={19} aria-hidden="true" />
      {!!unread && unread > 0 && (
        <span aria-hidden="true"
          className={`absolute -end-1 -top-1 min-w-5 border px-1 py-0.5 text-center text-xs font-bold leading-none num ${
            onShell ? 'border-shell bg-alert-solid text-white' : 'border-surface bg-alert-solid text-white'
          }`}>
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
