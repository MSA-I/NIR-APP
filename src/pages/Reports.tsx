import { useState } from 'react';
import { FileSpreadsheet, Printer, Send, CheckCircle2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge, useToast, ConfirmDialog, ErrorNote, SkeletonCards, Note } from '../components/ui';
import { INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, CREDIT_STATUS, CREDIT_REASON, EXCEPTION_TYPE } from '../lib/status';
import { currentMonthISO, fmtMoneyExact, fmtDate, fmtDateTime, fmtMonth, monthInstantRange, monthRange } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import { fetchAll } from '../lib/supabasePaging';
import { buildMonthlyWorkbook } from '../lib/monthlyReport';
import * as XLSX from 'xlsx';

export default function Reports() {
  const { profile, org } = useAuth();
  const toast = useToast();
  const [month, setMonth] = useState(currentMonthISO());
  const [busy, setBusy] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  const { data, loading, fetching, error, refetch } = useQuery(async () => {
    const { start, end } = monthRange(month);
    const instants = monthInstantRange(month);
    const [invoices, payments, credits, exceptions, bank, exportRes] = await Promise.all([
      fetchAll((from, to) => supabase.from('invoices').select('*, supplier:suppliers(name)')
        .gte('invoice_date', start).lt('invoice_date', end).is('deleted_at', null)
        .order('invoice_date').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('payments').select('*, supplier:suppliers(name)')
        .gte('paid_date', start).lt('paid_date', end).order('paid_date').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('credit_requests').select('*, supplier:suppliers(name)')
        .gte('created_at', instants.start).lt('created_at', instants.end).order('created_at').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('exceptions').select('*, supplier:suppliers(name)')
        .in('status', ['open', 'in_progress']).order('created_at').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('bank_transactions').select('id, status')
        .gte('tx_date', start).lt('tx_date', end).order('tx_date').order('id').range(from, to)),
      supabase.from('monthly_exports').select('*').eq('month', `${month}-01`).maybeSingle(),
    ]);
    return {
      invoices: invoices as ({ id: string; invoice_number: string; invoice_date: string; total_amount: number; amount_before_vat: number; vat_amount: number; review_status: string; payment_status: string; export_status: string; supplier: { name: string } })[],
      payments: payments as ({ id: string; number: number; paid_date: string; amount: number; method: string | null; reference: string | null; supplier: { name: string } })[],
      credits: credits as ({ id: string; number: number; reason: string; amount: number; status: string; supplier: { name: string } })[],
      exceptions: exceptions as ({ id: string; type: string; title: string; supplier: { name: string } | null })[],
      bank: bank as { id: string; status: string }[],
      export: unwrap(exportRes) as { id: string; status: string; sent_at: string | null } | null,
      generatedAt: new Date(),
    };
  }, [month]);

  const isOffice = !!profile && ['owner', 'office'].includes(profile.role);

  function exportExcel() {
    if (!data || fetching || error) return;
    const wb = buildMonthlyWorkbook({
      orgName: org?.name, month, generatedAt: data.generatedAt, data,
      labels: {
        invoiceReview: INVOICE_REVIEW_STATUS,
        invoicePayment: INVOICE_PAYMENT_STATUS,
        creditReason: CREDIT_REASON,
        creditStatus: CREDIT_STATUS,
        exceptionType: EXCEPTION_TYPE,
      },
    });
    // This file lands in an accountant's inbox, and an accountant serves several businesses.
    // The name has to say whose report it is; a fixed tenant name would break multi-tenancy.
    // Strip only what filesystems object to; Hebrew names are fine and are the whole point.
    const slug = (org?.name ?? '').replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-');
    XLSX.writeFile(wb, `${slug || 'supplyflow'}-report-${month}.xlsx`);
  }

  async function markSent(reason?: string) {
    if (!data || !profile || fetching || error) return;
    setBusy(true);
    try {
      unwrap(await supabase.rpc('mark_month_export_sent', {
        p_month: `${month}-01`,
        p_invoice_ids: data.invoices.map((invoice) => invoice.id),
        p_reason: reason?.trim() || null,
      }));
      setSendOpen(false);
      toast('החודש סומן כהועבר לרו״ח');
      void refetch();
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <SkeletonCards count={6} cols={6} title />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <ErrorNote message="שגיאה" />;

  const totals = {
    invoices: data.invoices.reduce((s, i) => s + i.total_amount, 0),
    beforeVat: data.invoices.reduce((s, i) => s + i.amount_before_vat, 0),
    vat: data.invoices.reduce((s, i) => s + i.vat_amount, 0),
    paid: data.payments.reduce((s, p) => s + p.amount, 0),
    unpaidCount: data.invoices.filter((i) => i.payment_status !== 'paid').length,
    unmatchedBank: data.bank.filter((b) => b.status === 'unmatched' || b.status === 'suggested').length,
  };

  // payments grouped by supplier
  const paymentsBySupplier = [...data.payments.reduce((m, p) => {
    m.set(p.supplier.name, (m.get(p.supplier.name) ?? 0) + p.amount);
    return m;
  }, new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && data && <Note tone="idle">הדוח מתעדכן. הייצוא והסימון מושבתים עד להשלמת הרענון.</Note>}
      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div>
          <h1 className="page-title">דוח חודשי לרואת חשבון</h1>
          <p className="mt-1 text-xs text-ink-muted">הנתונים הושלמו {fmtDateTime(data.generatedAt)} ואינם snapshot טרנזקציוני.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="month" className="input w-auto!" value={month} onChange={(e) => setMonth(e.target.value)} />
          <button className="btn-secondary" disabled={fetching || !!error} onClick={exportExcel}><FileSpreadsheet size={15} /> ייצוא Excel</button>
          <button className="btn-secondary" disabled={fetching || !!error} onClick={() => window.print()}><Printer size={15} /> הדפסה / PDF</button>
          {isOffice && (
            data.export?.status === 'sent'
              ? <span className="badge-done flex items-center gap-1"><CheckCircle2 size={13} /> הועבר לרו״ח {data.export.sent_at ? fmtDate(data.export.sent_at) : ''}</span>
              : <button className="btn-primary" disabled={busy || fetching || !!error} onClick={() => setSendOpen(true)}><Send size={15} /> סימון כהועבר לרו״ח</button>
          )}
        </div>
      </div>

      <ConfirmDialog open={sendOpen} onClose={() => setSendOpen(false)}
        onConfirm={(reason) => void markSent(reason)}
        title="סימון הדוח כהועבר לרו״ח"
        message="רשימת החשבוניות הנוכחית תישמר כצילום מצב, וכל הסימון יתבצע בעסקה אחת."
        confirmLabel="סימון כהועבר" requireReason busy={busy} />

      <div className="print-area space-y-4">
        <div className="hidden print:block">
          {/* Printed header handed to the accountant — carries the tenant's own name. */}
          <h2 className="text-xl font-bold">{`${org?.name ? `${org.name} — ` : ''}דוח חודשי ${fmtMonth(`${month}-01`)}`}</h2>
          <p className="text-xs">נוצר {fmtDateTime(data.generatedAt)}</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
          <div className="card card-pad"><div className="text-xs text-ink-muted">חשבוניות</div><div className="text-lg font-bold">{data.invoices.length}</div></div>
          <div className="card card-pad"><div className="text-xs text-ink-muted">סה״כ חשבוניות</div><div className="text-lg font-bold num text-start">{fmtMoneyExact(totals.invoices)}</div></div>
          <div className="card card-pad"><div className="text-xs text-ink-muted">מע״מ</div><div className="text-lg font-bold num text-start">{fmtMoneyExact(totals.vat)}</div></div>
          <div className="card card-pad"><div className="text-xs text-ink-muted">שולם החודש</div><div className="text-lg font-bold num text-start text-done-fg">{fmtMoneyExact(totals.paid)}</div></div>
          <div className="card card-pad"><div className="text-xs text-ink-muted">חשבוניות שטרם שולמו</div><div className={`text-lg font-bold ${totals.unpaidCount ? 'text-await-fg' : ''}`}>{totals.unpaidCount}</div></div>
          <div className="card card-pad"><div className="text-xs text-ink-muted">תנועות בנק ללא התאמה</div><div className={`text-lg font-bold ${totals.unmatchedBank ? 'text-alert-solid' : ''}`}>{totals.unmatchedBank}</div></div>
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
          <div className="px-4 py-3 border-b border-line-soft section-title">חשבוניות {fmtMonth(`${month}-01`)}</div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-sunken"><tr>
                <th className="th">ספק</th><th className="th">מס׳</th><th className="th">תאריך</th>
                <th className="th">לפני מע״מ</th><th className="th">מע״מ</th><th className="th">סה״כ</th>
                <th className="th">בדיקה</th><th className="th">תשלום</th>
              </tr></thead>
              <tbody className="divide-y divide-line-soft">
                {data.invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="td">{i.supplier.name}</td>
                    <td className="td" dir="ltr">{i.invoice_number}</td>
                    <td className="td">{fmtDate(i.invoice_date)}</td>
                    <td className="td num">{fmtMoneyExact(i.amount_before_vat)}</td>
                    <td className="td num">{fmtMoneyExact(i.vat_amount)}</td>
                    <td className="td num font-medium">{fmtMoneyExact(i.total_amount)}</td>
                    <td className="td"><StatusBadge meta={INVOICE_REVIEW_STATUS[i.review_status]} /></td>
                    <td className="td"><StatusBadge meta={INVOICE_PAYMENT_STATUS[i.payment_status]} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t-2 border-line font-bold">
                <td className="td" colSpan={3}>סה״כ</td>
                <td className="td num">{fmtMoneyExact(totals.beforeVat)}</td>
                <td className="td num">{fmtMoneyExact(totals.vat)}</td>
                <td className="td num">{fmtMoneyExact(totals.invoices)}</td>
                <td colSpan={2} />
              </tr></tfoot>
            </table>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-line-soft section-title">תשלומים לפי ספק</div>
            <div className="overflow-x-auto">
            <table className="w-full">
              <tbody className="divide-y divide-line-soft">
                {paymentsBySupplier.map(([name, sum]) => (
                  <tr key={name}><td className="td">{name}</td><td className="td num font-medium">{fmtMoneyExact(sum)}</td></tr>
                ))}
                {!paymentsBySupplier.length && <tr><td className="td text-ink-muted text-center py-6">אין תשלומים בחודש זה</td></tr>}
              </tbody>
            </table>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-line-soft section-title">זיכויים</div>
            <div className="overflow-x-auto">
            <table className="w-full">
              <tbody className="divide-y divide-line-soft">
                {data.credits.map((c) => (
                  <tr key={c.number}>
                    <td className="td">{c.supplier.name}</td>
                    <td className="td text-ink-muted">{CREDIT_REASON[c.reason]}</td>
                    <td className="td num">{fmtMoneyExact(c.amount)}</td>
                    <td className="td"><StatusBadge meta={CREDIT_STATUS[c.status]} /></td>
                  </tr>
                ))}
                {!data.credits.length && <tr><td className="td text-ink-muted text-center py-6">אין זיכויים בחודש זה</td></tr>}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
