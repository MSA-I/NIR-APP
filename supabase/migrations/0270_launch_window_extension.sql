-- 0270 — the launch window moves to 01.02.2027, and the three copies of the old date move with it.
--
-- OWNER RULING, 31.08.2026: one more month. `OPEN-DECISIONS #314`.
--
-- ⚠ THIS IS NOT "CHANGE A LITERAL". `private.prelaunch_window_end()` (`0210:26-29`) really is the
-- only place the date is READ from — but its value was COPIED INTO ROWS the moment the migrations
-- that call it ran. Redefining the function changes behaviour only for organisations created after
-- it, and moves not one existing customer.
--
--   `organization_subscriptions.granted_until`      — written by `0212:94`. Without a backfill,
--                                                     every existing customer's plan still expires
--                                                     on 01.01.
--   `org_flag_configurations.targeting->>'ends_at'` — written by `0210:128-131`, as a STRING inside
--                                                     JSONB. `assistant.ui` and `assistant.history`
--                                                     would switch off a month early.
--   `org_autonomy_policies.expires_at`              — written by `0211:224-225`, four policy keys.
--                                                     Document autonomy would expire a month early.
--
-- ⚠ AND THERE IS A FOURTH COPY THIS FILE CANNOT REACH. `AI_ASSISTANT_PRELAUNCH_EXCEPTION` is an
-- Edge Function environment variable — a production secret, outside the repository. No migration,
-- no gate and no PR can touch it. Rotating it to `until=2027-01-31` in the SAME rollout is a manual
-- step, and skipping it produces exactly the drift `0210:25` was written to prevent ("two copies of
-- a deadline are how the halves split apart"): the assistant exception would expire a month before
-- the subscription, and it would look like an assistant that stopped working for no reason.
--
-- EVERY UPDATE IS KEYED ON THE EXACT OLD VALUE, never on "anything expiring in 2027". A row an
-- operator set by hand to a different date is a DECISION, and a backfill that overwrites it is
-- precisely "putting an end date on a grant nobody asked to end" (`0211:222-223`). Each update also
-- carries forward the guards of the migration that wrote the column in the first place — most
-- importantly, an organisation that has ever opened a billing period is not touched at all.
--
-- AND EXTENDING ENTITLEMENT IS A FINANCIAL CHANGE, so every row moved is audited by tenant with a
-- reason that names the ruling and its date. "The migration did it" is not a reason in a ledger.
--
-- FORWARD-ONLY. There is no shortening back: cutting a window is reducing an entitlement that was
-- announced, which `#276` forbids. If the ruling reverses, that is a new ruling with notice — not a
-- rollback of this file.

-- ===== 1. The guard, before anything moves =====
do $guard_0270$
declare
  v_current timestamptz := private.prelaunch_window_end();
begin
  if v_current = '2027-02-01T00:00:00+00'::timestamptz then
    raise notice '0270: the window is already extended; the backfills below will match no rows';
  elsif v_current <> '2027-01-01T00:00:00+00'::timestamptz then
    -- Refusing is the point. If the window is somewhere this file did not expect, the backfills
    -- below would be keyed on a date that means nothing here, and they would move nothing while
    -- reporting success.
    raise exception '0270: the launch window is at %, not the 2027-01-01 this migration extends',
      v_current;
  end if;
end
$guard_0270$;

-- ===== 2. The one literal moves. It stays the only one. =====
create or replace function private.prelaunch_window_end()
returns timestamptz
language sql
immutable
set search_path = public, pg_temp
as $$
  select '2027-02-01T00:00:00+00'::timestamptz
$$;

comment on function private.prelaunch_window_end() is
  'When the pre-launch window ends. Extended from 2027-01-01 to 2027-02-01 by 0270 (owner ruling '
  '31.08.2026, OPEN-DECISIONS #314). The ONLY literal: everything else reads this function, and '
  'the three tables that copied its old value into rows were backfilled in the same migration. '
  'The fourth copy, AI_ASSISTANT_PRELAUNCH_EXCEPTION, is an Edge secret rotated by hand.';

-- ===== 3. The three backfills =====
do $backfill_0270$
declare
  -- The historical value, named once. It cannot be read from the function any more — that is the
  -- point of the guard above, which proved it was there a moment ago.
  v_old constant timestamptz := '2027-01-01T00:00:00+00'::timestamptz;
  v_old_text constant text := '2027-01-01T00:00:00+00';
  v_new constant timestamptz := private.prelaunch_window_end();
  v_new_text constant text :=
    to_char(private.prelaunch_window_end() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00"');
  v_reason constant text :=
    'the pre-launch window was extended by one month, from 2027-01-01 to 2027-02-01, by owner '
    'ruling of 31.08.2026 (OPEN-DECISIONS #314). This row carried a copy of the old date and was '
    'moved with it; no entitlement was reduced and nothing was charged.';
  v_subs int;
  v_flags int;
  v_policies int;
begin
  -- ---- 3a. The subscription grant ------------------------------------------------------------
  -- `0212`'s own guards, carried forward: a manual provider, and NO billing period ever opened.
  -- An organisation that has paid keeps whatever it has, untouched.
  with moved as (
    update public.organization_subscriptions subscription
       set granted_until = v_new, updated_at = now()
     where subscription.provider = 'manual'
       and subscription.granted_until = v_old
       and not exists (
         select 1 from public.organization_billing_periods period
          where period.org_id = subscription.org_id)
    returning subscription.org_id
  )
  insert into audit_logs (org_id, action, entity_type, entity_id, old_values, new_values, reason)
  select moved.org_id, 'prelaunch_window_extended', 'organization_subscriptions', moved.org_id,
         jsonb_build_object('granted_until', v_old),
         jsonb_build_object('granted_until', v_new),
         v_reason
  from moved;
  get diagnostics v_subs = row_count;

  -- ---- 3b. The assistant exposure flags -------------------------------------------------------
  -- A STRING inside JSONB, so it is compared and written as the same string `0210` built. Only the
  -- two keys that migration wrote; a targeting row somebody aimed by hand is not this file's.
  with moved as (
    update public.org_flag_configurations configuration
       set targeting = jsonb_set(configuration.targeting, '{ends_at}', to_jsonb(v_new_text)),
           updated_at = now()
     where configuration.flag_key in ('assistant.ui', 'assistant.history')
       and configuration.targeting ->> 'ends_at' = v_old_text
    returning configuration.org_id, configuration.flag_key
  )
  insert into audit_logs (org_id, action, entity_type, entity_id, old_values, new_values, reason)
  select moved.org_id, 'prelaunch_window_extended', 'org_flag_configurations', moved.org_id,
         jsonb_build_object('flag_key', moved.flag_key, 'ends_at', v_old_text),
         jsonb_build_object('flag_key', moved.flag_key, 'ends_at', v_new_text),
         v_reason
  from moved;
  get diagnostics v_flags = row_count;

  -- ---- 3c. The document-autonomy policies -----------------------------------------------------
  -- The four keys `0211` wrote, and only rows carrying the old expiry. The demo organisation's
  -- pre-existing rows carry no expiry at all and are therefore untouched, which is the same
  -- protection `0211:222-223` wrote for itself.
  with moved as (
    update public.org_autonomy_policies policy
       set expires_at = v_new, updated_at = now()
     where policy.policy_key in (
             'document.interpretation', 'delivery_note.receiving',
             'price_list.intake', 'document.packet_split')
       and policy.expires_at = v_old
    returning policy.org_id, policy.policy_key
  )
  insert into audit_logs (org_id, action, entity_type, entity_id, old_values, new_values, reason)
  select moved.org_id, 'prelaunch_window_extended', 'org_autonomy_policies', moved.org_id,
         jsonb_build_object('policy_key', moved.policy_key, 'expires_at', v_old),
         jsonb_build_object('policy_key', moved.policy_key, 'expires_at', v_new),
         v_reason
  from moved;
  get diagnostics v_policies = row_count;

  raise notice '0270: moved % subscription(s), % flag row(s), % autonomy policy row(s)',
    v_subs, v_flags, v_policies;
end
$backfill_0270$;

-- ===== Proof =====
do $verify_0270$
declare
  v_violations text;
  v_stragglers int;
begin
  if private.prelaunch_window_end() <> '2027-02-01T00:00:00+00'::timestamptz then
    raise exception '0270: the window did not move';
  end if;

  -- THE ONLY LITERAL. A second copy of the date in a function body is how the two halves split.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname <> 'prelaunch_window_end'
      and replace(p.prosrc, chr(13), '') like '%2027-01-01T00:00:00%') then
    raise exception '0270: another routine carries a copy of the old window';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname <> 'prelaunch_window_end'
      and replace(p.prosrc, chr(13), '') like '%2027-02-01T00:00:00%') then
    raise exception '0270: another routine carries a copy of the new window';
  end if;

  -- NOTHING CARRYING THE OLD DATE IS LEFT BEHIND in the three places this file owns.
  select
    (select count(*) from public.organization_subscriptions
      where provider = 'manual' and granted_until = '2027-01-01T00:00:00+00'::timestamptz
        and not exists (select 1 from public.organization_billing_periods period
                         where period.org_id = organization_subscriptions.org_id))
  + (select count(*) from public.org_flag_configurations
      where flag_key in ('assistant.ui', 'assistant.history')
        and targeting ->> 'ends_at' = '2027-01-01T00:00:00+00')
  + (select count(*) from public.org_autonomy_policies
      where policy_key in ('document.interpretation', 'delivery_note.receiving',
                           'price_list.intake', 'document.packet_split')
        and expires_at = '2027-01-01T00:00:00+00'::timestamptz)
  into v_stragglers;
  if v_stragglers <> 0 then
    raise exception '0270: % row(s) still carry the old window', v_stragglers;
  end if;

  -- The JSONB survived being edited. `jsonb_set` on a missing path is a silent no-op, so this
  -- asserts the shape rather than assuming it.
  if exists (
    select 1 from public.org_flag_configurations
    where flag_key in ('assistant.ui', 'assistant.history')
      and targeting is not null
      and (jsonb_typeof(targeting) <> 'object' or targeting ->> 'ends_at' is null)) then
    raise exception '0270: a targeting row lost its shape or its end date';
  end if;

  -- Every moved row is in the ledger with a reason. An extension is a financial change.
  if exists (
    select 1 from audit_logs
    where action = 'prelaunch_window_extended'
      and (reason is null or length(trim(reason)) = 0 or position('#314' in reason) = 0)) then
    raise exception '0270: a window extension was logged without the ruling behind it';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0270 scope assertions failed:\n%', v_violations;
  end if;
end
$verify_0270$;
