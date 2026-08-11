-- 0113 -- Four money questions, one answer each.
--
-- Today the same four numbers are computed in at least three places with quietly different
-- meanings, and the divergences were measured rather than suspected:
--
--   * TIME ZONE. `Dashboard.tsx` bucketed by `localDateKey` (Asia/Jerusalem) while
--     `KitchenDashboard.tsx` used a raw `created_at.slice(0, 7)` (UTC). An order placed at 01:00
--     local on 1 August is 22:00Z on 31 July: the same order, the same label "נרכש החודש", two
--     different months on two screens. Fixed on the client in the same wave; this migration makes
--     the server-side answer exist so there is somewhere to converge ON.
--   * CONCEPT. `0100`'s `committed` is the value of OPEN orders with no time window at all, and
--     it sits on the same screen as "נרכש החודש", which is non-draft orders within a month.
--   * WINDOW. Expenses says "החודש" meaning start-of-month → TODAY; Reports says the same word
--     meaning the full calendar month. Same formula, different totals, no way to tell from the
--     screen which one you are reading.
--   * DATE COLUMN vs LABEL. The dashboard header says "שהתקבלו" and filters `invoice_date`, while
--     `summary.ts` uses `received_date`.
--
-- So this is one function whose four numbers are DEFINED, not derived by whoever wrote the screen.
-- It does not replace the role-specific queries -- a kitchen manager's outstanding-order list is
-- not a money metric -- it replaces the ones that claim to answer the same question.
--
-- NULL, NOT ZERO. Every figure is null when its source set is empty. `CLAUDE.md` states the rule
-- and the reason: a metric with no data shows a dash, because zero is itself a claim about the
-- business. A measured zero -- rows exist and they sum to zero -- stays a zero.
--
-- ⚠ ONE OPEN BUSINESS QUESTION, ANSWERED BY A DOCUMENTED DEFAULT RATHER THAN A SILENT GUESS
-- (OPEN-DECISIONS #147). "Recognised credits" could mean any of three things, because
-- `credit_status` has five values in two disjoint groups: `open|requested|received` are what the
-- credits screen calls open, and `offset|closed` are what actually reduce a supplier balance
-- (0022:411-417). `Reports` currently counts ALL FIVE under one label.
--
-- The default here is the conservative one: **only `offset` and `closed` reduce net expense** --
-- money that has actually come off the balance. A credit that has been agreed but not yet applied
-- is real and is reported, as its own figure, `credits_pending`, so nothing is hidden; it simply
-- does not flatter the net number before the money moves. If the owner decides that an agreed
-- credit should net immediately, this is the one line to change and the suite says so.

create or replace function private.canonical_purchase_metrics(
  p_org_id uuid,
  p_from date,
  p_to date
) returns jsonb
language sql
stable
set search_path = public, pg_temp
as $fn$
  with committed as (
    -- WHAT WAS ORDERED, at the prices agreed when it was ordered. `unit_price` on the order item
    -- is the snapshot (ARCHITECTURE.md), never today's price list -- otherwise a price rise would
    -- retroactively change what a past month cost. Cancelled orders are excluded because nothing
    -- was committed; drafts are excluded because nothing was sent.
    select count(*)::bigint as order_count,
           sum(item_total) as value
    from (
      select po.id, sum(poi.qty * poi.unit_price) as item_total
      from public.purchase_orders po
      join public.purchase_order_items poi
        on poi.org_id = po.org_id and poi.order_id = po.id
      where po.org_id = p_org_id
        and po.status not in ('draft', 'cancelled')
        -- The business day, not the UTC day. `created_at` is an instant; a month boundary is a
        -- local calendar fact, and this is the conversion the two dashboards disagreed about.
        and (po.created_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
      group by po.id
    ) per_order
  ),
  gross as (
    -- WHAT WE WERE BILLED. Approved invoices only: an invoice still in review is a claim, not an
    -- expense, and counting it would make every month's figure move as the office works through
    -- its queue. By `invoice_date` -- the date the supplier billed -- because that is what the
    -- label on every screen says, and what an accountant reconciles against.
    select count(*)::bigint as invoice_count,
           sum(i.total_amount) as value
    from public.invoices i
    where i.org_id = p_org_id
      and i.deleted_at is null
      and i.review_status = 'approved'
      and i.invoice_date between p_from and p_to
  ),
  credits as (
    select
      count(*) filter (where c.status in ('offset', 'closed'))::bigint as recognised_count,
      sum(c.amount) filter (where c.status in ('offset', 'closed')) as recognised,
      count(*) filter (where c.status in ('open', 'requested', 'received'))::bigint as pending_count,
      sum(c.amount) filter (where c.status in ('open', 'requested', 'received')) as pending
    from public.credit_requests c
    where c.org_id = p_org_id
      and coalesce(c.resolved_at, c.created_at)::date between p_from and p_to
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'time_zone', 'Asia/Jerusalem',
    -- Committed and gross stay SEPARATE and are never summed or netted against each other. They
    -- are not two views of one number: an order placed in March and billed in April belongs to
    -- both months, in different senses, and a screen that adds them is double counting.
    'committed', case when committed.order_count > 0 then round(committed.value, 2) end,
    'committed_order_count', committed.order_count,
    'gross_expense', case when gross.invoice_count > 0 then round(gross.value, 2) end,
    'gross_invoice_count', gross.invoice_count,
    'credits_recognised',
      case when credits.recognised_count > 0 then round(credits.recognised, 2) end,
    'credits_pending',
      case when credits.pending_count > 0 then round(credits.pending, 2) end,
    'net_expense', case when gross.invoice_count > 0
      then round(gross.value - coalesce(credits.recognised, 0), 2) end,
    'net_definition', 'gross_minus_offset_and_closed_credits'
  )
  from committed, gross, credits
$fn$;

revoke all on function private.canonical_purchase_metrics(uuid, date, date)
  from public, anon, authenticated, service_role;

comment on function private.canonical_purchase_metrics(uuid, date, date) is
  'The four purchase-money figures, defined once (0113): committed (non-draft, non-cancelled '
  'orders at snapshot prices), gross expense (approved invoices by invoice_date), recognised '
  'credits, and net. Buckets by the BUSINESS day (Asia/Jerusalem), which is the divergence two '
  'dashboards had. Every figure is null when its source set is empty, because a dash and a zero '
  'are different claims. Committed and gross are never netted against one another. Recognised '
  'credits are `offset`+`closed` only -- OPEN-DECISIONS #147 -- with agreed-but-unapplied credits '
  'reported separately as credits_pending so nothing is hidden.';

create or replace function public.get_purchase_metrics(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
begin
  -- The same readers 0100's management snapshot serves. `kitchen` is deliberately absent: this is
  -- the money view, and role visibility is not widened just to make two screens agree on a number
  -- (the campaign plan says so in as many words).
  if auth.uid() is null or v_org is null or v_role not in ('owner', 'office', 'accountant') then
    raise exception 'purchase_metrics_not_authorized' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'purchase_metrics_invalid_window' using errcode = '22023';
  end if;
  return private.canonical_purchase_metrics(v_org, p_from, p_to);
end
$$;

revoke all on function public.get_purchase_metrics(date, date) from public, anon;
grant execute on function public.get_purchase_metrics(date, date) to authenticated;

comment on function public.get_purchase_metrics(date, date) is
  'The canonical purchase-money figures for a window (0113). One definition for every screen that '
  'claims to answer the same question, so "נרכש החודש" cannot mean two things on two dashboards. '
  'Readers are owner/office/accountant -- the role boundary is not widened to make numbers agree.';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values (
  'get_purchase_metrics(date,date)',
  '0113 aggregates only within auth_org after an explicit role check, and returns totals rather '
  'than rows, so no per-unit record crosses the boundary in either direction.'
)) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0113 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== Anchors =====
do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'canonical_purchase_metrics';

  -- (a) The business time zone, which is the divergence this function exists to end.
  if position('Asia/Jerusalem' in v_src) = 0 then
    raise exception
      '0113: the metric stopped converting to the business time zone. An order placed at 01:00 '
      'local on the 1st is the previous month in UTC, which is exactly how two dashboards came to '
      'disagree about the same order.';
  end if;

  -- (b) Snapshot prices. Reaching for supplier_products here would let a price rise retroactively
  -- change what a past month cost.
  if position('supplier_products' in v_src) > 0 or position('current_price' in v_src) > 0 then
    raise exception
      '0113: the committed figure reads today''s price list. It must use the order item''s '
      'snapshot price, or last month''s total changes every time a supplier raises a price.';
  end if;

  -- (c) Approved invoices only, and the recognised-credit set the documented default names.
  if position('''approved''' in v_src) = 0 then
    raise exception '0113: gross expense no longer restricts to approved invoices.';
  end if;
  if position('''offset''' in v_src) = 0 or position('''closed''' in v_src) = 0 then
    raise exception
      '0113: the recognised-credit definition changed. It is OPEN-DECISIONS #147 and belongs in '
      'that table before it belongs in this function.';
  end if;

  -- (d) It reads. A metric that writes is a metric that changes what it measures.
  if (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'canonical_purchase_metrics') <> 's' then
    raise exception '0113: the canonical metric is not STABLE.';
  end if;

  -- (e) The browser reaches the public wrapper and nothing beneath it.
  if has_function_privilege('authenticated',
       'private.canonical_purchase_metrics(uuid,date,date)', 'execute') then
    raise exception
      '0113: authenticated can call the private metric directly, which takes org_id as an argument.';
  end if;
  if not has_function_privilege('authenticated',
       'public.get_purchase_metrics(date,date)', 'execute') then
    raise exception '0113: authenticated cannot call the metric wrapper.';
  end if;
end
$$;
