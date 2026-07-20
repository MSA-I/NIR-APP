import { useNavigate } from 'react-router-dom';
import { RefreshCw, ChevronLeft, ShieldCheck } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import { buildSummary, type Summary, type SummaryLine } from '../lib/summary';
import type { AlertSeverity } from '../lib/alerts';
import { fmtMoney, fmtNum, fmtDateTime } from '../lib/format';
import { SkeletonCards, ErrorNote, EmptyState } from '../components/ui';

/**
 * סעיף 9 (התראות) + סעיף 10 (סיכום עסקי) on one screen, because they answer the same
 * question from two directions: what is true right now, and what about it needs a decision.
 *
 * Severity maps onto the existing badge- classes rather than raw colours. The colour
 * language (סעיף 6) is still being settled; when those class definitions change in
 * index.css this screen follows without being touched.
 */

const SEVERITY_BADGE: Record<AlertSeverity, string> = {
  critical: 'badge-red',
  warning: 'badge-amber',
  info: 'badge-blue',
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: 'דחוף',
  warning: 'לטיפול',
  info: 'מידע',
};

function Figure({ line, onClick }: { line: SummaryLine; onClick: () => void }) {
  return (
    <button onClick={onClick} className="card card-pad text-start w-full hover:border-indigo-300 hover:shadow transition-all cursor-pointer">
      <div className="text-xs font-medium text-slate-500">{line.label}</div>
      <div className="text-xl font-bold text-slate-900 mt-1 num">
        {line.unit === 'currency' ? fmtMoney(line.value) : fmtNum(line.value)}
      </div>
    </button>
  );
}

export default function Alerts() {
  const navigate = useNavigate();
  const { data, loading, fetching, error, refetch } = useQuery<Summary>(() => buildSummary(), []);

  if (loading) return <SkeletonCards count={5} cols={5} title />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="page-title">התראות וסיכום עסקי</h1>
          <p className="text-xs text-slate-400 mt-0.5">נבדק {fmtDateTime(data.generatedAt)}</p>
        </div>
        <button className="btn-secondary" onClick={() => void refetch()} disabled={fetching}>
          <RefreshCw size={15} className={fetching ? 'animate-spin' : ''} />
          רענון
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        {data.lines.map((l) => <Figure key={l.key} line={l} onClick={() => navigate(l.to)} />)}
      </div>

      <div>
        <h2 className="section-title mb-2">דורש טיפול</h2>
        {data.alerts.length === 0 ? (
          // Deliberately not a row of zeros: "nothing found" is a different statement from
          // "we measured seven things and they were all zero", and only the first is true.
          <div className="card card-pad flex items-center gap-3 text-sm text-slate-600">
            <ShieldCheck size={18} className="text-emerald-600 shrink-0" />
            לא נמצאו התראות פתוחות בבדיקות שהמערכת יודעת להריץ.
          </div>
        ) : (
          <div className="card divide-y divide-slate-100 overflow-hidden">
            {data.alerts.map((a) => (
              <button key={a.code} onClick={() => navigate(a.to)}
                className="w-full text-start flex items-center gap-3 px-4 py-3 hover:bg-indigo-50/40 cursor-pointer">
                <span className={`${SEVERITY_BADGE[a.severity]} shrink-0`}>{SEVERITY_LABEL[a.severity]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-800">{a.title}</span>
                  <span className="block text-xs text-slate-500 mt-0.5">{a.detail}</span>
                </span>
                <ChevronLeft size={16} className="text-slate-300 shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Naming what is not covered belongs on the screen, not only in the docs: a manager
          who reads this page as complete would stop looking elsewhere. */}
      <p className="text-xs text-slate-400 leading-relaxed">
        אינו נבדק: מלאי נמוך (אין מעקב כמויות במערכת) · חריגה בתקציב (לא הוגדר תקציב).
        מועדי פירעון נבדקים רק על דרישות תשלום שהוזן להן תאריך.
      </p>

      {data.alerts.length === 0 && data.lines.every((l) => l.value === 0) && (
        <EmptyState title="אין עדיין נתונים במערכת" subtitle="ההתראות יופיעו כשייקלטו חשבוניות, מחירונים והזמנות" />
      )}
    </div>
  );
}
