import { CreditCard, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { supabase } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { DOMAIN } from '../lib/query/keys';
import { useParamState } from '../lib/useParamState';
import { DataTable, ErrorNote, Modal, PageHeader, SkeletonTable, useToast, type ServerColumn } from '../components/ui';
import { fmtMoneyExact, fmtDate } from '../lib/format';
import type { Payment } from '../lib/types';
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
import { financialSupplierMap } from '../lib/financialSuppliers';

/** `invoice` is nullable on purpose: an allocation whose invoice is soft-deleted or unreadable
    under RLS still carries money, and the detail card names it instead of dropping it. */
type Row = Omit<Payment, 'supplier'> & {
  supplier: { name: string };
  allocations: { amount: number; invoice: { id: string; invoice_number: string } | null }[];
  executor: { full_name: string } | null;
};

const PAGE_SIZE = 15;
/** `payments_org_paid_date_idx` (0053) is the one server-backed ordering; the old client-side
    sorts on number/supplier/amount were dropped with the conversion. */
const SORTABLE_COLUMNS: ReadonlySet<string> = new Set(['date']);
const SORT_COLUMN: Record<string, string> = { date: 'paid_date' };
const DEFAULT_SORT: readonly ServerSort[] = [{ column: 'paid_date', ascending: false }];

export default function Payments() {
  const toast = useToast();
  const [, setParams] = useSearchParams();
  const [idFilter] = useParamState('id');
  const [monthFilter] = useParamState('month');
  const [searchTerm] = useParamState('q');
  const [pageParam] = useParamState('page');
  const [sortParam] = useParamState('sort');

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
  const [selected, setSelected] = useState<Row | null>(null);

  const { data, loading, fetching, error } = useQuery(
    async () => {
      // A global-search result opens as ?id= — that pin bypasses every other filter, exactly as
      // the old in-memory narrowing did.
      const predicates: ServerPredicate[] = [];
      let narrowed = false;
      if (idFilter) {
        predicates.push({ kind: 'eq', column: 'id', value: idFilter });
      } else {
        // ?month=YYYY-MM from the dashboard "שולם לספקים החודש" tile, now a range on paid_date.
        predicates.push(...monthRangePredicates('paid_date', monthFilter));
        if (searchTerm) {
          const suppliers = await searchSupplierIds(supabase, searchTerm);
          narrowed = suppliers.narrowed;
          predicates.push(twoStepSearchPredicate(['reference'], searchTerm, suppliers.ids));
        }
      }
      const result = await fetchServerList<Row>(supabase, {
        table: 'payments',
        select: '*, allocations:payment_allocations(amount, invoice:invoices(id, invoice_number)), executor:profiles!p0_payments_actor_tenant_fk(full_name)',
        predicates,
        sort: uiSort
          ? [{ column: SORT_COLUMN[uiSort[0].column], ascending: uiSort[0].ascending }]
          : DEFAULT_SORT,
        page,
        pageSize: PAGE_SIZE,
      });
      const suppliers = await financialSupplierMap(result.rows.map((row) => row.supplier_id));
      return {
        ...result,
        rows: result.rows.map((row) => ({
          ...row,
          supplier: { name: suppliers.get(row.supplier_id)?.name ?? '—' },
        })),
        narrowed,
      };
    },
    [],
    [DOMAIN.payments, 'list', { id: idFilter, month: monthFilter, q: searchTerm, sort: sortParam, page }],
    { keepPreviousData: true, structuralSharing: false },
  );

  // A pinned payment that no longer answers drops its pin, as the old in-memory check did.
  // Gated on !fetching: while a request is in flight `data` still belongs to the previous key.
  useEffect(() => {
    if (!idFilter || fetching || !data) return;
    if (data.rows.length === 0) patchParams({ id: '' });
  }, [idFilter, fetching, data, patchParams]);

  // ?id= already pins one payment, so a shared link should land on the card, not on a one-row
  // table the reader still has to click. Keyed on the id that was opened: a background refetch
  // hands back a fresh `data` object, and that must not reopen a card the reader closed.
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!idFilter || fetching || !data || data.rows.length !== 1) return;
    const only = data.rows[0];
    if (autoOpened.current === only.id) return;
    autoOpened.current = only.id;
    setSelected(only);
  }, [idFilter, fetching, data]);

  const handledReset = useRef<ServerListPageReset | null>(null);
  useEffect(() => {
    const reset = data?.pageReset ?? null;
    if (!reset || reset === handledReset.current) return;
    handledReset.current = reset;
    toast(reset.message);
    patchParams({ page: pageToParam(reset.servedPage) });
  }, [data, toast, patchParams]);

  const columns: ServerColumn<Row>[] = [
    { key: 'num', header: 'מס׳', render: (r) => `#${r.number}` },
    { key: 'supplier', header: 'ספק', render: (r) => <span className="font-medium">{r.supplier.name}</span> },
    { key: 'date', header: 'תאריך', render: (r) => fmtDate(r.paid_date) },
    { key: 'amount', header: 'סכום', className: 'num', render: (r) => <span className="font-semibold">{fmtMoneyExact(r.amount)}</span> },
    { key: 'method', header: 'אמצעי', render: (r) => r.method ?? '—' },
    { key: 'ref', header: 'אסמכתא', render: (r) => <span dir="ltr">{r.reference ?? '—'}</span> },
    { key: 'executor', header: 'בוצע על ידי', priority: 3, render: (r) => r.executor?.full_name ?? '—' },
    {
      // Every allocation is listed, hidden invoices included: filtering them away turned a
      // payment whose invoices are all unreadable into '—', which reads as "covered nothing".
      key: 'invoices', header: 'חשבוניות', priority: 3, render: (r) => (
        <span className="text-ink-muted" dir="ltr">
          {r.allocations.map((a) => a.invoice?.invoice_number ?? 'לא זמינה').join(', ') || '—'}
        </span>
      ),
    },
    { key: 'notes', header: 'הערות', priority: 3, render: (r) => <span className="text-ink-muted max-w-56 truncate inline-block">{r.notes ?? ''}</span> },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <SkeletonTable cols={5} />;

  const focused = idFilter ? data.rows[0] ?? null : null;
  const activeFilters = [idFilter, monthFilter].filter(Boolean).length;

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      <PageHeader title={<span className="flex items-center gap-2"><CreditCard size={22} /> תשלומים</span>}
        meta={`${data.total} תשלומים שנרשמו${activeFilters ? ' · תצוגה מסוננת' : ''}`} />
      <DataTable rows={data.rows} columns={columns}
        error={error}
        onRowClick={(row) => setSelected(row)}
        rowLabel={(r) => `תשלום #${r.number}`}
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
        onClearFilters={() => patchParams({ id: '', month: '', q: '', page: '' })}
        columnPicker="payments"
        searchLabel="חיפוש בתשלומים"
        mobile="cards"
        mobileTitle={(r) => <>#{r.number} · {r.supplier.name}</>}
        toolbar={
          <>
            {data.narrowed && <span className="text-xs text-await-fg" role="status">{SUPPLIER_SEARCH_NARROWED}</span>}
            {focused ? (
              <button className="btn-secondary" onClick={() => patchParams({ id: '', page: '' })}><X size={14} /> מציג תשלום #{focused.number}</button>
            ) : monthFilter ? (
              <button className="btn-secondary" onClick={() => patchParams({ month: '', page: '' })}><X size={14} /> תשלומי חודש <span dir="ltr">{monthFilter}</span></button>
            ) : null}
          </>
        }
        emptyTitle="טרם בוצעו תשלומים" emptySubtitle="תשלומים שבוצעו יופיעו כאן כיומן כספי." />
      {selected && <PaymentDetail payment={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/**
 * Everything on this card is already on the loaded row, so it is a modal and not a route.
 *
 * The two questions it cannot answer are named rather than guessed at: `payments` carries
 * `executed_by` (the performer, shown here) but no approver and no approval time — who approved
 * lives in `payment_requests` and `audit_logs` — and `payment_request_id` is on the row but
 * /payment-requests has no ?id= deep link to send it to.
 */
function PaymentDetail({ payment, onClose }: { payment: Row; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={`תשלום #${payment.number} — ${payment.supplier.name}`}>
      <div className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-ink-muted">ספק</dt><dd className="font-medium">{payment.supplier.name}</dd></div>
          <div><dt className="text-ink-muted">סכום</dt><dd className="font-semibold num">{fmtMoneyExact(payment.amount)}</dd></div>
          <div><dt className="text-ink-muted">תאריך תשלום</dt><dd className="num">{fmtDate(payment.paid_date)}</dd></div>
          <div><dt className="text-ink-muted">אמצעי תשלום</dt><dd>{payment.method ?? '—'}</dd></div>
          <div><dt className="text-ink-muted">אסמכתא</dt><dd dir="ltr">{payment.reference ?? '—'}</dd></div>
          <div><dt className="text-ink-muted">בוצע על ידי</dt><dd>{payment.executor?.full_name ?? '—'}</dd></div>
        </dl>

        {payment.notes && <div className="text-sm text-ink-soft bg-surface-sunken rounded-lg px-3 py-2">{payment.notes}</div>}

        <div>
          <div className="text-sm font-medium text-ink-soft mb-1.5">חשבוניות שכוסו בתשלום</div>
          {payment.allocations.length ? (
            <ul className="divide-y divide-line-soft border border-line-soft rounded-lg text-sm">
              {payment.allocations.map((allocation, index) => (
                <li key={allocation.invoice?.id ?? `unavailable-${index}`}>
                  {allocation.invoice ? (
                    <Link to={`/invoices/${allocation.invoice.id}`} onClick={onClose}
                      className="row-hover flex min-h-11 items-center justify-between gap-3 px-3 py-2">
                      <span>חשבונית <b dir="ltr" className="num">{allocation.invoice.invoice_number}</b></span>
                      <span className="num font-medium">{fmtMoneyExact(allocation.amount)}</span>
                    </Link>
                  ) : (
                    // Kept, never filtered: this row carries money, and a detail card that hides
                    // part of the sum tells the reader the payment is smaller than it is.
                    <div className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
                      <span className="text-await-fg">חשבונית שאינה זמינה לצפייה</span>
                      <span className="num font-medium">{fmtMoneyExact(allocation.amount)}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : <div className="text-sm text-await-fg">התשלום אינו מקושר לחשבוניות</div>}
        </div>
      </div>
    </Modal>
  );
}
