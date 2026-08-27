import { useT } from '../lib/i18n/LocaleProvider';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { Building2, Lock, PauseCircle, PlayCircle } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import {
  DataTable, ErrorNote, ICON, Modal, Note, PageHeader, SkeletonTable, StatusBadge, ToggleGroup,
  useToast, type ServerColumn,
} from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { fmtDate, fmtNum } from '../lib/format';
import { ORG_STATUS } from '../lib/status';
import {
  fetchLifecycleReasonCodes, fetchMyCapabilities, fetchPlatformCustomers,
  setOrganizationLifecycle,
  type CustomerAttention, type LifecycleReasonCode, type PlatformCapability,
  type PlatformCustomer,
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
  { key: 'onboarding_stalled', label: 'הקמה נתקעה', value: 'onboarding_stalled' },
  { key: 'processing_failures', label: 'כשלי עיבוד מסמכים', value: 'processing_failures' },
];

/**
 * The suspension dialog after the #20 split. It is two fields, not one, and the difference
 * between them is the whole point: the top field is written into the tenant's own audit trail
 * and the tenant's owner and accountant can read it; the bottom field is Platform-only storage
 * the tenant has no path to. The screen says so in as many words, because an operator who
 * believes both fields are private will put the commercial note in the wrong one.
 *
 * This is NOT the security boundary — the split is enforced in the command and in the storage
 * (0195). This is the surface that makes the boundary usable.
 */
function LifecycleDialog({
  pending, codes, busy, onClose, onSubmit,
}: {
  pending: PendingLifecycle | null;
  codes: LifecycleReasonCode[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { reasonCode: string; publicReason: string; internalNote: string }) => void;
}) {
  const codeId = useId();
  const publicId = useId();
  const internalId = useId();
  const suspending = pending?.action === 'suspend';
  const targetStatus: OrgStatus = suspending ? 'suspended' : 'active';
  const choices = codes.filter((code) => code.applies_to_status === targetStatus);
  const [reasonCode, setReasonCode] = useState('');
  const [publicReason, setPublicReason] = useState('');
  const [internalNote, setInternalNote] = useState('');

  const dialogKey = `${pending?.customer.id ?? ''}:${pending?.action ?? ''}`;
  const [lastKey, setLastKey] = useState('');
  if (pending && dialogKey !== lastKey) {
    // Reset on open rather than in an effect: a stale internal note carried into the next
    // customer's dialog would be an operator note filed against the wrong tenant.
    setLastKey(dialogKey);
    setReasonCode(choices[0]?.reason_code ?? '');
    setPublicReason('');
    setInternalNote('');
  }

  if (!pending) return null;

  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      title={suspending
        ? `השהיית ${pending.customer.name}`
        : `הפעלת ${pending.customer.name} מחדש`}
      description={suspending
        ? 'כל משתמשי הארגון יאבדו גישה לנתונים באופן מיידי — החסימה נאכפת בבסיס הנתונים, לא במסך בלבד.'
        : 'הארגון יחזור לסטטוס «פעיל» וגישת המשתמשים תשוחזר.'}
    >
      <div className="mb-4">
        <label className="label" htmlFor={codeId}>קוד סיבה (נרשם ביומן של הדייר)</label>
        <select
          id={codeId}
          className="input"
          value={reasonCode}
          onChange={(event) => setReasonCode(event.target.value)}
        >
          {choices.map((code) => (
            <option key={code.reason_code} value={code.reason_code}>{code.tenant_label}</option>
          ))}
        </select>
      </div>

      <div className="mb-4">
        <label className="label" htmlFor={publicId}>סיבה גלויה לדייר</label>
        <p className="mb-1 text-xs text-ink-muted">
          בעל הארגון ורואה החשבון שלו יכולים לקרוא את הטקסט הזה. יש לנסח אותו כהודעה ללקוח.
        </p>
        <textarea
          id={publicId}
          className="input"
          rows={2}
          maxLength={1000}
          value={publicReason}
          onChange={(event) => setPublicReason(event.target.value)}
        />
      </div>

      <div className="mb-4">
        <label className="label flex items-center gap-1.5" htmlFor={internalId}>
          <Lock size={ICON.xs} aria-hidden="true" />
          הערה פנימית — Platform בלבד
        </label>
        <p className="mb-1 text-xs text-ink-muted">
          לא נכנסת ליומן של הדייר, לא לייצוא הנתונים שלו ולא להתראה. כאן נרשמת התמונה המסחרית.
        </p>
        <textarea
          id={internalId}
          className="input"
          rows={3}
          maxLength={4000}
          value={internalNote}
          onChange={(event) => setInternalNote(event.target.value)}
        />
      </div>

      <div className="flex gap-2 justify-end">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
          ביטול
        </button>
        <button
          type="button"
          className={suspending ? 'btn-danger' : 'btn-primary'}
          disabled={busy}
          onClick={() => onSubmit({ reasonCode, publicReason, internalNote })}
        >
          {suspending ? 'השהיה' : 'הפעלה מחדש'}
        </button>
      </div>
    </Modal>
  );
}

interface PendingLifecycle {
  customer: PlatformCustomer;
  action: 'suspend' | 'reactivate';
  reasonCode?: string;
  publicReason?: string;
  internalNote?: string;
}

export default function Customers() {
  const { errorText } = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const [statusKey, setStatusKey] = useState('all');
  const [attentionKey, setAttentionKey] = useState('none');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState<PendingLifecycle | null>(null);
  const [reauth, setReauth] = useState(false);
  const [busy, setBusy] = useState(false);

  const status = STATUS_FILTERS.find((filter) => filter.key === statusKey)?.value ?? [];
  const attention = ATTENTION_FILTERS.find((filter) => filter.key === attentionKey)?.value ?? null;

  const { data, loading, fetching, error, refetch } = useQuery(
    async () => {
      const [capabilities, codes, customers] = await Promise.all([
        fetchMyCapabilities(),
        fetchLifecycleReasonCodes(),
        fetchPlatformCustomers({ search, status, attention, page, pageSize: PAGE_SIZE }),
      ]);
      return { capabilities, codes, ...customers };
    },
    [search, statusKey, attentionKey, page],
  );

  const capabilities: PlatformCapability[] = data?.capabilities ?? [];
  const may = (capability: PlatformCapability) => capabilities.includes(capability);

  async function applyStatus(next: PendingLifecycle) {
    setBusy(true);
    try {
      await setOrganizationLifecycle({
        orgId: next.customer.id,
        status: next.action === 'suspend' ? 'suspended' : 'active',
        publicReason: next.publicReason?.trim() || (next.action === 'suspend'
          ? 'השהיית הארגון' : 'הפעלת הארגון מחדש'),
        publicReasonCode: next.reasonCode?.trim() || null,
        // Empty means "no note", never an empty string in the ledger.
        internalNote: next.internalNote?.trim() || null,
      });
    } catch (rpcError) {
      setBusy(false);
      setReauth(false);
      toast(errorText((rpcError as Error).message), 'error');
      return;
    }
    setBusy(false);
    setReauth(false);
    setPending(null);
    toast(next.action === 'suspend' ? 'הארגון הושהה — הגישה נחסמה' : 'הארגון הופעל מחדש');
    void refetch();
  }

  const columns: ServerColumn<PlatformCustomer>[] = [
    {
      // `priority: 3` (desktop only), not 1: `mobileTitle` below already renders the name as the
      // card's headline, and DataTable excludes the first column from the card's detail grid only
      // when there is NO mobileTitle. With both set the phone card printed the organization twice
      // — once as the headline and once as „ארגון: מסעדת הגפן".
      key: 'name', header: 'ארגון', priority: 3,
      render: (row) => <span className="font-medium text-ink">{row.name}</span>,
    },
    {
      // Same duplication, same cause: `mobileTrailing` already carries the status badge.
      key: 'status', header: 'מצב', mobileLabel: null, priority: 3,
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
      <PageHeader title={<span className="flex items-center gap-2"><Building2 size={ICON.xl} aria-hidden="true" /> לקוחות</span>} />

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
        onRowClick={(row) => navigate(`/admin/customers/${row.id}`)}
        tableLabel="לקוחות"
        searchLabel="חיפוש בלקוחות"
        rowLabel={(row) => `לקוח ${row.name}`}
        mobileTitle={(row) => row.name}
        // The trailing slot now carries what the desktop `status` column carries, because that
        // column is desktop-only: the badge AND the offboarding stage, which is the one fact on
        // this row that changes what an operator does next.
        mobileTrailing={(row) => (
          <span className="flex flex-col items-end gap-0.5 text-end">
            <StatusBadge meta={ORG_STATUS[row.status]} />
            {row.offboarding_status && OPEN_OFFBOARDING.has(row.offboarding_status) && (
              <span className="text-xs text-ink-muted">
                {OFFBOARDING_LABEL[row.offboarding_status] ?? row.offboarding_status}
              </span>
            )}
          </span>
        )}
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
            <ToggleGroup
              label="סינון לפי מצב"
              items={STATUS_FILTERS.map((filter) => ({ key: filter.key, label: filter.label }))}
              value={statusKey}
              onChange={(key) => { setStatusKey(key); setPage(0); }}
            />
            <label className="sr-only" htmlFor="customer-attention">סינון לפי דורש טיפול</label>
            <select
              id="customer-attention"
              // Full width inside the phone's filter sheet, content width beside the chips on a
              // desktop toolbar — the sheet is a column, and a content-width select there sat in
              // the middle of an empty row.
              className="input w-full sm:w-auto"
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

      <LifecycleDialog
        pending={reauth ? null : pending}
        codes={data?.codes ?? []}
        busy={busy}
        onClose={() => setPending(null)}
        onSubmit={(input) => {
          if (!pending) return;
          // BOTH directions re-authenticate. set_organization_lifecycle has demanded a fresh
          // password since 0134:176 for suspension as well as reactivation; asking only on the
          // way back left an operator staring at a step-up error they had no way to satisfy.
          setPending({
            ...pending,
            reasonCode: input.reasonCode,
            publicReason: input.publicReason,
            internalNote: input.internalNote,
          });
          setReauth(true);
        }}
      />
      <ReauthModal
        open={reauth}
        title={pending?.action === 'suspend'
          ? 'אימות זהות להשהיית ארגון'
          : 'אימות זהות להפעלת ארגון מחדש'}
        onConfirm={() => { if (pending) void applyStatus(pending); }}
        onCancel={() => setReauth(false)}
      />
    </div>
  );
}
