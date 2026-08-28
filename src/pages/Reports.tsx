import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { FileSpreadsheet, Printer, Send, CheckCircle2, LockKeyhole, Download, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge, useToast, ConfirmDialog, ErrorNote, PageHeader, SkeletonCards, Note, Modal, Card, EmptyState, ICON } from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, INVOICE_EXPORT_STATUS, CREDIT_STATUS, CREDIT_REASON, EXCEPTION_TYPE } from '../lib/status';
import { addCalendarDays, fmtMoneyExact, fmtDate, fmtDateTime, fmtMonth, monthInstantRange, monthRange, safeMonthISO } from '../lib/format';
import { MoneyByCurrency, sortByBaseCurrency } from '../components/Money';
import type { MoneyAmount } from '../lib/types';
import { useParamState } from '../lib/useParamState';
import { toHebrewError } from '../lib/errors';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';
import { buildLockedMonthlyWorkbook, buildStyledMonthlyWorkbook, monthlyReportScreenTotals, type MonthlyReportLabels, type MonthlyReportSnapshot } from '../lib/monthlyReport';
import * as XLSX from 'xlsx';
import { financialSupplierMap } from '../lib/financialSuppliers';
import {
  downloadRenderedWorkbook,
  monthlyReportTemplateValues,
  renderConfiguredReportTemplate,
} from '../lib/reportTemplateExport';

/**
 * What `invoice_balances_by_currency` returns per invoice. Every one of these is COMPUTED at read
 * time from the allocation tables — the constitution's rule that a balance is never stored. The
 * row is read and displayed; it is never re-derived in the browser from payments or credits.
 *
 * One row per invoice still, because an invoice is issued in one currency; the reader is named
 * per-currency (0218) so that a SUPPLIER's two debts stay two.
 */
interface InvoiceBalanceRow {
  invoice_id: string;
  currency: string;
  paid_amount: number;
  credited_amount: number;
  balance_in_currency: number;
}

function toSnapshotHebrewError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/monthly_report_snapshot_unattributed_bank_transactions/i.test(raw)) {
    return 'לא ניתן ליצור דוח סופי: כל תנועות הבנק בחודש חייבות התאמה מאושרת לחשבונית או לתשלום המשויכים לישות משפטית אחת.';
  }
  if (/monthly_report_snapshot_unattributed_(invoices|payments|credits|bank_transactions|exceptions)/i.test(raw)) {
    return 'לא ניתן ליצור דוח סופי: קיימות רשומות ללא שיוך חד־משמעי לישות משפטית. יש להשלים את השיוך לפני ניסיון נוסף.';
  }
  if (/monthly_report_snapshot_legal_entity_invalid|unit_out_of_scope/i.test(raw)) {
    return 'הישות המשפטית אינה זמינה או אינה בתחום ההרשאה שלך. יש לבחור ישות אחרת.';
  }
  if (/monthly_report_snapshot_source_unavailable/i.test(raw)) {
    return 'לא ניתן להשלים כעת את צילום המצב. הנתונים לא נשמרו ויש לנסות שוב.';
  }
  return toHebrewError(error);
}

export default function Reports() {
  const { profile, org, organizationAccess } = useAuth();
  const baseCurrency = org?.base_currency ?? null;
  const orgLogoUrl = org?.logo_path
    ? `${supabase.storage.from('organization-branding').getPublicUrl(org.logo_path).data.publicUrl}?v=${encodeURIComponent(org.logo_updated_at ?? '')}`
    : null;
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  // The month lives in the URL beside the legal entity, so leaving for an invoice and coming back
  // returns the accountant to the month they were reading. An ABSENT `?month=` means "the current
  // month" and is never written eagerly: the address stays a clean `/reports` until a month is
  // actually picked, so a `?month=` in a shared or bookmarked link is always a deliberate choice.
  const [monthParam, setMonth] = useParamState('month');
  const month = safeMonthISO(monthParam);
  const [busy, setBusy] = useState(false);
  const [sendSnapshot, setSendSnapshot] = useState<MonthlyReportSnapshot | null>(null);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [snapshotReauthOpen, setSnapshotReauthOpen] = useState(false);
  const [snapshotPreviewAt, setSnapshotPreviewAt] = useState<Date | null>(null);
  // Both finalization and delivery are server-side step-up paths. These states only control the
  // password prompt; 0074 independently rejects a stale/missing password AMR claim.
  const [pendingDelivery, setPendingDelivery] = useState<{
    snapshot: MonthlyReportSnapshot;
    reason: string;
  } | null>(null);
  /**
   * G1, finding 17. Closing the month is one real action, and what happens when it is BLOCKED was
   * a toast: it named no transaction, carried no link, and disappeared. The recovering link
   * already existed on this very page — the "תנועות בנק ללא התאמה" tile points at
   * `/bank?month=…&status=attention` (:402) — and nothing connected the two. So the message stays
   * on screen until the next attempt, and when the blocker is the bank it carries that link and
   * the count that is already computed here. It is also the far end of finding 10: the transaction
   * the accountant could not attribute is the one standing in front of the month close, and
   * neither screen used to mention the other.
   */
  const [snapshotBlock, setSnapshotBlock] = useState<{ message: string; bank: boolean } | null>(null);

  const canManageExport = !!profile && ['owner', 'accountant'].includes(profile.role);
  const canMutateExport = canManageExport && organizationAccess.canWrite;
  const requestedUnitId = searchParams.get('unit');

  const reportLabels: MonthlyReportLabels = {
    invoiceReview: INVOICE_REVIEW_STATUS,
    invoicePayment: INVOICE_PAYMENT_STATUS,
    creditReason: CREDIT_REASON,
    creditStatus: CREDIT_STATUS,
    exceptionType: EXCEPTION_TYPE,
  };

  const { data, loading, fetching, error } = useQuery(async () => {
    const { start, end } = monthRange(month);
    const instants = monthInstantRange(month);
    const [rawInvoices, rawPayments, rawCredits, rawExceptions, bank] = await Promise.all([
      fetchAll((from, to) => supabase.from('invoices').select('*')
        .eq('financial_role', 'payable').gte('invoice_date', start).lt('invoice_date', end).is('deleted_at', null)
        .order('invoice_date').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('payments').select('*')
        .gte('paid_date', start).lt('paid_date', end).order('paid_date').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('credit_requests').select('*')
        .gte('created_at', instants.start).lt('created_at', instants.end).order('created_at').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('exceptions').select('*')
        .in('status', ['open', 'in_progress']).order('created_at').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('bank_transactions').select('id, status')
        .gte('tx_date', start).lt('tx_date', end).order('tx_date').order('id').range(from, to)),
    ]);
    type SupplierLinked = { supplier_id: string | null };
    const linkedRows = [...rawInvoices, ...rawPayments, ...rawCredits, ...rawExceptions] as unknown as SupplierLinked[];
    const invoiceIds = (rawInvoices as unknown as { id: string }[]).map((row) => row.id);
    // שולם · זוכה · יתרה. The accountant reconciling a month needs to see what is still OPEN per
    // invoice, and the balance is never a stored column: `invoice_balances` (0022) is the view over
    // `p0_invoice_balance_rows()`, granted to `authenticated`, and the function itself scopes rows
    // by `auth_org()` and `auth_role()` — so this returns exactly what the signed-in reader may
    // see, nothing wider. Chunked because `.in()` has a URL-length ceiling.
    // An invoice with no balance row keeps `null` and prints `—`; it never prints 0.
    const [suppliers, balanceRows] = await Promise.all([
      financialSupplierMap(linkedRows.flatMap((row) => row.supplier_id ? [row.supplier_id] : [])),
      invoiceIds.length
        ? fetchInChunks(invoiceIds, (chunk) => fetchAll<InvoiceBalanceRow>((from, to) => supabase.from('invoice_balances_by_currency')
          .select('invoice_id, currency, paid_amount, credited_amount, balance_in_currency')
          .in('invoice_id', chunk).order('invoice_id').range(from, to)))
        : Promise.resolve<InvoiceBalanceRow[]>([]),
    ]);
    const balances = new Map(balanceRows.map((row) => [row.invoice_id, row]));
    const supplier = (supplierId: string | null) => ({
      name: supplierId ? suppliers.get(supplierId)?.name ?? '—' : '—',
    });
    return {
      invoices: (rawInvoices as unknown as (SupplierLinked & { id: string; invoice_number: string; invoice_date: string; received_date: string | null; total_amount: number; amount_before_vat: number; vat_amount: number; currency: string; review_status: string; payment_status: string; export_status: string; notes: string | null })[])
        .map((row) => ({ ...row, supplier: supplier(row.supplier_id), balance: balances.get(row.id) ?? null })),
      payments: (rawPayments as unknown as (SupplierLinked & { id: string; number: number; paid_date: string; amount: number; currency: string; method: string | null; reference: string | null })[])
        .map((row) => ({ ...row, supplier: supplier(row.supplier_id) })),
      credits: (rawCredits as unknown as (SupplierLinked & { id: string; number: number; reason: string; amount: number; currency: string; status: string })[])
        .map((row) => ({ ...row, supplier: supplier(row.supplier_id) })),
      exceptions: (rawExceptions as unknown as (SupplierLinked & { id: string; type: string; title: string })[])
        .map((row) => ({ ...row, supplier: row.supplier_id ? supplier(row.supplier_id) : null })),
      bank: bank as { id: string; status: string }[],
      generatedAt: new Date(),
    };
  }, [month]);

  const {
    data: lockedReports,
    loading: lockedReportsLoading,
    fetching: lockedReportsFetching,
    error: lockedReportsError,
    refetch: refetchLockedReports,
  } = useQuery(async () => {
    if (!canManageExport) return { legalEntities: [], selectedUnitId: '', snapshots: [], deliveries: [] };

    const legalEntities = unwrap(await supabase.rpc('read_monthly_report_legal_entities')) as {
      id: string;
      name: string;
    }[];
    const requestedIsAllowed = !!requestedUnitId
      && legalEntities.some((unit) => unit.id === requestedUnitId);
    const selectedUnitId = requestedIsAllowed
      ? requestedUnitId
      : requestedUnitId === null && legalEntities.length === 1
        ? legalEntities[0]!.id
        : '';
    const [snapshotRows, deliveryRows] = selectedUnitId
      ? await Promise.all([
        fetchAll((from, to) => supabase.from('monthly_report_snapshots').select('*')
          .eq('unit_id', selectedUnitId)
          .eq('report_month', `${month}-01`)
          .order('version', { ascending: false })
          .range(from, to)),
        fetchAll((from, to) => supabase.from('monthly_report_snapshot_deliveries')
          .select('id, snapshot_id, sent_at, sent_by_name, reason')
          .eq('unit_id', selectedUnitId)
          .eq('report_month', `${month}-01`)
          .order('snapshot_version', { ascending: false })
          .range(from, to)),
      ])
      : [[], []] as const;
    const snapshots = snapshotRows as MonthlyReportSnapshot[];
    const deliveries = deliveryRows as {
      id: string;
      snapshot_id: string;
      sent_at: string;
      sent_by_name: string;
      reason: string;
    }[];
    return { legalEntities, selectedUnitId, snapshots, deliveries };
  }, [canManageExport, requestedUnitId, month]);

  async function exportExcel() {
    if (!data || fetching || error || !org) return;
    setBusy(true);
    try {
      const { start, end } = monthRange(month);
      const values = monthlyReportTemplateValues({
        orgName: org.name,
        periodLabel: fmtMonth(`${month}-01`),
        periodFrom: fmtDate(start),
        periodTo: fmtDate(addCalendarDays(end, -1)),
        generatedAt: fmtDateTime(data.generatedAt),
        // The invoice rows carry their `invoice_balances` row, which is where the recognised
        // credit comes from. The credit list is what the month's credit sheet lists; it is not
        // the money that came off these invoices.
        invoices: data.invoices,
      });
      // This file lands in an accountant's inbox, and an accountant serves several businesses.
      // The name has to say whose report it is; a fixed tenant name would break multi-tenancy.
      // Strip only what filesystems object to; Hebrew names are fine and are the whole point.
      const slug = org.name.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-');
      const fileName = `${slug || 'inplace'}-report-${month}.xlsx`;
      const templated = await renderConfiguredReportTemplate({
        exportKey: 'accountant_monthly_report', orgId: org.id, values,
      });
      if (templated) {
        downloadRenderedWorkbook(templated, fileName);
      } else {
        // No custom template configured → the styled built-in default (18.08.2026). A BROKEN
        // custom template still throws above rather than landing here — that contract is
        // renderConfiguredReportTemplate's, untouched.
        const wb = buildStyledMonthlyWorkbook({
          orgName: org.name, month, generatedAt: data.generatedAt, data,
          labels: reportLabels, summary: values,
        });
        XLSX.writeFile(wb, fileName);
      }
      toast('קובץ ה-Excel הורד');
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  function downloadSnapshot(snapshot: MonthlyReportSnapshot) {
    try {
      const workbook = buildLockedMonthlyWorkbook({ snapshot });
      const orgSlug = snapshot.organization_name.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-');
      const unitSlug = snapshot.legal_entity_name.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-');
      XLSX.writeFile(
        workbook,
        `${orgSlug || 'inplace'}-${unitSlug || 'legal-entity'}-final-report-${snapshot.report_month.slice(0, 7)}-v${snapshot.version}.xlsx`,
      );
      toast(`גרסה ${snapshot.version} הורדה מה-snapshot הנעול`);
    } catch (e) {
      toast(toHebrewError(e), 'error');
    }
  }

  async function createSnapshot() {
    const selectedUnitId = lockedReports?.selectedUnitId;
    if (!canMutateExport || !selectedUnitId || lockedReportsFetching || lockedReportsError) return;
    setBusy(true);
    setSnapshotBlock(null);
    try {
      const snapshot = unwrap(await supabase.rpc('create_monthly_report_snapshot', {
        p_month: `${month}-01`,
        p_unit_id: selectedUnitId,
      })) as MonthlyReportSnapshot;
      setSnapshotOpen(false);
      toast(`דוח סופי נעול גרסה ${snapshot.version} נוצר בהצלחה`);
      void refetchLockedReports();
    } catch (e) {
      const message = toSnapshotHebrewError(e);
      // The toast stays for the immediate, announced feedback; the Note is what survives it.
      toast(message, 'error');
      setSnapshotBlock({
        message,
        bank: /monthly_report_snapshot_unattributed_bank_transactions/i
          .test(e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setBusy(false);
    }
  }

  async function markSent(snapshot: MonthlyReportSnapshot, reason: string) {
    if (!canMutateExport || lockedReportsFetching || lockedReportsError) return;
    setBusy(true);
    try {
      unwrap(await supabase.rpc('mark_monthly_report_snapshot_sent', {
        p_snapshot_id: snapshot.id,
        p_reason: reason.trim() || null,
      }));
      toast(`גרסה ${snapshot.version} סומנה כהועברה לרו״ח`);
      void refetchLockedReports();
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <SkeletonCards count={6} cols={6} title />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <ErrorNote message="שגיאה" />;

  const balancesComplete = data.invoices.every((i) => i.balance !== null);
  /** Sum a month's rows WITHIN each currency. There is no other kind of total on this screen. */
  const within = <T,>(rows: readonly T[], currency: (row: T) => string, amount: (row: T) => number): MoneyAmount[] => {
    const sums = new Map<string, number>();
    for (const row of rows) sums.set(currency(row), (sums.get(currency(row)) ?? 0) + amount(row));
    return sortByBaseCurrency([...sums].map(([code, value]) => ({ currency: code, amount: value })), baseCurrency);
  };
  const totals = {
    ...monthlyReportScreenTotals(data),
    // Distinct from `paid`: that is money that LEFT this month, this is what has been allocated
    // against these invoices whenever it was paid. Still per currency, and still withheld
    // entirely when any invoice has no balance row — a partial sum is not a smaller total.
    allocated: balancesComplete ? within(data.invoices, (i) => i.currency, (i) => i.balance?.paid_amount ?? 0) : null,
    openBalance: balancesComplete ? within(data.invoices, (i) => i.currency, (i) => i.balance?.balance_in_currency ?? 0) : null,
  };
  const orderedTotals = (rows: MoneyAmount[]) => sortByBaseCurrency(rows, baseCurrency);

  /* Payments grouped by supplier AND currency, and ordered inside each currency. A supplier paid
     ₪4,000 and $900 this month appears twice, because those are two payments of two kinds of
     money — one row holding their sum would be the false number this whole change is about. */
  const paymentsBySupplier = [...data.payments.reduce((m, p) => {
    const key = `${p.supplier.name}|${p.currency}`;
    m.set(key, { name: p.supplier.name, currency: p.currency, amount: (m.get(key)?.amount ?? 0) + p.amount });
    return m;
  }, new Map<string, { name: string; currency: string; amount: number }>()).values()]
    .sort((a, b) => (a.currency === b.currency
      ? b.amount - a.amount
      : a.currency === baseCurrency ? -1 : b.currency === baseCurrency ? 1 : a.currency < b.currency ? -1 : 1));
  // A disabled button looks clickable but does nothing; the title says why it is blocked.
  const exportBlockedReason = fetching ? 'הנתונים נטענים…' : error ? 'שגיאה בטעינת הנתונים' : null;
  // Card now renders whatever element it is told to (`as`), so the tiles stop composing the
  // card class string by hand; what stays here is only what makes a LINK out of one.
  const metricLinkClass = 'card-link-hover block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas';
  const selectedLegalEntity = lockedReports?.legalEntities.find(
    (unit) => unit.id === lockedReports.selectedUnitId,
  ) ?? null;
  const latestSnapshot = lockedReports?.snapshots[0] ?? null;
  const snapshotBlockedReason = lockedReportsFetching
    ? 'נתוני הדוחות הסופיים נטענים…'
    : lockedReportsError
      ? 'שגיאה בטעינת הדוחות הסופיים'
      : !selectedLegalEntity
        ? 'יש לבחור ישות משפטית מורשית'
        : null;

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && data && <Note tone="idle">הדוח מתעדכן. הייצוא והסימון מושבתים עד להשלמת הרענון.</Note>}
      <PageHeader className="no-print"
        title={<span className="flex flex-wrap items-center gap-2">דוח חודשי לרואת חשבון <span className="badge-idle">דוח חי</span></span>}
        meta={`הנתונים הושלמו ${fmtDateTime(data.generatedAt)} ואינם snapshot טרנזקציוני.`}
        actions={<div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="monthly-report-month">חודש הדוח</label>
          {/* The native clear affordance emits '' — keep the previous month instead of a broken query. */}
          <input id="monthly-report-month" type="month" className="input w-auto!" value={month} onChange={(e) => { if (e.target.value) setMonth(e.target.value); }} />
          <button className="btn-secondary" disabled={busy || fetching || !!error} title={exportBlockedReason ?? 'הורדת הדוח כקובץ Excel'} onClick={() => void exportExcel()}>{busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <FileSpreadsheet size={ICON.sm} aria-hidden="true" />} ייצוא Excel</button>
          <button className="btn-secondary" disabled={fetching || !!error} title={exportBlockedReason ?? 'הדפסת הדוח או שמירה כ-PDF'} onClick={() => window.print()}><Printer size={ICON.sm} aria-hidden="true" /> הדפסה / PDF</button>
        </div>} />

      {/* The product summary is a sibling report, reached from here rather than from the main
          navigation: it answers a different question about the same money, and a sub-report that
          earns its own top-level row makes the catalogue longer without making anything easier
          to find. */}
      <p className="no-print text-sm">
        <Link className="link" to="/reports/products">סיכום רכישות מוצרים ←</Link>
      </p>

      <ConfirmDialog open={sendSnapshot !== null} onClose={() => setSendSnapshot(null)}
        onConfirm={(reason) => {
          if (!sendSnapshot) return;
          setPendingDelivery({ snapshot: sendSnapshot, reason: reason ?? '' });
          setSendSnapshot(null);
        }}
        title="סימון דוח סופי כהועבר לרו״ח"
        message={sendSnapshot
          ? `הסימון יתייחס רק לגרסה ${sendSnapshot.version} הנעולה (${sendSnapshot.content_hash.slice(0, 12)}…). נתוני הדוח החי אינם נקראים בפעולה זו.`
          : ''}
        confirmLabel="סימון כהועבר" requireReason busy={busy} />

      <ReauthModal open={pendingDelivery !== null}
        title="אימות זהות לסימון הדוח הסופי כהועבר"
        onConfirm={() => {
          const pending = pendingDelivery;
          setPendingDelivery(null);
          if (pending) void markSent(pending.snapshot, pending.reason);
        }}
        onCancel={() => setPendingDelivery(null)} />

      <ReauthModal open={snapshotReauthOpen}
        title="אימות זהות ליצירת דוח סופי נעול"
        onConfirm={() => { setSnapshotReauthOpen(false); void createSnapshot(); }}
        onCancel={() => setSnapshotReauthOpen(false)} />

      {canManageExport && (
        <>
          <Modal open={snapshotOpen} onClose={() => setSnapshotOpen(false)}
            title="יצירת דוח סופי נעול"
            description="הדוח ייווצר בשרת ממצב נתונים עקבי ויישמר כגרסה חדשה שאינה ניתנת לשינוי."
            busy={busy}>
            <dl className="mb-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-ink-muted">חודש הדיווח</dt><dd className="mt-0.5 font-medium">{fmtMonth(`${month}-01`)}</dd></div>
              <div><dt className="text-xs text-ink-muted">ארגון</dt><dd className="mt-0.5 font-medium">{org?.name ?? '—'}</dd></div>
              <div><dt className="text-xs text-ink-muted">ישות משפטית</dt><dd className="mt-0.5 font-medium">{selectedLegalEntity?.name ?? '—'}</dd></div>
              <div><dt className="text-xs text-ink-muted">זמן יצירה</dt><dd className="num mt-0.5">{snapshotPreviewAt ? fmtDateTime(snapshotPreviewAt) : '—'}</dd></div>
              <div><dt className="text-xs text-ink-muted">יוצר הדוח</dt><dd className="mt-0.5 font-medium">{profile?.full_name ?? '—'}</dd></div>
              <div>
                <dt className="text-xs text-ink-muted">Snapshot קיים לחודש</dt>
                <dd className="mt-0.5 font-medium">{latestSnapshot ? `כן — גרסה ${latestSnapshot.version}` : 'לא קיים עדיין'}</dd>
              </div>
            </dl>
            <Note tone="await">הדוח הסופי משקף את כל החשבוניות שבדוח החי לחודש ולישות שנבחרו. כל תנועת בנק בחודש חייבת התאמה מאושרת לישות אחת; אחרת היצירה תיחסם. לאחר היצירה הגרסה אינה ניתנת לשינוי.</Note>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setSnapshotOpen(false)}>ביטול</button>
              <button type="button" className="btn-primary" disabled={busy || !selectedLegalEntity} onClick={() => { setSnapshotOpen(false); setSnapshotReauthOpen(true); }}>
                <LockKeyhole size={ICON.sm} aria-hidden="true" /> {latestSnapshot ? 'יצירת גרסה חדשה' : 'יצירת דוח סופי נעול'}
              </button>
            </div>
          </Modal>

          <Card as="section" className="no-print" aria-labelledby="locked-reports-title">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="locked-reports-title" className="section-title flex items-center gap-2"><LockKeyhole size={ICON.sm} aria-hidden="true" /> דוחות סופיים נעולים</h2>
                  <span className="badge-done">דוח סופי נעול</span>
                </div>
                <p className="mt-1 text-xs text-ink-muted">כל גרסה שייכת לישות משפטית אחת, נשמרת במסד הנתונים ואינה משתנה יחד עם הדוח החי.</p>
              </div>
              <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
                <div className="min-w-0 sm:min-w-56">
                  <label className="label" htmlFor="monthly-report-legal-entity">ישות משפטית</label>
                  <select id="monthly-report-legal-entity" className="input w-full" value={lockedReports?.selectedUnitId ?? ''}
                    disabled={lockedReportsLoading || lockedReportsFetching || !!lockedReportsError}
                    onChange={(event) => {
                      const next = new URLSearchParams(searchParams);
                      if (event.target.value) next.set('unit', event.target.value);
                      else next.delete('unit');
                      setSearchParams(next, { replace: true });
                    }}>
                    <option value="">בחירת ישות משפטית</option>
                    {(lockedReports?.legalEntities ?? []).map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                  </select>
                </div>
                {canMutateExport && (
                  <button type="button" className="btn-primary self-end" disabled={busy || !!snapshotBlockedReason}
                    title={snapshotBlockedReason ?? 'יצירת גרסה סופית נעולה'}
                    onClick={() => { setSnapshotPreviewAt(new Date()); setSnapshotOpen(true); }}>
                    <LockKeyhole size={ICON.sm} aria-hidden="true" /> יצירת דוח סופי לרו״ח
                  </button>
                )}
              </div>
            </div>

            {snapshotBlock && (
              <div className="mt-4">
                <Note tone="alert" role="alert">
                  <span>
                    {snapshotBlock.message}
                    {snapshotBlock.bank && (
                      <span className="block mt-1">
                        <Link className="link" to={`/bank?month=${month}&status=unmatched`}>
                          פתיחת {totals.unmatchedBank} תנועות הבנק ללא התאמה בחודש זה
                        </Link>
                        {totals.suggestedBank > 0 && (
                          <> · <Link className="link" to={`/bank?month=${month}&status=suggested`}>
                            {totals.suggestedBank} התאמות שממתינות לאישור
                          </Link></>
                        )}
                        {' '}— תנועה שלא שויכה לספק חוסמת את סגירת החודש.
                      </span>
                    )}
                  </span>
                </Note>
              </div>
            )}
            {lockedReportsError && <div className="mt-4"><ErrorNote message={lockedReportsError} /></div>}
            {!lockedReportsError && !lockedReportsLoading && !lockedReports?.legalEntities.length && (
              <div className="mt-4"><Note tone="await">לא נמצאה ישות משפטית מורשית להפקת דוח סופי.</Note></div>
            )}
            {!lockedReportsError && requestedUnitId && !lockedReports?.selectedUnitId && (
              <div className="mt-4"><Note tone="await">מזהה הישות המשפטית שבכתובת אינו תקין או שאינו מורשה למשתמש זה.</Note></div>
            )}
            {selectedLegalEntity && (
              lockedReports?.snapshots.length ? (
                <ul className="mt-4 divide-y divide-line-soft">
                  {lockedReports.snapshots.map((snapshot) => (
                    <li key={snapshot.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="font-medium">{snapshot.legal_entity_name} · גרסה <span className="num">{snapshot.version}</span></div>
                        <div className="mt-0.5 break-words text-xs text-ink-muted">
                          נוצר {fmtDateTime(snapshot.created_at)} · {snapshot.created_by_name} · מבנה {snapshot.report_version}
                        </div>
                        {(() => {
                          const delivery = lockedReports.deliveries.find((item) => item.snapshot_id === snapshot.id);
                          return delivery ? (
                            <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-done-fg">
                              <CheckCircle2 size={ICON.xs} aria-hidden="true" /> הועבר לרו״ח {fmtDateTime(delivery.sent_at)} · {delivery.sent_by_name} · {delivery.reason}
                            </div>
                          ) : null;
                        })()}
                      </div>
                      <div className="flex flex-wrap gap-2 self-start sm:self-auto">
                        {canMutateExport && !lockedReports.deliveries.some((item) => item.snapshot_id === snapshot.id) && (
                          <button type="button" className="btn-primary" disabled={busy} onClick={() => setSendSnapshot(snapshot)}>
                            {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <Send size={ICON.sm} aria-hidden="true" />} סימון כהועבר לרו״ח
                          </button>
                        )}
                        <button type="button" className="btn-secondary" onClick={() => downloadSnapshot(snapshot)}>
                          <Download size={ICON.sm} aria-hidden="true" /> הורדת גרסה {snapshot.version}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : !lockedReportsFetching && <p className="mt-4 text-sm text-ink-muted">אין עדיין דוח סופי נעול לחודש ולישות המשפטית שנבחרו.</p>
            )}
          </Card>
        </>
      )}

      <div className="print-area monthly-report space-y-4">
        <div className="hidden print:block">
          {/* Printed header handed to the accountant — carries the tenant's own name. */}
          {orgLogoUrl && <img data-testid="monthly-report-logo" src={orgLogoUrl} alt="" className="mb-2 h-14 w-32 object-contain object-right" />}
          <h2 className="text-xl font-semibold">{`${org?.name ? `${org.name} — ` : ''}דוח חודשי ${fmtMonth(`${month}-01`)}`}</h2>
          <p className="text-xs">נוצר {fmtDateTime(data.generatedAt)}</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card as={Link} className={metricLinkClass} to={`/invoices?month=${month}`}><div className="text-xs text-ink-muted">חשבוניות</div><div className="kpi-value-compact num">{data.invoices.length}</div></Card>
          <Card as={Link} className={metricLinkClass} to={`/invoices?month=${month}`}><div className="text-xs text-ink-muted">סה״כ חשבוניות</div><div className="kpi-value-compact text-start"><MoneyByCurrency amounts={orderedTotals(totals.invoices)} baseCurrency={baseCurrency} /></div></Card>
          <Card as={Link} className={metricLinkClass} to={`/invoices?month=${month}`}><div className="text-xs text-ink-muted">מע״מ</div><div className="kpi-value-compact text-start"><MoneyByCurrency amounts={orderedTotals(totals.vat)} baseCurrency={baseCurrency} /></div></Card>
          <Card as={Link} className={metricLinkClass} to={`/payments?month=${month}`}><div className="text-xs text-ink-muted">שולם החודש</div><div className={`kpi-value-compact text-start ${totals.paid.length ? 'text-done-fg' : 'text-idle-fg'}`}><MoneyByCurrency amounts={orderedTotals(totals.paid)} baseCurrency={baseCurrency} /></div></Card>
          <Card as={Link} className={metricLinkClass} to={`/invoices?month=${month}&pay=open`}><div className="text-xs text-ink-muted">חשבוניות שטרם שולמו</div><div className={`kpi-value-compact num ${totals.unpaidCount ? 'text-await-fg' : ''}`}>{totals.unpaidCount}</div></Card>
          <Card as={Link} className={metricLinkClass} to={`/bank?month=${month}&status=unmatched`}><div className="text-xs text-ink-muted">תנועות בנק ללא התאמה</div><div className={`kpi-value-compact num ${totals.unmatchedBank ? 'text-alert-fg' : ''}`}>{totals.unmatchedBank}</div></Card>
          <Card as={Link} className={metricLinkClass} to={`/bank?month=${month}&status=suggested`}><div className="text-xs text-ink-muted">התאמות שממתינות לאישור</div><div className={`kpi-value-compact num ${totals.suggestedBank ? 'text-await-fg' : ''}`}>{totals.suggestedBank}</div></Card>
          <Card as={Link} className={metricLinkClass} to={`/credits?month=${month}&status=all`}><div className="text-xs text-ink-muted">זיכויים בחודש</div><div className="kpi-value-compact num">{data.credits.length}</div></Card>
          <Card as={Link} className={metricLinkClass} to="/exceptions?status=open"><div className="text-xs text-ink-muted">חריגים פתוחים</div><div className={`kpi-value-compact num ${data.exceptions.length ? 'text-await-fg' : ''}`}>{data.exceptions.length}</div></Card>
        </div>

        {data.exceptions.length > 0 && (
          <Note tone="await">
            <div className="w-full">
              <h2 className="text-base font-semibold mb-2">חריגים פתוחים כרגע שדורשים טיפול לפני סגירת החודש ({data.exceptions.length})</h2>
              <ul className="space-y-1 list-disc list-inside">
                {data.exceptions.map((e) => <li key={e.id}>{EXCEPTION_TYPE[e.type]} — {e.title}</li>)}
              </ul>
            </div>
          </Note>
        )}

        <Card pad={false} clip>
          <div className="px-4 py-3 border-b border-line-soft section-title">חשבוניות {fmtMonth(`${month}-01`)}</div>
          <ul className="report-mobile-cards xl:hidden divide-y divide-line-soft print:hidden" aria-label="חשבוניות בדוח">
            {data.invoices.map((i) => (
              <li key={i.id} className="p-4">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="break-words font-medium text-ink-body">{i.supplier.name}</div>
                    <div className="mt-0.5 text-xs text-ink-muted"><span className="num" dir="ltr">{i.invoice_number}</span> · {fmtDate(i.invoice_date)}</div>
                  </div>
                  <div className="num shrink-0 font-semibold text-ink-body">{fmtMoneyExact(i.total_amount, i.currency)}</div>
                </div>
                {/* Four figures, not eleven. The wide grid below is where a month is reconciled;
                    a phone card that grew to match it would be a table with extra steps. */}
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div><dt className="text-xs text-ink-muted">לפני מע״מ</dt><dd className="num mt-0.5">{fmtMoneyExact(i.amount_before_vat, i.currency)}</dd></div>
                  <div><dt className="text-xs text-ink-muted">מע״מ</dt><dd className="num mt-0.5">{fmtMoneyExact(i.vat_amount, i.currency)}</dd></div>
                  <div><dt className="text-xs text-ink-muted">שולם</dt><dd className="num mt-0.5">{fmtMoneyExact(i.balance?.paid_amount, i.currency)}</dd></div>
                  <div><dt className="text-xs text-ink-muted">יתרה לתשלום</dt><dd className="num mt-0.5">{fmtMoneyExact(i.balance?.balance_in_currency, i.currency)}</dd></div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusBadge meta={INVOICE_REVIEW_STATUS[i.review_status]} />
                  <StatusBadge meta={INVOICE_PAYMENT_STATUS[i.payment_status]} />
                </div>
                {i.notes && <p className="mt-3 break-words text-xs text-ink-muted">{i.notes}</p>}
              </li>
            ))}
            {!data.invoices.length && <li><EmptyState title="אין חשבוניות בחודש זה" /></li>}
            {/* A total row standing over no rows is not information — the empty sentence above
                already said everything there is to say about this month. */}
            {totals.hasInvoices && (
              <li className="flex min-h-11 flex-wrap items-center justify-between gap-2 bg-surface-sunken px-4 py-3 font-semibold">
                <span>סה״כ</span><MoneyByCurrency amounts={orderedTotals(totals.invoices)} baseCurrency={baseCurrency} />
              </li>
            )}
          </ul>
          <div className="report-table-wrap table-scroll hidden overflow-x-auto xl:block print:block" tabIndex={0} role="region" aria-label="חשבוניות בדוח — טבלה נגללת">
            <table className="report-invoices w-full">
              {/* Widths apply in PRINT only, where the table is `table-layout: fixed`: A4 landscape
                  at 9mm margins leaves 279mm, and left to itself the browser hands ספק half of it
                  and squeezes every figure. On screen the columns stay auto. */}
              <colgroup>
                <col className="print:w-[16%]" /><col className="print:w-[9%]" /><col className="print:w-[7%]" />
                <col className="print:w-[8%]" /><col className="print:w-[9%]" /><col className="print:w-[8%]" />
                <col className="print:w-[9%]" /><col className="print:w-[9%]" /><col className="print:w-[9%]" />
                <col className="print:w-[8%]" /><col className="print:w-[8%]" />
              </colgroup>
              <thead className="table-head"><tr>
                <th scope="col" className="th">ספק</th><th scope="col" className="th">מס׳</th><th scope="col" className="th">תאריך</th>
                <th scope="col" className="th">תאריך קליטה</th>
                <th scope="col" className="th">לפני מע״מ</th><th scope="col" className="th">מע״מ</th><th scope="col" className="th">סה״כ</th>
                <th scope="col" className="th">שולם</th><th scope="col" className="th">יתרה</th>
                <th scope="col" className="th">בדיקה</th><th scope="col" className="th">תשלום</th>
              </tr></thead>
              <tbody className="divide-y divide-line-soft">
                {data.invoices.map((i) => {
                  const credited = i.balance?.credited_amount ?? 0;
                  return (
                    <Fragment key={i.id}>
                      <tr>
                        <td className="td">{i.supplier.name}</td>
                        <td className="td">
                          <span className="num" dir="ltr">{i.invoice_number}</span>
                          {/* A mark, not a twelfth column: "הועברה לרו״ח" is one bit per invoice and
                              a whole column of it would cost width the figures need. */}
                          {i.export_status === 'sent' && (
                            <span className="ms-1 text-done-fg" title={INVOICE_EXPORT_STATUS.sent.label}>
                              <span aria-hidden="true">✓</span>
                              <span className="sr-only">{INVOICE_EXPORT_STATUS.sent.label}</span>
                            </span>
                          )}
                        </td>
                        <td className="td">{fmtDate(i.invoice_date)}</td>
                        <td className="td">{fmtDate(i.received_date)}</td>
                        <td className="td num">{fmtMoneyExact(i.amount_before_vat, i.currency)}</td>
                        <td className="td num">{fmtMoneyExact(i.vat_amount, i.currency)}</td>
                        <td className="td num font-medium">{fmtMoneyExact(i.total_amount, i.currency)}</td>
                        <td className="td num">{fmtMoneyExact(i.balance?.paid_amount, i.currency)}</td>
                        <td className="td num">{fmtMoneyExact(i.balance?.balance_in_currency, i.currency)}</td>
                        <td className="td"><StatusBadge meta={INVOICE_REVIEW_STATUS[i.review_status]} /></td>
                        <td className="td"><StatusBadge meta={INVOICE_PAYMENT_STATUS[i.payment_status]} /></td>
                      </tr>
                      {/* Print-only second line. הערות is free text of any length — inside the grid it
                          would either be truncated or take a column from the numbers. זוכה joins it
                          when there is one, because without it סה״כ − שולם ≠ יתרה on the printed page
                          and the accountant is left reconciling a sum that does not close. */}
                      {(i.notes || credited > 0) && (
                        <tr className="hidden print:table-row">
                          <td className="td text-ink-muted" colSpan={11}>
                            {credited > 0 && <span className="me-4">זוכה <span className="num">{fmtMoneyExact(credited, i.currency)}</span></span>}
                            {i.notes && <span className="break-words">הערות: {i.notes}</span>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {/* This table is also the printed sheet the accountant receives. Without this row
                    a first month printed a header, an empty body and a ₪0.00 total line. */}
                {!data.invoices.length && (
                  <tr><td className="td" colSpan={11}><EmptyState className="print:hidden" title="אין חשבוניות בחודש זה" /><span className="hidden text-ink-muted print:inline">אין חשבוניות בחודש זה</span></td></tr>
                )}
              </tbody>
              {totals.hasInvoices && (
              <tfoot><tr className="border-t-2 border-line font-semibold">
                <th scope="row" className="td text-start font-semibold" colSpan={4}>סה״כ</th>
                {/* A footer line per currency, never one line covering two. In a shekel-only
                    month — every month this product has recorded — this renders exactly the
                    single figure it always did. */}
                <td className="td"><MoneyByCurrency amounts={orderedTotals(totals.beforeVat)} baseCurrency={baseCurrency} /></td>
                <td className="td"><MoneyByCurrency amounts={orderedTotals(totals.vat)} baseCurrency={baseCurrency} /></td>
                <td className="td"><MoneyByCurrency amounts={orderedTotals(totals.invoices)} baseCurrency={baseCurrency} /></td>
                <td className="td"><MoneyByCurrency amounts={totals.allocated} baseCurrency={baseCurrency} /></td>
                <td className="td"><MoneyByCurrency amounts={totals.openBalance} baseCurrency={baseCurrency} /></td>
                <td colSpan={2} />
              </tr></tfoot>
              )}
            </table>
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card pad={false} clip>
            <div className="px-4 py-3 border-b border-line-soft section-title">תשלומים לפי ספק</div>
            <ul className="report-mobile-cards xl:hidden divide-y divide-line-soft print:hidden" aria-label="תשלומים לפי ספק">
              {paymentsBySupplier.map((row) => (
                <li key={`${row.name}|${row.currency}`} className="flex min-h-11 min-w-0 items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0 break-words text-sm">{row.name}</span>
                  <span className="num shrink-0 font-medium">{fmtMoneyExact(row.amount, row.currency)}</span>
                </li>
              ))}
              {!paymentsBySupplier.length && <li><EmptyState title="אין תשלומים בחודש זה" /></li>}
            </ul>
            <div className="report-table-wrap table-scroll hidden overflow-x-auto xl:block print:block" tabIndex={0} role="region" aria-label="תשלומים לפי ספק — טבלה נגללת">
            <table className="w-full">
              <thead className="table-head"><tr><th scope="col" className="th">ספק</th><th scope="col" className="th">סכום ששולם</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {paymentsBySupplier.map((row) => (
                  <tr key={`${row.name}|${row.currency}`}><td className="td">{row.name}</td><td className="td num font-medium">{fmtMoneyExact(row.amount, row.currency)}</td></tr>
                ))}
                {!paymentsBySupplier.length && <tr><td className="td" colSpan={2}><EmptyState className="print:hidden" title="אין תשלומים בחודש זה" /><span className="hidden text-ink-muted print:inline">אין תשלומים בחודש זה</span></td></tr>}
              </tbody>
            </table>
            </div>
          </Card>

          <Card pad={false} clip>
            <div className="px-4 py-3 border-b border-line-soft section-title">זיכויים</div>
            <ul className="report-mobile-cards xl:hidden divide-y divide-line-soft print:hidden" aria-label="זיכויים בדוח">
              {data.credits.map((c) => (
                <li key={c.id} className="p-4">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="break-words font-medium text-ink-body">{c.supplier.name}</div>
                      <div className="mt-0.5 break-words text-xs text-ink-muted">{CREDIT_REASON[c.reason]}</div>
                    </div>
                    <span className="num shrink-0 font-medium">{fmtMoneyExact(c.amount, c.currency)}</span>
                  </div>
                  <div className="mt-3"><StatusBadge meta={CREDIT_STATUS[c.status]} /></div>
                </li>
              ))}
              {!data.credits.length && <li><EmptyState title="אין זיכויים בחודש זה" /></li>}
            </ul>
            <div className="report-table-wrap table-scroll hidden overflow-x-auto xl:block print:block" tabIndex={0} role="region" aria-label="זיכויים בדוח — טבלה נגללת">
            <table className="w-full">
              <thead className="table-head"><tr><th scope="col" className="th">ספק</th><th scope="col" className="th">סיבה</th><th scope="col" className="th">סכום</th><th scope="col" className="th">סטטוס</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {data.credits.map((c) => (
                  <tr key={c.number}>
                    <td className="td">{c.supplier.name}</td>
                    <td className="td text-ink-muted">{CREDIT_REASON[c.reason]}</td>
                    <td className="td num">{fmtMoneyExact(c.amount, c.currency)}</td>
                    <td className="td"><StatusBadge meta={CREDIT_STATUS[c.status]} /></td>
                  </tr>
                ))}
                {!data.credits.length && <tr><td className="td" colSpan={4}><EmptyState className="print:hidden" title="אין זיכויים בחודש זה" /><span className="hidden text-ink-muted print:inline">אין זיכויים בחודש זה</span></td></tr>}
              </tbody>
            </table>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
