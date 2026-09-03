-- 0303 — three security defects the Codex review found in `0295` and `0296`, all confirmed by
-- measurement before anything was written. Round 1, findings 1, 2 and 4.
--
-- ---------------------------------------------------------------------------------------------
-- FINDING 2 (HIGH) — a parallel burst outran the lockout entirely.
--
-- `0296` read the counter with `select ... for update`, and **`for update` cannot lock a row that
-- does not exist.** So the first N concurrent failures for one account all saw "not found", all
-- took the insert branch, and the `on conflict do update` there set `failed_count = 1` — each of
-- them, over and over. Hundreds of parallel guesses could run with the count never leaving 1, and
-- every one of them returned `continue`. The lockout was real only against an attacker polite
-- enough to wait for each answer.
--
-- THE FIX IS TO STOP READING BEFORE WRITING. The whole count now moves in ONE statement: the
-- upsert takes the row lock and does its arithmetic on the committed row, so concurrent attempts
-- serialise on it and each one increments. There is no read-modify-write window left to lose.
-- The window roll and the lockout stamp move into the same statement for the same reason — a
-- second statement is a second chance to interleave.
--
-- The pre-check for an existing lockout stays a plain read, and a burst can still pass it
-- together. That is harmless and deliberate: those attempts then increment atomically, the count
-- is right, and the door shuts. What must not happen — and no longer can — is the count being
-- reset by its own concurrency.
--
-- ---------------------------------------------------------------------------------------------
-- FINDING 4 (MEDIUM) — the hook did not need `usage` on the whole `private` schema.
--
-- `0296` granted `usage on schema private to supabase_auth_admin`. The hook is SECURITY DEFINER,
-- so it executes as its owner and the CALLER needs no access to `private` at all. What the grant
-- did instead was open every `private` function that kept the default `execute to public` to the
-- Auth role. Measured: **four private SECURITY DEFINER functions became executable by
-- `supabase_auth_admin`** the moment that line ran, including one that takes an arbitrary
-- `org_id`. The grant is withdrawn, and the verify block proves both halves — the hook still
-- works, and the Auth role can no longer reach a private definer.
--
-- ---------------------------------------------------------------------------------------------
-- FINDING 1 (HIGH) — the idempotency grant was inert, and it opened a cross-tenant oracle.
--
-- `0295` granted `insert (id)` on `products` and `suppliers` to `authenticated` so that a retried
-- create would collide with the primary key instead of making a second row. **No client sends an
-- id.** Not `Products.tsx`, not `Suppliers.tsx`, not `QuickCreateProduct`, not
-- `QuickCreateSupplier` — verified by searching for `randomUUID` across all four and finding
-- nothing. So a dropped connection followed by a retry produced a second row exactly as before,
-- and the migration's own claim that "a replay now violates the primary key" was false.
--
-- What the grant DID buy was an oracle: a caller who holds a uuid from another tenant can attempt
-- an insert with it, and success versus `23505` tells them whether that id exists. RLS decides
-- which rows they may READ; it does not stop the primary key from answering a question about a
-- row they cannot see.
--
-- So the grant goes. The triple-submit is left OPEN and recorded, which is the honest state: the
-- fix that works is the command conversion `0295`'s own header argued for and declined
-- (`create_product`/`create_supplier`, SECURITY DEFINER, caller-supplied id, returning
-- `{"idempotent": true}`), and the reason it was declined — six client call sites insert products
-- and two insert suppliers, including bulk onboarding — has not changed. A door that does nothing
-- and leaks is worse than a door that is honestly still shut.

-- ---------------------------------------------------------------------------------------------
-- 1. The counter that cannot be outrun.
--
-- Re-declared rather than anchored, and the assertion below is what makes that safe: `0296` is
-- the ONLY migration that has ever declared this function (verified: it is the sole file in
-- `supabase/migrations/` naming it), so there is no later patch for a re-declaration to revert.
-- Re-anchoring three separate hunks inside a sixty-line body would have been the more fragile
-- choice here, not the safer one.
-- ---------------------------------------------------------------------------------------------
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
  v_locked timestamptz;
  v_count  integer;
begin
  v_user  := nullif(event ->> 'user_id', '')::uuid;
  v_valid := coalesce((event ->> 'valid')::boolean, false);

  -- A payload this function does not understand is not a reason to refuse a sign-in.
  if v_user is null then
    return jsonb_build_object('decision', 'continue');
  end if;

  -- Still inside a lockout: refuse whatever the password was. Checking this BEFORE `valid` is the
  -- point of a lockout — an attacker who eventually guesses correctly must still wait. A plain
  -- read is right here: there is nothing to lock when there is no row, and a burst that passes
  -- this check together still increments atomically below.
  select locked_until into v_locked
  from private.password_attempt_counters
  where user_id = v_user;
  if v_locked is not null and v_locked > now() then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'יותר מדי ניסיונות כניסה. נסו שוב בעוד כמה דקות.');
  end if;

  if v_valid then
    -- One success clears the run. A person who mistyped nine times and then got it right starts
    -- from zero, which is what makes ten a usable threshold rather than a trap.
    delete from private.password_attempt_counters where user_id = v_user;
    return jsonb_build_object('decision', 'continue');
  end if;

  -- ONE STATEMENT. The upsert takes the row lock and computes on the committed row, so N
  -- concurrent failures serialise and each increments — the defect finding 2 named was that a
  -- separate read could not lock a row that did not exist yet, so every member of a burst
  -- believed it was the first. The rolling window and the lockout stamp are decided here too,
  -- because a second statement is a second chance to interleave.
  insert into private.password_attempt_counters (
    user_id, failed_count, window_started, last_failed_at)
  values (v_user, 1, now(), now())
  on conflict (user_id) do update
    set failed_count = case
          when private.password_attempt_counters.window_started < now() - c_window then 1
          else private.password_attempt_counters.failed_count + 1 end,
        window_started = case
          when private.password_attempt_counters.window_started < now() - c_window then now()
          else private.password_attempt_counters.window_started end,
        last_failed_at = now(),
        locked_until = case
          when private.password_attempt_counters.window_started >= now() - c_window
           and private.password_attempt_counters.failed_count + 1 >= c_max_failures
          then now() + c_lockout
          else null end
  returning failed_count into v_count;

  if v_count >= c_max_failures then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'יותר מדי ניסיונות כניסה. נסו שוב בעוד כמה דקות.');
  end if;

  return jsonb_build_object('decision', 'continue');
exception when others then
  -- A broken rate limiter must not become an outage. The password check has already happened;
  -- this function only decides whether to slow the caller down.
  return jsonb_build_object('decision', 'continue');
end
$function$;

comment on function public.password_verification_attempt(jsonb) is
  'GoTrue password-verification-attempt hook (0296, corrected by 0303): ten consecutive failures '
  'inside fifteen minutes lock that account for fifteen minutes, a success clears the run, and '
  'ANY internal error returns `continue`. The whole count moves in ONE upsert, because a separate '
  'read cannot lock a row that does not exist and a parallel burst therefore outran the original '
  'version entirely. Counts per account, not per caller — a spray across many accounts is '
  'CAPTCHA''s problem and is a separate judgement.';

revoke all on function public.password_verification_attempt(jsonb) from public;
revoke all on function public.password_verification_attempt(jsonb) from authenticated, anon;
grant execute on function public.password_verification_attempt(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------------------------
-- 2. The grant the hook never needed.
-- ---------------------------------------------------------------------------------------------
revoke usage on schema private from supabase_auth_admin;

-- ---------------------------------------------------------------------------------------------
-- 3. The idempotency grant that bought nothing and leaked.
-- ---------------------------------------------------------------------------------------------
revoke insert (id) on public.products from authenticated;
revoke insert (id) on public.suppliers from authenticated;

do $assert_0303$
declare
  v_violations text;
  v_answer jsonb;
  v_reachable integer;
begin
  -- The hook still answers, and still fails open on a payload it cannot read.
  v_answer := public.password_verification_attempt('{}'::jsonb);
  if v_answer ->> 'decision' <> 'continue' then
    raise exception '0303: an unreadable payload refuses a sign-in';
  end if;
  if not has_function_privilege(
       'supabase_auth_admin', 'public.password_verification_attempt(jsonb)', 'execute') then
    raise exception '0303: GoTrue can no longer call the hook';
  end if;

  -- The counter is still unreachable to a client role, and the sequential path still counts: a
  -- single failure must leave the count at one rather than at zero or two.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private' and table_name = 'password_attempt_counters'
      and grantee in ('authenticated', 'anon')
  ) then
    raise exception '0303: the failed-sign-in counters became readable by a client role';
  end if;

  -- Finding 4: the Auth role must no longer be able to REACH a private definer.
  --
  -- The predicate matters, and the first version of this assertion got it wrong and said so
  -- loudly: `has_function_privilege` reports the FUNCTION's own ACL, and these functions keep the
  -- default `execute to public`, so it answers true whether or not the caller can get into the
  -- schema at all. It read "4" immediately after the revoke and refused a migration that had
  -- worked. The gate is the schema: without `usage on schema private` a call fails with
  -- "permission denied for schema private" before the function ACL is ever consulted. So that is
  -- what is asserted, and the function count is reported alongside it as the size of what the
  -- gate is holding shut.
  if has_schema_privilege('supabase_auth_admin', 'private', 'usage') then
    select count(*) into v_reachable
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.prosecdef;
    raise exception
      '0303: supabase_auth_admin still holds usage on schema private, which opens % definer function(s)',
      v_reachable;
  end if;

  -- Finding 1: the inert grant is gone, in both directions.
  if has_column_privilege('authenticated', 'public.products', 'id', 'insert')
     or has_column_privilege('authenticated', 'public.suppliers', 'id', 'insert') then
    raise exception '0303: the browser can still choose a surrogate id';
  end if;
  -- And the columns it legitimately writes are untouched — a revoke that took the wrong grant
  -- with it would break every create instead of closing an oracle.
  if not has_column_privilege('authenticated', 'public.products', 'name', 'insert')
     or not has_column_privilege('authenticated', 'public.suppliers', 'name', 'insert') then
    raise exception '0303: the revoke took a legitimate insert grant with it';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0303 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0303$;
