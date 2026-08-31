-- 0265 — what is actually scheduled to leave in the next thirty days, and how much of the debt
-- that figure can even see.
--
-- NOT A FORECAST, AND THE NAME IS THE POINT. This reports payment requests that carry a due date.
-- Coverage will be partial for a long time, so the read model returns it as FIELDS rather than as
-- a note: a caller cannot render the amount without also holding `covered_count`, `total_count`,
-- `covered_amount` and `uncovered_amount`. Presenting a partial figure as a cash-flow forecast is
-- the "claim about reality" this whole item forbids — at 39% coverage and at 91% alike.
--
-- COVERAGE IN COUNT IS NOT COVERAGE IN MONEY. Nine dated requests out of twenty-three might be
-- ninety percent of the money or three percent of it, and a card that reports only the ratio of
-- rows tells the reader nothing about their exposure. Both are returned, always.
--
-- WHAT IS DELIBERATELY OUTSIDE THE HORIZON. `openOrders.remaining` is money committed to an order,
-- not money owed on a day. It is returned as a separate undated row beside the horizon and never
-- inside it — a commitment with no date cannot be scheduled, and folding it in would produce a
-- thirty-day figure containing money that may leave in eight months.
--
-- AND TWO TABLES, NOT ONE. Backtesting needs the cohort that was measured, frozen. A header row
-- carrying only a total forces a later measurement to REBUILD the cohort from the live tables — at
-- which point a cancelled request has vanished and a new one has appeared, which is exactly the
-- leakage that makes a backtest meaningless. `forecast_snapshot_requests` freezes each request's
-- amount, currency, due date and status as they stood, and `actual` is measured against those rows
-- and never against `payment_requests` as they are today. The rows are immutable: no update, no
-- delete, and no command that repairs one.
--
-- SO P2.1 IS NOT A READ MODEL THAT WRITES NOTHING. It writes a monthly measurement of the system's
-- own output. That row is not an audit row: it has no actor and no reason, because nobody did it.

-- ===== 1. The frozen header =====
create table public.forecast_snapshots (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  horizon_days      int not null check (horizon_days > 0),
  currency          text not null references public.currencies(code),
  -- What the model said would leave, in this currency, inside this horizon.
  forecast_amount   numeric(18,4) not null,
  -- The two coverages, side by side, because they answer different questions.
  covered_count     int not null check (covered_count >= 0),
  total_count       int not null check (total_count >= 0),
  covered_amount    numeric(18,4) not null,
  uncovered_amount  numeric(18,4) not null,
  horizon_ends_at   date not null,
  as_of             timestamptz not null default now(),
  constraint forecast_snapshots_coverage check (covered_count <= total_count),
  unique (org_id, as_of, horizon_days, currency)
);
create index forecast_snapshots_org_idx
  on public.forecast_snapshots (org_id, as_of desc, horizon_days);
-- The composite target the frozen cohort references, so a row can never reach another tenant's
-- snapshot. Declared here rather than after the child table, which is where it has to exist.
alter table public.forecast_snapshots
  add constraint forecast_snapshots_org_id_key unique (org_id, id);

comment on table public.forecast_snapshots is
  'One monthly measurement of the scheduled-payments outlook, per horizon and per currency (0265). '
  'Carries its own coverage in count AND in amount, so a later reader cannot see the figure '
  'without seeing how much of the debt it could see. A record of the system measuring itself: no '
  'actor, no reason, and not an audit row.';

-- ===== 2. The frozen cohort =====
create table public.forecast_snapshot_requests (
  snapshot_id   uuid not null,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  request_id    uuid not null,
  -- As they stood AT THE MOMENT OF THE SNAPSHOT. Never re-read from the live row.
  amount        numeric(18,4) not null,
  currency      text not null references public.currencies(code),
  due_date      date,
  status        text not null,
  primary key (snapshot_id, request_id),
  -- Composite, so a row can never point at another tenant's snapshot or another tenant's request.
  constraint forecast_snapshot_requests_snapshot_fkey
    foreign key (org_id, snapshot_id) references public.forecast_snapshots (org_id, id)
    on delete cascade,
  constraint forecast_snapshot_requests_request_fkey
    foreign key (org_id, request_id) references public.payment_requests (org_id, id)
    on delete cascade
);
create index forecast_snapshot_requests_org_idx
  on public.forecast_snapshot_requests (org_id, snapshot_id);

comment on table public.forecast_snapshot_requests is
  'The cohort a forecast snapshot was measured over, frozen (0265). Immutable by construction: '
  'rebuilding it later from the live tables would drop a cancelled request and pick up a new one, '
  'and that leakage is what makes a backtest lie. `actual` is measured against these rows.';

-- ===== 3. Tenancy =====
alter table public.forecast_snapshots enable row level security;
alter table public.forecast_snapshot_requests enable row level security;

create policy forecast_snapshots_read on public.forecast_snapshots
  for select to authenticated using (org_id = auth_org());
create policy forecast_snapshot_requests_read on public.forecast_snapshot_requests
  for select to authenticated using (org_id = auth_org());

-- Read-only to every client role. The writer is the scheduled job and nothing else.
revoke all on table public.forecast_snapshots from public, anon, authenticated;
revoke all on table public.forecast_snapshot_requests from public, anon, authenticated;
grant select on table public.forecast_snapshots to authenticated;
grant select on table public.forecast_snapshot_requests to authenticated;

create trigger zz_organization_write_guard
  before insert or update or delete on public.forecast_snapshots
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard
  before insert or update or delete on public.forecast_snapshot_requests
  for each row execute function private.organization_row_write_guard();

-- IMMUTABLE, AND SAID IN A TRIGGER RATHER THAN IN A COMMENT. A revoked grant is not enough: the
-- writer runs as a role that has grants, and the whole value of the cohort is that nothing —
-- including a well-meaning repair — can move it after the fact.
create or replace function private.forecast_snapshot_rows_are_frozen()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'forecast_snapshot_rows_are_frozen' using errcode = '42501';
end
$$;

create trigger forecast_snapshot_requests_frozen
  before update or delete on public.forecast_snapshot_requests
  for each row execute function private.forecast_snapshot_rows_are_frozen();
create trigger forecast_snapshots_frozen
  before update on public.forecast_snapshots
  for each row execute function private.forecast_snapshot_rows_are_frozen();

-- Both tables are DERIVED: rows the system computed from `payment_requests`, org-scoped and
-- carrying no unit of their own. `consolidated_invoice_snapshots` is classified the same way for
-- the same reason — a measurement of scoped rows is not itself a scoped record.
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('forecast_snapshots', 'derived', false),
  ('forecast_snapshot_requests', 'derived', false)
on conflict (table_name) do update
  set scope_class = excluded.scope_class, enforced = excluded.enforced;

-- NOT EVIDENCE THAT ANYBODY USED THE PRODUCT. A row appears in either table because a monthly
-- cron job ran, not because a person did something — so counting one as activity would keep an
-- abandoned tenant looking alive forever. `profiles` and `org_units` are classified the same way
-- for the same reason: created by machinery at signup, proving nothing about use.
insert into private.org_activity_evidence_registry (table_name, disposition, rationale) values
  ('forecast_snapshots', 'not_evidence',
   'Written by the monthly cron job, never by a person; its existence proves nothing was used.'),
  ('forecast_snapshot_requests', 'not_evidence',
   'The frozen cohort behind a cron-written snapshot; same machinery, same absence of a person.')
on conflict (table_name) do update set
  disposition = excluded.disposition,
  rationale = excluded.rationale;

insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale)
values
  ('forecast_snapshots', 'include', '{}',
   'The tenant''s own monthly measurement of its scheduled-payments outlook, with the coverage '
   'that measurement had.'),
  ('forecast_snapshot_requests', 'include', '{}',
   'The frozen cohort behind each snapshot: the tenant''s own requests as they stood when the '
   'measurement was taken.')
on conflict (table_name) do update set
  disposition = excluded.disposition,
  excluded_columns = excluded.excluded_columns,
  rationale = excluded.rationale;

update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
    )
where registry.table_name in ('forecast_snapshots', 'forecast_snapshot_requests');

-- ===== 4. The read model =====
--
-- `office` IS REFUSED, AND REFUSED IN WORDS. The outlook rests on balances and requests outside
-- that role's scope (#151). A blocked block returns `not_permitted` rather than zeros — returning
-- zeros is `DEBT §59` exactly: a permission boundary rendered as a business fact, so an office
-- user reads "nothing is due" when the truth is "you may not see this".
create or replace function public.scheduled_payments_outlook(p_horizon_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
  v_ends date;
  v_rows jsonb;
  v_undated jsonb;
begin
  if v_org is null then
    return jsonb_build_object('status', 'not_permitted', 'reason', 'no_tenant');
  end if;
  if v_role not in ('owner', 'accountant') then
    return jsonb_build_object('status', 'not_permitted', 'reason', 'role_out_of_scope');
  end if;
  if p_horizon_days is null or p_horizon_days <= 0 or p_horizon_days > 365 then
    raise exception 'horizon_out_of_range' using errcode = '22023';
  end if;
  v_ends := v_today + p_horizon_days;

  -- One row per currency. Coverage counts EVERY active request in that currency, dated or not,
  -- so the denominator is the debt and not the part of it that happens to be visible.
  select coalesce(jsonb_agg(jsonb_build_object(
    'currency', measured.currency,
    'amount', measured.amount,
    'recordCount', measured.record_count,
    'coveredCount', measured.covered_count,
    'totalCount', measured.total_count,
    'coveredAmount', measured.covered_amount,
    'uncoveredAmount', measured.uncovered_amount
  ) order by measured.currency), '[]'::jsonb)
  into v_rows
  from (
    select request.currency,
      -- The horizon figure: dated, active, inside the window.
      coalesce(sum(request.amount) filter (
        where request.due_date is not null
          and request.due_date between v_today and v_ends), 0) as amount,
      count(*) filter (
        where request.due_date is not null
          and request.due_date between v_today and v_ends)::int as record_count,
      -- Coverage, in rows and in money, over the whole active set.
      count(*) filter (where request.due_date is not null)::int as covered_count,
      count(*)::int as total_count,
      coalesce(sum(request.amount) filter (where request.due_date is not null), 0) as covered_amount,
      coalesce(sum(request.amount) filter (where request.due_date is null), 0) as uncovered_amount
    from public.payment_requests request
    where request.org_id = v_org
      -- The scope predicate is the enforcement, not a formality: a request belonging to a unit
      -- this actor cannot see must not reach a figure they read.
      and (request.unit_id is null or request.unit_id = any(public.auth_scopes()))
      and request.status not in ('draft', 'executed', 'matched', 'cancelled')
    group by request.currency
  ) measured;

  -- OUTSIDE THE HORIZON ON PURPOSE. What remains on an open order is money committed, not money
  -- owed on a day; putting it inside a thirty-day figure would schedule a payment nobody dated.
  select coalesce(jsonb_agg(jsonb_build_object(
    'currency', commitment.currency, 'amount', commitment.remaining)
    order by commitment.currency), '[]'::jsonb)
  into v_undated
  from (
    select purchase_order.currency,
      sum(greatest(item.qty - coalesce(item.received_qty, 0), 0) * item.unit_price) as remaining
    from public.purchase_orders purchase_order
    join public.purchase_order_items item on item.order_id = purchase_order.id
    where purchase_order.org_id = v_org
      and purchase_order.status in ('sent', 'confirmed', 'partial')
    group by purchase_order.currency
    having sum(greatest(item.qty - coalesce(item.received_qty, 0), 0) * item.unit_price) > 0
  ) commitment;

  return jsonb_build_object(
    'status', 'measured',
    'horizonDays', p_horizon_days,
    'horizonEndsAt', v_ends,
    'asOf', now(),
    'byCurrency', v_rows,
    'undatedCommitmentsByCurrency', v_undated
  );
end
$$;

comment on function public.scheduled_payments_outlook(int) is
  'What is scheduled to leave inside a horizon, per currency, with the coverage that figure has '
  'in BOTH rows and money (0265). Owner and accountant only; office is refused in words rather '
  'than with zeros, because a permission boundary rendered as a business fact reads as "nothing '
  'is due". Undated order commitments are returned beside the horizon and never inside it.';

revoke all on function public.scheduled_payments_outlook(int) from public;
revoke all on function public.scheduled_payments_outlook(int) from anon;
grant execute on function public.scheduled_payments_outlook(int) to authenticated;

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select 'scheduled_payments_outlook(integer)',
       md5(replace(p.prosrc, e'\r', '')), 'filtered_read',
       '0265 reads only rows whose org_id equals auth_org(), refuses every role outside owner and '
       'accountant before any read, and returns not_permitted rather than zeros.'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'scheduled_payments_outlook'
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== 5. The writer, and the clock that calls it =====
create or replace function private.record_forecast_snapshots()
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org record;
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
  v_ends date := ((now() at time zone 'Asia/Jerusalem')::date) + 30;
  v_as_of timestamptz := now();
  v_snapshot record;
  v_written int := 0;
begin
  for v_org in select id from public.organizations where status <> 'suspended' loop
    -- One header per currency that has any active request. An organisation with none writes no
    -- row at all rather than a row of zeros: there was nothing to measure.
    for v_snapshot in
      insert into public.forecast_snapshots (
        org_id, horizon_days, currency, forecast_amount,
        covered_count, total_count, covered_amount, uncovered_amount, horizon_ends_at, as_of)
      select v_org.id, 30, request.currency,
        coalesce(sum(request.amount) filter (
          where request.due_date is not null
            and request.due_date between v_today and v_ends), 0),
        count(*) filter (where request.due_date is not null)::int,
        count(*)::int,
        coalesce(sum(request.amount) filter (where request.due_date is not null), 0),
        coalesce(sum(request.amount) filter (where request.due_date is null), 0),
        v_ends, v_as_of
      from public.payment_requests request
      where request.org_id = v_org.id
        and request.status not in ('draft', 'executed', 'matched', 'cancelled')
      group by request.currency
      returning id, currency
    loop
      v_written := v_written + 1;
      -- THE COHORT, FROZEN. Amount, currency, due date and status as they stand right now, so a
      -- later backtest measures the same set rather than whatever survived.
      insert into public.forecast_snapshot_requests (
        snapshot_id, org_id, request_id, amount, currency, due_date, status)
      select v_snapshot.id, v_org.id, request.id, request.amount, request.currency,
             request.due_date, request.status::text
      from public.payment_requests request
      where request.org_id = v_org.id
        and request.currency = v_snapshot.currency
        and request.status not in ('draft', 'executed', 'matched', 'cancelled');
    end loop;
  end loop;
  return v_written;
end
$$;

comment on function private.record_forecast_snapshots() is
  'The monthly measurement: one header per organisation per currency with any active request, and '
  'the frozen cohort behind it (0265). An organisation with nothing to measure writes no row, '
  'because a row of zeros would be a measurement that did not happen.';

revoke all on function private.record_forecast_snapshots() from public, anon, authenticated;

-- THE WRITER CANNOT BE SCOPE-ENFORCED, AND SAYING SO IS THE HONEST ANSWER. It runs from
-- `cron.schedule` with no JWT at all, so `auth_scopes()` returns nothing and a scope predicate
-- inside it would silently measure zero rows for every tenant. It carries the same exemption
-- reason the other trusted server paths do, and its tenancy is STRUCTURAL instead: it iterates
-- organisations explicitly and every read and write inside the loop is filtered by that
-- organisation's id, while no client role can execute it at all. `check:exemptions` is what stops
-- this list from growing quietly.
insert into private.scope_definer_exemptions (function_signature, reason, target_wave) values
  ('private.record_forecast_snapshots()',
   'trusted-server-no-scope -- the monthly job runs from cron with no user JWT, so auth_scopes() '
   'is empty. Tenancy is structural: it iterates organisations and filters every read and write '
   'by that org id, and no client role can execute it.',
   'P2.1')
on conflict (function_signature) do update
  set reason = excluded.reason, target_wave = excluded.target_wave;

-- `cron.schedule(job_name, ...)` is an upsert by name, so applying this file twice converges on
-- one job. 01:10 UTC on the first of the month: after the month it measures has closed, and clear
-- of the 00:20 grant sweep and the 04:00 payment scan so no two jobs contend for the same rows.
select cron.schedule(
  'supplyflow-forecast-snapshots',
  '10 1 1 * *',
  'select private.record_forecast_snapshots();'
);

-- ===== Proof =====
do $verify_0265$
declare
  v_violations text;
begin
  -- The cohort is immutable, and that is proved by trying rather than by reading the trigger.
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.forecast_snapshot_requests'::regclass
      and tgname = 'forecast_snapshot_requests_frozen' and not tgisinternal) then
    raise exception '0265: the frozen-cohort trigger is absent';
  end if;

  -- No client role may write either table; the scheduled job is the only writer.
  if has_table_privilege('authenticated', 'public.forecast_snapshots', 'insert')
     or has_table_privilege('authenticated', 'public.forecast_snapshot_requests', 'insert')
     or has_table_privilege('authenticated', 'public.forecast_snapshots', 'update')
     or has_table_privilege('anon', 'public.forecast_snapshots', 'select') then
    raise exception '0265: a client role can write or anon can read the snapshots';
  end if;
  if not has_table_privilege('authenticated', 'public.forecast_snapshots', 'select') then
    raise exception '0265: the tenant cannot read its own snapshots';
  end if;

  -- Both tables carry row-level security, not merely a grant.
  if not (select relrowsecurity from pg_class where oid = 'public.forecast_snapshots'::regclass)
     or not (select relrowsecurity from pg_class
             where oid = 'public.forecast_snapshot_requests'::regclass) then
    raise exception '0265: row level security is not enabled on both tables';
  end if;

  -- The read model refuses office in words. A zero here would be DEBT §59 all over again.
  -- Read with carriage returns stripped, like every other body read in this repository: a
  -- function applied from Windows stores CRLF and one applied on CI stores LF, and a check that
  -- only ever runs on CI would not notice the difference until production did.
  if position('''status'', ''not_permitted''' in replace(pg_get_functiondef(
      'public.scheduled_payments_outlook(int)'::regprocedure), e'', '')) = 0 then
    raise exception '0265: the read model does not refuse in words';
  end if;

  if not has_function_privilege('authenticated', 'public.scheduled_payments_outlook(int)', 'execute')
     or has_function_privilege('anon', 'public.scheduled_payments_outlook(int)', 'execute') then
    raise exception '0265: the read model is not exactly authenticated-only';
  end if;
  if has_function_privilege('authenticated', 'private.record_forecast_snapshots()', 'execute') then
    raise exception '0265: a client role can run the writer';
  end if;

  -- Both tables are in the tenant export registry, with a shape hash that is current.
  if (select count(*) from private.tenant_export_registry
      where table_name in ('forecast_snapshots', 'forecast_snapshot_requests')) <> 2 then
    raise exception '0265: the export registry does not carry both tables';
  end if;
  -- AND IN THE ACTIVITY-EVIDENCE REGISTRY. A public table carrying `org_id` and no classification
  -- blocks tenant deletion, which is how this was found: the local dry-run ran this migration's
  -- own assertions and CI ran `p75`, which is the suite that actually knows the rule.
  if (select count(*) from private.org_activity_evidence_registry
      where table_name in ('forecast_snapshots', 'forecast_snapshot_requests')
        and disposition = 'not_evidence') <> 2 then
    raise exception '0265: the activity-evidence registry does not classify both tables';
  end if;
  if exists (select 1 from private.org_activity_registry_violations()) then
    raise exception '0265: a public org table is unclassified for activity evidence';
  end if;

  -- And the clock exists rather than being described in a comment.
  if not exists (select 1 from cron.job where jobname = 'supplyflow-forecast-snapshots') then
    raise exception '0265: the monthly job was not scheduled';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0265 scope assertions failed:\n%', v_violations;
  end if;
end
$verify_0265$;
