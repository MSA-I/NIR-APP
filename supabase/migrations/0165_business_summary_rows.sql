-- The business summary's five metrics, defined once, on the server (סעיף 10).
--
-- WHY THIS EXISTS. `src/lib/summary.ts::buildSummary()` is the deliberate model-free answer to
-- the "AI Assistant" request: five countable business questions, answered by queries. The
-- assistant now needs the SAME five numbers as a tool (`get_business_summary`), and until this
-- migration three of the five definitions lived only as inline browser filters -- two consumers
-- of one business truth, with nothing stopping them drifting apart silently. A summary metric
-- that disagrees with the /alerts screen is worse than no assistant at all.
--
-- Shape: one SECURITY INVOKER read model, `public.p2_business_summary_rows()`, returning
-- (metric_key, value, measured) for exactly five metrics. The two metrics that already had
-- server-side definitions (0024) are CALLED, not re-implemented, so there is still exactly one
-- definition of each. Each metric is computed in its own exception block: one failing metric
-- reports itself as `measured = false, value = null` and the other four still arrive -- the SQL
-- twin of the Promise.allSettled the browser used to run. Dates resolve in Asia/Jerusalem, the
-- product's business timezone, as trailing windows (7 and 30 days) -- exactly what
-- `todayISO()`/`addCalendarDays()` computed client-side, and deliberately not calendar weeks
-- or months.
--
-- On `awaiting_approval`: it reads invoices.review_status = 'pending_approval' literally,
-- because the line says "חשבוניות". Dashboard.tsx counts `received|in_review` for its own card,
-- which is a different set -- that divergence is open decision #1 in docs/OPEN-DECISIONS.md and
-- is owned by the sections 1-6 work. When it is settled, this definition follows it rather than
-- forking a third interpretation.
--
-- What this deliberately does not cover: no new metrics, no history, no generated prose, and no
-- Hebrew labels or routes -- naming and navigation stay in the client (`src/lib/summary.ts`),
-- which maps rows by metric_key. No `private.scope_definer_exemptions` row is needed: the
-- function is SECURITY INVOKER end to end, so RLS and unit scope produce exactly the row
-- visibility the browser's own queries produced before it existed.

-- ===== 1. The read model =====
create or replace function public.p2_business_summary_rows()
returns table (metric_key text, value numeric, measured boolean)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  -- The business day, not the server day: a browser in any timezone and this function must
  -- agree on what "today" means, and the product says Israel time (src/lib/format.ts).
  v_today constant date := (now() at time zone 'Asia/Jerusalem')::date;
begin
  -- 1. invoices received in the trailing 7 days
  begin
    return query select 'received_week'::text,
      (select count(*)
         from invoices i
        where i.org_id = auth_org()
          and i.financial_role = 'payable'
          and i.deleted_at is null
          and i.received_date >= v_today - 7)::numeric,
      true;
  exception when others then
    return query select 'received_week'::text, null::numeric, false;
  end;

  -- 2. invoices awaiting approval (see the header note on open decision #1)
  begin
    return query select 'awaiting_approval'::text,
      (select count(*)
         from invoices i
        where i.org_id = auth_org()
          and i.financial_role = 'payable'
          and i.deleted_at is null
          and i.review_status = 'pending_approval')::numeric,
      true;
  exception when others then
    return query select 'awaiting_approval'::text, null::numeric, false;
  end;

  -- 3. money committed on active payment requests -- 0024's definition, called, not copied
  begin
    return query select 'expected_payments'::text,
      public.p2_active_payment_request_total(),
      true;
  exception when others then
    return query select 'expected_payments'::text, null::numeric, false;
  end;

  -- 4. distinct suppliers who raised a catalogue price in the trailing 30 days -- 0024's
  --    definition, called, not copied
  begin
    return query select 'suppliers_raised'::text,
      public.p2_suppliers_with_price_increase_since(v_today - 30)::numeric,
      true;
  exception when others then
    return query select 'suppliers_raised'::text, null::numeric, false;
  end;

  -- 5. exceptions still needing a decision
  begin
    return query select 'open_exceptions'::text,
      (select count(*)
         from exceptions x
        where x.org_id = auth_org()
          and x.status in ('open', 'in_progress'))::numeric,
      true;
  exception when others then
    return query select 'open_exceptions'::text, null::numeric, false;
  end;
end
$$;

comment on function public.p2_business_summary_rows() is
  'The five business-summary metrics (סעיף 10), one server-side definition for both consumers: '
  'the /alerts screen and the assistant tool get_business_summary. SECURITY INVOKER so RLS and '
  'unit scope give exactly the visibility the browser queries had. A metric that fails returns '
  'measured=false, value=null and never blanks its four neighbours (0165).';

-- ===== 2. Grants =====
revoke all on function public.p2_business_summary_rows() from public, anon;
grant execute on function public.p2_business_summary_rows() to authenticated;

-- ===== 3. Structural re-assertion =====
do $assert_0165$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0165 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0165 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0165$;

-- ===== 4. Anchors =====
do $anchor_0165$
declare
  v_keys text[];
begin
  -- INVOKER is the security design, not a default that happened to hold: a definer here would
  -- widen five aggregates past RLS for every caller. If someone flips it, this migration is the
  -- argument they must rewrite.
  if exists (
    select 1 from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace space on space.oid = procedure.pronamespace
    where space.nspname = 'public' and procedure.proname = 'p2_business_summary_rows'
      and procedure.prosecdef
  ) then
    raise exception '0165: p2_business_summary_rows became SECURITY DEFINER';
  end if;

  -- Same rule as my_entitlements() and organization_usage_snapshot(): a tenant summary must not
  -- accept an organization argument, because a parameter is a thing an attacker can change.
  if (select procedure.pronargs from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace space on space.oid = procedure.pronamespace
      where space.nspname = 'public' and procedure.proname = 'p2_business_summary_rows') <> 0 then
    raise exception '0165: p2_business_summary_rows grew a parameter';
  end if;

  -- Exactly the five metrics both consumers were promised, whatever visibility the caller has.
  -- Run with no JWT this counts nothing, which is fine: the anchor pins the SHAPE.
  select array_agg(summary_row.metric_key order by summary_row.metric_key)
    into v_keys from public.p2_business_summary_rows() summary_row;
  if v_keys is distinct from array[
    'awaiting_approval', 'expected_payments', 'open_exceptions',
    'received_week', 'suppliers_raised'
  ] then
    raise exception '0165: the summary read model returned metric keys %', v_keys;
  end if;

  if exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public' and routine_name = 'p2_business_summary_rows'
      and grantee = 'anon'
  ) then
    raise exception '0165: anon can execute the business summary';
  end if;
end
$anchor_0165$;
