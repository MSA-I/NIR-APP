-- P96 — a thousand presses, one row, and two allowlists that refuse by name.
--
-- `0271` lets the benefit strip report that it was seen, pressed or put away. Everything
-- interesting is about what a caller must NOT be able to do with a write endpoint it can reach:
--
--   CHOOSE ITS OWN CEILING. The idempotency key is derived from tenant, event, window and day, so
--   a thousand calls collapse into one row. A key the client supplied would not be a limit on the
--   client at all — it would pick a different one. This suite presses a thousand times.
--
--   PUT FREE TEXT WHERE AN OPERATOR READS IT. `properties` is a closed schema of three short
--   strings. A size cap would have bounded VOLUME while leaving the surface open, and size is not
--   content filtering.
--
--   ATTRIBUTE TO SOMEBODY ELSE. The organisation comes from `auth_org()`, never the payload.
--
--   OR BE MEASURED WHEN IT SHOULD HAVE BEEN REFUSED. Both allowlists raise by name; a silent
--   no-write would let the caller believe it had been recorded.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p96_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P96 countdown event assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p96_refuses(p_sql text, p_expected text)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return position(p_expected in sqlerrm) > 0;
end
$$;

insert into public.organizations(id, name, status, vat_rate, base_currency, country_code) values
  ('a0960000-0000-4000-8000-000000000001', 'P96 granted', 'active', 18, 'ILS', 'IL'),
  ('a0960000-0000-4000-8000-000000000002', 'P96 no window', 'active', 18, 'ILS', 'IL');
insert into auth.users (id, email) values
  ('b0960000-0000-4000-8000-000000000001', 'p96-owner@example.test'),
  ('b0960000-0000-4000-8000-000000000002', 'p96-office@example.test'),
  ('b0960000-0000-4000-8000-000000000003', 'p96-nowindow@example.test');
insert into public.profiles(id, org_id, full_name, role, active) values
  ('b0960000-0000-4000-8000-000000000001', 'a0960000-0000-4000-8000-000000000001',
   'P96 owner', 'owner', true),
  ('b0960000-0000-4000-8000-000000000002', 'a0960000-0000-4000-8000-000000000001',
   'P96 office', 'office', true),
  ('b0960000-0000-4000-8000-000000000003', 'a0960000-0000-4000-8000-000000000002',
   'P96 owner without a window', 'owner', true);

insert into public.organization_subscriptions(org_id, plan_key, provider, granted_until)
values ('a0960000-0000-4000-8000-000000000001', 'premium', 'manual', now() + interval '45 days')
on conflict (org_id) do update
  set plan_key = 'premium', provider = 'manual', granted_until = excluded.granted_until;
-- No grant and no introduction stamp: nothing to report on.
insert into public.organization_subscriptions(org_id, plan_key, provider, granted_until)
values ('a0960000-0000-4000-8000-000000000002', 'free', 'manual', null)
on conflict (org_id) do update
  set plan_key = 'free', provider = 'manual', granted_until = null;

select set_config('request.jwt.claim.sub', 'b0960000-0000-4000-8000-000000000001', true);

-- ---- 1. The three names, and only those three. ------------------------------------------------
select pg_temp.p96_assert(
  public.record_my_countdown_event('countdown.impression'),
  'the first impression was not recorded');
select pg_temp.p96_assert(
  public.record_my_countdown_event('countdown.cta_clicked'),
  'the press was not recorded');
select pg_temp.p96_assert(
  public.record_my_countdown_event('countdown.dismissed', '{"mode": "minimized"}'::jsonb),
  'minimising was not recorded');

-- REFUSED BY NAME, not dropped. A silent no-write lets a caller believe it was measured.
select pg_temp.p96_assert(
  pg_temp.p96_refuses($$select public.record_my_countdown_event('countdown.invented')$$,
                      'event_not_allowed'),
  'an invented event name was accepted or silently dropped');
select pg_temp.p96_assert(
  pg_temp.p96_refuses($$select public.record_my_countdown_event('usage.limit_reached')$$,
                      'event_not_allowed'),
  'a real event from another surface was accepted through this door');

-- ---- 2. THE CEILING. A thousand calls, one row. -----------------------------------------------
do $flood$
declare v_recorded int := 0;
begin
  for i in 1..1000 loop
    if public.record_my_countdown_event('countdown.impression') then
      v_recorded := v_recorded + 1;
    end if;
  end loop;
  -- Not one of the thousand recorded anything: the first call today already did.
  if v_recorded <> 0 then
    raise exception 'P96 countdown event assertion failed: % of 1000 repeats wrote a row',
      v_recorded;
  end if;
end
$flood$;
select pg_temp.p96_assert(
  (select count(*) from private.product_events
   where org_id = 'a0960000-0000-4000-8000-000000000001'
     and event_name = 'countdown.impression') = 1,
  'a thousand presses left more than one impression row');

-- The ceiling is per EVENT, not per surface: pressing is still countable after an impression.
select pg_temp.p96_assert(
  (select count(*) from private.product_events
   where org_id = 'a0960000-0000-4000-8000-000000000001'
     and event_name like 'countdown.%') = 3,
  'the three events did not each keep their own row');

-- And `false` is not an error — it is the ceiling working, and the caller can tell the difference.
select pg_temp.p96_assert(
  not public.record_my_countdown_event('countdown.impression'),
  'a repeat reported itself as a new recording');

-- ---- 3. The properties are a closed schema, not a size limit. ---------------------------------
select pg_temp.p96_assert(
  pg_temp.p96_refuses(
    $$select public.record_my_countdown_event('countdown.dismissed', '{"note": "hello"}'::jsonb)$$,
    'property_not_allowed'),
  'an unknown property key was accepted or dropped');
select pg_temp.p96_assert(
  pg_temp.p96_refuses(
    $$select public.record_my_countdown_event('countdown.dismissed', '{"mode": 7}'::jsonb)$$,
    'property_not_a_short_string'),
  'a non-string property value was accepted');
select pg_temp.p96_assert(
  pg_temp.p96_refuses(
    $$select public.record_my_countdown_event('countdown.dismissed',
        ('{"mode": "' || repeat('x', 64) || '"}')::jsonb)$$,
    'property_not_a_short_string'),
  'a long string was accepted into a store an operator reads');
select pg_temp.p96_assert(
  pg_temp.p96_refuses(
    $$select public.record_my_countdown_event('countdown.dismissed', '"not an object"'::jsonb)$$,
    'properties_not_an_object'),
  'a scalar was accepted where an object belongs');

-- What WAS stored is exactly what was allowed, and nothing more.
select pg_temp.p96_assert(
  (select properties from private.product_events
   where org_id = 'a0960000-0000-4000-8000-000000000001'
     and event_name = 'countdown.dismissed') = '{"mode": "minimized"}'::jsonb,
  'the stored properties are not the allowed keys the caller sent');

-- ---- 4. The organisation is never the caller's to choose. ------------------------------------
select pg_temp.p96_assert(
  (select count(*) from private.product_events
   where org_id = 'a0960000-0000-4000-8000-000000000002'
     and event_name like 'countdown.%') = 0,
  'an event was attributed to an organisation that recorded none');
select pg_temp.p96_assert(
  (select actor from private.product_events
   where org_id = 'a0960000-0000-4000-8000-000000000001'
     and event_name = 'countdown.cta_clicked') = 'b0960000-0000-4000-8000-000000000001',
  'the actor is not the caller');

-- ---- 5. Owner, and a live window. ------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'b0960000-0000-4000-8000-000000000002', true);
select pg_temp.p96_assert(
  pg_temp.p96_refuses($$select public.record_my_countdown_event('countdown.impression')$$,
                      'not_authorized'),
  'an office user wrote telemetry for the tenant');

select set_config('request.jwt.claim.sub', 'b0960000-0000-4000-8000-000000000003', true);
select pg_temp.p96_assert(
  pg_temp.p96_refuses($$select public.record_my_countdown_event('countdown.impression')$$,
                      'no_eligible_window'),
  'an owner with no window reported seeing one');

-- ---- 6. Three names, and the two that are deliberately NOT client events. ---------------------
-- `offer_redeemed` is launch_offer_intents plus its audit row; `offer_expired` is written by
-- 0212. Neither is a thing a browser can witness, so neither has a definition here.
select pg_temp.p96_assert(
  (select count(*) from private.product_event_definitions
   where event_name like 'countdown.%') = 3,
  'the countdown surface defines something other than its three events');
select pg_temp.p96_assert(
  not exists (select 1 from private.product_event_definitions
              where event_name in ('countdown.offer_redeemed', 'countdown.offer_expired')),
  'a server-observed fact was defined as a client event');

-- And the self-reported limitation is written where a reader of the data will find it.
select pg_temp.p96_assert(
  (select position('lower bound' in description) > 0
   from private.product_event_definitions where event_name = 'countdown.impression'),
  'the impression event does not declare that it is self-reported');

rollback;

select 'P96_countdown_events_passed' as result;
