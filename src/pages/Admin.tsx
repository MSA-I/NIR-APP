import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useId, useState } from 'react';
import { Building2, ShieldCheck, Plus, Copy, MessageSquare, Archive, RefreshCw, Undo2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { DataTable, ICON, Modal, Note, PageHeader, useToast, ErrorNote, SkeletonTable, SkeletonList, type Column } from '../components/ui';
import type { ActionMenuItem } from '../components/ActionMenu';
import { ReauthModal } from '../components/ReauthModal';
import { fmtDate, fmtDateTime, fmtNum } from '../lib/format';
import { ROLE_LABEL } from '../lib/status';
// No resetUserPassword: the campaign replaced owner-initiated password reset with self-service
// recovery to the verified address (campaign report §15), so the function no longer exists.
import { provisionOrg, generatePassword, type ProvisionResult } from '../lib/platform';

interface NewOrgForm {
  name: string;
  ownerName: string;
  ownerEmail: string;
  password: string;
  vatRate: string;
  categories: string;
}

interface PlatformOffboardingRequest {
  id: string;
  org_id: string;
  organization_name: string;
  status: 'requested' | 'approved' | 'export_building' | 'export_ready' | 'export_failed' | 'cancelled' | 'reactivated';
  requested_at: string;
  cancellation_deadline: string;
  export_completed_at: string | null;
  export_attempts: number;
  export_parts_total: number;
  export_parts_completed: number;
  last_export_error: string | null;
}

const OFFBOARDING_STATUS: Record<PlatformOffboardingRequest['status'], string> = {
  requested: 'ממתין לאישור',
  approved: 'ממתין להכנת ייצוא',
  export_building: 'הייצוא בהכנה',
  export_ready: 'הייצוא מוכן',
  export_failed: 'ניסיון הייצוא נכשל',
  cancelled: 'בוטל בידי הלקוח',
  reactivated: 'הופעל מחדש',
};

const emptyForm = (): NewOrgForm => ({
  name: '',
  ownerName: '',
  ownerEmail: '',
  password: generatePassword(),
  vatRate: '18',
  categories: '',
});

export default function Admin() {
  const { errorText } = useT();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [handover, setHandover] = useState<{ email: string; password: string; result: ProvisionResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [offboardingPending, setOffboardingPending] = useState<{
    request: PlatformOffboardingRequest;
    action: 'approve' | 'build' | 'reactivate';
  } | null>(null);

  const { data, loading, error, refetch } = useQuery(async () => {
    const isPlatformAdmin = unwrap(await supabase.rpc('is_platform_admin')) as boolean;
    if (!isPlatformAdmin) return {
      isPlatformAdmin,
      offboarding: [] as PlatformOffboardingRequest[],
    };
    return {
      isPlatformAdmin,
      offboarding: unwrap(await supabase.rpc('platform_offboarding_requests')) as PlatformOffboardingRequest[],
    };
  });

  async function applyOffboardingAction() {
    if (!offboardingPending) return;
    const { request, action } = offboardingPending;
    setBusy(true);
    try {
      if (action === 'reactivate') {
        const reactivated = await supabase.rpc('reactivate_organization_from_offboarding', {
          p_request_id: request.id,
        });
        if (reactivated.error) throw reactivated.error;
        toast('הארגון הופעל מחדש במצב פעיל.');
      } else {
        if (action === 'approve') {
          const approved = await supabase.rpc('approve_organization_offboarding', {
            p_request_id: request.id,
          });
          if (approved.error) throw approved.error;
        }
        const started = await supabase.functions.invoke<{ accepted?: boolean; status?: string }>('tenant-export', {
          body: { action: 'build', request_id: request.id },
        });
        if (started.error) throw started.error;
        toast(action === 'approve'
          ? 'הבקשה אושרה והכנת הייצוא הועברה לעיבוד.'
          : 'ניסיון הכנת הייצוא הועבר מחדש לעיבוד.');
      }
      setOffboardingPending(null);
      await refetch();
    } catch (actionError) {
      toast(errorText(actionError), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function submitNewOrg(form: NewOrgForm) {
    setBusy(true);
    const categories = form.categories.split(',').map((c) => c.trim()).filter(Boolean);
    const res = await provisionOrg({
      name: form.name.trim(),
      owner_email: form.ownerEmail.trim(),
      owner_name: form.ownerName.trim(),
      owner_password: form.password,
      vat_rate: Number(form.vatRate),
      ...(categories.length ? { categories } : {}),
    });
    setBusy(false);

    if (!res.ok) { toast(errorText(res.message), 'error'); return; }
    setCreating(false);
    setHandover({ email: form.ownerEmail.trim(), password: form.password, result: res.result });
    void refetch();
  }

  const offboardingColumns: Column<PlatformOffboardingRequest>[] = [
    { key: 'organization', header: 'ארגון', render: (r) => <span className="font-medium text-ink">{r.organization_name}</span>, sortValue: (r) => r.organization_name },
    {
      key: 'status', header: 'מצב', sortValue: (r) => r.status,
      render: (r) => (
        <div>
          <div>{OFFBOARDING_STATUS[r.status]}</div>
          {r.status === 'export_building' && r.export_parts_total > 0 && (
            <div className="mt-0.5 text-xs text-ink-muted num">{fmtNum(r.export_parts_completed)} / {fmtNum(r.export_parts_total)}</div>
          )}
        </div>
      ),
    },
    { key: 'requested', header: 'מועד הבקשה', render: (r) => fmtDate(r.requested_at), sortValue: (r) => r.requested_at },
    { key: 'attempts', header: 'ניסיונות ייצוא', className: 'num', render: (r) => fmtNum(r.export_attempts), sortValue: (r) => r.export_attempts },
  ];

  /** The same three gates the hand-rolled `actions` column carried, as the table's own row menu. */
  function offboardingActions(r: PlatformOffboardingRequest): ActionMenuItem[] {
    return [
      {
        key: 'approve', label: 'אישור והכנת ייצוא',
        hidden: r.status !== 'requested',
        onSelect: () => setOffboardingPending({ request: r, action: 'approve' }),
      },
      {
        key: 'build', icon: RefreshCw,
        label: r.status === 'export_failed' ? 'ניסיון חוזר' : r.status === 'export_building' ? 'בדיקה והמשך' : 'הכנת ייצוא',
        hidden: !['approved', 'export_building', 'export_failed'].includes(r.status),
        onSelect: () => setOffboardingPending({ request: r, action: 'build' }),
      },
      {
        key: 'reactivate', label: 'הפעלה מחדש', icon: Undo2,
        hidden: ['cancelled', 'reactivated'].includes(r.status),
        onSelect: () => setOffboardingPending({ request: r, action: 'reactivate' }),
      },
    ];
  }

  if (loading) return <SkeletonTable cols={5} />;
  if (error) return <ErrorNote message={error} />;
  if (!data?.isPlatformAdmin) return <ErrorNote message="המסך הזה פתוח למנהלי פלטפורמה בלבד." />;

  return (
    <div className="space-y-4">
      {/* The organization list moved to /admin/customers (0151): that screen filters, pages and
          counts on the server, and shows the columns this one never could. A second table of the
          same rows here would be two answers to one question. Provisioning stays -- it is an
          action, not a list. */}
      <PageHeader
        title={<span className="flex items-center gap-2"><ShieldCheck size={ICON.xl} aria-hidden="true" /> ניהול פלטפורמה</span>}
        actions={
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus size={ICON.sm} aria-hidden="true" /> ארגון חדש
          </button>
        }
      />

      <FeedbackNotes />

      <NewOrgModal open={creating} busy={busy} onClose={() => setCreating(false)} onSubmit={submitNewOrg} />

      <section className="space-y-3" aria-labelledby="offboarding-heading">
        <div>
          <h2 id="offboarding-heading" className="section-title flex items-center gap-2"><Archive size={ICON.md} aria-hidden="true" /> סיום שירות וייצוא דיירים</h2>
          <p className="mt-1 text-sm text-ink-muted">אישור מפעיל מתחיל הכנת ייצוא מבוקר. התהליך אינו מוחק מידע ואינו חוסם צפייה של הלקוח.</p>
        </div>
        <DataTable
          rows={data.offboarding}
          columns={offboardingColumns}
          searchable
          searchFn={(row, query) => row.organization_name.toLowerCase().includes(query)}
          tableLabel="בקשות סיום שירות"
          searchLabel="חיפוש בבקשות סיום שירות"
          rowActions={offboardingActions}
          rowLabel={(row) => `בקשת סיום שירות של ${row.organization_name}`}
          emptyTitle="אין בקשות סיום שירות"
          emptySubtitle="בקשות שיוגשו בידי בעלי ארגונים יופיעו כאן"
        />
      </section>
      {handover && (
        <Modal open onClose={() => setHandover(null)} title="הארגון הוקם — פרטי כניסה למסירה">
          <div className="space-y-4">
            <p className="text-sm text-ink-soft">
              הפרטים מוצגים פעם אחת בלבד. מסור אותם לבעל העסק בערוץ מאובטח ובקש ממנו להחליף סיסמה בכניסה הראשונה.
            </p>
            <CredentialRow label="אימייל" value={handover.email} onCopy={() => toast('הועתק')} onCopyError={() => toast('ההעתקה נכשלה — יש להעתיק ידנית', 'error')} />
            <CredentialRow label="סיסמה ראשונית" value={handover.password} onCopy={() => toast('הועתק')} onCopyError={() => toast('ההעתקה נכשלה — יש להעתיק ידנית', 'error')} />
            <div className="text-xs text-ink-muted">
              נוצרו {fmtNum(handover.result.categories_created)} קטגוריות בסיס. הארגון נפתח בסטטוס פעיל.
            </div>
            <div className="flex justify-end">
              <button className="btn-primary" onClick={() => setHandover(null)}>סגירה</button>
            </div>
          </div>
        </Modal>
      )}

      <ReauthModal
        open={offboardingPending !== null}
        title={offboardingPending?.action === 'reactivate'
          ? 'אימות זהות לפני הפעלת הארגון מחדש'
          : 'אימות זהות לפני טיפול בייצוא הארגון'}
        onConfirm={() => { void applyOffboardingAction(); }}
        onCancel={() => setOffboardingPending(null)}
      />
    </div>
  );
}

/**
 * Design-partner feedback (0090). The Discord message is the alert; this is the ledger — where a
 * note is still findable a week later, and where a note whose send failed is visible at all.
 *
 * Read across tenants by `feedback_notes_platform_select`, the RLS mirror of org_platform_select.
 * Bounded at 200 rows rather than paginated: the volume is one design partner's notes, and an
 * unbounded select that quietly grows is the kind of thing this repo measures later and regrets.
 */
interface FeedbackNoteRow {
  id: string;
  created_at: string;
  note: string;
  route: string;
  role: string;
  viewport_width: number | null;
  app_release: string | null;
  sent_at: string | null;
  send_error: string | null;
  organizations: { name: string } | null;
}

function FeedbackNotes() {
  const { statusLabel } = useT();
  const { data, loading, error } = useQuery(async () => unwrap(await supabase
    .from('feedback_notes')
    .select('id, created_at, note, route, role, viewport_width, app_release, sent_at, send_error, organizations(name)')
    .order('created_at', { ascending: false })
    .limit(200)) as unknown as FeedbackNoteRow[]);

  const columns: Column<FeedbackNoteRow>[] = [
    {
      key: 'note',
      header: 'ההערה',
      priority: 1,
      mobileLabel: null,
      render: (r) => <span className="whitespace-pre-wrap text-ink-body">{r.note}</span>,
    },
    {
      key: 'org',
      header: 'ארגון',
      render: (r) => r.organizations?.name ?? '—',
    },
    {
      key: 'who',
      header: 'תפקיד',
      // The vendor's own screen, so the frozen defaults are the right vocabulary here — a tenant's
      // renamed role would say nothing to the reader of this table (status.ts:163-168).
      render: (r) => statusLabel(ROLE_LABEL[r.role]) || r.role,
    },
    {
      key: 'route',
      header: 'מסך',
      render: (r) => <span dir="ltr" className="num">{r.route}</span>,
    },
    {
      key: 'device',
      header: 'מכשיר',
      priority: 3,
      render: (r) => (
        <span className="text-xs text-ink-muted">
          {r.viewport_width ? <span className="num">{r.viewport_width}px</span> : '—'}
          {r.app_release ? <> · <span dir="ltr" className="num">{r.app_release}</span></> : null}
        </span>
      ),
    },
    {
      key: 'sent',
      header: 'שליחה',
      mobileLabel: null,
      // send_error is shown, not summarised: "לא נשלח" without the reason sends the reader to the
      // function logs for something the row already knows.
      render: (r) => (r.sent_at
        ? <span className="badge-done">נשלח</span>
        : <span className="badge-alert" title={r.send_error ?? undefined}>לא נשלח</span>),
    },
    {
      key: 'when',
      header: 'מתי',
      render: (r) => fmtDateTime(r.created_at),
    },
  ];

  if (loading) return <SkeletonList rows={3} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <section className="space-y-2">
      <h2 className="section-title flex items-center gap-2"><MessageSquare size={ICON.md} aria-hidden="true" /> הערות מלקוחות</h2>
      <DataTable
        rows={data ?? []}
        columns={columns}
        tableLabel="הערות מלקוחות"
        rowLabel={(r) => `הערה מ-${r.organizations?.name ?? 'ארגון לא מזוהה'}`}
        emptyTitle="אין הערות"
        emptySubtitle="כפתור ההערות מופיע רק בארגון שהדגל feedback.notes דלוק בו"
      />
    </section>
  );
}

function CredentialRow({ label, value, onCopy, onCopyError }: {
  label: string; value: string; onCopy: () => void; onCopyError: () => void;
}) {
  const inputId = useId();

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      onCopy();
    } catch {
      onCopyError();
    }
  }

  return (
    <div>
      <label className="label" htmlFor={inputId}>{label}</label>
      <div className="flex items-center gap-2">
        <input id={inputId} className="input" readOnly value={value} dir="ltr" />
        {/* `btn-icon`, not `p-2!`: the override zeroed the padding on one axis only, so the button
            was 44px tall and 36px wide — under the floor on the axis nobody measured. */}
        <button className="btn-secondary btn-icon" aria-label={`העתקת ${label}`}
          onClick={() => void copy()}>
          <Copy size={ICON.sm} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function NewOrgModal({ open, busy, onClose, onSubmit }: {
  open: boolean; busy: boolean; onClose: () => void; onSubmit: (form: NewOrgForm) => void;
}) {
  const [form, setForm] = useState<NewOrgForm>(emptyForm);
  const set = <K extends keyof NewOrgForm>(key: K, value: NewOrgForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    if (!open) setForm(emptyForm());
  }, [open]);

  const ready = form.name.trim() && form.ownerName.trim() && form.ownerEmail.trim() && form.password.length >= 10;

  function close() {
    setForm(emptyForm());
    onClose();
  }

  return (
    <Modal open={open} onClose={close} title="הקמת ארגון חדש" wide busy={busy}>
      <div className="space-y-4">
        {/* `Note tone="idle"` — a neutral statement, and the one box the system already has for
            it. The hand-rolled version was a fifth spelling of `.note-idle`. */}
        <Note tone="idle">
          <Building2 size={ICON.sm} className="mt-0.5 shrink-0 text-ink-faint" aria-hidden="true" />
          <span className="min-w-0 flex-1">נוצרים ארגון, משתמש בעלים וקטגוריות בסיס. הפעולה מבוטלת במלואה אם שלב כלשהו נכשל.</span>
        </Note>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="new-org-name">שם הארגון</label>
            <input id="new-org-name" className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="new-org-owner-name">שם בעל העסק</label>
            <input id="new-org-owner-name" className="input" value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="new-org-owner-email">אימייל בעל העסק</label>
            <input id="new-org-owner-email" className="input" type="email" dir="ltr" value={form.ownerEmail} onChange={(e) => set('ownerEmail', e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="new-org-password">סיסמה ראשונית (לפחות 10 תווים)</label>
            <div className="flex items-center gap-2">
              <input id="new-org-password" className="input" dir="ltr" value={form.password} onChange={(e) => set('password', e.target.value)} />
              <button type="button" className="btn-secondary whitespace-nowrap" disabled={busy} onClick={() => set('password', generatePassword())}>הגרלה מחדש</button>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="new-org-vat">שיעור מע״מ (%)</label>
            <input id="new-org-vat" className="input num" type="number" step="0.5" value={form.vatRate} onChange={(e) => set('vatRate', e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="new-org-categories">קטגוריות בסיס (מופרדות בפסיק — ריק יוצר «כללי» בלבד)</label>
            <input id="new-org-categories" className="input" value={form.categories} onChange={(e) => set('categories', e.target.value)} />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" disabled={busy} onClick={close}>ביטול</button>
          <button className="btn-primary" disabled={busy || !ready} onClick={() => onSubmit(form)}>הקמה</button>
        </div>
      </div>
    </Modal>
  );
}
