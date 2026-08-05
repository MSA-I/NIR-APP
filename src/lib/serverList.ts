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
 *    and `applyPredicate` is exhaustive, so a filter that only JavaScript can evaluate cannot be
 *    passed in and quietly become true for one page. The invoice duplicate filter is the case that
 *    made this rule: `Invoices.tsx:77-84` counts `(supplier_id, invoice_number)` occurrences across
 *    the entire result set, and two twins can land on different pages, so computed per page it
 *    reports "no duplicates" exactly when there are some. Migration `0053` answers it properly with
 *    the computed fields `invoice_has_duplicate` and `invoice_without_order`, which are ordinary
 *    boolean predicates here; what stays uninvitable is the client-side computation.
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
  /** An empty `values` throws `invalid_request`: PostgREST parses `in.()` as a syntax error at
      runtime, and "in nothing" is a filter that matches nothing while looking like a mistake. */
  | { kind: 'in'; column: string; values: readonly (string | number)[] }
  /** `is.null` / `is.true` / `is.false`. Also how an embedded `!left` resource is tested for absence. */
  | { kind: 'is'; column: string; value: null | boolean }
  | { kind: 'not-null'; column: string }
  /**
   * Case-insensitive contains. User-typed `%`/`_` are escaped before `ilike` — see
   * `containsPattern`. An empty `text` throws `invalid_request`: `ilike '%%'` excludes NULLs, so
   * "empty search" would quietly drop rows that a client-side `.includes('')` keeps. The caller
   * decides what an empty search box means (usually: no predicate at all).
   */
  | { kind: 'contains-text'; column: string; text: string };

/**
 * PostgREST `and(...)`. Its value is inside `any-of`: `or=(a,and(b,c))` is the only way to say
 * "this OR (that AND that)" in one request. Alone it is emitted as `or=(and(...))`, which PostgREST
 * reads as the same conjunction — one emission path, so the two spellings cannot drift.
 */
export type AllOfPredicate = { kind: 'all-of'; of: readonly LeafPredicate[] };

/**
 * The closed set of filters this contract accepts.
 *
 * **This is the most important type in the module.** A list filter that cannot be written as one of
 * these has no server expression, and passing it is a compile error rather than a filter that runs
 * on one page and silently reports a wrong count.
 */
export type ServerPredicate =
  | LeafPredicate
  | AllOfPredicate
  /** PostgREST `or=(a,b)`. Used for a search box that looks in more than one column. */
  | { kind: 'any-of'; of: readonly (LeafPredicate | AllOfPredicate)[] };

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
  /**
   * Cancels the HTTP request itself, via supabase-js `.abortSignal()`. A debounced search box only
   * delays the next request; the superseded one is still on the wire, still paying its COUNT, and
   * still able to land after the newer answer. Aborting is the half debounce cannot do.
   */
  signal?: AbortSignal;
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
  abortSignal(signal: AbortSignal): ListQuery<Row>;
  limit(count: number): ListQuery<Row>;
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
 * User-typed `%`, `_` and `\` are escaped, because `LIKE`'s default escape character is `\` and
 * PostgREST passes the pattern to `ILIKE` untouched. Without this, a search for `50%` matches every
 * row starting with "50", and an invoice number with `_` matches numbers it should not — a list
 * that is silently broader than the search the user typed. An empty `text` is rejected upstream
 * (see `validateLeaf`); this function only ever wraps a non-empty term.
 */
const escapeLikeWildcards = (text: string) => text.replace(/[\\%_]/g, '\\$&');
const containsPattern = (text: string) => `%${escapeLikeWildcards(text)}%`;

/**
 * The runtime guards a leaf needs before it can travel. Both emission paths (`applyPredicate` and
 * `leafToOrTerm`) call this, so a leaf inside an or-group is held to exactly the same rules as one
 * applied directly.
 */
function validateLeaf(leaf: LeafPredicate): LeafPredicate {
  if (leaf.kind === 'in' && leaf.values.length === 0) {
    // Compiles fine, then PostgREST rejects `in.()` at runtime — so it must be caught here.
    throw new ServerListError('invalid_request', `empty_in_predicate:${leaf.column}`);
  }
  if (leaf.kind === 'contains-text' && leaf.text === '') {
    // `ilike '%%'` matches every non-NULL value — different semantics from the client-side
    // `.includes('')` it replaces, which keeps NULL-backed rows. Refusing is the honest option.
    throw new ServerListError('invalid_request', `empty_contains_text_predicate:${leaf.column}`);
  }
  return leaf;
}

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
function leafToOrTerm(rawLeaf: LeafPredicate): string {
  const leaf = validateLeaf(rawLeaf);
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
 * `and(a,b)` — one conjunction term. An empty conjunction throws for the same reason an empty
 * or-group does: `and()` is a PostgREST parse error, and "all of nothing" is vacuously true, which
 * would widen a filtered list without saying so.
 */
function allOfToOrTerm(predicate: AllOfPredicate): string {
  if (predicate.of.length === 0) {
    throw new ServerListError('invalid_request', 'empty_all_of_predicate');
  }
  return `and(${predicate.of.map(leafToOrTerm).join(',')})`;
}

/** A member of an `any-of` group: a plain leaf or a nested conjunction. */
const orMemberToTerm = (member: LeafPredicate | AllOfPredicate): string =>
  member.kind === 'all-of' ? allOfToOrTerm(member) : leafToOrTerm(member);

/**
 * Applies one predicate to a query.
 *
 * The `never` in the default branch is the enforcement promised above: adding a member to
 * `ServerPredicate` without giving it a server expression stops the build, and a filter that is not
 * a member cannot reach this function at all.
 */
export function applyPredicate<Row>(query: ListQuery<Row>, predicate: ServerPredicate): ListQuery<Row> {
  if (predicate.kind !== 'any-of' && predicate.kind !== 'all-of') validateLeaf(predicate);
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
    case 'all-of':
      // One emission path with the nested case: `or=(and(...))` is the same conjunction PostgREST
      // would read from `and=(...)`, and reusing `allOfToOrTerm` means the two spellings cannot
      // diverge on quoting or validation.
      return query.or(allOfToOrTerm(predicate));
    case 'any-of': {
      if (predicate.of.length === 0) {
        // An empty `or=()` is a PostgREST parse error, and treating it as "match everything" would
        // widen a filtered list without saying so.
        throw new ServerListError('invalid_request', 'empty_any_of_predicate');
      }
      return query.or(predicate.of.map(orMemberToTerm).join(','));
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

  if (request.signal) query = query.abortSignal(request.signal);

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

/* ------------------------------------------------------------------ URL-facing helpers */

/**
 * The month filter as a half-open range on the screen's date column: `'2026-08'` becomes
 * `[2026-08-01, 2026-09-01)`. The client-side filter this replaces was a string prefix match on the
 * date, which no index can serve; a range on the ordering column rides the same index the sort uses.
 *
 * A value that is not `YYYY-MM` yields no predicates at all. The value arrives from a URL
 * parameter, and a crafted `?month=` must degrade to "no month filter" — visible as an empty month
 * input — rather than travel into a Postgres date cast error.
 */
export function monthRangePredicates(column: string, month: string): ServerPredicate[] {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return [];
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) return [];
  const next = monthNumber === 12 ? `${year + 1}-01` : `${match[1]}-${String(monthNumber + 1).padStart(2, '0')}`;
  return [
    { kind: 'gte', column, value: `${month}-01` },
    { kind: 'lt', column, value: `${next}-01` },
  ];
}

/** Zero-based page as a URL value: page 0 is the absent parameter, page 3 reads as `page=4`. */
export function pageToParam(page: number): string {
  return page > 0 ? String(page + 1) : '';
}

/** The URL value back into a zero-based page. Anything unparseable or crafted is page 0. */
export function pageFromParam(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 1 ? parsed - 1 : 0;
}

/** `ServerSort` as a URL parameter value: `'date.desc'`. Empty string when there is no user sort. */
export function formatSortParam(sort: readonly ServerSort[] | null): string {
  const first = sort?.[0];
  return first ? `${first.column}.${first.ascending === false ? 'desc' : 'asc'}` : '';
}

/**
 * The URL value back into a sort, refusing columns the screen did not declare sortable. A crafted
 * `?sort=` must not reach `.order()`: an unknown column is a PostgREST error in Hebrew clothing,
 * and a known-but-unindexed one is the full sort this wave exists to avoid.
 */
export function parseSortParam(value: string, sortable: ReadonlySet<string>): ServerSort[] | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\.(asc|desc)$/.exec(value);
  if (!match || !sortable.has(match[1])) return null;
  return [{ column: match[1], ascending: match[2] === 'asc' }];
}

/* ------------------------------------------------------------------ cross-table search */

/**
 * The most supplier ids a search is allowed to inline into one `in.(...)`.
 *
 * The bound is URL length: every id is a 36-character UUID and PostgREST reads the whole filter
 * from the query string. 150 is the same ceiling `fetchInChunks` already enforces for `.in()`
 * (`supabasePaging.ts:43`) — one constant of the codebase, not two.
 */
export const SUPPLIER_SEARCH_ID_CAP = 150;

/**
 * Shown in the toolbar when the supplier arm of a search was dropped. Exported so the three
 * converted screens render one wording — the count on screen is only honest while the narrowing
 * is visible.
 */
export const SUPPLIER_SEARCH_NARROWED =
  'שמות ספקים רבים מדי תואמים לחיפוש, ולכן הוא בוצע על עמודות המסך בלבד. דייקו את שם הספק כדי לחפש גם לפי ספק.';

export interface SupplierIdSearch {
  /** Empty either because no supplier matched or because the search was narrowed — check `narrowed`. */
  ids: string[];
  /**
   * More than `SUPPLIER_SEARCH_ID_CAP` suppliers matched, so the supplier arm is dropped rather
   * than truncated. A truncated arm would return a list — and a total — that excludes suppliers
   * the user's search matches, with nothing on screen admitting it. Dropping the arm narrows the
   * search to the screen's own columns, and the screen states that (`SUPPLIER_SEARCH_NARROWED`),
   * so the displayed count is exactly the count of the filter that ran.
   */
  narrowed: boolean;
}

/**
 * Step one of the cross-table search: which suppliers match the term.
 *
 * `DataTable`'s client-side `searchFn` reads `row.supplier.name` off the embedded resource, which
 * PostgREST cannot filter *the parent* by without turning the embed into an inner join and changing
 * which rows exist. So the search runs in two steps: a trgm-backed lookup on `suppliers.name`
 * (`suppliers_name_trgm`, `0011:10`), then `in supplier_id <ids>` as one arm of the screen's
 * `any-of`. Soft-deleted suppliers are deliberately included — the embedded name the client-side
 * search read today does not filter `deleted_at` either, and an invoice of a deleted supplier is
 * still findable by that supplier's name.
 */
export async function searchSupplierIds(
  client: ServerListClient,
  q: string,
  signal?: AbortSignal,
): Promise<SupplierIdSearch> {
  if (q === '') {
    // Same rule as `contains-text`: an empty term is the caller forgetting to not search.
    throw new ServerListError('invalid_request', 'empty_supplier_search');
  }
  let query = client.from('suppliers').select('id') as ListQuery<{ id: string }>;
  if (signal) query = query.abortSignal(signal);
  // One row past the cap: "151 rows" distinguishes "too many" from "exactly 150" without counting.
  const response = await query.ilike('name', containsPattern(q)).limit(SUPPLIER_SEARCH_ID_CAP + 1);
  if (response.error) {
    throw new ServerListError('request_failed', response.error.message, response.status);
  }
  const rows = response.data ?? [];
  if (rows.length > SUPPLIER_SEARCH_ID_CAP) return { ids: [], narrowed: true };
  return { ids: rows.map((row) => row.id), narrowed: false };
}

/**
 * Step two: the screen's search predicate — its own columns, plus the supplier arm when step one
 * found any. With no matching suppliers the predicate is the screen columns alone: an `in` over
 * zero ids is invalid (see `LeafPredicate`), and "no supplier matched" must not erase the rest of
 * the search.
 */
export function twoStepSearchPredicate(
  screenColumns: readonly string[],
  q: string,
  supplierIds: readonly string[],
): ServerPredicate {
  return {
    kind: 'any-of',
    of: [
      ...screenColumns.map((column) => ({ kind: 'contains-text', column, text: q } as const)),
      ...(supplierIds.length > 0
        ? [{ kind: 'in', column: 'supplier_id', values: supplierIds } as const]
        : []),
    ],
  };
}
