import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { Link } from 'react-router';
import { useEffect, useRef } from 'react';
import { RefreshCw, ChevronLeft, ShieldCheck, TriangleAlert, BellOff } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import { useParamState } from '../lib/useParamState';
import { buildSummary, type Summary } from '../lib/summary';
import type { AlertSeverity } from '../lib/alerts';
import { fmtDateTime } from '../lib/format';
import { SkeletonCards, ErrorNote, Note, PageHeader, Card, EmptyState, ToggleGroup, ICON } from '../components/ui';
import { PushSection } from '../components/PushSettings';
import { useAuth } from '../auth/AuthContext';
import {
  markAllNotificationsRead, readNotifications, groupNotifications,
  NOTIFICATION_FEED_LIMIT, type NotificationRow,
} from '../lib/notifications';

/** Full actionable queue. The dashboard owns the business summary and links here for detail. */

const SEVERITY_BADGE: Record<AlertSeverity, string> = {
  critical: 'badge-alert',
  warning: 'badge-await',
  info: 'badge-info',
};

const SEVERITY_KEY: Record<AlertSeverity, TKey> = {
  critical: 'alerts.severityCritical',
  warning: 'alerts.severityWarning',
  info: 'alerts.severityInfo',
};

export default function Alerts() {
  const { t, tDynamic } = useT();
  const { profile } = useAuth();
  const { data, loading, fetching, error, refetch } = useQuery<Summary>(() => buildSummary(), []);
  const [sevFilter, setSevFilter] = useParamState('severity');
  const userId = profile?.id ?? null;
  /* The delivered notifications — what the BELL counted. Separate query on purpose: it answers a
     different question from `buildSummary()` (what was sent to me, vs what is true right now), it
     must not be able to blank the scan when it fails, and the scan must not be able to hide it. */
  const feed = useQuery<NotificationRow[]>(
    () => (userId ? readNotifications(userId) : Promise.resolve([])),
    [userId],
  );

  const feedGroups = feed.data ? groupNotifications(feed.data) : null;
  /* WHAT WAS NEW WHEN THIS VISIT STARTED, frozen once. The rows are marked read a moment after
     they render, so reading `read_at` live would erase the marking under the reader's eyes. */
  const newOnArrival = useRef<Set<string> | null>(null);
  if (newOnArrival.current === null && feedGroups) {
    newOnArrival.current = new Set(feedGroups.filter((group) => group.unread > 0).map((group) => group.key));
  }

  /* Acknowledging is gated on the FEED, not on the scan (26.08.2026 audit).
     It used to fire on `data.complete` — a successful *summary* load — so the count was cleared by
     a screen that had not displayed a single one of the rows it was clearing. Now the receipt says
     what actually happened: these rows were put on screen, therefore they are read. A feed that
     failed to load clears nothing. */
  useEffect(() => {
    if (!userId || feed.loading || feed.fetching || feed.error || !feed.data) return;
    if (!feed.data.some((row) => row.read_at === null)) return;
    void markAllNotificationsRead(userId);
  }, [userId, feed.data, feed.loading, feed.fetching, feed.error]);

  if (loading) return <SkeletonCards count={5} cols={5} title />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return null;

  /* Decision F (owner, 03.09.2026): "nothing is owed" is a SENTENCE, not a number.
     It used to arrive here as a named failure — the currency-less measured zero the summary RPC
     returns when there is nothing open was filtered out upstream and reported as unmeasured — so
     this page painted the red bar below over a perfectly healthy organisation. It is stated in
     the same place now, in the register it deserves: no figure, no `—` (this product reserves
     that for UNKNOWN), and no alert colour. */
  const statedAbsences = data.lines
    .map((line) => (line.state === 'absent' ? line.absenceKey : undefined))
    .filter((key): key is TKey => key !== undefined);

  const SEV_ORDER: AlertSeverity[] = ['critical', 'warning', 'info'];
  const present = SEV_ORDER.filter((s) => data.alerts.some((a) => a.severity === s));
  const shown = sevFilter ? data.alerts.filter((a) => a.severity === sevFilter) : data.alerts;

  return (
    <div className="space-y-5">
      <PageHeader title={t('alerts.title')} meta={
          <span>
            {t('alerts.checkedAt', { at: fmtDateTime(data.generatedAt) })}{fetching ? t('alerts.fmtDateTime') : ''}
          </span>
        } actions={<button className="btn-secondary" onClick={() => void refetch()} disabled={fetching}>
          {/* One refresh mark for the whole product: RefreshCw at ICON.sm, spinning while the
              view is refetching, label unchanged. The busy state stays INSIDE the button
              (DESIGN.md:554) instead of only greying it out. */}
              <RefreshCw size={ICON.sm} aria-hidden="true" className={fetching ? 'animate-spin ' : ''} />
          {t('alerts.text')}
        </button>} />

      {(error || !data.complete) && (
        <Note tone="alert">
          <TriangleAlert size={ICON.sm} className="mt-0.5 shrink-0" />
          <span>
            {error ?? t('alertsPage.partialScan', { scans: data.failures.map((failure) => tDynamic(failure.labelKey, failure.labelVars) ?? failure.labelKey).join(', ') })}
          </span>
        </Note>
      )}

      {statedAbsences.length > 0 && (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
          {statedAbsences.map((key) => <li key={key}>{t(key)}</li>)}
        </ul>
      )}

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="section-title">{t('alerts.text_2')}</h2>
          {present.length > 1 && (
            /* Was a BADGE wearing `cursor-pointer` — no height floor, no focus ring, and the
               pressed chip took its colour from severity, so the control changed shape as well
               as state. ToggleGroup is the one pick-one-of-N control; severity colour still
               rides the row badge below, where it describes an alert rather than a filter. */
            <ToggleGroup<string>
              label={t('alerts.label')}
              value={sevFilter}
              onChange={setSevFilter}
              className="gap-1"
              items={[{ key: '', label: t('alerts.map') }, ...present.map((s) => ({ key: s as string, label: t(SEVERITY_KEY[s]) }))]} />
          )}
        </div>
        {data.complete && data.alerts.length === 0 ? (
          // Deliberately not a row of zeros: "nothing found" is a different statement from
          // "we measured seven things and they were all zero", and only the first is true.
          <Card pad={false}>
            <EmptyState
              icon={<ShieldCheck size={ICON.hero} className="text-done-fg" />}
              title={t('alerts.title_2')}
              subtitle={t('alerts.subtitle')} />
          </Card>
        ) : shown.length > 0 ? (
          <Card pad={false} clip className="divide-y divide-line-soft">
            {/* `DASH-12`: real <Link>s, not buttons wearing an onClick. This is the screen the
                manager is told to work THROUGH, and a button has no href — so middle-click,
                ⌘/Ctrl-click, "open in new tab" and the hover status bar are all absent, and the
                queue can only be walked one item at a time, losing the page on every step. The
                dashboard's own attention rows already decided this for rows pointing at the same
                routes, and `ui.tsx` says so in as many words. */}
            {shown.map((a) => (
              <Link key={a.code} to={a.to}
                className="w-full text-start flex items-center gap-3 px-4 py-3 row-hover cursor-pointer">
                <span className={`${SEVERITY_BADGE[a.severity]} shrink-0`}>{t(SEVERITY_KEY[a.severity])}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink-body">{t(a.title.key as TKey, a.title.vars)}</span>
                  <span className="block text-xs text-ink-muted mt-0.5">{t(a.detail.key as TKey, a.detail.vars)}</span>
                </span>
                <ChevronLeft size={ICON.sm} className="text-ink-ghost shrink-0" aria-hidden="true" />
              </Link>
            ))}
          </Card>
        ) : data.alerts.length > 0 ? (
          <Card pad={false}>
            <EmptyState title={t('alerts.title_3')}
              action={<button type="button" className="btn-secondary" onClick={() => setSevFilter('')}>{t('alerts.setSevFilter')}</button>} />
          </Card>
        ) : (
          <Card pad={false}>
            <EmptyState
              icon={<TriangleAlert size={ICON.hero} className="text-await-fg" />}
              title={t('alerts.title_4')}
              subtitle={t('alerts.subtitle_2')} />
          </Card>
        )}
      </div>

      {/* Naming what is not covered belongs on the screen, not only in the docs: a manager
          who reads this page as complete would stop looking elsewhere. */}
      <p className="text-xs text-ink-muted leading-relaxed">
        {t('alerts.text_3')}{' '}
        {t('alerts.text_4')}
      </p>

      {/* WHAT THE BELL COUNTED. Until 26.08.2026 the bell's number and this screen described two
          different catalogues — the number came from delivered `notifications` rows, the list above
          from a live scan — and the rows themselves were rendered nowhere in the product. So a
          count of 23 opened a page that mentioned none of them and then cleared the number. */}
      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="section-title">{t('alerts.text_5')}</h2>
          {/* The cap is honest only because the screen prints it, and the grouping only because
              the screen prints how many times each condition was announced. */}
          <span className="text-xs text-ink-muted">
            {t('alerts.feedLimitNote', { limit: NOTIFICATION_FEED_LIMIT })}
          </span>
        </div>
        {feed.loading ? (
          <SkeletonCards count={3} cols={3} />
        ) : feed.error ? (
          <ErrorNote message={feed.error} />
        ) : feedGroups && feedGroups.length > 0 ? (
          <Card pad={false} clip className="divide-y divide-line-soft">
            {/* Same change, same reason, and safe to put in an href: `target_url` is refused at
                write time unless it is a same-origin path — `0024:82-84`, `0068:255-257` and the
                push twin beside it all reject an empty value, one that does not begin with `/`,
                and one that begins with `//`. So the anchor cannot be pointed off-site by a row. */}
            {feedGroups.map((group) => (
              <Link key={group.key} to={group.latest.target_url}
                className="w-full text-start flex items-center gap-3 px-4 py-3 row-hover cursor-pointer">
                <span className={`${SEVERITY_BADGE[group.latest.severity]} shrink-0`}>
                  {t(SEVERITY_KEY[group.latest.severity])}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink-body">
                    {group.latest.title}
                    {/* Frozen at arrival — see `newOnArrival`. Without it the mark would vanish
                        mid-read, the moment the acknowledgement lands. */}
                    {newOnArrival.current?.has(group.key) && <span className="badge-info ms-2 align-middle">{t('alerts.has')}</span>}
                  </span>
                  <span className="block text-xs text-ink-muted mt-0.5">{group.latest.body}</span>
                  <span className="block text-xs text-ink-muted mt-0.5">
                    {group.occurrences > 1
                      ? t('alerts.sentTimes', {
                        times: group.occurrences,
                        latest: fmtDateTime(new Date(group.latest.created_at)),
                      })
                      : fmtDateTime(new Date(group.latest.created_at))}
                  </span>
                </span>
                <ChevronLeft size={ICON.sm} className="text-ink-ghost shrink-0" aria-hidden="true" />
              </Link>
            ))}
          </Card>
        ) : (
          <Card pad={false}>
            <EmptyState
              icon={<BellOff size={ICON.hero} className="text-ink-ghost" />}
              title={t('alerts.title_5')}
              subtitle={t('alerts.subtitle_3')} />
          </Card>
        )}
      </div>

      {/* Canonical per-device notification setting: /alerts is available to owner and office. */}
      <PushSection />
    </div>
  );
}
