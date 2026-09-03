-- 0310 — the lockout window actually rolls. Codex review round 3, finding 1.
--
-- WHAT WAS WRONG, and it is the third different way this one control has been wrong.
--
--   `0296` counted with a fixed window anchored to the FIRST failure. It reset on its own edge:
--   nine failures inside fifteen minutes, then one at 15:01 reset the count to one.
--   `0306` fixed that edge by measuring the run from the LAST failure — ten failures with no
--   fifteen-minute gap between them. That closed the burst, and opened a slower door: failures
--   at minute 0, 14, 28, 42 … never leave a fifteen-minute gap, so the tenth locks the account
--   **after more than two hours**, on an account nobody was attacking quickly. No fifteen-minute
--   window in that sequence holds more than two attempts.
--
-- And I claimed in `0306` that "ruling #347's numbers do not change; what changes is that they
-- now mean what they said". That was false. #347 says "עשרה כישלונות רצופים בתוך חמש-עשרה דקות"
-- and calls the window rolling in as many words. A consecutive-run rule with no gap is a
-- different rule, and it locks people the decision did not ask to lock.
--
-- WHAT REPLACES IT: the timestamps themselves. A rolling window cannot be computed from a counter
-- and one date — that is what both previous attempts were trying to do — so the failures inside
-- the window are stored, pruned on every write, and counted. Ten of them and the door shuts. The
-- array is capped at the threshold because nothing beyond it can change the answer: the question
-- is only ever "are there ten in the last fifteen minutes", and an attacker generating thousands
-- must not also generate an unbounded row.
--
-- `failed_count` stays, written from the pruned array, because it is what the diagnostics read.
-- It is now a projection of the timestamps rather than a second source of truth.

alter table private.password_attempt_counters
  add column if not exists failed_at timestamptz[] not null default '{}';

comment on column private.password_attempt_counters.failed_at is
  'When the failures inside the current window happened, most recent last, capped at the lockout '
  'threshold. A ROLLING window (owner ruling #347) cannot be derived from a counter and a single '
  'date: anchored to the first failure it resets on its own edge, and anchored to the last it '
  'never resets for an attacker who waits fourteen minutes between attempts. 0310.';

create or replace function public.password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'private', 'pg_temp'
as $function$
declare
  -- Ten failures inside a ROLLING fifteen minutes; fifteen minutes locked. Owner ruling #347.
  c_max_failures  constant integer  := 10;
  c_window        constant interval := interval '15 minutes';
  c_lockout       constant interval := interval '15 minutes';

  v_user   uuid;
  v_valid  boolean;
  v_row    private.password_attempt_counters;
  v_recent timestamptz[];
  v_count  integer;
begin
  v_user  := nullif(event ->> 'user_id', '')::uuid;
  v_valid := coalesce((event ->> 'valid')::boolean, false);

  -- A payload this function does not understand is not a reason to refuse a sign-in.
  if v_user is null then
    return jsonb_build_object('decision', 'continue');
  end if;

  -- EVERY path for this account is behind this line: a row lock cannot cover a row that does not
  -- exist, and it left the lockout check and the success branch outside itself.
  perform pg_advisory_xact_lock(hashtextextended('password_attempt:' || v_user::text, 0));

  select * into v_row
  from private.password_attempt_counters
  where user_id = v_user;

  -- Still locked out: refuse whatever the password was. An attacker who eventually guesses right
  -- must still wait, which is the difference between a lockout and a counter.
  if found and v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'יותר מדי ניסיונות כניסה. נסו שוב בעוד כמה דקות.');
  end if;

  if v_valid then
    if found then
      delete from private.password_attempt_counters where user_id = v_user;
    end if;
    return jsonb_build_object('decision', 'continue');
  end if;

  -- THE WINDOW, ROLLING: keep only the failures still inside it, add this one, and count. Capped
  -- at the threshold because nothing past it can change the answer, and an attacker generating
  -- thousands of attempts must not also generate an unbounded array.
  select array_agg(moment order by moment)
    into v_recent
  from (
    select moment
    from unnest(coalesce(v_row.failed_at, '{}'::timestamptz[])) as moment
    where moment > now() - c_window
    order by moment desc
    limit c_max_failures
  ) kept;
  v_recent := coalesce(v_recent, '{}'::timestamptz[]) || now();
  v_count := cardinality(v_recent);

  insert into private.password_attempt_counters (
    user_id, failed_count, window_started, last_failed_at, failed_at, locked_until)
  values (
    v_user, v_count, v_recent[1], now(), v_recent,
    case when v_count >= c_max_failures then now() + c_lockout end)
  on conflict (user_id) do update
    set failed_count   = excluded.failed_count,
        window_started = excluded.window_started,
        last_failed_at = excluded.last_failed_at,
        failed_at      = excluded.failed_at,
        locked_until   = excluded.locked_until;

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
  'GoTrue password-verification-attempt hook (0296, corrected by 0303, 0306 and 0310). Ten '
  'failures inside a ROLLING fifteen minutes lock the account for fifteen minutes (owner ruling '
  '#347); a success clears the run; a correct password does not open a locked door; any internal '
  'error returns `continue`. The whole decision sits behind one advisory lock on the account, and '
  'the window is computed from the stored failure timestamps -- a rolling window cannot be '
  'derived from a counter and one date, which is how the first two attempts at this both left a '
  'door open. Counts per account, not per caller.';

revoke all on function public.password_verification_attempt(jsonb) from public;
revoke all on function public.password_verification_attempt(jsonb) from authenticated, anon;
grant execute on function public.password_verification_attempt(jsonb) to supabase_auth_admin;

do $assert_0310$
declare
  v_violations text;
  v_source text := (select prosrc from pg_proc
                    where oid = 'public.password_verification_attempt(jsonb)'::regprocedure);
begin
  if position('pg_advisory_xact_lock' in v_source) = 0 then
    raise exception '0310: the decision is no longer behind a lock';
  end if;
  if position('failed_at' in v_source) = 0 then
    raise exception '0310: the window is not computed from the stored timestamps';
  end if;
  -- The two shapes the previous attempts anchored on must be gone as PREDICATES. A body that went
  -- back to either would restore a door this migration exists to close.
  if position('window_started < now()' in v_source) <> 0
     or position('last_failed_at < now()' in v_source) <> 0 then
    raise exception '0310: the window is anchored to a single date again';
  end if;
  if public.password_verification_attempt('{}'::jsonb) ->> 'decision' <> 'continue' then
    raise exception '0310: an unreadable payload refuses a sign-in';
  end if;
  if not has_function_privilege(
       'supabase_auth_admin', 'public.password_verification_attempt(jsonb)', 'execute') then
    raise exception '0310: GoTrue can no longer call the hook';
  end if;
  if has_function_privilege('authenticated', 'public.password_verification_attempt(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.password_verification_attempt(jsonb)', 'execute') then
    raise exception '0310: a browser role can forge its own lockout decision';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0310 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0310$;
