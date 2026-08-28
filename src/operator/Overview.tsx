import { Link } from 'react-router';
import { ArrowUpLeft } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import {
  AttentionZone, ErrorNote, ICON, KpiCard, Note, PageHeader, SkeletonCards,
  type AttentionItem,
} from '../components/ui';
import { fmtNum } from '../lib/format';
import {
  fetchMyCapabilities, fetchPlatformOperators, fetchPlatformOverview, fetchPlatformRoles,
  type PlatformCapability, type PlatformOperator, type PlatformOverview, type PlatformRole,
} from '../lib/platform';

/**
 * The console's opening screen, and the only one allowed to be a dashboard.
 *
 * The constitution's §12 test applies to an operator exactly as it applies to a tenant owner: a
 * screen that merely displays numbers is an operational screen, not a decision screen. So it
 * carries the tenant control centre's anatomy rather than a grid of tiles — the state band first
 * at every width (DESIGN.md "Dashboard — פס הכסף": a manager who opens the product sees state,
 * not only a task list), then the attention card beside the one Onyx surface of the screen.
 *
 * Every figure is measured. `platform_user_overview()` returns no row at all to a caller without
 * `user.view`, which is why `null` and "a row of zeroes" are handled as different situations: the
 * first is a permission answer, the second is a fact about the platform.
 */

function attentionItems(overview: PlatformOverview): AttentionItem[] {
  return [
    {
      key: 'orgs_without_owner',
      label: 'ארגונים ללא בעלים פעיל',
      count: overview.orgs_without_owner,
      tone: 'alert',
      to: '/admin/customers',
      hint: 'אף אחד בארגון אינו יכול לנהל אותו — כולל הזמנת משתמשים ואישור תשלומים',
      clearLabel: 'לכל ארגון יש בעלים פעיל',
    },
    {
      key: 'operators_without_role',
      label: 'מפעילים ללא תפקיד',
      count: overview.operators_without_role,
      tone: 'alert',
      to: '/admin/team',
      hint: 'חברות בצוות בלי אף הרשאה — הקונסולה תיראה להם ריקה',
      clearLabel: 'לכל מפעיל יש תפקיד',
    },
    {
      key: 'users_suspended',
      label: 'משתמשים מושהים',
      count: overview.users_suspended,
      tone: 'await',
      to: '/admin/users?status=suspended',
      clearLabel: 'אין משתמש מושהה',
    },
    {
      key: 'users_never_signed_in',
      label: 'משתמשים שמעולם לא נכנסו',
      count: overview.users_never_signed_in,
      tone: 'info',
      to: '/admin/users?status=never_signed_in',
      hint: 'חשבון שנפתח ולא נעשה בו שימוש — לרוב הזמנה שלא הושלמה',
      clearLabel: 'כל המשתמשים נכנסו לפחות פעם אחת',
    },
    {
      key: 'users_dormant_30d',
      label: 'משתמשים ללא כניסה 30 יום',
      count: overview.users_dormant_30d,
      tone: 'info',
      to: '/admin/users',
      clearLabel: 'כל המשתמשים נכנסו החודש',
    },
  ];
}

/**
 * The screen's single Onyx surface, in the slot and the shape the tenant control centre gives
 * "משימות לפי תפקיד": hero number, queue rows with count chips, and the reference's corner
 * circle-chip to the full list. Here the queue is our own roster, by the authority each person
 * holds — the one thing on this screen that is about us rather than about customers.
 */
function TeamCard({ operators, roles, className = '' }: {
  operators: PlatformOperator[];
  roles: PlatformRole[];
  className?: string;
}) {
  const rows = roles
    .map((role) => ({
      key: role.role_key,
      label: role.label,
      count: operators.filter((operator) => operator.roles.includes(role.role_key)).length,
    }))
    .filter((row) => row.count > 0);
  const unassigned = operators.filter((operator) => operator.roles.length === 0).length;

  return (
    <section aria-labelledby="operator-roster-title"
      className={`relative rounded-3xl bg-shell p-4 text-shell-ink shadow-dashboard sm:p-5 ${className}`}>
      <Link to="/admin/team" aria-label="לניהול צוות הפלטפורמה"
        className="group absolute end-3 top-3 grid size-11 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        <span className="grid size-9 place-items-center rounded-full bg-shell-ink/10 text-shell-ink transition-colors group-hover:bg-shell-ink/20">
          <ArrowUpLeft size={ICON.sm} aria-hidden="true" />
        </span>
      </Link>
      <h2 id="operator-roster-title" className="section-title pe-16 text-shell-ink">צוות הפלטפורמה</h2>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="kpi-hero num text-shell-ink">{operators.length}</span>
        <span className="text-xs text-shell-ink-dim">מפעילים בעלי גישה לקונסולה</span>
      </div>
      <ul className="mt-3 space-y-0.5 text-sm">
        {rows.map((row) => (
          <li key={row.key} className="flex min-h-11 items-center gap-3 px-0 py-1.5 text-shell-ink-soft">
            <span className="min-w-0 flex-1 leading-snug">{row.label}</span>
            <span className="badge num min-w-8 shrink-0 justify-center bg-action-soft text-action-on-soft">
              {row.count}
            </span>
          </li>
        ))}
        {unassigned > 0 && (
          <li className="flex min-h-11 items-center gap-3 py-1.5 text-shell-ink-soft">
            <span className="min-w-0 flex-1 leading-snug">ללא תפקיד</span>
            <span className="badge num min-w-8 shrink-0 justify-center bg-action-soft text-action-on-soft">
              {unassigned}
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}

export default function Overview() {
  const { data, loading, error } = useQuery(async () => {
    const [capabilities, overview, operators, roles] = await Promise.all([
      fetchMyCapabilities(),
      fetchPlatformOverview(),
      fetchPlatformOperators(),
      fetchPlatformRoles(),
    ]);
    return { capabilities, overview, operators, roles };
  }, []);

  if (loading) return <SkeletonCards count={4} />;
  if (error) return <ErrorNote message={error} />;

  const capabilities: PlatformCapability[] = data?.capabilities ?? [];
  const overview = data?.overview ?? null;

  // An operator can hold membership without user.view, and the read answers such a caller with
  // zero rows rather than an error. An empty dashboard would then say "the platform is empty",
  // which is a different claim entirely.
  if (!capabilities.includes('user.view') || !overview) {
    return (
      <Note tone="alert">
        <span className="min-w-0 flex-1">
          מרכז הבקרה פתוח למפעילים בעלי הרשאת צפייה במשתמשים. ההרשאה מוקצית במסך „צוות הפלטפורמה".
        </span>
      </Note>
    );
  }

  return (
    // `dashboard-depth` is the one named elevation exception (DESIGN.md §4): inside the control
    // centre a card carries `shadow-dashboard`, and the scope stays framed so operational cards
    // elsewhere in the product are untouched.
    <div className="dashboard-depth flex flex-col gap-5">
      <PageHeader
        title="מרכז בקרה"
        description="מה דורש טיפול עכשיו, ומה מצב הפלטפורמה מאחוריו."
      />

      {/* The state band, first at every width. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          title="ארגונים פעילים"
          value={fmtNum(overview.orgs_active)}
          sub={`מתוך ${fmtNum(overview.orgs_total)} ארגונים`}
        />
        <KpiCard
          title="משתמשים פעילים"
          value={fmtNum(overview.users_active)}
          sub={`מתוך ${fmtNum(overview.users_total)} משתמשים`}
        />
        <KpiCard
          title="משתמשים חדשים"
          value={fmtNum(overview.users_new_30d)}
          sub="נפתחו ב-30 הימים האחרונים"
        />
        <KpiCard
          title="ארגונים מושהים"
          value={fmtNum(overview.orgs_suspended)}
          sub="הגישה שלהם חסומה"
          tone={overview.orgs_suspended > 0 ? 'await' : 'idle'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <AttentionZone
          className="lg:col-span-7"
          items={attentionItems(overview)}
          totalLabel="דורש טיפול"
        />
        <TeamCard
          className="lg:col-span-5"
          operators={data?.operators ?? []}
          roles={data?.roles ?? []}
        />
      </div>
    </div>
  );
}
