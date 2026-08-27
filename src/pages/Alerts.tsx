import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { useNavigate } from 'react-router';
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

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: 'דחוף',
  warning: 'לטיפול',
  info: 'מידע',
};

export default function Alerts() {
  const { t, tDynamic } = useT();
  const navigate = useNavigate();
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

  const SEV_ORDER: AlertSeverity[] = ['critical', 'warning', 'info'];
  const present = SEV_ORDER.filter((s) => data.alerts.some((a) => a.severity === s));
  const shown = sevFilter ? data.alerts.filter((a) => a.severity === sevFilter) : data.alerts;

  return (
    <div className="space-y-5">
      <PageHeader title="התראות" meta={
          <span>
            נבדק {fmtDateTime(data.generatedAt)}{fetching ? ' · מתעדכן כעת' : ''}
          </span>
        } actions={<button className="btn-secondary" onClick={() => void refetch()} disabled={fetching}>
          {/* One refresh mark for the whole product: RefreshCw at ICON.sm, spinning while the
              view is refetching, label unchanged. The busy state stays INSIDE the button
              (DESIGN.md:554) instead of only greying it out. */}
              <RefreshCw size={ICON.sm} aria-hidden="true" className={fetching ? 'animate-spin ' : ''} />
          רענון
        </button>} />

      {(error || !data.complete) && (
        <Note tone="alert">
          <TriangleAlert size={ICON.sm} className="mt-0.5 shrink-0" />
          <span>
            {error ?? t('alertsPage.partialScan', { scans: data.failures.map((failure) => tDynamic(failure.labelKey) ?? failure.labelKey).join(', ') })}
          </span>
        </Note>
      )}

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="section-title">דורש טיפול</h2>
          {present.length > 1 && (
            /* Was a BADGE wearing `cursor-pointer` — no height floor, no focus ring, and the
               pressed chip took its colour from severity, so the control changed shape as well
               as state. ToggleGroup is the one pick-one-of-N control; severity colour still
               rides the row badge below, where it describes an alert rather than a filter. */
            <ToggleGroup<string>
              label="סינון התראות לפי סוג"
              value={sevFilter}
              onChange={setSevFilter}
              className="gap-1"
              items={[{ key: '', label: 'הכל' }, ...present.map((s) => ({ key: s as string, label: SEVERITY_LABEL[s] }))]} />
          )}
        </div>
        {data.complete && data.alerts.length === 0 ? (
          // Deliberately not a row of zeros: "nothing found" is a different statement from
          // "we measured seven things and they were all zero", and only the first is true.
          <Card pad={false}>
            <EmptyState
              icon={<ShieldCheck size={ICON.hero} className="text-done-fg" />}
              title="לא נמצאו התראות פתוחות"
              subtitle="בבדיקות שהמערכת יודעת להריץ לא נמצאה התראה פתוחה." />
          </Card>
        ) : shown.length > 0 ? (
          <Card pad={false} clip className="divide-y divide-line-soft">
            {shown.map((a) => (
              <button key={a.code} onClick={() => navigate(a.to)}
                className="w-full text-start flex items-center gap-3 px-4 py-3 row-hover cursor-pointer">
                <span className={`${SEVERITY_BADGE[a.severity]} shrink-0`}>{SEVERITY_LABEL[a.severity]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink-body">{t(a.title.key as TKey, a.title.vars)}</span>
                  <span className="block text-xs text-ink-muted mt-0.5">{t(a.detail.key as TKey, a.detail.vars)}</span>
                </span>
                <ChevronLeft size={ICON.sm} className="text-ink-ghost shrink-0" aria-hidden="true" />
              </button>
            ))}
          </Card>
        ) : data.alerts.length > 0 ? (
          <Card pad={false}>
            <EmptyState title="אין התראות מסוג זה"
              action={<button type="button" className="btn-secondary" onClick={() => setSevFilter('')}>הצג הכל</button>} />
          </Card>
        ) : (
          <Card pad={false}>
            <EmptyState
              icon={<TriangleAlert size={ICON.hero} className="text-await-fg" />}
              title="הסריקה לא הושלמה"
              subtitle="ולכן אין אפשרות לקבוע שאין התראות פתוחות." />
          </Card>
        )}
      </div>

      {/* Naming what is not covered belongs on the screen, not only in the docs: a manager
          who reads this page as complete would stop looking elsewhere. */}
      <p className="text-xs text-ink-muted leading-relaxed">
        אינו נבדק: מלאי נמוך (אין מעקב כמויות במערכת) · חריגה בתקציב (לא הוגדר תקציב).
        מועדי פירעון נבדקים רק על דרישות תשלום שהוזן להן תאריך.
      </p>

      {/* WHAT THE BELL COUNTED. Until 26.08.2026 the bell's number and this screen described two
          different catalogues — the number came from delivered `notifications` rows, the list above
          from a live scan — and the rows themselves were rendered nowhere in the product. So a
          count of 23 opened a page that mentioned none of them and then cleared the number. */}
      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="section-title">נשלח אליך</h2>
          {/* The cap is honest only because the screen prints it, and the grouping only because
              the screen prints how many times each condition was announced. */}
          <span className="text-xs text-ink-muted">
            {`עד ${NOTIFICATION_FEED_LIMIT} ההודעות האחרונות לחשבון הזה, מקובצות לפי הנושא`}
          </span>
        </div>
        {feed.loading ? (
          <SkeletonCards count={3} cols={3} />
        ) : feed.error ? (
          <ErrorNote message={feed.error} />
        ) : feedGroups && feedGroups.length > 0 ? (
          <Card pad={false} clip className="divide-y divide-line-soft">
            {feedGroups.map((group) => (
              <button key={group.key} onClick={() => navigate(group.latest.target_url)}
                className="w-full text-start flex items-center gap-3 px-4 py-3 row-hover cursor-pointer">
                <span className={`${SEVERITY_BADGE[group.latest.severity]} shrink-0`}>
                  {SEVERITY_LABEL[group.latest.severity]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink-body">
                    {group.latest.title}
                    {/* Frozen at arrival — see `newOnArrival`. Without it the mark would vanish
                        mid-read, the moment the acknowledgement lands. */}
                    {newOnArrival.current?.has(group.key) && <span className="badge-info ms-2 align-middle">חדש</span>}
                  </span>
                  <span className="block text-xs text-ink-muted mt-0.5">{group.latest.body}</span>
                  <span className="block text-xs text-ink-muted mt-0.5">
                    {group.occurrences > 1
                      ? `נשלחה ${group.occurrences} פעמים · האחרונה ${fmtDateTime(new Date(group.latest.created_at))}`
                      : fmtDateTime(new Date(group.latest.created_at))}
                  </span>
                </span>
                <ChevronLeft size={ICON.sm} className="text-ink-ghost shrink-0" aria-hidden="true" />
              </button>
            ))}
          </Card>
        ) : (
          <Card pad={false}>
            <EmptyState
              icon={<BellOff size={ICON.hero} className="text-ink-ghost" />}
              title="לא נשלחו אליך הודעות"
              subtitle="הודעות נשלחות על חשד לכפילות, על מועד פירעון, על עליית מחיר במחירון ועל עיבוד מסמכים שנעצר." />
          </Card>
        )}
      </div>

      {/* Canonical per-device notification setting: /alerts is available to owner and office. */}
      <PushSection />
    </div>
  );
}
