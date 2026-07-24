import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { RefreshCw, ChevronLeft, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import { useParamState } from '../lib/useParamState';
import { buildSummary, type Summary } from '../lib/summary';
import type { AlertSeverity } from '../lib/alerts';
import { fmtDateTime } from '../lib/format';
import { SkeletonCards, ErrorNote, Note } from '../components/ui';
import { PushSection } from '../components/PushSettings';
import { useAuth } from '../auth/AuthContext';
import { markAllNotificationsRead } from '../lib/notifications';

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
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { data, loading, fetching, error, refetch } = useQuery<Summary>(() => buildSummary(), []);
  const [sevFilter, setSevFilter] = useParamState('severity');

  // Opening the canonical alerts screen acknowledges everything delivered to the bell.
  // Wait for a successful load so a network failure never clears unseen work.
  useEffect(() => {
    if (data?.complete && !fetching && !error && profile) void markAllNotificationsRead(profile.id);
  }, [data, fetching, error, profile]);

  if (loading) return <SkeletonCards count={5} cols={5} title />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return null;

  const SEV_ORDER: AlertSeverity[] = ['critical', 'warning', 'info'];
  const present = SEV_ORDER.filter((s) => data.alerts.some((a) => a.severity === s));
  const shown = sevFilter ? data.alerts.filter((a) => a.severity === sevFilter) : data.alerts;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="page-title">התראות</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            נבדק {fmtDateTime(data.generatedAt)}{fetching ? ' · מתעדכן כעת' : ''}
          </p>
        </div>
        <button className="btn-secondary" onClick={() => void refetch()} disabled={fetching}>
          <RefreshCw size={15} className={fetching ? 'animate-spin' : ''} />
          רענון
        </button>
      </div>

      {(error || !data.complete) && (
        <Note tone="alert">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <span>
            {error ?? `הסריקה חלקית: ${data.failures.map((failure) => failure.label).join(', ')}. הממצאים שכן נטענו מוצגים, אך אי אפשר לקבוע שהכול תקין.`}
          </span>
        </Note>
      )}

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="section-title">דורש טיפול</h2>
          {present.length > 1 && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="סינון התראות לפי סוג">
              <button type="button" onClick={() => setSevFilter('')} aria-pressed={!sevFilter}
                className={`${!sevFilter ? 'badge-info' : 'badge-idle'} cursor-pointer`}>הכל</button>
              {present.map((s) => (
                <button key={s} type="button" onClick={() => setSevFilter(s)} aria-pressed={sevFilter === s}
                  className={`${sevFilter === s ? SEVERITY_BADGE[s] : 'badge-idle'} cursor-pointer`}>
                  {SEVERITY_LABEL[s]}
                </button>
              ))}
            </div>
          )}
        </div>
        {data.complete && data.alerts.length === 0 ? (
          // Deliberately not a row of zeros: "nothing found" is a different statement from
          // "we measured seven things and they were all zero", and only the first is true.
          <div className="card card-pad flex items-center gap-3 text-sm text-ink-soft">
            <ShieldCheck size={18} className="text-done-solid shrink-0" />
            לא נמצאו התראות פתוחות בבדיקות שהמערכת יודעת להריץ.
          </div>
        ) : shown.length > 0 ? (
          <div className="card divide-y divide-line-soft overflow-hidden">
            {shown.map((a) => (
              <button key={a.code} onClick={() => navigate(a.to)}
                className="w-full text-start flex items-center gap-3 px-4 py-3 row-hover cursor-pointer">
                <span className={`${SEVERITY_BADGE[a.severity]} shrink-0`}>{SEVERITY_LABEL[a.severity]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink-body">{a.title}</span>
                  <span className="block text-xs text-ink-muted mt-0.5">{a.detail}</span>
                </span>
                <ChevronLeft size={16} className="text-ink-ghost shrink-0" />
              </button>
            ))}
          </div>
        ) : data.alerts.length > 0 ? (
          <div className="card card-pad text-sm text-ink-soft">
            אין התראות מסוג זה. <button type="button" className="text-action underline" onClick={() => setSevFilter('')}>הצג הכל</button>
          </div>
        ) : (
          <div className="card card-pad text-sm text-ink-soft">
            הסריקה לא הושלמה, ולכן אין אפשרות לקבוע שאין התראות פתוחות.
          </div>
        )}
      </div>

      {/* Naming what is not covered belongs on the screen, not only in the docs: a manager
          who reads this page as complete would stop looking elsewhere. */}
      <p className="text-xs text-ink-muted leading-relaxed">
        אינו נבדק: מלאי נמוך (אין מעקב כמויות במערכת) · חריגה בתקציב (לא הוגדר תקציב).
        מועדי פירעון נבדקים רק על דרישות תשלום שהוזן להן תאריך.
      </p>

      {/* Canonical per-device notification setting: /alerts is available to owner and office. */}
      <PushSection />
    </div>
  );
}
