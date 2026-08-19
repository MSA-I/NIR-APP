-- Wave 7 of Customer Operations (owner decision 19.08.2026) -- self-service signup, and the rate
-- limit that makes an anonymous door safe enough to open.
--
-- THIS REVERSES OPEN-DECISIONS #12. Until now a tenant existed only because an operator created
-- it through admin-provision, and "no self-signup (closed system)" was the recorded default. The
-- owner decided on 19.08.2026 that the product is self-service, so an unauthenticated visitor can
-- now cause an organization to exist. That is a genuinely new trust boundary and this file is
-- mostly about bounding it.
--
-- Shape: the Edge Function holds the service_role key and does the work; the database holds the
-- things a function must not be trusted to remember. Attempt evidence and the counting live here,
-- so a restarted function, a second instance, or a redeployed worker cannot reset a limiter that
-- lives in process memory.
--
-- WHAT IS HASHED, AND WHY. An attempt records a SHA-256 of the client address and of the lowercased
-- email, never the values. A rate limiter needs to recognise a repeat, which a hash does; it does
-- not need to be able to read back who tried, which storing the address would allow and which
-- would make this table a log of who visited a signup page. `private`, no grants, and the
-- comparison happens inside a definer.
--
-- THE THREE LIMITS are security defaults, not business decisions about money, and they are
-- deliberately conservative: 5 attempts per address per hour, 3 per email address per hour, and
-- 200 across the whole platform per day. The global cap is the one that matters most -- it bounds
-- how many junk organizations a single bad afternoon can create, and it is a number an operator
-- can raise once real traffic exists (OPEN-DECISIONS #162).
--
-- What this deliberately does not cover: no CAPTCHA. Supabase Auth carries hCaptcha/Turnstile as a
-- project setting rather than as code, so wiring it is an enablement step and is recorded as one
-- rather than faked here. No purge of organizations whose owner never confirmed their email --
-- they are bounded by the global cap and visible to an operator as customers that never acted,
-- and a purge is destructive work that deserves its own review (DEBT §58).

-- ===== 1. Attempt evidence =====
create table private.signup_attempts (
  id           uuid primary key default gen_random_uuid(),
  -- SHA-256 hex. Never the address or the email itself: a limiter must recognise a repeat, not
  -- be able to read back who tried.
  ip_hash      text check (ip_hash ~ '^[0-9a-f]{64}$'),
  email_hash   text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  outcome      text not null check (outcome in ('accepted', 'rate_limited', 'rejected')),
  attempted_at timestamptz not null default statement_timestamp()
);
revoke all on table private.signup_attempts from public, anon, authenticated, service_role;
create index signup_attempts_ip_idx on private.signup_attempts (ip_hash, attempted_at desc)
  where ip_hash is not null;
create index signup_attempts_email_idx on private.signup_attempts (email_hash, attempted_at desc);
create index signup_attempts_time_idx on private.signup_attempts (attempted_at desc);

comment on table private.signup_attempts is
  'Rate-limit evidence for the anonymous signup door (0159). Hashes only -- recognising a repeat '
  'does not require being able to read back who tried.';

-- ===== 2. The limiter =====
-- Counting lives in the database rather than in the function on purpose: a limiter held in
-- process memory resets on every cold start, and Edge Functions cold-start constantly.
create or replace function public.service_check_signup_rate(
  p_ip_hash text, p_email_hash text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ip_count     integer;
  v_email_count  integer;
  v_global_count integer;
  v_reason       text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_email_hash is null or p_email_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'signup_hash_invalid' using errcode = '22023';
  end if;
  if p_ip_hash is not null and p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'signup_hash_invalid' using errcode = '22023';
  end if;

  select count(*) into v_ip_count from private.signup_attempts
  where p_ip_hash is not null and ip_hash = p_ip_hash
    and attempted_at > now() - interval '1 hour';

  select count(*) into v_email_count from private.signup_attempts
  where email_hash = p_email_hash and attempted_at > now() - interval '1 hour';

  select count(*) into v_global_count from private.signup_attempts
  where outcome = 'accepted' and attempted_at > now() - interval '1 day';

  v_reason := case
    when v_ip_count >= 5 then 'address_hourly'
    when v_email_count >= 3 then 'email_hourly'
    when v_global_count >= 200 then 'platform_daily'
    else null end;

  -- The refused attempt is recorded too. A limiter that only remembers what it allowed can be
  -- walked past by simply continuing to be refused until the window rolls.
  insert into private.signup_attempts (ip_hash, email_hash, outcome)
  values (p_ip_hash, p_email_hash,
          case when v_reason is null then 'accepted' else 'rate_limited' end);

  return jsonb_build_object('allowed', v_reason is null, 'reason', v_reason);
end
$$;
revoke all on function public.service_check_signup_rate(text, text)
  from public, anon, authenticated;
grant execute on function public.service_check_signup_rate(text, text) to service_role;

-- Signup can fail after the rate check has already recorded an acceptance -- a duplicate email, a
-- provisioning error. Recording the correction keeps the global counter honest about how many
-- organizations were actually created.
create or replace function public.service_mark_signup_rejected(p_email_hash text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  update private.signup_attempts
     set outcome = 'rejected'
   where id = (
     select id from private.signup_attempts
     where email_hash = p_email_hash and outcome = 'accepted'
     order by attempted_at desc limit 1);
end
$$;
revoke all on function public.service_mark_signup_rejected(text)
  from public, anon, authenticated;
grant execute on function public.service_mark_signup_rejected(text) to service_role;

-- ===== 3. The funnel's first stage =====
insert into private.product_event_definitions (event_name, label, description, emitted_by) values
  ('signup.completed', 'הרשמה עצמית הושלמה',
   'Recorded when an anonymous visitor caused an organization to be created. Carries no email and no address.',
   'public-signup edge function');

-- The service seam wave 6 promised: an Edge Function that has done its own verification records
-- an allowlisted event without holding a grant on the table.
create or replace function public.service_record_product_event(
  p_org_id          uuid,
  p_event_name      text,
  p_properties      jsonb,
  p_idempotency_key text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  return private.record_product_event(
    p_org_id, null, p_event_name, p_properties, p_idempotency_key);
end
$$;
revoke all on function public.service_record_product_event(uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.service_record_product_event(uuid, text, jsonb, text)
  to service_role;

-- ===== 4. Operator visibility =====
-- Signup pressure is an operational fact -- a spike is either growth or an attack, and both are
-- things somebody should see. Counts only: the table holds hashes, and even those do not leave.
create or replace function public.platform_signup_activity(p_hours integer default 24)
returns table (accepted bigint, rate_limited bigint, rejected bigint, window_hours integer)
language sql stable security definer set search_path = public as $$
  -- The guard filters the RESULT, not the input rows. An aggregate over zero rows still returns
  -- one row of zeros, so putting is_platform_admin() in the inner WHERE would hand an
  -- unauthorised caller "no signup activity" -- a statement about the platform -- instead of
  -- nothing at all. Same shape as every other operator read in this campaign.
  select summary.accepted, summary.rate_limited, summary.rejected, summary.window_hours
  from (
    select count(*) filter (where outcome = 'accepted')      as accepted,
           count(*) filter (where outcome = 'rate_limited')  as rate_limited,
           count(*) filter (where outcome = 'rejected')      as rejected,
           least(greatest(coalesce(p_hours, 24), 1), 720)    as window_hours
    from private.signup_attempts
    where attempted_at
          > now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 720))
  ) summary
  where is_platform_admin() and public.platform_has_capability('customer.view')
$$;
revoke all on function public.platform_signup_activity(integer) from public, anon;
grant execute on function public.platform_signup_activity(integer) to authenticated;

-- ===== 5. Structural re-assertion =====
do $assert_0159$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0159 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0159 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0159$;

-- ===== 6. Anchors =====
do $anchor_0159$
begin
  -- The attempt table must be able to hold a hash and nothing that reads back as an identity.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'private' and table_name = 'signup_attempts'
      and column_name in ('ip', 'ip_address', 'email', 'user_agent')
  ) then
    raise exception '0159: the signup attempt table grew a column that identifies a visitor';
  end if;

  -- Every signup door is service_role only. An anonymous caller reaching the limiter directly
  -- could exhaust the window for everybody else.
  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name in ('service_check_signup_rate', 'service_mark_signup_rejected',
                           'service_record_product_event')
      and grantee in ('anon', 'authenticated')
  ) then
    raise exception '0159: a browser role can execute a signup service function';
  end if;

  if not exists (
    select 1 from private.product_event_definitions where event_name = 'signup.completed'
  ) then
    raise exception '0159: the signup funnel stage has no event definition';
  end if;
end
$anchor_0159$;
