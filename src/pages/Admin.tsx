import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t.ts';
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
import { VAT_RATE_MAX, VAT_RATE_MIN, isVatRateInRange } from '../lib/inputBounds';

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

/**
 * The operator's reading of an offboarding request, which is NOT the customer's reading of the
 * same row: `Settings.tsx` says "your request was sent" where this says "waiting for approval".
 * Two audiences, two sentences, and the keys are separate so neither can be edited into the
 * other by someone tidying up duplicates.
 */
const OFFBOARDING_STATUS_KEYS: Record<PlatformOffboardingRequest['status'], TKey> = {
  requested: 'admin.offboardingStatusRequested',
  approved: 'admin.offboardingStatusApproved',
  export_building: 'admin.offboardingStatusExportBuilding',
  export_ready: 'admin.offboardingStatusExportReady',
  export_failed: 'admin.offboardingStatusExportFailed',
  cancelled: 'admin.offboardingStatusCancelled',
  reactivated: 'admin.offboardingStatusReactivated',
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
  const { errorText, t } = useT();
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
        toast(t('admin.toast'));
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
          ? t('admin.text')
          : t('admin.text_2'));
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
    /* Unlike the Settings screen, this one already has a server bound behind it:
       `validateProvisionInput` refuses a rate outside 0-100 before the organization row is
       created (`supabase/functions/_shared/provision.ts:170-172`), and `admin-provision` calls
       it (`index.ts:121-122`). So this check is genuinely only a courtesy — it turns a 400 from
       a remote function into a sentence next to the field. It is here so the operator learns
       about the bound at the same moment the tenant owner does, not so it can be relied on. */
    const vat = Number(form.vatRate);
    if (!isVatRateInRange(vat)) { toast(t('admin.vatRateOutOfRange'), 'error'); return; }

    setBusy(true);
    const categories = form.categories.split(',').map((c) => c.trim()).filter(Boolean);
    const res = await provisionOrg({
      name: form.name.trim(),
      owner_email: form.ownerEmail.trim(),
      owner_name: form.ownerName.trim(),
      owner_password: form.password,
      vat_rate: vat,
      ...(categories.length ? { categories } : {}),
    });
    setBusy(false);

    if (!res.ok) { toast(errorText(res.message), 'error'); return; }
    setCreating(false);
    setHandover({ email: form.ownerEmail.trim(), password: form.password, result: res.result });
    void refetch();
  }

  const offboardingColumns: Column<PlatformOffboardingRequest>[] = [
    { key: 'organization', header: t('admin.text_3'), render: (r) => <span className="font-medium text-ink">{r.organization_name}</span>, sortValue: (r) => r.organization_name },
    {
      key: 'status', header: t('admin.text_4'), sortValue: (r) => r.status,
      render: (r) => (
        <div>
          <div>{t(OFFBOARDING_STATUS_KEYS[r.status])}</div>
          {r.status === 'export_building' && r.export_parts_total > 0 && (
            <div className="mt-0.5 text-xs text-ink-muted num">{fmtNum(r.export_parts_completed)} / {fmtNum(r.export_parts_total)}</div>
          )}
        </div>
      ),
    },
    { key: 'requested', header: t('admin.fmtDate'), render: (r) => fmtDate(r.requested_at), sortValue: (r) => r.requested_at },
    { key: 'attempts', header: t('admin.fmtNum'), className: 'num', render: (r) => fmtNum(r.export_attempts), sortValue: (r) => r.export_attempts },
  ];

  /** The same three gates the hand-rolled `actions` column carried, as the table's own row menu. */
  function offboardingActions(r: PlatformOffboardingRequest): ActionMenuItem[] {
    return [
      {
        key: 'approve', label: t('admin.text_5'),
        hidden: r.status !== 'requested',
        onSelect: () => setOffboardingPending({ request: r, action: 'approve' }),
      },
      {
        key: 'build', icon: RefreshCw,
        label: r.status === 'export_failed' ? t('admin.text_6') : r.status === 'export_building' ? t('admin.text_7') : t('admin.text_8'),
        hidden: !['approved', 'export_building', 'export_failed'].includes(r.status),
        onSelect: () => setOffboardingPending({ request: r, action: 'build' }),
      },
      {
        key: 'reactivate', label: t('admin.text_9'), icon: Undo2,
        hidden: ['cancelled', 'reactivated'].includes(r.status),
        onSelect: () => setOffboardingPending({ request: r, action: 'reactivate' }),
      },
    ];
  }

  if (loading) return <SkeletonTable cols={5} />;
  if (error) return <ErrorNote message={error} />;
  if (!data?.isPlatformAdmin) return <ErrorNote message={t('admin.message')} />;

  return (
    <div className="space-y-4">
      {/* The organization list moved to /admin/customers (0151): that screen filters, pages and
          counts on the server, and shows the columns this one never could. A second table of the
          same rows here would be two answers to one question. Provisioning stays -- it is an
          action, not a list. */}
      <PageHeader
        title={<span className="flex items-center gap-2"><ShieldCheck size={ICON.xl} aria-hidden="true" /> {t('admin.text_10')}</span>}
        actions={
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus size={ICON.sm} aria-hidden="true" /> {t('admin.newOrganization')}
          </button>
        }
      />

      <FeedbackNotes />

      <NewOrgModal open={creating} busy={busy} onClose={() => setCreating(false)} onSubmit={submitNewOrg} />

      <section className="space-y-3" aria-labelledby="offboarding-heading">
        <div>
          <h2 id="offboarding-heading" className="section-title flex items-center gap-2"><Archive size={ICON.md} aria-hidden="true" /> {t('admin.text_11')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('admin.text_12')}</p>
        </div>
        <DataTable
          rows={data.offboarding}
          columns={offboardingColumns}
          searchable
          searchFn={(row, query) => row.organization_name.toLowerCase().includes(query)}
          tableLabel={t('admin.tableLabel')}
          searchLabel={t('admin.searchLabel')}
          rowActions={offboardingActions}
          rowLabel={(row) => t('admin.offboardingRowLabel', { organization: row.organization_name })}
          emptyTitle={t('admin.emptyTitle')}
          emptySubtitle={t('admin.emptySubtitle')}
        />
      </section>
      {handover && (
        <Modal open onClose={() => setHandover(null)} title={t('admin.title')}>
          <div className="space-y-4">
            <p className="text-sm text-ink-soft">
              {t('admin.text_13')}
            </p>
            <CredentialRow label={t('admin.label')} value={handover.email} onCopy={() => toast(t('admin.text_14'))} onCopyError={() => toast(t('admin.text_15'), 'error')} />
            <CredentialRow label={t('admin.label_2')} value={handover.password} onCopy={() => toast(t('admin.text_16'))} onCopyError={() => toast(t('admin.text_17'), 'error')} />
            <div className="text-xs text-ink-muted">
              {t('admin.handoverCategories', { count: fmtNum(handover.result.categories_created) })}
            </div>
            <div className="flex justify-end">
              <button className="btn-primary" onClick={() => setHandover(null)}>{t('admin.setHandover')}</button>
            </div>
          </div>
        </Modal>
      )}

      <ReauthModal
        open={offboardingPending !== null}
        title={offboardingPending?.action === 'reactivate'
          ? t('admin.text_18')
          : t('admin.text_19')}
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
  const { statusLabel, t } = useT();
  const { data, loading, error } = useQuery(async () => unwrap(await supabase
    .from('feedback_notes')
    .select('id, created_at, note, route, role, viewport_width, app_release, sent_at, send_error, organizations(name)')
    .order('created_at', { ascending: false })
    .limit(200)) as unknown as FeedbackNoteRow[]);

  const columns: Column<FeedbackNoteRow>[] = [
    {
      key: 'note',
      header: t('admin.text_20'),
      priority: 1,
      mobileLabel: null,
      render: (r) => <span className="whitespace-pre-wrap text-ink-body">{r.note}</span>,
    },
    {
      key: 'org',
      header: t('admin.text_21'),
      render: (r) => r.organizations?.name ?? '—',
    },
    {
      key: 'who',
      header: t('admin.text_22'),
      // The vendor's own screen, so the frozen defaults are the right vocabulary here — a tenant's
      // renamed role would say nothing to the reader of this table (status.ts:163-168).
      render: (r) => statusLabel(ROLE_LABEL[r.role]) || r.role,
    },
    {
      key: 'route',
      header: t('admin.text_23'),
      render: (r) => <span dir="ltr" className="num">{r.route}</span>,
    },
    {
      key: 'device',
      header: t('admin.text_24'),
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
      header: t('admin.text_25'),
      mobileLabel: null,
      // send_error is shown, not summarised: "לא נשלח" without the reason sends the reader to the
      // function logs for something the row already knows.
      render: (r) => (r.sent_at
        ? <span className="badge-done">{t('admin.text_26')}</span>
        : <span className="badge-alert" title={r.send_error ?? undefined}>{t('admin.text_27')}</span>),
    },
    {
      key: 'when',
      header: t('admin.text_28'),
      render: (r) => fmtDateTime(r.created_at),
    },
  ];

  if (loading) return <SkeletonList rows={3} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <section className="space-y-2">
      <h2 className="section-title flex items-center gap-2"><MessageSquare size={ICON.md} aria-hidden="true" /> {t('admin.text_29')}</h2>
      <DataTable
        rows={data ?? []}
        columns={columns}
        tableLabel={t('admin.tableLabel_2')}
        rowLabel={(r) => t('admin.noteRowLabel', { organization: r.organizations?.name ?? t('admin.unknownOrganization') })}
        emptyTitle={t('admin.emptyTitle_2')}
        emptySubtitle={t('admin.emptySubtitle_2')}
      />
    </section>
  );
}

function CredentialRow({ label, value, onCopy, onCopyError }: {
  label: string; value: string; onCopy: () => void; onCopyError: () => void;
}) {
  const { t } = useT();
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
        <button className="btn-secondary btn-icon" aria-label={t('admin.copyFieldLabel', { field: label })}
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
  const { t } = useT();
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
    <Modal open={open} onClose={close} title={t('admin.title_2')} wide busy={busy}>
      <div className="space-y-4">
        {/* `Note tone="idle"` — a neutral statement, and the one box the system already has for
            it. The hand-rolled version was a fifth spelling of `.note-idle`. */}
        <Note tone="idle">
          <Building2 size={ICON.sm} className="mt-0.5 shrink-0 text-ink-faint" aria-hidden="true" />
          <span className="min-w-0 flex-1">{t('admin.text_30')}</span>
        </Note>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="new-org-name">{t('admin.text_31')}</label>
            <input id="new-org-name" className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="new-org-owner-name">{t('admin.text_32')}</label>
            <input id="new-org-owner-name" className="input" value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="new-org-owner-email">{t('admin.text_33')}</label>
            <input id="new-org-owner-email" className="input" type="email" dir="ltr" value={form.ownerEmail} onChange={(e) => set('ownerEmail', e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="new-org-password">{t('admin.text_34')}</label>
            <div className="flex items-center gap-2">
              <input id="new-org-password" className="input" dir="ltr" value={form.password} onChange={(e) => set('password', e.target.value)} />
              <button type="button" className="btn-secondary whitespace-nowrap" disabled={busy} onClick={() => set('password', generatePassword())}>{t('admin.set')}</button>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="new-org-vat">{t('admin.text_35')}</label>
            <input id="new-org-vat" className="input num" type="number" step="0.5" min={VAT_RATE_MIN} max={VAT_RATE_MAX} value={form.vatRate} onChange={(e) => set('vatRate', e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="new-org-categories">{t('admin.text_36')}</label>
            <input id="new-org-categories" className="input" value={form.categories} onChange={(e) => set('categories', e.target.value)} />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" disabled={busy} onClick={close}>{t('admin.text_37')}</button>
          <button className="btn-primary" disabled={busy || !ready} onClick={() => onSubmit(form)}>{t('admin.onSubmit')}</button>
        </div>
      </div>
    </Modal>
  );
}
