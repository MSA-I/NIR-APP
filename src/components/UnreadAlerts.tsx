import { useRef } from 'react';
import { useNavigate } from 'react-router';
import { useT } from '../lib/i18n/LocaleProvider';
import { useQuery } from '../lib/useQuery';
import { fmtDateTime } from '../lib/format';
import { readNotifications, groupNotifications, type NotificationRow } from '../lib/notifications';
import { Card, ICON } from './ui';
import { BellDot } from 'lucide-react';

/**
 * The unread notifications, on the control centre.
 *
 * NAMED FOR WHAT THE DATA KNOWS. The plan asked for "what changed since your last visit", and this
 * block deliberately does not claim that, because `notifications.read_at` cannot support it in
 * either direction: someone who opened the bell yesterday and never came here would see nothing,
 * and a two-week-old notice nobody read would be presented as having happened "since your visit".
 * A visit receipt would be a second column answering a question `/alerts` already answers, so the
 * heading is "unread notifications" and it is exactly true. `OPEN-DECISIONS` ש-14 records the
 * literal requirement as still open.
 *
 * READ-ONLY, AND THAT IS THE DIFFERENCE FROM `/alerts`. This block never marks anything read.
 * `/alerts` acknowledges because it shows the rows in full; a summary tile that cleared the bell
 * would clear a count for rows the reader never opened — the exact failure the 26.08.2026 audit
 * repaired there. So the block reads, links, and leaves the acknowledgement to the screen that
 * earns it.
 *
 * ZERO IS NOT RENDERED. An empty block saying "0 unread" is a claim competing with the attention
 * zone above it, which is the screen's real answer to "what needs me". Nothing unread means
 * nothing to say.
 */
export function UnreadAlerts({ userId, className }: { userId: string | null; className?: string }) {
  const { t } = useT();
  const navigate = useNavigate();
  const feed = useQuery<NotificationRow[]>(
    () => (userId ? readNotifications(userId) : Promise.resolve([])),
    [userId],
  );

  /**
   * Frozen at arrival, the same rule `/alerts` follows.
   *
   * `read_at` can change under the reader — the bell in another tab, or `/alerts` opened in one —
   * and a block that emptied itself mid-glance would look like the notices had been dealt with.
   * What was unread when this dashboard loaded stays listed for this visit.
   */
  const unreadOnArrival = useRef<Set<string> | null>(null);
  const groups = feed.data ? groupNotifications(feed.data) : null;
  if (unreadOnArrival.current === null && groups) {
    unreadOnArrival.current = new Set(groups.filter((group) => group.unread > 0).map((group) => group.key));
  }

  /* A failed read says nothing rather than "nothing is waiting" — the same reasoning
     `useUnreadNotifications` gives for the bell. The attention zone above carries the load-bearing
     answer on this screen, so a quiet failure here costs the reader nothing. */
  if (!groups || !unreadOnArrival.current) return null;
  const unread = groups.filter((group) => unreadOnArrival.current?.has(group.key));
  if (unread.length === 0) return null;

  return (
    <section className={className} aria-labelledby="unread-alerts-title">
      <div className="mb-3 flex items-center gap-2">
        <BellDot size={ICON.md} aria-hidden="true" className="text-ink-soft" />
        <h2 id="unread-alerts-title" className="text-base font-semibold text-ink">
          {t('unreadAlerts.title')}
        </h2>
        <span className="badge-info num">{unread.length}</span>
      </div>
      <Card pad={false} clip className="divide-y divide-line-soft">
        {unread.map((group) => (
          <button key={group.key} type="button" onClick={() => navigate(group.latest.target_url)}
            className="flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 py-3 text-start row-hover">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink-body">{group.latest.title}</span>
              <span className="mt-0.5 block text-xs text-ink-muted">
                {group.occurrences > 1
                  ? t('unreadAlerts.sentTimes', {
                    times: group.occurrences,
                    latest: fmtDateTime(new Date(group.latest.created_at)),
                  })
                  : fmtDateTime(new Date(group.latest.created_at))}
              </span>
            </span>
          </button>
        ))}
      </Card>
    </section>
  );
}
