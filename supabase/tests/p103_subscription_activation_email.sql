-- p103 -- the activation email is owed exactly once, and a settlement cannot be replayed into two.
--
-- WHAT THIS PROVES, and why each case is here rather than trusted:
--   1. A verified activation records a debt, and the address comes from the OWNER we resolved
--      server-side -- never from the provider payload.
--   2. A SECOND activation for the same organization records nothing. This is the whole point:
--      Paddle retries a delivery up to sixty times over three days and re-sends `activated` after
--      a resume, while Resend's Idempotency-Key expires in twenty-four hours. Only the database
--      can carry "exactly once" across that window.
--   3. A claim leases the row, so a concurrent second sender gets nothing.
--   4. Settling twice is a no-op, not a second send.
--   5. An activation AFTER the mail was sent still records nothing -- once means once, forever.
--   6. An organization with no active owner records no debt and does not break the entitlement
--      write, because a missing address is a support problem and not a reason to refuse a plan
--      somebody paid for.
--
-- Runs entirely inside one transaction and rolls back: it seeds an organization, a plan, a price
-- mapping and a billing event of its own, and leaves nothing behind.

begin;

do $suite$
declare
  v_org        uuid := '9c000000-0000-4000-8000-000000000094';
  v_org_noown  uuid := '9c000000-0000-4000-8000-000000000095';
  v_user       uuid := '9c000000-0000-4000-8000-0000000000a4';
  v_event      uuid;
  v_event_two  uuid;
  v_data       jsonb;
  v_verdict    jsonb;
  v_claim      jsonb;
  v_settle     jsonb;
  v_count      int;
  v_row        private.subscription_activation_emails;
begin
  -- ===== Fixture =====
  insert into organizations (id, name) values
    (v_org, 'p103 activation tenant'), (v_org_noown, 'p103 ownerless tenant');

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'p103-owner@tenant.example', 'x', now(), now(), now());
  insert into profiles (id, org_id, full_name, role, active)
  values (v_user, v_org, 'p103 owner', 'owner', true);

  insert into subscription_plans (plan_key, label, tier_order)
  values ('p103_plan', 'p103 plan', 900)
  on conflict (plan_key) do nothing;

  insert into private.billing_provider_price_map (provider, provider_price_id, plan_key)
  values ('paddle', 'pri_p103', 'p103_plan');

  insert into organization_subscriptions (org_id, plan_key) values
    (v_org, 'free'), (v_org_noown, 'free')
  on conflict (org_id) do update set plan_key = excluded.plan_key;

  insert into private.billing_events (provider, provider_event_id, event_type, status, payload, org_id)
  values ('paddle', 'evt_p103_one', 'subscription.activated', 'stored', '{}'::jsonb, v_org)
  returning id into v_event;
  insert into private.billing_events (provider, provider_event_id, event_type, status, payload, org_id)
  values ('paddle', 'evt_p103_two', 'subscription.activated', 'stored', '{}'::jsonb, v_org)
  returning id into v_event_two;

  -- The provider's subscription entity, shaped as 0187 reads it.
  v_data := jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('price', jsonb_build_object('id', 'pri_p103'))),
    'billing_cycle', jsonb_build_object('interval', 'month'),
    'current_billing_period', jsonb_build_object(
      'starts_at', '2026-08-01T00:00:00Z', 'ends_at', '2026-09-01T00:00:00Z'),
    -- A payload that TRIES to choose the recipient. It must change nothing: the address below is
    -- the owner's, resolved from our own tables.
    'customer', jsonb_build_object('email', 'attacker@evil.example'));

  -- ===== 1. A verified activation records one debt, addressed to the owner =====
  v_verdict := private.billing_apply_subscription_state(v_org, v_data, v_event, 'paddle', true);
  if not (v_verdict ->> 'ok')::boolean then
    raise exception 'p103.1: the activation transition refused: %', v_verdict ->> 'detail';
  end if;

  select * into v_row from private.subscription_activation_emails where org_id = v_org;
  if not found then raise exception 'p103.1: no activation email was recorded'; end if;
  if v_row.to_email <> 'p103-owner@tenant.example' then
    raise exception 'p103.1: the recipient is %, not the owner resolved server-side', v_row.to_email;
  end if;
  if v_row.status <> 'pending' or v_row.attempt_count <> 0 then
    raise exception 'p103.1: a fresh debt must be pending with no attempts, got %/%',
      v_row.status, v_row.attempt_count;
  end if;
  if v_row.plan_key <> 'p103_plan' then
    raise exception 'p103.1: the plan came from somewhere other than the price map: %', v_row.plan_key;
  end if;

  -- ===== 2. A second activation records NOTHING =====
  v_verdict := private.billing_apply_subscription_state(v_org, v_data, v_event_two, 'paddle', true);
  if not (v_verdict ->> 'ok')::boolean then
    raise exception 'p103.2: the second activation refused: %', v_verdict ->> 'detail';
  end if;
  select count(*) into v_count from private.subscription_activation_emails where org_id = v_org;
  if v_count <> 1 then
    raise exception 'p103.2: a redelivered activation produced % rows; exactly one is the contract',
      v_count;
  end if;
  select * into v_row from private.subscription_activation_emails where org_id = v_org;
  if v_row.billing_event_id <> v_event then
    raise exception 'p103.2: the second activation overwrote the first event reference';
  end if;

  -- ===== 3. A claim leases the row; a concurrent second claim finds nothing =====
  v_claim := service_claim_subscription_activation_email();
  if v_claim ->> 'state' <> 'claimed' then
    raise exception 'p103.3: the pending debt was not claimable, got %', v_claim ->> 'state';
  end if;
  if v_claim ->> 'to_email' <> 'p103-owner@tenant.example' then
    raise exception 'p103.3: the claim handed over the wrong address';
  end if;
  if v_claim ->> 'plan_label' <> 'p103 plan' then
    raise exception 'p103.3: the claim did not resolve the current plan label, got %',
      v_claim ->> 'plan_label';
  end if;
  if v_claim ->> 'locale' is null then
    raise exception 'p103.3: the claim resolved no locale, so the email has no language';
  end if;
  v_claim := service_claim_subscription_activation_email();
  if v_claim ->> 'state' <> 'idle' then
    raise exception 'p103.3: a leased row was claimed a second time (state %)', v_claim ->> 'state';
  end if;

  -- ===== 4. Settling twice is a no-op, not a second send =====
  v_settle := service_settle_subscription_activation_email(v_org, 'sent', 'resend_p103', null);
  if v_settle ->> 'state' <> 'sent' then
    raise exception 'p103.4: the settlement did not record a send';
  end if;
  v_settle := service_settle_subscription_activation_email(v_org, 'sent', 'resend_p103_again', null);
  if v_settle ->> 'state' <> 'already_sent' then
    raise exception 'p103.4: a replayed settlement was not idempotent, got %', v_settle ->> 'state';
  end if;
  select * into v_row from private.subscription_activation_emails where org_id = v_org;
  if v_row.provider_message_id <> 'resend_p103' then
    raise exception 'p103.4: a replayed settlement overwrote the provider message id';
  end if;
  if v_row.sent_at is null or v_row.lease_expires_at is not null then
    raise exception 'p103.4: a sent row must carry a timestamp and hold no lease';
  end if;

  -- ===== 5. An activation after the send still records nothing =====
  v_verdict := private.billing_apply_subscription_state(v_org, v_data, v_event_two, 'paddle', true);
  select count(*) into v_count from private.subscription_activation_emails
  where org_id = v_org and status = 'sent';
  if v_count <> 1 then
    raise exception 'p103.5: a re-activation after the welcome produced % sent rows', v_count;
  end if;
  v_claim := service_claim_subscription_activation_email();
  if v_claim ->> 'state' <> 'idle' then
    raise exception 'p103.5: a settled organization became claimable again (state %)',
      v_claim ->> 'state';
  end if;

  -- ===== 6. No active owner: no debt, and the entitlement write still succeeds =====
  insert into private.billing_events (provider, provider_event_id, event_type, status, payload, org_id)
  values ('paddle', 'evt_p103_noowner', 'subscription.activated', 'stored', '{}'::jsonb, v_org_noown)
  returning id into v_event;
  v_verdict := private.billing_apply_subscription_state(v_org_noown, v_data, v_event, 'paddle', true);
  if not (v_verdict ->> 'ok')::boolean then
    raise exception 'p103.6: a missing owner address blocked the entitlement write: %',
      v_verdict ->> 'detail';
  end if;
  if exists (select 1 from private.subscription_activation_emails where org_id = v_org_noown) then
    raise exception 'p103.6: a debt was recorded with no owner address to send it to';
  end if;
  if (select plan_key from organization_subscriptions where org_id = v_org_noown) <> 'p103_plan' then
    raise exception 'p103.6: the plan was not granted to the ownerless organization';
  end if;

  -- ===== 7. The tenant roles cannot reach any of it =====
  if has_function_privilege('authenticated',
       'public.service_claim_subscription_activation_email()', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.service_settle_subscription_activation_email(uuid,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon',
       'public.service_claim_subscription_activation_email()', 'EXECUTE') then
    raise exception 'p103.7: a tenant role can run the activation-email commands';
  end if;

  raise notice 'p103 passed: seven cases';
end
$suite$;

rollback;
