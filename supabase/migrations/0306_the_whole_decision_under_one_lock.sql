-- 0306 — the lockout decision moves entirely under one lock, and the window stops being a
-- window. Codex review round 2, findings 1 and 2 — both of them defects in round 1's own fix.
--
-- ---------------------------------------------------------------------------------------------
-- FINDING 1 (HIGH) — the pre-check was NOT harmless, and I said it was.
--
-- `0303` claimed a burst passing the lockout pre-check together was "harmless and deliberate:
-- those attempts then increment atomically, the count is right, and the door shuts". That is
-- true only when every attempt in the burst is a failure. The sequence the reviewer found:
--
--   the account sits at nine failures. A wrong-password request and a CORRECT-password request
--   arrive together. Both read `locked_until = null`. The wrong one increments to ten and stamps
--   the lockout. The correct one — which had already passed the pre-check — reaches the `valid`
--   branch, DELETES the row, and returns `continue`.
--
-- So a correct password inside the burst that crossed the threshold still gets in, and takes the
-- lockout with it. An attacker who is guessing in parallel is exactly the caller who benefits.
--
-- ---------------------------------------------------------------------------------------------
-- FINDING 2 (HIGH) — the window was fixed, not rolling, and I called it rolling in two comments.
--
--   one failure at 00:00, eight more at 00:14:59 — the count is nine.
--   at 00:15:01 the next failure finds `window_started` older than the window and resets to ONE.
--   eight more immediately after reach nine again.
--
-- Seventeen failures inside a few seconds, no lockout. A fixed window resets on its own edge, and
-- an attacker only has to wait for the edge.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT REPLACES BOTH, and it is smaller than either patch.
--
-- **One advisory lock, taken before anything is read.** `pg_advisory_xact_lock` needs no row to
-- exist, so it covers the case a row lock could not: every attempt for one account serialises,
-- and the lockout check, the success branch and the increment all read state nobody can change
-- underneath them. It is released when GoTrue's transaction ends, which is the end of the hook
-- call. One uncontended lock per sign-in attempt is not a cost worth optimising against a
-- credential-stuffing burst.
--
-- **And the run is measured from the LAST failure, not from the first.** Ten failures with no
-- fifteen-minute gap between them lock the account. There is no edge to wait for: the run
-- continues as long as the attempts do, and it clears when somebody actually stops for fifteen
-- minutes — which is what a lockout is for. Owner ruling #347's numbers do not change; what
-- changes is that they now mean what they said.
--
-- The claim in `0303`'s comment that a burst is harmless is withdrawn, and so is the word
-- "rolling". Both are replaced by what the code does.
--
-- Re-declared rather than anchored, for the reason `0303` gave and re-verified here: `0296` and
-- `0303` are the only migrations that have ever declared this function, so there is no later
-- patch for a re-declaration to revert.

create or replace function public.password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'private', 'pg_temp'
as $function$
declare
  -- Ten failures with no fifteen-minute gap between them; fifteen minutes locked. Ruling #347.
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

  -- EVERY path for this account is behind this line. A row lock could not do it: `for update`
  -- cannot lock a row that does not exist, and even once one does, the lockout check and the
  -- success branch ran outside it. An advisory lock needs no row and covers the whole decision.
  perform pg_advisory_xact_lock(hashtextextended('password_attempt:' || v_user::text, 0));

  select * into v_row
  from private.password_attempt_counters
  where user_id = v_user;

  -- Still locked out: refuse whatever the password was. Checking this before `valid` is the point
  -- of a lockout — an attacker who eventually guesses right must still wait — and it is only true
  -- now that the check and the success branch cannot be separated by another attempt.
  if found and v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'יותר מדי ניסיונות כניסה. נסו שוב בעוד כמה דקות.');
  end if;

  if v_valid then
    -- One success clears the run. A person who mistyped nine times and then got it right starts
    -- from zero, which is what makes ten a usable threshold rather than a trap.
    if found then
      delete from private.password_attempt_counters where user_id = v_user;
    end if;
    return jsonb_build_object('decision', 'continue');
  end if;

  if not found then
    insert into private.password_attempt_counters (
      user_id, failed_count, window_started, last_failed_at)
    values (v_user, 1, now(), now())
    returning failed_count into v_count;
  elsif v_row.last_failed_at is null or v_row.last_failed_at < now() - c_window then
    -- The run went quiet for longer than the window, so this is a new run. Measured from the LAST
    -- failure and not from the first: a window anchored to the first attempt resets on its own
    -- edge, and seventeen failures either side of that edge used to pass unblocked.
    update private.password_attempt_counters
    set failed_count = 1, window_started = now(), last_failed_at = now(), locked_until = null
    where user_id = v_user
    returning failed_count into v_count;
  else
    update private.password_attempt_counters
    set failed_count   = failed_count + 1,
        last_failed_at = now(),
        locked_until   = case when failed_count + 1 >= c_max_failures
                              then now() + c_lockout else null end
    where user_id = v_user
    returning failed_count into v_count;
  end if;

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
  'GoTrue password-verification-attempt hook (0296, corrected by 0303 and 0306). Ten failures '
  'with NO FIFTEEN-MINUTE GAP between them lock the account for fifteen minutes; a success clears '
  'the run; a correct password does not open a locked door; any internal error returns '
  '`continue`. The whole decision sits behind one advisory lock on the account, because a row '
  'lock cannot cover a row that does not exist yet and left the lockout check and the success '
  'branch outside it — a correct password arriving alongside the failure that crossed the '
  'threshold used to get in AND clear the lockout. The run is measured from the LAST failure, not '
  'the first, so there is no window edge to wait for. Counts per account, not per caller.';

revoke all on function public.password_verification_attempt(jsonb) from public;
revoke all on function public.password_verification_attempt(jsonb) from authenticated, anon;
grant execute on function public.password_verification_attempt(jsonb) to supabase_auth_admin;

do $assert_0306$
declare
  v_violations text;
  v_source text := (select prosrc from pg_proc
                    where oid = 'public.password_verification_attempt(jsonb)'::regprocedure);
begin
  if position('pg_advisory_xact_lock' in v_source) = 0 then
    raise exception '0306: the decision is not behind a lock';
  end if;
  -- The run must be measured from the last failure. A body that went back to anchoring on
  -- `window_started` would restore the edge an attacker waits for.
  if position('last_failed_at < now() - c_window' in v_source) = 0 then
    raise exception '0306: the run is not measured from the last failure';
  end if;
  if public.password_verification_attempt('{}'::jsonb) ->> 'decision' <> 'continue' then
    raise exception '0306: an unreadable payload refuses a sign-in';
  end if;
  if not has_function_privilege(
       'supabase_auth_admin', 'public.password_verification_attempt(jsonb)', 'execute') then
    raise exception '0306: GoTrue can no longer call the hook';
  end if;
  if has_function_privilege('authenticated', 'public.password_verification_attempt(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.password_verification_attempt(jsonb)', 'execute') then
    raise exception '0306: a browser role can forge its own lockout decision';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0306 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0306$;
