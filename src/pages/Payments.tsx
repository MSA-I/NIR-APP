import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { DataTable, PageLoader, ErrorNote, type Column } from '../components/ui';
import { fmtMoneyExact, fmtDate } from '../lib/format';
import type { Payment } from '../lib/types';

type Row = Payment & {
  supplier: { name: string };
  allocations: { amount: number; invoice: { invoice_number: string } | null }[];
};

export default function Payments() {
  const { data, loading, error } = useQuery(async () =>
    unwrap(await supabase.from('payments')
      .select('*, supplier:suppliers(name), allocations:payment_allocations(amount, invoice:invoices(invoice_number))')
      .order('paid_date', { ascending: false })) as Promise<Row[]>);

  const columns: Column<Row>[] = [
    { key: 'num', header: 'מס׳', sortValue: (r) => r.number, render: (r) => `#${r.number}` },
    { key: 'supplier', header: 'ספק', sortValue: (r) => r.supplier.name, render: (r) => <span className="font-medium">{r.supplier.name}</span> },
    { key: 'date', header: 'תאריך', sortValue: (r) => r.paid_date, render: (r) => fmtDate(r.paid_date) },
    { key: 'amount', header: 'סכום', className: 'num', sortValue: (r) => r.amount, render: (r) => <span className="font-semibold">{fmtMoneyExact(r.amount)}</span> },
    { key: 'method', header: 'אמצעי', render: (r) => r.method ?? '—' },
    { key: 'ref', header: 'אסמכתא', render: (r) => <span dir="ltr">{r.reference ?? '—'}</span> },
    {
      key: 'invoices', header: 'חשבוניות', render: (r) => (
        <span className="text-slate-500" dir="ltr">
          {r.allocations.filter((a) => a.invoice).map((a) => a.invoice!.invoice_number).join(', ') || '—'}
        </span>
      ),
    },
    { key: 'notes', header: 'הערות', render: (r) => <span className="text-slate-500 max-w-56 truncate inline-block">{r.notes ?? ''}</span> },
  ];

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <h1 className="page-title">תשלומים</h1>
      <DataTable rows={data ?? []} columns={columns} searchable
        searchFn={(r, q) => r.supplier.name.toLowerCase().includes(q) || (r.reference ?? '').includes(q)}
        emptyTitle="לא נרשמו תשלומים" />
    </div>
  );
}
