-- 0262 — one definition of the introduction window, and one server clock the client may read.
--
-- WHAT THIS IS FOR. A countdown strip has to say when a benefit ends, and there is no source of
-- server time in the client at all: every date the product renders today comes from `Date.now()`,
-- which is the user's machine and is trivially wrong. `my_benefit_window()` is the one call that
-- returns the boundary AND the instant the server believes it is, so a countdown can be anchored
-- to something other than a clock the reader controls.
--
-- ⚠ AND IT REPLACES A LIVE ENTITLEMENT FUNCTION. `public.effective_entitlement` feeds
-- `current_plan_capability` and every product quota. The `introduction` CTE inside it is the only
-- definition of "the thirty-day free introduction", and this migration MOVES it into
-- `private.free_intro_window()` so the countdown reads the same window the entitlement ladder
-- judges by. A slip in that extraction grants or revokes capability for every tenant, which is why
-- the verification below re-derives the CTE's exact predicate rather than trusting the move, and
-- why the suite proves entitlement parity plan × capability × window state rather than proving
-- that the new function returns something reasonable.
--
-- TWO DEFINITIONS OF ONE WINDOW ARE THE FAILURE MODE THIS PREVENTS. `0210:24-25` and `0212:22-23`
-- say it about the grant; it is the same rule here. So `my_benefit_window()` does not recompute
-- the prelaunch grant either — it reads `public.my_plan_grant()`, which already returns
-- `ends_at`, `has_paid` and `reverts_to_plan_key`.
--
-- THE BOUNDARY IS THE ONE THAT CHANGES ENTITLEMENT, NOT THE EARLIEST DATE. The `introduction` CTE
-- requires `subscription.plan_key = 'free'`, so an organisation on a granted premium plan has NO
-- active introduction window at all, and the expiry of an intro stamp takes nothing away from it.
-- Picking the earlier of two dates would have shown that organisation a downgrade that will not
-- happen. The rule implemented here is the precedence the entitlement function already runs: the
-- grant first, then the introduction, and null when neither is live.
--
-- NO DISPLAY STRINGS COME BACK. `subscription_plans.label` is Hebrew, and the product carries
-- `profiles.locale` since `0253`. A label from the server would put Hebrew on an English screen,
-- and `check:i18n` would not catch it — that guard is a ratchet on hard-coded Hebrew in the source
-- (`scripts/check-i18n.ts`), not a gate on strings arriving from the database. The client
-- translates `plan_key` from its own dictionary.
--
-- `search_path` ends with `pg_temp` on both new functions. Omitted, `pg_temp` is searched FIRST by
-- implication, which is the classic hijack surface in a definer function. (`my_plan_grant()` is
-- missing it — existing debt, recorded and deliberately not opened here, because changing the
-- search path of a live definer function is its own migration with its own proof.)

-- ===== 1. The introduction window, extracted verbatim =====
create or replace function private.free_intro_window(p_org_id uuid)
returns table (started_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  -- Character for character the predicate `effective_entitlement`'s `introduction` CTE ran: the
  -- stamp exists, the organisation is on `free`, the window has opened and has not closed. The
  -- CTE reached the subscription through a sibling CTE filtered by the org; here that filter is
  -- stated on the join, which is the same set and one fewer indirection.
  select window_row.started_at,
         window_row.started_at + interval '30 days' as ends_at
  from private.assistant_intro_windows window_row
  join public.organization_subscriptions subscription
    on subscription.org_id = window_row.org_id
  where subscription.org_id = p_org_id
    and subscription.plan_key = 'free'
    and window_row.started_at <= now()
    and now() < window_row.started_at + interval '30 days'
$$;

comment on function private.free_intro_window(uuid) is
  'The thirty-day free introduction window for one organisation, as one row or none. Extracted '
  'from effective_entitlement in 0262 so the entitlement ladder and the countdown read the same '
  'window; two definitions of one window are what 0210 and 0212 forbid. Returns nothing for an '
  'organisation that is not on the free plan, which is why an expiring intro stamp takes nothing '
  'away from a granted premium tenant.';

revoke all on function private.free_intro_window(uuid) from public;
revoke all on function private.free_intro_window(uuid) from anon;
revoke all on function private.free_intro_window(uuid) from authenticated;

-- ===== 2. effective_entitlement calls it instead of carrying it =====
do $patch_entitlement_0262$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
  v_count int;
begin
  if to_regprocedure('public.effective_entitlement(uuid, text)') is null then
    raise exception '0262: public.effective_entitlement is absent';
  end if;

  v_definition := replace(pg_get_functiondef(
    'public.effective_entitlement(uuid, text)'::regprocedure), e'\r', '');

  v_anchor := e'  introduction as (\n'
    || e'    select window_row.started_at,\n'
    || e'           window_row.started_at + interval ''30 days'' as ends_at\n'
    || e'    from private.assistant_intro_windows window_row\n'
    || e'    join subscription on subscription.org_id = window_row.org_id\n'
    || e'    where subscription.plan_key = ''free''\n'
    || e'      and window_row.started_at <= now()\n'
    || e'      and now() < window_row.started_at + interval ''30 days''\n'
    || e'  ),\n';
  v_replacement := e'  introduction as (\n'
    || e'    -- 0262: one definition, in private.free_intro_window. The countdown strip and this\n'
    || e'    -- ladder now judge by the same window; before, a screen showing "your introduction\n'
    || e'    -- ends on" would have been a second implementation of the same thirty days.\n'
    || e'    select intro_window.started_at, intro_window.ends_at\n'
    || e'    from private.free_intro_window(p_org_id) intro_window\n'
    || e'  ),\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0262: introduction CTE anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end
$patch_entitlement_0262$;

-- ===== 3. The one call the client makes =====
create or replace function public.my_benefit_window()
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  with grant_row as (
    -- NOT a parallel query on granted_until. `my_plan_grant()` is the definition of the grant,
    -- and it already carries the end, the revert target and whether anyone has ever paid.
    select public.my_plan_grant() as grant_json
  ),
  subscription as (
    select * from public.organization_subscriptions where org_id = auth_org()
  ),
  intro as (
    select * from private.free_intro_window(auth_org())
  ),
  -- The precedence `effective_entitlement` runs, and therefore the boundary after which the
  -- entitlement actually differs. A live grant puts the tenant on a plan that is not `free`, so
  -- it has no introduction window to lose; where there is no grant, the introduction is the only
  -- thing that ends.
  chosen as (
    select case
      when (select (grant_json ->> 'granted')::boolean from grant_row) then jsonb_build_object(
        'kind', 'prelaunch_grant',
        'starts_at', null,
        'ends_at', (select grant_json ->> 'ends_at' from grant_row),
        'plan_key', (select plan_key from subscription),
        'reverts_to_plan_key', (select grant_json ->> 'reverts_to_plan_key' from grant_row))
      when exists (select 1 from intro) then jsonb_build_object(
        'kind', 'free_intro',
        'starts_at', (select started_at from intro),
        'ends_at', (select ends_at from intro),
        -- What the ladder actually grants during the introduction, from its `effective_plan` CTE.
        'plan_key', 'basic',
        -- And what it falls back to, which the CTE's own predicate guarantees is `free`.
        'reverts_to_plan_key', (select plan_key from subscription))
      end as window_json
  )
  select jsonb_build_object(
    -- The point of the whole function. A countdown anchored to the reader's own clock is a
    -- countdown the reader can change.
    'server_now', now(),
    'has_paid', coalesce((select (grant_json ->> 'has_paid')::boolean from grant_row), false),
    -- No `intent_recorded` yet: the table that key reads is created in a later migration, and a
    -- forward dependency between two applications is a runtime failure in the window between them.
    'eligible', (select window_json from chosen) is not null
      and not coalesce((select (grant_json ->> 'has_paid')::boolean from grant_row), false),
    'window', (select window_json from chosen)
  )
$$;

comment on function public.my_benefit_window() is
  'The launch benefit as one object: the server''s own clock, whether anyone has ever paid, and '
  'the window that ends next — the grant if one is live, otherwise the free introduction, and '
  'null when neither is. Added in 0262. Carries plan KEYS and never a label: the client '
  'translates, because subscription_plans.label is Hebrew and profiles.locale exists since 0253. '
  'The grant is read from my_plan_grant() and the introduction from private.free_intro_window(), '
  'so neither is defined twice.';

revoke all on function public.my_benefit_window() from public;
revoke all on function public.my_benefit_window() from anon;
grant execute on function public.my_benefit_window() to authenticated;

-- ===== Proof =====
do $verify_0262$
declare
  v_body text;
  v_code text;
  v_violations text;
begin
  -- The CTE moved, and it moved to the function rather than to a copy.
  v_body := replace(pg_get_functiondef(
    'public.effective_entitlement(uuid, text)'::regprocedure), e'\r', '');
  if position('private.free_intro_window(p_org_id)' in v_body) = 0 then
    raise exception '0262: effective_entitlement does not call the extracted window';
  end if;
  if position('private.assistant_intro_windows' in v_body) > 0
     or position('interval ''30 days''' in v_body) > 0 then
    raise exception '0262: effective_entitlement still carries a second definition of the window';
  end if;

  -- NOTHING ELSE IN THE LADDER MOVED. The precedence, the intro's two entry points and the
  -- automatic-documents special case are each re-found rather than assumed: this function decides
  -- what every tenant may do.
  if position('when exists (select 1 from live_override) then ''override''' in v_body) = 0
     or position('then ''intro''' in v_body) = 0
     or position('when exists (select 1 from from_plan) then ''plan''' in v_body) = 0
     or position('else ''unavailable'' end' in v_body) = 0 then
    raise exception '0262: the entitlement precedence changed';
  end if;
  if position('p_entitlement_key = ''documents.automatic_monthly''' in v_body) = 0
     or position('intro_automatic_limit' in v_body) = 0 then
    raise exception '0262: the automatic-documents intro path was disturbed';
  end if;
  if position('then ''basic'' else subscription.plan_key end' in v_body) = 0 then
    raise exception '0262: the effective plan during the introduction changed';
  end if;

  -- The extracted window carries the predicate it was extracted from, including the one clause
  -- that makes the boundary rule correct: an organisation that is not on `free` has no window.
  v_body := replace(pg_get_functiondef(
    'private.free_intro_window(uuid)'::regprocedure), e'\r', '');
  if position('subscription.plan_key = ''free''' in v_body) = 0
     or position('window_row.started_at <= now()' in v_body) = 0
     or position('now() < window_row.started_at + interval ''30 days''' in v_body) = 0 then
    raise exception '0262: the extracted window is not the predicate it replaced';
  end if;

  -- The benefit window reads the grant rather than redefining it.
  v_body := replace(pg_get_functiondef(
    'public.my_benefit_window()'::regprocedure), e'\r', '');
  if position('public.my_plan_grant()' in v_body) = 0 then
    raise exception '0262: my_benefit_window does not read my_plan_grant';
  end if;
  if position('''server_now'', now()' in v_body) = 0 then
    raise exception '0262: my_benefit_window does not publish the server clock';
  end if;

  -- The two "must NOT appear" checks run against CODE, not against prose. A comment saying "not a
  -- parallel query on granted_until" trips the assertion that forbids one — which it did, on the
  -- first run of this migration. No string literal in this function contains a double dash, so
  -- removing line comments leaves the code intact.
  v_code := regexp_replace(v_body, '--[^' || chr(10) || ']*', '', 'g');
  if position('granted_until' in v_code) > 0 then
    raise exception '0262: my_benefit_window queries the grant a second way';
  end if;
  -- A label from the server would leak Hebrew onto an English screen, and no guard would catch it.
  if position('subscription_plans' in v_code) > 0 or position('label' in v_code) > 0 then
    raise exception '0262: my_benefit_window returns a display string';
  end if;

  -- Both new functions end their search path with pg_temp; without it pg_temp is searched first.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'free_intro_window'
      and array_to_string(p.proconfig, ',') like '%pg_temp%') then
    raise exception '0262: free_intro_window does not pin pg_temp';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'my_benefit_window'
      and array_to_string(p.proconfig, ',') like '%pg_temp%') then
    raise exception '0262: my_benefit_window does not pin pg_temp';
  end if;

  -- The private helper is reachable only by the definer functions that call it.
  if has_function_privilege('authenticated', 'private.free_intro_window(uuid)', 'execute')
     or has_function_privilege('anon', 'private.free_intro_window(uuid)', 'execute') then
    raise exception '0262: free_intro_window is executable by a client role';
  end if;
  if not has_function_privilege('authenticated', 'public.my_benefit_window()', 'execute') then
    raise exception '0262: my_benefit_window is not executable by authenticated';
  end if;
  if has_function_privilege('anon', 'public.my_benefit_window()', 'execute') then
    raise exception '0262: my_benefit_window is executable by anon';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0262 scope assertions failed:\n%', v_violations;
  end if;
end
$verify_0262$;
