import { useEffect, useId, useState } from 'react';
import { toHebrewError } from "../lib/errors";
import { Building2, ShieldCheck, Plus, Copy } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { DataTable, StatusBadge, ConfirmDialog, Modal, useToast, ErrorNote, SkeletonTable, type Column } from '../components/ui';
import { fmtDate, fmtNum, todayISO } from '../lib/format';
import { logAction } from '../lib/audit';
import { ORG_STATUS } from '../lib/status';
import { provisionOrg, generatePassword, type PlatformOrg, type ProvisionResult } from '../lib/platform';

interface NewOrgForm {
  name: string;
  ownerName: string;
  ownerEmail: string;
  password: string;
  vatRate: string;
  trialEndsAt: string;
  categories: string;
}

const emptyForm = (): NewOrgForm => ({
  name: '',
  ownerName: '',
  ownerEmail: '',
  password: generatePassword(),
  vatRate: '18',
  trialEndsAt: '',
  categories: '',
});

export default function Admin() {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [handover, setHandover] = useState<{ email: string; password: string; result: ProvisionResult } | null>(null);
  const [pending, setPending] = useState<{ org: PlatformOrg; action: 'suspend' | 'reactivate' } | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () => {
    const isPlatformAdmin = unwrap(await supabase.rpc('is_platform_admin')) as boolean;
    if (!isPlatformAdmin) return { isPlatformAdmin, orgs: [] as PlatformOrg[] };
    return { isPlatformAdmin, orgs: unwrap(await supabase.rpc('platform_orgs')) as PlatformOrg[] };
  });

  async function applyStatus(org: PlatformOrg, action: 'suspend' | 'reactivate', reason?: string) {
    const status = action === 'suspend' ? 'suspended' : 'active';
    setBusy(true);
    const res = await supabase.from('organizations').update({ status }).eq('id', org.id);
    if (res.error) { setBusy(false); toast(toHebrewError(res.error.message), 'error'); return; }

    await logAction({
      orgId: org.id,
      action: action === 'suspend' ? 'org:suspend' : 'org:reactivate',
      entityType: 'organizations',
      entityId: org.id,
      reason,
      oldValues: { status: org.status },
      newValues: { status },
    });

    setBusy(false);
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
      trial_ends_at: form.trialEndsAt || null,
      ...(categories.length ? { categories } : {}),
    });
    setBusy(false);

    if (!res.ok) { toast(toHebrewError(res.message), 'error'); return; }
    setCreating(false);
    setHandover({ email: form.ownerEmail.trim(), password: form.password, result: res.result });
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
        <button
          className={o.status === 'suspended' ? 'btn-secondary py-1! text-xs' : 'btn-ghost py-1! text-xs text-alert-solid'}
          onClick={() => setPending({ org: o, action: o.status === 'suspended' ? 'reactivate' : 'suspend' })}>
          {o.status === 'suspended' ? 'הפעלה מחדש' : 'השהיה'}
        </button>
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
          <button className="btn-primary ms-auto flex items-center gap-1.5" onClick={() => setCreating(true)}>
            <Plus size={16} /> ארגון חדש
          </button>
        }
      />

      <NewOrgModal open={creating} busy={busy} onClose={() => setCreating(false)} onSubmit={submitNewOrg} />

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
        open={!!pending}
        busy={busy}
        danger={pending?.action === 'suspend'}
        requireReason={pending?.action === 'suspend'}
        title={pending?.action === 'suspend' ? `השהיית ${pending.org.name}` : `הפעלת ${pending?.org.name ?? ''} מחדש`}
        message={
          pending?.action === 'suspend'
            ? 'כל משתמשי הארגון יאבדו גישה לנתונים באופן מיידי — החסימה נאכפת בבסיס הנתונים, לא במסך בלבד.'
            : 'הארגון יחזור לסטטוס «פעיל» וגישת המשתמשים תשוחזר.'
        }
        confirmLabel={pending?.action === 'suspend' ? 'השהיה' : 'הפעלה מחדש'}
        onClose={() => setPending(null)}
        onConfirm={(reason) => { if (pending) void applyStatus(pending.org, pending.action, reason); }}
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
          <div>
            <label className="label" htmlFor="new-org-trial">סיום תקופת ניסיון (אופציונלי)</label>
            <input id="new-org-trial" className="input" type="date" min={todayISO()} value={form.trialEndsAt} onChange={(e) => set('trialEndsAt', e.target.value)} />
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
