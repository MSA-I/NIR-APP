import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { FileSpreadsheet, Printer, Send, CheckCircle2, LockKeyhole, Download } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge, useToast, ConfirmDialog, ErrorNote, PageHeader, SkeletonCards, Note, Modal } from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, CREDIT_STATUS, CREDIT_REASON, EXCEPTION_TYPE } from '../lib/status';
import { addCalendarDays, currentMonthISO, fmtMoneyExact, fmtDate, fmtDateTime, fmtMonth, monthInstantRange, monthRange } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import { fetchAll } from '../lib/supabasePaging';
import { buildLockedMonthlyWorkbook, buildStyledMonthlyWorkbook, monthlyReportScreenTotals, type MonthlyReportLabels, type MonthlyReportSnapshot } from '../lib/monthlyReport';
import * as XLSX from 'xlsx';
import { financialSupplierMap } from '../lib/financialSuppliers';
import {
  downloadRenderedWorkbook,
  monthlyReportTemplateValues,
  renderConfiguredReportTemplate,
} from '../lib/reportTemplateExport';

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
  const orgLogoUrl = org?.logo_path
    ? `${supabase.storage.from('organization-branding').getPublicUrl(org.logo_path).data.publicUrl}?v=${encodeURIComponent(org.logo_updated_at ?? '')}`
    : null;
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [month, setMonth] = useState(currentMonthISO());
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

  // Browsers without a native month picker fall back to free text, so a value like "07/2026" can
  // land in state. One sanitized value drives the query, the headings, the filename and the
  // mark-sent command — what is shown is always what is exported, and no date math ever throws.
  const safeMonth = /^\d{4}-\d{2}$/.test(month) ? month : currentMonthISO();
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
    const { start, end } = monthRange(safeMonth);
    const instants = monthInstantRange(safeMonth);
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
    const suppliers = await financialSupplierMap(linkedRows.flatMap((row) => row.supplier_id ? [row.supplier_id] : []));
    const supplier = (supplierId: string | null) => ({
      name: supplierId ? suppliers.get(supplierId)?.name ?? '—' : '—',
    });
    return {
      invoices: (rawInvoices as unknown as (SupplierLinked & { id: string; invoice_number: string; invoice_date: string; total_amount: number; amount_before_vat: number; vat_amount: number; review_status: string; payment_status: string; export_status: string })[])
        .map((row) => ({ ...row, supplier: supplier(row.supplier_id) })),
      payments: (rawPayments as unknown as (SupplierLinked & { id: string; number: number; paid_date: string; amount: number; method: string | null; reference: string | null })[])
        .map((row) => ({ ...row, supplier: supplier(row.supplier_id) })),
      credits: (rawCredits as unknown as (SupplierLinked & { id: string; number: number; reason: string; amount: number; status: string })[])
        .map((row) => ({ ...row, supplier: supplier(row.supplier_id) })),
      exceptions: (rawExceptions as unknown as (SupplierLinked & { id: string; type: string; title: string })[])
        .map((row) => ({ ...row, supplier: row.supplier_id ? supplier(row.supplier_id) : null })),
      bank: bank as { id: string; status: string }[],
      generatedAt: new Date(),
    };
  }, [safeMonth]);

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
          .eq('report_month', `${safeMonth}-01`)
          .order('version', { ascending: false })
          .range(from, to)),
        fetchAll((from, to) => supabase.from('monthly_report_snapshot_deliveries')
          .select('id, snapshot_id, sent_at, sent_by_name, reason')
          .eq('unit_id', selectedUnitId)
          .eq('report_month', `${safeMonth}-01`)
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
  }, [canManageExport, requestedUnitId, safeMonth]);

  async function exportExcel() {
    if (!data || fetching || error || !org) return;
    setBusy(true);
    try {
      const { start, end } = monthRange(safeMonth);
      const values = monthlyReportTemplateValues({
        orgName: org.name,
        periodLabel: fmtMonth(`${safeMonth}-01`),
        periodFrom: fmtDate(start),
        periodTo: fmtDate(addCalendarDays(end, -1)),
        generatedAt: fmtDateTime(data.generatedAt),
        invoices: data.invoices,
        credits: data.credits,
      });
      // This file lands in an accountant's inbox, and an accountant serves several businesses.
      // The name has to say whose report it is; a fixed tenant name would break multi-tenancy.
      // Strip only what filesystems object to; Hebrew names are fine and are the whole point.
      const slug = org.name.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-');
      const fileName = `${slug || 'inplace'}-report-${safeMonth}.xlsx`;
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
          orgName: org.name, month: safeMonth, generatedAt: data.generatedAt, data,
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
        p_month: `${safeMonth}-01`,
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

  const totals = monthlyReportScreenTotals(data);

  // payments grouped by supplier
  const paymentsBySupplier = [...data.payments.reduce((m, p) => {
    m.set(p.supplier.name, (m.get(p.supplier.name) ?? 0) + p.amount);
    return m;
  }, new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
  // A disabled button looks clickable but does nothing; the title says why it is blocked.
  const exportBlockedReason = fetching ? 'הנתונים נטענים…' : error ? 'שגיאה בטעינת הנתונים' : null;
  const metricLinkClass = 'card card-pad block transition-colors hover:border-action-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas';
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
          <button className="btn-secondary" disabled={busy || fetching || !!error} title={exportBlockedReason ?? 'הורדת הדוח כקובץ Excel'} onClick={() => void exportExcel()}><FileSpreadsheet size={15} /> ייצוא Excel</button>
          <button className="btn-secondary" disabled={fetching || !!error} title={exportBlockedReason ?? 'הדפסת הדוח או שמירה כ-PDF'} onClick={() => window.print()}><Printer size={15} /> הדפסה / PDF</button>
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
              <div><dt className="text-xs text-ink-muted">חודש הדיווח</dt><dd className="mt-0.5 font-medium">{fmtMonth(`${safeMonth}-01`)}</dd></div>
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
                <LockKeyhole size={15} /> {latestSnapshot ? 'יצירת גרסה חדשה' : 'יצירת דוח סופי נעול'}
              </button>
            </div>
          </Modal>

          <section className="card card-pad no-print" aria-labelledby="locked-reports-title">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="locked-reports-title" className="section-title flex items-center gap-2"><LockKeyhole size={16} /> דוחות סופיים נעולים</h2>
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
                    <LockKeyhole size={15} /> יצירת דוח סופי לרו״ח
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
                        <Link className="link" to={`/bank?month=${safeMonth}&status=unmatched`}>
                          פתיחת {totals.unmatchedBank} תנועות הבנק ללא התאמה בחודש זה
                        </Link>
                        {totals.suggestedBank > 0 && (
                          <> · <Link className="link" to={`/bank?month=${safeMonth}&status=suggested`}>
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
                              <CheckCircle2 size={13} /> הועבר לרו״ח {fmtDateTime(delivery.sent_at)} · {delivery.sent_by_name} · {delivery.reason}
                            </div>
                          ) : null;
                        })()}
                      </div>
                      <div className="flex flex-wrap gap-2 self-start sm:self-auto">
                        {canMutateExport && !lockedReports.deliveries.some((item) => item.snapshot_id === snapshot.id) && (
                          <button type="button" className="btn-primary" disabled={busy} onClick={() => setSendSnapshot(snapshot)}>
                            <Send size={15} /> סימון כהועבר לרו״ח
                          </button>
                        )}
                        <button type="button" className="btn-secondary" onClick={() => downloadSnapshot(snapshot)}>
                          <Download size={15} /> הורדת גרסה {snapshot.version}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : !lockedReportsFetching && <p className="mt-4 text-sm text-ink-muted">אין עדיין דוח סופי נעול לחודש ולישות המשפטית שנבחרו.</p>
            )}
          </section>
        </>
      )}

      <div className="print-area monthly-report space-y-4">
        <div className="hidden print:block">
          {/* Printed header handed to the accountant — carries the tenant's own name. */}
          {orgLogoUrl && <img data-testid="monthly-report-logo" src={orgLogoUrl} alt="" className="mb-2 h-14 w-32 object-contain object-right" />}
          <h2 className="text-xl font-semibold">{`${org?.name ? `${org.name} — ` : ''}דוח חודשי ${fmtMonth(`${safeMonth}-01`)}`}</h2>
          <p className="text-xs">נוצר {fmtDateTime(data.generatedAt)}</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Link className={metricLinkClass} to={`/invoices?month=${safeMonth}`}><div className="text-xs text-ink-muted">חשבוניות</div><div className="kpi-value-compact num">{data.invoices.length}</div></Link>
          <Link className={metricLinkClass} to={`/invoices?month=${safeMonth}`}><div className="text-xs text-ink-muted">סה״כ חשבוניות</div><div className="kpi-value-compact num text-start">{fmtMoneyExact(totals.invoices)}</div></Link>
          <Link className={metricLinkClass} to={`/invoices?month=${safeMonth}`}><div className="text-xs text-ink-muted">מע״מ</div><div className="kpi-value-compact num text-start">{fmtMoneyExact(totals.vat)}</div></Link>
          <Link className={metricLinkClass} to={`/payments?month=${safeMonth}`}><div className="text-xs text-ink-muted">שולם החודש</div><div className={`kpi-value-compact num text-start ${totals.paid ? 'text-done-fg' : 'text-idle-fg'}`}>{fmtMoneyExact(totals.paid)}</div></Link>
          <Link className={metricLinkClass} to={`/invoices?month=${safeMonth}&pay=open`}><div className="text-xs text-ink-muted">חשבוניות שטרם שולמו</div><div className={`kpi-value-compact num ${totals.unpaidCount ? 'text-await-fg' : ''}`}>{totals.unpaidCount}</div></Link>
          <Link className={metricLinkClass} to={`/bank?month=${safeMonth}&status=unmatched`}><div className="text-xs text-ink-muted">תנועות בנק ללא התאמה</div><div className={`kpi-value-compact num ${totals.unmatchedBank ? 'text-alert-solid' : ''}`}>{totals.unmatchedBank}</div></Link>
          <Link className={metricLinkClass} to={`/bank?month=${safeMonth}&status=suggested`}><div className="text-xs text-ink-muted">התאמות שממתינות לאישור</div><div className={`kpi-value-compact num ${totals.suggestedBank ? 'text-await-fg' : ''}`}>{totals.suggestedBank}</div></Link>
          <Link className={metricLinkClass} to={`/credits?month=${safeMonth}&status=all`}><div className="text-xs text-ink-muted">זיכויים בחודש</div><div className="kpi-value-compact num">{data.credits.length}</div></Link>
          <Link className={metricLinkClass} to="/exceptions?status=open"><div className="text-xs text-ink-muted">חריגים פתוחים</div><div className={`kpi-value-compact num ${data.exceptions.length ? 'text-await-fg' : ''}`}>{data.exceptions.length}</div></Link>
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

        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-line-soft section-title">חשבוניות {fmtMonth(`${safeMonth}-01`)}</div>
          <ul className="report-mobile-cards xl:hidden divide-y divide-line-soft print:hidden" aria-label="חשבוניות בדוח">
            {data.invoices.map((i) => (
              <li key={i.id} className="p-4">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="break-words font-medium text-ink-body">{i.supplier.name}</div>
                    <div className="mt-0.5 text-xs text-ink-muted"><span className="num" dir="ltr">{i.invoice_number}</span> · {fmtDate(i.invoice_date)}</div>
                  </div>
                  <div className="num shrink-0 font-semibold text-ink-body">{fmtMoneyExact(i.total_amount)}</div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div><dt className="text-xs text-ink-muted">לפני מע״מ</dt><dd className="num mt-0.5">{fmtMoneyExact(i.amount_before_vat)}</dd></div>
                  <div><dt className="text-xs text-ink-muted">מע״מ</dt><dd className="num mt-0.5">{fmtMoneyExact(i.vat_amount)}</dd></div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusBadge meta={INVOICE_REVIEW_STATUS[i.review_status]} />
                  <StatusBadge meta={INVOICE_PAYMENT_STATUS[i.payment_status]} />
                </div>
              </li>
            ))}
            {!data.invoices.length && <li className="p-4 text-center text-sm text-ink-muted">אין חשבוניות בחודש זה</li>}
            {/* A total row standing over no rows is not information — the empty sentence above
                already said everything there is to say about this month. */}
            {totals.hasInvoices && (
              <li className="flex min-h-11 flex-wrap items-center justify-between gap-2 bg-surface-sunken px-4 py-3 font-semibold">
                <span>סה״כ</span><span className="num">{fmtMoneyExact(totals.invoices)}</span>
              </li>
            )}
          </ul>
          <div className="report-table-wrap hidden overflow-x-auto xl:block print:block">
            <table className="report-invoices w-full">
              <thead className="table-head"><tr>
                <th scope="col" className="th">ספק</th><th scope="col" className="th">מס׳</th><th scope="col" className="th">תאריך</th>
                <th scope="col" className="th">לפני מע״מ</th><th scope="col" className="th">מע״מ</th><th scope="col" className="th">סה״כ</th>
                <th scope="col" className="th">בדיקה</th><th scope="col" className="th">תשלום</th>
              </tr></thead>
              <tbody className="divide-y divide-line-soft">
                {data.invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="td">{i.supplier.name}</td>
                    <td className="td num" dir="ltr">{i.invoice_number}</td>
                    <td className="td">{fmtDate(i.invoice_date)}</td>
                    <td className="td num">{fmtMoneyExact(i.amount_before_vat)}</td>
                    <td className="td num">{fmtMoneyExact(i.vat_amount)}</td>
                    <td className="td num font-medium">{fmtMoneyExact(i.total_amount)}</td>
                    <td className="td"><StatusBadge meta={INVOICE_REVIEW_STATUS[i.review_status]} /></td>
                    <td className="td"><StatusBadge meta={INVOICE_PAYMENT_STATUS[i.payment_status]} /></td>
                  </tr>
                ))}
                {/* This table is also the printed sheet the accountant receives. Without this row
                    a first month printed a header, an empty body and a ₪0.00 total line. */}
                {!data.invoices.length && (
                  <tr><td className="td py-6 text-center text-ink-muted" colSpan={8}>אין חשבוניות בחודש זה</td></tr>
                )}
              </tbody>
              {totals.hasInvoices && (
                <tfoot><tr className="border-t-2 border-line font-semibold">
                  <th scope="row" className="td text-start font-semibold" colSpan={3}>סה״כ</th>
                  <td className="td num">{fmtMoneyExact(totals.beforeVat)}</td>
                  <td className="td num">{fmtMoneyExact(totals.vat)}</td>
                  <td className="td num">{fmtMoneyExact(totals.invoices)}</td>
                  <td colSpan={2} />
                </tr></tfoot>
              )}
            </table>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-line-soft section-title">תשלומים לפי ספק</div>
            <ul className="report-mobile-cards xl:hidden divide-y divide-line-soft print:hidden" aria-label="תשלומים לפי ספק">
              {paymentsBySupplier.map(([name, sum]) => (
                <li key={name} className="flex min-h-11 min-w-0 items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0 break-words text-sm">{name}</span>
                  <span className="num shrink-0 font-medium">{fmtMoneyExact(sum)}</span>
                </li>
              ))}
              {!paymentsBySupplier.length && <li className="p-4 text-center text-sm text-ink-muted">אין תשלומים בחודש זה</li>}
            </ul>
            <div className="report-table-wrap hidden overflow-x-auto xl:block print:block">
            <table className="w-full">
              <thead className="table-head"><tr><th scope="col" className="th">ספק</th><th scope="col" className="th">סכום ששולם</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {paymentsBySupplier.map(([name, sum]) => (
                  <tr key={name}><td className="td">{name}</td><td className="td num font-medium">{fmtMoneyExact(sum)}</td></tr>
                ))}
                {!paymentsBySupplier.length && <tr><td colSpan={2} className="td text-ink-muted text-center py-6">אין תשלומים בחודש זה</td></tr>}
              </tbody>
            </table>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-line-soft section-title">זיכויים</div>
            <ul className="report-mobile-cards xl:hidden divide-y divide-line-soft print:hidden" aria-label="זיכויים בדוח">
              {data.credits.map((c) => (
                <li key={c.id} className="p-4">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="break-words font-medium text-ink-body">{c.supplier.name}</div>
                      <div className="mt-0.5 break-words text-xs text-ink-muted">{CREDIT_REASON[c.reason]}</div>
                    </div>
                    <span className="num shrink-0 font-medium">{fmtMoneyExact(c.amount)}</span>
                  </div>
                  <div className="mt-3"><StatusBadge meta={CREDIT_STATUS[c.status]} /></div>
                </li>
              ))}
              {!data.credits.length && <li className="p-4 text-center text-sm text-ink-muted">אין זיכויים בחודש זה</li>}
            </ul>
            <div className="report-table-wrap hidden overflow-x-auto xl:block print:block">
            <table className="w-full">
              <thead className="table-head"><tr><th scope="col" className="th">ספק</th><th scope="col" className="th">סיבה</th><th scope="col" className="th">סכום</th><th scope="col" className="th">סטטוס</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {data.credits.map((c) => (
                  <tr key={c.number}>
                    <td className="td">{c.supplier.name}</td>
                    <td className="td text-ink-muted">{CREDIT_REASON[c.reason]}</td>
                    <td className="td num">{fmtMoneyExact(c.amount)}</td>
                    <td className="td"><StatusBadge meta={CREDIT_STATUS[c.status]} /></td>
                  </tr>
                ))}
                {!data.credits.length && <tr><td colSpan={4} className="td text-ink-muted text-center py-6">אין זיכויים בחודש זה</td></tr>}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
