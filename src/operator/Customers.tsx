import { useState } from 'react';
import { Building2, PauseCircle, PlayCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import {
  DataTable, ErrorNote, Note, SkeletonTable, StatusBadge, ConfirmDialog, useToast,
  type ServerColumn,
} from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { fmtDate, fmtNum } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import { ORG_STATUS } from '../lib/status';
import {
  fetchMyCapabilities, fetchPlatformCustomers,
  type CustomerAttention, type PlatformCapability, type PlatformCustomer,
} from '../lib/platform';
import type { OrgStatus } from '../lib/types';

const PAGE_SIZE = 25;

/** The open offboarding states. `cancelled` and `reactivated` are closed outcomes, so a customer
    carrying one of those is not in an offboarding process any more. */
const OPEN_OFFBOARDING = new Set([
  'requested', 'approved', 'export_building', 'export_ready', 'export_failed',
]);

const OFFBOARDING_LABEL: Record<string, string> = {
  requested: 'ביקש סיום שירות',
  approved: 'סיום שירות אושר',
  export_building: 'ייצוא בהכנה',
  export_ready: 'ייצוא מוכן',
  export_failed: 'ייצוא נכשל',
};

const STATUS_FILTERS: { key: string; label: string; value: OrgStatus[] }[] = [
  { key: 'all', label: 'הכול', value: [] },
  { key: 'active', label: 'פעילים', value: ['active'] },
  { key: 'suspended', label: 'מושהים', value: ['suspended'] },
];

const ATTENTION_FILTERS: { key: string; label: string; value: CustomerAttention | null }[] = [
  { key: 'none', label: 'ללא סינון', value: null },
  { key: 'offboarding', label: 'בתהליך סיום שירות', value: 'offboarding' },
  { key: 'no_users', label: 'ללא משתמשים פעילים', value: 'no_users' },
  { key: 'dormant', label: 'ללא פעילות 30 יום', value: 'dormant' },
];

export default function Customers() {
  const toast = useToast();
  const [statusKey, setStatusKey] = useState('all');
  const [attentionKey, setAttentionKey] = useState('none');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState<{
    customer: PlatformCustomer; action: 'suspend' | 'reactivate'; reason?: string;
  } | null>(null);
  const [reauth, setReauth] = useState(false);
  const [busy, setBusy] = useState(false);

  const status = STATUS_FILTERS.find((filter) => filter.key === statusKey)?.value ?? [];
  const attention = ATTENTION_FILTERS.find((filter) => filter.key === attentionKey)?.value ?? null;

  const { data, loading, fetching, error, refetch } = useQuery(
    async () => {
      const [capabilities, customers] = await Promise.all([
        fetchMyCapabilities(),
        fetchPlatformCustomers({ search, status, attention, page, pageSize: PAGE_SIZE }),
      ]);
      return { capabilities, ...customers };
    },
    [search, statusKey, attentionKey, page],
  );

  const capabilities: PlatformCapability[] = data?.capabilities ?? [];
  const may = (capability: PlatformCapability) => capabilities.includes(capability);

  async function applyStatus(
    customer: PlatformCustomer, action: 'suspend' | 'reactivate', reason?: string,
  ) {
    const status = action === 'suspend' ? 'suspended' : 'active';
    setBusy(true);
    const res = await supabase.rpc('set_organization_lifecycle', {
      p_org_id: customer.id,
      p_status: status,
      p_trial_ends_at: null,
      p_reason: reason?.trim() ?? '',
    });
    setBusy(false);
    setReauth(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    setPending(null);
    toast(action === 'suspend' ? 'הארגון הושהה — הגישה נחסמה' : 'הארגון הופעל מחדש');
    void refetch();
  }

  const columns: ServerColumn<PlatformCustomer>[] = [
    {
      key: 'name', header: 'ארגון', priority: 1,
      render: (row) => <span className="font-medium text-ink">{row.name}</span>,
    },
    {
      key: 'status', header: 'מצב', mobileLabel: null,
      render: (row) => (
        <div>
          <StatusBadge meta={ORG_STATUS[row.status]} />
          {row.offboarding_status && OPEN_OFFBOARDING.has(row.offboarding_status) && (
            <div className="mt-0.5 text-xs text-ink-muted">
              {OFFBOARDING_LABEL[row.offboarding_status] ?? row.offboarding_status}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'users', header: 'משתמשים פעילים', className: 'num',
      render: (row) => fmtNum(row.active_user_count),
    },
    {
      // A customer that has never acted gets an em dash, never a date and never a zero: both
      // would be claims about something that did not happen (PRODUCT.md, anti-references).
      key: 'activity', header: 'פעילות אחרונה',
      render: (row) => (row.last_activity_at
        ? fmtDate(row.last_activity_at)
        : <span className="text-ink-muted">—</span>),
    },
    { key: 'created', header: 'לקוח מאז', render: (row) => fmtDate(row.created_at) },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error) return <ErrorNote message={error} />;

  // An operator can hold membership without customer.view, and platform_customers() answers such
  // a caller with zero rows rather than an error. An empty table here would therefore tell the
  // operator the platform has no customers; the screen must say which of the two it is showing.
  if (!may('customer.view')) {
    return (
      <Note tone="alert">
        <span className="min-w-0 flex-1">
          רשימת הלקוחות פתוחה למפעילים בעלי הרשאת צפייה בלקוחות. ההרשאה מוקצית מחוץ למוצר.
        </span>
      </Note>
    );
  }

  const activeFilters = (status.length ? 1 : 0) + (attention ? 1 : 0);

  return (
    <div className="space-y-4">
      <h1 className="page-title flex items-center gap-2"><Building2 size={22} /> לקוחות</h1>

      <DataTable
        rows={data?.rows ?? []}
        columns={columns}
        server={{
          total: data?.total ?? 0,
          page,
          pageSize: PAGE_SIZE,
          onPageChange: setPage,
          // platform_customers() orders by created_at desc and takes no sort argument, so no
          // column offers a sort button rather than offering one that would sort a single page.
          sort: null,
          onSortChange: () => {},
          sortableColumns: new Set<string>(),
          search: { value: search, onChange: (value) => { setSearch(value); setPage(0); } },
          fetching,
        }}
        searchLabel="חיפוש בלקוחות"
        rowLabel={(row) => `לקוח ${row.name}`}
        mobileTitle={(row) => row.name}
        mobileTrailing={(row) => <StatusBadge meta={ORG_STATUS[row.status]} />}
        emptyTitle="אין לקוחות"
        emptySubtitle="לקוח חדש נפתח במסך ניהול הפלטפורמה"
        activeFilters={activeFilters}
        onClearFilters={() => { setStatusKey('all'); setAttentionKey('none'); setPage(0); }}
        rowActions={(row) => [
          {
            key: 'suspend',
            label: 'השהיית הארגון',
            icon: PauseCircle,
            tone: 'danger',
            hidden: !may('org.lifecycle') || row.status === 'suspended',
            onSelect: () => setPending({ customer: row, action: 'suspend' }),
          },
          {
            key: 'reactivate',
            label: 'הפעלה מחדש',
            icon: PlayCircle,
            hidden: !may('org.lifecycle') || row.status !== 'suspended',
            onSelect: () => setPending({ customer: row, action: 'reactivate' }),
          },
        ]}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="סינון לפי מצב" className="flex flex-wrap gap-1">
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  aria-pressed={statusKey === filter.key}
                  className={statusKey === filter.key ? 'chip-filter-active' : 'chip-filter'}
                  onClick={() => { setStatusKey(filter.key); setPage(0); }}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <label className="sr-only" htmlFor="customer-attention">סינון לפי דורש טיפול</label>
            <select
              id="customer-attention"
              className="input w-auto"
              value={attentionKey}
              onChange={(event) => { setAttentionKey(event.target.value); setPage(0); }}
            >
              {ATTENTION_FILTERS.map((filter) => (
                <option key={filter.key} value={filter.key}>{filter.label}</option>
              ))}
            </select>
          </div>
        }
      />

      <ConfirmDialog
        open={!!pending && !reauth}
        busy={busy}
        danger={pending?.action === 'suspend'}
        requireReason
        title={pending?.action === 'suspend'
          ? `השהיית ${pending.customer.name}`
          : `הפעלת ${pending?.customer.name ?? ''} מחדש`}
        message={pending?.action === 'suspend'
          ? 'כל משתמשי הארגון יאבדו גישה לנתונים באופן מיידי — החסימה נאכפת בבסיס הנתונים, לא במסך בלבד.'
          : 'הארגון יחזור לסטטוס «פעיל» וגישת המשתמשים תשוחזר.'}
        confirmLabel={pending?.action === 'suspend' ? 'השהיה' : 'הפעלה מחדש'}
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          if (!pending) return;
          if (pending.action === 'reactivate') {
            setPending({ ...pending, reason });
            setReauth(true);
            return;
          }
          void applyStatus(pending.customer, pending.action, reason);
        }}
      />
      <ReauthModal
        open={reauth}
        title="אימות זהות להפעלת ארגון מחדש"
        onConfirm={() => {
          if (pending) void applyStatus(pending.customer, pending.action, pending.reason);
        }}
        onCancel={() => setReauth(false)}
      />
    </div>
  );
}
