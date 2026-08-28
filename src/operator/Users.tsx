import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ShieldCheck, Users as UsersIcon } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import {
  DataTable, ErrorNote, ICON, Note, PageHeader, SkeletonTable, StatusBadge, ToggleGroup,
  type ServerColumn,
} from '../components/ui';
import { fmtDate } from '../lib/format';
import { ORG_STATUS, ROLE_LABEL } from '../lib/status';
import {
  fetchMyCapabilities, fetchPlatformUsers,
  type PlatformCapability, type PlatformUser, type PlatformUserStatusFilter,
} from '../lib/platform';
import type { Role } from '../lib/types';

const PAGE_SIZE = 25;

const STATUS_FILTERS: { key: string; label: string; value: PlatformUserStatusFilter | null }[] = [
  { key: 'all', label: 'הכול', value: null },
  { key: 'active', label: 'פעילים', value: 'active' },
  { key: 'suspended', label: 'מושהים', value: 'suspended' },
  { key: 'never_signed_in', label: 'לא נכנסו מעולם', value: 'never_signed_in' },
];

// Only the three roles a product account may hold today (0133). A historical `kitchen` or
// `payer` profile still appears in the table — the filter chips are for finding people who
// hold a job, and nobody holds a retired one.
const ROLE_FILTERS: { key: string; label: string; value: Role | null }[] = [
  { key: 'any', label: 'כל התפקידים', value: null },
  { key: 'owner', label: ROLE_LABEL.owner, value: 'owner' },
  { key: 'office', label: ROLE_LABEL.office, value: 'office' },
  { key: 'accountant', label: ROLE_LABEL.accountant, value: 'accountant' },
];

/**
 * The cross-tenant user directory.
 *
 * The screen exists to answer one operator question — "this person says they cannot get in;
 * what is true about their account" — so the columns are exactly the facts that answer it:
 * which customer they belong to, whether the account is active, what it may do, and when it
 * was last used. Anything else belongs on the person's own page.
 */
export default function Users() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  // The status filter is a URL parameter because the dashboard links straight into it. A
  // filter that only lived in component state would make those links land on an unfiltered
  // table and quietly show the wrong answer.
  const statusKey = params.get('status') ?? 'all';
  const [roleKey, setRoleKey] = useState('any');
  const orgId = params.get('org');

  const status = STATUS_FILTERS.find((f) => f.key === statusKey)?.value ?? null;
  const role = ROLE_FILTERS.find((f) => f.key === roleKey)?.value ?? null;

  const { data, loading, fetching, error } = useQuery(
    async () => {
      const [capabilities, users] = await Promise.all([
        fetchMyCapabilities(),
        fetchPlatformUsers({ search, orgId, status, role, page, pageSize: PAGE_SIZE }),
      ]);
      return { capabilities, ...users };
    },
    [search, statusKey, roleKey, orgId, page],
  );

  const capabilities: PlatformCapability[] = data?.capabilities ?? [];

  const columns: ServerColumn<PlatformUser>[] = [
    {
      key: 'name', header: 'משתמש', priority: 3,
      render: (row) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-medium text-ink">
            {row.full_name}
            {row.is_operator && (
              <ShieldCheck size={ICON.sm} aria-label="מפעיל פלטפורמה" className="text-info-fg" />
            )}
          </div>
          {row.email && <div dir="ltr" className="truncate text-xs text-ink-muted">{row.email}</div>}
        </div>
      ),
    },
    {
      key: 'org', header: 'ארגון',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-ink">{row.org_name}</div>
          {row.org_status === 'suspended' && (
            <div className="mt-0.5"><StatusBadge meta={ORG_STATUS.suspended} /></div>
          )}
        </div>
      ),
    },
    {
      key: 'role', header: 'תפקיד',
      render: (row) => ROLE_LABEL[row.role] ?? row.role,
    },
    {
      key: 'access', header: 'גישה', mobileLabel: null, priority: 3,
      render: (row) => (row.active
        ? <span className="badge-done">פעיל</span>
        : <span className="badge-alert">מושהה</span>),
    },
    {
      // Never a zero and never a date that did not happen: an account that was never used says
      // so in words, because "—" alone reads as missing data rather than as a fact.
      key: 'last_sign_in', header: 'כניסה אחרונה',
      render: (row) => (row.last_sign_in_at
        ? fmtDate(row.last_sign_in_at)
        : <span className="text-ink-muted">לא נכנס מעולם</span>),
    },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error) return <ErrorNote message={error} />;

  if (!capabilities.includes('user.view')) {
    return (
      <Note tone="alert">
        <span className="min-w-0 flex-1">
          ספריית המשתמשים פתוחה למפעילים בעלי הרשאת צפייה במשתמשים.
        </span>
      </Note>
    );
  }

  function setStatus(key: string) {
    setPage(0);
    const next = new URLSearchParams(params);
    if (key === 'all') next.delete('status'); else next.set('status', key);
    setParams(next, { replace: true });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={<span className="flex items-center gap-2"><UsersIcon size={ICON.xl} aria-hidden="true" /> משתמשים</span>}
        description="כל המשתמשים בכל הארגונים. חיפוש לפי שם, כתובת דוא״ל או שם ארגון."
      />

      <div className="flex flex-wrap gap-2">
        <ToggleGroup
          items={STATUS_FILTERS.map((f) => ({ key: f.key, label: f.label }))}
          value={statusKey}
          onChange={setStatus}
          label="סינון לפי מצב גישה"
        />
        <ToggleGroup
          items={ROLE_FILTERS.map((f) => ({ key: f.key, label: f.label }))}
          value={roleKey}
          onChange={(key) => { setPage(0); setRoleKey(key); }}
          label="סינון לפי תפקיד"
        />
      </div>

      <DataTable
        rows={data?.rows ?? []}
        columns={columns}
        onRowClick={(row) => navigate(`/admin/users/${row.id}`)}
        mobileTitle={(row) => row.full_name}
        // Without this the phone card dropped the access badge entirely — `access` is a
        // desktop-priority column — and a directory whose whole job is "why can this person not
        // get in" cannot be the one surface that hides whether they are suspended.
        mobileTrailing={(row) => (row.active
          ? <span className="badge-done">פעיל</span>
          : <span className="badge-alert">מושהה</span>)}
        emptyTitle="אין משתמש שתואם את הסינון"
        emptySubtitle="נסה חיפוש אחר או הסר את הסינון"
        server={{
          total: data?.total ?? 0,
          page,
          pageSize: PAGE_SIZE,
          onPageChange: setPage,
          // platform_users() orders by access state and then by age, and takes no sort argument.
          sort: null,
          onSortChange: () => {},
          sortableColumns: new Set<string>(),
          search: { value: search, onChange: (value) => { setPage(0); setSearch(value); } },
          fetching,
        }}
        searchLabel="חיפוש משתמש"
      />
    </div>
  );
}
