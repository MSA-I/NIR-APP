import { CreditCard, X } from 'lucide-react';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { DataTable, ErrorNote, SkeletonTable, type Column } from '../components/ui';
import { fmtMoneyExact, fmtDate } from '../lib/format';
import type { Payment } from '../lib/types';
import { fetchAll } from '../lib/supabasePaging';

type Row = Payment & {
  supplier: { name: string };
  allocations: { amount: number; invoice: { invoice_number: string } | null }[];
  executor: { full_name: string } | null;
};

export default function Payments() {
  const [params, setParams] = useSearchParams();
  const { data, loading, error } = useQuery(async () =>
    fetchAll<Row>((from, to) => supabase.from('payments')
      .select('*, supplier:suppliers(name), allocations:payment_allocations(amount, invoice:invoices(invoice_number)), executor:profiles!p0_payments_actor_tenant_fk(full_name)')
      .order('paid_date', { ascending: false }).order('id').range(from, to)));

  useEffect(() => {
    const id = params.get('id');
    if (!id || !data || data.some((row) => row.id === id)) return;
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('id');
      return next;
    }, { replace: true });
  }, [data, params, setParams]);

  const columns: Column<Row>[] = [
    { key: 'num', header: 'מס׳', sortValue: (r) => r.number, render: (r) => `#${r.number}` },
    { key: 'supplier', header: 'ספק', sortValue: (r) => r.supplier.name, render: (r) => <span className="font-medium">{r.supplier.name}</span> },
    { key: 'date', header: 'תאריך', sortValue: (r) => r.paid_date, render: (r) => fmtDate(r.paid_date) },
    { key: 'amount', header: 'סכום', className: 'num', sortValue: (r) => r.amount, render: (r) => <span className="font-semibold">{fmtMoneyExact(r.amount)}</span> },
    { key: 'method', header: 'אמצעי', render: (r) => r.method ?? '—' },
    { key: 'ref', header: 'אסמכתא', render: (r) => <span dir="ltr">{r.reference ?? '—'}</span> },
    { key: 'executor', header: 'בוצע על ידי', priority: 3, render: (r) => r.executor?.full_name ?? '—' },
    {
      key: 'invoices', header: 'חשבוניות', priority: 3, render: (r) => (
        <span className="text-ink-muted" dir="ltr">
          {r.allocations.filter((a) => a.invoice).map((a) => a.invoice!.invoice_number).join(', ') || '—'}
        </span>
      ),
    },
    { key: 'notes', header: 'הערות', priority: 3, render: (r) => <span className="text-ink-muted max-w-56 truncate inline-block">{r.notes ?? ''}</span> },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error) return <ErrorNote message={error} />;

  // A global-search result opens as ?id= — narrow the table to that one payment (no modal on
  // this page) and offer a dismissible chip back to the full list.
  const allRows = data ?? [];
  const focused = params.get('id') ? allRows.find((r) => r.id === params.get('id')) : null;
  const clearFocus = () => { const next = new URLSearchParams(params); next.delete('id'); setParams(next, { replace: true }); };

  // ?month=YYYY-MM from the dashboard "שולם לספקים החודש" tile. paid_date is a plain date,
  // so a prefix match is the month filter. Read straight off params — useSearchParams
  // re-reads each render, so no mount-only staleness here.
  const monthFilter = params.get('month') ?? '';
  const clearMonth = () => { const next = new URLSearchParams(params); next.delete('month'); setParams(next, { replace: true }); };
  const baseRows = monthFilter ? allRows.filter((r) => r.paid_date?.startsWith(monthFilter)) : allRows;

  return (
    <div className="space-y-4">
      <h1 className="page-title flex items-center gap-2"><CreditCard size={22} /> תשלומים</h1>
      <DataTable rows={focused ? [focused] : baseRows} columns={columns} searchable
        searchFn={(r, q) => r.supplier.name.toLowerCase().includes(q) || (r.reference ?? '').includes(q)}
        mobile="cards"
        mobileTitle={(r) => <>#{r.number} · {r.supplier.name}</>}
        toolbar={focused ? (
          <button className="btn-secondary" onClick={clearFocus}><X size={14} /> מציג תשלום #{focused.number}</button>
        ) : monthFilter ? (
          <button className="btn-secondary" onClick={clearMonth}><X size={14} /> תשלומי חודש <span dir="ltr">{monthFilter}</span></button>
        ) : undefined}
        emptyTitle="לא נרשמו תשלומים" />
    </div>
  );
}
