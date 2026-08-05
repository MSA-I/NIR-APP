/**
 * Server-side list fetching: one PostgREST request, one page of rows, and the total the filters
 * actually match.
 *
 * `fetchAll` (`supabasePaging.ts`) loops PostgREST until the table is exhausted and hands the
 * whole thing to the browser, which then filters, sorts and pages it in memory. That is the right
 * shape when the intent really is "everything" — a full export, a whole-account check — and it is
 * what `Reports.tsx` and `checks.ts` mean. It is the wrong shape for a list screen, where the user
 * reads fifteen rows and the account holds fifty thousand. This module is the second route, not a
 * replacement.
 *
 * **No screen is converted here, and that is a decision rather than an omission.** `DataTable`
 * searches, sorts and pages *the rows handed to it* (`ui.tsx:595-611`). A screen wired to server
 * paging before the table engine knows to stop doing that would receive one page and then filter
 * it again in memory — "5 חשבוניות" while 40 match. A wrong number on a financial screen is worse
 * than the slowness it was meant to fix. `ui.tsx` belongs to wave 2, and so does the conversion.
 *
 * Five things this module exists to get right:
 *
 * 1. **`.range()` past the end is HTTP 416, not an empty page.** PostgREST answers 416 when the
 *    offset is past the total *and* above zero. Deleting a row while a user sits on page 5 is
 *    therefore a hard error, and raw it reaches a Hebrew-speaking user as "Requested range not
 *    satisfiable". Here it is a recovery: count again, serve the last page that still exists, and
 *    report it in `pageReset` so the caller can move its own page state.
 * 2. **`count: 'exact'` runs an RLS-filtered COUNT on every page.** That is the price of a true
 *    total, and it is paid deliberately rather than ignored — `cost` reports what each call spent.
 *    `count: 'estimated'` is never sent: it answers `*`, which arrives as no count at all, and a
 *    list that then shows 0 is making a false claim about the business.
 * 3. **The `id` tie-breaker is appended here, to every request.** Two rows equal on the sort column
 *    have no defined order between pages, so without it rows duplicate or disappear.
 *    `supabasePaging.ts:6` asks callers to remember; this module does not let them forget.
 * 4. **A filter with no server expression does not compile.** `ServerPredicate` is a closed union
 *    and `applyPredicate` is exhaustive, so a filter that only JavaScript can evaluate — the
 *    duplicate-suspicion branch in `Invoices.tsx:77-84` counts occurrences across the entire
 *    result set — cannot be passed in and quietly become true for one page.
 * 5. **Every failure carries Hebrew.** `ServerListError.hebrew` is `toHebrewError` applied once, at
 *    the throw. See the note on `ServerListError` for why `message` deliberately stays raw.
 */

import { toHebrewError } from './errors';
import { readExactCount } from './queryResult';

/* ------------------------------------------------------------------ predicates */

/**
 * A single comparison PostgREST can express on its own.
 *
 * Every member is here because a live screen needs it: `eq` for the review/payment/export status
 * selects, `neq` for "פתוחות לתשלום" (`payment_status <> 'paid'`), `gte`/`lt` for the month filter,
 * `is` for `deleted_at is null` and for a boolean flag column, `not-null` for "already filed",
 * `in` for a multi-select, `contains-text` for a search box, and `any-of` for a search that spans
 * two columns.
 */
export type LeafPredicate =
  | { kind: 'eq'; column: string; value: string | number | boolean }
  | { kind: 'neq'; column: string; value: string | number | boolean }
  | { kind: 'gt'; column: string; value: string | number }
  | { kind: 'gte'; column: string; value: string | number }
  | { kind: 'lt'; column: string; value: string | number }
  | { kind: 'lte'; column: string; value: string | number }
  | { kind: 'in'; column: string; values: readonly (string | number)[] }
  /** `is.null` / `is.true` / `is.false`. Also how an embedded `!left` resource is tested for absence. */
  | { kind: 'is'; column: string; value: null | boolean }
  | { kind: 'not-null'; column: string }
  /** Case-insensitive contains. See `containsPattern` for what the server does and does not escape. */
  | { kind: 'contains-text'; column: string; text: string };

/**
 * The closed set of filters this contract accepts.
 *
 * **This is the most important type in the module.** A list filter that cannot be written as one of
 * these has no server expression, and passing it is a compile error rather than a filter that runs
 * on one page and silently reports a wrong count.
 */
export type ServerPredicate =
  | LeafPredicate
  /** PostgREST `or=(a,b)`. Used for a search box that looks in more than one column. */
  | { kind: 'any-of'; of: readonly LeafPredicate[] };

/* ------------------------------------------------------------------ request and result */

export interface ServerSort {
  column: string;
  /** Defaults to ascending, matching PostgREST. */
  ascending?: boolean;
  nullsFirst?: boolean;
}

export interface ServerListRequest {
  table: string;
  /**
   * The PostgREST `select` string, embedded resources included.
   *
   * The count probe on the 416 path reuses it verbatim: a predicate that filters on an embedded
   * resource (`order_links` on `invoice_order_links!left`) is only valid while that resource is
   * part of the select, so a cheaper `select=id` probe would fail on exactly the screens that
   * need the recovery.
   */
  select: string;
  predicates?: readonly ServerPredicate[];
  /** Applied in order. The `id` tie-breaker is appended after these; callers do not add it. */
  sort?: readonly ServerSort[];
  /** Zero-based. */
  page: number;
  pageSize: number;
  /** The deterministic tie-breaker column. `id` everywhere in this schema. */
  idColumn?: string;
}

/** Set when the requested page no longer existed. Carries text a Hebrew-speaking user can act on. */
export interface ServerListPageReset {
  requestedPage: number;
  servedPage: number;
  message: string;
}

/**
 * What the call cost.
 *
 * An exact count is a filtered COUNT per page. Reporting it is the difference between accepting a
 * known cost and not knowing there is one.
 */
export interface ServerListCost {
  /** HTTP requests issued, including the count probe and any 416 recovery. 1 on the normal path. */
  requests: number;
  /** Wall-clock milliseconds for the whole call. */
  ms: number;
}

export interface ServerListResult<Row> {
  rows: Row[];
  /** The RLS-filtered total. Never a fallback zero — an unavailable count throws instead. */
  total: number;
  /** The page actually served; differs from the requested page after a 416 recovery. */
  page: number;
  pageReset: ServerListPageReset | null;
  cost: ServerListCost;
}

/** Shown when a page disappeared underneath the user. Exported so wave 2 renders one wording. */
export const PAGE_NO_LONGER_EXISTS =
  'העמוד שביקשת כבר אינו קיים — ייתכן ששורות נמחקו בינתיים. מוצג העמוד האחרון הקיים.';

/* ------------------------------------------------------------------ errors */

export type ServerListErrorCode =
  /** A page past the end that could not be recovered onto a valid page. */
  | 'page_out_of_range'
  /** The response carried no usable total. Never rendered as 0 — see `queryResult.ts`. */
  | 'count_unavailable'
  /** PostgREST refused the query: RLS, a bad column, a broken filter. */
  | 'request_failed'
  /** The caller handed this module something it cannot turn into a query. */
  | 'invalid_request';

/**
 * A list failure with both halves of the truth.
 *
 * `hebrew` is what a user reads. `message` deliberately stays the raw server string, because the
 * error keeps travelling: `useQuery` runs whatever it catches through `toHebrewError` again
 * (`useQuery.ts:94,126`), and a message that is already Hebrew matches none of the ~70 patterns in
 * `errors.ts` and collapses to the generic fallback. Keeping the raw text in `message` means the
 * upstream mapping still produces the specific sentence, and `hebrew` is here for any caller that
 * renders this error directly.
 */
export class ServerListError extends Error {
  readonly code: ServerListErrorCode;
  readonly hebrew: string;
  readonly status: number | null;

  constructor(code: ServerListErrorCode, raw: string, status: number | null = null) {
    super(raw);
    this.name = 'ServerListError';
    this.code = code;
    this.status = status;
    this.hebrew = toHebrewError(raw);
  }
}

/* ------------------------------------------------------------------ the PostgREST surface used */

/** The shape a PostgREST read resolves to. Only the fields this module reads. */
export interface PostgrestPage<Row> {
  data: Row[] | null;
  error: { message: string; code?: string | null; details?: string | null } | null;
  count: number | null;
  status: number;
}

/**
 * The slice of the PostgREST builder this module drives.
 *
 * Declared structurally rather than imported: `PostgrestFilterBuilder` takes seven generic
 * parameters that are re-shaped between minor releases, and this module calls eleven of its
 * methods. Narrowing the surface also means a caller can hand in a fake without reproducing
 * supabase-js.
 */
export interface ListQuery<Row> extends PromiseLike<PostgrestPage<Row>> {
  eq(column: string, value: unknown): ListQuery<Row>;
  neq(column: string, value: unknown): ListQuery<Row>;
  gt(column: string, value: unknown): ListQuery<Row>;
  gte(column: string, value: unknown): ListQuery<Row>;
  lt(column: string, value: unknown): ListQuery<Row>;
  lte(column: string, value: unknown): ListQuery<Row>;
  in(column: string, values: readonly unknown[]): ListQuery<Row>;
  is(column: string, value: boolean | null): ListQuery<Row>;
  not(column: string, operator: string, value: unknown): ListQuery<Row>;
  ilike(column: string, pattern: string): ListQuery<Row>;
  or(filters: string): ListQuery<Row>;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): ListQuery<Row>;
  range(from: number, to: number): ListQuery<Row>;
}

export interface ServerListSelectOptions {
  /** Only ever `'exact'`. See the module note on why `'estimated'` is not an option here. */
  count?: 'exact';
  head?: boolean;
}

/** The one thing this module needs from a Supabase client. `supabase` satisfies it as it is. */
export interface ServerListClient {
  from(table: string): { select(columns: string, options?: ServerListSelectOptions): unknown };
}

/* ------------------------------------------------------------------ query building */

/**
 * `%` rather than PostgREST's `*` alias: `*` only becomes a wildcard because PostgREST rewrites it,
 * and inside an `or=(...)` group the value is also unquoted first. `%` is the wildcard SQL itself
 * uses, so it needs no rewrite and behaves the same quoted or not.
 *
 * `%` and `_` typed by the user stay wildcards — PostgREST exposes no ESCAPE clause. That is a
 * search being broader than asked, not a count being wrong, and it is left visible here rather than
 * hidden behind a rewrite that would also break a genuine search for an invoice number with `_`.
 */
const containsPattern = (text: string) => `%${text}%`;

/**
 * PostgREST splits an `or=(...)` group on commas, so a value carrying one — a supplier name with a
 * comma, a search term — has to be quoted or it silently becomes two filters. Quoting only when a
 * reserved character is present keeps ordinary values readable in the request log.
 */
const quoteOrValue = (value: string | number | boolean) => {
  const text = String(value);
  return /[,()"\\]/.test(text) ? `"${text.replace(/(["\\])/g, '\\$1')}"` : text;
};

/** One `or=(...)` term. Kept beside `applyPredicate` so the two cannot drift apart. */
function leafToOrTerm(leaf: LeafPredicate): string {
  switch (leaf.kind) {
    case 'eq': return `${leaf.column}.eq.${quoteOrValue(leaf.value)}`;
    case 'neq': return `${leaf.column}.neq.${quoteOrValue(leaf.value)}`;
    case 'gt': return `${leaf.column}.gt.${quoteOrValue(leaf.value)}`;
    case 'gte': return `${leaf.column}.gte.${quoteOrValue(leaf.value)}`;
    case 'lt': return `${leaf.column}.lt.${quoteOrValue(leaf.value)}`;
    case 'lte': return `${leaf.column}.lte.${quoteOrValue(leaf.value)}`;
    case 'in': return `${leaf.column}.in.(${leaf.values.map(quoteOrValue).join(',')})`;
    // `is` takes a bare null/true/false keyword; quoting it would compare against the string.
    case 'is': return `${leaf.column}.is.${leaf.value === null ? 'null' : String(leaf.value)}`;
    case 'not-null': return `${leaf.column}.not.is.null`;
    case 'contains-text': return `${leaf.column}.ilike.${quoteOrValue(containsPattern(leaf.text))}`;
    default: {
      // A new leaf without an `or` form fails to compile here rather than at a customer.
      const unreachable: never = leaf;
      throw new ServerListError('invalid_request', `unsupported_predicate:${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Applies one predicate to a query.
 *
 * The `never` in the default branch is the enforcement promised above: adding a member to
 * `ServerPredicate` without giving it a server expression stops the build, and a filter that is not
 * a member cannot reach this function at all.
 */
export function applyPredicate<Row>(query: ListQuery<Row>, predicate: ServerPredicate): ListQuery<Row> {
  switch (predicate.kind) {
    case 'eq': return query.eq(predicate.column, predicate.value);
    case 'neq': return query.neq(predicate.column, predicate.value);
    case 'gt': return query.gt(predicate.column, predicate.value);
    case 'gte': return query.gte(predicate.column, predicate.value);
    case 'lt': return query.lt(predicate.column, predicate.value);
    case 'lte': return query.lte(predicate.column, predicate.value);
    case 'in': return query.in(predicate.column, predicate.values);
    case 'is': return query.is(predicate.column, predicate.value);
    case 'not-null': return query.not(predicate.column, 'is', null);
    case 'contains-text': return query.ilike(predicate.column, containsPattern(predicate.text));
    case 'any-of': {
      if (predicate.of.length === 0) {
        // An empty `or=()` is a PostgREST parse error, and treating it as "match everything" would
        // widen a filtered list without saying so.
        throw new ServerListError('invalid_request', 'empty_any_of_predicate');
      }
      return query.or(predicate.of.map(leafToOrTerm).join(','));
    }
    default: {
      const unreachable: never = predicate;
      throw new ServerListError('invalid_request', `unsupported_predicate:${JSON.stringify(unreachable)}`);
    }
  }
}

/** The last page that can exist for a total. Page 0 when nothing matches. */
export function lastPageOf(total: number, pageSize: number): number {
  return total <= 0 ? 0 : Math.ceil(total / pageSize) - 1;
}

function buildQuery<Row>(
  client: ServerListClient,
  request: ServerListRequest,
  options: { head: boolean; page: number | null },
): ListQuery<Row> {
  const idColumn = request.idColumn ?? 'id';
  // The single cast in this module: supabase-js types `select` through generics this contract does
  // not carry, and `ListQuery` states exactly what is used afterwards.
  let query = client
    .from(request.table)
    .select(request.select, { count: 'exact', head: options.head }) as ListQuery<Row>;

  for (const predicate of request.predicates ?? []) query = applyPredicate(query, predicate);

  const sorts = request.sort ?? [];
  for (const sort of sorts) {
    query = query.order(sort.column, { ascending: sort.ascending ?? true, nullsFirst: sort.nullsFirst });
  }
  // The order clause always ends on the id column. Rows equal on the sort column would otherwise
  // come back in whatever order the plan produced, and a row can then appear on two pages or on
  // none. Skipped only when the caller already sorted by it last, which is the same clause.
  if (sorts[sorts.length - 1]?.column !== idColumn) query = query.order(idColumn, { ascending: true });

  if (options.page !== null) {
    const from = options.page * request.pageSize;
    query = query.range(from, from + request.pageSize - 1);
  }
  return query;
}

/* ------------------------------------------------------------------ reading the response */

/**
 * PostgREST's own rule: 416 when the offset is past the total *and* above zero. Page 0 is therefore
 * always satisfiable, which is what makes the recovery below terminate.
 */
function isRangeNotSatisfiable(response: PostgrestPage<unknown>): boolean {
  return response.status === 416 || response.error?.code === 'PGRST103';
}

/**
 * The total, or nothing at all.
 *
 * `readExactCount` (`queryResult.ts`) is the project's rule that a missing count throws instead of
 * becoming 0, and it is reused rather than restated. The response is already resolved, so it is
 * wrapped rather than awaited a second time: a PostgREST builder issues a fresh HTTP request every
 * time it is awaited.
 *
 * The `NaN` guard is not defensive noise. postgrest-js reads the count with
 * `parseInt(contentRange[1])` (`PostgrestBuilder.ts:515`), and PostgREST answers `Content-Range:
 * 0-24/*` whenever it has no total — which is exactly what `count: 'estimated'` returns when the
 * planner has no estimate. That arrives as `NaN`, and `NaN` is not `null`, so it would walk past
 * the guard in `readExactCount` and be rendered as a total.
 */
async function readTotal(response: PostgrestPage<unknown>): Promise<number> {
  // A refused query has no count either, and reporting it as a missing count would hide an RLS
  // rejection behind a vaguer failure.
  if (response.error) {
    throw new ServerListError('request_failed', response.error.message, response.status);
  }
  const count = response.count != null && Number.isFinite(response.count) ? response.count : null;
  try {
    return await readExactCount(Promise.resolve({ count, error: null }));
  } catch (e) {
    throw new ServerListError('count_unavailable', e instanceof Error ? e.message : String(e), response.status);
  }
}

/* ------------------------------------------------------------------ the entry point */

/**
 * Fetches one page and the filtered total.
 *
 * On 416 the requested page no longer exists. The recovery counts again, moves to the last page
 * that does exist, and reports it in `pageReset`; the target page strictly decreases on each
 * attempt and page 0 cannot return 416, so the loop terminates.
 */
export async function fetchServerList<Row>(
  client: ServerListClient,
  request: ServerListRequest,
): Promise<ServerListResult<Row>> {
  if (!Number.isInteger(request.pageSize) || request.pageSize <= 0) {
    throw new ServerListError('invalid_request', `invalid_page_size:${request.pageSize}`);
  }
  if (!Number.isInteger(request.page) || request.page < 0) {
    throw new ServerListError('invalid_request', `invalid_page:${request.page}`);
  }

  const startedAt = performance.now();
  const requestedPage = request.page;
  let page = requestedPage;
  let requests = 0;

  for (;;) {
    requests += 1;
    const response = await buildQuery<Row>(client, request, { head: false, page });

    if (!isRangeNotSatisfiable(response)) {
      // `readTotal` raises the server's own refusal before anything is read off the response.
      const total = await readTotal(response);
      return {
        rows: response.data ?? [],
        total,
        page,
        pageReset: page === requestedPage
          ? null
          : { requestedPage, servedPage: page, message: PAGE_NO_LONGER_EXISTS },
        cost: { requests, ms: performance.now() - startedAt },
      };
    }

    if (page === 0) {
      // PostgREST cannot answer 416 for offset 0, so this is the server disagreeing with its own
      // documented rule. Failing is honest; retrying would spin.
      throw new ServerListError('page_out_of_range', response.error?.message ?? 'range_not_satisfiable', 416);
    }

    requests += 1;
    const total = await readTotal(await buildQuery(client, request, { head: true, page: null }));
    const last = lastPageOf(total, request.pageSize);
    page = last < page ? last : 0;
  }
}
