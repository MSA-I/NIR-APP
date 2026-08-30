import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { useCallback, useEffect, useRef, useState } from 'react';
import { reasonOr } from '../lib/reason';
import { useSearchParams } from 'react-router';
import { Upload, Download, Landmark, Link2, AlertTriangle, EyeOff, Loader2, CheckCircle2, Unlink } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { DOMAIN } from '../lib/query/keys';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, useToast, Modal, ErrorNote, PageHeader, SkeletonTable, Note, EmptyState, SubPanel, ICON, type ServerColumn } from '../components/ui';
import { effectiveTolerance } from '../lib/tolerances';
import { BANK_TX_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, fmtDateTime, addCalendarDays } from '../lib/format';
import { toleranceRefusalMessage } from '../lib/errors';
import type { BankTransaction, BankImport } from '../lib/types';
import { useParamState } from '../lib/useParamState';
import { SupplierSelectField, useQuickSupplier } from '../components/QuickSupplierPicker';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';
import { financialSupplierMap, readFinancialSuppliers } from '../lib/financialSuppliers';
import {
  BANK_IMPORT_CONTRACT,
  BANK_IMPORT_HEADERS,
  BANK_IMPORT_TEMPLATE_VERSION,
  parseCanonicalBankImportWorkbook,
  type CanonicalBankImportRow,
} from '../lib/bankImportWorkbook';
import {
  SUPPLIER_SEARCH_NARROWED_KEY,
  fetchServerList,
  formatSortParam,
  monthRangePredicates,
  pageFromParam,
  pageToParam,
  parseSortParam,
  searchSupplierIds,
  twoStepSearchPredicate,
  type ServerListPageReset,
  type ServerPredicate,
  type ServerSort,
} from '../lib/serverList';

type TxRow = Omit<BankTransaction, 'supplier'> & { supplier: { name: string } | null };

async function sha256(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** normalize supplier names for fuzzy contains-matching against bank descriptions */
const norm = (s: string) => s.replace(/["'״׳]/g, '').replace(/בע\s*מ/g, '').replace(/\s+/g, ' ').trim();

const PAGE_SIZE = 15;
/** `bank_transactions_org_date_idx` / `..._org_status_date_idx` (0053): tx_date is the one
    server-backed ordering. The old client-side amount sort was dropped with the conversion. */
const SORTABLE_COLUMNS: ReadonlySet<string> = new Set(['date']);
const SORT_COLUMN: Record<string, string> = { date: 'tx_date' };
const DEFAULT_SORT: readonly ServerSort[] = [{ column: 'tx_date', ascending: false }];

export default function Bank() {
  const { statusLabel, t } = useT();
  const { profile, org, organizationAccess } = useAuth();
  const toast = useToast();
  const [, setParams] = useSearchParams();
  const [statusFilter] = useParamState('status');
  const [monthFilter] = useParamState('month');
  const [idFilter] = useParamState('id');
  const [searchTerm] = useParamState('q');
  const [pageParam] = useParamState('page');
  const [sortParam] = useParamState('sort');
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<TxRow | null>(null);
  const autoOpenedId = useRef<string | null>(null);
  const canOperateBank = organizationAccess.canWrite && !!profile && ['owner', 'accountant'].includes(profile.role);

  /** One atomic URL write — see the note in Invoices.tsx: sequential functional setParams calls
      in the same handler read the same stale snapshot and clobber each other. */
  const patchParams = useCallback((patch: Record<string, string>) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [name, value] of Object.entries(patch)) {
        if (value) next.set(name, value);
        else next.delete(name);
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  const page = pageFromParam(pageParam);
  const uiSort = parseSortParam(sortParam, SORTABLE_COLUMNS);

  const { data, loading, fetching, error, refetch } = useQuery(
    async () => {
      const predicates: ServerPredicate[] = [];
      let narrowed = false;
      if (idFilter) {
        // The ?id= pin bypasses every other filter, exactly as the old in-memory branch did.
        predicates.push({ kind: 'eq', column: 'id', value: idFilter });
      } else {
        if (statusFilter) {
          predicates.push(statusFilter === 'attention'
            ? { kind: 'in', column: 'status', values: ['unmatched', 'suggested'] }
            : { kind: 'eq', column: 'status', value: statusFilter });
        }
        predicates.push(...monthRangePredicates('tx_date', monthFilter));
        if (searchTerm) {
          // description has no trgm index — a search here is a seq scan within the tenant,
          // accepted at current volume (ADR-0007); an index is a DB wave.
          const suppliers = await searchSupplierIds(supabase, searchTerm);
          narrowed = suppliers.narrowed;
          predicates.push(twoStepSearchPredicate(['description', 'reference'], searchTerm, suppliers.ids));
        }
      }
      const result = await fetchServerList<TxRow>(supabase, {
        table: 'bank_transactions',
        select: '*',
        predicates,
        sort: uiSort
          ? [{ column: SORT_COLUMN[uiSort[0].column], ascending: uiSort[0].ascending }]
          : DEFAULT_SORT,
        page,
        pageSize: PAGE_SIZE,
      });
      const suppliers = await financialSupplierMap(result.rows.flatMap((row) => row.supplier_id ? [row.supplier_id] : []));
      return {
        ...result,
        rows: result.rows.map((row) => ({
          ...row,
          supplier: row.supplier_id ? { name: suppliers.get(row.supplier_id)?.name ?? '—' } : null,
        })),
        narrowed,
      };
    },
    [],
    [DOMAIN.bank, 'list', { id: idFilter, status: statusFilter, month: monthFilter, q: searchTerm, sort: sortParam, page }],
    { keepPreviousData: true, structuralSharing: false },
  );

  const imports = useQuery(
    async () => unwrap(await supabase.from('bank_imports').select('*')
      .order('imported_at', { ascending: false }).limit(10)) as BankImport[],
    [],
    [DOMAIN.bank, 'imports'],
  );

  useEffect(() => {
    if (!idFilter || !canOperateBank || !data || autoOpenedId.current === idFilter) return;
    const match = data.rows.find((transaction) => transaction.id === idFilter);
    if (match) { autoOpenedId.current = idFilter; setSelected(match); }
  }, [idFilter, canOperateBank, data]);

  const handledReset = useRef<ServerListPageReset | null>(null);
  useEffect(() => {
    const reset = data?.pageReset ?? null;
    if (!reset || reset === handledReset.current) return;
    handledReset.current = reset;
    toast(t(reset.messageKey));
    patchParams({ page: pageToParam(reset.servedPage) });
  }, [data, toast, patchParams]);

  const refetchAll = useCallback(() => { void refetch(); void imports.refetch(); }, [refetch, imports.refetch]);

  const columns: ServerColumn<TxRow>[] = [
    { key: 'date', header: 'תאריך', render: (r) => fmtDate(r.tx_date) },
    { key: 'desc', header: 'תיאור', render: (r) => <span className="max-w-72 truncate inline-block">{r.description}</span> },
    { key: 'amount', header: 'סכום', className: 'num', render: (r) => <span className="font-semibold">{fmtMoneyExact(r.amount, r.currency)}</span> },
    { key: 'ref', header: 'אסמכתא', className: 'num', render: (r) => <span dir="ltr">{r.reference ?? '—'}</span> },
    { key: 'supplier', header: 'ספק מזוהה', render: (r) => r.supplier?.name ?? <span className="text-ink-muted">לא זוהה</span> },
    { key: 'status', header: 'סטטוס', render: (r) => <StatusBadge meta={BANK_TX_STATUS[r.status]} /> },
  ];

  if (loading) return <SkeletonTable cols={6} />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <SkeletonTable cols={6} />;

  const activeFilters = [idFilter, statusFilter, monthFilter].filter(Boolean).length;

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {imports.error && <ErrorNote message={imports.error} />}
      {fetching && <div className="text-xs text-ink-muted" role="status">{t('bank.text_6')}</div>}
      <PageHeader title={<span className="flex items-center gap-2"><Landmark size={ICON.xl} aria-hidden="true" /> {t('bank.text_7')}</span>}
        meta={`${t('bank.transactionsMeta', { total: data.total })}${activeFilters
          ? t('bank.activeFiltersMeta', { count: activeFilters })
          : ''}`}
        actions={canOperateBank && <button className="btn-primary" onClick={() => setImportOpen(true)}><Upload size={ICON.sm} aria-hidden="true" /> {t('bank.setImportOpen')}</button>} />

      {imports.data?.length ? (
        <div className="text-xs text-ink-muted">
          {t('bank.lastImport', {
            fileName: imports.data[0].filename,
            rowCount: imports.data[0].row_count,
            importedAt: fmtDateTime(imports.data[0].imported_at),
          })}
        </div>
      ) : null}

      <DataTable rows={data.rows} columns={columns}
        error={error}
        server={{
          total: data.total,
          page,
          pageSize: PAGE_SIZE,
          onPageChange: (next) => patchParams({ page: pageToParam(next) }),
          onSortChange: (next) => patchParams({ sort: formatSortParam(next), page: '' }),
          sort: uiSort,
          sortableColumns: SORTABLE_COLUMNS,
          search: { value: searchTerm, onChange: (value) => patchParams({ q: value, page: '' }) },
          fetching,
        }}
        activeFilters={activeFilters}
        onClearFilters={() => patchParams({ id: '', status: '', month: '', q: '', page: '' })}
        columnPicker="bank"
        searchLabel="חיפוש בתנועות בנק"
        rowLabel={(r) => t('bank.transactionRowLabel', {
          date: fmtDate(r.tx_date),
          amount: fmtMoneyExact(r.amount, r.currency),
          description: r.description,
        })}
        onRowClick={canOperateBank ? (r) => setSelected(r) : undefined}
        toolbar={
          <>
            {data.narrowed && <span className="text-xs text-await-fg" role="status">{t(SUPPLIER_SEARCH_NARROWED_KEY)}</span>}
            {idFilter && <button className="btn-ghost text-sm text-action" onClick={() => patchParams({ id: '', page: '' })}>{t('bank.patchParams')}</button>}
            <select className="input w-auto!" aria-label={t('bank.aria_label')} value={statusFilter} onChange={(e) => patchParams({ status: e.target.value, page: '' })}>
              <option value="">{t('bank.text_8')}</option>
              <option value="attention">{t('bank.text_9')}</option>
              {Object.entries(BANK_TX_STATUS).map(([k, v]) => <option key={k} value={k}>{statusLabel(v)}</option>)}
            </select>
            <input type="month" className="input w-auto!" aria-label={t('bank.aria_label_2')} value={monthFilter} onChange={(e) => patchParams({ month: e.target.value, page: '' })} />
          </>
        }
        emptyTitle={t('bank.emptyTitle')} emptySubtitle={t('bank.emptySubtitle')} />

      {importOpen && <BankImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); refetchAll(); }} />}
      {selected && (
        selected.status === 'matched'
          ? <UnmatchModal tx={selected} onClose={() => setSelected(null)} onChanged={() => { setSelected(null); void refetch(); }} />
          /* THE TOLERANCE IS READ IN THE LINE'S OWN CURRENCY, AND MAY BE null. This used to be
             `?? 1` — a shekel-shaped 1 handed to a dollar statement line, which made the screen
             offer matches that `0232` then refused with `bank_match_tolerance_unconfigured`.
             #288 forbids inventing the number, so when it is missing the modal says so instead. */
          : <MatchModal tx={selected} tolerance={effectiveTolerance(org?.settings?.bank_match_amount_tolerance, selected.currency, 'bank_match_amount_tolerance')} days={org?.settings?.bank_match_days ?? 7} canChangeSettings={organizationAccess.canWrite && profile?.role === 'owner'}
              onClose={() => setSelected(null)} onChanged={() => { setSelected(null); void refetch(); }} />
      )}
    </div>
  );
}

function UnmatchModal({ tx, onClose, onChanged }: { tx: TxRow; onClose: () => void; onChanged: () => void }) {
  const { errorText, t } = useT();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function unmatch() {
    setBusy(true);
    try {
      unwrap(await supabase.rpc('unmatch_bank_transaction', {
        p_bank_transaction_id: tx.id,
        p_reason: reasonOr(reason, 'הסרת ההתאמה'),
      }));
      toast(t('bank.toast'));
      onChanged();
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('bank.title')} busy={busy} statusMessage={busy ? t('bank.text_10') : undefined}>
      <div className="space-y-4">
        <SubPanel className="border border-line text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <span>{fmtDate(tx.tx_date)} · {tx.description}</span>
            <span className="font-semibold num">{fmtMoneyExact(tx.amount, tx.currency)}</span>
          </div>
        </SubPanel>
        <Note tone="await">{t('bank.text_11')}</Note>
        <div>
          <label className="label" htmlFor="bank-unmatch-reason">{t('bank.text_12')}</label>
          <input id="bank-unmatch-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" disabled={busy} onClick={onClose}>{t('bank.text_13')}</button>
          <button className="btn-danger" disabled={busy} onClick={() => void unmatch()}>
            {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <Unlink size={ICON.sm} aria-hidden="true" />} {t('bank.removeMatch')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ================= Canonical XLSX import: signature -> preview -> atomic command ================= */
function BankImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { errorText, t } = useT();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [fileHash, setFileHash] = useState('');
  const [rawRows, setRawRows] = useState<CanonicalBankImportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ rowCount: number; idempotent: boolean } | null>(null);
  const [reason, setReason] = useState('');

  const importError: Record<string, string> = {
    bank_import_xlsx_required: t('bank.text_14'),
    bank_import_workbook_invalid: t('bank.text_15'),
    bank_import_sheet_invalid: t('bank.text_16'),
    bank_import_version_unsupported: t('bank.text_17'),
    bank_import_headers_invalid: t('bank.text_18'),
    bank_import_formula_forbidden: t('bank.text_19'),
    bank_import_cell_type_invalid: t('bank.text_20'),
    bank_import_row_invalid: t('bank.text_21'),
    bank_import_row_limit: t('bank.text_22'),
  };

  function downloadTemplate() {
    const anchor = document.createElement('a');
    anchor.href = '/templates/inplace-bank-import-v1.xlsx';
    anchor.download = `inplace-bank-import-v${BANK_IMPORT_TEMPLATE_VERSION}.xlsx`;
    anchor.click();
  }

  async function onFile(file: File) {
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      setFileHash(await sha256(buf));
      setFileName(file.name);
      const parsed = parseCanonicalBankImportWorkbook(buf, file.name);
      if (!parsed.rows.length) { toast(t('bank.toast_2'), 'error'); return; }
      setRawRows(parsed.rows);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      toast(importError[code] ?? t('bank.toast_3'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setBusy(true);
    try {
      const suppliers = await readFinancialSuppliers();
      const normalized = await Promise.all(rawRows.map(async (raw) => {
        const rowHash = await sha256(`${raw.tx_date}|${raw.amount}|${raw.reference ?? ''}|${raw.description}`);
        const supplier = suppliers.find((s) => norm(raw.description).includes(norm(s.name)) || norm(s.name).includes(norm(raw.description)));
        return {
          tx_date: raw.tx_date,
          description: raw.description,
          amount: raw.amount,
          is_debit: raw.is_debit,
          reference: raw.reference,
          raw: raw.raw,
          supplier_id: supplier?.id ?? null,
          row_hash: rowHash,
        };
      }));

      const imported = unwrap(await supabase.rpc('import_bank_transactions', {
        p_filename: fileName,
        p_file_hash: fileHash,
        p_column_mapping: BANK_IMPORT_CONTRACT,
        p_rows: normalized,
        p_reason: reasonOr(reason, 'ייבוא תדפיס הבנק'),
      })) as { row_count: number; idempotent: boolean };
      setResult({ rowCount: imported.row_count, idempotent: imported.idempotent });
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const resultText = result
    ? t(result.idempotent ? 'bank.importAlreadyExists' : 'bank.importSucceeded', { count: result.rowCount })
    : null;

  return (
    <Modal open onClose={onClose} title={t('bank.title_2')} wide busy={busy} statusMessage={resultText ?? (busy ? t('bank.text_23') : undefined)}>
      {result ? (
        <div className="space-y-4">
          <Note tone="done">{resultText}</Note>
          <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>{t('bank.text_24')}</button></div>
        </div>
      ) : !rawRows.length ? (
        <div className="text-center py-8">
          <p className="text-sm text-ink-soft mb-4">{t('bank.canonicalTemplateOnly', { version: BANK_IMPORT_TEMPLATE_VERSION })}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button className="btn-secondary" type="button" onClick={downloadTemplate}><Download size={ICON.sm} aria-hidden="true" /> {t('bank.text_25')}</button>
            <button className="btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={ICON.sm} aria-hidden="true" /> {t('bank.click')}</button>
          </div>
          <input ref={fileRef} type="file" hidden accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="text-sm text-ink-soft">{t('bank.fileSummary', {
            fileName,
            count: rawRows.length,
            version: BANK_IMPORT_TEMPLATE_VERSION,
          })}</div>
          <div className="table-scroll max-h-48 overflow-auto rounded-lg border border-line-soft" tabIndex={0} role="region" aria-label={t('bank.aria_label_3')}>
            <table className="w-full">
              {/* The overrides that used to force .th to 11px and .td to 12px are gone. This is the
                  preview a person reads before importing bank transactions — business data — and
                  DESIGN.md reserves 11px for sidebar group headings, explicitly not for content.
                  The wrapper above already scrolls in both axes, so the canonical scale costs
                  nothing but a wider table. */}
              <thead className="table-head sticky top-0"><tr>{BANK_IMPORT_HEADERS.map((header) => <th key={header} scope="col" className="th">{header}</th>)}</tr></thead>
              <tbody className="divide-y divide-line-soft">
                {rawRows.slice(0, 6).map((row, index) => (
                  <tr key={index}>
                    <td className="td num" dir="ltr">{row.tx_date}</td>
                    <td className="td">{row.description}</td>
                    <td className="td" dir="ltr">{row.direction}</td>
                    <td className="td num">{row.amount}</td>
                    <td className="td num" dir="ltr">{row.reference ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div><label className="label" htmlFor="bank-import-reason">{t('bank.setReason')}</label><input id="bank-import-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => { setRawRows([]); setFileName(''); setFileHash(''); }}>{t('bank.setRawRows')}</button>
            <button className="btn-primary" disabled={busy} onClick={() => void runImport()}>
              {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <Upload size={ICON.sm} aria-hidden="true" />} {t('bank.importAction')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ================= Matching modal: suggestions + manual allocation ================= */
interface Candidate {
  kind: 'payment' | 'invoice';
  id: string;
  labelKey: TKey;
  labelData: {
    number: string | number;
    date: string;
    reference?: string;
    balance?: number;
    /** The invoice's own currency, so the balance in the sentence is not read in the wrong unit. */
    currency?: string;
  };
  amount: number;
  confidence: number;
  invoiceIds: string[]; // invoices to mark paid when confirmed
}

function MatchModal({ tx, tolerance, days, canChangeSettings, onClose, onChanged }: {
  /** `null` when this business has never stated a tolerance for THIS line's currency (#288). */
  tx: TxRow; tolerance: number | null; days: number; canChangeSettings: boolean;
  onClose: () => void; onChanged: () => void;
}) {
  const { errorText, t } = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [supplierId, setSupplierId] = useState(tx.supplier_id ?? '');
  const [chosenInvoices, setChosenInvoices] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [directPaymentId] = useState(() => crypto.randomUUID());

  const { data, loading, error, refetch } = useQuery(async () => {
    const suppliers = await readFinancialSuppliers();
    if (!supplierId) return { suppliers, candidates: [] as Candidate[], openInvoices: [] };

    const fromDate = addCalendarDays(tx.tx_date, -days);
    const toDate = addCalendarDays(tx.tx_date, days);

    // candidate payments: recorded transfers awaiting bank match
    const payments = await fetchAll<{ id: string; number: number; amount: number; currency: string; settlement_amount: number | null; settlement_currency: string | null; paid_date: string; reference: string | null; payment_request_id: string | null; allocations: { invoice_id: string | null }[] }>((from, to) => supabase.from('payments')
      .select('id, number, amount, currency, settlement_amount, settlement_currency, paid_date, reference, payment_request_id, allocations:payment_allocations(invoice_id)')
      .eq('supplier_id', supplierId).order('paid_date').order('id').range(from, to));
    const matchedAllocations = await fetchAll<{ id: string; payment_id: string | null }>((from, to) => supabase.from('bank_allocations')
      .select('id, payment_id').eq('confirmed', true).order('id').range(from, to));
    const matchedPaymentIds = new Set(matchedAllocations
      .map((b) => b.payment_id).filter(Boolean));

    const candidates: Candidate[] = [];
    for (const p of payments) {
      if (matchedPaymentIds.has(p.id)) continue;
      /* THE FIGURE THE STATEMENT LINE IS COMPARED AGAINST IS THE ONE IN THE LINE'S OWN CURRENCY
         (0217, #286). A payment made in the debt's currency is compared on `amount`; a payment
         that settled from an account in another currency recorded what actually left that account,
         and THAT is what the bank line shows. A payment with neither figure in the transaction's
         currency is not a candidate — comparing 3,100 against 11,500 is not a near miss, it is a
         comparison of two different things. */
      const paymentAmountInLineCurrency = p.currency === tx.currency ? p.amount
        : p.settlement_currency === tx.currency ? p.settlement_amount
        : null;
      if (paymentAmountInLineCurrency == null) continue;
      // No tolerance for this currency means the amounts CANNOT be compared, not that they differ.
      // A reference that matches exactly is still a real signal and needs no tolerance, so those
      // candidates survive; nothing that rests on a numeric window does.
      const amountOk = tolerance != null && Math.abs(paymentAmountInLineCurrency - tx.amount) <= tolerance;
      const dateOk = p.paid_date >= fromDate && p.paid_date <= toDate;
      const refOk = !!p.reference && !!tx.reference && p.reference === tx.reference;
      if (!amountOk && !refOk) continue;
      let confidence = 0.5;
      if (amountOk) confidence += 0.25;
      if (dateOk) confidence += 0.1;
      if (refOk) confidence += 0.15;
      candidates.push({
        kind: 'payment', id: p.id,
        labelKey: p.reference ? 'bank.paymentCandidateWithReference' : 'bank.paymentCandidate',
        labelData: {
          number: p.number,
          date: p.paid_date,
          ...(p.reference ? { reference: p.reference } : {}),
        },
        amount: paymentAmountInLineCurrency, confidence: Math.min(0.99, confidence),
        invoiceIds: p.allocations.map((a) => a.invoice_id).filter(Boolean) as string[],
      });
    }

    // candidate open invoices (direct match when no payment was recorded)
    const invoices = await fetchAll<{ id: string; invoice_number: string; invoice_date: string; total_amount: number; currency: string }>((from, to) => supabase.from('invoices')
      .select('id, invoice_number, invoice_date, total_amount, currency')
      .eq('supplier_id', supplierId).eq('financial_role', 'payable').neq('payment_status', 'paid').is('deleted_at', null)
      // A statement line settles a debt of the SAME KIND of money. A dollar invoice is not
      // offered against a shekel line — that route needs a payment carrying both figures (#286),
      // which is the candidate loop above.
      .eq('currency', tx.currency)
      .order('invoice_date').order('id').range(from, to));
    const ids = invoices.map((i) => i.id);
    const bals = ids.length ? await fetchInChunks(ids, (chunk) => fetchAll<{ invoice_id: string; balance_in_currency: number }>((from, to) => supabase.from('invoice_balances_by_currency')
      .select('invoice_id, balance_in_currency').in('invoice_id', chunk).order('invoice_id').range(from, to))) : [];
    const balMap = new Map(bals.map((b) => [b.invoice_id, b.balance_in_currency]));
    const openInvoices = invoices.map((i) => ({ ...i, balance: balMap.get(i.id) ?? i.total_amount })).filter((i) => i.balance > 0);

    for (const inv of openInvoices) {
      if (tolerance != null && Math.abs(inv.balance - tx.amount) <= tolerance) {
        candidates.push({
          kind: 'invoice', id: inv.id,
          labelKey: 'bank.invoiceCandidate',
          labelData: { number: inv.invoice_number, date: inv.invoice_date, balance: inv.balance, currency: inv.currency },
          amount: inv.balance, confidence: 0.7, invoiceIds: [inv.id],
        });
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    return { suppliers, candidates, openInvoices };
  }, [supplierId]);

  async function assignSupplier() {
    setBusy(true);
    try {
      const res = await supabase.rpc('assign_bank_transaction_supplier', {
        p_bank_transaction_id: tx.id,
        p_supplier_id: supplierId || null,
        p_reason: reasonOr(reason, 'פעולה'),
      });
      if (res.error) { toast(errorText(res.error.message), 'error'); return; }
      toast(supplierId ? t('bank.toast_4') : t('bank.toast_5'));
      void refetch();
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmCandidate(c: Candidate) {
    setBusy(true);
    try {
      unwrap(await supabase.rpc('match_bank_transaction', {
        p_bank_transaction_id: tx.id,
        p_supplier_id: supplierId || null,
        p_existing_payment_id: c.kind === 'payment' ? c.id : null,
        p_payment_id: c.kind === 'invoice' ? directPaymentId : null,
        p_allocations: c.kind === 'invoice'
          ? [{ invoice_id: c.id, amount: Math.min(tx.amount, c.amount) }]
          : [],
        p_confidence: c.confidence,
        p_reason: reasonOr(reason, 'אישור ההתאמה'),
      }));
      toast(t('bank.toast_6'));
      onChanged();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmManual() {
    const entries = Object.entries(chosenInvoices).filter(([, v]) => v > 0);
    if (!entries.length) return;
    setBusy(true);
    try {
      unwrap(await supabase.rpc('match_bank_transaction', {
        p_bank_transaction_id: tx.id,
        p_supplier_id: supplierId || null,
        p_existing_payment_id: null,
        p_payment_id: directPaymentId,
        p_allocations: entries.map(([invoice_id, amount]) => ({ invoice_id, amount })),
        p_confidence: null,
        p_reason: reasonOr(reason, 'אישור ההתאמה'),
      }));
      toast(t('bank.toast_7'));
      onChanged();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openException() {
    setBusy(true);
    const res = await supabase.rpc('open_bank_transaction_exception', {
      p_bank_transaction_id: tx.id,
      p_supplier_id: supplierId || null,
      p_reason: reasonOr(reason, 'פתיחת החריג'),
    });
    setBusy(false);
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    toast(t('bank.toast_8'));
    onChanged();
  }

  async function ignore() {
    setBusy(true);
    try {
      const res = await supabase.rpc('ignore_bank_transaction', {
        p_bank_transaction_id: tx.id,
        p_reason: reasonOr(reason, 'סימון התנועה'),
      });
      if (res.error) { toast(errorText(res.error.message), 'error'); return; }
      toast(t('bank.toast_9'));
      onChanged();
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  /**
   * The fourth screen the shared picker was written for (QuickSupplierPicker.tsx:24) — G1, finding 10.
   *
   * A bank charge from a party that is not yet a supplier row left an `accountant` with two exits,
   * both of them statements they did not mean: "לא רלוונטית (לא ספק)", or an exception and a wait.
   * `/suppliers` is closed to that role (App.tsx:228), so there was no third door anywhere.
   *
   * The field is mounted **after** finding 4 gave it an `else` branch, and that order is the whole
   * point: `canCreate` here is owner/office (QuickSupplierPicker.tsx:131), so the accountant gets
   * the select with no button — which, before finding 4, was precisely the silence this change
   * exists to remove. Owner gets the door; accountant gets a sentence naming who to ask.
   */
  const supplierPicker = useQuickSupplier(data?.suppliers, (nextSupplierId) => {
    setSupplierId(nextSupplierId);
    setChosenInvoices({});
  });

  const chosenSum = Object.values(chosenInvoices).reduce((s, v) => s + v, 0);
  const supplierName = data?.suppliers.find((supplier) => supplier.id === supplierId)?.name ?? 'הספק הנבחר';
  const transactionLabel = `תנועת הבנק מיום ${fmtDate(tx.tx_date)} בסכום ${fmtMoneyExact(tx.amount, tx.currency)}`;

  const labelForCandidate = (candidate: Candidate) => {
    const vars: Record<string, string | number> = {
      number: candidate.labelData.number,
      date: fmtDate(candidate.labelData.date),
    };
    if (candidate.labelData.reference) vars.reference = candidate.labelData.reference;
    if (candidate.labelData.balance !== undefined) vars.balance = fmtMoneyExact(candidate.labelData.balance, candidate.labelData.currency);
    return t(candidate.labelKey, vars);
  };

  return (
    <Modal open onClose={onClose} title={t('bank.title_3')} wide busy={busy} statusMessage={busy ? t('bank.text_26') : undefined}>
      <div className="space-y-4">
        <SubPanel className="border border-line text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <span>{fmtDate(tx.tx_date)} · {tx.description}</span>
            <span className="font-semibold num">{fmtMoneyExact(tx.amount, tx.currency)}</span>
          </div>
          {tx.reference && <div className="text-xs text-ink-muted mt-1">{t('bank.text_27')} <span dir="ltr">{tx.reference}</span></div>}
        </SubPanel>

        <div className="flex items-end gap-2">
          {/* id and placeholder are unchanged on purpose — `#bank-match-supplier` and the
              "לא מזוהה" option are what the existing scenarios and the empty value mean here. */}
          <SupplierSelectField picker={supplierPicker} className="flex-1"
            id="bank-match-supplier" label={t('bank.label')} placeholder={t('bank.placeholder')}
            value={supplierId} disabled={loading} />
          {supplierId !== (tx.supplier_id ?? '') && <button className="btn-secondary" disabled={busy || loading} onClick={() => void assignSupplier()}>{t('bank.assignSupplier')}</button>}
        </div>
        <div><label className="label" htmlFor="bank-action-reason">{t('bank.setReason_2')}</label><input id="bank-action-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>

        {loading && <div role="status" className="text-sm text-ink-muted">{t('bank.text_28')}</div>}
        {error && <ErrorNote message={error} />}

        {supplierId && !loading && !error && (
          <>
            {/* A screen that quietly returns nothing teaches people the data is wrong. The reason
                there are no amount-based suggestions here is a setting nobody has stated, and
                saying so is the difference between a missing answer and a missing question (#293). */}
            {/* One wrapper, not prose beside an expression: `.note` is a flex row and every raw
                text run in it becomes its own flex item (noteProse.spec.ts). */}
            {tolerance == null && (
              <Note tone="await">
                <span>
                  {`${tx.currency}: ${toleranceRefusalMessage(canChangeSettings)} `
                    + 'הצעות לפי אסמכתא עדיין מוצגות, והתאמה ידנית פתוחה.'}
                </span>
              </Note>
            )}
            <div>
              <div className="text-sm font-medium text-ink-soft mb-1.5">{t('bank.text_29')}</div>
              {data?.candidates.length ? (
                <div className="space-y-2">
                  {data.candidates.map((c) => {
                    const candidateLabel = labelForCandidate(c);
                    return (
                      <div key={`${c.kind}-${c.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line px-3 py-2.5 text-sm">
                        <Link2 size={ICON.sm} className="text-info-fg shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 basis-full break-words sm:basis-auto">{candidateLabel}</span>
                        <span className={c.confidence >= 0.85 ? 'badge-done' : c.confidence >= 0.7 ? 'badge-await' : 'badge-idle'}>
                          {t('bank.confidence', { percent: (c.confidence * 100).toFixed(0) })}
                        </span>
                        <button className="btn-primary btn-sm" aria-label={t('bank.confirmCandidate', {
                          candidate: candidateLabel,
                          transaction: transactionLabel,
                        })} disabled={busy} onClick={() => void confirmCandidate(c)}>
                          <CheckCircle2 size={ICON.sm} aria-hidden="true" /> {t('bank.confirm')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : <EmptyState compact title={t('bank.title_4')} subtitle={t('bank.subtitle')} />}
            </div>

            <fieldset>
              <legend className="text-sm font-medium text-ink-soft mb-1.5">{t('bank.text_30')}</legend>
              {data?.openInvoices.length ? (
                <div className="max-h-48 divide-y divide-line-soft overflow-y-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label={t('bank.aria_label_4')}>
                  {data.openInvoices.map((inv) => {
                    const checked = inv.id in chosenInvoices;
                    return (
                      <div key={inv.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm">
                        <label className="flex min-h-11 min-w-0 flex-1 basis-full cursor-pointer items-center gap-3 sm:basis-auto">
                          <input type="checkbox" className="size-5 shrink-0 accent-action" checked={checked}
                            aria-label={t('bank.chooseInvoiceForAllocation', {
                              invoice: inv.invoice_number,
                              supplier: supplierName,
                              transaction: transactionLabel,
                            })}
                            onChange={(e) => setChosenInvoices((c) => {
                              const next = { ...c };
                              if (e.target.checked) next[inv.id] = Math.min(inv.balance, tx.amount - chosenSum > 0 ? tx.amount - chosenSum : inv.balance);
                              else delete next[inv.id];
                              return next;
                            })} />
                          <span className="min-w-0 break-words">{t('bank.fmtDate_2')} <b dir="ltr" className="num">{inv.invoice_number}</b> · {fmtDate(inv.invoice_date)}</span>
                        </label>
                        <span className="text-xs text-ink-muted">{t('bank.fmtMoneyExact_2')} <span className="num">{fmtMoneyExact(inv.balance, inv.currency)}</span></span>
                        {checked && (
                          <input type="number" step="0.01" className="input w-28! num" value={chosenInvoices[inv.id]}
                            aria-label={t('bank.allocationAmountForInvoice', {
                              invoice: inv.invoice_number,
                              supplier: supplierName,
                              transaction: transactionLabel,
                            })}
                            onChange={(e) => setChosenInvoices((c) => ({ ...c, [inv.id]: Number(e.target.value) || 0 }))} />
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : <EmptyState compact title={t('bank.title_5')} subtitle={t('bank.subtitle_2')} />}
              {chosenSum > 0 && (
                <div className="flex items-center justify-between mt-2 text-sm">
                  <span className={Math.abs(chosenSum - tx.amount) > 1 ? 'text-await-fg' : 'text-done-fg'}>
                    {t('bank.allocatedOutOf', {
                      allocated: fmtMoneyExact(chosenSum, tx.currency),
                      total: fmtMoneyExact(tx.amount, tx.currency),
                    })}
                  </span>
                  <button className="btn-primary" disabled={busy} onClick={() => void confirmManual()}>{t('bank.confirmManual')}</button>
                </div>
              )}
            </fieldset>
          </>
        )}

        <div className="flex flex-wrap justify-between gap-2 pt-2 border-t border-line-soft">
          <button className="btn-ghost text-ink-muted" disabled={busy} onClick={() => void ignore()}><EyeOff size={ICON.sm} aria-hidden="true" /> {t('bank.ignore')}</button>
          <button className="btn-secondary text-await-fg" disabled={busy} onClick={() => void openException()}>
            <AlertTriangle size={ICON.sm} aria-hidden="true" /> {t('bank.openException')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
