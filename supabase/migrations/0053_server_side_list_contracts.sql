-- Server-side list contracts: the predicates and the indexes a paged list screen needs to stay
-- honest. No screen is converted here -- wave 2 owns `ui.tsx` and the conversion. This migration
-- lands the server side first, because converting a screen before the server can answer its
-- filters is what produces a wrong number.
--
-- The filter that cannot survive paging alone. `Invoices.tsx:77-84` builds `duplicateKeys` by
-- counting occurrences of (supplier_id, lower(trim(invoice_number))) across the WHOLE result
-- array and then keeps the rows whose key appears more than once (`:92`). Two twins can land on
-- different pages. Server-side paging without a server-side predicate would therefore make that
-- filter lie quietly: it would report "no duplicates" exactly when there are some. A wrong number
-- on a financial screen is the worst failure class in this project, so "does this row have a twin"
-- becomes a server question here, before any screen moves.
--
-- The normalised key is deliberately unchanged: org_id + supplier_id + lower(trim(invoice_number)),
-- over live rows only. That is already the definition in three places -- the browser
-- (`Invoices.tsx:23-24`, over a list filtered by `deleted_at is null` at :65),
-- `p2_duplicate_invoice_group_count()` (`0024:399`) and the Push trigger
-- `private.notify_duplicate_invoice_check()` (`0017:150-168`), which even uses the same ':'
-- separator. Widening it to date or amount would be a business decision, not a refactor, and it is
-- not made here.
--
-- Known, pre-existing divergence, carried on purpose rather than silently changed: SQL `trim()` is
-- `btrim()` and strips spaces only, while JavaScript `.trim()` also strips tabs, newlines and
-- NBSP. An invoice number padded with a tab would group differently in the two languages. Both
-- existing server definitions above already behave this way, so matching them keeps one definition
-- rather than creating a fourth; narrowing or widening it is an open business question.
--
-- Both predicates are PostgREST computed fields: a `stable` function whose single argument is the
-- table's composite type is selectable and filterable from the API
-- (`/invoices?invoice_has_duplicate=is.true`). They are `security invoker`, so the inner scan sees
-- exactly the rows the caller's own RLS policies allow -- the same set the browser fetches today,
-- so the two agree per role rather than only for an owner.
--
-- One role where that inheritance produces a WRONG answer, recorded rather than glossed: a payer
-- has no branch in `iol_select` (`0031:69`) and therefore sees zero link rows, so
-- `invoice_without_order` returns true for a payer even on an invoice that has an order. Measured:
-- the same invoice answers false for an owner and true for a payer. This is not a leak -- a payer
-- learns nothing it could not already read -- it is a wrong number, which is the failure class this
-- wave exists to prevent. It is also NOT "what the browser already does": READERS is
-- `['owner','office','kitchen','accountant']` (`App.tsx:103`), so `/invoices` is guarded against a
-- payer and the old client-side computation never ran for one. The predicate is reachable through
-- the API because the grant is to `authenticated`. The constraint that follows belongs to wave 2:
-- do not expose the without-order filter on a screen a role that cannot read `invoice_order_links`
-- can reach. Making the predicate `security definer` is not the fix -- it would disclose the
-- existence of links on invoices the caller may not read.
--
-- Both predicates are false for a soft-deleted row. The list query always carries
-- `deleted_at=is.null`, but a caller that forgets it must not be handed a deleted invoice by an
-- attention filter, and a deleted twin must not keep a live invoice flagged.
--
-- On the org_id term, stated accurately rather than reassuringly: it is NOT what isolates tenants.
-- A supplier belongs to exactly one organization and `p0_invoices_supplier_tenant_fk` (`0021`)
-- makes an invoice's tenant agree with its supplier's, so `supplier_id` equality already implies
-- same-tenant. org_id is here because it is the leading column of the duplicate index -- without
-- it the probe cannot use that index at all -- and as a second lock that survives the constraint
-- being relaxed. The test asserts the constraint separately, because that is the load-bearing one.
--
-- The cost, stated plainly: `set search_path` blocks SQL inlining, so the planner cannot fold the
-- predicate into a semi-join and calls it once per candidate row. Each call is one probe of
-- `invoices_org_live_duplicate_key_idx` -- which is the difference between a lookup and the full
-- scan this wave exists to avoid. Dropping the search_path pin would trade a repo-wide security
-- convention for a planner optimisation; this migration does not make that trade.

create or replace function public.invoice_has_duplicate(public.invoices)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select $1.deleted_at is null
    and exists (
      select 1
      from public.invoices twin
      where twin.org_id = $1.org_id
        and twin.supplier_id = $1.supplier_id
        and twin.id <> $1.id
        and twin.deleted_at is null
        and lower(trim(twin.invoice_number)) = lower(trim($1.invoice_number))
    )
$$;

create or replace function public.invoice_without_order(public.invoices)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select $1.deleted_at is null
    and not exists (
      select 1
      from public.invoice_order_links link
      where link.org_id = $1.org_id
        and link.invoice_id = $1.id
    )
$$;

-- `revoke ... from public` alone is not enough here. Supabase's default privileges grant ALL on
-- every new public-schema function to anon, authenticated and service_role by name, and revoking
-- from the PUBLIC pseudo-role leaves those explicit grants standing -- the same reason `0017:36`
-- and `0044:101` revoke from anon by name on tables. These are tenant read helpers for a signed-in
-- browser. anon could never reach a row through RLS anyway, which is exactly why holding EXECUTE
-- buys it nothing.
revoke all on function public.invoice_has_duplicate(public.invoices) from public, anon;
revoke all on function public.invoice_without_order(public.invoices) from public, anon;
grant execute on function public.invoice_has_duplicate(public.invoices) to authenticated;
grant execute on function public.invoice_without_order(public.invoices) to authenticated;

-- ===== Indexes =====
--
-- Every index below starts at org_id. `auth_org()` is the InitPlan every policy opens with, so a
-- tenant-rooted prefix is what lets the planner start from the RLS predicate instead of filtering
-- after the fact. Every ordering index ends at id: `supabasePaging.ts:6` already requires callers
-- to add an `id` tie-breaker, and without a matching index `.order(col).order('id')` is a full sort
-- on every page of a deep pagination -- the cost paid per page, not once.
--
-- Sort direction is not cosmetic here. The list screens order newest-first and break ties by
-- ascending id, so the index has to be (org_id, <date> desc, id) to be read without a sort step.

-- The duplicate probe. Partial on live rows because the key is defined over live rows: a deleted
-- invoice is not a twin. (org_id, supplier_id) is also the prefix that serves the supplier-scoped
-- invoice joins in p0_supplier_balance_rows().
create index invoices_org_live_duplicate_key_idx
  on public.invoices (org_id, supplier_id, lower(trim(invoice_number)))
  where deleted_at is null;

-- The invoices screen: default ordering, plus the three status filters it actually offers
-- (`Invoices.tsx:54-56`). The month filter is a range on invoice_date, which each of these serves
-- as its trailing range column.
create index invoices_org_live_date_idx
  on public.invoices (org_id, invoice_date desc, id)
  where deleted_at is null;
create index invoices_org_live_review_date_idx
  on public.invoices (org_id, review_status, invoice_date desc, id)
  where deleted_at is null;
create index invoices_org_live_payment_date_idx
  on public.invoices (org_id, payment_status, invoice_date desc, id)
  where deleted_at is null;
create index invoices_org_live_export_date_idx
  on public.invoices (org_id, export_status, invoice_date desc, id)
  where deleted_at is null;

-- The without-order anti-join. `iol_invoice_idx` (0005:73) is on invoice_id alone and
-- `invoice_order_links_org_idx` (0021:172) on org_id alone; neither answers the tenant-scoped
-- existence question in one probe.
create index invoice_order_links_org_invoice_idx
  on public.invoice_order_links (org_id, invoice_id);

-- The remaining volume screens, each on the ordering it actually issues today.
-- Documents gallery (`DocumentsInbox.tsx:296`): created_at desc, id. The 0019 indexes are on
-- document_date and serve the kind/supplier filters, not this ordering.
create index documents_org_live_created_idx
  on public.documents (org_id, created_at desc, id)
  where deleted_at is null;

-- Payments (`Payments.tsx:22`).
create index payments_org_paid_date_idx
  on public.payments (org_id, paid_date desc, id);

-- Bank statement (`Bank.tsx:54`), unfiltered and by status -- the screen's only two shapes,
-- with the month filter as the trailing range.
create index bank_transactions_org_date_idx
  on public.bank_transactions (org_id, tx_date desc, id);
create index bank_transactions_org_status_date_idx
  on public.bank_transactions (org_id, status, tx_date desc, id);

-- Orders (`Orders.tsx:44`). The screen's default "open" filter is an IN over statuses, which the
-- status index serves as separate ranges.
create index purchase_orders_org_created_idx
  on public.purchase_orders (org_id, created_at desc, id);
create index purchase_orders_org_status_created_idx
  on public.purchase_orders (org_id, status, created_at desc, id);

-- Balance support only. p0_invoice_balance_rows() and p0_supplier_balance_rows() are
-- `security definer` and therefore bypass RLS; their bodies are NOT touched here -- the scope
-- condition goes inside them in 0057, in wave 3. These two indexes serve the aggregates those
-- functions already run (`0031:233,277`) and change no behaviour.
create index payment_allocations_org_invoice_idx
  on public.payment_allocations (org_id, invoice_id)
  where invoice_id is not null;
create index credit_requests_org_invoice_settled_idx
  on public.credit_requests (org_id, invoice_id)
  where invoice_id is not null and status in ('offset', 'closed');
