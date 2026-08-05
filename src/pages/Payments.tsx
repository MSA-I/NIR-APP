import { CreditCard, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { supabase } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { DOMAIN } from '../lib/query/keys';
import { useParamState } from '../lib/useParamState';
import { DataTable, ErrorNote, SkeletonTable, useToast, type ServerColumn } from '../components/ui';
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

type Row = Payment & {
  supplier: { name: string };
  allocations: { amount: number; invoice: { invoice_number: string } | null }[];
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
        select: '*, supplier:suppliers(name), allocations:payment_allocations(amount, invoice:invoices(invoice_number)), executor:profiles!p0_payments_actor_tenant_fk(full_name)',
        predicates,
        sort: uiSort
          ? [{ column: SORT_COLUMN[uiSort[0].column], ascending: uiSort[0].ascending }]
          : DEFAULT_SORT,
        page,
        pageSize: PAGE_SIZE,
      });
      return { ...result, narrowed };
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
      key: 'invoices', header: 'חשבוניות', priority: 3, render: (r) => (
        <span className="text-ink-muted" dir="ltr">
          {r.allocations.filter((a) => a.invoice).map((a) => a.invoice!.invoice_number).join(', ') || '—'}
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
      <h1 className="page-title flex items-center gap-2"><CreditCard size={22} /> תשלומים</h1>
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
        onClearFilters={() => patchParams({ id: '', month: '', q: '', page: '' })}
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
        emptyTitle="לא נרשמו תשלומים" />
    </div>
  );
}
