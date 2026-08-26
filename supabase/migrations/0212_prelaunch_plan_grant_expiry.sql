-- 0212: the pre-launch PLAN grant learns the clock every other grant in the same wave already has.
--
-- WHAT WAS WRONG, MEASURED RATHER THAN ASSUMED. 0210 hands out three things at once and only two of
-- them can end by themselves. The assistant switches carry `targeting.ends_at`, which
-- resolve_feature_flags evaluates: past the date the row still says `state = true` and resolves to
-- OFF. 0211's autonomy grants carry `expires_at`, and 0211 proves on a real row that an expired
-- grant resolves exactly like an organisation that was never configured. The PLAN grant --
-- 0210 section 2 creating every new organisation on `premium`, and section 4 promoting every
-- organisation still on the seeded `free`/`manual` pair -- carries nothing at all. The trigger
-- reads the clock, so an organisation created after the window is born on `free` again; but every
-- organisation created BEFORE it keeps `premium` for ever, with no row anywhere recording that a
-- grant was ever made or when it was supposed to stop.
--
-- WHY THAT IS NOT A COSMETIC GAP. A plan is not a feature switch. It decides the published quota
-- (#266), it decides what the customer's own screen calls them, and -- the moment billing opens --
-- it decides what they are asked to pay to keep. An unbounded grant of the top rung is a promise
-- nobody made, and taking it back later with no stamp to point at is indistinguishable from an
-- arbitrary downgrade. #274/#276 name the same duty from the customer's side: the end of a window
-- is a real reduction in service, and it must be stated BEFORE it happens, in the plan it reopens
-- on. A date nothing stores cannot be stated.
--
-- WHAT THIS FILE DOES NOT DO. It does not touch the window date, which stays 0210's single
-- `private.prelaunch_window_end()` -- a second literal is exactly how two halves of one grant come
-- to end on different days. It does not revert anything today: the window is open, so the sweeper
-- installed here has nothing to do until it closes. It does not open, close or price anything: no
-- entitlement is written, no billing period is opened, no provider is enabled. And it does not
-- decide the #274 capability ladder, which is `DECIDED / NOT_IMPLEMENTED` and stays that way here.

-- ===== 1. The grant becomes a row that says when it ends =====
-- On the subscription itself rather than in a side table, for 0211's reason: the expiry belongs
-- beside the thing it bounds, where a reader of the row cannot miss it. Nullable, and NULL keeps
-- meaning what every row already means -- an ordinary subscription with no end date, which is what
-- a purchased one is.
alter table organization_subscriptions
  add column if not exists granted_until timestamptz;

comment on column organization_subscriptions.granted_until is
  'When a plan the PLATFORM granted stops applying (0212). NULL is an ordinary subscription -- '
  'purchased, or set by an operator -- with no end date. A non-null value means this rung was given '
  'rather than bought, and private.expire_prelaunch_plan_grants() returns the organisation to free '
  'when the date passes. Never used to grant anything: it can only end one.';

-- ===== 2. A new organisation is born with the stamp =====
-- 0210's body restated in full rather than patched by anchor: 0210 is the only definition of this
-- function in the tree, and a partial replacement is how a security property gets dropped in
-- silence. Everything below is 0210's, character for character, with `granted_until` added to the
-- insert and the branch that already decided the plan now also deciding the end date. Security
-- properties are re-stated because what is written here is what production gets.
create or replace function private.organizations_default_subscription() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_end timestamptz := private.prelaunch_window_end();
  v_in_window boolean := clock_timestamp() < v_end;
begin
  insert into organization_subscriptions (org_id, plan_key, provider, granted_until)
  values (
    new.id,
    -- After the window this is `free` again with no further migration: the branch reads the clock,
    -- it does not read a row somebody has to remember to change.
    case when v_in_window then 'premium' else 'free' end,
    'manual',
    -- 0212: the granted rung carries its own end date. `free` is not a grant and gets none --
    -- stamping it would schedule a revert from free to free, which is a no-op that would still
    -- appear in the ledger as if something had been taken away.
    case when v_in_window then v_end end)
  on conflict (org_id) do nothing;
  return new;
end
$$;
revoke all on function private.organizations_default_subscription()
  from public, anon, authenticated;

comment on function private.organizations_default_subscription() is
  'The plan a new organisation is created on (0154, window branch 0210, expiry 0212). Inside the '
  'pre-launch window that is premium WITH an end date; outside it, free with none.';

-- ===== 3. The organisations 0210 already promoted =====
-- The predicate is narrow on purpose, and each clause answers a way this could stamp the wrong row.
--
--   * `provider = 'manual'` -- a subscription a provider owns is not ours to time-box.
--   * `granted_until is null` -- idempotent; a second run cannot move a date already written.
--   * ABOVE free on the ladder -- read from tier_order rather than a list of plan names, the same
--     derivation my_subscription() uses for `is_paid_plan`, so a rung added later needs no edit
--     here. `free` is not a grant.
--   * NO BILLING PERIOD HAS EVER BEEN OPENED. This is the clause that matters. A billing period is
--     written only by private.record_billing_period, which is reached from a verified provider
--     event or from an operator command carrying a reason -- so its absence is the honest, checkable
--     reading of "this organisation has never paid for anything". An organisation that HAS paid
--     keeps its plan untouched and unstamped, whatever 0210 did to the column beside it.
--
-- The premise 0210 recorded still holds and is what makes this safe: there are no paying tenants
-- yet. This clause is what keeps that from being an assumption the moment there is one.
update organization_subscriptions subscription
   set granted_until = private.prelaunch_window_end(), updated_at = now()
  from subscription_plans plan
 where plan.plan_key = subscription.plan_key
   and subscription.provider = 'manual'
   and subscription.granted_until is null
   and plan.tier_order > (select free_plan.tier_order from subscription_plans free_plan
                          where free_plan.plan_key = 'free')
   and not exists (select 1 from organization_billing_periods period
                   where period.org_id = subscription.org_id)
   and clock_timestamp() < private.prelaunch_window_end();

-- ===== 4. The sweeper that makes the date real =====
-- An end date nothing acts on is decoration, and decoration about what a customer is entitled to is
-- worse than nothing: it reads as a bound that exists. 0210's assistant grant could lean on a
-- resolver that already evaluated a clock; a plan has no such resolver -- `plan_key` is read
-- directly by my_subscription(), by effective_entitlement() and by every quota check -- so the
-- clock has to be applied by a writer.
--
-- THREE OUTCOMES, AND EACH IS A DIFFERENT FACT.
--   reverted -- the grant ran out and nothing replaced it. The organisation returns to free, and it
--              is audited WITH a reason, because a change to what a tenant is entitled to is a
--              sensitive action even when no person performed it. `user_id`/`actor` stay null on
--              purpose: naming an operator would be a lie in the audit trail.
--   cleared  -- the grant was superseded. A purchase happened, an operator moved the plan, or the
--              organisation is already on free. There is nothing to take away; the stamp is removed
--              so the sweeper never looks at this row again.
--   skipped  -- 0092's latch refuses writes to a tenant that is not in a writable access mode. The
--              stamp is LEFT IN PLACE so the next sweep retries. Silently swallowing the refusal
--              would hand a suspended organisation a permanent grant nobody made.
--
-- NOTHING IS DELETED and no counter moves. #242 anchors the usage period to signup, and a plan
-- change -- in either direction, by anybody -- never touches it.
create or replace function private.expire_prelaunch_plan_grants() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row      record;
  v_free     text := 'free';
  v_reverted integer := 0;
  v_cleared  integer := 0;
  v_skipped  integer := 0;
begin
  for v_row in
    select subscription.org_id, subscription.plan_key, subscription.provider,
           subscription.granted_until
      from organization_subscriptions subscription
     where subscription.granted_until is not null
       and subscription.granted_until <= now()
     order by subscription.org_id
  loop
    if v_row.provider <> 'manual'
       or v_row.plan_key = v_free
       or exists (select 1 from organization_billing_periods period
                  where period.org_id = v_row.org_id) then
      update organization_subscriptions
         set granted_until = null, updated_at = now()
       where org_id = v_row.org_id;
      v_cleared := v_cleared + 1;
      continue;
    end if;

    if private.organization_access_mode(v_row.org_id) not in ('active', 'trial', 'grace') then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    update organization_subscriptions
       set plan_key = v_free, granted_until = null, updated_at = now()
     where org_id = v_row.org_id;

    insert into audit_logs (org_id, action, entity_type, entity_id, new_values, reason)
    values (v_row.org_id, 'subscription_grant_expired', 'organization_subscriptions', v_row.org_id,
            jsonb_build_object('from_plan_key', v_row.plan_key, 'to_plan_key', v_free,
                               'granted_until', v_row.granted_until),
            'the pre-launch grant reached the end date it was written with; nothing was purchased, '
            'nothing was charged and no stored data was removed');

    perform private.record_platform_lifecycle_event(
      v_row.org_id, null, 'subscription_grant_expired', 'organization_subscriptions', v_row.org_id,
      jsonb_build_object('plan_key', v_row.plan_key, 'granted_until', v_row.granted_until),
      jsonb_build_object('plan_key', v_free),
      'pre-launch plan grant expired');

    v_reverted := v_reverted + 1;
  end loop;

  return jsonb_build_object('reverted', v_reverted, 'cleared', v_cleared, 'skipped', v_skipped);
end
$$;
revoke all on function private.expire_prelaunch_plan_grants()
  from public, anon, authenticated, service_role;

comment on function private.expire_prelaunch_plan_grants() is
  'Ends every pre-launch plan grant whose date has passed (0212). Reverts to free only when the '
  'grant is still the reason the organisation holds the rung; a purchased or operator-set plan is '
  'left alone and merely unstamped. Writes no usage period and resets no counter (#242).';

-- ===== 4b. A plan somebody else moved is no longer a grant =====
-- Without this the stamp outlives the thing it describes. `platform_set_org_subscription` (0154)
-- and every billing transition in 0187 write `plan_key` and never mention `granted_until` -- so an
-- operator who moves a granted organisation to `pro` for a stated reason leaves 0210's end date
-- sitting on the row, and the sweeper would take that operator's decision away at the window's end
-- as if it had been the grant. That is the same silent downgrade this whole file exists to prevent,
-- arriving through the other door.
--
-- The rule is deliberately about INTENT rather than about who is calling: a statement that changes
-- the plan and says nothing about the stamp has, by saying nothing, stopped describing a grant. The
-- sweeper sets both columns in one statement, so it is unaffected; so is any future writer that
-- means to move the end date.
--
-- SECURITY INVOKER, not definer, and that is not an oversight. It reads and writes only the row
-- already selected by the caller's own statement, needs no privilege the caller lacks, and staying
-- an invoker keeps it out of the A5 surface entirely rather than adding a definer that would have
-- to argue for itself.
create or replace function private.organization_subscription_grant_release() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.plan_key is distinct from old.plan_key
     and new.granted_until is not distinct from old.granted_until then
    new.granted_until := null;
  end if;
  return new;
end
$$;
revoke all on function private.organization_subscription_grant_release()
  from public, anon, authenticated;

comment on function private.organization_subscription_grant_release() is
  'Clears granted_until when a statement moves the plan without saying anything about the stamp '
  '(0212). A plan an operator or a provider event set is not a grant, and must not be swept.';

drop trigger if exists zzz_subscription_grant_release on public.organization_subscriptions;
create trigger zzz_subscription_grant_release
  before update on public.organization_subscriptions
  for each row execute function private.organization_subscription_grant_release();

-- ===== 5. The clock that calls it =====
-- cron.schedule(job_name, ...) is an upsert by name, so applying this file twice converges on one
-- job rather than two. 00:20 UTC: after midnight everywhere the window is stated in, and far from
-- the 04:00 payment scan of 0016 so two sweeps never contend for the same rows.
select cron.schedule(
  'supplyflow-prelaunch-plan-grant-expiry',
  '20 0 * * *',
  'select private.expire_prelaunch_plan_grants();'
);

-- ===== 6. What the tenant is allowed to know about its own grant =====
-- The same shape and the same information boundary as 0189's my_billing_availability(): no
-- argument, so it cannot be aimed at another tenant; one small object; and every key ALWAYS
-- PRESENT AND NEVER ABSENT, so a caller can never mistake a missing key for `false`.
--
-- `has_paid` is the key the screen actually needed and did not have. `is_paid_plan` answers "is
-- this rung above free", which stops being the same question the moment a rung is GIVEN: after
-- 0210 every organisation answers true to it while none of them has paid a shekel. A screen that
-- keys a billing period, a payment-failure notice or a cancel button off `is_paid_plan` alone
-- therefore shows a person who never bought anything the machinery of a customer who did. There is
-- no third state here on purpose -- a billing period either exists or it does not, and
-- private.record_billing_period is the only writer.
create or replace function public.my_plan_grant() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'granted', coalesce(subscription.granted_until > now()
                        and subscription.provider = 'manual', false),
    'ends_at', case when subscription.granted_until > now()
                     and subscription.provider = 'manual'
                    then subscription.granted_until end,
    'reverts_to_plan_key', 'free',
    'reverts_to_label', (select free_plan.label from subscription_plans free_plan
                         where free_plan.plan_key = 'free'),
    'has_paid', coalesce(exists (select 1 from organization_billing_periods period
                                 where period.org_id = subscription.org_id), false))
  from (select 1) probe
  left join organization_subscriptions subscription
    on subscription.org_id = auth_org() and auth_org() is not null
$$;
revoke all on function public.my_plan_grant() from public, anon;
grant execute on function public.my_plan_grant() to authenticated;

comment on function public.my_plan_grant() is
  'Whether the caller''s own plan was GRANTED rather than bought, until when, what it returns to, '
  'and whether this organisation has ever had a billing period opened (0212). Takes no argument, '
  'names no provider and carries no amount.';

-- ===== 7. The tenant export contract follows the column =====
-- 0103 hashes the shape of every exported tenant table so a column cannot join an export without
-- somebody having looked at it. This is that look: `granted_until` is an ordinary timestamp, it is
-- the customer's own record of a grant made to them, it belongs in their export beside the plan it
-- bounds, and it matches none of the secret-like patterns the registry refuses to export silently.
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
where registry.table_name = 'organization_subscriptions';

-- ===== 8. Proof, and the 0058 re-assertion duty =====
do $assert_0212$
declare
  v_violations text;
  v_end        timestamptz := private.prelaunch_window_end();
  v_unstamped  integer;
  v_probe_org  uuid;
  v_before     text;
  v_after      text;
begin
  -- A window already in the past would make sections 2 and 3 no-ops that read as a grant.
  if v_end <= clock_timestamp() then
    raise exception '0212: the pre-launch window ends at % which is not in the future', v_end;
  end if;

  -- Every organisation 0210 put above free without a purchase now carries an end date. This is the
  -- defect this file exists to close, asserted rather than described.
  select count(*) into v_unstamped
    from organization_subscriptions subscription
    join subscription_plans plan on plan.plan_key = subscription.plan_key
   where subscription.provider = 'manual'
     and subscription.granted_until is null
     and plan.tier_order > (select free_plan.tier_order from subscription_plans free_plan
                            where free_plan.plan_key = 'free')
     and not exists (select 1 from organization_billing_periods period
                     where period.org_id = subscription.org_id);
  if v_unstamped <> 0 then
    raise exception '0212: % granted subscription(s) still carry no end date', v_unstamped;
  end if;

  -- Nothing may have expired yet: the window is open, so the sweeper must be a no-op today. If this
  -- raises, either the date moved or a stamp was written in the past, and both are worth stopping
  -- for rather than discovering as a silent downgrade.
  if (private.expire_prelaunch_plan_grants() ->> 'reverted')::integer <> 0 then
    raise exception '0212: the sweeper reverted a grant while the window is still open';
  end if;

  -- THE EXPIRY IS NOT DECORATION, proven on a real row and then rolled back. The block below is a
  -- sub-transaction: the deliberate `0212_probe_rollback` at its end discards the probe's writes --
  -- the plan change, the audit row and the lifecycle row -- while any REAL failure inside it is
  -- re-raised and fails the migration. An organisation that is not in a writable access mode is
  -- skipped rather than forced, because the latch refusing a write is the correct behaviour and not
  -- something a probe may switch off.
  select subscription.org_id into v_probe_org
    from organization_subscriptions subscription
   where subscription.granted_until is not null
     and subscription.provider = 'manual'
     and private.organization_access_mode(subscription.org_id) in ('active', 'trial', 'grace')
   limit 1;

  if v_probe_org is not null then
    begin
      select plan_key into v_before from organization_subscriptions where org_id = v_probe_org;
      update organization_subscriptions
         set granted_until = now() - interval '1 second'
       where org_id = v_probe_org;
      perform private.expire_prelaunch_plan_grants();
      select plan_key into v_after from organization_subscriptions where org_id = v_probe_org;
      if v_after <> 'free' then
        raise exception '0212: an EXPIRED grant left the organisation on % instead of free', v_after;
      end if;
      if v_before = 'free' then
        raise exception '0212: the probe proved nothing -- the organisation was already on free';
      end if;
      raise exception '0212_probe_rollback';
    exception when others then
      if sqlerrm <> '0212_probe_rollback' then raise; end if;
    end;
  end if;

  -- 0058:207-218: a migration that adds a definer proves the scope contract still holds here,
  -- rather than three hours later in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0212 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0212 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0212$;
