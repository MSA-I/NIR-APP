import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Upload, Landmark, Link2, AlertTriangle, EyeOff, Loader2, CheckCircle2 } from 'lucide-react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, useToast, Modal, ErrorNote, SkeletonTable, type Column } from '../components/ui';
import { BANK_TX_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, fmtDateTime } from '../lib/format';
import { refreshInvoicePaymentStatus } from '../lib/checks';
import { toHebrewError } from '../lib/errors';
import { logAction } from '../lib/audit';
import type { BankTransaction, BankImport, Supplier } from '../lib/types';

type TxRow = BankTransaction & { supplier: { name: string } | null };

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

export default function Bank() {
  const { profile, org } = useAuth();
  const [params] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState(params.get('status') ?? '');
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<TxRow | null>(null);

  const { data, loading, error, refetch } = useQuery(async () => {
    const txs = unwrap(await supabase.from('bank_transactions')
      .select('*, supplier:suppliers(name)').order('tx_date', { ascending: false })) as TxRow[];
    const imports = unwrap(await supabase.from('bank_imports').select('*').order('imported_at', { ascending: false }).limit(10)) as BankImport[];
    return { txs, imports };
  });

  const rows = (data?.txs ?? []).filter((t) => !statusFilter || t.status === statusFilter);
  const isOffice = !!profile && ['owner', 'office'].includes(profile.role);

  const columns: Column<TxRow>[] = [
    { key: 'date', header: 'תאריך', sortValue: (r) => r.tx_date, render: (r) => fmtDate(r.tx_date) },
    { key: 'desc', header: 'תיאור', render: (r) => <span className="max-w-72 truncate inline-block">{r.description}</span> },
    { key: 'amount', header: 'סכום', className: 'num', sortValue: (r) => r.amount, render: (r) => <span className="font-semibold">{fmtMoneyExact(r.amount)}</span> },
    { key: 'ref', header: 'אסמכתא', render: (r) => <span dir="ltr">{r.reference ?? '—'}</span> },
    { key: 'supplier', header: 'ספק מזוהה', render: (r) => r.supplier?.name ?? <span className="text-slate-400">לא זוהה</span> },
    { key: 'status', header: 'סטטוס', render: (r) => <StatusBadge meta={BANK_TX_STATUS[r.status]} /> },
  ];

  if (loading) return <SkeletonTable cols={6} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title flex items-center gap-2"><Landmark size={22} /> התאמות בנק</h1>
        {isOffice && <button className="btn-primary" onClick={() => setImportOpen(true)}><Upload size={15} /> ייבוא תדפיס בנק</button>}
      </div>

      {data?.imports.length ? (
        <div className="text-xs text-slate-400">
          ייבוא אחרון: {data.imports[0].filename} ({data.imports[0].row_count} שורות, {fmtDateTime(data.imports[0].imported_at)})
        </div>
      ) : null}

      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.description.toLowerCase().includes(q) || (r.reference ?? '').includes(q) || (r.supplier?.name ?? '').toLowerCase().includes(q)}
        onRowClick={isOffice ? (r) => setSelected(r) : undefined}
        toolbar={
          <select className="input w-auto!" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">כל הסטטוסים</option>
            {Object.entries(BANK_TX_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        }
        emptyTitle="אין תנועות בנק" emptySubtitle="ייבא תדפיס בנק (CSV / Excel) כדי להתחיל בהתאמות" />

      {importOpen && <BankImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); void refetch(); }} />}
      {selected && (
        <MatchModal tx={selected} tolerance={org?.settings?.bank_match_amount_tolerance ?? 1} days={org?.settings?.bank_match_days ?? 7}
          onClose={() => setSelected(null)} onChanged={() => { setSelected(null); void refetch(); }} />
      )}
    </div>
  );
}

/* ================= Import wizard: file -> column mapping -> insert ================= */
function BankImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [fileHash, setFileHash] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [map, setMap] = useState({ date: '', description: '', amount: '', reference: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function onFile(file: File) {
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
  }

  async function runImport() {
    if (!map.date || !map.description || !map.amount) { toast('יש למפות לפחות תאריך, תיאור וסכום', 'error'); return; }
    setBusy(true);
    try {
      // duplicate file guard
      const existing = unwrap(await supabase.from('bank_imports').select('id').eq('file_hash', fileHash).maybeSingle()) as { id: string } | null;
      if (existing) { toast('קובץ זה כבר יובא בעבר — הייבוא בוטל', 'error'); setBusy(false); return; }

      const suppliers = unwrap(await supabase.from('suppliers').select('id, name').is('deleted_at', null)) as { id: string; name: string }[];
      const existingHashes = new Set((unwrap(await supabase.from('bank_transactions').select('row_hash')) as { row_hash: string }[]).map((r) => r.row_hash));

      const imp = unwrap(await supabase.from('bank_imports').insert({
        org_id: profile!.org_id, filename: fileName, file_hash: fileHash,
        column_mapping: map, row_count: 0, imported_by: profile!.id,
      }).select('id').single()) as { id: string };

      let inserted = 0, skippedDup = 0, skippedBad = 0;
      for (const raw of rawRows) {
        const date = parseDate(String(raw[map.date] ?? ''));
        const amount = parseAmount(raw[map.amount]);
        const description = String(raw[map.description] ?? '').trim();
        if (!date || !amount || !description) { skippedBad++; continue; }
        const reference = map.reference ? String(raw[map.reference] ?? '').trim() || null : null;
        const rowHash = await sha256(`${date}|${amount}|${reference ?? ''}|${description}`);
        if (existingHashes.has(rowHash)) { skippedDup++; continue; }
        existingHashes.add(rowHash);
        const supplier = suppliers.find((s) => norm(description).includes(norm(s.name)) || norm(s.name).includes(norm(description)));
        const ins = await supabase.from('bank_transactions').insert({
          org_id: profile!.org_id, import_id: imp.id, tx_date: date, description, amount,
          is_debit: true, reference, raw, supplier_id: supplier?.id ?? null,
          status: 'unmatched', row_hash: rowHash,
        });
        if (!ins.error) inserted++;
      }
      await supabase.from('bank_imports').update({ row_count: inserted }).eq('id', imp.id);
      setResult(`יובאו ${inserted} תנועות. דולגו ${skippedDup} כפולות ו־${skippedBad} שורות לא תקינות.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'שגיאה בייבוא', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="ייבוא תדפיס בנק" wide>
      {result ? (
        <div className="space-y-4">
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-3">{result}</div>
          <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>סיום</button></div>
        </div>
      ) : !headers.length ? (
        <div className="text-center py-8">
          <p className="text-sm text-slate-600 mb-4">בחר קובץ CSV או Excel מתדפיס הבנק. השורה המקורית נשמרת במלואה.</p>
          <button className="btn-primary" onClick={() => fileRef.current?.click()}><Upload size={16} /> בחירת קובץ</button>
          <input ref={fileRef} type="file" hidden accept=".csv,.xlsx,.xls" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="text-sm text-slate-600">{fileName} · {rawRows.length} שורות. מיפוי עמודות:</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {([['date', 'תאריך *'], ['description', 'תיאור *'], ['amount', 'סכום (חובה) *'], ['reference', 'אסמכתא']] as const).map(([k, label]) => (
              <div key={k}>
                <label className="label">{label}</label>
                <select className="input" value={map[k]} onChange={(e) => setMap((m) => ({ ...m, [k]: e.target.value }))}>
                  <option value="">—</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="max-h-48 overflow-auto border border-slate-100 rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0"><tr>{headers.map((h) => <th key={h} className="th text-[11px]!">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rawRows.slice(0, 6).map((r, i) => (
                  <tr key={i}>{headers.map((h) => <td key={h} className="td text-xs!">{String(r[h] ?? '')}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => { setHeaders([]); setRawRows([]); }}>קובץ אחר</button>
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
  const { profile } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [supplierId, setSupplierId] = useState(tx.supplier_id ?? '');
  const [chosenInvoices, setChosenInvoices] = useState<Record<string, number>>({});

  const { data, refetch } = useQuery(async () => {
    const suppliers = unwrap(await supabase.from('suppliers').select('id, name').is('deleted_at', null).order('name')) as Supplier[];
    if (!supplierId) return { suppliers, candidates: [] as Candidate[], openInvoices: [] };

    const from = new Date(tx.tx_date); from.setDate(from.getDate() - days);
    const to = new Date(tx.tx_date); to.setDate(to.getDate() + days);

    // candidate payments: recorded transfers awaiting bank match
    const payments = unwrap(await supabase.from('payments')
      .select('id, number, amount, paid_date, reference, payment_request_id, allocations:payment_allocations(invoice_id)')
      .eq('supplier_id', supplierId)) as { id: string; number: number; amount: number; paid_date: string; reference: string | null; payment_request_id: string | null; allocations: { invoice_id: string | null }[] }[];
    const matchedPaymentIds = new Set((unwrap(await supabase.from('bank_allocations').select('payment_id').eq('confirmed', true)) as { payment_id: string | null }[])
      .map((b) => b.payment_id).filter(Boolean));

    const candidates: Candidate[] = [];
    for (const p of payments) {
      if (matchedPaymentIds.has(p.id)) continue;
      const amountOk = Math.abs(p.amount - tx.amount) <= tolerance;
      const dateOk = p.paid_date >= from.toISOString().slice(0, 10) && p.paid_date <= to.toISOString().slice(0, 10);
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
    const invoices = unwrap(await supabase.from('invoices')
      .select('id, invoice_number, invoice_date, total_amount')
      .eq('supplier_id', supplierId).neq('payment_status', 'paid').is('deleted_at', null)) as
      { id: string; invoice_number: string; invoice_date: string; total_amount: number }[];
    const ids = invoices.map((i) => i.id);
    const bals = ids.length ? unwrap(await supabase.from('invoice_balances').select('*').in('invoice_id', ids)) as { invoice_id: string; balance: number }[] : [];
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
    const res = await supabase.from('bank_transactions').update({ supplier_id: supplierId || null }).eq('id', tx.id);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    toast('הספק שויך לתנועה');
    void refetch();
  }

  async function confirmCandidate(c: Candidate) {
    setBusy(true);
    try {
      let paymentId = c.kind === 'payment' ? c.id : null;
      // direct invoice match without a recorded payment -> create the payment record now
      if (c.kind === 'invoice') {
        const pay = unwrap(await supabase.from('payments').insert({
          org_id: profile!.org_id, supplier_id: supplierId, amount: tx.amount, paid_date: tx.tx_date,
          method: 'העברה בנקאית', reference: tx.reference, executed_by: profile!.id,
          notes: `נוצר אוטומטית מהתאמת בנק (${tx.description})`,
        }).select('id').single()) as { id: string };
        paymentId = pay.id;
        const insAlloc = await supabase.from('payment_allocations').insert({ payment_id: paymentId, invoice_id: c.id, amount: Math.min(tx.amount, c.amount) });
        if (insAlloc.error) throw new Error(insAlloc.error.message);
      }
      const ins = await supabase.from('bank_allocations').insert({
        bank_transaction_id: tx.id,
        invoice_id: c.kind === 'invoice' ? c.id : c.invoiceIds[0] ?? null,
        payment_id: paymentId,
        amount: tx.amount, confidence: c.confidence, confirmed: true, created_by: profile!.id,
      });
      if (ins.error) throw new Error(ins.error.message);
      await supabase.from('bank_transactions').update({ status: 'matched', supplier_id: supplierId || tx.supplier_id }).eq('id', tx.id);

      // downstream statuses
      for (const invId of c.invoiceIds) await refreshInvoicePaymentStatus(invId);
      if (c.kind === 'payment') {
        const p = unwrap(await supabase.from('payments').select('payment_request_id').eq('id', c.id).single()) as { payment_request_id: string | null };
        if (p.payment_request_id) await supabase.from('payment_requests').update({ status: 'matched' }).eq('id', p.payment_request_id);
      }
      await logAction({ orgId: tx.org_id, action: 'bank_match_confirmed', entityType: 'bank_transactions', entityId: tx.id, newValues: { candidate: c.label, confidence: c.confidence } });
      toast('ההתאמה אושרה');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'שגיאה באישור ההתאמה', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmManual() {
    const entries = Object.entries(chosenInvoices).filter(([, v]) => v > 0);
    if (!entries.length) return;
    setBusy(true);
    try {
      const pay = unwrap(await supabase.from('payments').insert({
        org_id: profile!.org_id, supplier_id: supplierId, amount: tx.amount, paid_date: tx.tx_date,
        method: 'העברה בנקאית', reference: tx.reference, executed_by: profile!.id,
        notes: `התאמה ידנית מתדפיס בנק (${tx.description})`,
      }).select('id').single()) as { id: string };
      for (const [invId, amount] of entries) {
        await supabase.from('payment_allocations').insert({ payment_id: pay.id, invoice_id: invId, amount });
        await supabase.from('bank_allocations').insert({
          bank_transaction_id: tx.id, invoice_id: invId, payment_id: pay.id, amount,
          confidence: null, confirmed: true, created_by: profile!.id,
        });
        await refreshInvoicePaymentStatus(invId);
      }
      await supabase.from('bank_transactions').update({ status: 'matched', supplier_id: supplierId }).eq('id', tx.id);
      await logAction({ orgId: tx.org_id, action: 'bank_match_manual', entityType: 'bank_transactions', entityId: tx.id, newValues: { invoices: entries } });
      toast('ההתאמה הידנית נשמרה');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'שגיאה', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openException() {
    setBusy(true);
    const type = supplierId ? 'payment_without_invoice' : 'unknown_supplier';
    const res = await supabase.from('exceptions').insert({
      org_id: tx.org_id, type, severity: 'medium', status: 'open',
      title: supplierId
        ? `תשלום ללא חשבונית — ${data?.suppliers.find((s) => s.id === supplierId)?.name ?? ''} (${fmtMoneyExact(tx.amount)})`
        : `העברה לגורם לא מזוהה — ${fmtMoneyExact(tx.amount)}`,
      details: { description: tx.description, date: tx.tx_date, amount: tx.amount },
      supplier_id: supplierId || null, bank_transaction_id: tx.id, assigned_role: 'office',
    });
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    toast('נפתח חריג לבירור');
    onChanged();
  }

  async function ignore() {
    const res = await supabase.from('bank_transactions').update({ status: 'ignored' }).eq('id', tx.id);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    toast('התנועה סומנה כלא רלוונטית');
    onChanged();
  }

  const chosenSum = Object.values(chosenInvoices).reduce((s, v) => s + v, 0);

  return (
    <Modal open onClose={onClose} title="התאמת תנועת בנק" wide>
      <div className="space-y-4">
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <span>{fmtDate(tx.tx_date)} · {tx.description}</span>
            <span className="font-bold num">{fmtMoneyExact(tx.amount)}</span>
          </div>
          {tx.reference && <div className="text-xs text-slate-400 mt-1">אסמכתא: <span dir="ltr">{tx.reference}</span></div>}
        </div>

        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="label">ספק</label>
            <select className="input" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setChosenInvoices({}); }}>
              <option value="">לא מזוהה</option>
              {data?.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          {supplierId !== (tx.supplier_id ?? '') && <button className="btn-secondary" onClick={() => void assignSupplier()}>שיוך ספק</button>}
        </div>

        {supplierId && (
          <>
            <div>
              <div className="text-sm font-medium text-slate-600 mb-1.5">הצעות התאמה</div>
              {data?.candidates.length ? (
                <div className="space-y-2">
                  {data.candidates.map((c) => (
                    <div key={`${c.kind}-${c.id}`} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 text-sm">
                      <Link2 size={15} className="text-indigo-500 shrink-0" />
                      <span className="flex-1">{c.label}</span>
                      <span className={`badge ${c.confidence >= 0.85 ? 'bg-emerald-100 text-emerald-800' : c.confidence >= 0.7 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>
                        ביטחון {(c.confidence * 100).toFixed(0)}%
                      </span>
                      <button className="btn-primary py-1.5!" disabled={busy} onClick={() => void confirmCandidate(c)}>
                        <CheckCircle2 size={14} /> אישור
                      </button>
                    </div>
                  ))}
                </div>
              ) : <div className="text-sm text-slate-400">אין הצעות אוטומטיות — ניתן להתאים ידנית מטה</div>}
            </div>

            <div>
              <div className="text-sm font-medium text-slate-600 mb-1.5">התאמה ידנית — פיצול בין חשבוניות פתוחות</div>
              {data?.openInvoices.length ? (
                <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-48 overflow-y-auto">
                  {data.openInvoices.map((inv) => {
                    const checked = inv.id in chosenInvoices;
                    return (
                      <div key={inv.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <input type="checkbox" className="rounded" checked={checked}
                          onChange={(e) => setChosenInvoices((c) => {
                            const next = { ...c };
                            if (e.target.checked) next[inv.id] = Math.min(inv.balance, tx.amount - chosenSum > 0 ? tx.amount - chosenSum : inv.balance);
                            else delete next[inv.id];
                            return next;
                          })} />
                        <span className="flex-1">חשבונית <b dir="ltr">{inv.invoice_number}</b> · {fmtDate(inv.invoice_date)}</span>
                        <span className="text-xs text-slate-400 num">יתרה {fmtMoneyExact(inv.balance)}</span>
                        {checked && (
                          <input type="number" step="0.01" className="input w-28! num" value={chosenInvoices[inv.id]}
                            onChange={(e) => setChosenInvoices((c) => ({ ...c, [inv.id]: Number(e.target.value) || 0 }))} />
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : <div className="text-sm text-slate-400">אין חשבוניות פתוחות לספק</div>}
              {chosenSum > 0 && (
                <div className="flex items-center justify-between mt-2 text-sm">
                  <span className={Math.abs(chosenSum - tx.amount) > 1 ? 'text-amber-600' : 'text-emerald-600'}>
                    הוקצה {fmtMoneyExact(chosenSum)} מתוך {fmtMoneyExact(tx.amount)}
                  </span>
                  <button className="btn-primary" disabled={busy} onClick={() => void confirmManual()}>אישור התאמה ידנית</button>
                </div>
              )}
            </div>
          </>
        )}

        <div className="flex flex-wrap justify-between gap-2 pt-2 border-t border-slate-100">
          <button className="btn-ghost text-slate-500" disabled={busy} onClick={() => void ignore()}><EyeOff size={15} /> לא רלוונטית (לא ספק)</button>
          <button className="btn-secondary text-amber-700" disabled={busy} onClick={() => void openException()}>
            <AlertTriangle size={15} /> פתיחת חריג לבירור
          </button>
        </div>
      </div>
    </Modal>
  );
}
