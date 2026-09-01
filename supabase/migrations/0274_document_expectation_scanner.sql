-- 0274 — the scanner, and the exception it opens.
--
-- `0272` built the model and `0273` gave the exception vocabulary a word for it. Neither of them
-- can notice anything: an expectation with no scanner is a statement the product never checks, and
-- the whole value of the item is the noticing. This file is what turns a row into a finding.
--
-- THE SCANNER WRITES OCCURRENCES, NOT EXCEPTIONS DIRECTLY, and that is what makes it idempotent.
-- Running twice in a day opens nothing twice because `unique (expectation_id, period_start)`
-- refuses the second occurrence -- not because the job tries to remember whether it already ran.
-- A job that reasons about its own history is a job that opens duplicates the first time a run is
-- retried, and "did I already run today" is exactly the question a crashed run cannot answer.
--
-- THE CRON RUNS IN UTC AND THE ARITHMETIC RUNS IN THE TENANT'S TIMEZONE. `pg_cron` has no notion
-- of Asia/Jerusalem, so the schedule is stated in UTC and every date inside is computed as
-- `(now() at time zone expectation.timezone)::date`. Casting to `date` before comparing is the
-- point: a timestamp comparison would move the boundary by an hour twice a year, and "the 3rd to
-- the 7th" would open an exception a day early each spring and a day late each autumn.

-- ===== 1. When an expectation was switched on =====
-- `0272` has `created_at`, which is when somebody wrote the proposal down -- not when anybody
-- agreed it should scan. Without this column the first scan of a newly approved expectation would
-- reach back over every period since the proposal was drafted and open exceptions for months
-- nobody was watching. The distinction only matters because a proposal never scans, which is the
-- rule `0272` chose deliberately.
alter table public.supplier_document_expectations
  add column if not exists activated_at timestamptz;

comment on column public.supplier_document_expectations.activated_at is
  'When the expectation was approved into `active` (0274). The scanner opens no occurrence for a '
  'period that ended before this instant: a proposal written in March and approved in June is not '
  'evidence that March was missed, and backfilling it would greet the approver with a wall of '
  'exceptions for periods nobody had asked to be watched.';

-- A NEW COLUMN ON AN EXPORTED TABLE DRIFTS ITS FINGERPRINT, and the export registry is right to
-- refuse until somebody says the column is meant to leave with the tenant. `activated_at` is: it
-- is a fact about the customer's own expectation, and a copy of the table without it could not say
-- when the watching started. Same idiom as `0264` used when the invoice gained a due date.
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
where registry.table_name = 'supplier_document_expectations';

-- ===== 2. The period arithmetic, alone and testable =====
-- Split out of the scanner on purpose. This is the part with the edge cases -- a monthly window
-- that says "to the 31st" in February, a quarter whose second month is what matters, a week that
-- starts on Sunday here and on Monday in Postgres -- and a function that both computes and writes
-- can only be tested by writing.
--
-- IMMUTABLE and language sql: it reads nothing, and the planner may fold it.
create or replace function private.expectation_period_bounds(
  p_cadence text,
  p_day_from int,
  p_day_to int,
  p_weekday int,
  p_month_of_quarter int,
  p_anchor date,
  out period_start date,
  out period_end date
)
language plpgsql
immutable
as $$
declare
  v_month_start date;
  v_last_day    int;
begin
  if p_cadence = 'monthly' or p_cadence = 'quarterly' then
    if p_cadence = 'monthly' then
      v_month_start := date_trunc('month', p_anchor)::date;
    else
      -- The quarter's Nth month. `expected_month_of_quarter` is 1..3 by the column's own check.
      v_month_start := (date_trunc('quarter', p_anchor)
                        + make_interval(months => p_month_of_quarter - 1))::date;
    end if;

    -- THE CLAMP, AND WHY IT IS NOT A `least` ON THE DAY NUMBER ALONE. A monthly expectation that
    -- says "the 28th to the 31st" is a real thing a supplier does -- end of month -- and February
    -- has no 31st. Clamping to the month's own length lands it on the 28th or the 29th, which is
    -- the end of the month the customer meant. Without it `make_date(2027, 2, 31)` raises and the
    -- whole scan dies on one tenant's row.
    v_last_day := extract(day from (v_month_start + interval '1 month' - interval '1 day'))::int;
    period_start := v_month_start + (least(p_day_from, v_last_day) - 1);
    period_end   := v_month_start + (least(p_day_to,   v_last_day) - 1);

  elsif p_cadence = 'weekly' then
    -- POSTGRES WEEKS START ON MONDAY; THIS BUSINESS DOES NOT. `date_trunc('week', ...)` is ISO,
    -- and `expected_weekday` is 0..6 with 0 = Sunday to match `extract(dow)`. Subtracting the
    -- anchor's own `dow` gives the Sunday that begins its week, so a Sunday expectation belongs to
    -- the week that just began rather than the one that ended yesterday.
    period_start := p_anchor - extract(dow from p_anchor)::int + p_weekday;
    period_end   := period_start;

  else
    raise exception 'unknown_cadence' using errcode = '22023', detail = p_cadence;
  end if;
end
$$;

revoke all on function private.expectation_period_bounds(text, int, int, int, int, date)
  from public, anon, authenticated, service_role;

comment on function private.expectation_period_bounds(text, int, int, int, int, date) is
  'The window one period of an expectation covers, in the tenant''s own calendar (0274). Separated '
  'from the scanner so the month-end clamp, the leap year and the Sunday-start week can be '
  'measured without writing a row. Reads nothing and is IMMUTABLE.';

-- ===== 3. The scanner =====
-- Two passes, and they are different questions.
--
--   Pass one opens the occurrence for the period the tenant is in now. It is the ledger entry that
--   says "this period exists and we are watching it", and it is written whether or not anything is
--   late. The UNIQUE is the idempotency.
--
--   Pass two asks which open occurrences have run out of time. Only here is an exception opened,
--   and only under a lock.
--
-- WHAT THE LOCK IN PASS TWO ACTUALLY BUYS, MEASURED RATHER THAN ASSUMED. The obvious claim is
-- that it stops two scanners each opening an exception for the same period. That claim is FALSE,
-- and the negative control is what showed it: with the lock removed entirely, the second scanner
-- still opened nothing. A plain `select` followed by `update` serialises on its own -- the second
-- scanner's UPDATE waits on the first's row lock, and READ COMMITTED then re-reads a row that says
-- `missed`, so its loop body never runs. Duplicate exceptions were never the exposure here.
--
-- What `skip locked` buys is that the second scan does not WAIT. Measured against a scan holding
-- its rows for three seconds: `for update ... skip locked` returned in 3ms with no rows, while the
-- same query without it queued for the remainder of the hold. That matters because this job runs
-- on a schedule -- a run that queues behind the previous one on a tenant with many late periods is
-- a run that does not finish inside its window, and the periods it never reached are simply not
-- reported that night.
--
-- The exception insert and the stamp stay in one transaction regardless. That is what makes the
-- pair atomic if the process dies between them, which is a different failure from a race.
create or replace function private.dispatch_document_expectations()
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_row            record;
  v_bounds         record;
  v_anchor         date;
  v_today          date;
  v_step           int;
  v_exception_id   uuid;
  v_opened         int := 0;
  v_missed         int := 0;
begin
  -- ----- Pass one: the period exists -----
  for v_row in
    select e.id, e.org_id, e.cadence, e.expected_day_from, e.expected_day_to,
           e.expected_weekday, e.expected_month_of_quarter, e.timezone, e.activated_at
      from public.supplier_document_expectations e
     where e.state = 'active'
  loop
    v_today := (now() at time zone v_row.timezone)::date;

    -- BACK ONE PERIOD AS WELL AS THIS ONE. A job that did not run yesterday -- a restart, a failed
    -- deploy, a database that was down for the night -- would otherwise skip a period entirely and
    -- the document that never arrived would never be noticed. Bounded at one because reaching
    -- further would let a long outage manufacture a backlog of findings all dated today.
    for v_step in 0..1 loop
      v_anchor := case v_row.cadence
                    when 'monthly'   then (v_today - make_interval(months => v_step))::date
                    when 'quarterly' then (v_today - make_interval(months => 3 * v_step))::date
                    when 'weekly'    then v_today - (7 * v_step)
                  end;

      select * into v_bounds from private.expectation_period_bounds(
        v_row.cadence, v_row.expected_day_from, v_row.expected_day_to,
        v_row.expected_weekday, v_row.expected_month_of_quarter, v_anchor);

      -- Not before the period has begun, and not before anybody switched the expectation on.
      continue when v_bounds.period_start > v_today;
      continue when v_row.activated_at is null;
      continue when v_bounds.period_end < (v_row.activated_at at time zone v_row.timezone)::date;

      -- `where not exists` FIRST, AND `on conflict` STILL BEHIND IT. The ON CONFLICT alone is
      -- correct but it is not free: a BEFORE INSERT row trigger fires before the conflict is
      -- detected, so an insert that ends up doing nothing still runs the organisation write guard,
      -- which takes a lock on the organisation row. While another scan holds that lock this
      -- statement WAITS -- measured at 2403ms against a scan holding for 3s, on a period that
      -- already existed and needed no work at all. That wait happens before the second pass is
      -- reached, so it would mask `skip locked` entirely and the two scans would serialise anyway.
      -- With the guard clause the common case touches nothing and blocks nobody; ON CONFLICT stays
      -- for the real race, where both scans see no row and both try to insert it.
      insert into public.expectation_occurrences (org_id, expectation_id, period_start, period_end)
      select v_row.org_id, v_row.id, v_bounds.period_start, v_bounds.period_end
       where not exists (
         select 1 from public.expectation_occurrences existing
          where existing.expectation_id = v_row.id
            and existing.period_start = v_bounds.period_start)
      on conflict (expectation_id, period_start) do nothing;

      if found then
        v_opened := v_opened + 1;
      end if;
    end loop;
  end loop;

  -- ----- Pass two: the window closed and nothing arrived -----
  for v_row in
    select o.id, o.org_id, o.period_start, o.period_end,
           e.supplier_id, e.document_type, e.grace_days, s.name as supplier_name
      from public.expectation_occurrences o
      join public.supplier_document_expectations e
        on e.id = o.expectation_id and e.org_id = o.org_id
      join public.suppliers s
        on s.id = e.supplier_id and s.org_id = e.org_id
     where o.due_status = 'awaiting'
       and o.resolution = 'open'
       and e.state = 'active'
       and (now() at time zone e.timezone)::date > o.period_end + e.grace_days
       for update of o skip locked
  loop
    insert into public.exceptions (
      org_id, type, severity, status, title, details, supplier_id, assigned_role
    )
    values (
      v_row.org_id, 'expected_document_missing', 'medium', 'open',
      'מסמך שהיה צפוי מ' || v_row.supplier_name || ' לא הגיע',
      jsonb_build_object(
        'occurrence_id', v_row.id,
        'document_type', v_row.document_type,
        'period_start', v_row.period_start,
        'period_end', v_row.period_end,
        'grace_days', v_row.grace_days),
      v_row.supplier_id, 'office'
    )
    returning id into v_exception_id;

    update public.expectation_occurrences
       set due_status   = 'missed',
           missed_at    = now(),
           exception_id = v_exception_id,
           updated_at   = now()
     where id = v_row.id;

    -- NO ACTOR, AND THAT IS THE HONEST ROW. Naming a person here would put a name in the audit
    -- trail beside an action nobody performed -- the same reason `0212:114-116` leaves it null
    -- when the grant sweeper reverts a plan. The reason is still mandatory: an exception appearing
    -- in a customer's list is a sensitive action whoever caused it.
    insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
    values (v_row.org_id, null, 'expectation_occurrence_missed', 'expectation_occurrences',
            v_row.id,
            jsonb_build_object('exception_id', v_exception_id,
                               'period_start', v_row.period_start,
                               'period_end', v_row.period_end),
            'the waiting window and the grace period both ended with no document recorded against '
            'this period of a standing expectation');

    perform public.claim_notification_event_and_notify(
      v_row.org_id, 'expected_document_missing', v_row.id::text, 'warning',
      'מסמך צפוי לא הגיע',
      v_row.supplier_name || ' — ' || v_row.document_type,
      '/alerts');

    v_missed := v_missed + 1;
  end loop;

  return jsonb_build_object('occurrences_opened', v_opened, 'occurrences_missed', v_missed);
end
$$;

revoke all on function private.dispatch_document_expectations()
  from public, anon, authenticated, service_role;

comment on function private.dispatch_document_expectations() is
  'The daily scan (0274). Pass one opens the occurrence for the current period and the one before '
  'it, so a night the job did not run does not silently skip a period; the UNIQUE makes a repeat '
  'run a no-op. Pass two turns an occurrence whose window and grace both expired into `missed` and '
  'opens one exception under `for update ... skip locked`, in the same transaction, so two '
  'scanners cannot leave a second exception nothing points at.';

insert into private.notification_event_definitions (event_code, description) values
  ('expected_document_missing',
   'A document a person said to expect from this supplier did not arrive before its window and '
   'grace period ended (0274).')
on conflict (event_code) do update set description = excluded.description;

-- ONE ROW, NOT TWO. `private.expectation_period_bounds` is SECURITY INVOKER and reads no table --
-- it returns two dates computed from its own arguments -- so it is not a definer function and has
-- no business in a registry of definer exemptions. Listing it there would have spent one of the
-- pinned slots on a function that never needed an argument made for it, which is precisely the
-- quiet growth the pin exists to prevent.
--
-- THE SCANNER CANNOT BE SCOPE-ENFORCED, and the honest answer is the one `0265` already gave for
-- the monthly writer. It runs from `cron.schedule` with no JWT, so `auth_scopes()` is empty and a
-- scope predicate inside it would quietly measure nothing for every tenant. Its tenancy is
-- STRUCTURAL: every read and every write inside both loops is filtered by the org_id it read off
-- the expectation row, and no client role can execute it at all.
insert into private.scope_definer_exemptions (function_signature, reason, target_wave) values
  ('private.dispatch_document_expectations()',
   'trusted-server-no-scope -- the nightly scan runs from cron with no user JWT, so auth_scopes() '
   'is empty. Tenancy is structural: every read and write is filtered by the org id carried on the '
   'expectation row, and no client role can execute it.',
   'multi-unit enablement wave')
on conflict (function_signature) do update
  set reason = excluded.reason, target_wave = excluded.target_wave;

-- `cron.schedule(job_name, ...)` is an upsert by name, so applying this file twice converges on one
-- job. 04:17 UTC: after the 00:20 grant sweep and clear of the 04:00 payment scan, so no two jobs
-- are contending for the same tenant rows at the same instant.
select cron.schedule(
  'supplyflow-document-expectations',
  '17 4 * * *',
  'select private.dispatch_document_expectations();'
);

-- ===== 4. The four commands a person has =====
-- Each one owner/office only, each one scope-checked in its own body, each one audited with a
-- reason. `0272` shipped the fifth -- `declare_document_expectation` -- which creates the proposal
-- these act on.

-- ----- Approve the proposal into something that scans -----
create or replace function public.activate_document_expectation(
  p_expectation_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org  uuid := auth_org();
  v_role user_role := auth_role();
  v_row  public.supplier_document_expectations;
begin
  if v_org is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_row from public.supplier_document_expectations
   where id = p_expectation_id and org_id = v_org;
  if not found then
    raise exception 'expectation_not_found' using errcode = 'P0002';
  end if;
  perform public.assert_unit_in_scope(v_row.unit_id);

  if v_row.state = 'cancelled' then
    raise exception 'expectation_cancelled' using errcode = '22023';
  end if;

  update public.supplier_document_expectations
     set state = 'active',
         -- FIRST APPROVAL ONLY. Un-pausing must not move the line the scanner refuses to look
         -- behind, or a pause and a resume would erase every period in between.
         activated_at = coalesce(activated_at, now()),
         updated_at = now()
   where id = p_expectation_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (v_org, auth.uid(), 'expectation_activated', 'supplier_document_expectations',
          p_expectation_id,
          jsonb_build_object('from_state', v_row.state, 'to_state', 'active'),
          btrim(p_reason));

  return jsonb_build_object('id', p_expectation_id, 'state', 'active');
end
$$;

revoke all on function public.activate_document_expectation(uuid, text) from public, anon;
grant execute on function public.activate_document_expectation(uuid, text) to authenticated;

comment on function public.activate_document_expectation(uuid, text) is
  'Approves a proposed expectation into one that scans (0274). `activated_at` is set once and '
  'never moved, so a later pause and resume cannot make the scanner reach back over the gap.';

-- ----- Stop scanning without forgetting -----
create or replace function public.pause_document_expectation(
  p_expectation_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org  uuid := auth_org();
  v_role user_role := auth_role();
  v_row  public.supplier_document_expectations;
begin
  if v_org is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_row from public.supplier_document_expectations
   where id = p_expectation_id and org_id = v_org;
  if not found then
    raise exception 'expectation_not_found' using errcode = 'P0002';
  end if;
  perform public.assert_unit_in_scope(v_row.unit_id);

  update public.supplier_document_expectations
     set state = 'paused', updated_at = now()
   where id = p_expectation_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (v_org, auth.uid(), 'expectation_paused', 'supplier_document_expectations',
          p_expectation_id,
          jsonb_build_object('from_state', v_row.state, 'to_state', 'paused'),
          btrim(p_reason));

  return jsonb_build_object('id', p_expectation_id, 'state', 'paused');
end
$$;

revoke all on function public.pause_document_expectation(uuid, text) from public, anon;
grant execute on function public.pause_document_expectation(uuid, text) to authenticated;

comment on function public.pause_document_expectation(uuid, text) is
  'Stops the scanner without deleting the statement or the periods already recorded (0274). '
  'Occurrences already open stay exactly as they are: a pause is about the future.';

-- ----- End it -----
create or replace function public.cancel_document_expectation(
  p_expectation_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org  uuid := auth_org();
  v_role user_role := auth_role();
  v_row  public.supplier_document_expectations;
begin
  if v_org is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_row from public.supplier_document_expectations
   where id = p_expectation_id and org_id = v_org;
  if not found then
    raise exception 'expectation_not_found' using errcode = 'P0002';
  end if;
  perform public.assert_unit_in_scope(v_row.unit_id);

  update public.supplier_document_expectations
     set state = 'cancelled', updated_at = now()
   where id = p_expectation_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (v_org, auth.uid(), 'expectation_cancelled', 'supplier_document_expectations',
          p_expectation_id,
          jsonb_build_object('from_state', v_row.state, 'to_state', 'cancelled'),
          btrim(p_reason));

  return jsonb_build_object('id', p_expectation_id, 'state', 'cancelled');
end
$$;

revoke all on function public.cancel_document_expectation(uuid, text) from public, anon;
grant execute on function public.cancel_document_expectation(uuid, text) to authenticated;

comment on function public.cancel_document_expectation(uuid, text) is
  'Ends a standing expectation (0274). The rows stay -- they are human input and the history of '
  'what was expected is what makes a later argument about a missing month answerable.';

-- ----- "Not this period" -----
create or replace function public.mark_expectation_not_due(
  p_occurrence_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org  uuid := auth_org();
  v_role user_role := auth_role();
  v_occ  public.expectation_occurrences;
  v_unit uuid;
begin
  if v_org is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select o.* into v_occ from public.expectation_occurrences o
   where o.id = p_occurrence_id and o.org_id = v_org;
  if not found then
    raise exception 'occurrence_not_found' using errcode = 'P0002';
  end if;

  select e.unit_id into v_unit from public.supplier_document_expectations e
   where e.id = v_occ.expectation_id and e.org_id = v_org;
  perform public.assert_unit_in_scope(v_unit);

  -- ONE PERIOD, AND ONLY THIS ONE. "The invoice is not coming this month" is a fact about a month,
  -- not a change to the standing arrangement -- pausing the expectation instead would silence next
  -- month too, and the customer would never learn that the one after was missed.
  update public.expectation_occurrences
     set due_status = 'not_due',
         resolution = 'cancelled',
         updated_at = now()
   where id = p_occurrence_id;

  -- An exception already opened for this period is withdrawn with it: leaving it open would say
  -- the document is still missing after a person stated it was never coming.
  if v_occ.exception_id is not null then
    update public.exceptions
       set status = 'dismissed', resolved_at = now(), resolved_by = auth.uid(),
           resolution_note = btrim(p_reason)
     where id = v_occ.exception_id and org_id = v_org;
  end if;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (v_org, auth.uid(), 'expectation_occurrence_not_due', 'expectation_occurrences',
          p_occurrence_id,
          jsonb_build_object('period_start', v_occ.period_start,
                             'period_end', v_occ.period_end,
                             'exception_dismissed', v_occ.exception_id),
          btrim(p_reason));

  return jsonb_build_object('id', p_occurrence_id, 'due_status', 'not_due');
end
$$;

revoke all on function public.mark_expectation_not_due(uuid, text) from public, anon;
grant execute on function public.mark_expectation_not_due(uuid, text) to authenticated;

comment on function public.mark_expectation_not_due(uuid, text) is
  'Closes ONE period as not expected (0274), and withdraws the exception if one was already open. '
  'It does not touch the expectation, so the next period is watched exactly as before -- which is '
  'the difference between this and a pause.';

-- ----- The document turned up -----
-- WHY THIS IS A COMMAND AND NOT AUTOMATIC MATCHING. `documents` carries no document type at all --
-- `entity_type` is `inbox`/`supplier`, an attachment kind -- and the classified type lives on
-- `document_review_applications`. Matching an arrival to an expectation therefore needs a rule
-- about series, dates and revisions that nobody has stated, and inventing one here would close
-- occurrences against documents the customer never said were the same thing. So the link is made
-- by the person who can see both. The automatic matcher is a separate item, as the learning is.
create or replace function public.resolve_expectation_occurrence(
  p_occurrence_id uuid,
  p_document_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org  uuid := auth_org();
  v_role user_role := auth_role();
  v_occ  public.expectation_occurrences;
  v_unit uuid;
  v_late boolean;
begin
  if v_org is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select o.* into v_occ from public.expectation_occurrences o
   where o.id = p_occurrence_id and o.org_id = v_org;
  if not found then
    raise exception 'occurrence_not_found' using errcode = 'P0002';
  end if;

  select e.unit_id into v_unit from public.supplier_document_expectations e
   where e.id = v_occ.expectation_id and e.org_id = v_org;
  perform public.assert_unit_in_scope(v_unit);

  if p_document_id is not null
     and not exists (select 1 from public.documents d
                      where d.id = p_document_id and d.org_id = v_org and d.deleted_at is null) then
    raise exception 'document_not_found' using errcode = 'P0002';
  end if;

  -- LATENESS IS A FACT ABOUT THE PAST AND IT IS NOT ERASED. `missed_at` stays exactly where it
  -- was: a document that arrives after the window still arrived after the window, and the measure
  -- of this whole item -- how many missing documents we found -- is computed from occurrences that
  -- were missed and then received. Overwriting `missed_at` on arrival would delete the evidence
  -- that the product did its job.
  v_late := v_occ.missed_at is not null;

  update public.expectation_occurrences
     set due_status    = 'received',
         resolution    = 'resolved_by_document',
         document_id   = p_document_id,
         received_at   = now(),
         received_late = v_late,
         updated_at    = now()
   where id = p_occurrence_id;

  if v_occ.exception_id is not null then
    update public.exceptions
       set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(),
           resolution_note = btrim(p_reason)
     where id = v_occ.exception_id and org_id = v_org;
  end if;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (v_org, auth.uid(), 'expectation_occurrence_received', 'expectation_occurrences',
          p_occurrence_id,
          jsonb_build_object('document_id', p_document_id,
                             'received_late', v_late,
                             'missed_at', v_occ.missed_at),
          btrim(p_reason));

  return jsonb_build_object('id', p_occurrence_id, 'due_status', 'received',
                            'received_late', v_late);
end
$$;

revoke all on function public.resolve_expectation_occurrence(uuid, uuid, text) from public, anon;
grant execute on function public.resolve_expectation_occurrence(uuid, uuid, text) to authenticated;

comment on function public.resolve_expectation_occurrence(uuid, uuid, text) is
  'Records that the expected document arrived (0274). `missed_at` is left untouched and '
  '`received_late` is derived from it, because "arrived, but late" is the measurement this item is '
  'judged on and a single status field cannot hold both halves of it.';

-- ===== 5. Registrations =====
-- The occurrence is now an entity a direct audit row names, so the taxonomy has to classify it or
-- the audit trigger refuses the write. Same domain and same resolver as the expectation it belongs
-- to: no resolver reads a unit off this table either.
insert into private.audit_scope_taxonomy (entity_type, scope_domain, resolver, rationale)
values ('expectation_occurrences', 'organization_identity_platform', 'cross_scope',
        'One period of a standing expectation. It inherits its unit from the expectation and holds '
        'none of its own, so it is classified the way the expectation is rather than given a '
        'resolver that would have to join to answer.')
on conflict (entity_type) do update
  set scope_domain = excluded.scope_domain,
      resolver = excluded.resolver,
      rationale = excluded.rationale;

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
-- TYPES ONLY, AND WRITTEN OUT. `pg_get_function_identity_arguments` includes the parameter names,
-- and `private.scope_definer_marker_violations()` parses this column as a type list -- a signature
-- carrying `p_expectation_id uuid` makes the guard raise `invalid type name` rather than report a
-- violation, which reads as a broken migration instead of the registration mistake it is.
select sig.signature,
       md5(replace(p.prosrc, chr(13), '')), 'assert_unit',
       '0274 resolves the unit from the expectation the row belongs to and asserts it is in scope '
       'before any write, and derives the organisation from auth_org() rather than an argument.'
from (values
  ('activate_document_expectation',  'activate_document_expectation(uuid,text)'),
  ('pause_document_expectation',     'pause_document_expectation(uuid,text)'),
  ('cancel_document_expectation',    'cancel_document_expectation(uuid,text)'),
  ('mark_expectation_not_due',       'mark_expectation_not_due(uuid,text)'),
  ('resolve_expectation_occurrence', 'resolve_expectation_occurrence(uuid,uuid,text)')
) as sig(proname, signature)
join pg_proc p on p.proname = sig.proname
join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== Proof =====
do $verify_0274$
declare
  v_violations text;
  v_start date;
  v_end   date;
begin
  -- The month-end clamp, measured rather than asserted in a comment. February 2027 has 28 days,
  -- and an expectation that says "the 28th to the 31st" has to land inside the month it means.
  select period_start, period_end into v_start, v_end
    from private.expectation_period_bounds('monthly', 28, 31, null, null, date '2027-02-10');
  if v_start <> date '2027-02-28' or v_end <> date '2027-02-28' then
    raise exception '0274: the month-end clamp gave % .. %', v_start, v_end;
  end if;

  -- And the leap year is not the same answer.
  select period_end into v_end
    from private.expectation_period_bounds('monthly', 1, 31, null, null, date '2028-02-10');
  if v_end <> date '2028-02-29' then
    raise exception '0274: February 2028 ended on % rather than the 29th', v_end;
  end if;

  -- Sunday starts the week: 2026-09-03 is a Thursday, and weekday 0 is the Sunday before it.
  select period_start into v_start
    from private.expectation_period_bounds('weekly', null, null, 0, null, date '2026-09-03');
  if v_start <> date '2026-08-30' then
    raise exception '0274: the Sunday-start week began on % instead', v_start;
  end if;

  if not exists (select 1 from cron.job where jobname = 'supplyflow-document-expectations') then
    raise exception '0274: the scan was never scheduled';
  end if;

  -- No client role may reach the scanner. A grant here would let a tenant open exceptions for
  -- every other tenant at a time of its choosing.
  if has_function_privilege('authenticated', 'private.dispatch_document_expectations()', 'execute')
     or has_function_privilege('anon', 'private.dispatch_document_expectations()', 'execute') then
    raise exception '0274: a client role can execute the scanner';
  end if;

  if (select count(*) from private.audit_scope_taxonomy
      where entity_type = 'expectation_occurrences') <> 1 then
    raise exception '0274: the occurrence is not classified for audit';
  end if;

  select string_agg(detail, chr(10) order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0274 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$verify_0274$;
