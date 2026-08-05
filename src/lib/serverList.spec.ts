import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createClient } from '@supabase/supabase-js';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { toHebrewError } from './errors';
import {
  PAGE_NO_LONGER_EXISTS,
  ServerListError,
  fetchServerList,
  lastPageOf,
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
      { kind: 'is', column: 'has_duplicate_key_match', value: true },
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
    expect(params.get('has_duplicate_key_match')).toBe('is.true');
    expect(params.get('filed_at')).toBe('not.is.null');
    expect(params.get('invoice_number')).toBe('ilike.%104%');
  });

  it('expresses the without-order branch as an absent embedded resource', async () => {
    const seen = useTable('invoices', invoices(1));

    // `Invoices.tsx:93` reads `order_links.length === 0` off rows already in memory. On the server
    // that is a left-joined embed tested for null, which is a real predicate over the whole table.
    await fetchServerList<Row>(client, request({
      select: '*, order_links:invoice_order_links!left(order_id)',
      predicates: [{ kind: 'is', column: 'order_links', value: null }],
    }));

    expect(seen[0].url.searchParams.get('order_links')).toBe('is.null');
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

describe('ServerPredicate — a filter with no server expression does not compile', () => {
  /**
   * These assertions are enforced by `tsc --noEmit`, which `npm run build` runs over `src`. If any
   * of these lines ever started compiling, TypeScript would report the `@ts-expect-error` as unused
   * and the build would fail — so the claim cannot rot into a comment.
   */
  it('rejects filters that only JavaScript can evaluate', () => {
    // The duplicate-suspicion branch counts `(supplier_id, invoice_number)` occurrences across the
    // whole result set (`Invoices.tsx:77-84`). Two twins can land on different pages, so computed
    // per page it reports "no duplicates" exactly when there are some. It has no expression here
    // until 0053 supplies a server-side duplicate key.
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
    ] satisfies ServerPredicate[];

    expect(supported).toHaveLength(4);
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

  it('gives a missing count Hebrew too, rather than the internal code', async () => {
    server.use(http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json(invoices(2))));

    const failure = await fetchServerList<Row>(client, request()).catch((e: unknown) => e);

    expect((failure as ServerListError).hebrew).toMatch(/[֐-׿]/);
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
