import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createClient } from '@supabase/supabase-js';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { toHebrewError } from './errors';
import {
  PAGE_NO_LONGER_EXISTS,
  SUPPLIER_SEARCH_ID_CAP,
  SUPPLIER_SEARCH_NARROWED,
  ServerListError,
  fetchServerList,
  formatSortParam,
  lastPageOf,
  monthRangePredicates,
  pageFromParam,
  pageToParam,
  parseSortParam,
  searchSupplierIds,
  twoStepSearchPredicate,
  type ServerListClient,
  type ServerPredicate,
} from './serverList';

/**
 * A real supabase-js client pointed at the MSW base URL, not a hand-written fake.
 *
 * The claims under test are about PostgREST wire behaviour — which query parameters `.range()`
 * produces, where the count comes from, what a 416 looks like once postgrest-js has processed it.
 * A fake builder would let this suite agree with itself while disagreeing with the server.
 * `src/lib/supabase.ts` is deliberately not imported: it throws at module load without
 * `VITE_SUPABASE_URL`, and the tests need a URL the handlers below actually answer.
 */
const client: ServerListClient = createClient(SUPABASE_URL, 'test-anon-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

type Row = { id: string; invoice_number: string };

const invoices = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `inv-${i}`, invoice_number: `${1000 + i}` }));

interface Seen { url: URL; method: string; prefer: string | null }

/**
 * A PostgREST stand-in that answers from a row array.
 *
 * The 416 rule is transcribed from PostgREST rather than invented: it answers 416 when the offset
 * is at or past the total *and* above zero, which is also why offset 0 can never produce one. The
 * rows array is mutable so a test can delete rows between two requests, which is the situation the
 * recovery exists for.
 */
function fakeTable(table: string, rows: Row[], seen: Seen[]) {
  const respond = ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    seen.push({ url, method: request.method, prefer: request.headers.get('prefer') });

    const total = rows.length;
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? String(total));

    if (offset >= total && offset > 0) {
      return HttpResponse.json(
        {
          message: 'Requested range not satisfiable',
          code: 'PGRST103',
          details: `An offset of ${offset} was requested, but there are only ${total} rows.`,
          hint: null,
        },
        { status: 416, headers: { 'content-range': `*/${total}` } },
      );
    }
    if (request.method === 'HEAD') {
      return new HttpResponse(null, { status: 200, headers: { 'content-range': `*/${total}` } });
    }
    const page = rows.slice(offset, offset + limit);
    return HttpResponse.json(page, {
      status: page.length < total ? 206 : 200,
      headers: { 'content-range': `${offset}-${offset + Math.max(page.length - 1, 0)}/${total}` },
    });
  };
  return [
    http.get(`${SUPABASE_URL}/rest/v1/${table}`, respond),
    http.head(`${SUPABASE_URL}/rest/v1/${table}`, respond),
  ];
}

/** Installs the stand-in and hands back the request log every test asserts on. */
function useTable(table: string, rows: Row[]): Seen[] {
  const seen: Seen[] = [];
  server.use(...fakeTable(table, rows, seen));
  return seen;
}

const request = (over: Partial<Parameters<typeof fetchServerList>[1]> = {}) => ({
  table: 'invoices',
  select: '*',
  page: 0,
  pageSize: 10,
  ...over,
});

describe('fetchServerList — paging', () => {
  it('asks for exactly one page and reports the filtered total, not the page length', async () => {
    const seen = useTable('invoices', invoices(42));

    const result = await fetchServerList<Row>(client, request({ page: 2, pageSize: 10 }));

    expect(result.rows).toHaveLength(10);
    expect(result.rows[0].id).toBe('inv-20');
    // The number the screen shows is the number the filters match, not the number transferred.
    expect(result.total).toBe(42);
    expect(result.page).toBe(2);
    expect(result.pageReset).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].url.searchParams.get('offset')).toBe('20');
    expect(seen[0].url.searchParams.get('limit')).toBe('10');
  });

  it('serves a short last page without treating it as the end of the table', async () => {
    useTable('invoices', invoices(42));

    const result = await fetchServerList<Row>(client, request({ page: 4, pageSize: 10 }));

    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(42);
  });

  it('reports what the call cost, because an exact count is not free', async () => {
    useTable('invoices', invoices(42));

    const result = await fetchServerList<Row>(client, request({ page: 1 }));

    expect(result.cost.requests).toBe(1);
    expect(Number.isFinite(result.cost.ms)).toBe(true);
    expect(result.cost.ms).toBeGreaterThanOrEqual(0);
  });

  it('refuses a page size it cannot turn into a range instead of sending limit 0', async () => {
    await expect(fetchServerList<Row>(client, request({ pageSize: 0 })))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(fetchServerList<Row>(client, request({ page: -1 })))
      .rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('fetchServerList — the id tie-breaker', () => {
  it('closes the order clause with id even when the caller sorts by something else', async () => {
    const seen = useTable('invoices', invoices(3));

    await fetchServerList<Row>(client, request({
      sort: [{ column: 'invoice_date', ascending: false }],
    }));

    // Two invoices on the same date have no order between pages without this, so a row shows up
    // twice or not at all as the user pages through.
    expect(seen[0].url.searchParams.get('order')).toBe('invoice_date.desc,id.asc');
  });

  it('adds the tie-breaker when the caller passes no sort at all', async () => {
    const seen = useTable('invoices', invoices(3));

    await fetchServerList<Row>(client, request());

    expect(seen[0].url.searchParams.get('order')).toBe('id.asc');
  });

  it('does not repeat the column when the caller already sorted by it last', async () => {
    const seen = useTable('invoices', invoices(3));

    await fetchServerList<Row>(client, request({ sort: [{ column: 'id', ascending: false }] }));

    expect(seen[0].url.searchParams.get('order')).toBe('id.desc');
  });

  it('carries the tie-breaker on every request the module issues, recovery included', async () => {
    const rows = invoices(42);
    const seen = useTable('invoices', rows);

    await fetchServerList<Row>(client, request({
      page: 5,
      pageSize: 10,
      sort: [{ column: 'invoice_date', ascending: false }],
    }));

    expect(seen.length).toBeGreaterThan(1);
    for (const call of seen) {
      expect(call.url.searchParams.get('order')?.endsWith('id.asc')).toBe(true);
    }
  });
});

describe('fetchServerList — a page that no longer exists', () => {
  it('turns HTTP 416 into the last page that exists, not into an error', async () => {
    const rows = invoices(42);
    const seen = useTable('invoices', rows);

    // The user is on page 5 of a 62-row list; rows are deleted before the request lands.
    const result = await fetchServerList<Row>(client, request({ page: 5, pageSize: 10 }));

    expect(result.page).toBe(4);
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(42);
    expect(result.pageReset).toEqual({ requestedPage: 5, servedPage: 4, message: PAGE_NO_LONGER_EXISTS });
    // Hebrew a business owner can act on, never "Requested range not satisfiable".
    expect(result.pageReset?.message).toMatch(/[֐-׿]/);
    expect(result.pageReset?.message).not.toContain('range');
    // The 416, a count probe, then the page that exists.
    expect(seen.map((call) => call.method)).toEqual(['GET', 'HEAD', 'GET']);
    expect(result.cost.requests).toBe(3);
  });

  it('lands on page 0 when the table empties underneath the user', async () => {
    const rows = invoices(42);
    useTable('invoices', rows);
    rows.length = 0;

    const result = await fetchServerList<Row>(client, request({ page: 5, pageSize: 10 }));

    expect(result.page).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.pageReset?.servedPage).toBe(0);
  });

  it('keeps shrinking the target page until it terminates, even while rows keep disappearing', async () => {
    const rows = invoices(95);
    const seen: Seen[] = [];
    // Every request drops another ten rows, so each recomputed "last page" is already stale when it
    // arrives. The loop still ends: the target page strictly decreases, and page 0 cannot 416.
    server.use(...fakeTable('invoices', rows, seen));
    server.events.on('request:start', () => { rows.splice(0, 10); });

    try {
      const result = await fetchServerList<Row>(client, request({ page: 9, pageSize: 10 }));

      expect(result.page).toBe(0);
      expect(result.pageReset?.requestedPage).toBe(9);
      // Bounded by the proof, not by the observed run: at most one page request and one probe per
      // page from 9 down to 0, plus the request that finally succeeds.
      expect(seen.length).toBeLessThanOrEqual(2 * 10 + 1);
    } finally {
      server.events.removeAllListeners('request:start');
    }
  });

  it('never resolves a 416 into an empty page that would read as "no results"', async () => {
    const rows = invoices(42);
    useTable('invoices', rows);

    const result = await fetchServerList<Row>(client, request({ page: 9, pageSize: 10 }));

    // 42 rows still match. A silent empty list here would tell the user their invoices are gone.
    expect(result.total).toBe(42);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

describe('fetchServerList — the count', () => {
  it('asks for an exact count on every request and never an estimate', async () => {
    const rows = invoices(42);
    const seen = useTable('invoices', rows);

    await fetchServerList<Row>(client, request({ page: 5, pageSize: 10 }));

    expect(seen.length).toBe(3);
    for (const call of seen) expect(call.prefer).toBe('count=exact');
  });

  it('throws count_unavailable rather than showing a total of 0', async () => {
    // No content-range header: this is what an estimated count answers when the planner has no
    // estimate, and what postgrest-js then reports as no count at all.
    server.use(http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json(invoices(3))));

    const failure = await fetchServerList<Row>(client, request()).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ServerListError);
    expect((failure as ServerListError).code).toBe('count_unavailable');
    // Zero is a claim about the business. Refusing to make it is the point.
    expect(failure).not.toMatchObject({ total: 0 });
  });

  it('throws count_unavailable when the total arrives as a non-number', async () => {
    // PostgREST answers `Content-Range: 0-2/*` when it has no total, and postgrest-js parses that
    // with parseInt — which yields NaN, and NaN is not null.
    server.use(http.get(`${SUPABASE_URL}/rest/v1/invoices`, () =>
      HttpResponse.json(invoices(3), { headers: { 'content-range': '0-2/*' } })));

    const failure = await fetchServerList<Row>(client, request()).catch((e: unknown) => e);

    expect((failure as ServerListError).code).toBe('count_unavailable');
    expect(Number.isNaN((failure as { total?: number }).total)).toBe(false);
  });

  it('counts zero honestly when zero really is the answer', async () => {
    useTable('invoices', []);

    const result = await fetchServerList<Row>(client, request());

    expect(result.total).toBe(0);
    expect(result.rows).toEqual([]);
  });
});

describe('fetchServerList — filters', () => {
  it('writes each supported predicate as its PostgREST expression', async () => {
    const seen = useTable('invoices', invoices(1));
    const predicates: ServerPredicate[] = [
      { kind: 'eq', column: 'review_status', value: 'approved' },
      { kind: 'neq', column: 'payment_status', value: 'paid' },
      { kind: 'gte', column: 'invoice_date', value: '2026-08-01' },
      { kind: 'lt', column: 'invoice_date', value: '2026-09-01' },
      { kind: 'gt', column: 'total_amount', value: 0 },
      { kind: 'lte', column: 'total_amount', value: 5000 },
      { kind: 'in', column: 'export_status', values: ['pending', 'sent'] },
      { kind: 'is', column: 'deleted_at', value: null },
      { kind: 'is', column: 'invoice_has_duplicate', value: true },
      { kind: 'not-null', column: 'filed_at' },
      { kind: 'contains-text', column: 'invoice_number', text: '104' },
    ];

    await fetchServerList<Row>(client, request({ predicates }));

    const params = seen[0].url.searchParams;
    expect(params.get('review_status')).toBe('eq.approved');
    expect(params.get('payment_status')).toBe('neq.paid');
    expect(params.getAll('invoice_date')).toEqual(['gte.2026-08-01', 'lt.2026-09-01']);
    expect(params.getAll('total_amount')).toEqual(['gt.0', 'lte.5000']);
    expect(params.get('export_status')).toBe('in.(pending,sent)');
    expect(params.get('deleted_at')).toBe('is.null');
    expect(params.get('invoice_has_duplicate')).toBe('is.true');
    expect(params.get('filed_at')).toBe('not.is.null');
    expect(params.get('invoice_number')).toBe('ilike.%104%');
  });

  it('carries the attention filters as the computed fields 0053 delivered', async () => {
    const seen = useTable('invoices', invoices(1));

    // `Invoices.tsx:92-93` reads both branches off rows already in memory: it counts duplicate keys
    // across the whole result set and checks `order_links.length === 0`. `0053` exposes each as a
    // PostgREST computed field (`handoff/1b-server-list-contract.md` §1), so both become predicates
    // over the whole table rather than over whichever page happened to load.
    await fetchServerList<Row>(client, request({
      predicates: [
        { kind: 'is', column: 'deleted_at', value: null },
        { kind: 'eq', column: 'invoice_without_order', value: true },
      ],
    }));

    expect(seen[0].url.searchParams.get('invoice_without_order')).toBe('eq.true');
    // The computed fields already exclude soft-deleted rows, but the partial indexes behind them
    // are `where deleted_at is null` and a query that omits it does not use them.
    expect(seen[0].url.searchParams.get('deleted_at')).toBe('is.null');
  });

  it('searches more than one column in a single or-group', async () => {
    const seen = useTable('invoices', invoices(1));

    await fetchServerList<Row>(client, request({
      predicates: [{
        kind: 'any-of',
        of: [
          { kind: 'contains-text', column: 'invoice_number', text: '104' },
          { kind: 'contains-text', column: 'supplier_name', text: '104' },
        ],
      }],
    }));

    expect(seen[0].url.searchParams.get('or'))
      .toBe('(invoice_number.ilike.%104%,supplier_name.ilike.%104%)');
  });

  it('quotes a search term containing a comma so the or-group stays one filter', async () => {
    const seen = useTable('invoices', invoices(1));

    await fetchServerList<Row>(client, request({
      predicates: [{
        kind: 'any-of',
        of: [{ kind: 'contains-text', column: 'supplier_name', text: 'כהן, יוסי' }],
      }],
    }));

    // Unquoted, PostgREST would split this into two filters and match far more than the user asked.
    expect(seen[0].url.searchParams.get('or')).toBe('(supplier_name.ilike."%כהן, יוסי%")');
  });

  it('refuses an empty or-group instead of widening the list in silence', async () => {
    useTable('invoices', invoices(1));

    await expect(fetchServerList<Row>(client, request({ predicates: [{ kind: 'any-of', of: [] }] })))
      .rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('emits all-of alone as one and-group', async () => {
    const seen = useTable('invoices', invoices(1));

    await fetchServerList<Row>(client, request({
      predicates: [{
        kind: 'all-of',
        of: [
          { kind: 'eq', column: 'review_status', value: 'approved' },
          { kind: 'is', column: 'deleted_at', value: null },
        ],
      }],
    }));

    // `or=(and(...))` is the same conjunction as `and=(...)` — one emission path for both spellings.
    expect(seen[0].url.searchParams.get('or'))
      .toBe('(and(review_status.eq.approved,deleted_at.is.null))');
  });

  it('emits all-of inside any-of, which is the case it exists for', async () => {
    const seen = useTable('invoices', invoices(1));

    // "matches the text, OR belongs to this supplier within this month" — expressible in one
    // request only as or=(leaf,and(leaf,leaf)).
    await fetchServerList<Row>(client, request({
      predicates: [{
        kind: 'any-of',
        of: [
          { kind: 'contains-text', column: 'invoice_number', text: '104' },
          {
            kind: 'all-of',
            of: [
              { kind: 'eq', column: 'supplier_id', value: 'sup-1' },
              { kind: 'gte', column: 'invoice_date', value: '2026-08-01' },
            ],
          },
        ],
      }],
    }));

    expect(seen[0].url.searchParams.get('or'))
      .toBe('(invoice_number.ilike.%104%,and(supplier_id.eq.sup-1,invoice_date.gte.2026-08-01))');
  });

  it('refuses an empty all-of, alone and nested — "all of nothing" matches everything', async () => {
    useTable('invoices', invoices(1));

    await expect(fetchServerList<Row>(client, request({ predicates: [{ kind: 'all-of', of: [] }] })))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(fetchServerList<Row>(client, request({
      predicates: [{
        kind: 'any-of',
        of: [{ kind: 'eq', column: 'a', value: 1 }, { kind: 'all-of', of: [] }],
      }],
    }))).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('refuses an empty in-list instead of sending in.() to fail at the server', async () => {
    useTable('invoices', invoices(1));

    await expect(fetchServerList<Row>(client, request({
      predicates: [{ kind: 'in', column: 'supplier_id', values: [] }],
    }))).rejects.toMatchObject({ code: 'invalid_request' });
    // The same leaf inside an or-group is held to the same rule.
    await expect(fetchServerList<Row>(client, request({
      predicates: [{ kind: 'any-of', of: [{ kind: 'in', column: 'supplier_id', values: [] }] }],
    }))).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('refuses an empty search term — ilike %% excludes NULLs, unlike .includes("")', async () => {
    useTable('invoices', invoices(1));

    await expect(fetchServerList<Row>(client, request({
      predicates: [{ kind: 'contains-text', column: 'invoice_number', text: '' }],
    }))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(fetchServerList<Row>(client, request({
      predicates: [{ kind: 'any-of', of: [{ kind: 'contains-text', column: 'invoice_number', text: '' }] }],
    }))).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('escapes user-typed % and _ so a search means the characters, not the wildcards', async () => {
    const seen = useTable('invoices', invoices(1));

    await fetchServerList<Row>(client, request({
      predicates: [{ kind: 'contains-text', column: 'invoice_number', text: '50%_' }],
    }));

    // Unescaped, `%50%_%` matches any value containing "50" followed by any character.
    expect(seen[0].url.searchParams.get('invoice_number')).toBe('ilike.%50\\%\\_%');
  });

  it('escapes wildcards inside an or-group too, where the backslash also forces quoting', async () => {
    const seen = useTable('invoices', invoices(1));

    await fetchServerList<Row>(client, request({
      predicates: [{ kind: 'any-of', of: [{ kind: 'contains-text', column: 'invoice_number', text: '50%' }] }],
    }));

    // The escape backslash is itself a reserved character in an or-group, so the pattern arrives
    // quoted with the backslash doubled; PostgREST unquotes it back to %50\%%.
    expect(seen[0].url.searchParams.get('or')).toBe('(invoice_number.ilike."%50\\\\%%")');
  });

  it('applies the same filters to the count probe on the recovery path', async () => {
    const seen = useTable('invoices', invoices(42));

    await fetchServerList<Row>(client, request({
      page: 5,
      pageSize: 10,
      predicates: [{ kind: 'is', column: 'deleted_at', value: null }],
    }));

    // A probe that counted the unfiltered table would send the user to a page that is not there.
    for (const call of seen) expect(call.url.searchParams.get('deleted_at')).toBe('is.null');
    expect(seen[1].url.searchParams.get('offset')).toBeNull();
  });
});

describe('searchSupplierIds — the two-step cross-table search', () => {
  const suppliers = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `sup-${i}` }));

  /** The financial supplier projection answers `select=id` lookups and logs what was asked. */
  function useSuppliers(rows: { id: string }[]): Seen[] {
    const seen: Seen[] = [];
    server.use(http.get(`${SUPABASE_URL}/rest/v1/financial_supplier_directory`, ({ request: req }) => {
      const url = new URL(req.url);
      seen.push({ url, method: req.method, prefer: req.headers.get('prefer') });
      const limit = Number(url.searchParams.get('limit') ?? String(rows.length));
      return HttpResponse.json(rows.slice(0, limit));
    }));
    return seen;
  }

  it('asks suppliers by name with the wildcards escaped, one row past the cap', async () => {
    const seen = useSuppliers(suppliers(2));

    const result = await searchSupplierIds(client, 'כהן 50%');

    expect(result).toEqual({ ids: ['sup-0', 'sup-1'], narrowed: false });
    expect(seen[0].url.searchParams.get('select')).toBe('id');
    expect(seen[0].url.searchParams.get('name')).toBe('ilike.%כהן 50\\%%');
    // The +1 is how "more than the cap" is detected without paying a COUNT.
    expect(seen[0].url.searchParams.get('limit')).toBe(String(SUPPLIER_SEARCH_ID_CAP + 1));
  });

  it('drops the supplier arm entirely past the cap, and says so, instead of truncating it', async () => {
    useSuppliers(suppliers(SUPPLIER_SEARCH_ID_CAP + 1));

    const result = await searchSupplierIds(client, 'בע');

    // Truncating to 150 ids would produce a list — and a total — that silently excludes suppliers
    // the search matches. Dropping the arm keeps the count honest; the screen must then show
    // SUPPLIER_SEARCH_NARROWED so the narrowing is visible rather than quiet.
    expect(result).toEqual({ ids: [], narrowed: true });
    expect(SUPPLIER_SEARCH_NARROWED).toMatch(/[֐-׿]/);
  });

  it('returns every id at exactly the cap — 150 matches is not "too many"', async () => {
    useSuppliers(suppliers(SUPPLIER_SEARCH_ID_CAP));

    const result = await searchSupplierIds(client, 'ספק');

    expect(result.narrowed).toBe(false);
    expect(result.ids).toHaveLength(SUPPLIER_SEARCH_ID_CAP);
  });

  it('refuses an empty term, same as contains-text', async () => {
    await expect(searchSupplierIds(client, '')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('carries a refused lookup as request_failed with Hebrew attached', async () => {
    server.use(http.get(`${SUPABASE_URL}/rest/v1/financial_supplier_directory`, () => HttpResponse.json(
      { message: 'permission denied for view financial_supplier_directory', code: '42501', details: null, hint: null },
      { status: 403 },
    )));

    const failure = await searchSupplierIds(client, 'כהן').catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ServerListError);
    expect((failure as ServerListError).code).toBe('request_failed');
    expect((failure as ServerListError).hebrew).toBe('אין לך הרשאה לבצע את הפעולה הזו.');
  });

  it('composes the screen columns with the supplier arm when there are ids', async () => {
    const seen = useTable('invoices', invoices(1));

    await fetchServerList<Row>(client, request({
      predicates: [twoStepSearchPredicate(['invoice_number'], '104', ['sup-1', 'sup-2'])],
    }));

    expect(seen[0].url.searchParams.get('or'))
      .toBe('(invoice_number.ilike.%104%,supplier_id.in.(sup-1,sup-2))');
  });

  it('composes the screen columns alone when no supplier matched — an empty in is not sent', async () => {
    const seen = useTable('invoices', invoices(1));

    await fetchServerList<Row>(client, request({
      predicates: [twoStepSearchPredicate(['invoice_number', 'reference'], '104', [])],
    }));

    expect(seen[0].url.searchParams.get('or'))
      .toBe('(invoice_number.ilike.%104%,reference.ilike.%104%)');
  });
});

describe('fetchServerList — cancellation', () => {
  it('aborts the request on the wire when the signal fires, and rejects rather than resolving stale', async () => {
    useTable('invoices', invoices(3));
    const controller = new AbortController();
    controller.abort();

    const failure = await fetchServerList<Row>(client, request({ signal: controller.signal }))
      .catch((e: unknown) => e);

    // postgrest-js reports an aborted fetch as an error result; it must surface as a failure,
    // never as an empty page that would read as "no results".
    expect(failure).toBeInstanceOf(ServerListError);
    expect((failure as ServerListError).message).toMatch(/abort/i);
  });

  it('leaves a request with an unfired signal untouched', async () => {
    useTable('invoices', invoices(3));

    const result = await fetchServerList<Row>(client, request({ signal: new AbortController().signal }));

    expect(result.rows).toHaveLength(3);
    expect(result.total).toBe(3);
  });
});

describe('ServerPredicate — a filter with no server expression does not compile', () => {
  /**
   * These assertions are enforced by `tsc --noEmit`, which `npm run build` runs over `src`. If any
   * of these lines ever started compiling, TypeScript would report the `@ts-expect-error` as unused
   * and the build would fail — so the claim cannot rot into a comment.
   */
  it('rejects filters that only JavaScript can evaluate', () => {
    // The duplicate-suspicion branch counts `(supplier_id, invoice_number)` occurrences across the
    // whole result set (`Invoices.tsx:77-84`). Two twins can land on different pages, so computed
    // per page it reports "no duplicates" exactly when there are some. `0053` answers the question
    // properly as `invoice_has_duplicate`; the client-side computation stays unrepresentable, which
    // is what stops a screen from carrying it over unchanged.
    // @ts-expect-error — not a member of the closed union
    const duplicates: ServerPredicate = { kind: 'duplicates-in-result-set', column: 'invoice_number' };

    // `searchFn` and `sortValue` are arbitrary JS (`ui.tsx:597,602`). A callback cannot travel to
    // PostgREST, so it cannot be a predicate.
    // @ts-expect-error — a callback has no server expression
    const callback: ServerPredicate = { kind: 'js', fn: (row: Row) => row.id !== '' };

    // A valid kind with the wrong payload is caught just as hard as an invalid kind.
    // @ts-expect-error — `eq` without a value
    const malformed: ServerPredicate = { kind: 'eq', column: 'review_status' };

    expect([duplicates, callback, malformed]).toHaveLength(3);
  });

  it('accepts the predicates the volume screens actually need', () => {
    const supported = [
      { kind: 'eq', column: 'review_status', value: 'approved' },
      { kind: 'neq', column: 'payment_status', value: 'paid' },
      { kind: 'is', column: 'deleted_at', value: null },
      { kind: 'any-of', of: [{ kind: 'contains-text', column: 'invoice_number', text: 'x' }] },
      { kind: 'all-of', of: [{ kind: 'eq', column: 'status', value: 'open' }] },
      {
        kind: 'any-of',
        of: [
          { kind: 'contains-text', column: 'invoice_number', text: 'x' },
          { kind: 'all-of', of: [{ kind: 'eq', column: 'supplier_id', value: 's' }] },
        ],
      },
    ] satisfies ServerPredicate[];

    expect(supported).toHaveLength(6);
  });

  it('keeps the nesting one level deep — an or inside an or is a restatement, not a shape', () => {
    // @ts-expect-error — any-of is not a member of any-of; flatten it instead
    const nested: ServerPredicate = { kind: 'any-of', of: [{ kind: 'any-of', of: [] }] };
    // @ts-expect-error — all-of members are leaves; a conjunction of disjunctions has no emission
    const conjunctionOfDisjunctions: ServerPredicate = { kind: 'all-of', of: [{ kind: 'any-of', of: [] }] };

    expect([nested, conjunctionOfDisjunctions]).toHaveLength(2);
  });
});

describe('fetchServerList — errors', () => {
  it('carries Hebrew, and leaves the raw string where the upstream mapper can still read it', async () => {
    server.use(http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json(
      { message: 'permission denied for table invoices', code: '42501', details: null, hint: null },
      { status: 403 },
    )));

    const failure = await fetchServerList<Row>(client, request()).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ServerListError);
    const error = failure as ServerListError;
    expect(error.code).toBe('request_failed');
    expect(error.status).toBe(403);
    expect(error.hebrew).toBe('אין לך הרשאה לבצע את הפעולה הזו.');
    expect(error.hebrew).not.toContain('permission denied');
    // `useQuery` maps whatever it catches through `toHebrewError` again. Keeping `message` raw is
    // what stops that second pass from collapsing a specific sentence into the generic fallback.
    expect(toHebrewError(error)).toBe('אין לך הרשאה לבצע את הפעולה הזו.');
  });

  it('gives a missing count its own Hebrew sentence, not the generic fallback and never a 0', async () => {
    server.use(http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json(invoices(2))));

    const failure = await fetchServerList<Row>(client, request()).catch((e: unknown) => e);

    const error = failure as ServerListError;
    expect(error.code).toBe('count_unavailable');
    expect(error.hebrew).toBe('לא ניתן לאמת כרגע את מספר הרשומות ברשימה. רענן את המסך ונסה שוב.');
    // Named mapping, not the FALLBACK sentence — and the raw message stays mappable upstream.
    expect(error.hebrew).not.toContain('פנה לתמיכה');
    expect(toHebrewError(error)).toBe(error.hebrew);
    // The sentence says "unverified", never "empty": a 0 here would be a claim about the business.
    expect(error.hebrew).not.toContain('0');
  });

  it('never lets a Postgres string reach the reader', async () => {
    server.use(http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json(
      { message: 'null value in column "org_id" violates not-null constraint', code: '23502' },
      { status: 400 },
    )));

    const failure = await fetchServerList<Row>(client, request()).catch((e: unknown) => e);

    const hebrew = (failure as ServerListError).hebrew;
    expect(hebrew).toBe('חסר שדה חובה.');
    expect(hebrew).not.toMatch(/[a-z]{4,}/);
  });
});

describe('lastPageOf', () => {
  it('never points past the end, and never below zero', () => {
    expect(lastPageOf(0, 10)).toBe(0);
    expect(lastPageOf(1, 10)).toBe(0);
    expect(lastPageOf(10, 10)).toBe(0);
    expect(lastPageOf(11, 10)).toBe(1);
    expect(lastPageOf(42, 10)).toBe(4);
  });
});

describe('monthRangePredicates', () => {
  it('turns a month into a half-open range on the ordering column', () => {
    expect(monthRangePredicates('invoice_date', '2026-08')).toEqual([
      { kind: 'gte', column: 'invoice_date', value: '2026-08-01' },
      { kind: 'lt', column: 'invoice_date', value: '2026-09-01' },
    ]);
  });

  it('wraps December into January of the next year', () => {
    expect(monthRangePredicates('paid_date', '2026-12')).toEqual([
      { kind: 'gte', column: 'paid_date', value: '2026-12-01' },
      { kind: 'lt', column: 'paid_date', value: '2027-01-01' },
    ]);
  });

  it('degrades a crafted URL value to "no filter" rather than a Postgres date error', () => {
    expect(monthRangePredicates('tx_date', 'garbage')).toEqual([]);
    expect(monthRangePredicates('tx_date', '2026-13')).toEqual([]);
    expect(monthRangePredicates('tx_date', '2026-00')).toEqual([]);
    expect(monthRangePredicates('tx_date', '')).toEqual([]);
  });
});

describe('page as a URL parameter', () => {
  it('survives the round trip: what navigation restores is the page the user left', () => {
    expect(pageFromParam(pageToParam(0))).toBe(0);
    expect(pageFromParam(pageToParam(3))).toBe(3);
    // Page 0 disappears from the URL entirely rather than lingering as ?page=1.
    expect(pageToParam(0)).toBe('');
    expect(pageToParam(3)).toBe('4');
  });

  it('degrades a crafted value to the first page, never a negative range', () => {
    expect(pageFromParam('garbage')).toBe(0);
    expect(pageFromParam('-2')).toBe(0);
    expect(pageFromParam('0')).toBe(0);
    expect(pageFromParam('')).toBe(0);
  });
});

describe('sort as a URL parameter', () => {
  const sortable = new Set(['date']);

  it('survives the round trip, which is what keeps sort in the URL honest', () => {
    const sort = [{ column: 'date', ascending: false }];
    expect(parseSortParam(formatSortParam(sort), sortable)).toEqual([{ column: 'date', ascending: false }]);
    expect(parseSortParam(formatSortParam([{ column: 'date', ascending: true }]), sortable))
      .toEqual([{ column: 'date', ascending: true }]);
  });

  it('formats no sort as an empty value, so the parameter disappears from the URL', () => {
    expect(formatSortParam(null)).toBe('');
    expect(formatSortParam([])).toBe('');
  });

  it('refuses a crafted sort column instead of handing it to .order()', () => {
    // An undeclared column is either a PostgREST error or an unindexed full sort per page.
    expect(parseSortParam('total.asc', sortable)).toBeNull();
    expect(parseSortParam('date.upside-down', sortable)).toBeNull();
    expect(parseSortParam('', sortable)).toBeNull();
  });
});
