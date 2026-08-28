import { useT } from '../lib/i18n/LocaleProvider';
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
import { useParamState } from '../lib/useParamState';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';
import { buildLockedMonthlyWorkbook, buildStyledMonthlyWorkbook, monthlyReportScreenTotals, type MonthlyReportLabels, type MonthlyReportSnapshot } from '../lib/monthlyReport';
import * as XLSX from 'xlsx';
import { financialSupplierMap } from '../lib/financialSuppliers';
import {
  downloadRenderedWorkbook,
  monthlyReportTemplateValues,
  reportTemplateErrorText,
  renderConfiguredReportTemplate,
} from '../lib/reportTemplateExport';

/**
 * What `invoice_balances` returns per invoice. Every one of these is COMPUTED at read time from
 * the allocation tables — the constitution's rule that a balance is never stored. The row is read
 * and displayed; it is never re-derived in the browser from payments or credits.
 */
interface InvoiceBalanceRow {
  invoice_id: string;
  paid_amount: number;
  credited_amount: number;
  balance: number;
}

function toSnapshotCondition(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Returns the CONDITION, not a sentence. Every one of these is registered in src/lib/errors.ts,
  // so the screen resolves them exactly like every other failure and this function is not a
  // second, page-local error vocabulary.
  //
  // Two unattributed-record conditions used to return a Hebrew SENTENCE from right here — exactly
  // the page-local vocabulary the paragraph above says was retired. `errorText()` was handed a
  // sentence, found no condition matching it, and passed it through unchanged, so it looked
  // correct and would have stayed Hebrew in an English session. They are registered in
  // `errors.ts` now and reach this function's caller by falling through to `raw`.
  if (/monthly_report_snapshot_legal_entity_invalid|unit_out_of_scope/i.test(raw)) {
    return 'monthly_report_snapshot_legal_entity_invalid';
  }
  if (/monthly_report_snapshot_source_unavailable/i.test(raw)) {
    return 'monthly_report_snapshot_source_unavailable';
  }
  return raw;
}

export default function Reports() {
  const { profile, org, organizationAccess } = useAuth();
  const orgLogoUrl = org?.logo_path
    ? `${supabase.storage.from('organization-branding').getPublicUrl(org.logo_path).data.publicUrl}?v=${encodeURIComponent(org.logo_updated_at ?? '')}`
    : null;
  const { errorText, statusLabel, t, tDynamic } = useT();
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

  // Resolved here, where a language exists, rather than inside the workbook builder: a spreadsheet
  // exported in the wrong language is a file somebody sends to their accountant.
  const resolveMetas = (map: Record<string, { key: string }>): Record<string, string> =>
    Object.fromEntries(Object.entries(map).map(([value, meta]) => [value, statusLabel(meta)]));
  const resolveKeys = (map: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(map).map(([value, key]) => [value, tDynamic(`status.${key}`) ?? key]));

  const reportLabels: MonthlyReportLabels = {
    invoiceReview: resolveMetas(INVOICE_REVIEW_STATUS),
    invoicePayment: resolveMetas(INVOICE_PAYMENT_STATUS),
    creditReason: resolveKeys(CREDIT_REASON),
    creditStatus: resolveMetas(CREDIT_STATUS),
    exceptionType: resolveKeys(EXCEPTION_TYPE),
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
        ? fetchInChunks(invoiceIds, (chunk) => fetchAll<InvoiceBalanceRow>((from, to) => supabase.from('invoice_balances')
          .select('invoice_id, paid_amount, credited_amount, balance')
          .in('invoice_id', chunk).order('invoice_id').range(from, to)))
        : Promise.resolve<InvoiceBalanceRow[]>([]),
    ]);
    const balances = new Map(balanceRows.map((row) => [row.invoice_id, row]));
    const supplier = (supplierId: string | null) => ({
      name: supplierId ? suppliers.get(supplierId)?.name ?? '—' : '—',
    });
    return {
      invoices: (rawInvoices as unknown as (SupplierLinked & { id: string; invoice_number: string; invoice_date: string; received_date: string | null; total_amount: number; amount_before_vat: number; vat_amount: number; review_status: string; payment_status: string; export_status: string; notes: string | null })[])
        .map((row) => ({ ...row, supplier: supplier(row.supplier_id), balance: balances.get(row.id) ?? null })),
      payments: (rawPayments as unknown as (SupplierLinked & { id: string; number: number; paid_date: string; amount: number; method: string | null; reference: string | null })[])
        .map((row) => ({ ...row, supplier: supplier(row.supplier_id) })),
      credits: (rawCredits as unknown as (SupplierLinked & { id: string; number: number; reason: string; amount: number; status: string })[])
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
          t,
          orgName: org.name, month, generatedAt: data.generatedAt, data,
          labels: reportLabels, summary: values,
        });
        XLSX.writeFile(wb, fileName);
      }
      toast(t('reports.toast'));
    } catch (e) {
      toast(reportTemplateErrorText(e, t, errorText), 'error');
    } finally {
      setBusy(false);
    }
  }

  function downloadSnapshot(snapshot: MonthlyReportSnapshot) {
    try {
      const workbook = buildLockedMonthlyWorkbook({ t, snapshot });
      const orgSlug = snapshot.organization_name.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-');
      const unitSlug = snapshot.legal_entity_name.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-');
      XLSX.writeFile(
        workbook,
        `${orgSlug || 'inplace'}-${unitSlug || 'legal-entity'}-final-report-${snapshot.report_month.slice(0, 7)}-v${snapshot.version}.xlsx`,
      );
      toast(t('reports.versionDownloaded', { version: snapshot.version }));
    } catch (e) {
      toast(errorText(e), 'error');
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
      toast(t('reports.snapshotCreated', { version: snapshot.version }));
      void refetchLockedReports();
    } catch (e) {
      const message = errorText(toSnapshotCondition(e));
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
      toast(t('reports.versionDelivered', { version: snapshot.version }));
      void refetchLockedReports();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <SkeletonCards count={6} cols={6} title />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <ErrorNote message={t('reports.message')} />;

  const balancesComplete = data.invoices.every((i) => i.balance !== null);
  const totals = {
    ...monthlyReportScreenTotals(data),
    // Distinct from `paid`: that is money that LEFT this month, this is what has been allocated
    // against these invoices whenever it was paid.
    allocated: balancesComplete ? data.invoices.reduce((s, i) => s + (i.balance?.paid_amount ?? 0), 0) : null,
    openBalance: balancesComplete ? data.invoices.reduce((s, i) => s + (i.balance?.balance ?? 0), 0) : null,
  };

  // payments grouped by supplier
  const paymentsBySupplier = [...data.payments.reduce((m, p) => {
    m.set(p.supplier.name, (m.get(p.supplier.name) ?? 0) + p.amount);
    return m;
  }, new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
  // A disabled button looks clickable but does nothing; the title says why it is blocked.
  const exportBlockedReason = fetching ? t('reports.text') : error ? t('reports.text_2') : null;
  // Card now renders whatever element it is told to (`as`), so the tiles stop composing the
  // card class string by hand; what stays here is only what makes a LINK out of one.
  const metricLinkClass = 'card-link-hover block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas';
  const selectedLegalEntity = lockedReports?.legalEntities.find(
    (unit) => unit.id === lockedReports.selectedUnitId,
  ) ?? null;
  const latestSnapshot = lockedReports?.snapshots[0] ?? null;
  const snapshotBlockedReason = lockedReportsFetching
    ? t('reports.text_3')
    : lockedReportsError
      ? t('reports.text_4')
      : !selectedLegalEntity
        ? t('reports.text_5')
        : null;

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && data && <Note tone="idle">{t('reports.text_6')}</Note>}
      <PageHeader className="no-print"
        title={<span className="flex flex-wrap items-center gap-2">{t('reports.text_7')} <span className="badge-idle">{t('reports.text_8')}</span></span>}
        meta={t('reports.liveMeta', { at: fmtDateTime(data.generatedAt) })}
        actions={<div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="monthly-report-month">{t('reports.text_9')}</label>
          {/* The native clear affordance emits '' — keep the previous month instead of a broken query. */}
          <input id="monthly-report-month" type="month" className="input w-auto!" value={month} onChange={(e) => { if (e.target.value) setMonth(e.target.value); }} />
          <button className="btn-secondary" disabled={busy || fetching || !!error} title={exportBlockedReason ?? t('reports.exportExcel')} onClick={() => void exportExcel()}>{busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <FileSpreadsheet size={ICON.sm} aria-hidden="true" />} {t('reports.exportExcelLabel')}</button>
          <button className="btn-secondary" disabled={fetching || !!error} title={exportBlockedReason ?? t('reports.print')} onClick={() => window.print()}><Printer size={ICON.sm} aria-hidden="true" /> {t('reports.text_10')}</button>
        </div>} />

      {/* The product summary is a sibling report, reached from here rather than from the main
          navigation: it answers a different question about the same money, and a sub-report that
          earns its own top-level row makes the catalogue longer without making anything easier
          to find. */}
      <p className="no-print text-sm">
        <Link className="link" to="/reports/products">{t('reports.text_11')}</Link>
      </p>

      <ConfirmDialog open={sendSnapshot !== null} onClose={() => setSendSnapshot(null)}
        onConfirm={(reason) => {
          if (!sendSnapshot) return;
          setPendingDelivery({ snapshot: sendSnapshot, reason: reason ?? '' });
          setSendSnapshot(null);
        }}
        title={t('reports.title')}
        message={sendSnapshot
          ? t('reports.deliveryScope', { version: sendSnapshot.version, hash: sendSnapshot.content_hash.slice(0, 12) })
          : ''}
        confirmLabel={t('reports.confirmLabel')} requireReason busy={busy} />

      <ReauthModal open={pendingDelivery !== null}
        title={t('reports.title_2')}
        onConfirm={() => {
          const pending = pendingDelivery;
          setPendingDelivery(null);
          if (pending) void markSent(pending.snapshot, pending.reason);
        }}
        onCancel={() => setPendingDelivery(null)} />

      <ReauthModal open={snapshotReauthOpen}
        title={t('reports.title_3')}
        onConfirm={() => { setSnapshotReauthOpen(false); void createSnapshot(); }}
        onCancel={() => setSnapshotReauthOpen(false)} />

      {canManageExport && (
        <>
          <Modal open={snapshotOpen} onClose={() => setSnapshotOpen(false)}
            title={t('reports.title_4')}
            description={t('reports.description')}
            busy={busy}>
            <dl className="mb-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-ink-muted">{t('reports.reportMonth')}</dt><dd className="mt-0.5 font-medium">{fmtMonth(`${month}-01`)}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('reports.text_12')}</dt><dd className="mt-0.5 font-medium">{org?.name ?? '—'}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('reports.text_13')}</dt><dd className="mt-0.5 font-medium">{selectedLegalEntity?.name ?? '—'}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('reports.fmtDateTime')}</dt><dd className="num mt-0.5">{snapshotPreviewAt ? fmtDateTime(snapshotPreviewAt) : '—'}</dd></div>
              <div><dt className="text-xs text-ink-muted">{t('reports.text_14')}</dt><dd className="mt-0.5 font-medium">{profile?.full_name ?? '—'}</dd></div>
              <div>
                <dt className="text-xs text-ink-muted">{t('reports.text_15')}</dt>
                <dd className="mt-0.5 font-medium">{latestSnapshot ? t('reports.snapshotYesVersion', { version: latestSnapshot.version }) : t('reports.snapshotNotYet')}</dd>
              </div>
            </dl>
            <Note tone="await">{t('reports.text_16')}</Note>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setSnapshotOpen(false)}>{t('reports.setSnapshotOpen')}</button>
              <button type="button" className="btn-primary" disabled={busy || !selectedLegalEntity} onClick={() => { setSnapshotOpen(false); setSnapshotReauthOpen(true); }}>
                <LockKeyhole size={ICON.sm} aria-hidden="true" /> {latestSnapshot ? t('reports.text_17') : t('reports.text_18')}
              </button>
            </div>
          </Modal>

          <Card as="section" className="no-print" aria-labelledby="locked-reports-title">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="locked-reports-title" className="section-title flex items-center gap-2"><LockKeyhole size={ICON.sm} aria-hidden="true" /> {t('reports.text_19')}</h2>
                  <span className="badge-done">{t('reports.text_20')}</span>
                </div>
                <p className="mt-1 text-xs text-ink-muted">{t('reports.text_21')}</p>
              </div>
              <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
                <div className="min-w-0 sm:min-w-56">
                  <label className="label" htmlFor="monthly-report-legal-entity">{t('reports.text_22')}</label>
                  <select id="monthly-report-legal-entity" className="input w-full" value={lockedReports?.selectedUnitId ?? ''}
                    disabled={lockedReportsLoading || lockedReportsFetching || !!lockedReportsError}
                    onChange={(event) => {
                      const next = new URLSearchParams(searchParams);
                      if (event.target.value) next.set('unit', event.target.value);
                      else next.delete('unit');
                      setSearchParams(next, { replace: true });
                    }}>
                    <option value="">{t('reports.text_23')}</option>
                    {(lockedReports?.legalEntities ?? []).map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                  </select>
                </div>
                {canMutateExport && (
                  <button type="button" className="btn-primary self-end" disabled={busy || !!snapshotBlockedReason}
                    title={snapshotBlockedReason ?? t('reports.text_24')}
                    onClick={() => { setSnapshotPreviewAt(new Date()); setSnapshotOpen(true); }}>
                    <LockKeyhole size={ICON.sm} aria-hidden="true" /> {t('reports.produceForAccountant')}
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
                          {t('reports.openUnmatchedBank', { count: totals.unmatchedBank })}
                        </Link>
                        {totals.suggestedBank > 0 && (
                          <> · <Link className="link" to={`/bank?month=${month}&status=suggested`}>
                            {t('reports.suggestedAwaiting', { count: totals.suggestedBank })}
                          </Link></>
                        )}
                        {' '}{t('reports.unattributedBlocksClose')}
                      </span>
                    )}
                  </span>
                </Note>
              </div>
            )}
            {lockedReportsError && <div className="mt-4"><ErrorNote message={lockedReportsError} /></div>}
            {!lockedReportsError && !lockedReportsLoading && !lockedReports?.legalEntities.length && (
              <div className="mt-4"><Note tone="await">{t('reports.text_25')}</Note></div>
            )}
            {!lockedReportsError && requestedUnitId && !lockedReports?.selectedUnitId && (
              <div className="mt-4"><Note tone="await">{t('reports.text_26')}</Note></div>
            )}
            {selectedLegalEntity && (
              lockedReports?.snapshots.length ? (
                <ul className="mt-4 divide-y divide-line-soft">
                  {lockedReports.snapshots.map((snapshot) => (
                    <li key={snapshot.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="font-medium">{snapshot.legal_entity_name} · {t('reports.versionWord')} <span className="num">{snapshot.version}</span></div>
                        <div className="mt-0.5 break-words text-xs text-ink-muted">
                          {t('reports.createdWord')} {fmtDateTime(snapshot.created_at)} · {snapshot.created_by_name} · {t('reports.layoutWord')} {snapshot.report_version}
                        </div>
                        {(() => {
                          const delivery = lockedReports.deliveries.find((item) => item.snapshot_id === snapshot.id);
                          return delivery ? (
                            <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-done-fg">
                              <CheckCircle2 size={ICON.xs} aria-hidden="true" /> {t('reports.deliveredToAccountant')} {fmtDateTime(delivery.sent_at)} · {delivery.sent_by_name} · {delivery.reason}
                            </div>
                          ) : null;
                        })()}
                      </div>
                      <div className="flex flex-wrap gap-2 self-start sm:self-auto">
                        {canMutateExport && !lockedReports.deliveries.some((item) => item.snapshot_id === snapshot.id) && (
                          <button type="button" className="btn-primary" disabled={busy} onClick={() => setSendSnapshot(snapshot)}>
                            {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <Send size={ICON.sm} aria-hidden="true" />} {t('reports.markDelivered')}
                          </button>
                        )}
                        <button type="button" className="btn-secondary" onClick={() => downloadSnapshot(snapshot)}>
                          <Download size={ICON.sm} aria-hidden="true" /> {t('reports.downloadVersion')} {snapshot.version}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : !lockedReportsFetching && <p className="mt-4 text-sm text-ink-muted">{t('reports.text_27')}</p>
            )}
          </Card>
        </>
      )}

      <div className="print-area monthly-report space-y-4">
        <div className="hidden print:block">
          {/* Printed header handed to the accountant — carries the tenant's own name. */}
          {orgLogoUrl && <img data-testid="monthly-report-logo" src={orgLogoUrl} alt="" className="mb-2 h-14 w-32 object-contain object-right" />}
          <h2 className="text-xl font-semibold">{`${org?.name ? `${org.name} — ` : ''}${t('reports.printHeading', { month: fmtMonth(`${month}-01`) })}`}</h2>
          <p className="text-xs">{t('reports.createdWord')} {fmtDateTime(data.generatedAt)}</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card as={Link} className={metricLinkClass} to={`/invoices?month=${month}`}><div className="text-xs text-ink-muted">{t('reports.kpiInvoices')}</div><div className="kpi-value-compact num">{data.invoices.length}</div></Card>
          <Card as={Link} className={metricLinkClass} to={`/invoices?month=${month}`}><div className="text-xs text-ink-muted">{t('reports.kpiInvoiceTotal')}</div><div className="kpi-value-compact num text-start">{fmtMoneyExact(totals.invoices)}</div></Card>
          <Card as={Link} className={metricLinkClass} to={`/invoices?month=${month}`}><div className="text-xs text-ink-muted">{t('reports.kpiVat')}</div><div className="kpi-value-compact num text-start">{fmtMoneyExact(totals.vat)}</div></Card>
          <Card as={Link} className={metricLinkClass} to={`/payments?month=${month}`}><div className="text-xs text-ink-muted">{t('reports.kpiPaidThisMonth')}</div><div className={`kpi-value-compact num text-start ${totals.paid ? 'text-done-fg' : 'text-idle-fg'}`}>{fmtMoneyExact(totals.paid)}</div></Card>
          <Card as={Link} className={metricLinkClass} to={`/invoices?month=${month}&pay=open`}><div className="text-xs text-ink-muted">{t('reports.kpiUnpaid')}</div><div className={`kpi-value-compact num ${totals.unpaidCount ? 'text-await-fg' : ''}`}>{totals.unpaidCount}</div></Card>
          <Card as={Link} className={metricLinkClass} to={`/bank?month=${month}&status=unmatched`}><div className="text-xs text-ink-muted">{t('reports.kpiUnmatchedBank')}</div><div className={`kpi-value-compact num ${totals.unmatchedBank ? 'text-alert-fg' : ''}`}>{totals.unmatchedBank}</div></Card>
          <Card as={Link} className={metricLinkClass} to={`/bank?month=${month}&status=suggested`}><div className="text-xs text-ink-muted">{t('reports.kpiSuggested')}</div><div className={`kpi-value-compact num ${totals.suggestedBank ? 'text-await-fg' : ''}`}>{totals.suggestedBank}</div></Card>
          <Card as={Link} className={metricLinkClass} to={`/credits?month=${month}&status=all`}><div className="text-xs text-ink-muted">{t('reports.kpiCredits')}</div><div className="kpi-value-compact num">{data.credits.length}</div></Card>
          <Card as={Link} className={metricLinkClass} to="/exceptions?status=open"><div className="text-xs text-ink-muted">{t('reports.kpiOpenExceptions')}</div><div className={`kpi-value-compact num ${data.exceptions.length ? 'text-await-fg' : ''}`}>{data.exceptions.length}</div></Card>
        </div>

        {data.exceptions.length > 0 && (
          <Note tone="await">
            <div className="w-full">
              <h2 className="text-base font-semibold mb-2">{t('reports.openExceptionsHeading', { count: data.exceptions.length })}</h2>
              <ul className="space-y-1 list-disc list-inside">
                {data.exceptions.map((e) => <li key={e.id}>{statusLabel(EXCEPTION_TYPE[e.type])} — {e.title}</li>)}
              </ul>
            </div>
          </Note>
        )}

        <Card pad={false} clip>
          <div className="px-4 py-3 border-b border-line-soft section-title">{t('reports.invoicesForMonth', { month: fmtMonth(`${month}-01`) })}</div>
          <ul className="report-mobile-cards xl:hidden divide-y divide-line-soft print:hidden" aria-label={t('reports.aria_label')}>
            {data.invoices.map((i) => (
              <li key={i.id} className="p-4">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="break-words font-medium text-ink-body">{i.supplier.name}</div>
                    <div className="mt-0.5 text-xs text-ink-muted"><span className="num" dir="ltr">{i.invoice_number}</span> · {fmtDate(i.invoice_date)}</div>
                  </div>
                  <div className="num shrink-0 font-semibold text-ink-body">{fmtMoneyExact(i.total_amount)}</div>
                </div>
                {/* Four figures, not eleven. The wide grid below is where a month is reconciled;
                    a phone card that grew to match it would be a table with extra steps. */}
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div><dt className="text-xs text-ink-muted">{t('reports.fmtMoneyExact')}</dt><dd className="num mt-0.5">{fmtMoneyExact(i.amount_before_vat)}</dd></div>
                  <div><dt className="text-xs text-ink-muted">{t('reports.fmtMoneyExact_2')}</dt><dd className="num mt-0.5">{fmtMoneyExact(i.vat_amount)}</dd></div>
                  <div><dt className="text-xs text-ink-muted">{t('reports.fmtMoneyExact_3')}</dt><dd className="num mt-0.5">{fmtMoneyExact(i.balance?.paid_amount)}</dd></div>
                  <div><dt className="text-xs text-ink-muted">{t('reports.fmtMoneyExact_4')}</dt><dd className="num mt-0.5">{fmtMoneyExact(i.balance?.balance)}</dd></div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusBadge meta={INVOICE_REVIEW_STATUS[i.review_status]} />
                  <StatusBadge meta={INVOICE_PAYMENT_STATUS[i.payment_status]} />
                </div>
                {i.notes && <p className="mt-3 break-words text-xs text-ink-muted">{i.notes}</p>}
              </li>
            ))}
            {!data.invoices.length && <li><EmptyState title={t('reports.title_5')} /></li>}
            {/* A total row standing over no rows is not information — the empty sentence above
                already said everything there is to say about this month. */}
            {totals.hasInvoices && (
              <li className="flex min-h-11 flex-wrap items-center justify-between gap-2 bg-surface-sunken px-4 py-3 font-semibold">
                <span>{t('reports.fmtMoneyExact_5')}</span><span className="num">{fmtMoneyExact(totals.invoices)}</span>
              </li>
            )}
          </ul>
          <div className="report-table-wrap table-scroll hidden overflow-x-auto xl:block print:block" tabIndex={0} role="region" aria-label={t('reports.aria_label_2')}>
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
                <th scope="col" className="th">{t('reports.text_28')}</th><th scope="col" className="th">{t('reports.text_29')}</th><th scope="col" className="th">{t('reports.text_30')}</th>
                <th scope="col" className="th">{t('reports.text_31')}</th>
                <th scope="col" className="th">{t('reports.text_32')}</th><th scope="col" className="th">{t('reports.text_33')}</th><th scope="col" className="th">{t('reports.text_34')}</th>
                <th scope="col" className="th">{t('reports.text_35')}</th><th scope="col" className="th">{t('reports.text_36')}</th>
                <th scope="col" className="th">{t('reports.text_37')}</th><th scope="col" className="th">{t('reports.text_38')}</th>
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
                            <span className="ms-1 text-done-fg" title={statusLabel(INVOICE_EXPORT_STATUS.sent)}>
                              <span aria-hidden="true">✓</span>
                              <span className="sr-only">{statusLabel(INVOICE_EXPORT_STATUS.sent)}</span>
                            </span>
                          )}
                        </td>
                        <td className="td">{fmtDate(i.invoice_date)}</td>
                        <td className="td">{fmtDate(i.received_date)}</td>
                        <td className="td num">{fmtMoneyExact(i.amount_before_vat)}</td>
                        <td className="td num">{fmtMoneyExact(i.vat_amount)}</td>
                        <td className="td num font-medium">{fmtMoneyExact(i.total_amount)}</td>
                        <td className="td num">{fmtMoneyExact(i.balance?.paid_amount)}</td>
                        <td className="td num">{fmtMoneyExact(i.balance?.balance)}</td>
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
                            {credited > 0 && <span className="me-4">{t('reports.fmtMoneyExact_6')} <span className="num">{fmtMoneyExact(credited)}</span></span>}
                            {i.notes && <span className="break-words">{t('reports.notesLabel')} {i.notes}</span>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {/* This table is also the printed sheet the accountant receives. Without this row
                    a first month printed a header, an empty body and a ₪0.00 total line. */}
                {!data.invoices.length && (
                  <tr><td className="td" colSpan={11}><EmptyState className="print:hidden" title={t('reports.title_6')} /><span className="hidden text-ink-muted print:inline">{t('reports.text_39')}</span></td></tr>
                )}
              </tbody>
              {totals.hasInvoices && (
              <tfoot><tr className="border-t-2 border-line font-semibold">
                <th scope="row" className="td text-start font-semibold" colSpan={4}>{t('reports.text_40')}</th>
                <td className="td num">{fmtMoneyExact(totals.beforeVat)}</td>
                <td className="td num">{fmtMoneyExact(totals.vat)}</td>
                <td className="td num">{fmtMoneyExact(totals.invoices)}</td>
                <td className="td num">{fmtMoneyExact(totals.allocated)}</td>
                <td className="td num">{fmtMoneyExact(totals.openBalance)}</td>
                <td colSpan={2} />
              </tr></tfoot>
              )}
            </table>
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card pad={false} clip>
            <div className="px-4 py-3 border-b border-line-soft section-title">{t('reports.text_41')}</div>
            <ul className="report-mobile-cards xl:hidden divide-y divide-line-soft print:hidden" aria-label={t('reports.aria_label_3')}>
              {paymentsBySupplier.map(([name, sum]) => (
                <li key={name} className="flex min-h-11 min-w-0 items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0 break-words text-sm">{name}</span>
                  <span className="num shrink-0 font-medium">{fmtMoneyExact(sum)}</span>
                </li>
              ))}
              {!paymentsBySupplier.length && <li><EmptyState title={t('reports.title_7')} /></li>}
            </ul>
            <div className="report-table-wrap table-scroll hidden overflow-x-auto xl:block print:block" tabIndex={0} role="region" aria-label={t('reports.aria_label_4')}>
            <table className="w-full">
              <thead className="table-head"><tr><th scope="col" className="th">{t('reports.text_42')}</th><th scope="col" className="th">{t('reports.text_43')}</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {paymentsBySupplier.map(([name, sum]) => (
                  <tr key={name}><td className="td">{name}</td><td className="td num font-medium">{fmtMoneyExact(sum)}</td></tr>
                ))}
                {!paymentsBySupplier.length && <tr><td className="td" colSpan={2}><EmptyState className="print:hidden" title={t('reports.title_8')} /><span className="hidden text-ink-muted print:inline">{t('reports.text_44')}</span></td></tr>}
              </tbody>
            </table>
            </div>
          </Card>

          <Card pad={false} clip>
            <div className="px-4 py-3 border-b border-line-soft section-title">{t('reports.text_45')}</div>
            <ul className="report-mobile-cards xl:hidden divide-y divide-line-soft print:hidden" aria-label={t('reports.aria_label_5')}>
              {data.credits.map((c) => (
                <li key={c.id} className="p-4">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="break-words font-medium text-ink-body">{c.supplier.name}</div>
                      <div className="mt-0.5 break-words text-xs text-ink-muted">{statusLabel(CREDIT_REASON[c.reason])}</div>
                    </div>
                    <span className="num shrink-0 font-medium">{fmtMoneyExact(c.amount)}</span>
                  </div>
                  <div className="mt-3"><StatusBadge meta={CREDIT_STATUS[c.status]} /></div>
                </li>
              ))}
              {!data.credits.length && <li><EmptyState title={t('reports.title_9')} /></li>}
            </ul>
            <div className="report-table-wrap table-scroll hidden overflow-x-auto xl:block print:block" tabIndex={0} role="region" aria-label={t('reports.aria_label_6')}>
            <table className="w-full">
              <thead className="table-head"><tr><th scope="col" className="th">{t('reports.text_46')}</th><th scope="col" className="th">{t('reports.text_47')}</th><th scope="col" className="th">{t('reports.text_48')}</th><th scope="col" className="th">{t('reports.text_49')}</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {data.credits.map((c) => (
                  <tr key={c.number}>
                    <td className="td">{c.supplier.name}</td>
                    <td className="td text-ink-muted">{statusLabel(CREDIT_REASON[c.reason])}</td>
                    <td className="td num">{fmtMoneyExact(c.amount)}</td>
                    <td className="td"><StatusBadge meta={CREDIT_STATUS[c.status]} /></td>
                  </tr>
                ))}
                {!data.credits.length && <tr><td className="td" colSpan={4}><EmptyState className="print:hidden" title={t('reports.title_10')} /><span className="hidden text-ink-muted print:inline">{t('reports.text_50')}</span></td></tr>}
              </tbody>
            </table>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
