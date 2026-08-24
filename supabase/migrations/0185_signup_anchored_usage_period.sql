-- OWNER DECISION #242 (22.08.2026) -- the usage period stops following the money.
--
-- THE DEFECT THIS REPLACES, stated exactly. 0155 defined `private.usage_period()` as: the
-- subscription's current billing window when the provider has given us one and now() falls inside
-- it, otherwise the calendar month in Asia/Jerusalem. Both halves are wrong under #242, and each is
-- wrong in its own way:
--
--   * The subscription arm makes a QUOTA WINDOW out of a PAYMENT window. Every event that moves a
--     billing period -- a first payment (#217), a renewal, a tier or interval change (#216), a
--     cancellation (#219), a refund (#225), a late payment that opens a whole new billing period
--     at the approval timestamp (#223) -- silently re-keys `private.usage_counters`, whose primary
--     key is (org_id, metric_key, period_start). A new period_start is a new row, and a new row
--     starts at zero. Nobody wrote "reset the counters"; the schema did it as a side effect. A
--     customer at 24 of 25 could pay, get a fresh 25, and a customer who cancelled could get
--     another fresh 25 on the way down.
--
--   * The calendar-month arm resets EVERY organization at midnight on the first, regardless of when
--     it joined. An organization that signed up on the 28th gets its first "month" as three days.
--
-- #242 replaces both with one rule: the organization's signup timestamp is the permanent anchor for
-- every usage period, on every plan, for the organization's whole life. Periods are monthly by
-- calendar arithmetic from that instant. Payment, renewal, tier or interval change, cancellation,
-- refund, delinquency recovery and the Legacy cutover never move period_start and never reset a
-- counter. The billing period is a separate thing and now lives in a separate table (0184).
--
-- ===== CALENDAR ARITHMETIC, MONTH ENDS AND DST =====
--
-- Every period boundary is computed from the ORIGINAL anchor -- `anchor + n months` -- never by
-- adding a month to the previous boundary. The difference is the whole month-end question:
--
--     anchor 31.01 09:17     iterative: 31.01 -> 28.02 -> 28.03 -> 28.04   (drifts off the 31st)
--                            from anchor: 31.01 -> 28.02 -> 31.03 -> 30.04 (returns to the 31st)
--
-- PostgreSQL's own month addition clamps into a short month and the anchor is never mutated, so the
-- second column is what this function produces. A February member keeps the last day of February
-- and gets the 31st back in March.
--
-- The arithmetic is done in LOCAL Jerusalem time and converted back, so a period boundary keeps its
-- wall-clock time across a daylight-saving change instead of sliding by an hour twice a year. The
-- one residual case is an anchor whose local time falls inside the spring-forward gap: that instant
-- does not exist on that date, PostgreSQL resolves it deterministically to the adjacent real
-- instant, and the boundary is still strictly ordered. It is written down here rather than rounded
-- away.
--
-- ===== THE COUNTERS THAT ALREADY EXIST =====
--
-- Changing the window would, on its own, do exactly the harm this migration exists to stop: the
-- currently open counter row would no longer be found, a fresh row would be created at the new
-- period_start, and every customer would be handed a reset on the day of the upgrade. So the open
-- rows are RE-BASED rather than abandoned: their quantities are folded into the row at the new
-- period_start, and the usage events that produced them are re-stamped so a later refund (0160)
-- decrements the row that actually holds its quantity. Historical, already-closed rows keep their
-- own period_start untouched -- they are the record of months that really happened.
--
-- What moved is written to `private.usage_period_rebase_ledger` rather than being done silently,
-- and the anchor block below refuses to finish unless every re-based row still holds every unit it
-- held before.
--
-- What this deliberately does not cover: the assistant introduction window (#209) is a DIFFERENT
-- anchor -- 30 consecutive days from the owner's first email verification -- and is not built here.
-- Nothing about the billing period is touched; 0184 owns that table.

-- ===== 1. The anchor =====
create table private.organization_usage_anchors (
  org_id        uuid primary key references organizations(id) on delete restrict,
  anchor_at     timestamptz not null,
  anchor_source text not null check (length(btrim(anchor_source)) > 0),
  created_at    timestamptz not null default now()
);
revoke all on table private.organization_usage_anchors
  from public, anon, authenticated, service_role;

comment on table private.organization_usage_anchors is
  'The permanent usage-period anchor, one row per organization (0185, #242). Immutable by trigger: '
  'a payment, a renewal, a plan change, a cancellation, a refund or the Legacy cutover must never '
  'be able to move it, and the cheapest way to guarantee that is to make it unwritable.';

-- Immutable means immutable. #242 lists six events that must not move this value; enumerating them
-- in six call sites would be six chances to miss one.
create or replace function private.usage_anchor_immutable() returns trigger
language plpgsql as $$
begin
  if new.org_id is distinct from old.org_id or new.anchor_at is distinct from old.anchor_at then
    raise exception 'usage_anchor_immutable' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.usage_anchor_immutable() from public, anon, authenticated;

create trigger zz_usage_anchor_immutable
  before update on private.organization_usage_anchors
  for each row execute function private.usage_anchor_immutable();

-- Signup time is `organizations.created_at`: the row is written by the signup path itself, so it is
-- the timestamp the customer actually joined rather than a derived approximation of it.
insert into private.organization_usage_anchors (org_id, anchor_at, anchor_source)
select org.id, org.created_at, 'organization_created_at'
from organizations org
on conflict (org_id) do nothing;

-- A backfill covers who is here now; without the trigger every organization created after this
-- migration would fall back to the calendar month and #242 would be true only for old customers.
create or replace function private.organizations_usage_anchor() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into private.organization_usage_anchors (org_id, anchor_at, anchor_source)
  values (new.id, new.created_at, 'organization_created_at')
  on conflict (org_id) do nothing;
  return new;
end
$$;
revoke all on function private.organizations_usage_anchor() from public, anon, authenticated;

create trigger zzz_organizations_usage_anchor
  after insert on public.organizations
  for each row execute function private.organizations_usage_anchor();

-- ===== 2. The period =====
-- Prove what is live before replacing it. Reading the migration that LAST declared a function is
-- the minimum; it cannot see a body that drifted out of band, and this container has already shown
-- that out-of-order applies happen. So the definition this migration was reasoned against is
-- asserted at apply time, from `pg_get_functiondef` on an explicit regprocedure, and a body that is
-- not the one that was read refuses rather than being overwritten blindly.
--
-- The anchor is `calendar_month`, which occurs exactly once in the 0155 definition. It alone is not
-- decisive, because the replacement below keeps a calendar-month fallback for an identifier that
-- resolves to no organization, so the guard also requires the token this migration exists to
-- REMOVE -- a read of the billing window. A body already migrated, or drifted into something else,
-- fails here instead of being overwritten silently.
do $usage_period_drift$
declare
  v_def      text;
  v_anchor   constant text := 'calendar_month';
  v_defect   constant text := 'current_period_start';
  v_hits     integer;
  v_defects  integer;
begin
  select pg_get_functiondef(proc.oid) into v_def
  from pg_catalog.pg_proc proc
  where proc.oid = 'private.usage_period(uuid)'::regprocedure;
  if v_def is null then
    raise exception '0185: private.usage_period(uuid) not found';
  end if;
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  v_defects := (length(v_def) - length(replace(v_def, v_defect, ''))) / length(v_defect);
  if v_hits <> 1 or v_defects = 0 then
    raise exception
      '0185: usage_period body is not the 0155 definition (calendar anchor %, billing-window reads %) -- refusing to replace blindly',
      v_hits, v_defects;
  end if;
end
$usage_period_drift$;

-- Replaces 0155:90 outright. `period_source` still travels with every number, because a reader has
-- to be able to see which definition produced it -- but there are now only two answers, and
-- `subscription` is deliberately not one of them.
create or replace function private.usage_period(p_org_id uuid)
returns table (period_start timestamptz, period_end timestamptz, period_source text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_zone   constant text := 'Asia/Jerusalem';
  v_anchor timestamptz;
  v_local  timestamp;
  v_now    timestamp;
  v_months integer;
begin
  select anchor.anchor_at into v_anchor
  from private.organization_usage_anchors anchor
  where anchor.org_id = p_org_id;

  if v_anchor is null then
    -- No anchor means no such organization. Answering with the calendar month keeps the honest
    -- fallback 0155 established for an identifier that resolves to nothing.
    period_start  := date_trunc('month', now() at time zone v_zone) at time zone v_zone;
    period_end    := (date_trunc('month', now() at time zone v_zone) + interval '1 month')
                     at time zone v_zone;
    period_source := 'calendar_month';
    return next;
    return;
  end if;

  v_local := v_anchor at time zone v_zone;
  v_now   := now() at time zone v_zone;

  -- Whole months elapsed, then one correction: the month difference counts boundaries crossed, and
  -- now() may still be short of this month's anchor day.
  v_months := (extract(year from v_now)::integer - extract(year from v_local)::integer) * 12
            + (extract(month from v_now)::integer - extract(month from v_local)::integer);
  if v_now < v_local + make_interval(months => v_months) then
    v_months := v_months - 1;
  end if;
  if v_months < 0 then
    -- An anchor in the future cannot have opened a period that already closed.
    v_months := 0;
  end if;

  period_start  := (v_local + make_interval(months => v_months))     at time zone v_zone;
  period_end    := (v_local + make_interval(months => v_months + 1)) at time zone v_zone;
  period_source := 'signup_anchor';
  return next;
end
$$;
revoke all on function private.usage_period(uuid) from public, anon, authenticated;

comment on function private.usage_period(uuid) is
  'The usage period, anchored to signup for the organization''s whole life (0185, #242). Computed '
  'from the ORIGINAL anchor every time, so a month-end anchor returns to its day rather than '
  'drifting, and never from the billing period, which is a separate fact in a separate table.';

-- ===== 3. Re-basing what is already counted =====
create table private.usage_period_rebase_ledger (
  migration        text not null,
  org_id           uuid not null references organizations(id) on delete restrict,
  metric_key       text not null,
  old_period_start timestamptz not null,
  old_period_end   timestamptz not null,
  new_period_start timestamptz not null,
  new_period_end   timestamptz not null,
  quantity         numeric not null,
  created_at       timestamptz not null default now(),
  primary key (migration, org_id, metric_key, old_period_start)
);
revoke all on table private.usage_period_rebase_ledger
  from public, anon, authenticated, service_role;

comment on table private.usage_period_rebase_ledger is
  'What the #242 change moved, and from where (0185). A migration that silently re-keys a counter '
  'a customer is measured against should leave a receipt.';

-- Every counter row that now() currently falls inside, together with the window it is about to be
-- measured in. A row can be open under more than one historical definition, so this deliberately
-- takes them all rather than assuming one.
insert into private.usage_period_rebase_ledger (
  migration, org_id, metric_key, old_period_start, old_period_end,
  new_period_start, new_period_end, quantity)
select '0185', counter.org_id, counter.metric_key, counter.period_start, counter.period_end,
       period.period_start, period.period_end, counter.quantity
from private.usage_counters counter
cross join lateral private.usage_period(counter.org_id) period
where counter.period_start <= now() and counter.period_end > now();

insert into private.usage_counters (org_id, metric_key, period_start, period_end, quantity)
select distinct ledger.org_id, ledger.metric_key, ledger.new_period_start, ledger.new_period_end, 0
from private.usage_period_rebase_ledger ledger
where ledger.migration = '0185'
on conflict (org_id, metric_key, period_start) do nothing;

-- A row that survived under a different window keeps its quantity but must adopt the new end.
update private.usage_counters counter
   set period_end = ledger.new_period_end, updated_at = now()
from private.usage_period_rebase_ledger ledger
where ledger.migration = '0185'
  and counter.org_id = ledger.org_id
  and counter.metric_key = ledger.metric_key
  and counter.period_start = ledger.new_period_start
  and counter.period_end is distinct from ledger.new_period_end;

update private.usage_counters counter
   set quantity = counter.quantity + moved.quantity, updated_at = now()
from (
  select org_id, metric_key, new_period_start, sum(quantity) as quantity
  from private.usage_period_rebase_ledger
  where migration = '0185' and old_period_start <> new_period_start
  group by org_id, metric_key, new_period_start
) moved
where counter.org_id = moved.org_id
  and counter.metric_key = moved.metric_key
  and counter.period_start = moved.new_period_start;

-- 0160 stamps every event with the period it was counted into, and refunds a failed job against
-- that stamp. Moving a quantity without moving the stamp would leave a refund decrementing a row
-- that no longer holds it.
update private.usage_events event
   set period_start = ledger.new_period_start
from private.usage_period_rebase_ledger ledger
where ledger.migration = '0185'
  and ledger.old_period_start <> ledger.new_period_start
  and event.org_id = ledger.org_id
  and event.metric_key = ledger.metric_key
  and event.period_start = ledger.old_period_start;

delete from private.usage_counters counter
using private.usage_period_rebase_ledger ledger
where ledger.migration = '0185'
  and ledger.old_period_start <> ledger.new_period_start
  and counter.org_id = ledger.org_id
  and counter.metric_key = ledger.metric_key
  and counter.period_start = ledger.old_period_start;

-- ===== 4. Structural re-assertion =====
do $assert_0185$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0185 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0185 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0185$;

-- ===== 5. Anchors =====
do $anchor_0185$
declare
  v_count  integer;
  v_org    uuid;
  v_period record;
  v_days   numeric;
begin
  select count(*) into v_count from organizations org
  where not exists (
    select 1 from private.organization_usage_anchors anchor where anchor.org_id = org.id);
  if v_count > 0 then
    raise exception '0185: % organization(s) have no usage anchor and would fall back to the calendar', v_count;
  end if;

  select count(*) into v_count
  from private.organization_usage_anchors anchor
  join organizations org on org.id = anchor.org_id
  where anchor.anchor_at is distinct from org.created_at;
  if v_count > 0 then
    raise exception '0185: % anchor(s) do not equal the organization signup timestamp', v_count;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger trg
    join pg_catalog.pg_class relation on relation.oid = trg.tgrelid
    where relation.relname = 'organizations'
      and trg.tgname = 'zzz_organizations_usage_anchor' and not trg.tgisinternal
  ) then
    raise exception '0185: an organization created a minute from now would have no usage anchor';
  end if;

  -- The billing period is no longer an input. A function that still reads one would reintroduce
  -- exactly the reset #242 forbids.
  if exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('private.usage_period(uuid)')
      and prosrc like '%current_period_start%'
  ) then
    raise exception '0185: the usage period still reads a billing window';
  end if;

  select org.id into v_org from organizations org order by org.created_at limit 1;
  if v_org is not null then
    select * into v_period from private.usage_period(v_org);
    if v_period.period_source <> 'signup_anchor' then
      raise exception '0185: a real organization resolved its usage period as "%"', v_period.period_source;
    end if;
    if not (now() >= v_period.period_start and now() < v_period.period_end) then
      raise exception '0185: the current usage period does not contain the present moment';
    end if;
    v_days := extract(epoch from (v_period.period_end - v_period.period_start)) / 86400;
    if v_days < 27.9 or v_days > 31.1 then
      raise exception '0185: a usage period came out % days long', round(v_days, 2);
    end if;
    -- The signup time of day survives: a period that starts at midnight on the first is the
    -- calendar month wearing a new name.
    if (v_period.period_start at time zone 'Asia/Jerusalem')::time
       is distinct from (
         (select anchor.anchor_at from private.organization_usage_anchors anchor
          where anchor.org_id = v_org) at time zone 'Asia/Jerusalem')::time then
      raise exception '0185: the usage period lost the signup time of day';
    end if;
  end if;

  -- Month-end arithmetic, checked on the case that motivates it rather than trusted.
  if (timestamp '2026-01-31 09:17' + make_interval(months => 1))::date <> date '2026-02-28'
     or (timestamp '2026-01-31 09:17' + make_interval(months => 2))::date <> date '2026-03-31' then
    raise exception '0185: month addition does not clamp-and-return as the period arithmetic assumes';
  end if;

  -- Nothing was lost in the re-base. This is the assertion the whole migration is for.
  select count(*) into v_count from (
    select ledger.org_id, ledger.metric_key, ledger.new_period_start,
           sum(ledger.quantity) as expected
    from private.usage_period_rebase_ledger ledger
    where ledger.migration = '0185'
    group by ledger.org_id, ledger.metric_key, ledger.new_period_start
  ) expected
  left join private.usage_counters counter
    on counter.org_id = expected.org_id
   and counter.metric_key = expected.metric_key
   and counter.period_start = expected.new_period_start
  where counter.quantity is distinct from expected.expected;
  if v_count > 0 then
    raise exception '0185: % re-based counter(s) do not hold what they held before', v_count;
  end if;

  -- And no organization is left with two open rows for one metric, which would let a quota be
  -- measured against whichever the planner reached first.
  select count(*) into v_count from (
    select counter.org_id, counter.metric_key
    from private.usage_counters counter
    where counter.period_start <= now() and counter.period_end > now()
    group by counter.org_id, counter.metric_key
    having count(*) > 1
  ) doubled;
  if v_count > 0 then
    raise exception '0185: % organization/metric pair(s) have more than one open counter', v_count;
  end if;
end
$anchor_0185$;
