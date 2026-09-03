-- 0296 — a sign-in attempt that can be counted, and stopped. Wave 1, gate W0-G4.
--
-- WHAT W0-G4 MEASURED ON PRODUCTION, and it is worse than "the limit is too high": there is no
-- sign-in attempt limit in the configuration AT ALL. `rate_limit_verify`, `rate_limit_otp`,
-- `rate_limit_token_refresh` and `rate_limit_anonymous_users` all exist and not one of them
-- governs password sign-in. That is the 33-attempts-without-a-block finding, confirmed at its
-- source rather than inferred from a screen.
--
-- The supported mechanism is GoTrue's password-verification-attempt hook, and W0-G4 found it
-- `false` with its URI `null`. So it could not simply be switched on: enabling a hook with
-- nothing behind it does not weaken sign-in, it REFUSES every sign-in, because GoTrue calls a
-- hook that is not there. This migration is the thing that has to exist first.
--
-- WHY A POSTGRES FUNCTION AND NOT AN EDGE FUNCTION. GoTrue supports both. A Postgres hook runs
-- inside the database GoTrue is already talking to — no third holder of a service key, no network
-- hop on the sign-in path, and no separate deployment that can drift from this repository. The
-- counter it needs is one small table, and it belongs beside the identity it counts.
--
-- IT FAILS OPEN, DELIBERATELY, AND THIS IS THE ONE JUDGEMENT IN THE FILE.
-- Every sign-in in the product passes through this function. If it raises, GoTrue treats the
-- attempt as failed and nobody signs in — a bug in a RATE LIMITER would become a total outage.
-- A rate limiter is not the authentication; the password check has already happened when this is
-- called, and `event.valid` carries its answer. So any internal error returns `continue` and the
-- password check stands on its own. The failure mode of a broken counter is that brute force is
-- no longer slowed; the failure mode of the alternative is that the business cannot open.
--
-- THE NUMBERS ARE A DOCUMENTED DEFAULT, NOT A SILENT GUESS — owner ruling #347 in
-- `docs/OPEN-DECISIONS.md` records them and where to change them: ten consecutive failures inside
-- fifteen minutes locks that account for fifteen minutes, and one success clears the count. Ten
-- is above any realistic typo run and far below the 33 the QA round reached unblocked; the
-- window is rolling, so an attacker cannot spread attempts thinly and keep a stale count alive.
--
-- WHAT IT DOES NOT DO, stated so nobody reads more into it. It counts per ACCOUNT, not per IP:
-- GoTrue's hook payload names the user, not the caller, so this stops an account being ground
-- down and does not stop a spray across many accounts. CAPTCHA is the control for that, and the
-- plan calls CAPTCHA a separate judgement. It also says nothing about password strength — the
-- breach check and the length minimum are configuration, applied by `scripts/auth-hardening.mjs`.

create table if not exists private.password_attempt_counters (
  user_id         uuid        primary key references auth.users(id) on delete cascade,
  failed_count    integer     not null default 0,
  window_started  timestamptz not null default now(),
  last_failed_at  timestamptz,
  locked_until    timestamptz,
  constraint password_attempt_counters_failed_count_check check (failed_count >= 0)
);

comment on table private.password_attempt_counters is
  'One row per account with a live run of failed sign-ins (0296). In `private` and granted to '
  'nobody: the row says when somebody last failed to sign in as that account, which is a fact '
  'about a person and not a fact the product has any reason to publish. Cleared on success and '
  'cascade-deleted with the identity.';

revoke all on private.password_attempt_counters from public;

create or replace function public.password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'private', 'pg_temp'
as $function$
declare
  -- Ten failures inside fifteen minutes; fifteen minutes locked. Owner ruling #347.
  c_max_failures  constant integer  := 10;
  c_window        constant interval := interval '15 minutes';
  c_lockout       constant interval := interval '15 minutes';

  v_user   uuid;
  v_valid  boolean;
  v_row    private.password_attempt_counters;
  v_count  integer;
begin
  v_user  := nullif(event ->> 'user_id', '')::uuid;
  v_valid := coalesce((event ->> 'valid')::boolean, false);

  -- A payload this function does not understand is not a reason to refuse a sign-in.
  if v_user is null then
    return jsonb_build_object('decision', 'continue');
  end if;

  select * into v_row
  from private.password_attempt_counters
  where user_id = v_user
  for update;

  -- Still inside a lockout: refuse whatever the password was. Checking this BEFORE `valid` is the
  -- point of a lockout — an attacker who eventually guesses correctly must still wait.
  if found and v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'יותר מדי ניסיונות כניסה. נסו שוב בעוד כמה דקות.');
  end if;

  if v_valid then
    -- One success clears the run. A legitimate person who mistyped nine times and then got it
    -- right starts from zero, which is what makes ten a usable threshold rather than a trap.
    delete from private.password_attempt_counters where user_id = v_user;
    return jsonb_build_object('decision', 'continue');
  end if;

  -- A rolling window: a run that went quiet for longer than the window is a new run, so an
  -- attacker cannot keep a stale count alive by spreading attempts thinly, and a person who
  -- mistyped last week does not carry it forward.
  if not found or v_row.window_started < now() - c_window then
    insert into private.password_attempt_counters (user_id, failed_count, window_started, last_failed_at)
    values (v_user, 1, now(), now())
    on conflict (user_id) do update
      set failed_count = 1, window_started = now(), last_failed_at = now(), locked_until = null;
    return jsonb_build_object('decision', 'continue');
  end if;

  update private.password_attempt_counters
  set failed_count   = failed_count + 1,
      last_failed_at = now(),
      locked_until   = case when failed_count + 1 >= c_max_failures
                            then now() + c_lockout else null end
  where user_id = v_user
  returning failed_count into v_count;

  if v_count >= c_max_failures then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'יותר מדי ניסיונות כניסה. נסו שוב בעוד כמה דקות.');
  end if;

  return jsonb_build_object('decision', 'continue');
exception when others then
  -- See the header: a broken rate limiter must not become an outage. The password check has
  -- already happened; this function only decides whether to slow the caller down.
  return jsonb_build_object('decision', 'continue');
end
$function$;

comment on function public.password_verification_attempt(jsonb) is
  'GoTrue password-verification-attempt hook (0296): ten consecutive failures inside fifteen '
  'minutes lock that account for fifteen minutes, a success clears the run, and ANY internal '
  'error returns `continue` — a rate limiter that raises would refuse every sign-in in the '
  'product. Counts per account, not per caller, because the hook payload names the user; a spray '
  'across many accounts is CAPTCHA''s problem and is a separate judgement.';

-- Only GoTrue may call it, and only GoTrue may see the counters.
revoke all on function public.password_verification_attempt(jsonb) from public;
revoke all on function public.password_verification_attempt(jsonb) from authenticated, anon;
grant execute on function public.password_verification_attempt(jsonb) to supabase_auth_admin;
grant usage on schema private to supabase_auth_admin;

do $assert_0296$
declare
  v_violations text;
  v_answer jsonb;
begin
  if not has_function_privilege(
       'supabase_auth_admin', 'public.password_verification_attempt(jsonb)', 'execute') then
    raise exception '0296: GoTrue cannot call the hook, so enabling it would refuse every sign-in';
  end if;
  if has_function_privilege(
       'authenticated', 'public.password_verification_attempt(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.password_verification_attempt(jsonb)', 'execute') then
    raise exception '0296: a browser role can call the lockout hook and forge its own decision';
  end if;

  -- A malformed payload must not refuse a sign-in. This is the assertion that would have caught
  -- the whole class of "the hook raised and nobody could log in".
  v_answer := public.password_verification_attempt('{}'::jsonb);
  if v_answer ->> 'decision' <> 'continue' then
    raise exception '0296: an unreadable payload refuses a sign-in';
  end if;
  v_answer := public.password_verification_attempt('{"user_id":"not-a-uuid"}'::jsonb);
  if v_answer ->> 'decision' <> 'continue' then
    raise exception '0296: a malformed user id refuses a sign-in';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0296 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0296$;
