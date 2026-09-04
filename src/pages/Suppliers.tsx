import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useParamState } from '../lib/useParamState';
import { Plus, Phone, Mail, MapPin, Clock, Truck, Star, TrendingUp, TrendingDown, Pencil, Trash2, Upload, Landmark } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { Breadcrumbs, Card, DataTable, StatusBadge, useToast, Modal, ErrorNote, Note, ConfirmDialog, PageHeader, RecordHeader, RecordSkeleton, SkeletonTable, SubPanel, Tabs, TabPanel, ToggleGroup, ICON, type Column } from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { PriceListUploadModal, SUBMISSION_STATUS, submissionMonthLabel } from '../components/PriceListUpload';
import { Scorecard, RatingStars, PriceSparkline, fmtOtdPct, hasReportableOtd, OTD_MIN_SAMPLES, fmtLeadDays, type SupplierMetrics, type ScoreItem, type ScoreTone } from '../components/supplier-metrics';
import { canStartSupplierCommerce, SUPPLIER_STATUS, PO_STATUS, INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, CREDIT_STATUS, CREDIT_REASON } from '../lib/status';
import { fmtMoneyExact, fmtNum, fmtDate, fmtDays, productLabel } from '../lib/format';
import type { Supplier, Category, PurchaseOrder, Invoice, Payment, CreditRequest, SupplierStatus, SupplierProduct, PriceHistory, SupplierPriceSubmission, SupplierBankDetails, SupplierBankMigrationItem, MoneyAmount } from '../lib/types';
import { MoneyByCurrency } from '../components/Money';
import { SUPPLIER_COLUMNS } from '../lib/supplierColumns';
import { OPTIONAL_REASON_LABEL_KEY, reasonOr } from '../lib/reason';
import { SupplierCommunicationCard } from '../components/SupplierCommunicationCard';
import { readFinancialSupplierBankAccount, readSupplierBankMigrationItem } from '../lib/financialSuppliers';
import { EntityMonogram } from '../components/EntityMonogram';

// suppliers.rating* are added in migration 0011. The hand-written Supplier type (types.ts) is
// read-only this wave and does not carry them yet, so extend it locally.
type SupplierRow = Supplier & {
  rating: number | null;
  rating_updated_at: string | null;
  rating_note: string | null;
};

type PricedProduct = SupplierProduct & {
  product: { id: string; name: string; display_name: string | null; unit: string };
};

interface SupplierWithBalance extends SupplierRow {
  /**
   * ONE ENTRY PER CURRENCY (0218, #277) — the row this whole campaign is about. A supplier owed
   * ₪12,400 and $3,100 has two balances managed separately, and `Map` keyed by supplier alone was
   * exactly the place the second one used to be overwritten by the first.
   * `null` = the balance reader is owner-gated for this caller, which is not the same claim as
   * "nothing is owed".
   */
  open_balances?: MoneyAmount[] | null;
  categories?: string[];
  metrics?: SupplierMetrics;
}

// On-time tone: green ≥90 / amber ≥75 / red <75 — but slate below the reportable sample size. A
// red tag drawn from 3 deliveries is a confident lie; a null pct (no promised dates at all) is
// slate too. The sample threshold itself is `hasReportableOtd` in supplier-metrics.tsx and is
// shared with /analytics (ruling #356) — this file used to spell it out a second time, and the
// tile below it gated the same word at `otd_samples > 0`.
function otdTone(m: SupplierMetrics | null | undefined): ScoreTone {
  if (!hasReportableOtd(m)) return 'idle';
  if (m.on_time_pct >= 90) return 'done';
  if (m.on_time_pct >= 75) return 'await';
  return 'alert';
}

// The one decision-support column: open exceptions + open credits, empty (calm) when clean.
function RiskCell({ m }: { m?: SupplierMetrics }) {
  const { t } = useT();
  const ex = m?.open_exceptions ?? 0;
  const cr = m?.open_credits ?? 0;
  if (!ex && !cr) return <span className="text-ink-muted">—</span>;
  return (
    <span className="flex items-center gap-1">
      {/* Singular is not a rounding error in Hebrew: the plural form read "1 חריגים" on every
          supplier that had exactly one, in both the table and the mobile card. */}
      {ex > 0 && <span className="badge-alert">{ex} {ex === 1 ? t('suppliers.text_2') : t('suppliers.text_3')}</span>}
      {cr > 0 && <span className="badge-await">{cr} {cr === 1 ? t('suppliers.text_4') : t('suppliers.text_5')}</span>}
    </span>
  );
}

export function SuppliersList() {
  const { errorText, statusLabel, t } = useT();
  const navigate = useNavigate();
  const { profile, org, organizationAccess } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState<SupplierRow | null | 'new'>(null);
  const [priceUploadFor, setPriceUploadFor] = useState<SupplierWithBalance | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SupplierWithBalance | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);

  // p0_supplier_balance_rows stops at owner (0137) on this STAFF page. For office the view
  // answers an empty 200, and rendering that as ₪0.00 is a false measurement — so the query is
  // skipped and every balance cell says — instead (constitution: אפס הוא גם טענה על המציאות).
  const financial = profile?.role === 'owner';

  const { data, loading, error, refetch } = useQuery(async () => {
    // Same shape as the card query (Promise.all): suppliers + balances + metrics in parallel,
    // merged through Maps. The list answers "who needs my attention"; the card answers "why".
    const [supRes, balRes, metRes] = await Promise.all([
      /* Explicit columns, not `*` (0112). `suppliers.bank_details` is no longer selectable by
         any client role — the column privilege was revoked so that no crafted query reaches the
         account money is sent to — and `select('*')` expands to include it, which would fail the
         whole screen. The edit dialog fetches it on demand through financial_supplier_directory.

         SUPPLIER_COLUMNS, not a second copy of it. This query used to spell the list out again,
         and the copy fell behind: `default_currency` arrived on suppliers in 0217 and in the
         shared constant, never here. So `r.default_currency` was undefined on every row of this
         screen and `fmtMoneyExact(amount, undefined)` drew the minimum order as `—` for every
         supplier that had one — a value that was in the database the whole time. */
      supabase.from('suppliers')
        .select(`${SUPPLIER_COLUMNS}, supplier_categories(category_id, categories(name))`)
        .is('deleted_at', null).order('name'),
      financial
        ? supabase.from('supplier_balances_by_currency').select('*')
        : Promise.resolve({ data: [], error: null }),
      supabase.from('supplier_metrics').select('*'),
    ]);
    const suppliers = unwrap(supRes) as (SupplierRow & { supplier_categories: { categories: { name: string } }[] })[];
    const balances = unwrap(balRes) as { supplier_id: string; currency: string; open_balance_in_currency: number }[];
    const metrics = unwrap(metRes) as SupplierMetrics[];
    // A LIST per supplier, not a number. Keying by supplier alone is what dropped a currency.
    const balMap = new Map<string, MoneyAmount[]>();
    for (const balance of balances) {
      const rows = balMap.get(balance.supplier_id) ?? [];
      rows.push({ currency: balance.currency, amount: balance.open_balance_in_currency });
      balMap.set(balance.supplier_id, rows);
    }
    const metMap = new Map(metrics.map((m) => [m.supplier_id, m]));
    return suppliers.map((s) => ({
      ...s,
      open_balances: financial ? (balMap.get(s.id) ?? []) : null,
      categories: s.supplier_categories?.map((c) => c.categories?.name).filter(Boolean),
      metrics: metMap.get(s.id),
    }));
  }, [financial]);

  const canWrite = organizationAccess.canWrite && (profile?.role === 'owner' || profile?.role === 'office');

  // ?balance=open from the dashboard "ספקים עם יתרה פתוחה" card.
  const [balanceFilter, setBalanceFilter] = useParamState('balance');
  const [statusFilter, setStatusFilter] = useParamState('status');
  const rows = useMemo(() => (data ?? []).filter((r) =>
    (balanceFilter !== 'open' || (r.open_balances ?? []).some((entry) => entry.amount > 0))
    && (!statusFilter || r.status === statusFilter)
  ), [data, balanceFilter, statusFilter]);

  // Delete guard (adversarial review round): a soft-deleted supplier vanishes from the lists
  // while money is still owed to them or goods are still on their way — the open balance and
  // the in-flight orders would go dark. Both checks run FRESH (not off the possibly-stale list
  // merge): the supplier_balances view for open money, purchase_orders outside the terminal
  // statuses for in-flight activity.
  //
  // 'draft' counts as terminal here (owner decision, 19.08.2026) and the same list lives in
  // soft_delete_supplier (0146): an order that was never sent commits the business to nothing.
  // The two rejections also stopped sharing one sentence — a forgotten draft used to be reported
  // as an open balance, which is what sent the owner looking for money that was not there.
  async function requestDelete(s: SupplierWithBalance) {
    // The balance reader is owner-gated (0137): for any other role it answers an empty 200,
    // which this guard would mistake for "no money owed" and let the supplier vanish while
    // invoices are open. Unprovable = refuse, same as a failed check.
    if (!financial) {
      toast(t('suppliers.toast'), 'error');
      return;
    }
    const [balRes, poRes] = await Promise.all([
      supabase.from('supplier_balances_by_currency').select('open_balance_in_currency').eq('supplier_id', s.id),
      supabase.from('purchase_orders').select('id', { count: 'exact', head: true })
        .eq('supplier_id', s.id).not('status', 'in', '(draft,received,cancelled)'),
    ]);
    const err = balRes.error ?? poRes.error;
    // If the check itself failed we cannot prove the supplier is safe to delete — refuse.
    if (err) { toast(errorText(err.message), 'error'); return; }
    // ANY currency in which this supplier is still owed money blocks the deletion. A netting
    // across currencies is exactly how a supplier with a dollar debt and a shekel credit could
    // have been deleted with money outstanding — the server's own guard was fixed the same way.
    const openBalance = ((balRes.data ?? []) as { open_balance_in_currency: number }[])
      .reduce((worst, row) => Math.max(worst, row.open_balance_in_currency), 0);
    if (openBalance > 0) {
      toast(t('suppliers.toast_2'), 'error');
      return;
    }
    if ((poRes.count ?? 0) > 0) {
      toast(t('suppliers.toast_3'), 'error');
      return;
    }
    setDeleteTarget(s);
  }

  // Soft delete only (CLAUDE.md): deleted_at is stamped, the financial history stays. The list
  // query already filters .is('deleted_at', null), so refetch drops the row.
  async function deleteSupplier(reason?: string) {
    if (!deleteTarget) return;
    setBusyDelete(true);
    const res = await supabase.rpc('soft_delete_supplier', {
      p_supplier_id: deleteTarget.id,
      p_reason: reason ?? null,
    });
    setBusyDelete(false);
    if (res.error) { setDeleteTarget(null); toast(errorText(res.error.message), 'error'); return; }
    setDeleteTarget(null);
    toast(t('suppliers.toast_4'));
    void refetch();
  }

  const columns: Column<SupplierWithBalance>[] = [
    { key: 'name', header: t('suppliers.text_6'), priority: 3, sortValue: (r) => r.name, render: (r) => (
      <span className="inline-flex min-w-0 items-center gap-2.5">
        {/* Seeded from the id, not the name: renaming a supplier must not move its mark, or the
            mark stops being an identity and becomes a second spelling of the name. */}
        <EntityMonogram name={r.name} seed={r.id} size="sm" />
        <span className="min-w-0 truncate font-medium text-ink">{r.name}</span>
      </span>
    ) },
    { key: 'rating', header: t('suppliers.text_7'), priority: 3, className: 'num', sortValue: (r) => r.rating ?? 0, render: (r) => r.rating != null
        ? <span className="inline-flex items-center gap-1"><Star size={ICON.xs} className="fill-star text-star" aria-hidden="true" />{r.rating}</span>
        : <span className="text-ink-muted">—</span> },
    { key: 'cats', header: t('suppliers.join'), priority: 3, render: (r) => <span className="text-ink-muted">{r.categories?.join(', ') || '—'}</span> },
    { key: 'contact', header: t('suppliers.text_8'), priority: 3, render: (r) => r.contact_name || '—' },
    { key: 'phone', header: t('suppliers.text_9'), render: (r) => <span dir="ltr">{r.phone || '—'}</span> },
    { key: 'min', header: t('suppliers.fmtMoneyExact'), priority: 3, className: 'num', sortValue: (r) => r.min_order_amount ?? 0, render: (r) => fmtMoneyExact(r.min_order_amount, r.default_currency) },
    { key: 'risk', header: t('suppliers.text_10'), mobileLabel: null, render: (r) => <RiskCell m={r.metrics} /> },
    {
      key: 'balance', header: t('suppliers.balanceHeader'), className: 'num',
      /* Sorted on the organisation's own currency: a column holding two currencies has no single
         ordering, and ranking by "the first entry" would order the table by whichever currency
         came back first. */
      sortValue: (r) => r.open_balances?.find((entry) => entry.currency === org?.base_currency)?.amount ?? 0,
      render: (r) => (r.open_balances == null
        ? <span className="num">—</span>
        : <MoneyByCurrency amounts={r.open_balances} baseCurrency={org?.base_currency}
            className={r.open_balances.some((entry) => entry.amount > 0) ? 'text-await-fg font-medium' : ''} />),
    },
    { key: 'status', header: t('suppliers.text_11'), priority: 3, render: (r) => <StatusBadge meta={SUPPLIER_STATUS[r.status]} /> },
  ];

  if (loading) return <SkeletonTable cols={7} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <PageHeader title={t('suppliers.title')}
        meta={financial
          ? t('suppliers.listMetaFinancial', {
            count: data?.length ?? 0,
            withBalance: (data ?? []).filter((supplier) => (supplier.open_balances ?? []).some((b) => b.amount > 0)).length,
          })
          : t('suppliers.listMeta', { count: data?.length ?? 0 })}
        actions={canWrite && <button data-tour-anchor="suppliers-new" className="btn-primary" onClick={() => setEditing('new')}><Plus size={ICON.sm} aria-hidden="true" /> {t('suppliers.setEditing')}</button>} />
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.name.toLowerCase().includes(q) || (r.contact_name ?? '').toLowerCase().includes(q) || (r.tax_id ?? '').toLowerCase().includes(q)}
        searchLabel={t('suppliers.searchLabel')}
        columnPicker="suppliers"
        rowLabel={(r) => t('suppliers.rowLabel', { name: r.name })}
        onRowClick={(r) => navigate(`/suppliers/${r.id}`)}
        mobile="cards"
        mobileTitle={(r) => (
          /* The mark belongs on the phone MORE than on the table — that is the viewport where a
             scan replaces reading. `mobileTitle` OVERRIDES the first column's render, so without
             this the disc existed only in the hidden desktop branch: the DOM had it, the phone
             did not, and only a screenshot showed the difference. */
          <span className="inline-flex min-w-0 items-center gap-2.5">
            <EntityMonogram name={r.name} seed={r.id} size="sm" />
            <span className="min-w-0 truncate">{r.name}</span>
          </span>
        )}
        mobileTrailing={(r) => <StatusBadge meta={SUPPLIER_STATUS[r.status]} />}
        rowActions={canWrite ? (r) => [
          { key: 'edit', label: t('suppliers.setEditing_2'), icon: Pencil, onSelect: () => setEditing(r) },
          ...(canStartSupplierCommerce(r.status) ? [
            { key: 'price-list', label: t('suppliers.setPriceUploadFor'), icon: Upload, onSelect: () => setPriceUploadFor(r) },
          ] : []),
          { key: 'delete', label: t('suppliers.requestDelete'), icon: Trash2, tone: 'danger', onSelect: () => void requestDelete(r) },
        ] : undefined}
        activeFilters={(balanceFilter === 'open' ? 1 : 0) + (statusFilter ? 1 : 0)}
        onClearFilters={() => { setBalanceFilter(''); setStatusFilter(''); }}
        toolbar={
          <>
            <select className="input w-auto!" aria-label={t('suppliers.aria_label')} value={balanceFilter} onChange={(e) => setBalanceFilter(e.target.value)}>
              <option value="">{t('suppliers.text_12')}</option>
              <option value="open">{t('suppliers.text_13')}</option>
            </select>
            <select className="input w-auto!" aria-label={t('suppliers.aria_label_2')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">{t('suppliers.text_14')}</option>
              {Object.entries(SUPPLIER_STATUS).map(([k, v]) => <option key={k} value={k}>{statusLabel(v)}</option>)}
            </select>
          </>
        }
        emptyTitle={t('suppliers.emptyTitle')}
        emptySubtitle={t('suppliers.emptySubtitle')}
        emptyAction={canWrite && <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={ICON.sm} aria-hidden="true" /> {t('suppliers.setEditing_3')}</button>} />
      {editing && <SupplierForm supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refetch(); }} />}
      {priceUploadFor && (
        <PriceListUploadModal supplier={{ id: priceUploadFor.id, name: priceUploadFor.name }}
          onClose={() => setPriceUploadFor(null)} onImported={() => void refetch()} />
      )}

      <ConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}
        onConfirm={(reason) => void deleteSupplier(reason)}
        title={t('suppliers.title_2')}
        message={t('suppliers.deleteMessage', { name: deleteTarget?.name ?? '' })}
        confirmLabel={t('suppliers.confirmLabel')} danger requireReason busy={busyDelete} />
    </div>
  );
}

/**
 * What the audit ledger records when the optional reason box was left empty (#299). The server
 * refuses a blank `p_reason` outright (`supplier_bank_details_reason_required`, 22023), so this is
 * not decoration — it is the string that keeps a legitimate change from failing at the boundary.
 */
const BANK_DETAILS_ACTION = 'עדכון פרטי בנק של ספק';

// Exported for the wave-4 bank-details spec; the app itself reaches it only through this file.
export function SupplierForm({ supplier, onClose, onSaved, focus }: {
  supplier: SupplierRow | null;
  onClose: () => void;
  onSaved: () => void;
  /**
   * G1, finding 15. The secure bank-details path (reason + fresh password + audit, 0061:471-490)
   * had no entrance except /suppliers → find → עריכה → scroll — five clicks and two dialogs from
   * the dashboard, and every existing link to /suppliers/:id lands on the read-only card. With
   * `?edit=bank` the card can open this form directly; focusing the field is what makes that
   * "directly" true rather than merely "the right modal is up".
   */
  focus?: 'bank';
}) {
  const { errorText, statusLabel, t } = useT();
  const { profile } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // The dedicated bank-details step (migration 0061). `suppliers.bank_details` left the direct
  // UPDATE column grant in 0061; changing it goes through `update_supplier_bank_details`
  // (step-up + mandatory reason + audit). `bankStep` holds the new value while the step-up
  // dialog is up.
  //
  // #299: this used to be TWO full-screen interruptions in a row for one action — a ConfirmDialog
  // that existed only to collect a reason, and then the password prompt. The reason box moved into
  // the password prompt itself, so the person is stopped once. Nothing about the gate moved with
  // it: `update_supplier_bank_details` still calls `assert_recent_password_authentication()`
  // (`0171:314`), and the only thing that ever satisfied it was a fresh password `amr` entry.
  const [bankStep, setBankStep] = useState<{ nextBank: SupplierBankDetails | null; supplierId: string } | null>(null);
  /**
   * Which state that single dialog is in.
   *
   * `'ask'` is the first pass: a session whose JWT already carries a fresh password proof skips the
   * prompt, exactly as it did before — the server accepts that same proof, so asking would be
   * asking for a password the user typed seconds ago.
   *
   * `'retry'` is what a rejected write leaves behind, and it turns the skip OFF. Re-opening a
   * skipping dialog after a failure would re-fire the write by itself, forever; and after a refused
   * sensitive write, asking for the password again is stricter than the first pass, never weaker.
   *
   * It also has to be separate state from `bankStep`: `onConfirm` must close the dialog in the same
   * tick it hands back the session, because a successful `signInWithPassword` refreshes the session
   * and would otherwise make the still-open dialog "fresh" and fire the write a second time.
   */
  const [bankPrompt, setBankPrompt] = useState<'closed' | 'ask' | 'retry'>('closed');
  const [bankBusy, setBankBusy] = useState(false);
  const [legacyBank, setLegacyBank] = useState<SupplierBankMigrationItem | null>(null);
  const [bankLoadError, setBankLoadError] = useState<string | null>(null);
  const bankTouchedRef = useRef(false);
  const [bankTouched, setBankTouched] = useState(false);
  const [bank, setBank] = useState({
    kind: '' as '' | 'IL' | 'international',
    account_holder: '', country_code: '', bank_code: '', branch_code: '',
    account_number: '', iban: '', bic: '',
  });

  const [f, setF] = useState({
    name: supplier?.name ?? '', tax_id: supplier?.tax_id ?? '', contact_name: supplier?.contact_name ?? '',
    phone: supplier?.phone ?? '', whatsapp: supplier?.whatsapp ?? '', email: supplier?.email ?? '',
    address: supplier?.address ?? '', min_order_amount: supplier?.min_order_amount?.toString() ?? '',
    payment_terms: supplier?.payment_terms ?? '',
    notes: supplier?.notes ?? '', status: (supplier?.status ?? 'active') as SupplierStatus,
    delivery_days: supplier?.delivery_days ?? [] as number[],
    cutoff_time: supplier?.cutoff_time?.slice(0, 5) ?? '',
    rating: (supplier?.rating ?? null) as number | null,
    rating_note: supplier?.rating_note ?? '',
  });

  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));

  const setBankField = (key: keyof typeof bank, value: string) => {
    bankTouchedRef.current = true;
    setBankTouched(true);
    setBank((current) => ({ ...current, [key]: value }));
  };

  useEffect(() => {
    if (!supplier) return;
    let cancelled = false;
    void Promise.all([
      readFinancialSupplierBankAccount(supplier.id),
      readSupplierBankMigrationItem(supplier.id),
    ]).then(([current, legacy]) => {
      if (cancelled) return;
      setLegacyBank(legacy);
      setBankLoadError(null);
      if (!current || bankTouchedRef.current) return;
      setBank({
        kind: current.country_code === 'IL' ? 'IL' : 'international',
        account_holder: current.account_holder,
        country_code: current.country_code === 'IL' ? '' : current.country_code,
        bank_code: current.bank_code ?? '',
        branch_code: current.branch_code ?? '',
        account_number: current.account_number ?? '',
        iban: current.iban ?? '',
        bic: current.bic ?? '',
      });
    }).catch((error) => {
      if (!cancelled) setBankLoadError(errorText(error));
    });
    return () => { cancelled = true; };
  }, [supplier]);

  const bankFieldRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (focus !== 'bank') return;
    // After the modal has taken its own initial focus, otherwise the dialog wins the race.
    const frame = requestAnimationFrame(() => {
      bankFieldRef.current?.focus();
      bankFieldRef.current?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  function bankPayload(): SupplierBankDetails | null {
    if (!bank.kind) return null;
    const accountHolder = bank.account_holder.trim();
    if (!accountHolder) throw new Error(t('suppliers.Error'));
    if (bank.kind === 'IL') {
      const bankCode = bank.bank_code.replace(/\s+/g, '');
      const branchCode = bank.branch_code.replace(/\s+/g, '');
      const accountNumber = bank.account_number.replace(/\s+/g, '');
      if (!/^\d{1,3}$/.test(bankCode)
          || !/^\d{1,3}$/.test(branchCode)
          || !/^[0-9-]{1,20}$/.test(accountNumber)) {
        throw new Error(t('suppliers.Error_2'));
      }
      return {
        account_holder: accountHolder,
        country_code: 'IL',
        bank_code: bankCode,
        branch_code: branchCode,
        account_number: accountNumber,
        iban: null,
        bic: null,
      };
    }
    const countryCode = bank.country_code.trim().toUpperCase();
    const iban = bank.iban.replace(/\s+/g, '').toUpperCase();
    const bic = bank.bic.replace(/\s+/g, '').toUpperCase() || null;
    if (!/^[A-Z]{2}$/.test(countryCode)
        || !/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)
        || iban.slice(0, 2) !== countryCode
        || (bic && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(bic))) {
      throw new Error(t('suppliers.Error_3'));
    }
    return {
      account_holder: accountHolder,
      country_code: countryCode,
      bank_code: null,
      branch_code: null,
      account_number: null,
      iban,
      bic,
    };
  }

  async function save() {
    if (!f.name.trim()) { toast(t('suppliers.trim'), 'error'); return; }
    let nextBank: SupplierBankDetails | null | undefined;
    if (bankTouched) {
      if (bankLoadError) { toast(t('suppliers.toast_5'), 'error'); return; }
      try {
        nextBank = bankPayload();
      } catch (error) {
        toast(errorText(error), 'error');
        return;
      }
    }
    setBusy(true);
    const newRating = f.rating || null; // 0 (cleared) → null; DB checks 1..5
    const ratingChanged = newRating !== (supplier?.rating ?? null);
    // bank_details is deliberately absent from this row in BOTH directions now: 0061 revoked
    // the UPDATE column grant, and 0088 (#106, decided 09.08.2026) revoked INSERT too — so a
    // non-empty value entered while creating goes through the same reasoned step-up RPC a
    // change does. Sending the column on either write would fail the whole save.
    const row = {
      name: f.name.trim(), tax_id: f.tax_id || null, contact_name: f.contact_name || null,
      phone: f.phone || null, whatsapp: f.whatsapp || null, email: f.email || null, address: f.address || null,
      min_order_amount: f.min_order_amount ? Number(f.min_order_amount) : null,
      payment_terms: f.payment_terms || null, notes: f.notes || null,
      status: f.status, delivery_days: f.delivery_days, cutoff_time: f.cutoff_time || null,
      rating: newRating, rating_note: f.rating_note || null,
      // Timestamp moves only when the rating itself changed — otherwise "עודכן {date}" would lie.
      rating_updated_at: ratingChanged ? new Date().toISOString() : (supplier?.rating_updated_at ?? null),
    };
    if (supplier) {
      const res = await supabase.from('suppliers').update(row).eq('id', supplier.id);
      setBusy(false);
      if (res.error) { toast(errorText(res.error.message), 'error'); return; }
      if (nextBank !== undefined) { startBankStep(nextBank, supplier.id); return; }
      toast(t('suppliers.toast_6'));
      onSaved();
    } else {
      const res = await supabase.from('suppliers')
        .insert({ ...row, org_id: profile!.org_id }).select('id').single();
      setBusy(false);
      if (res.error) { toast(errorText(res.error.message), 'error'); return; }
      // `nextBank` truthiness, not `!== undefined`: on a NEW supplier `null` means the user opened
      // the bank select and chose "ללא פרטי בנק", i.e. saved nothing. There is no prior value to
      // clear on a row that was just inserted bank-less, so demanding a reason and a password
      // step-up here would be a step-up for a no-op. On an EXISTING supplier `null` is a real
      // change — erasing details that are there — and keeps the `!== undefined` test above.
      if (nextBank) {
        // #106: the row exists bank-less; the details now take the same reasoned step-up
        // path a change to an existing supplier takes.
        toast(t('suppliers.toast_7'));
        startBankStep(nextBank, (res.data as { id: string }).id);
        return;
      }
      toast(t('suppliers.toast_8'));
      onSaved();
    }
  }

  function startBankStep(nextBank: SupplierBankDetails | null, supplierId: string) {
    setBankStep({ nextBank, supplierId });
    setBankPrompt('ask');
  }

  async function saveBankDetails(reason: string) {
    if (!bankStep) return;
    setBankBusy(true);
    const res = await supabase.rpc('update_supplier_bank_details', {
      p_supplier_id: bankStep.supplierId,
      p_bank_details: bankStep.nextBank,
      // Already non-blank — `reasonOr` ran at the call site, and the server raises
      // `supplier_bank_details_reason_required` (22023) on anything that trims to nothing.
      p_reason: reason,
    });
    setBankBusy(false);
    // On failure the step-up dialog comes back for a retry — this time without the fresh-JWT skip,
    // so the retry is a deliberate act. The other fields are already saved.
    if (res.error) { toast(errorText(res.error.message), 'error'); setBankPrompt('retry'); return; }
    toast(t('suppliers.toast_9'));
    setBankStep(null);
    onSaved();
  }

  // Cancelling the bank step is not a silent no-op: the other fields were already saved, and the
  // user must hear that the bank change specifically did not happen.
  function cancelBankStep() {
    setBankStep(null);
    setBankPrompt('closed');
    toast(t('suppliers.toast_10'), 'error');
    onSaved();
  }

  const days = [t('suppliers.text_15'), t('suppliers.text_16'), t('suppliers.text_17'), t('suppliers.text_18'), t('suppliers.text_19'), t('suppliers.text_20'), t('suppliers.text_21')];

  return (
    <Modal open onClose={onClose} title={supplier ? t('suppliers.editTitle', { name: supplier.name }) : t('suppliers.newTitle')} wide
      busy={busy || bankBusy}
      statusMessage={busy ? t('suppliers.savingStatus') : bankBusy ? t('suppliers.savingBankStatus') : undefined}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div><label className="label" htmlFor="supplier-name">{t('suppliers.set')}</label><input id="supplier-name" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div><label className="label" htmlFor="supplier-tax-id">{t('suppliers.set_2')}</label><input id="supplier-tax-id" className="input" dir="ltr" value={f.tax_id} onChange={(e) => set('tax_id', e.target.value)} /></div>
        <div><label className="label" htmlFor="supplier-contact">{t('suppliers.set_3')}</label><input id="supplier-contact" className="input" value={f.contact_name} onChange={(e) => set('contact_name', e.target.value)} /></div>
        <div><label className="label" htmlFor="supplier-phone">{t('suppliers.set_4')}</label><input id="supplier-phone" className="input" dir="ltr" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        <div><label className="label" htmlFor="supplier-whatsapp">WhatsApp</label><input id="supplier-whatsapp" className="input" dir="ltr" value={f.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} /></div>
        <div><label className="label" htmlFor="supplier-email">{t('suppliers.set_5')}</label><input id="supplier-email" className="input" dir="ltr" value={f.email} onChange={(e) => set('email', e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="supplier-address">{t('suppliers.set_6')}</label><input id="supplier-address" className="input" value={f.address} onChange={(e) => set('address', e.target.value)} /></div>
        <div>
          <span className="label">{t('suppliers.text_22')}</span>
          <ToggleGroup label={t('suppliers.label')}
            items={days.map((d, i) => ({ key: String(i), label: d }))}
            value={f.delivery_days.map(String)}
            onChange={(key) => {
              const day = Number(key);
              set('delivery_days', f.delivery_days.includes(day)
                ? f.delivery_days.filter((x) => x !== day)
                : [...f.delivery_days, day].sort());
            }} />
        </div>
        <div><label className="label" htmlFor="supplier-cutoff">{t('suppliers.set_7')}</label><input id="supplier-cutoff" type="time" className="input" value={f.cutoff_time} onChange={(e) => set('cutoff_time', e.target.value)} /></div>
        {/* The currency comes from the supplier row, never from a symbol typed into the label.
            `currency-baseline.json` records that min_order_amount is stated in
            `suppliers.default_currency`, and a euro supplier's minimum was being labelled ₪.
            A supplier that does not exist yet has no currency to name, so the label does not
            invent one — it says where the currency comes from instead. */}
        <div><label className="label" htmlFor="supplier-minimum">{supplier ? t('suppliers.minimumOrderInCurrency', { currency: supplier.default_currency }) : t('suppliers.fmtMoneyExact_3')}</label><input id="supplier-minimum" type="number" className="input num" value={f.min_order_amount} onChange={(e) => set('min_order_amount', e.target.value)} />{!supplier && <p className="text-xs text-ink-muted mt-1">{t('suppliers.minimumOrderCurrencyHint')}</p>}</div>
        <div><label className="label" htmlFor="supplier-payment-terms">{t('suppliers.text_23')}</label><input id="supplier-payment-terms" className="input" placeholder={t('suppliers.placeholder')} value={f.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} /></div>
        <SubPanel className="sm:col-span-2 space-y-3">
          <div>
            <label className="label" htmlFor="supplier-bank-kind">{t('suppliers.text_24')}</label>
            <select id="supplier-bank-kind" ref={bankFieldRef} className="input" value={bank.kind}
              onChange={(event) => setBankField('kind', event.target.value)}>
              <option value="">{t('suppliers.text_25')}</option>
              <option value="IL">{t('suppliers.text_26')}</option>
              <option value="international">{t('suppliers.text_27')}</option>
            </select>
          </div>
          {legacyBank && (
            <Note tone="await">
              <span className="block font-medium">{t('suppliers.text_28')}</span>
              <span className="block mt-1" dir="ltr">{legacyBank.legacy_bank_details}</span>
              <span className="block mt-1">{t('suppliers.text_29')}</span>
            </Note>
          )}
          {bankLoadError && <ErrorNote message={t('suppliers.message')} />}
          {bank.kind && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2"><label className="label" htmlFor="supplier-bank-holder">{t('suppliers.setBankField')}</label><input id="supplier-bank-holder" className="input" value={bank.account_holder} onChange={(event) => setBankField('account_holder', event.target.value)} /></div>
              {bank.kind === 'IL' ? (
                <>
                  <div><label className="label" htmlFor="supplier-bank-code">{t('suppliers.setBankField_2')}</label><input id="supplier-bank-code" inputMode="numeric" dir="ltr" className="input" value={bank.bank_code} onChange={(event) => setBankField('bank_code', event.target.value)} /></div>
                  <div><label className="label" htmlFor="supplier-bank-branch">{t('suppliers.setBankField_3')}</label><input id="supplier-bank-branch" inputMode="numeric" dir="ltr" className="input" value={bank.branch_code} onChange={(event) => setBankField('branch_code', event.target.value)} /></div>
                  <div className="sm:col-span-2"><label className="label" htmlFor="supplier-bank-account">{t('suppliers.setBankField_4')}</label><input id="supplier-bank-account" inputMode="numeric" dir="ltr" className="input" value={bank.account_number} onChange={(event) => setBankField('account_number', event.target.value)} /></div>
                </>
              ) : (
                <>
                  <div><label className="label" htmlFor="supplier-bank-country">{t('suppliers.setBankField_5')}</label><input id="supplier-bank-country" maxLength={2} dir="ltr" className="input uppercase" value={bank.country_code} onChange={(event) => setBankField('country_code', event.target.value)} /></div>
                  <div><label className="label" htmlFor="supplier-bank-bic">BIC / SWIFT</label><input id="supplier-bank-bic" dir="ltr" className="input uppercase" value={bank.bic} onChange={(event) => setBankField('bic', event.target.value)} /></div>
                  <div className="sm:col-span-2"><label className="label" htmlFor="supplier-bank-iban">IBAN *</label><input id="supplier-bank-iban" dir="ltr" className="input uppercase" value={bank.iban} onChange={(event) => setBankField('iban', event.target.value)} /></div>
                </>
              )}
            </div>
          )}
        </SubPanel>
        <div>
          <label className="label" htmlFor="supplier-status">{t('suppliers.text_30')}</label>
          <select id="supplier-status" className="input" value={f.status} onChange={(e) => set('status', e.target.value)}
            aria-describedby="supplier-status-hint">
            {Object.entries(SUPPLIER_STATUS).map(([k, v]) => <option key={k} value={k}>{statusLabel(v)}</option>)}
          </select>
          {/* OPEN-DECISIONS #115, decided 09.08.2026 (owner delegated): `inactive` means
              "לא להזמין ממנו יותר" — the procurement doors close (new order, price-list upload),
              the money doors stay open so an open account can still be settled. Deliberately NOT
              filtered: invoice intake, payment requests, bank matching, documents, analytics —
              an invoice from a supplier deactivated yesterday is the commonest event after
              deactivation, and blocking it would manufacture the dead end #115 warned about. */}
          <p id="supplier-status-hint" className="mt-1 text-xs text-ink-muted">
            {t('suppliers.text_31')}{' '}
            {t('suppliers.text_32')}
          </p>
        </div>
        <fieldset>
          <legend className="label">{t('suppliers.text_33')}</legend>
          <div className="pt-1"><RatingStars value={f.rating} onChange={(n) => set('rating', n || null)} /></div>
        </fieldset>
        <div className="sm:col-span-2"><label className="label" htmlFor="supplier-rating-note">{t('suppliers.text_34')}</label><input id="supplier-rating-note" className="input" placeholder={t('suppliers.placeholder_2')} value={f.rating_note} onChange={(e) => set('rating_note', e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="supplier-notes">{t('suppliers.set_9')}</label><textarea id="supplier-notes" className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" disabled={busy} onClick={onClose}>{t('suppliers.text_35')}</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? t('suppliers.save') : t('suppliers.save_2')}</button>
      </div>

      {/* One interruption, not two (#299). The password step is the whole gate; the sentence that
          used to be a separate ConfirmDialog — which account is about to change — is now this
          dialog's description, and the reason box rides along as an optional field.
          `skipWhenFresh={false}`, deliberately, and it is the one place in the app that opts out.
          Everywhere else the skip is a kindness: the server would accept the fresh token anyway,
          so asking again buys nothing. Here it would buy the thing that matters. Collapsing two
          dialogs into one is a fix; collapsing them into none is not — and that is what a fresh
          token would have done, because the ConfirmDialog this replaced was unconditional. This
          field decides which account the money leaves for (#106), so it never changes without a
          person seeing the account and typing something. One interruption, always. */}
      <ReauthModal
        open={bankPrompt !== 'closed'}
        skipWhenFresh={false}
        title={t('suppliers.title_4')}
        details={bankStep?.nextBank
          ? t('suppliers.bankChangeMessage', {
            name: supplier?.name ?? f.name,
            country: bankStep.nextBank.country_code,
            last4: (bankStep.nextBank.account_number ?? bankStep.nextBank.iban ?? '').slice(-4),
          })
          : t('suppliers.bankRemoveMessage', { name: supplier?.name ?? f.name })}
        reasonLabel={t(OPTIONAL_REASON_LABEL_KEY)}
        onConfirm={(_session, reason) => {
          setBankPrompt('closed');
          void saveBankDetails(reasonOr(reason, BANK_DETAILS_ACTION));
        }}
        onCancel={cancelBankStep}
      />
    </Modal>
  );
}

/* ================= Supplier card ================= */
export function SupplierCard() {
  const { locale, statusLabel, t } = useT();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile, organizationAccess } = useAuth();
  const [tab, setTab] = useState<'orders' | 'invoices' | 'payments' | 'credits' | 'prices'>('orders');
  const [editing, setEditing] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  /**
   * G1, finding 15 — `?edit=bank` opens the edit form on the bank field.
   *
   * "ספק הודיע שהחליף מספר חשבון" is a real, recurring, security-sensitive task whose only route
   * was /suppliers → search → עריכה → scroll. The parameter is consumed once and stripped, so a
   * refresh or a Back does not re-open the modal — the same discipline OrderDetail's `?print=1`
   * already uses. Kept as a URL rather than local state precisely so the address is shareable and
   * the other screens that link to this card have something to point at when they need to.
   */
  const [editParam, setEditParam] = useParamState('edit');
  const [editFocus, setEditFocus] = useState<'bank' | undefined>(undefined);

  const { data, loading, error, refetch } = useQuery(async () => {
    const supplier = unwrap(await supabase.from('suppliers').select(SUPPLIER_COLUMNS).eq('id', id!).single()) as SupplierRow;
    // supplier_price_submissions RLS grants SELECT to owner/office (or the supplier itself) —
    // other staff roles skip the query instead of reading an empty result as "no history".
    const staff = profile?.role === 'owner' || profile?.role === 'office';
    // payments_select (0133) and p0_supplier_balance_rows (0137) both stop at owner on this
    // page (accountant never reaches it — the route is STAFF). For office the queries would
    // return empty 200s, and an RLS-emptied result rendered as "0 payments / ₪0.00" is a false
    // claim about the business, not a permission message. Skip, and render — with the reason.
    const financial = profile?.role === 'owner';
    const [orders, invoices, consolidated, payments, credits, balance, metrics, sps, submissions] = await Promise.all([
      supabase.from('purchase_orders').select('*').eq('supplier_id', id!).order('created_at', { ascending: false }).limit(50),
      supabase.from('invoices').select('*').eq('supplier_id', id!).eq('financial_role', 'payable').is('deleted_at', null).order('invoice_date', { ascending: false }).limit(50),
      // Not rows — one count. Invoices a consolidated case demoted to supporting_evidence are
      // deliberately absent from the table (0137: "not an ordinary invoice anywhere"), but their
      // absence must be explained or the tab reads as out of sync with the documents gallery.
      supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('supplier_id', id!).eq('financial_role', 'supporting_evidence').is('deleted_at', null),
      financial
        ? supabase.from('payments').select('*').eq('supplier_id', id!).order('paid_date', { ascending: false }).limit(50)
        : Promise.resolve({ data: null as Payment[] | null, error: null }),
      supabase.from('credit_requests').select('*').eq('supplier_id', id!).order('created_at', { ascending: false }).limit(50),
      financial
        ? supabase.from('supplier_balances_by_currency').select('*').eq('supplier_id', id!)
        : Promise.resolve({ data: null, error: null }),
      supabase.from('supplier_metrics').select('*').eq('supplier_id', id!).maybeSingle(), // maybeSingle: a role-guarded view may return no row
      supabase.from('supplier_products').select('*, product:products(id,name,display_name,unit)').eq('supplier_id', id!).order('updated_at', { ascending: false }),
      staff
        ? supabase.from('supplier_price_submissions').select('*').eq('supplier_id', id!)
          .order('target_month', { ascending: false }).order('revision', { ascending: false }).limit(12)
        : Promise.resolve({ data: [] as SupplierPriceSubmission[], error: null }),
    ]);
    const prices = unwrap(sps) as PricedProduct[];
    const spIds = prices.map((p) => p.id);
    const history = spIds.length
      ? unwrap(await supabase.from('price_history').select('*').in('supplier_product_id', spIds).order('effective_date', { ascending: true })) as PriceHistory[]
      : [];
    return {
      supplier,
      orders: unwrap(orders) as PurchaseOrder[],
      invoices: unwrap(invoices) as Invoice[],
      consolidatedCount: consolidated.count ?? 0,
      // null = this role may not read payments/balance — a different claim than "none exist",
      // and the render below keeps the two apart (constitution: אפס הוא גם טענה על המציאות).
      payments: financial ? (unwrap(payments) as Payment[]) : null,
      credits: unwrap(credits) as CreditRequest[],
      balances: financial
        ? ((balance.data ?? []) as { currency: string; open_balance_in_currency: number }[])
          .map((row) => ({ currency: row.currency, amount: row.open_balance_in_currency }))
        : null,
      metrics: (metrics.data as SupplierMetrics | null) ?? null,
      prices,
      history,
      submissions: unwrap(submissions) as SupplierPriceSubmission[],
      canSeeSubmissions: staff,
    };
  }, [id]);

  const canWrite = organizationAccess.canWrite && (profile?.role === 'owner' || profile?.role === 'office');

  useEffect(() => {
    if (editParam !== 'bank') return;
    // Read-only staff never get the form; stripping the param regardless keeps a stale link from
    // sitting in the address bar claiming an edit is in progress.
    if (canWrite) { setEditing(true); setEditFocus('bank'); }
    setEditParam('');
  }, [editParam, canWrite, setEditParam]);

  const tabs = useMemo(() => ([
    { key: 'orders' as const, label: t('suppliers.tabOrders', { count: data?.orders.length ?? 0 }) },
    { key: 'invoices' as const, label: t('suppliers.tabInvoices', { count: data?.invoices.length ?? 0 }) },
    // — and not 0: a role that may not read payments has no count to claim.
    { key: 'payments' as const, label: t('suppliers.tabPayments', { count: data?.payments ? data.payments.length : '—' }) },
    { key: 'credits' as const, label: t('suppliers.tabCredits', { count: data?.credits.length ?? 0 }) },
    { key: 'prices' as const, label: t('suppliers.tabPrices', { count: data?.prices.length ?? 0 }) },
  ]), [data]);

  if (loading) return <RecordSkeleton />;
  if (error || !data) return <ErrorNote message={error ?? t('suppliers.text_36')} />;
  const s = data.supplier;
  const m = data.metrics;

  // One card, one grid — the spec sheet (§4.4). Balance + honest metrics; OTD renders — (never
  // 0%) when no promised delivery date was ever recorded (open decision #28, not yet answered).
  const scoreItems: ScoreItem[] = [
    // balance === null means the balance reader is owner-gated for this caller, and a green
    // ₪0.00 there would be a fabricated measurement, not a permission message.
    data.balances === null
      ? { label: t('suppliers.text_37'), value: '—', sub: t('suppliers.text_38'), tone: 'idle' }
      /* THE ROW #277 IS ABOUT. Two currencies are two balances, listed one under the other, and
         never a sum: ₪12,400 plus $3,100 is not 15,500, it is not a number at all. */
      : {
        label: t('suppliers.text_37'),
        value: data.balances.length
          ? data.balances.map((entry) => fmtMoneyExact(entry.amount, entry.currency)).join(' · ')
          : '—',
        tone: data.balances.some((entry) => entry.amount > 0) ? 'await' : 'done',
      },
    {
      label: t('suppliers.text_39'),
      /* RULING #356. This read `otd_samples > 0`, so one delivery was enough to print a
         percentage on a supplier's card — while /analytics claimed five and the tone here
         already used five. Two screens, two rules, one word. */
      value: fmtOtdPct(m),
      /* Three states, not two. The sub-line used to say "no delivery date was entered" for every
         supplier it would not rate, which is false for the ones that have four receipts: they
         have dates, just not enough of them to answer the question. */
      sub: hasReportableOtd(m) ? t('suppliers.otdSamples', { count: m.otd_samples })
        : m && m.otd_samples > 0 ? t('suppliers.otdBelowMinimum', { min: OTD_MIN_SAMPLES })
          : t('suppliers.noDeliveryDate'),
      tone: otdTone(m),
    },
    { label: t('suppliers.fmtLeadDays'), value: fmtLeadDays(m?.avg_lead_days ?? null, locale), sub: t('suppliers.fmtLeadDays_2'), tone: 'idle' },
    // No supplier_metrics row = the counts were never computed, which is not the same claim as
    // "zero open exceptions". fmtNum(null) renders — so the tile stays honest (constitution §"אין ערכים
    // סטטיים מזויפים"), matching how OTD and lead time above already behave.
    { label: t('suppliers.openExceptions'), value: fmtNum(m?.open_exceptions ?? null), sub: m ? t('suppliers.exceptionsLifetime', { count: fmtNum(m.exceptions_lifetime) }) : t('suppliers.metricsNotComputed'), tone: (m?.open_exceptions ?? 0) > 0 ? 'alert' : 'idle' },
    /* 0223: the amount is null when this supplier holds open credits in more than one currency,
       because the view refuses to add them — the count is still true, and the sub-line says so. */
    { label: t('suppliers.fmtNum'), value: fmtNum(m?.open_credits ?? null), sub: fmtMoneyExact(m?.open_credits_amount ?? null, m?.open_credits_currency), tone: (m?.open_credits ?? 0) > 0 ? 'await' : 'idle' },
    { label: t('suppliers.priceChanges90'), value: fmtNum(m?.price_changes_window ?? null), sub: m ? t('suppliers.pricedItems', { count: fmtNum(m.priced_items) }) : t('suppliers.metricsNotComputed'), tone: 'idle' },
    { label: t('suppliers.fmtMoneyExact_3'), value: fmtMoneyExact(s.min_order_amount, s.default_currency), tone: 'idle' },
    { label: t('suppliers.text_40'), value: s.payment_terms ?? '—', tone: 'idle', numeric: false },
  ];

  return (
    <div className="space-y-4">
      <RecordHeader
        breadcrumbs={<Breadcrumbs items={[{ label: t('suppliers.text_41'), to: '/suppliers' }, { label: s.name }]} />}
        title={s.name}
        status={<><StatusBadge meta={SUPPLIER_STATUS[s.status]} /><span className="inline-flex items-center gap-2">
              <RatingStars value={s.rating} />
              {s.rating != null && s.rating_updated_at && (
                <span className="text-xs font-normal text-ink-muted" title={s.rating_note ?? undefined}>{t('suppliers.ratingUpdated', { date: fmtDate(s.rating_updated_at) })}</span>
              )}
            </span></>}
        meta={<>
            {s.contact_name && <span>{s.contact_name}</span>}
            {s.phone && <span className="flex items-center gap-1"><Phone size={ICON.xs} aria-hidden="true" /><span dir="ltr">{s.phone}</span></span>}
            {s.email && <span className="flex items-center gap-1"><Mail size={ICON.xs} aria-hidden="true" /><span dir="ltr">{s.email}</span></span>}
            {s.address && <span className="flex items-center gap-1"><MapPin size={ICON.xs} aria-hidden="true" />{s.address}</span>}
            {s.delivery_days.length > 0 && <span className="flex items-center gap-1"><Truck size={ICON.xs} aria-hidden="true" />{t('suppliers.deliveryDays', { days: fmtDays(s.delivery_days) })}</span>}
            {s.cutoff_time && <span className="flex items-center gap-1"><Clock size={ICON.xs} aria-hidden="true" />{t('suppliers.orderCutoff', { time: s.cutoff_time.slice(0, 5) })}</span>}
          </>}
        primaryAction={canWrite && canStartSupplierCommerce(s.status)
          ? <button className="btn-primary" onClick={() => setUploadOpen(true)}><Upload size={ICON.sm} aria-hidden="true" /> {t('suppliers.setUploadOpen')}</button>
          : null}
        secondaryActions={canWrite && <>
            {/* Named, not buried: "החליף מספר חשבון" is the task, and it used to be four steps
                inside a form of twenty fields. Navigates rather than calling setEditing directly,
                so the address is the one another screen can link to. */}
            <button className="btn-secondary" onClick={() => navigate(`/suppliers/${s.id}?edit=bank`)}>
              <Landmark size={ICON.sm} aria-hidden="true" /> {t('suppliers.updateBankDetails')}
            </button>
            <button className="btn-secondary" onClick={() => setEditing(true)}>{t('suppliers.setEditing_4')}</button>
          </>} />

      <Scorecard items={scoreItems} />

      {s.notes && <Card className="text-sm text-ink-soft">{s.notes}</Card>}

      <SupplierCommunicationCard supplierId={s.id} supplierEmail={s.email}
        supplierPhone={s.whatsapp || s.phone} canWrite={!!canWrite} />


      {/* Tabs generates exactly these ids (tabId/panelId with idPrefix "supplier"), so the
          panels below keep the wiring they already had. */}
      <Tabs items={tabs} value={tab} onChange={(key) => setTab(key as typeof tab)}
        label={t('suppliers.tabsLabel', { name: s.name })} idPrefix="supplier" />

      {tab === 'orders' && (
        <TabPanel idPrefix="supplier" tabKey="orders">
        <DataTable rows={data.orders} columns={[
          { key: 'num', header: t('suppliers.numberHeader'), className: 'num', render: (r: PurchaseOrder) => `#${r.number}` },
          { key: 'date', header: t('suppliers.fmtDate'), sortValue: (r: PurchaseOrder) => r.created_at, render: (r: PurchaseOrder) => fmtDate(r.created_at) },
          { key: 'expected', header: t('suppliers.fmtDate_2'), render: (r: PurchaseOrder) => fmtDate(r.expected_date) },
          { key: 'status', header: t('suppliers.text_43'), render: (r: PurchaseOrder) => <StatusBadge meta={PO_STATUS[r.status]} /> },
        ]} rowLabel={(r) => t('suppliers.orderRowLabel', { number: r.number, supplier: s.name })} onRowClick={(r) => navigate(`/orders/${r.id}`)} emptyTitle={t('suppliers.noOrders')} />
        </TabPanel>
      )}
      {tab === 'invoices' && (
        <TabPanel idPrefix="supplier" tabKey="invoices" className="space-y-3">
        {data.consolidatedCount > 0 && (
          /* One wrapper span: a Note body may mix elements with each other, never with bare
             prose (noteProse.spec — .note is a flex row and shreds raw text into columns). */
          <Note tone="info">
            <span>
              <span className="num">{data.consolidatedCount}</span> {t('suppliers.consolidatedLead')}
              {t('suppliers.text_44')}{' '}
              <button className="underline" onClick={() => navigate('/documents/consolidated-invoices')}>{t('suppliers.navigate')}</button>
            </span>
          </Note>
        )}
        <DataTable rows={data.invoices} columns={[
          { key: 'num', header: t('suppliers.text_45'), className: 'num', render: (r: Invoice) => r.invoice_number },
          { key: 'date', header: t('suppliers.fmtDate_3'), sortValue: (r: Invoice) => r.invoice_date, render: (r: Invoice) => fmtDate(r.invoice_date) },
          { key: 'total', header: t('suppliers.fmtMoneyExact_4'), className: 'num', sortValue: (r: Invoice) => r.total_amount, render: (r: Invoice) => fmtMoneyExact(r.total_amount, r.currency) },
          { key: 'review', header: t('suppliers.text_46'), render: (r: Invoice) => <StatusBadge meta={INVOICE_REVIEW_STATUS[r.review_status]} /> },
          { key: 'payment', header: t('suppliers.text_47'), render: (r: Invoice) => <StatusBadge meta={INVOICE_PAYMENT_STATUS[r.payment_status]} /> },
        ]} rowLabel={(r) => t('suppliers.invoiceRowLabel', { number: r.invoice_number, supplier: s.name })} onRowClick={(r) => navigate(`/invoices/${r.id}`)} emptyTitle={t('suppliers.noInvoices')} />
        </TabPanel>
      )}
      {tab === 'payments' && (
        <TabPanel idPrefix="supplier" tabKey="payments">
        {data.payments ? (
          <DataTable rows={data.payments} columns={[
            { key: 'date', header: t('suppliers.fmtDate_4'), sortValue: (r: Payment) => r.paid_date, render: (r: Payment) => fmtDate(r.paid_date) },
            { key: 'amount', header: t('suppliers.fmtMoneyExact_5'), className: 'num', sortValue: (r: Payment) => r.amount, render: (r: Payment) => fmtMoneyExact(r.amount, r.currency) },
            { key: 'method', header: t('suppliers.text_48'), render: (r: Payment) => r.method ?? '—' },
            { key: 'ref', header: t('suppliers.text_49'), className: 'num', render: (r: Payment) => <span dir="ltr">{r.reference ?? '—'}</span> },
          ]} emptyTitle={t('suppliers.emptyTitle_2')} />
        ) : (
          <Note tone="info">{t('suppliers.text_50')}</Note>
        )}
        </TabPanel>
      )}
      {tab === 'credits' && (
        <TabPanel idPrefix="supplier" tabKey="credits">
        <DataTable rows={data.credits} columns={[
          { key: 'num', header: t('suppliers.numberHeader'), className: 'num', render: (r: CreditRequest) => `#${r.number}` },
          // Resolved, not printed raw: this tab reads the same map `/credits` does, and it had
          // the same defect (`FIN-05`).
          { key: 'reason', header: t('suppliers.statusLabel'), render: (r: CreditRequest) => statusLabel(CREDIT_REASON[r.reason]) },
          { key: 'amount', header: t('suppliers.fmtMoneyExact_6'), className: 'num', sortValue: (r: CreditRequest) => r.amount, render: (r: CreditRequest) => fmtMoneyExact(r.amount, r.currency) },
          { key: 'status', header: t('suppliers.text_51'), render: (r: CreditRequest) => <StatusBadge meta={CREDIT_STATUS[r.status]} /> },
          { key: 'date', header: t('suppliers.fmtDate_5'), sortValue: (r: CreditRequest) => r.created_at, render: (r: CreditRequest) => fmtDate(r.created_at) },
        ]} rowLabel={(r) => t('suppliers.creditRowLabel', { number: r.number, supplier: s.name })} onRowClick={() => navigate('/credits')} emptyTitle={t('suppliers.noCredits')} />
        </TabPanel>
      )}
      {tab === 'prices' && (
        <TabPanel idPrefix="supplier" tabKey="prices">
          <SupplierPricesTab rows={data.prices} history={data.history}
            submissions={data.canSeeSubmissions ? data.submissions : null} />
        </TabPanel>
      )}

      {editing && (
        <SupplierForm supplier={s} focus={editFocus}
          onClose={() => { setEditing(false); setEditFocus(undefined); }}
          onSaved={() => { setEditing(false); setEditFocus(undefined); void refetch(); }} />
      )}
      {uploadOpen && (
        <PriceListUploadModal supplier={{ id: s.id, name: s.name }}
          onClose={() => setUploadOpen(false)} onImported={() => void refetch()} />
      )}
    </div>
  );
}

/**
 * Price trend for one supplier. Kept local because it is not used anywhere else.
 */
function SupplierPricesTab({ rows, history, submissions }: {
  rows: PricedProduct[];
  history: PriceHistory[];
  /** null = the viewer's role cannot read the submissions ledger (not the same as "no history"). */
  submissions: SupplierPriceSubmission[] | null;
}) {
  const { t, locale } = useT();
  const histBySp = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const h of history) {
      const arr = map.get(h.supplier_product_id) ?? [];
      arr.push(h.price);
      map.set(h.supplier_product_id, arr);
    }
    return map;
  }, [history]);

  const changePct = (r: PricedProduct) => r.previous_price ? ((r.current_price - r.previous_price) / r.previous_price) * 100 : 0;

  // The actual decision answer, computed client-side: how many rose / fell, and the median move.
  const summary = useMemo(() => {
    let up = 0, down = 0;
    const pcts: number[] = [];
    for (const r of rows) {
      if (r.previous_price == null) continue;
      const pct = changePct(r);
      if (pct > 0) up++; else if (pct < 0) down++;
      pcts.push(pct);
    }
    pcts.sort((a, b) => a - b);
    const median = pcts.length ? pcts[Math.floor((pcts.length - 1) / 2)] : null;
    return { up, down, median };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const columns: Column<PricedProduct>[] = [
    { key: 'product', header: t('suppliers.productLabel'), sortValue: (r) => productLabel(r.product), render: (r) => <bdi className="font-medium text-ink">{productLabel(r.product)}</bdi> },
    { key: 'price', header: t('suppliers.fmtMoneyExact_7'), className: 'num', sortValue: (r) => r.current_price, render: (r) => <span className="font-semibold">{fmtMoneyExact(r.current_price, r.currency)}</span> },
    { key: 'prev', header: t('suppliers.fmtMoneyExact_8'), className: 'num', render: (r) => fmtMoneyExact(r.previous_price, r.currency) },
    {
      key: 'change', header: t('suppliers.text_52'), sortValue: changePct,
      render: (r) => {
        const pct = changePct(r);
        if (!r.previous_price || pct === 0) return <span className="text-ink-muted">—</span>;
        // Same treatment as PriceLists.tsx:50-56 (LRM keeps the sign on the correct side in RTL),
        // and the same TOKENS: this is a direction of change, not a status claim, so it speaks
        // trend-*. It used to say alert-solid/done-fg — identical values today, which is exactly
        // why the mismatch survived unseen; the two vocabularies stay apart (DESIGN.md §2).
        return pct > 0
          ? <span className="inline-flex items-center gap-1 text-trend-up-fg font-medium"><TrendingUp size={ICON.xs} aria-hidden="true" />{'‎'}+{pct.toFixed(1)}%</span>
          : <span className="inline-flex items-center gap-1 text-trend-down-fg font-medium"><TrendingDown size={ICON.xs} aria-hidden="true" />{'‎'}{pct.toFixed(1)}%</span>;
      },
    },
    {
      key: 'trend', header: t('suppliers.text_53'),
      render: (r) => {
        const pts = histBySp.get(r.id) ?? [];
        return pts.length >= 2 ? <PriceSparkline points={pts} /> : <span className="text-ink-muted">—</span>;
      },
    },
    { key: 'date', header: t('suppliers.fmtDate_6'), sortValue: (r) => r.price_effective_date, render: (r) => fmtDate(r.price_effective_date) },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-4 text-sm">
        <span className="text-ink-soft">{t('suppliers.text_54')} <b className="text-trend-up-fg">{summary.up}</b></span>
        <span className="text-ink-soft">{t('suppliers.text_55')} <b className="text-trend-down-fg">{summary.down}</b></span>
        <span className="text-ink-soft">{t('suppliers.medianChange')} <b className="num">{summary.median == null ? '—' : `${summary.median > 0 ? '+' : ''}${summary.median.toFixed(1)}%`}</b></span>
      </div>
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => productLabel(r.product).toLowerCase().includes(q) || r.product.name.toLowerCase().includes(q)}
        searchLabel={t('suppliers.searchLabel_2')}
        emptyTitle={t('suppliers.emptyTitle_3')} />

      {submissions !== null && (
        <section className="card p-4" aria-labelledby="supplier-card-submissions-heading">
          <h3 id="supplier-card-submissions-heading" className="section-title mb-3">{t('suppliers.text_56')}</h3>
          {submissions.length ? (
            <div className="divide-y divide-line-soft">
              {submissions.map((submission) => (
                <div key={submission.id} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium text-ink">{submissionMonthLabel(submission.target_month, locale)} · {t('suppliers.revisionWord')} <span className="num">{submission.revision}</span></div>
                    <StatusBadge meta={SUBMISSION_STATUS[submission.status]} />
                  </div>
                  <div className="mt-1 text-sm text-ink-muted break-words">
                    <bdi>{submission.file_name ?? t('suppliers.text_57')}</bdi> · {t('suppliers.acceptedWord')} <span className="num">{submission.accepted_count}</span> {t('suppliers.text_58')} <span className="num">{submission.unchanged_count}</span> {t('suppliers.text_59')} <span className="num">{submission.rejected_count}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-ink-muted">{t('suppliers.text_60')}</p>}
        </section>
      )}
    </div>
  );
}

export function useCategories() {
  return useQuery<Category[]>(async () => unwrap(await supabase.from('categories').select('*').order('sort')));
}
