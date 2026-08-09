import { useEffect, useId, useState } from 'react';
import { toHebrewError } from "../lib/errors";
import { Building2, ShieldCheck, Plus, Copy, Archive, RefreshCw, Undo2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { DataTable, StatusBadge, ConfirmDialog, Modal, useToast, ErrorNote, SkeletonTable, type Column } from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { addCalendarDays, dateStartInstant, fmtDate, fmtNum, todayISO } from '../lib/format';
import { ORG_STATUS } from '../lib/status';
import { provisionOrg, generatePassword, type PlatformOrg, type ProvisionResult } from '../lib/platform';

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

const trialEndInstant = (date: string) => new Date(
  Date.parse(dateStartInstant(addCalendarDays(date, 1))) - 1,
).toISOString();

export default function Admin() {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [handover, setHandover] = useState<{ email: string; password: string; result: ProvisionResult } | null>(null);
  const [pending, setPending] = useState<{ org: PlatformOrg; action: 'suspend' | 'reactivate'; reason?: string } | null>(null);
  const [statusReauth, setStatusReauth] = useState(false);
  const [extension, setExtension] = useState<{ org: PlatformOrg; date: string; reason: string } | null>(null);
  const [extensionReauth, setExtensionReauth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offboardingPending, setOffboardingPending] = useState<{
    request: PlatformOffboardingRequest;
    action: 'approve' | 'build' | 'reactivate';
  } | null>(null);

  const { data, loading, error, refetch } = useQuery(async () => {
    const isPlatformAdmin = unwrap(await supabase.rpc('is_platform_admin')) as boolean;
    if (!isPlatformAdmin) return {
      isPlatformAdmin,
      orgs: [] as PlatformOrg[],
      offboarding: [] as PlatformOffboardingRequest[],
    };
    const [orgs, offboarding] = await Promise.all([
      supabase.rpc('platform_orgs'),
      supabase.rpc('platform_offboarding_requests'),
    ]);
    return {
      isPlatformAdmin,
      orgs: unwrap(orgs) as PlatformOrg[],
      offboarding: unwrap(offboarding) as PlatformOffboardingRequest[],
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
      toast(toHebrewError(actionError), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function applyStatus(org: PlatformOrg, action: 'suspend' | 'reactivate', reason?: string) {
    const status = action === 'suspend' ? 'suspended' : 'active';
    setBusy(true);
    const res = await supabase.rpc('set_organization_lifecycle', {
      p_org_id: org.id,
      p_status: status,
      p_trial_ends_at: org.trial_ends_at,
      p_reason: reason?.trim() ?? '',
    });
    if (res.error) { setBusy(false); setStatusReauth(false); toast(toHebrewError(res.error.message), 'error'); return; }

    setBusy(false);
    setStatusReauth(false);
    setPending(null);
    toast(action === 'suspend' ? 'הארגון הושהה — הגישה נחסמה' : 'הארגון הופעל מחדש');
    void refetch();
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

    if (!res.ok) { toast(toHebrewError(res.message), 'error'); return; }
    setCreating(false);
    setHandover({ email: form.ownerEmail.trim(), password: form.password, result: res.result });
    void refetch();
  }

  async function extendTrial() {
    if (!extension) return;
    setBusy(true);
    const res = await supabase.rpc('set_organization_lifecycle', {
      p_org_id: extension.org.id,
      p_status: 'trial',
      p_trial_ends_at: trialEndInstant(extension.date),
      p_reason: extension.reason.trim(),
    });
    setBusy(false);
    setExtensionReauth(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    setExtension(null);
    toast('תקופת הניסיון הוארכה');
    void refetch();
  }

  const columns: Column<PlatformOrg>[] = [
    { key: 'name', header: 'ארגון', sortValue: (o) => o.name, render: (o) => <span className="font-medium text-ink">{o.name}</span> },
    { key: 'status', header: 'סטטוס', sortValue: (o) => o.status, render: (o) => <StatusBadge meta={ORG_STATUS[o.status]} /> },
    { key: 'users', header: 'משתמשים', className: 'num', sortValue: (o) => o.user_count, render: (o) => fmtNum(o.user_count) },
    { key: 'vat', header: 'מע״מ', className: 'num', render: (o) => `${fmtNum(o.vat_rate)}%` },
    { key: 'trial', header: 'סיום ניסיון', sortValue: (o) => o.trial_ends_at ?? '', render: (o) => fmtDate(o.trial_ends_at) },
    { key: 'created', header: 'נוצר', sortValue: (o) => o.created_at, render: (o) => fmtDate(o.created_at) },
    {
      key: 'actions',
      header: '',
      render: (o) => (
        <div className="flex flex-wrap justify-end gap-1">
          {o.status === 'trial' && (
            <button
              className="btn-ghost py-1! text-xs"
              onClick={() => setExtension({ org: o, date: addCalendarDays(todayISO(), 30), reason: '' })}>
              הארכת ניסיון
            </button>
          )}
          <button
            className={o.status === 'suspended' ? 'btn-secondary py-1! text-xs' : 'btn-ghost py-1! text-xs text-alert-solid'}
            onClick={() => setPending({ org: o, action: o.status === 'suspended' ? 'reactivate' : 'suspend' })}>
            {o.status === 'suspended' ? 'הפעלה מחדש' : 'השהיה'}
          </button>
        </div>
      ),
    },
  ];

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
    {
      key: 'actions', header: '', render: (r) => (
        <div className="flex flex-wrap justify-end gap-1">
          {r.status === 'requested' && (
            <button type="button" className="btn-primary py-1! text-xs" onClick={() => setOffboardingPending({ request: r, action: 'approve' })}>
              אישור והכנת ייצוא
            </button>
          )}
          {['approved', 'export_building', 'export_failed'].includes(r.status) && (
            <button type="button" className="btn-secondary py-1! text-xs" onClick={() => setOffboardingPending({ request: r, action: 'build' })}>
              <RefreshCw size={13} /> {r.status === 'export_failed' ? 'ניסיון חוזר' : r.status === 'export_building' ? 'בדיקה והמשך' : 'הכנת ייצוא'}
            </button>
          )}
          {!['cancelled', 'reactivated'].includes(r.status) && (
            <button type="button" className="btn-ghost py-1! text-xs" onClick={() => setOffboardingPending({ request: r, action: 'reactivate' })}>
              <Undo2 size={13} /> הפעלה מחדש
            </button>
          )}
        </div>
      ),
    },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error) return <ErrorNote message={error} />;
  if (!data?.isPlatformAdmin) return <ErrorNote message="המסך הזה פתוח למנהלי פלטפורמה בלבד." />;

  return (
    <div className="space-y-4">
      <h1 className="page-title flex items-center gap-2"><ShieldCheck size={22} /> ניהול פלטפורמה</h1>

      <DataTable
        rows={data.orgs}
        columns={columns}
        searchable
        searchFn={(o, q) => o.name.toLowerCase().includes(q)}
        searchLabel="חיפוש בארגונים"
        rowLabel={(o) => `ארגון ${o.name}`}
        emptyTitle="אין ארגונים במערכת"
        emptySubtitle="לקוח חדש נפתח כאן — הרשמה עצמית אינה קיימת במערכת"
        toolbar={
          <div className="ms-auto flex flex-wrap items-center gap-2">
            <button className="btn-primary flex items-center gap-1.5" onClick={() => setCreating(true)}>
              <Plus size={16} /> ארגון חדש
            </button>
          </div>
        }
      />

      <NewOrgModal open={creating} busy={busy} onClose={() => setCreating(false)} onSubmit={submitNewOrg} />
      <Modal open={extension !== null} onClose={() => setExtension(null)} title={`הארכת תקופת הניסיון — ${extension?.org.name ?? ''}`} busy={busy}>
        {extension && (
          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="trial-extension-date">תאריך סיום חדש *</label>
              <input
                id="trial-extension-date"
                className="input"
                type="date"
                min={addCalendarDays(todayISO(), 1)}
                value={extension.date}
                onChange={(event) => setExtension({ ...extension, date: event.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="trial-extension-reason">סיבת ההארכה *</label>
              <textarea
                id="trial-extension-reason"
                className="input min-h-24"
                value={extension.reason}
                onChange={(event) => setExtension({ ...extension, reason: event.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" disabled={busy} onClick={() => setExtension(null)}>ביטול</button>
              <button
                className="btn-primary"
                disabled={busy || !extension.date || !extension.reason.trim()}
                onClick={() => setExtensionReauth(true)}>
                אימות והארכה
              </button>
            </div>
          </div>
        )}
      </Modal>
      <ReauthModal
        open={extensionReauth}
        title="אימות זהות להארכת תקופת ניסיון"
        onConfirm={() => { void extendTrial(); }}
        onCancel={() => setExtensionReauth(false)}
      />

      <section className="space-y-3" aria-labelledby="offboarding-heading">
        <div>
          <h2 id="offboarding-heading" className="section-title flex items-center gap-2"><Archive size={17} /> סיום שירות וייצוא דיירים</h2>
          <p className="mt-1 text-sm text-ink-muted">אישור מפעיל מתחיל הכנת ייצוא מבוקר. התהליך אינו מוחק מידע ואינו חוסם צפייה של הלקוח.</p>
        </div>
        <DataTable
          rows={data.offboarding}
          columns={offboardingColumns}
          searchable
          searchFn={(row, query) => row.organization_name.toLowerCase().includes(query)}
          searchLabel="חיפוש בבקשות סיום שירות"
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
              נוצרו {fmtNum(handover.result.categories_created)} קטגוריות בסיס. הארגון נפתח בסטטוס «תקופת ניסיון».
            </div>
            <div className="flex justify-end">
              <button className="btn-primary" onClick={() => setHandover(null)}>סגירה</button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={!!pending && !statusReauth}
        busy={busy}
        danger={pending?.action === 'suspend'}
        requireReason
        title={pending?.action === 'suspend' ? `השהיית ${pending.org.name}` : `הפעלת ${pending?.org.name ?? ''} מחדש`}
        message={
          pending?.action === 'suspend'
            ? 'כל משתמשי הארגון יאבדו גישה לנתונים באופן מיידי — החסימה נאכפת בבסיס הנתונים, לא במסך בלבד.'
            : 'הארגון יחזור לסטטוס «פעיל» וגישת המשתמשים תשוחזר.'
        }
        confirmLabel={pending?.action === 'suspend' ? 'השהיה' : 'הפעלה מחדש'}
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          if (!pending) return;
          if (pending.action === 'reactivate') {
            setPending({ ...pending, reason });
            setStatusReauth(true);
            return;
          }
          void applyStatus(pending.org, pending.action, reason);
        }}
      />
      <ReauthModal
        open={statusReauth}
        title="אימות זהות להפעלת ארגון מחדש"
        onConfirm={() => { if (pending) void applyStatus(pending.org, pending.action, pending.reason); }}
        onCancel={() => setStatusReauth(false)}
      />
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
        <button className="btn-secondary p-2!" aria-label={`העתקת ${label}`}
          onClick={() => void copy()}>
          <Copy size={16} />
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
        <div className="flex items-start gap-2 rounded-lg bg-surface-sunken border border-line px-3 py-2.5 text-sm text-ink-soft">
          <Building2 size={16} className="mt-0.5 shrink-0 text-ink-faint" />
          <span>נוצרים ארגון, משתמש בעלים וקטגוריות בסיס. הפעולה מבוטלת במלואה אם שלב כלשהו נכשל.</span>
        </div>

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
