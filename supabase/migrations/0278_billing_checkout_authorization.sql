-- The server side of a self-serve purchase (owner ruling 31.08.2026, option ב) -- who may buy,
-- what they are allowed to buy, and the one write that makes every later webhook attributable.
--
-- THE SHAPE, AND WHY IT IS THIS SHAPE. A checkout has exactly three facts in it: which
-- organization, which price, which customer. All three are decided HERE, in the database, and none
-- of them is accepted from the browser:
--
--   * THE ORGANIZATION comes from auth_org() and the function takes no organization argument, so
--     there is nothing to aim. This is the p51/0189 idiom, and it is the reason a tampered request
--     cannot buy a plan for somebody else -- not because we validate the id it sent, but because it
--     never gets to send one.
--   * THE PRICE comes from private.billing_provider_price_map, which is the SAME table
--     private.billing_apply_subscription_state reads to decide what an activation GRANTS. One
--     table answering both halves is what makes "paid for Pro, received Pro" structural rather than
--     a pair of lookups that can drift. A browser naming a price id would be a browser naming its
--     own entitlement.
--   * THE CUSTOMER is whatever we have already written against the organization, or nothing yet.
--
-- AND THE GATE THAT MATTERS MOST: this refuses while the merchant of record is disabled.
--
-- That is not symmetry for its own sake. 0187 makes an unproven provider's events dead-letter with
-- `provider_not_enabled`, which is correct for an event that ARRIVES -- but if a checkout could
-- still be opened while the boundary was shut, a customer would pay Paddle and receive nothing,
-- and the dead letter proving it would be the only trace. Taking money and granting entitlement
-- must be governed by ONE switch, and this is that switch read from the other side. In production
-- today the boundary is disabled, so this function refuses every caller, and the Edge Function
-- above it can do nothing about that.

-- ===== 1. What a caller is allowed to buy =====
-- Purchasable rungs only. `free` is the state an organization is already in and `business` is a
-- conversation (#201) -- 0277 refuses to give either a provider price, so this is the same rule
-- read from the product's side rather than the catalogue's.
create or replace function public.authorize_billing_checkout(
  p_plan_key text, p_billing_interval text
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_org      uuid := auth_org();
  v_provider text;
  v_row      record;
  v_sub      organization_subscriptions;
begin
  -- No organization, no purchase. Deliberately the same refusal as a wrong role: a caller learns
  -- that it may not buy, never why, and never anything about another tenant.
  if v_org is null or auth_role() is distinct from 'owner' then
    return jsonb_build_object('allowed', false, 'reason_code', 'not_authorized');
  end if;

  -- One live merchant of record, read from the boundary rather than from configuration. While it
  -- is shut -- which is production today -- nobody can be charged.
  select boundary.provider into v_provider
  from private.billing_provider_boundary boundary
  where boundary.role = 'merchant_of_record' and boundary.enabled;
  if v_provider is null then
    return jsonb_build_object('allowed', false, 'reason_code', 'provider_not_enabled');
  end if;

  if p_billing_interval is null or p_billing_interval not in ('monthly', 'yearly') then
    return jsonb_build_object('allowed', false, 'reason_code', 'interval_unrecognized');
  end if;

  select subscription.* into v_sub
  from organization_subscriptions subscription where subscription.org_id = v_org;
  if not found then
    return jsonb_build_object('allowed', false, 'reason_code', 'subscription_row_absent');
  end if;

  -- The organization must be in a state that may transact at all. A suspended or offboarding
  -- tenant buying an upgrade would be the product contradicting itself.
  if (select organizations.status::text from organizations where organizations.id = v_org)
     is distinct from 'active' then
    return jsonb_build_object('allowed', false, 'reason_code', 'organization_not_active');
  end if;

  -- The price, from the one table that also decides what it grants.
  select map.provider_price_id, map.plan_key, map.billing_interval
    into v_row
  from private.billing_provider_price_map map
  where map.provider = v_provider
    and map.plan_key = p_plan_key
    and map.billing_interval = p_billing_interval;
  if not found then
    -- Covers a misspelled rung, `free`, `business`, and a rung nobody has priced at the provider.
    -- One reason code for all of them: a caller must not be able to enumerate the catalogue by
    -- reading the differences between refusals.
    return jsonb_build_object('allowed', false, 'reason_code', 'price_unmapped');
  end if;

  return jsonb_build_object(
    'allowed', true,
    'org_id', v_org,
    'provider', v_provider,
    'provider_price_id', v_row.provider_price_id,
    'plan_key', v_row.plan_key,
    'billing_interval', v_row.billing_interval,
    -- What we already hold. The Edge Function reuses a customer rather than creating a second one,
    -- and a subscription id is what a plan change or a cancellation is aimed at.
    'provider_customer_id', v_sub.provider_customer_id,
    'provider_subscription_id', v_sub.provider_subscription_id,
    'current_plan_key', v_sub.plan_key);
end
$$;
revoke all on function public.authorize_billing_checkout(text, text) from public, anon;
grant execute on function public.authorize_billing_checkout(text, text) to authenticated;

comment on function public.authorize_billing_checkout(text, text) is
  'Whether the CALLING user may buy the named rung, and the server-chosen price if so (0278). '
  'Takes no organization argument -- the organization is auth_org() and cannot be aimed. Refuses '
  'while no merchant of record is enabled, so taking money and granting entitlement are governed '
  'by the same switch.';

-- ===== 1b. Managing a subscription that already exists =====
-- Cancelling, changing rung and opening the provider's portal all need the same three facts and
-- none of them needs a price, so they share one authorization rather than borrowing the checkout's
-- and passing a rung nobody is buying.
--
-- SAME NO-ARGUMENT RULE. The organization is auth_org(); there is nothing to aim here either.
create or replace function public.authorize_billing_management()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_org      uuid := auth_org();
  v_provider text;
  v_sub      organization_subscriptions;
begin
  if v_org is null or auth_role() is distinct from 'owner' then
    return jsonb_build_object('allowed', false, 'reason_code', 'not_authorized');
  end if;

  select boundary.provider into v_provider
  from private.billing_provider_boundary boundary
  where boundary.role = 'merchant_of_record' and boundary.enabled;
  if v_provider is null then
    -- #204 and #219 grant cancellation unqualified, and this refusal does NOT take that away: the
    -- operator command with step-up and a reason is still there and is what a customer reaches
    -- through support. What is refused is a PROVIDER-SIDE call while there is no live provider to
    -- make it to -- which would fail anyway, just less honestly.
    return jsonb_build_object('allowed', false, 'reason_code', 'provider_not_enabled');
  end if;

  select subscription.* into v_sub
  from organization_subscriptions subscription where subscription.org_id = v_org;
  if not found then
    return jsonb_build_object('allowed', false, 'reason_code', 'subscription_row_absent');
  end if;
  if v_sub.provider_customer_id is null then
    -- Nothing was ever bought through a provider, so there is nothing of theirs to manage.
    return jsonb_build_object('allowed', false, 'reason_code', 'no_provider_customer');
  end if;

  return jsonb_build_object(
    'allowed', true,
    'org_id', v_org,
    'provider', v_provider,
    'provider_customer_id', v_sub.provider_customer_id,
    'provider_subscription_id', v_sub.provider_subscription_id,
    'current_plan_key', v_sub.plan_key,
    'current_billing_interval', v_sub.billing_interval);
end
$$;
revoke all on function public.authorize_billing_management() from public, anon;
grant execute on function public.authorize_billing_management() to authenticated;

comment on function public.authorize_billing_management() is
  'Whether the CALLING user may manage their organization''s existing provider subscription, and '
  'the provider ids if so (0278). No argument, so it cannot be aimed at another tenant. Refusing '
  'while the provider is shut does not withdraw the right to cancel (#204/#219) -- the operator '
  'command remains.';

-- ===== 2. The link every later webhook is attributed through =====
-- This is the write 0157 was built around: "resolved ONLY through
-- organization_subscriptions.provider_customer_id, which we wrote ourselves". This function is
-- the "we wrote ourselves". It runs as service_role from the checkout Edge Function, after that
-- function has created or re-found the customer at the provider.
create or replace function public.service_link_billing_customer(
  p_org_id uuid, p_provider text, p_provider_customer_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing text;
  v_holder   uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_provider_customer_id, '')), '') is null then
    raise exception 'provider_customer_id_required' using errcode = '22023';
  end if;

  select subscription.provider_customer_id into v_existing
  from organization_subscriptions subscription
  where subscription.org_id = p_org_id for update;
  if not found then
    raise exception 'subscription_row_absent' using errcode = 'P0002';
  end if;

  -- Already ours and identical: the normal case on a second checkout. Idempotent by design, so a
  -- customer who abandons a payment and comes back does not churn the link every event depends on.
  if v_existing = p_provider_customer_id then
    return jsonb_build_object('linked', true, 'changed', false, 'idempotent', true);
  end if;

  -- Already ours and DIFFERENT. Refuse rather than overwrite. Re-pointing an organization at a
  -- second provider customer would orphan every event still in flight for the first one -- they
  -- would arrive, fail to resolve, and dead-letter as unattributable, which looks exactly like an
  -- attack and is impossible to tell apart from one after the fact.
  if v_existing is not null then
    raise exception 'provider_customer_already_linked' using errcode = '23505';
  end if;

  -- Held by ANOTHER organization. The unique index would refuse this anyway; checking first turns
  -- a constraint violation into a named refusal, and it is worth naming because this is precisely
  -- the cross-tenant case: if org B could claim org A's provider customer, every one of A's
  -- future events would attribute to B.
  select subscription.org_id into v_holder
  from organization_subscriptions subscription
  where subscription.provider = p_provider
    and subscription.provider_customer_id = p_provider_customer_id;
  if v_holder is not null and v_holder <> p_org_id then
    raise exception 'provider_customer_claimed_by_another_org' using errcode = '23505';
  end if;

  update organization_subscriptions
     set provider = p_provider, provider_customer_id = p_provider_customer_id, updated_at = now()
   where org_id = p_org_id;

  -- Audited with a reason, like every sensitive write. user_id is null: no person performed this,
  -- a checkout the person STARTED caused it, and naming them as the actor would overstate it.
  insert into audit_logs (org_id, action, entity_type, entity_id, new_values, reason)
  values (p_org_id, 'billing_customer_linked', 'organization_subscriptions', p_org_id,
          jsonb_build_object('provider', p_provider),
          'a provider customer was created for this organization at checkout');

  return jsonb_build_object('linked', true, 'changed', true, 'idempotent', false);
end
$$;
revoke all on function public.service_link_billing_customer(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.service_link_billing_customer(uuid, text, text) to service_role;

comment on function public.service_link_billing_customer(uuid, text, text) is
  'Writes the provider-customer link that 0157 attributes every webhook through (0278). Idempotent '
  'on an identical value, refuses to re-point an organization at a second customer, and refuses a '
  'customer another organization already holds.';

-- ===== 3. Structural re-assertion =====
do $assert_0278$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0278 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0278 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0278$;

-- ===== 4. Anchors =====
do $anchor_0278$
begin
  -- TWO ARGUMENTS, AND NEITHER IS AN ORGANIZATION. The whole tenant safety of the checkout
  -- authorization is that it cannot be aimed; a third argument is the moment somebody adds one.
  if (select pronargs from pg_proc
      where oid = to_regprocedure('public.authorize_billing_checkout(text,text)')) <> 2 then
    raise exception '0278: authorize_billing_checkout changed shape -- it must not take an org id';
  end if;

  -- It must read the caller's own organization and nothing else.
  if not exists (
    select 1 from pg_proc where oid = to_regprocedure('public.authorize_billing_checkout(text,text)')
      and prosrc like '%auth_org()%'
  ) then
    raise exception '0278: authorize_billing_checkout does not resolve the caller''s organization';
  end if;

  -- The money gate. If this function stops consulting the boundary, a shut provider stops
  -- protecting anybody from being charged.
  if not exists (
    select 1 from pg_proc where oid = to_regprocedure('public.authorize_billing_checkout(text,text)')
      and prosrc like '%billing_provider_boundary%'
  ) then
    raise exception '0278: authorize_billing_checkout no longer refuses while the provider is shut';
  end if;

  -- The link writer is service_role only: a browser JWT must never write the attribution link,
  -- because writing it is choosing whose subscription a provider event will change.
  if has_function_privilege('anon', 'public.service_link_billing_customer(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.service_link_billing_customer(uuid,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.service_link_billing_customer(uuid,text,text)', 'EXECUTE')
  then
    raise exception '0278: the provider-customer link writer is not service_role only';
  end if;

  -- And the checkout authorization is NOT reachable by an anonymous caller.
  if has_function_privilege('anon', 'public.authorize_billing_checkout(text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.authorize_billing_management()', 'EXECUTE') then
    raise exception '0278: an anonymous caller can ask to be authorized for billing';
  end if;

  -- The management authorization is under the same no-argument rule, and for the same reason.
  if (select pronargs from pg_proc
      where oid = to_regprocedure('public.authorize_billing_management()')) <> 0 then
    raise exception '0278: authorize_billing_management grew a parameter';
  end if;
  if not exists (
    select 1 from pg_proc where oid = to_regprocedure('public.authorize_billing_management()')
      and prosrc like '%auth_org()%'
  ) then
    raise exception '0278: authorize_billing_management does not resolve the caller''s organization';
  end if;

  -- Neither function may write an entitlement. Only a verified provider event does that (#217),
  -- and a checkout that could set a plan would make the frontend callback a payment proof.
  if exists (
    select 1 from pg_proc
    where oid in (to_regprocedure('public.authorize_billing_checkout(text,text)'),
                  to_regprocedure('public.service_link_billing_customer(uuid,text,text)'))
      and prosrc ~ 'update\s+organization_subscriptions[^;]*\mplan_key\M'
  ) then
    raise exception '0278: a checkout function writes a plan -- entitlement follows a signed event only';
  end if;
end
$anchor_0278$;
