import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useParamState } from '../lib/useParamState';
import { Plus, Phone, Mail, MapPin, Clock, Truck, Star, TrendingUp, TrendingDown, Pencil, Trash2, Upload, Landmark } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { toHebrewError } from '../lib/errors';
import { useAuth } from '../auth/AuthContext';
import { Breadcrumbs, DataTable, StatusBadge, useToast, Modal, ErrorNote, ConfirmDialog, PageHeader, RecordHeader, RecordSkeleton, SkeletonTable, type Column } from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { PriceListUploadModal, SUBMISSION_STATUS, submissionMonthLabel } from '../components/PriceListUpload';
import { Scorecard, RatingStars, PriceSparkline, fmtPct, fmtLeadDays, type SupplierMetrics, type ScoreItem, type ScoreTone } from '../components/supplier-metrics';
import { canStartSupplierCommerce, SUPPLIER_STATUS, PO_STATUS, INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, CREDIT_STATUS, CREDIT_REASON } from '../lib/status';
import { fmtMoneyExact, fmtNum, fmtDate, fmtDays } from '../lib/format';
import type { Supplier, Category, PurchaseOrder, Invoice, Payment, CreditRequest, SupplierStatus, SupplierProduct, PriceHistory, SupplierPriceSubmission } from '../lib/types';
import { SUPPLIER_COLUMNS } from '../lib/supplierColumns';

// suppliers.rating* are added in migration 0011. The hand-written Supplier type (types.ts) is
// read-only this wave and does not carry them yet, so extend it locally.
type SupplierRow = Supplier & {
  rating: number | null;
  rating_updated_at: string | null;
  rating_note: string | null;
};

type PricedProduct = SupplierProduct & { product: { id: string; name: string; unit: string } };

interface SupplierWithBalance extends SupplierRow {
  open_balance?: number;
  categories?: string[];
  metrics?: SupplierMetrics;
}

// On-time tone: green ≥90 / amber ≥75 / red <75 — but slate below 5 samples. A red tag drawn
// from 3 deliveries is a confident lie; a null pct (no promised dates at all) is slate too.
function otdTone(m: SupplierMetrics | null | undefined): ScoreTone {
  if (!m || m.on_time_pct == null || m.otd_samples < 5) return 'idle';
  if (m.on_time_pct >= 90) return 'done';
  if (m.on_time_pct >= 75) return 'await';
  return 'alert';
}

// The one decision-support column: open exceptions + open credits, empty (calm) when clean.
// Raw utility pills rather than badge-* classes — index.css is mid-rewrite by another agent this
// wave; these are visually identical to the app's soft badges but immune to that churn.
function RiskCell({ m }: { m?: SupplierMetrics }) {
  const ex = m?.open_exceptions ?? 0;
  const cr = m?.open_credits ?? 0;
  if (!ex && !cr) return <span className="text-ink-ghost">—</span>;
  return (
    <span className="flex items-center gap-1">
      {/* Singular is not a rounding error in Hebrew: the plural form read "1 חריגים" on every
          supplier that had exactly one, in both the table and the mobile card. */}
      {ex > 0 && <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-alert-soft text-alert-on-soft whitespace-nowrap">{ex} {ex === 1 ? 'חריג' : 'חריגים'}</span>}
      {cr > 0 && <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-await-soft text-await-on-soft whitespace-nowrap">{cr} {cr === 1 ? 'זיכוי' : 'זיכויים'}</span>}
    </span>
  );
}

export function SuppliersList() {
  const navigate = useNavigate();
  const { profile, organizationAccess } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState<SupplierRow | null | 'new'>(null);
  const [priceUploadFor, setPriceUploadFor] = useState<SupplierWithBalance | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SupplierWithBalance | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () => {
    // Same shape as the card query (Promise.all): suppliers + balances + metrics in parallel,
    // merged through Maps. The list answers "who needs my attention"; the card answers "why".
    const [supRes, balRes, metRes] = await Promise.all([
      // Explicit columns, not `*` (0112). `suppliers.bank_details` is no longer selectable by
      // any client role — the column privilege was revoked so that no crafted query reaches the
      // account money is sent to — and `select('*')` expands to include it, which would fail the
      // whole screen. The edit dialog fetches it on demand through financial_supplier_directory.
      supabase.from('suppliers')
        .select('id, org_id, name, tax_id, contact_name, phone, whatsapp, email, address, delivery_days, cutoff_time, min_order_amount, payment_terms, notes, status, deleted_at, created_at, updated_at, rating, rating_updated_at, rating_note, supplier_categories(category_id, categories(name))')
        .is('deleted_at', null).order('name'),
      supabase.from('supplier_balances').select('*'),
      supabase.from('supplier_metrics').select('*'),
    ]);
    const suppliers = unwrap(supRes) as (SupplierRow & { supplier_categories: { categories: { name: string } }[] })[];
    const balances = unwrap(balRes) as { supplier_id: string; open_balance: number }[];
    const metrics = unwrap(metRes) as SupplierMetrics[];
    const balMap = new Map(balances.map((b) => [b.supplier_id, b.open_balance]));
    const metMap = new Map(metrics.map((m) => [m.supplier_id, m]));
    return suppliers.map((s) => ({
      ...s,
      open_balance: balMap.get(s.id) ?? 0,
      categories: s.supplier_categories?.map((c) => c.categories?.name).filter(Boolean),
      metrics: metMap.get(s.id),
    }));
  });

  const canWrite = organizationAccess.canWrite && (profile?.role === 'owner' || profile?.role === 'office');

  // ?balance=open from the dashboard "ספקים עם יתרה פתוחה" card.
  const [balanceFilter, setBalanceFilter] = useParamState('balance');
  const [statusFilter, setStatusFilter] = useParamState('status');
  const rows = useMemo(() => (data ?? []).filter((r) =>
    (balanceFilter !== 'open' || (r.open_balance ?? 0) > 0)
    && (!statusFilter || r.status === statusFilter)
  ), [data, balanceFilter, statusFilter]);

  // Delete guard (adversarial review round): a soft-deleted supplier vanishes from the lists
  // while money is still owed to them or goods are still on their way — the open balance and
  // the in-flight orders would go dark. Both checks run FRESH (not off the possibly-stale list
  // merge): the supplier_balances view for open money, purchase_orders outside the terminal
  // statuses (received/cancelled) for in-flight activity.
  async function requestDelete(s: SupplierWithBalance) {
    const [balRes, poRes] = await Promise.all([
      supabase.from('supplier_balances').select('open_balance').eq('supplier_id', s.id).maybeSingle(),
      supabase.from('purchase_orders').select('id', { count: 'exact', head: true })
        .eq('supplier_id', s.id).not('status', 'in', '(received,cancelled)'),
    ]);
    const err = balRes.error ?? poRes.error;
    // If the check itself failed we cannot prove the supplier is safe to delete — refuse.
    if (err) { toast(toHebrewError(err.message), 'error'); return; }
    const openBalance = (balRes.data as { open_balance: number } | null)?.open_balance ?? 0;
    if (openBalance > 0 || (poRes.count ?? 0) > 0) {
      toast('לא ניתן למחוק ספק עם יתרה פתוחה או הזמנות פעילות', 'error');
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
    if (res.error) { setDeleteTarget(null); toast(toHebrewError(res.error.message), 'error'); return; }
    setDeleteTarget(null);
    toast('הספק נמחק');
    void refetch();
  }

  const columns: Column<SupplierWithBalance>[] = [
    { key: 'name', header: 'ספק', priority: 3, sortValue: (r) => r.name, render: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'rating', header: 'דירוג', priority: 3, className: 'num', sortValue: (r) => r.rating ?? 0, render: (r) => r.rating != null
        ? <span className="inline-flex items-center gap-1"><Star size={13} className="fill-star text-star" />{r.rating}</span>
        : <span className="text-ink-ghost">—</span> },
    { key: 'cats', header: 'קטגוריות', priority: 3, render: (r) => <span className="text-ink-muted">{r.categories?.join(', ') || '—'}</span> },
    { key: 'contact', header: 'איש קשר', priority: 3, render: (r) => r.contact_name || '—' },
    { key: 'phone', header: 'טלפון', render: (r) => <span dir="ltr">{r.phone || '—'}</span> },
    { key: 'min', header: 'מינ׳ הזמנה', priority: 3, className: 'num', sortValue: (r) => r.min_order_amount ?? 0, render: (r) => fmtMoneyExact(r.min_order_amount) },
    { key: 'risk', header: 'התראות', mobileLabel: null, render: (r) => <RiskCell m={r.metrics} /> },
    { key: 'balance', header: 'יתרה פתוחה', sortValue: (r) => r.open_balance ?? 0, render: (r) => <span className={`num ${r.open_balance ? 'text-await-fg font-medium' : ''}`}>{fmtMoneyExact(r.open_balance)}</span>, className: 'num' },
    { key: 'status', header: 'סטטוס', priority: 3, render: (r) => <StatusBadge meta={SUPPLIER_STATUS[r.status]} /> },
  ];

  if (loading) return <SkeletonTable cols={7} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <PageHeader title="ספקים"
        meta={`${data?.length ?? 0} ספקים · ${(data ?? []).filter((supplier) => (supplier.open_balance ?? 0) > 0).length} עם יתרה פתוחה`}
        actions={canWrite && <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> ספק חדש</button>} />
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.name.toLowerCase().includes(q) || (r.contact_name ?? '').toLowerCase().includes(q) || (r.tax_id ?? '').toLowerCase().includes(q)}
        searchLabel="חיפוש בספקים"
        rowLabel={(r) => `ספק ${r.name}`}
        onRowClick={(r) => navigate(`/suppliers/${r.id}`)}
        mobile="cards"
        mobileTitle={(r) => r.name}
        mobileTrailing={(r) => <StatusBadge meta={SUPPLIER_STATUS[r.status]} />}
        rowActions={canWrite ? (r) => [
          { key: 'edit', label: 'עריכה', icon: Pencil, onSelect: () => setEditing(r) },
          ...(canStartSupplierCommerce(r.status) ? [
            { key: 'price-list', label: 'העלאת מחירון', icon: Upload, onSelect: () => setPriceUploadFor(r) },
          ] : []),
          { key: 'delete', label: 'מחיקה', icon: Trash2, tone: 'danger', onSelect: () => void requestDelete(r) },
        ] : undefined}
        activeFilters={(balanceFilter === 'open' ? 1 : 0) + (statusFilter ? 1 : 0)}
        onClearFilters={() => { setBalanceFilter(''); setStatusFilter(''); }}
        toolbar={
          <>
            <select className="input w-auto!" aria-label="סינון ספקים לפי יתרה פתוחה" value={balanceFilter} onChange={(e) => setBalanceFilter(e.target.value)}>
              <option value="">כל הספקים</option>
              <option value="open">עם יתרה פתוחה</option>
            </select>
            <select className="input w-auto!" aria-label="סינון ספקים לפי סטטוס" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">כל הסטטוסים</option>
              {Object.entries(SUPPLIER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </>
        }
        emptyTitle="עדיין אין ספקים"
        emptySubtitle="הוסף את הספק הראשון כדי להתחיל לנהל רכש, מחירים ויתרות"
        emptyAction={canWrite && <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> ספק חדש</button>} />
      {balanceFilter === 'open' && rows.length === 0 && <p className="text-sm text-ink-muted">אין ספקים עם יתרה פתוחה.</p>}
      {editing && <SupplierForm supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refetch(); }} />}
      {priceUploadFor && (
        <PriceListUploadModal supplier={{ id: priceUploadFor.id, name: priceUploadFor.name }}
          onClose={() => setPriceUploadFor(null)} onImported={() => void refetch()} />
      )}

      <ConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}
        onConfirm={(reason) => void deleteSupplier(reason)}
        title="מחיקת ספק"
        message={`הספק ״${deleteTarget?.name ?? ''}״ יוסר מהרשימות (מחיקה רכה — ההיסטוריה הכספית נשמרת). הפעולה תתועד ביומן הביקורת.`}
        confirmLabel="מחיקה" danger requireReason busy={busyDelete} />
    </div>
  );
}

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
  const { profile } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // The dedicated bank-details step (migration 0061). `suppliers.bank_details` left the direct
  // UPDATE column grant in 0061; changing it goes through `update_supplier_bank_details`
  // (step-up + mandatory reason + audit). `bankStep` holds the new value while the reason
  // dialog is up; `bankReauth` holds the confirmed reason while ReauthModal decides.
  const [bankStep, setBankStep] = useState<{ nextBank: string | null; supplierId: string } | null>(null);
  const [bankReauth, setBankReauth] = useState<string | null>(null);
  const [bankBusy, setBankBusy] = useState(false);

  const [f, setF] = useState({
    name: supplier?.name ?? '', tax_id: supplier?.tax_id ?? '', contact_name: supplier?.contact_name ?? '',
    phone: supplier?.phone ?? '', whatsapp: supplier?.whatsapp ?? '', email: supplier?.email ?? '',
    address: supplier?.address ?? '', min_order_amount: supplier?.min_order_amount?.toString() ?? '',
    payment_terms: supplier?.payment_terms ?? '', bank_details: '',
    notes: supplier?.notes ?? '', status: (supplier?.status ?? 'active') as SupplierStatus,
    delivery_days: supplier?.delivery_days ?? [] as number[],
    cutoff_time: supplier?.cutoff_time?.slice(0, 5) ?? '',
    rating: (supplier?.rating ?? null) as number | null,
    rating_note: supplier?.rating_note ?? '',
  });

  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));

  const bankFieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus !== 'bank') return;
    // After the modal has taken its own initial focus, otherwise the dialog wins the race.
    const frame = requestAnimationFrame(() => {
      bankFieldRef.current?.focus();
      bankFieldRef.current?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  async function save() {
    if (!f.name.trim()) { toast('שם ספק הוא שדה חובה', 'error'); return; }
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
      // The field opens EMPTY now (0112): the list row no longer carries bank_details, because
      // the column is not selectable by any client role. So "changed" means "something was
      // typed" — an untouched field leaves the stored details alone rather than clearing them,
      // which is the safe direction for the column that decides where money goes.
      const nextBank = f.bank_details.trim() || null;
      const bankChanged = nextBank !== null;
      const res = await supabase.from('suppliers').update(row).eq('id', supplier.id);
      setBusy(false);
      if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
      if (bankChanged) { setBankStep({ nextBank, supplierId: supplier.id }); return; }
      toast('הספק עודכן');
      onSaved();
    } else {
      const res = await supabase.from('suppliers')
        .insert({ ...row, org_id: profile!.org_id }).select('id').single();
      setBusy(false);
      if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
      const nextBank = f.bank_details || null;
      if (nextBank) {
        // #106: the row exists bank-less; the details now take the same reasoned step-up
        // path a change to an existing supplier takes.
        toast('הספק נוצר — פרטי הבנק דורשים אימות וסיבה');
        setBankStep({ nextBank, supplierId: (res.data as { id: string }).id });
        return;
      }
      toast('הספק נוצר');
      onSaved();
    }
  }

  async function saveBankDetails(reason: string) {
    if (!bankStep) return;
    setBankBusy(true);
    const res = await supabase.rpc('update_supplier_bank_details', {
      p_supplier_id: bankStep.supplierId,
      p_bank_details: bankStep.nextBank,
      p_reason: reason.trim(),
    });
    setBankBusy(false);
    // On failure the reason dialog stays open for a retry; the other fields are already saved.
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    toast('פרטי הבנק עודכנו ונרשמו ביומן הביקורת');
    setBankStep(null);
    onSaved();
  }

  // Cancelling the bank step is not a silent no-op: the other fields were already saved, and the
  // user must hear that the bank change specifically did not happen.
  function cancelBankStep() {
    setBankStep(null);
    setBankReauth(null);
    toast('פרטי הבנק לא עודכנו — שאר השדות נשמרו', 'error');
    onSaved();
  }

  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

  return (
    <Modal open onClose={onClose} title={supplier ? `עריכת ספק — ${supplier.name}` : 'ספק חדש'} wide busy={busy} statusMessage={busy ? 'שומר את פרטי הספק' : undefined}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div><label className="label" htmlFor="supplier-name">שם הספק *</label><input id="supplier-name" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div><label className="label" htmlFor="supplier-tax-id">ח.פ / עוסק</label><input id="supplier-tax-id" className="input" dir="ltr" value={f.tax_id} onChange={(e) => set('tax_id', e.target.value)} /></div>
        <div><label className="label" htmlFor="supplier-contact">איש קשר</label><input id="supplier-contact" className="input" value={f.contact_name} onChange={(e) => set('contact_name', e.target.value)} /></div>
        <div><label className="label" htmlFor="supplier-phone">טלפון</label><input id="supplier-phone" className="input" dir="ltr" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        <div><label className="label" htmlFor="supplier-whatsapp">WhatsApp</label><input id="supplier-whatsapp" className="input" dir="ltr" value={f.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} /></div>
        <div><label className="label" htmlFor="supplier-email">אימייל</label><input id="supplier-email" className="input" dir="ltr" value={f.email} onChange={(e) => set('email', e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="supplier-address">כתובת</label><input id="supplier-address" className="input" value={f.address} onChange={(e) => set('address', e.target.value)} /></div>
        <fieldset>
          <legend className="label">ימי אספקה</legend>
          <div className="flex flex-wrap gap-1.5">
            {days.map((d, i) => (
              <button type="button" key={i}
                aria-pressed={f.delivery_days.includes(i)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs ${f.delivery_days.includes(i) ? 'bg-action-solid text-white border-action-solid' : 'border-line-strong text-ink-soft hover:bg-action-wash'}`}
                onClick={() => set('delivery_days', f.delivery_days.includes(i) ? f.delivery_days.filter((x) => x !== i) : [...f.delivery_days, i].sort())}>
                {d}
              </button>
            ))}
          </div>
        </fieldset>
        <div><label className="label" htmlFor="supplier-cutoff">שעת סגירת הזמנות</label><input id="supplier-cutoff" type="time" className="input" value={f.cutoff_time} onChange={(e) => set('cutoff_time', e.target.value)} /></div>
        <div><label className="label" htmlFor="supplier-minimum">מינימום הזמנה (₪)</label><input id="supplier-minimum" type="number" className="input num" value={f.min_order_amount} onChange={(e) => set('min_order_amount', e.target.value)} /></div>
        <div><label className="label" htmlFor="supplier-payment-terms">תנאי תשלום</label><input id="supplier-payment-terms" className="input" placeholder="שוטף + 30" value={f.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="supplier-bank-details">פרטי בנק — מלא רק כדי לשנות (אינם מוצגים)</label><input id="supplier-bank-details" ref={bankFieldRef} className="input" value={f.bank_details} onChange={(e) => set('bank_details', e.target.value)} /></div>
        <div>
          <label className="label" htmlFor="supplier-status">סטטוס</label>
          <select id="supplier-status" className="input" value={f.status} onChange={(e) => set('status', e.target.value)}
            aria-describedby="supplier-status-hint">
            {Object.entries(SUPPLIER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          {/* OPEN-DECISIONS #115, decided 09.08.2026 (owner delegated): `inactive` means
              "לא להזמין ממנו יותר" — the procurement doors close (new order, price-list upload),
              the money doors stay open so an open account can still be settled. Deliberately NOT
              filtered: invoice intake, payment requests, bank matching, documents, analytics —
              an invoice from a supplier deactivated yesterday is the commonest event after
              deactivation, and blocking it would manufacture the dead end #115 warned about. */}
          <p id="supplier-status-hint" className="mt-1 text-xs text-ink-muted">
            ״לא פעיל״ = לא מזמינים ממנו יותר: הספק מוסתר בהזמנה חדשה ובהעלאת מחירון. בקליטת חשבונית,
            בדרישת תשלום ובהתאמות בנק הוא ממשיך להופיע, כדי שניתן יהיה לסגור מולו חשבון פתוח.
          </p>
        </div>
        <fieldset>
          <legend className="label">דירוג ספק</legend>
          <div className="pt-1"><RatingStars value={f.rating} onChange={(n) => set('rating', n || null)} /></div>
        </fieldset>
        <div className="sm:col-span-2"><label className="label" htmlFor="supplier-rating-note">הערת דירוג</label><input id="supplier-rating-note" className="input" placeholder="למה הדירוג הזה?" value={f.rating_note} onChange={(e) => set('rating_note', e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="supplier-notes">הערות</label><textarea id="supplier-notes" className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'שומר…' : 'שמירה'}</button>
      </div>

      <ConfirmDialog
        open={!!bankStep}
        onClose={cancelBankStep}
        onConfirm={(reason) => setBankReauth(reason ?? '')}
        title="עדכון פרטי בנק"
        message={`פרטי הבנק של ״${supplier?.name ?? f.name}״ ישתנו ל: ${bankStep?.nextBank ?? 'ללא פרטי בנק'}. השינוי דורש אימות סיסמה טרי ונרשם ביומן הביקורת.`}
        confirmLabel="אישור העדכון"
        requireReason
        busy={bankBusy}
      />

      <ReauthModal
        open={bankReauth !== null}
        title="אימות זהות לעדכון פרטי בנק"
        onConfirm={() => { const reason = bankReauth; setBankReauth(null); void saveBankDetails(reason ?? ''); }}
        onCancel={() => setBankReauth(null)}
      />
    </Modal>
  );
}

/* ================= Supplier card ================= */
export function SupplierCard() {
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
    const [orders, invoices, payments, credits, balance, metrics, sps, submissions] = await Promise.all([
      supabase.from('purchase_orders').select('*').eq('supplier_id', id!).order('created_at', { ascending: false }).limit(50),
      supabase.from('invoices').select('*').eq('supplier_id', id!).eq('financial_role', 'payable').is('deleted_at', null).order('invoice_date', { ascending: false }).limit(50),
      supabase.from('payments').select('*').eq('supplier_id', id!).order('paid_date', { ascending: false }).limit(50),
      supabase.from('credit_requests').select('*').eq('supplier_id', id!).order('created_at', { ascending: false }).limit(50),
      supabase.from('supplier_balances').select('*').eq('supplier_id', id!).maybeSingle(),
      supabase.from('supplier_metrics').select('*').eq('supplier_id', id!).maybeSingle(), // maybeSingle: a role-guarded view may return no row
      supabase.from('supplier_products').select('*, product:products(id,name,unit)').eq('supplier_id', id!).order('updated_at', { ascending: false }),
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
      payments: unwrap(payments) as Payment[],
      credits: unwrap(credits) as CreditRequest[],
      balance: (balance.data as { open_balance: number } | null)?.open_balance ?? 0,
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
    { key: 'orders' as const, label: `הזמנות (${data?.orders.length ?? 0})` },
    { key: 'invoices' as const, label: `חשבוניות (${data?.invoices.length ?? 0})` },
    { key: 'payments' as const, label: `תשלומים (${data?.payments.length ?? 0})` },
    { key: 'credits' as const, label: `זיכויים (${data?.credits.length ?? 0})` },
    { key: 'prices' as const, label: `מחירים (${data?.prices.length ?? 0})` },
  ]), [data]);

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowLeft') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowRight') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    setTab(tabs[next].key);
    requestAnimationFrame(() => document.getElementById(`supplier-tab-${tabs[next].key}`)?.focus());
  }

  if (loading) return <RecordSkeleton />;
  if (error || !data) return <ErrorNote message={error ?? 'ספק לא נמצא'} />;
  const s = data.supplier;
  const m = data.metrics;

  // One card, one grid — the spec sheet (§4.4). Balance + honest metrics; OTD renders — (never
  // 0%) when no promised delivery date was ever recorded (open decision #28, not yet answered).
  const scoreItems: ScoreItem[] = [
    { label: 'יתרה פתוחה', value: fmtMoneyExact(data.balance), tone: data.balance > 0 ? 'await' : 'done' },
    {
      label: 'עמידה בזמנים',
      value: m && m.otd_samples > 0 ? fmtPct(m.on_time_pct) : '—',
      sub: m && m.otd_samples > 0 ? `${m.otd_samples} אספקות` : 'אין תאריך אספקה מוזן',
      tone: otdTone(m),
    },
    { label: 'זמן אספקה ממוצע', value: fmtLeadDays(m?.avg_lead_days ?? null), sub: 'מהשליחה ועד קבלה', tone: 'idle' },
    // No supplier_metrics row = the counts were never computed, which is not the same claim as
    // "zero open exceptions". fmtNum(null) renders — so the tile stays honest (constitution §"אין ערכים
    // סטטיים מזויפים"), matching how OTD and lead time above already behave.
    { label: 'חריגים פתוחים', value: fmtNum(m?.open_exceptions ?? null), sub: m ? `${fmtNum(m.exceptions_lifetime)} בסה״כ` : 'טרם חושבו מדדים', tone: (m?.open_exceptions ?? 0) > 0 ? 'alert' : 'idle' },
    { label: 'זיכויים פתוחים', value: fmtNum(m?.open_credits ?? null), sub: fmtMoneyExact(m?.open_credits_amount ?? null), tone: (m?.open_credits ?? 0) > 0 ? 'await' : 'idle' },
    { label: 'שינויי מחיר (180 יום)', value: fmtNum(m?.price_changes_window ?? null), sub: m ? `${fmtNum(m.priced_items)} פריטים` : 'טרם חושבו מדדים', tone: 'idle' },
    { label: 'מינימום הזמנה', value: fmtMoneyExact(s.min_order_amount), tone: 'idle' },
    { label: 'תנאי תשלום', value: s.payment_terms ?? '—', tone: 'idle', numeric: false },
  ];

  return (
    <div className="space-y-4">
      <RecordHeader
        breadcrumbs={<Breadcrumbs items={[{ label: 'ספקים', to: '/suppliers' }, { label: s.name }]} />}
        title={s.name}
        status={<><StatusBadge meta={SUPPLIER_STATUS[s.status]} /><span className="inline-flex items-center gap-2">
              <RatingStars value={s.rating} />
              {s.rating != null && s.rating_updated_at && (
                <span className="text-xs font-normal text-ink-muted" title={s.rating_note ?? undefined}>עודכן {fmtDate(s.rating_updated_at)}</span>
              )}
            </span></>}
        meta={<>
            {s.contact_name && <span>{s.contact_name}</span>}
            {s.phone && <span className="flex items-center gap-1"><Phone size={13} /><span dir="ltr">{s.phone}</span></span>}
            {s.email && <span className="flex items-center gap-1"><Mail size={13} /><span dir="ltr">{s.email}</span></span>}
            {s.address && <span className="flex items-center gap-1"><MapPin size={13} />{s.address}</span>}
            {s.delivery_days.length > 0 && <span className="flex items-center gap-1"><Truck size={13} />ימי אספקה {fmtDays(s.delivery_days)}</span>}
            {s.cutoff_time && <span className="flex items-center gap-1"><Clock size={13} />סגירת הזמנות {s.cutoff_time.slice(0, 5)}</span>}
          </>}
        primaryAction={canWrite && canStartSupplierCommerce(s.status)
          ? <button className="btn-primary" onClick={() => setUploadOpen(true)}><Upload size={15} /> העלאת מחירון</button>
          : null}
        secondaryActions={canWrite && <>
            {/* Named, not buried: "החליף מספר חשבון" is the task, and it used to be four steps
                inside a form of twenty fields. Navigates rather than calling setEditing directly,
                so the address is the one another screen can link to. */}
            <button className="btn-secondary" onClick={() => navigate(`/suppliers/${s.id}?edit=bank`)}>
              <Landmark size={15} /> עדכון פרטי בנק
            </button>
            <button className="btn-secondary" onClick={() => setEditing(true)}>עריכה</button>
          </>} />

      <Scorecard items={scoreItems} />

      {s.notes && <div className="card card-pad text-sm text-ink-soft">{s.notes}</div>}

      <div role="tablist" aria-label={`מידע עבור ${s.name}`} className="flex gap-1 border-b border-line no-print overflow-x-auto">
        {tabs.map((t) => (
          <button key={t.key} id={`supplier-tab-${t.key}`} role="tab" aria-selected={tab === t.key} aria-controls={`supplier-panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1} onKeyDown={(event) => onTabKeyDown(event, tabs.indexOf(t))} onClick={() => setTab(t.key)}
            className={`min-h-11 px-4 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${tab === t.key ? 'border-action-solid text-action font-medium' : 'border-transparent text-ink-muted hover:text-ink-mid'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'orders' && (
        <div role="tabpanel" id="supplier-panel-orders" aria-labelledby="supplier-tab-orders">
        <DataTable rows={data.orders} columns={[
          { key: 'num', header: 'מס׳', className: 'num', render: (r: PurchaseOrder) => `#${r.number}` },
          { key: 'date', header: 'תאריך', sortValue: (r: PurchaseOrder) => r.created_at, render: (r: PurchaseOrder) => fmtDate(r.created_at) },
          { key: 'expected', header: 'אספקה צפויה', render: (r: PurchaseOrder) => fmtDate(r.expected_date) },
          { key: 'status', header: 'סטטוס', render: (r: PurchaseOrder) => <StatusBadge meta={PO_STATUS[r.status]} /> },
        ]} rowLabel={(r) => `הזמנת רכש מספר ${r.number} עבור ${s.name}`} onRowClick={(r) => navigate(`/orders/${r.id}`)} emptyTitle="אין הזמנות לספק זה" />
        </div>
      )}
      {tab === 'invoices' && (
        <div role="tabpanel" id="supplier-panel-invoices" aria-labelledby="supplier-tab-invoices">
        <DataTable rows={data.invoices} columns={[
          { key: 'num', header: 'מס׳ חשבונית', className: 'num', render: (r: Invoice) => r.invoice_number },
          { key: 'date', header: 'תאריך', sortValue: (r: Invoice) => r.invoice_date, render: (r: Invoice) => fmtDate(r.invoice_date) },
          { key: 'total', header: 'סה״כ', className: 'num', sortValue: (r: Invoice) => r.total_amount, render: (r: Invoice) => fmtMoneyExact(r.total_amount) },
          { key: 'review', header: 'בדיקה', render: (r: Invoice) => <StatusBadge meta={INVOICE_REVIEW_STATUS[r.review_status]} /> },
          { key: 'payment', header: 'תשלום', render: (r: Invoice) => <StatusBadge meta={INVOICE_PAYMENT_STATUS[r.payment_status]} /> },
        ]} rowLabel={(r) => `חשבונית ${r.invoice_number} של ${s.name}`} onRowClick={(r) => navigate(`/invoices/${r.id}`)} emptyTitle="אין חשבוניות לספק זה" />
        </div>
      )}
      {tab === 'payments' && (
        <div role="tabpanel" id="supplier-panel-payments" aria-labelledby="supplier-tab-payments">
        <DataTable rows={data.payments} columns={[
          { key: 'date', header: 'תאריך', sortValue: (r: Payment) => r.paid_date, render: (r: Payment) => fmtDate(r.paid_date) },
          { key: 'amount', header: 'סכום', className: 'num', sortValue: (r: Payment) => r.amount, render: (r: Payment) => fmtMoneyExact(r.amount) },
          { key: 'method', header: 'אמצעי', render: (r: Payment) => r.method ?? '—' },
          { key: 'ref', header: 'אסמכתא', className: 'num', render: (r: Payment) => <span dir="ltr">{r.reference ?? '—'}</span> },
        ]} emptyTitle="אין תשלומים לספק זה" />
        </div>
      )}
      {tab === 'credits' && (
        <div role="tabpanel" id="supplier-panel-credits" aria-labelledby="supplier-tab-credits">
        <DataTable rows={data.credits} columns={[
          { key: 'num', header: 'מס׳', className: 'num', render: (r: CreditRequest) => `#${r.number}` },
          { key: 'reason', header: 'סיבה', render: (r: CreditRequest) => CREDIT_REASON[r.reason] },
          { key: 'amount', header: 'סכום', className: 'num', sortValue: (r: CreditRequest) => r.amount, render: (r: CreditRequest) => fmtMoneyExact(r.amount) },
          { key: 'status', header: 'סטטוס', render: (r: CreditRequest) => <StatusBadge meta={CREDIT_STATUS[r.status]} /> },
          { key: 'date', header: 'נפתח', sortValue: (r: CreditRequest) => r.created_at, render: (r: CreditRequest) => fmtDate(r.created_at) },
        ]} rowLabel={(r) => `דרישת זיכוי מספר ${r.number} עבור ${s.name}`} onRowClick={() => navigate('/credits')} emptyTitle="אין זיכויים לספק זה" />
        </div>
      )}
      {tab === 'prices' && (
        <div role="tabpanel" id="supplier-panel-prices" aria-labelledby="supplier-tab-prices">
          <SupplierPricesTab rows={data.prices} history={data.history}
            submissions={data.canSeeSubmissions ? data.submissions : null} />
        </div>
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
    { key: 'product', header: 'מוצר', sortValue: (r) => r.product.name, render: (r) => <span className="font-medium text-ink">{r.product.name}</span> },
    { key: 'price', header: 'מחיר נוכחי', className: 'num', sortValue: (r) => r.current_price, render: (r) => <span className="font-semibold">{fmtMoneyExact(r.current_price)}</span> },
    { key: 'prev', header: 'מחיר קודם', className: 'num', render: (r) => fmtMoneyExact(r.previous_price) },
    {
      key: 'change', header: 'שינוי', sortValue: changePct,
      render: (r) => {
        const pct = changePct(r);
        if (!r.previous_price || pct === 0) return <span className="text-ink-faint">—</span>;
        // Same treatment as PriceLists.tsx:50-56 (LRM keeps the sign on the correct side in RTL).
        return pct > 0
          ? <span className="inline-flex items-center gap-1 text-alert-solid font-medium"><TrendingUp size={14} />{'‎'}+{pct.toFixed(1)}%</span>
          : <span className="inline-flex items-center gap-1 text-done-fg font-medium"><TrendingDown size={14} />{'‎'}{pct.toFixed(1)}%</span>;
      },
    },
    {
      key: 'trend', header: 'מגמה',
      render: (r) => {
        const pts = histBySp.get(r.id) ?? [];
        return pts.length >= 2 ? <PriceSparkline points={pts} /> : <span className="text-ink-ghost">—</span>;
      },
    },
    { key: 'date', header: 'בתוקף מ־', sortValue: (r) => r.price_effective_date, render: (r) => fmtDate(r.price_effective_date) },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-4 text-sm">
        <span className="text-ink-soft">התייקרו: <b className="text-alert-solid">{summary.up}</b></span>
        <span className="text-ink-soft">הוזלו: <b className="text-done-fg">{summary.down}</b></span>
        <span className="text-ink-soft">שינוי חציוני: <b className="num">{summary.median == null ? '—' : `${summary.median > 0 ? '+' : ''}${summary.median.toFixed(1)}%`}</b></span>
      </div>
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.product.name.toLowerCase().includes(q)}
        searchLabel="חיפוש במחירון הספק"
        emptyTitle="אין מחירון לספק זה" />

      {submissions !== null && (
        <section className="card p-4" aria-labelledby="supplier-card-submissions-heading">
          <h3 id="supplier-card-submissions-heading" className="section-title mb-3">היסטוריית מחירונים</h3>
          {submissions.length ? (
            <div className="divide-y divide-line-soft">
              {submissions.map((submission) => (
                <div key={submission.id} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium text-ink">{submissionMonthLabel(submission.target_month)} · גרסה <span className="num">{submission.revision}</span></div>
                    <StatusBadge meta={SUBMISSION_STATUS[submission.status]} />
                  </div>
                  <div className="mt-1 text-sm text-ink-muted break-words">
                    {submission.file_name ?? 'הגשה מדור קודם'} · נקלטו <span className="num">{submission.accepted_count}</span> · ללא שינוי <span className="num">{submission.unchanged_count}</span> · נדחו <span className="num">{submission.rejected_count}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-ink-muted">עדיין לא נקלט מחירון לספק זה.</p>}
        </section>
      )}
    </div>
  );
}

export function useCategories() {
  return useQuery<Category[]>(async () => unwrap(await supabase.from('categories').select('*').order('sort')));
}
