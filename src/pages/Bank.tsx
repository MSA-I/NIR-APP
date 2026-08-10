import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Upload, Landmark, Link2, AlertTriangle, EyeOff, Loader2, CheckCircle2, Unlink } from 'lucide-react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { DOMAIN } from '../lib/query/keys';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, useToast, Modal, ErrorNote, PageHeader, SkeletonTable, Note, type ServerColumn } from '../components/ui';
import { BANK_TX_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, fmtDateTime, addCalendarDays } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import type { BankTransaction, BankImport } from '../lib/types';
import { useParamState } from '../lib/useParamState';
import { SupplierSelectField, useQuickSupplier } from '../components/QuickSupplierPicker';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';
import { financialSupplierMap, readFinancialSuppliers } from '../lib/financialSuppliers';
import {
  SUPPLIER_SEARCH_NARROWED,
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

function parseDate(v: string): string | null {
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/); // dd/mm/yyyy
  if (m) {
    const yy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); // ISO
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

const parseAmount = (v: unknown) => Math.abs(Number(String(v ?? '').replace(/[₪,\s]/g, ''))) || 0;

const PAGE_SIZE = 15;
/** `bank_transactions_org_date_idx` / `..._org_status_date_idx` (0053): tx_date is the one
    server-backed ordering. The old client-side amount sort was dropped with the conversion. */
const SORTABLE_COLUMNS: ReadonlySet<string> = new Set(['date']);
const SORT_COLUMN: Record<string, string> = { date: 'tx_date' };
const DEFAULT_SORT: readonly ServerSort[] = [{ column: 'tx_date', ascending: false }];

export default function Bank() {
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
          // accepted at current volume (PLAN-02 §3.2); an index is a DB wave.
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
    toast(reset.message);
    patchParams({ page: pageToParam(reset.servedPage) });
  }, [data, toast, patchParams]);

  const refetchAll = useCallback(() => { void refetch(); void imports.refetch(); }, [refetch, imports.refetch]);

  const columns: ServerColumn<TxRow>[] = [
    { key: 'date', header: 'תאריך', render: (r) => fmtDate(r.tx_date) },
    { key: 'desc', header: 'תיאור', render: (r) => <span className="max-w-72 truncate inline-block">{r.description}</span> },
    { key: 'amount', header: 'סכום', className: 'num', render: (r) => <span className="font-semibold">{fmtMoneyExact(r.amount)}</span> },
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
      {fetching && <div className="text-xs text-ink-muted" role="status">מתעדכן…</div>}
      <PageHeader title={<span className="flex items-center gap-2"><Landmark size={22} /> התאמות בנק</span>}
        meta={`${data.total} תנועות${activeFilters ? ` · ${activeFilters} מסננים פעילים` : ''}`}
        actions={canOperateBank && <button className="btn-primary" onClick={() => setImportOpen(true)}><Upload size={15} /> ייבוא תדפיס בנק</button>} />

      {imports.data?.length ? (
        <div className="text-xs text-ink-muted">
          ייבוא אחרון: {imports.data[0].filename} ({imports.data[0].row_count} שורות, {fmtDateTime(imports.data[0].imported_at)})
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
        rowLabel={(r) => `תנועת בנק מיום ${fmtDate(r.tx_date)} בסכום ${fmtMoneyExact(r.amount)} עבור ${r.description}`}
        onRowClick={canOperateBank ? (r) => setSelected(r) : undefined}
        toolbar={
          <>
            {data.narrowed && <span className="text-xs text-await-fg" role="status">{SUPPLIER_SEARCH_NARROWED}</span>}
            {idFilter && <button className="btn-ghost text-sm text-action" onClick={() => patchParams({ id: '', page: '' })}>הצג את כל התנועות</button>}
            <select className="input w-auto!" aria-label="סינון תנועות בנק לפי סטטוס" value={statusFilter} onChange={(e) => patchParams({ status: e.target.value, page: '' })}>
              <option value="">כל הסטטוסים</option>
              <option value="attention">דורשות התאמה</option>
              {Object.entries(BANK_TX_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <input type="month" className="input w-auto!" aria-label="סינון תנועות בנק לפי חודש" value={monthFilter} onChange={(e) => patchParams({ month: e.target.value, page: '' })} />
          </>
        }
        emptyTitle="אין תנועות בנק" emptySubtitle="ייבא תדפיס בנק (CSV / Excel) כדי להתחיל בהתאמות" />

      {importOpen && <BankImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); refetchAll(); }} />}
      {selected && (
        selected.status === 'matched'
          ? <UnmatchModal tx={selected} onClose={() => setSelected(null)} onChanged={() => { setSelected(null); void refetch(); }} />
          : <MatchModal tx={selected} tolerance={org?.settings?.bank_match_amount_tolerance ?? 1} days={org?.settings?.bank_match_days ?? 7}
              onClose={() => setSelected(null)} onChanged={() => { setSelected(null); void refetch(); }} />
      )}
    </div>
  );
}

function UnmatchModal({ tx, onClose, onChanged }: { tx: TxRow; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function unmatch() {
    if (!reason.trim()) { toast('נדרשת סיבה להסרת ההתאמה', 'error'); return; }
    setBusy(true);
    try {
      unwrap(await supabase.rpc('unmatch_bank_transaction', {
        p_bank_transaction_id: tx.id,
        p_reason: reason.trim(),
      }));
      toast('ההתאמה הוסרה. התשלום נשאר רשום במערכת.');
      onChanged();
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="הסרת התאמת בנק" busy={busy} statusMessage={busy ? 'מסיר את התאמת הבנק' : undefined}>
      <div className="space-y-4">
        <div className="rounded-lg bg-surface-sunken border border-line px-4 py-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <span>{fmtDate(tx.tx_date)} · {tx.description}</span>
            <span className="font-bold num">{fmtMoneyExact(tx.amount)}</span>
          </div>
        </div>
        <Note tone="await">הסרת ההתאמה מחזירה את תנועת הבנק לטיפול ואת דרישת התשלום לסטטוס ״בוצעה״. התשלום והקצאותיו אינם מתבטלים. התאמה ישירה לחשבונית דורשת תיקון כספי נפרד.</Note>
        <div>
          <label className="label" htmlFor="bank-unmatch-reason">סיבה להסרת ההתאמה *</label>
          <input id="bank-unmatch-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button className="btn-danger" disabled={busy} onClick={() => void unmatch()}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Unlink size={15} />} הסרת התאמה
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ================= Import wizard: file -> column mapping -> insert ================= */
function BankImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [fileHash, setFileHash] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [map, setMap] = useState({ date: '', description: '', amount: '', reference: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  async function onFile(file: File) {
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      setFileHash(await sha256(buf));
      setFileName(file.name);
      let rows: Record<string, unknown>[] = [];
      if (file.name.toLowerCase().endsWith('.csv')) {
        const text = new TextDecoder('utf-8').decode(buf);
        const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true });
        rows = parsed.data;
      } else {
        const wb = XLSX.read(buf);
        rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
      }
      if (!rows.length) { toast('הקובץ ריק או לא נקרא', 'error'); return; }
      const hs = Object.keys(rows[0]);
      setHeaders(hs);
      setRawRows(rows);
      // best-effort auto-mapping by common Hebrew headers
      const find = (...names: string[]) => hs.find((h) => names.some((n) => h.includes(n))) ?? '';
      setMap({
        date: find('תאריך', 'date'),
        description: find('תיאור', 'פרטים', 'description'),
        amount: find('חובה', 'סכום', 'amount', 'debit'),
        reference: find('אסמכתא', 'reference', 'סימוכין'),
      });
    } catch {
      toast('קריאת הקובץ נכשלה', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!map.date || !map.description || !map.amount) { toast('יש למפות לפחות תאריך, תיאור וסכום', 'error'); return; }
    if (!reason.trim()) { toast('נדרשת סיבה לייבוא תדפיס הבנק', 'error'); return; }
    setBusy(true);
    try {
      const suppliers = await readFinancialSuppliers();
      const invalidRows: number[] = [];
      const normalized = await Promise.all(rawRows.map(async (raw, index) => {
        const date = parseDate(String(raw[map.date] ?? ''));
        const amount = parseAmount(raw[map.amount]);
        const description = String(raw[map.description] ?? '').trim();
        if (!date || !amount || !description) { invalidRows.push(index + 2); return null; }
        const reference = map.reference ? String(raw[map.reference] ?? '').trim() || null : null;
        const rowHash = await sha256(`${date}|${amount}|${reference ?? ''}|${description}`);
        const supplier = suppliers.find((s) => norm(description).includes(norm(s.name)) || norm(s.name).includes(norm(description)));
        return {
          tx_date: date,
          description,
          amount,
          is_debit: true,
          reference,
          raw,
          supplier_id: supplier?.id ?? null,
          row_hash: rowHash,
        };
      }));
      if (invalidRows.length) {
        throw new Error(`הייבוא בוטל: שורות ${invalidRows.slice(0, 12).join(', ')} אינן כוללות תאריך, תיאור וסכום תקינים.`);
      }

      const imported = unwrap(await supabase.rpc('import_bank_transactions', {
        p_filename: fileName,
        p_file_hash: fileHash,
        p_column_mapping: map,
        p_rows: normalized,
        p_reason: reason.trim(),
      })) as { row_count: number; idempotent: boolean };
      setResult(imported.idempotent
        ? `הקובץ כבר יובא קודם. נמצאו ${imported.row_count} תנועות בייבוא הקיים.`
        : `יובאו ${imported.row_count} תנועות בעסקה אחת.`);
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="ייבוא תדפיס בנק" wide busy={busy} statusMessage={result ?? (busy ? 'מעבד את תדפיס הבנק' : undefined)}>
      {result ? (
        <div className="space-y-4">
          <Note tone="done">{result}</Note>
          <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>סיום</button></div>
        </div>
      ) : !headers.length ? (
        <div className="text-center py-8">
          <p className="text-sm text-ink-soft mb-4">בחר קובץ CSV או Excel מתדפיס הבנק. השורה המקורית נשמרת במלואה.</p>
          <button className="btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={16} /> בחירת קובץ</button>
          <input ref={fileRef} type="file" hidden accept=".csv,.xlsx,.xls" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="text-sm text-ink-soft">{fileName} · {rawRows.length} שורות. מיפוי עמודות:</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {([['date', 'תאריך *'], ['description', 'תיאור *'], ['amount', 'סכום (חובה) *'], ['reference', 'אסמכתא']] as const).map(([k, label]) => (
              <div key={k}>
                <label className="label" htmlFor={`bank-import-${k}`}>{label}</label>
                <select id={`bank-import-${k}`} className="input" value={map[k]} onChange={(e) => setMap((m) => ({ ...m, [k]: e.target.value }))}>
                  <option value="">—</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="max-h-48 overflow-auto border border-line-soft rounded-lg">
            <table className="w-full">
              {/* The overrides that used to force .th to 11px and .td to 12px are gone. This is the
                  preview a person reads before importing bank transactions — business data — and
                  DESIGN.md reserves 11px for sidebar group headings, explicitly not for content.
                  The wrapper above already scrolls in both axes, so the canonical scale costs
                  nothing but a wider table. */}
              <thead className="bg-surface-sunken sticky top-0"><tr>{headers.map((h) => <th key={h} scope="col" className="th">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line-soft">
                {rawRows.slice(0, 6).map((r, i) => (
                  <tr key={i}>{headers.map((h) => <td key={h} className="td">{String(r[h] ?? '')}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <div><label className="label">סיבת הייבוא *</label><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => { setHeaders([]); setRawRows([]); }}>קובץ אחר</button>
            <button className="btn-primary" disabled={busy} onClick={() => void runImport()}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} ייבוא
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
  label: string;
  amount: number;
  confidence: number;
  invoiceIds: string[]; // invoices to mark paid when confirmed
}

function MatchModal({ tx, tolerance, days, onClose, onChanged }: {
  tx: TxRow; tolerance: number; days: number; onClose: () => void; onChanged: () => void;
}) {
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
    const payments = await fetchAll<{ id: string; number: number; amount: number; paid_date: string; reference: string | null; payment_request_id: string | null; allocations: { invoice_id: string | null }[] }>((from, to) => supabase.from('payments')
      .select('id, number, amount, paid_date, reference, payment_request_id, allocations:payment_allocations(invoice_id)')
      .eq('supplier_id', supplierId).order('paid_date').order('id').range(from, to));
    const matchedAllocations = await fetchAll<{ id: string; payment_id: string | null }>((from, to) => supabase.from('bank_allocations')
      .select('id, payment_id').eq('confirmed', true).order('id').range(from, to));
    const matchedPaymentIds = new Set(matchedAllocations
      .map((b) => b.payment_id).filter(Boolean));

    const candidates: Candidate[] = [];
    for (const p of payments) {
      if (matchedPaymentIds.has(p.id)) continue;
      const amountOk = Math.abs(p.amount - tx.amount) <= tolerance;
      const dateOk = p.paid_date >= fromDate && p.paid_date <= toDate;
      const refOk = !!p.reference && !!tx.reference && p.reference === tx.reference;
      if (!amountOk && !refOk) continue;
      let confidence = 0.5;
      if (amountOk) confidence += 0.25;
      if (dateOk) confidence += 0.1;
      if (refOk) confidence += 0.15;
      candidates.push({
        kind: 'payment', id: p.id,
        label: `תשלום #${p.number} · ${fmtDate(p.paid_date)}${p.reference ? ` · אסמכתא ${p.reference}` : ''}`,
        amount: p.amount, confidence: Math.min(0.99, confidence),
        invoiceIds: p.allocations.map((a) => a.invoice_id).filter(Boolean) as string[],
      });
    }

    // candidate open invoices (direct match when no payment was recorded)
    const invoices = await fetchAll<{ id: string; invoice_number: string; invoice_date: string; total_amount: number }>((from, to) => supabase.from('invoices')
      .select('id, invoice_number, invoice_date, total_amount')
      .eq('supplier_id', supplierId).neq('payment_status', 'paid').is('deleted_at', null)
      .order('invoice_date').order('id').range(from, to));
    const ids = invoices.map((i) => i.id);
    const bals = ids.length ? await fetchInChunks(ids, (chunk) => fetchAll<{ invoice_id: string; balance: number }>((from, to) => supabase.from('invoice_balances')
      .select('invoice_id, balance').in('invoice_id', chunk).order('invoice_id').range(from, to))) : [];
    const balMap = new Map(bals.map((b) => [b.invoice_id, b.balance]));
    const openInvoices = invoices.map((i) => ({ ...i, balance: balMap.get(i.id) ?? i.total_amount })).filter((i) => i.balance > 0);

    for (const inv of openInvoices) {
      if (Math.abs(inv.balance - tx.amount) <= tolerance) {
        candidates.push({
          kind: 'invoice', id: inv.id,
          label: `חשבונית ${inv.invoice_number} · ${fmtDate(inv.invoice_date)} (יתרה ${fmtMoneyExact(inv.balance)})`,
          amount: inv.balance, confidence: 0.7, invoiceIds: [inv.id],
        });
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    return { suppliers, candidates, openInvoices };
  }, [supplierId]);

  async function assignSupplier() {
    if (!reason.trim()) { toast('נדרשת סיבה לפעולה', 'error'); return; }
    setBusy(true);
    try {
      const res = await supabase.rpc('assign_bank_transaction_supplier', {
        p_bank_transaction_id: tx.id,
        p_supplier_id: supplierId || null,
        p_reason: reason.trim(),
      });
      if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
      toast(supplierId ? 'הספק שויך לתנועה' : 'שיוך הספק הוסר מהתנועה');
      void refetch();
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmCandidate(c: Candidate) {
    if (!reason.trim()) { toast('נדרשת סיבה לאישור ההתאמה', 'error'); return; }
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
        p_reason: reason.trim(),
      }));
      toast('ההתאמה אושרה');
      onChanged();
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmManual() {
    const entries = Object.entries(chosenInvoices).filter(([, v]) => v > 0);
    if (!entries.length) return;
    if (!reason.trim()) { toast('נדרשת סיבה לאישור ההתאמה', 'error'); return; }
    setBusy(true);
    try {
      unwrap(await supabase.rpc('match_bank_transaction', {
        p_bank_transaction_id: tx.id,
        p_supplier_id: supplierId || null,
        p_existing_payment_id: null,
        p_payment_id: directPaymentId,
        p_allocations: entries.map(([invoice_id, amount]) => ({ invoice_id, amount })),
        p_confidence: null,
        p_reason: reason.trim(),
      }));
      toast('ההתאמה הידנית נשמרה');
      onChanged();
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openException() {
    if (!reason.trim()) { toast('נדרשת סיבה לפתיחת החריג', 'error'); return; }
    setBusy(true);
    const res = await supabase.rpc('open_bank_transaction_exception', {
      p_bank_transaction_id: tx.id,
      p_supplier_id: supplierId || null,
      p_reason: reason.trim(),
    });
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    toast('נפתח חריג לבירור');
    onChanged();
  }

  async function ignore() {
    if (!reason.trim()) { toast('נדרשת סיבה לסימון התנועה', 'error'); return; }
    setBusy(true);
    try {
      const res = await supabase.rpc('ignore_bank_transaction', {
        p_bank_transaction_id: tx.id,
        p_reason: reason.trim(),
      });
      if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
      toast('התנועה סומנה כלא רלוונטית');
      onChanged();
    } catch (error) {
      toast(toHebrewError(error), 'error');
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
  const transactionLabel = `תנועת הבנק מיום ${fmtDate(tx.tx_date)} בסכום ${fmtMoneyExact(tx.amount)}`;

  return (
    <Modal open onClose={onClose} title="התאמת תנועת בנק" wide busy={busy} statusMessage={busy ? 'שומר את התאמת הבנק' : undefined}>
      <div className="space-y-4">
        <div className="rounded-lg bg-surface-sunken border border-line px-4 py-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <span>{fmtDate(tx.tx_date)} · {tx.description}</span>
            <span className="font-bold num">{fmtMoneyExact(tx.amount)}</span>
          </div>
          {tx.reference && <div className="text-xs text-ink-muted mt-1">אסמכתא: <span dir="ltr">{tx.reference}</span></div>}
        </div>

        <div className="flex items-end gap-2">
          {/* id and placeholder are unchanged on purpose — `#bank-match-supplier` and the
              "לא מזוהה" option are what the existing scenarios and the empty value mean here. */}
          <SupplierSelectField picker={supplierPicker} className="flex-1"
            id="bank-match-supplier" label="ספק" placeholder="לא מזוהה"
            value={supplierId} disabled={loading} />
          {supplierId !== (tx.supplier_id ?? '') && <button className="btn-secondary" disabled={busy || loading} onClick={() => void assignSupplier()}>שיוך ספק</button>}
        </div>
        <div><label className="label" htmlFor="bank-action-reason">סיבת הפעולה *</label><input id="bank-action-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>

        {loading && <div role="status" className="text-sm text-ink-muted">טוען ספקים והצעות התאמה…</div>}
        {error && <ErrorNote message={error} />}

        {supplierId && !loading && !error && (
          <>
            <div>
              <div className="text-sm font-medium text-ink-soft mb-1.5">הצעות התאמה</div>
              {data?.candidates.length ? (
                <div className="space-y-2">
                  {data.candidates.map((c) => (
                    <div key={`${c.kind}-${c.id}`} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 text-sm">
                      <Link2 size={15} className="text-info-fg shrink-0" />
                      <span className="flex-1">{c.label}</span>
                      <span className={c.confidence >= 0.85 ? 'badge-done' : c.confidence >= 0.7 ? 'badge-await' : 'badge-idle'}>
                        ביטחון {(c.confidence * 100).toFixed(0)}%
                      </span>
                      <button className="btn-primary py-1.5!" aria-label={`אישור ${c.label} עבור ${transactionLabel}`} disabled={busy} onClick={() => void confirmCandidate(c)}>
                        <CheckCircle2 size={14} /> אישור
                      </button>
                    </div>
                  ))}
                </div>
              ) : <div className="text-sm text-ink-muted">אין הצעות אוטומטיות — ניתן להתאים ידנית מטה</div>}
            </div>

            <fieldset>
              <legend className="text-sm font-medium text-ink-soft mb-1.5">התאמה ידנית — פיצול בין חשבוניות פתוחות</legend>
              {data?.openInvoices.length ? (
                <div className="border border-line rounded-lg divide-y divide-line-soft max-h-48 overflow-y-auto">
                  {data.openInvoices.map((inv) => {
                    const checked = inv.id in chosenInvoices;
                    return (
                      <div key={inv.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <input type="checkbox" className="rounded" checked={checked}
                          aria-label={`בחירת חשבונית ${inv.invoice_number} של ${supplierName} להקצאה עבור ${transactionLabel}`}
                          onChange={(e) => setChosenInvoices((c) => {
                            const next = { ...c };
                            if (e.target.checked) next[inv.id] = Math.min(inv.balance, tx.amount - chosenSum > 0 ? tx.amount - chosenSum : inv.balance);
                            else delete next[inv.id];
                            return next;
                          })} />
                        <span className="flex-1">חשבונית <b dir="ltr" className="num">{inv.invoice_number}</b> · {fmtDate(inv.invoice_date)}</span>
                        <span className="text-xs text-ink-muted num">יתרה {fmtMoneyExact(inv.balance)}</span>
                        {checked && (
                          <input type="number" step="0.01" className="input w-28! num" value={chosenInvoices[inv.id]}
                            aria-label={`סכום ההקצאה לחשבונית ${inv.invoice_number} של ${supplierName} עבור ${transactionLabel}`}
                            onChange={(e) => setChosenInvoices((c) => ({ ...c, [inv.id]: Number(e.target.value) || 0 }))} />
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : <div className="text-sm text-ink-muted">אין חשבוניות פתוחות לספק</div>}
              {chosenSum > 0 && (
                <div className="flex items-center justify-between mt-2 text-sm">
                  <span className={Math.abs(chosenSum - tx.amount) > 1 ? 'text-await-fg' : 'text-done-fg'}>
                    הוקצה {fmtMoneyExact(chosenSum)} מתוך {fmtMoneyExact(tx.amount)}
                  </span>
                  <button className="btn-primary" disabled={busy} onClick={() => void confirmManual()}>אישור התאמה ידנית</button>
                </div>
              )}
            </fieldset>
          </>
        )}

        <div className="flex flex-wrap justify-between gap-2 pt-2 border-t border-line-soft">
          <button className="btn-ghost text-ink-muted" disabled={busy} onClick={() => void ignore()}><EyeOff size={15} /> לא רלוונטית (לא ספק)</button>
          <button className="btn-secondary text-await-fg" disabled={busy} onClick={() => void openException()}>
            <AlertTriangle size={15} /> פתיחת חריג לבירור
          </button>
        </div>
      </div>
    </Modal>
  );
}
