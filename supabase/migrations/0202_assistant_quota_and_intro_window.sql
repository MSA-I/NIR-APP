-- OWNER DECISIONS #198, #209 and #242 (21-22.08.2026) -- the assistant quota stops refusing
-- everybody, and starts refusing the right people at the right number.
--
-- ===== WHAT WAS BROKEN, STATED EXACTLY =====
--
-- 0164 seeded `assistant_runs.monthly` for every plan in the explicit UNKNOWN state
-- (`unlimited = false, numeric_limit = null`), which `effective_entitlement()` reports as
-- `measured: false` and which both assistant doors read as `assistant_limit_unknown`. That was the
-- honest state while the numbers were undecided, and 0184 deliberately LEFT it that way for the two
-- new rungs, writing down why in its own header: #198 states the steady-state figures, but #209
-- puts a differently-anchored 30-day window in front of them, and seeding the steady-state number
-- alone would under-grant every new organization for its first month. That gap is what this
-- migration closes -- both halves at once, because either half alone is a wrong answer.
--
-- ===== THE TWO WINDOWS, AND WHY THEY ARE DIFFERENT =====
--
--   #209 -- the INTRODUCTION window. 30 consecutive days from the organization owner's FIRST email
--          verification. Every new organization gets 50 runs inside it. There is no calendar-month
--          and no global-launch dependency: an organization that verified on the 28th gets thirty
--          days, not three. A Legacy->Free move (#164) does not reset the verification date and
--          does not open a second window; neither does a retry, a re-login or a plan change. The
--          stamp is therefore written ONCE and made unwritable, in the shape 0185 gave the usage
--          anchor -- enumerating the events that must not move it at six call sites would be six
--          chances to miss one.
--
--   #242 -- the USAGE period. Monthly calendar arithmetic from the organization's signup instant,
--          owned by `private.organization_usage_anchors` and `private.usage_period()` (0185). This
--          migration does not touch it and must not: payment, renewal, tier or interval change,
--          cancellation, refund, delinquency recovery and the Legacy cutover all leave it alone,
--          and that is the whole point of 0185.
--
-- The two windows straddle each other on purpose. A 30-day introduction that begins at email
-- verification will, for almost every organization, cross at least one signup-anchored period
-- boundary. That is why the runs counted INSIDE the introduction window are counted from
-- `assistant_runs` itself rather than from `private.usage_counters`: a period-keyed counter resets
-- at the boundary, and resetting a 50-run introduction allowance halfway through would hand out
-- 50 more. Counting the run rows is also what `assistant_assert_run_rate_limit()` already does, for
-- the second reason that applies here too -- a privacy delete removes a conversation and keeps its
-- run rows, so deleting a conversation must not refund a quota.
--
-- The usage counter keeps moving during the introduction window all the same. Metering has to stay
-- true even when the gate is the window: `organization_usage_snapshot()`, `platform_org_usage()`
-- and the billing reads all read that counter, and a month of introduction traffic that counted as
-- zero would make every one of them lie.
--
-- ===== WHAT `business` GETS, AND WHY THAT IS NOT A NUMBER =====
--
-- #198 says Business is `מותאם` -- per contract. That is not a figure this migration may invent.
-- A Business organization therefore keeps the UNKNOWN state and keeps refusing with
-- `assistant_limit_unknown` until somebody writes an `organization_entitlement_overrides` row for
-- it, which is exactly the one auditable, reasoned, revocable exception 0154 built for the purpose.
-- Guessing a Business number here would look like an implementation detail and behave like a
-- commercial decision nobody made. `legacy` keeps the unknown state for the same reason from the
-- other direction: #164 retires it, and a retired rung gets no new allowance.
--
-- ===== WHERE THE RECORD LIVES =====
--
-- The four decided figures are written to `private.plan_quota_decisions` beside the figure they
-- replaced, exactly as 0184 recorded #197. That table IS the record: a plan-catalogue change is
-- platform-wide and has no tenant, and `audit_logs` is an org-scoped ledger -- an audit row with no
-- organization would be a row no tenant can read and no operator queries. The introductory stamps
-- are their own record for the same reason: one immutable row per organization, carrying the source
-- that produced it and the instant it was written.
--
-- ===== HOW THE TWO DOORS CHANGE =====
--
-- 0164 built two doors on purpose and this migration keeps both:
--   * the PRE-SPEND door (`assistant_assert_run_allowed`) is cheap, non-locking and advisory -- it
--     exists to save provider money on the obvious refusals without holding a lock across a
--     provider call;
--   * the RECORD door (inside `assistant_record_run`) is the enforcement of record: it locks the
--     counter row and asserts the limit in the same transaction as the increment, so N concurrent
--     runs at limit-minus-one serialize there and exactly one crosses.
-- Both now ask ONE resolver, `private.assistant_effective_quota()`, so the introduction window and
-- the plan quota cannot drift apart between them.
--
-- `assistant_record_run` is 270 lines of transactional persistence and is NOT re-declared from this
-- file. Re-typing a body from the migration that created it is how a security property gets
-- silently reverted; the live database is the authority, so its enforcement half is replaced by an
-- ANCHORED substitution against `pg_get_functiondef()`, which refuses unless it finds the exact
-- text this migration was reasoned against. Everything else in that function -- the egress lease
-- fence, the idempotency branch, the evidence writes, the audit row -- is preserved byte for byte
-- because it is never re-typed.
--
-- 0164's closing anchor pins four calls inside that body (`usage_counter_locked`,
-- `assert_usage_within_limit`, `record_usage_event`, `assistant_assert_run_rate_limit`). All four
-- are still there, and the anchor at the bottom of this file re-asserts them plus the new
-- `assistant_effective_quota` call -- the pin is extended, not weakened.
--
-- ===== WHAT THIS DELIBERATELY DOES NOT DO =====
--
--   * It does not add a trigger on `auth.users`. That table belongs to GoTrue and this project has
--     never put a trigger on it. The stamp is materialized on first demand instead, from the
--     `email_confirmed_at` value auth already recorded -- so `started_at` is the verification
--     instant either way, and whether the row was written the moment the link was clicked or the
--     moment the first question was asked changes nothing about the answer.
--   * It does not create a browser-facing quota read model. The tenant's own usage already reaches
--     the browser through `organization_usage_snapshot()`; presenting the introduction window in
--     the assistant UI is a separate, UI-owned surface.
--   * It does not touch `private.usage_period()`, the usage anchor, or any counter row.

-- =====================================================================================
-- 1. The decided figures (#198)
-- =====================================================================================
-- Recorded first, applied from the record: a figure that reached the catalogue without reaching the
-- ledger would be a number nobody is held to, and 0184's own anchor reads the ledger to prove the
-- catalogue agrees with it.
insert into private.plan_quota_decisions
  (plan_key, entitlement_key, decided_limit, previous_limit, previous_unlimited, decision_ref)
select decided.plan_key, 'assistant_runs.monthly', decided.quota,
       existing.numeric_limit, coalesce(existing.unlimited, false), 'OPEN-DECISIONS #198'
from (values
  ('free',     20),
  ('basic',    40),
  ('pro',     100),
  ('premium', 250)
) as decided(plan_key, quota)
left join plan_entitlements existing
  on existing.plan_key = decided.plan_key
 and existing.entitlement_key = 'assistant_runs.monthly'
on conflict (plan_key, entitlement_key) do nothing;

update plan_entitlements
   set unlimited = false, numeric_limit = decision.decided_limit, updated_at = now()
from private.plan_quota_decisions decision
where decision.decision_ref = 'OPEN-DECISIONS #198'
  and decision.entitlement_key = 'assistant_runs.monthly'
  and plan_entitlements.plan_key = decision.plan_key
  and plan_entitlements.entitlement_key = decision.entitlement_key;

-- `assistant_runs.monthly` is now enforced against a stated number on four rungs. The two rungs
-- that keep the unknown-that-refuses state keep it deliberately, and the anchor below proves it.
update private.entitlement_definitions set enforced_since = '0202'
where entitlement_key = 'assistant_runs.monthly';

-- =====================================================================================
-- 2. The introductory allowance (#198/#209), as data rather than as two literals
-- =====================================================================================
-- 50 runs and 30 days are owner figures, not implementation constants. Burying them in a function
-- body would make "what did the owner decide" a question answered by reading PL/pgSQL, and would
-- make the suite that proves them re-state them instead of reading them.
create table private.assistant_intro_allowance (
  singleton    boolean primary key default true check (singleton),
  runs         integer not null check (runs > 0),
  window_days  integer not null check (window_days > 0),
  decision_ref text not null check (length(btrim(decision_ref)) > 0),
  recorded_at  timestamptz not null default now()
);
revoke all on table private.assistant_intro_allowance
  from public, anon, authenticated, service_role;

comment on table private.assistant_intro_allowance is
  'The introductory allowance as decided (0202): 50 runs across 30 consecutive days (#198/#209). '
  'One row by construction -- two rows would be two answers to a question the owner answered once.';

insert into private.assistant_intro_allowance (runs, window_days, decision_ref)
values (50, 30, 'OPEN-DECISIONS #198/#209');

-- =====================================================================================
-- 3. The introductory window stamp (#209)
-- =====================================================================================
create table private.assistant_intro_windows (
  org_id     uuid primary key references organizations(id) on delete restrict,
  started_at timestamptz not null,
  source     text not null check (source in ('owner_email_confirmed', 'backfill')),
  created_at timestamptz not null default now()
);
revoke all on table private.assistant_intro_windows
  from public, anon, authenticated, service_role;

comment on table private.assistant_intro_windows is
  'When the 30-day introduction started, one row per organization (0202, #209). `started_at` is '
  'the owner''s first email verification, never now(): the stamp records something that already '
  'happened. Immutable by trigger -- #209 names retry, re-login, plan change and the Legacy->Free '
  'cutover as events that must not reset it, and the cheapest way to guarantee that is to make it '
  'unwritable rather than to enumerate them at four call sites.';

create or replace function private.assistant_intro_window_immutable() returns trigger
language plpgsql as $$
begin
  if new.org_id is distinct from old.org_id
     or new.started_at is distinct from old.started_at then
    raise exception 'assistant_intro_window_immutable' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.assistant_intro_window_immutable()
  from public, anon, authenticated;

create trigger zz_assistant_intro_window_immutable
  before update on private.assistant_intro_windows
  for each row execute function private.assistant_intro_window_immutable();

-- Deliberately NO delete guard. `private.tenant_delete_stages()` (0196) derives its order from the
-- live foreign-key graph, so this table is staged with every other org-keyed table when a tenant is
-- purged; a BEFORE DELETE that raised would turn an approved offboarding into a stuck purge. The
-- restrict on the foreign key is what keeps the row from disappearing by accident.

-- The verification instant, read from the one place that holds it. The predicate is 0196's
-- `organization_owner_verified()` widened from "does one exist" to "which was first": the earliest
-- confirmation among the members holding the owner role. `active` is deliberately NOT required --
-- #209 anchors on the first verification that happened, and an owner who was later deactivated
-- still verified when they verified. A later promotion cannot move the answer either, because the
-- row is written once and is immutable afterwards.
create or replace function private.assistant_intro_window_start(p_org_id uuid)
returns timestamptz
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_started timestamptz;
begin
  if p_org_id is null then
    return null;
  end if;

  select window_row.started_at into v_started
  from private.assistant_intro_windows window_row
  where window_row.org_id = p_org_id;
  if found then
    return v_started;
  end if;

  select min(account.email_confirmed_at) into v_started
  from public.profiles member
  join auth.users account on account.id = member.id
  where member.org_id = p_org_id
    and member.role = 'owner'
    and account.email_confirmed_at is not null;

  -- No verified owner email means no introduction, not a guessed one. #209 grants the allowance
  -- from a verification; without one there is nothing to count thirty days from, and defaulting to
  -- now() would hand a fresh 50 runs to an organization that never verified anything.
  if v_started is null then
    return null;
  end if;

  insert into private.assistant_intro_windows (org_id, started_at, source)
  values (p_org_id, v_started, 'owner_email_confirmed')
  on conflict (org_id) do nothing;

  select window_row.started_at into v_started
  from private.assistant_intro_windows window_row
  where window_row.org_id = p_org_id;
  return v_started;
end
$$;
revoke all on function private.assistant_intro_window_start(uuid)
  from public, anon, authenticated;

comment on function private.assistant_intro_window_start(uuid) is
  'The organization''s introduction start, materialized on first demand from the owner''s earliest '
  'auth.users.email_confirmed_at (0202, #209). Null means no verified owner email and therefore no '
  'introductory allowance. Returns the STAMP once one exists, so a later promotion or a '
  'deactivation cannot move an organization''s window.';

-- Backfill from data that already exists. An organization with no verified owner email gets no row
-- -- see the function above for why that is a refusal to guess rather than an omission.
insert into private.assistant_intro_windows (org_id, started_at, source)
select org.id, verified.started_at, 'backfill'
from organizations org
join lateral (
  select min(account.email_confirmed_at) as started_at
  from public.profiles member
  join auth.users account on account.id = member.id
  where member.org_id = org.id
    and member.role = 'owner'
    and account.email_confirmed_at is not null
) verified on verified.started_at is not null
on conflict (org_id) do nothing;

-- =====================================================================================
-- 4. One resolver (#198/#209/#242)
-- =====================================================================================
-- Both doors ask this and nothing else, so the introduction window and the plan quota cannot drift
-- apart between a pre-spend check and the write that follows it.
--
--   source = 'intro'        while now() < started_at + window_days; `used` counts run ROWS inside
--                           the window (see the header for the two reasons).
--   source = 'override' |   otherwise, verbatim from public.effective_entitlement(), including its
--            'plan' |       `measured` flag -- `measured: false` is what makes an unstated quota
--            'unavailable'  refuse instead of reading as infinity, and this resolver never
--                           converts it into a number. `used` is then the signup-anchored period
--                           counter, exactly as 0164 read it.
create or replace function private.assistant_effective_quota(p_org_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_allowance private.assistant_intro_allowance;
  v_started   timestamptz;
  v_ends      timestamptz;
  v_used      numeric;
  v_quota     jsonb;
  v_period    record;
begin
  if p_org_id is null then
    return jsonb_build_object(
      'measured', false, 'unlimited', false, 'limit', null,
      'source', 'unavailable', 'window_end', null, 'used', null);
  end if;

  select * into v_allowance from private.assistant_intro_allowance where singleton;
  v_started := private.assistant_intro_window_start(p_org_id);

  if v_started is not null then
    v_ends := v_started + make_interval(days => v_allowance.window_days);
    if now() < v_ends then
      select count(*) into v_used
      from assistant_runs run
      where run.org_id = p_org_id
        and run.created_at >= v_started
        and run.created_at < v_ends;
      return jsonb_build_object(
        'measured', true,
        'unlimited', false,
        'limit', v_allowance.runs::numeric,
        'source', 'intro',
        'window_end', v_ends,
        'used', v_used);
    end if;
  end if;

  v_quota := public.effective_entitlement(p_org_id, 'assistant_runs.monthly');
  select * into v_period from private.usage_period(p_org_id);
  select coalesce(counter.quantity, 0) into v_used
  from private.usage_counters counter
  where counter.org_id = p_org_id
    and counter.metric_key = 'assistant_runs.monthly'
    and counter.period_start = v_period.period_start;

  return jsonb_build_object(
    'measured', coalesce((v_quota ->> 'measured')::boolean, false),
    'unlimited', coalesce((v_quota ->> 'unlimited')::boolean, false),
    'limit', (v_quota ->> 'limit')::numeric,
    'source', coalesce(v_quota ->> 'source', 'unavailable'),
    'window_end', v_period.period_end,
    'used', coalesce(v_used, 0));
end
$$;
revoke all on function private.assistant_effective_quota(uuid)
  from public, anon, authenticated;

comment on function private.assistant_effective_quota(uuid) is
  'The one assistant quota answer (0202, #198/#209/#242): the 30-day introductory window while it '
  'is open, counted from assistant_runs; otherwise the signup-anchored plan/override entitlement, '
  'counted from private.usage_counters. `measured: false` still means unknown, never zero.';

-- =====================================================================================
-- 5. The pre-spend door
-- =====================================================================================
-- Proving what is live before replacing it. 0164's body reads the entitlement directly; a body that
-- already consults the resolver, or one that drifted into something else, fails here instead of
-- being overwritten blindly.
do $assert_run_allowed_drift$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('public.assistant_assert_run_allowed()')
      and prosrc like '%effective_entitlement%'
      and prosrc like '%assistant_assert_run_rate_limit%'
      and prosrc not like '%assistant_effective_quota%'
  ) then
    raise exception
      '0202: assistant_assert_run_allowed is not the 0164 pre-spend door -- refusing to replace blindly';
  end if;
end
$assert_run_allowed_drift$;

-- 0164:572 with one substitution: the entitlement read becomes the resolver read. Everything else
-- is unchanged, including the deliberate non-locking shape -- this door exists to refuse cheaply
-- before provider spend, and it is NOT the enforcement of record.
create or replace function public.assistant_assert_run_allowed() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_org   uuid := auth_org();
  v_quota jsonb;
  v_used  numeric;
begin
  if v_org is null or auth.uid() is null or auth_role() is null then
    raise exception 'assistant_unauthenticated' using errcode = '42501';
  end if;

  perform public.assistant_assert_run_rate_limit();

  v_quota := private.assistant_effective_quota(v_org);
  if v_quota is null or not coalesce((v_quota ->> 'measured')::boolean, false) then
    raise exception 'assistant_limit_unknown' using errcode = 'P0001';
  end if;
  if coalesce((v_quota ->> 'unlimited')::boolean, false) then
    return jsonb_build_object(
      'allowed', true, 'unlimited', true, 'source', v_quota ->> 'source');
  end if;

  v_used := coalesce((v_quota ->> 'used')::numeric, 0);
  if v_used + 1 > (v_quota ->> 'limit')::numeric then
    raise exception 'assistant_limit_reached' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'allowed', true, 'unlimited', false,
    'used', v_used, 'limit', (v_quota ->> 'limit')::numeric,
    'source', v_quota ->> 'source', 'window_end', v_quota ->> 'window_end');
end
$$;
revoke all on function public.assistant_assert_run_allowed() from public, anon;
grant execute on function public.assistant_assert_run_allowed() to authenticated;

comment on function public.assistant_assert_run_allowed() is
  'The pre-spend assistant door (0164, re-sourced by 0202): the hourly ceiling first, then the one '
  'quota resolver -- the introductory window while it is open, the signup-anchored plan quota after '
  'it. Non-locking on purpose; assistant_record_run is the enforcement that cannot be raced.';

-- =====================================================================================
-- 6. The record door -- anchored substitution, never a re-declaration
-- =====================================================================================
do $record_run_enforcement$
declare
  v_signature constant text :=
    'public.assistant_record_run(uuid,uuid,boolean,text,jsonb,text,text,text,text,integer,'
    || 'integer,bigint,integer,boolean,jsonb,jsonb,jsonb,jsonb,uuid,uuid,jsonb)';
  v_definition text;
  v_declare_anchor constant text := '  v_counter         private.usage_counters;';
  v_declare_replacement constant text :=
    '  v_counter         private.usage_counters;' || e'\n'
    || '  v_quota           jsonb;';
  v_body_anchor constant text :=
    '  v_counter := private.usage_counter_locked(v_org, ''assistant_runs.monthly'');' || e'\n'
    || '  begin' || e'\n'
    || '    perform private.assert_usage_within_limit(' || e'\n'
    || '      v_org, ''assistant_runs.monthly'', v_counter.quantity, 1);' || e'\n'
    || '  exception when raise_exception then' || e'\n'
    || '    if sqlerrm = ''plan_limit_unknown'' then' || e'\n'
    || '      raise exception ''assistant_limit_unknown'' using errcode = ''P0001'';' || e'\n'
    || '    elsif sqlerrm = ''plan_limit_reached'' then' || e'\n'
    || '      raise exception ''assistant_limit_reached'' using errcode = ''P0001'';' || e'\n'
    || '    else' || e'\n'
    || '      raise;' || e'\n'
    || '    end if;' || e'\n'
    || '  end;';
  -- The counter row is still LOCKED first, and still by the same call, so the serialization point
  -- is unchanged: N concurrent runs at limit-minus-one queue here whichever branch decides the
  -- number. The lock is taken BEFORE the resolver reads, which is what makes the introductory
  -- count safe as well -- under READ COMMITTED the count below takes a fresh snapshot after the
  -- lock is granted, so the loser sees the winner's committed run row.
  v_body_replacement constant text :=
    '  v_counter := private.usage_counter_locked(v_org, ''assistant_runs.monthly'');' || e'\n'
    || '  v_quota := private.assistant_effective_quota(v_org);' || e'\n'
    || '  if v_quota is null or not coalesce((v_quota ->> ''measured'')::boolean, false) then' || e'\n'
    || '    raise exception ''assistant_limit_unknown'' using errcode = ''P0001'';' || e'\n'
    || '  elsif coalesce((v_quota ->> ''unlimited'')::boolean, false) then' || e'\n'
    || '    null;' || e'\n'
    || '  elsif (v_quota ->> ''source'') = ''intro'' then' || e'\n'
    || '    if coalesce((v_quota ->> ''used'')::numeric, 0) + 1 > (v_quota ->> ''limit'')::numeric then' || e'\n'
    || '      raise exception ''assistant_limit_reached'' using errcode = ''P0001'';' || e'\n'
    || '    end if;' || e'\n'
    || '  else' || e'\n'
    || '    begin' || e'\n'
    || '      perform private.assert_usage_within_limit(' || e'\n'
    || '        v_org, ''assistant_runs.monthly'', v_counter.quantity, 1);' || e'\n'
    || '    exception when raise_exception then' || e'\n'
    || '      if sqlerrm = ''plan_limit_unknown'' then' || e'\n'
    || '        raise exception ''assistant_limit_unknown'' using errcode = ''P0001'';' || e'\n'
    || '      elsif sqlerrm = ''plan_limit_reached'' then' || e'\n'
    || '        raise exception ''assistant_limit_reached'' using errcode = ''P0001'';' || e'\n'
    || '      else' || e'\n'
    || '        raise;' || e'\n'
    || '      end if;' || e'\n'
    || '    end;' || e'\n'
    || '  end if;';
begin
  -- pg_get_functiondef returns the LIVE definition: language, volatility, SECURITY DEFINER and the
  -- pinned search_path travel with it, so none of them can be lost by being re-typed here. Carriage
  -- returns are stripped first for the reason the A5 pin strips them -- a body applied from a
  -- Windows checkout carries \r and a literal anchor written with \n would never match.
  select replace(pg_get_functiondef(proc.oid), e'\r', '') into v_definition
  from pg_catalog.pg_proc proc
  where proc.oid = pg_catalog.to_regprocedure(v_signature);
  if v_definition is null then
    raise exception '0202: % not found', v_signature;
  end if;

  if v_definition like '%assistant_effective_quota%' then
    raise exception '0202: assistant_record_run already consults the resolver -- refusing to re-apply';
  end if;
  if (length(v_definition) - length(replace(v_definition, v_declare_anchor, '')))
       / length(v_declare_anchor) <> 1 then
    raise exception
      '0202: the assistant_record_run counter declaration is not the single 0164 line this substitution anchors on';
  end if;
  if (length(v_definition) - length(replace(v_definition, v_body_anchor, '')))
       / length(v_body_anchor) <> 1 then
    raise exception
      '0202: the assistant_record_run write-time enforcement block is not 0164''s -- refusing to substitute blindly';
  end if;

  v_definition := replace(v_definition, v_declare_anchor, v_declare_replacement);
  v_definition := replace(v_definition, v_body_anchor, v_body_replacement);
  execute v_definition;
end
$record_run_enforcement$;

comment on function public.assistant_record_run(
  uuid, uuid, boolean, text, jsonb, text, text, text, text, integer, integer, bigint, integer,
  boolean, jsonb, jsonb, jsonb, jsonb, uuid, uuid, jsonb) is
  'One completed assistant run lands in one transaction (0164): dialogue, evidence, tool shapes, '
  'optional proposal, usage event and audit row -- or nothing. Caller-supplied run id makes a '
  'retried Edge call idempotent. The caller''s JWT supplies actor/org and an opaque settled '
  'assistant egress lease token proves the call came through the Edge/provider boundary. Since '
  '0202 the write-time limit comes from private.assistant_effective_quota(), so the introductory '
  'window (#209) and the plan quota (#198) are enforced by the same locked-counter door.';

-- =====================================================================================
-- 7. Structural re-assertion
-- =====================================================================================
do $assert_0202$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0202 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0202 tenant export assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.org_activity_registry_violations();
  if v_violations is not null then
    raise exception e'0202 org activity registry assertions failed:\n%', v_violations;
  end if;
end
$assert_0202$;

-- =====================================================================================
-- 8. Anchors
-- =====================================================================================
do $anchor_0202$
declare
  v_count     integer;
  v_allowance private.assistant_intro_allowance;
  v_quota     jsonb;
begin
  -- (a) The four decided figures reached the catalogue, each beside the figure it replaced.
  select count(*) into v_count
  from (values ('free', 20), ('basic', 40), ('pro', 100), ('premium', 250))
    as decided(plan_key, quota)
  join plan_entitlements entitlement
    on entitlement.plan_key = decided.plan_key
   and entitlement.entitlement_key = 'assistant_runs.monthly'
   and not entitlement.unlimited
   and entitlement.numeric_limit = decided.quota;
  if v_count <> 4 then
    raise exception '0202: % of the 4 assistant quotas #198 decided reached the catalogue', v_count;
  end if;
  select count(*) into v_count from private.plan_quota_decisions
  where decision_ref = 'OPEN-DECISIONS #198' and entitlement_key = 'assistant_runs.monthly';
  if v_count <> 4 then
    raise exception '0202: the #198 record holds % figures instead of 4', v_count;
  end if;
  if exists (
    select 1 from private.plan_quota_decisions decision
    join plan_entitlements entitlement
      on entitlement.plan_key = decision.plan_key
     and entitlement.entitlement_key = decision.entitlement_key
    where decision.decision_ref = 'OPEN-DECISIONS #198'
      and (entitlement.unlimited
        or entitlement.numeric_limit is distinct from decision.decided_limit)
  ) then
    raise exception '0202: a decided assistant quota did not reach the catalogue it records';
  end if;

  -- (b) `business` and `legacy` keep the explicit unknown state. `מותאם` is a contract, not a
  -- number this file may invent, and a retired rung gets no new allowance.
  select count(*) into v_count from plan_entitlements
  where entitlement_key = 'assistant_runs.monthly'
    and plan_key in ('business', 'legacy')
    and (unlimited or numeric_limit is not null);
  if v_count > 0 then
    raise exception '0202: % contract-priced or retired rung(s) were handed an invented assistant number', v_count;
  end if;
  select count(*) into v_count from subscription_plans plan
  where plan.plan_key not in ('business', 'legacy')
    and not exists (
      select 1 from plan_entitlements entitlement
      where entitlement.plan_key = plan.plan_key
        and entitlement.entitlement_key = 'assistant_runs.monthly'
        and not entitlement.unlimited and entitlement.numeric_limit is not null);
  if v_count > 0 then
    raise exception '0202: % self-service rung(s) still refuse for want of a decided number', v_count;
  end if;

  -- (c) The allowance is one row and holds exactly what #198/#209 decided.
  select * into v_allowance from private.assistant_intro_allowance where singleton;
  if v_allowance.runs <> 50 or v_allowance.window_days <> 30 then
    raise exception '0202: the introductory allowance is % runs over % days', v_allowance.runs, v_allowance.window_days;
  end if;
  select count(*) into v_count from private.assistant_intro_allowance;
  if v_count <> 1 then
    raise exception '0202: the introductory allowance has % rows', v_count;
  end if;

  -- (d) The stamp is unwritable and closed to every browser and service role.
  if not exists (
    select 1 from pg_catalog.pg_trigger trg
    join pg_catalog.pg_class relation on relation.oid = trg.tgrelid
    where relation.relname = 'assistant_intro_windows'
      and trg.tgname = 'zz_assistant_intro_window_immutable' and not trg.tgisinternal
  ) then
    raise exception '0202: the introduction window is not immutable -- a plan change could reset it';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name in ('assistant_intro_windows', 'assistant_intro_allowance')
      and grantee in ('anon', 'authenticated', 'service_role')
  ) then
    raise exception '0202: a browser or service role holds a grant on the introduction tables';
  end if;

  -- (e) The backfill invented nothing: every stamp equals a real owner verification instant, and
  -- every organization with a verified owner has one.
  if exists (
    select 1 from private.assistant_intro_windows window_row
    where window_row.started_at is distinct from (
      select min(account.email_confirmed_at)
      from public.profiles member
      join auth.users account on account.id = member.id
      where member.org_id = window_row.org_id and member.role = 'owner'
        and account.email_confirmed_at is not null)
  ) then
    raise exception '0202: an introduction stamp does not equal its owner''s first verification';
  end if;
  select count(*) into v_count
  from organizations org
  where exists (
      select 1 from public.profiles member
      join auth.users account on account.id = member.id
      where member.org_id = org.id and member.role = 'owner'
        and account.email_confirmed_at is not null)
    and not exists (
      select 1 from private.assistant_intro_windows window_row where window_row.org_id = org.id);
  if v_count > 0 then
    raise exception '0202: % organization(s) with a verified owner have no introduction stamp', v_count;
  end if;

  -- (f) The resolver answers, and answers the honest refusal for an identifier that resolves to no
  -- organization: no anchor, no plan, no override -- and therefore no number.
  v_quota := private.assistant_effective_quota('00000000-0000-4000-8000-000000000000');
  if v_quota is null or coalesce((v_quota ->> 'measured')::boolean, true) then
    raise exception '0202: the resolver claimed to measure an organization that does not exist';
  end if;

  -- (g) Both doors ask the resolver, and the record door still locks, still asserts, still counts
  -- and still re-asserts the hourly ceiling. This is 0164's four-call pin, extended to five rather
  -- than relaxed: `assert_usage_within_limit` is still the plan-quota assertion outside the
  -- introductory window, so removing it would still be caught here.
  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure(
      'public.assistant_record_run(uuid,uuid,boolean,text,jsonb,text,text,text,text,integer,integer,bigint,integer,boolean,jsonb,jsonb,jsonb,jsonb,uuid,uuid,jsonb)')
      and prosrc like '%usage_counter_locked%'
      and prosrc like '%assert_usage_within_limit%'
      and prosrc like '%record_usage_event%'
      and prosrc like '%assistant_assert_run_rate_limit%'
      and prosrc like '%assistant_effective_quota%'
      and prosrc like '%organization_external_egress_evidence%'
      and prosrc like '%assistant_egress_lease_invalid%'
  ) then
    raise exception '0202: assistant_record_run does not lock, resolve, assert and count the quota at write time';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('public.assistant_assert_run_allowed()')
      and prosrc like '%assistant_effective_quota%'
      and prosrc like '%assistant_assert_run_rate_limit%'
  ) then
    raise exception '0202: the pre-spend door skips the quota resolver or the rate limit';
  end if;
  -- ...and the resolver is the one that still reads the entitlement, so the chain from door to
  -- plan is pinned end to end rather than at one link.
  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('private.assistant_effective_quota(uuid)')
      and prosrc like '%effective_entitlement%'
      and prosrc like '%usage_period%'
      and prosrc like '%assistant_intro_window_start%'
  ) then
    raise exception '0202: the resolver stopped reading the entitlement, the period or the window';
  end if;

  -- (h) The record door still preserves 0164's egress fence and idempotency branch, which the
  -- anchored substitution never re-typed. Proved by the marker rather than assumed.
  if not exists (
    select 1 from pg_catalog.pg_proc proc
    where proc.oid = pg_catalog.to_regprocedure(
      'public.assistant_record_run(uuid,uuid,boolean,text,jsonb,text,text,text,text,integer,integer,bigint,integer,boolean,jsonb,jsonb,jsonb,jsonb,uuid,uuid,jsonb)')
      and proc.prosecdef
      and 'search_path=public, pg_temp' = any(proc.proconfig)
      and proc.prosrc like '%''idempotent'', true%'
  ) then
    raise exception '0202: the substitution lost the record door''s security properties or its idempotency branch';
  end if;
end
$anchor_0202$;
