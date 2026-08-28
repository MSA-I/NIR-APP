import { Gauge } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import {
  AttentionZone, ErrorNote, ICON, KpiCard, Note, PageHeader, SkeletonCards,
  type AttentionItem,
} from '../components/ui';
import { fmtNum } from '../lib/format';
import {
  fetchMyCapabilities, fetchPlatformOverview,
  type PlatformCapability, type PlatformOverview,
} from '../lib/platform';

/**
 * The console's opening screen, and the only one that is allowed to be a dashboard.
 *
 * The constitution's §12 test applies to the operator exactly as it applies to a tenant owner:
 * a screen that merely displays numbers is an operational screen, not a decision screen. So the
 * attention strip comes first and the counts come second — "which customer has nobody who can
 * administer it" is a thing to go and fix; "we have 41 users" is context.
 *
 * Every figure here is measured. platform_user_overview() returns no row at all to a caller
 * without user.view, which is why `null` and "a row of zeroes" are handled as different
 * situations: the first is a permission answer, the second is a fact about the platform.
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
      key: 'orgs_suspended',
      label: 'ארגונים מושהים',
      count: overview.orgs_suspended,
      tone: 'await',
      to: '/admin/customers',
      clearLabel: 'אין ארגון מושהה',
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

export default function Overview() {
  const { data, loading, error } = useQuery(async () => {
    const [capabilities, overview] = await Promise.all([
      fetchMyCapabilities(),
      fetchPlatformOverview(),
    ]);
    return { capabilities, overview };
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
    <div className="space-y-5">
      <PageHeader
        title={<span className="flex items-center gap-2"><Gauge size={ICON.xl} aria-hidden="true" /> מרכז בקרה</span>}
        description="מה דורש טיפול עכשיו, ומה מצב הפלטפורמה מאחוריו."
      />

      <AttentionZone items={attentionItems(overview)} totalLabel="דורש טיפול" />

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
          tone={overview.users_new_30d > 0 ? 'info' : 'idle'}
        />
        <KpiCard
          title="צוות הפלטפורמה"
          value={fmtNum(overview.operators_total)}
          sub="מפעילים בעלי גישה לקונסולה"
        />
      </div>
    </div>
  );
}
