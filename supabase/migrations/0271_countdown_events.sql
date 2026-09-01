-- 0271 — three events the benefit strip may report, and the four ways it is stopped from lying.
--
-- WHAT THIS MEASURES. Whether anyone saw the strip, pressed it, or closed it. Three names and no
-- more: `offer_redeemed` is `launch_offer_intents` plus its audit row (`0269`), and `offer_expired`
-- is `subscription_grant_expired`, already written by `0212:163-168`. Neither is a client event,
-- because neither is a thing a browser can witness.
--
-- ⚠ THE FUNCTION DOES NOT READ THE FLAG, AND MAY NOT. `p4_flags_identity:202-214` forbids
-- `resolve_feature_flags` in the body of any routine, so what protects this write is owner, a live
-- window and a ceiling — never the switch. A flag turns off the STRIP, and with the strip gone
-- nobody calls this; but the function itself remains callable, and `revoke execute` is what would
-- close it. That is a separate, explicit step and it is written down rather than assumed.
--
-- THE IDEMPOTENCY KEY IS DERIVED, NOT ACCEPTED. `p_idempotency_key` is deliberately absent from
-- the signature: a key the client chooses is not a limit on the client, because it can choose a
-- different one. The server builds `{org}:{event}:{window_kind}:{date}`, which makes one row per
-- organisation per event per window per day a CEILING rather than a request. A thousand calls
-- leave one row, and the suite presses a thousand times to prove it.
--
-- AND `properties` IS A CLOSED SCHEMA, NOT A SIZE LIMIT. Three keys are accepted — `kind`, `mode`
-- and `viewport` — and anything else is refused by name. A 2KB cap on free JSON would have been a
-- limit on VOLUME while leaving the surface open: an operator reads these rows, and free text from
-- a browser is an injection surface into what a person reads. Size is not content filtering.
--
-- `org_id` COMES FROM `auth_org()` AND NEVER FROM THE PAYLOAD — the rule `0157` enforces on
-- billing events, which `p54` proves by showing a forged identifier does not attribute.
--
-- A DECLARED LIMITATION, because a number nobody qualified becomes a number somebody trusts:
-- `countdown.impression` is SELF-REPORTED. A blocker, a background tab or a dropped connection
-- prevents it, so any conversion rate computed against it is a LOWER BOUND on what happened and
-- must be reported as one.

insert into private.product_event_definitions (event_name, label, description, emitted_by) values
  ('countdown.impression', 'Benefit strip seen',
   'Recorded the first time in a day that the launch-benefit strip rendered for an organisation. '
   || 'SELF-REPORTED: a blocker, a background tab or a dropped connection prevents it, so any rate '
   || 'measured against this is a lower bound.',
   'public.record_my_countdown_event'),
  ('countdown.cta_clicked', 'Benefit strip acted on',
   'Recorded when the owner pressed the call to action on the launch-benefit strip. The intention '
   || 'itself is a row in launch_offer_intents (0269); this is the press.',
   'public.record_my_countdown_event'),
  ('countdown.dismissed', 'Benefit strip put away',
   'Recorded when the owner closed or minimised the launch-benefit strip. Minimising is NOT a '
   || 'fourth name — it is this one with properties.mode = minimized, because a fourth name would '
   || 'let the two be counted as different decisions when they are the same one at two depths.',
   'public.record_my_countdown_event')
on conflict (event_name) do update
  set label = excluded.label,
      description = excluded.description,
      emitted_by = excluded.emitted_by;

create or replace function public.record_my_countdown_event(
  p_event_name text,
  p_properties jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_grant jsonb;
  v_kind text;
  v_key text;
  v_clean jsonb := '{}'::jsonb;
  v_property record;
  v_inserted uuid;
begin
  -- Owner, and a live window. Without both, every `authenticated` caller could write unbounded
  -- telemetry rows against their own organisation — storage abuse, and worse, a channel for free
  -- text into a store a human operator reads.
  if v_org is null or v_user is null or v_role <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if p_event_name is null or p_event_name not in
     ('countdown.impression', 'countdown.cta_clicked', 'countdown.dismissed') then
    -- Refused BY NAME. A silent no-write would let a caller believe it was measured.
    raise exception 'event_not_allowed' using errcode = '22023';
  end if;

  -- The window, derived here exactly as `0269` derives it. No window means nothing to report on.
  v_grant := public.my_plan_grant();
  if coalesce((v_grant ->> 'granted')::boolean, false) then
    v_kind := 'prelaunch_grant';
  elsif exists (select 1 from private.free_intro_window(v_org)) then
    v_kind := 'free_intro';
  else
    raise exception 'no_eligible_window' using errcode = '22023';
  end if;

  -- A CLOSED SCHEMA. Every key is checked by name, and an unknown one is refused rather than
  -- dropped: dropping it would make a caller think it had been recorded.
  if p_properties is not null and jsonb_typeof(p_properties) <> 'object' then
    raise exception 'properties_not_an_object' using errcode = '22023';
  end if;
  for v_property in select key, value from jsonb_each(coalesce(p_properties, '{}'::jsonb)) loop
    if v_property.key not in ('kind', 'mode', 'viewport') then
      raise exception 'property_not_allowed: %', v_property.key using errcode = '22023';
    end if;
    if jsonb_typeof(v_property.value) <> 'string' or length(v_property.value #>> '{}') > 32 then
      raise exception 'property_not_a_short_string: %', v_property.key using errcode = '22023';
    end if;
    v_clean := v_clean || jsonb_build_object(v_property.key, v_property.value);
  end loop;

  -- THE CEILING. Derived from the tenant, the event, the window and the day — so a thousand calls
  -- collapse into one row, and the client cannot widen it by choosing a different key.
  v_key := v_org::text || ':' || p_event_name || ':' || v_kind || ':'
        || ((now() at time zone 'Asia/Jerusalem')::date)::text;

  insert into private.product_events (org_id, actor, event_name, properties, idempotency_key)
  values (v_org, v_user, p_event_name, v_clean, v_key)
  on conflict (org_id, event_name, idempotency_key) do nothing
  returning id into v_inserted;

  -- True when this call is what recorded it. False is not an error: it is the ceiling working.
  return v_inserted is not null;
end
$$;

comment on function public.record_my_countdown_event(text, jsonb) is
  'Reports that the launch-benefit strip was seen, pressed or put away (0271). Owner only, and '
  'only while a window is live. The event name is an allowlist of three and the properties are a '
  'closed schema of three short strings — both refuse by name rather than dropping quietly. The '
  'idempotency key is DERIVED from tenant, event, window and day, so one row per day is a ceiling '
  'the caller cannot widen. It does not read the feature flag and may not (§8): what a flag turns '
  'off is the strip, and revoke execute is what would close this door.';

revoke all on function public.record_my_countdown_event(text, jsonb) from public;
revoke all on function public.record_my_countdown_event(text, jsonb) from anon;
grant execute on function public.record_my_countdown_event(text, jsonb) to authenticated;

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select 'record_my_countdown_event(text,jsonb)',
       md5(replace(p.prosrc, chr(13), '')), 'filtered_read',
       '0271 takes the organisation from auth_org() and never from the payload, refuses every '
       'caller who is not its owner before any read, and writes one row keyed on that org id.'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'record_my_countdown_event'
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

do $verify_0271$
declare
  v_body text;
  v_code text;
  v_violations text;
begin
  if (select count(*) from private.product_event_definitions
      where event_name like 'countdown.%') <> 3 then
    raise exception '0271: the countdown events are not exactly three';
  end if;

  v_body := replace(pg_get_functiondef(
    'public.record_my_countdown_event(text, jsonb)'::regprocedure), chr(13), '');

  -- §8, at the place it would be broken: a routine that reads the resolver is a flag that can
  -- gate a write, and a flag that gates a write is a flag that can lose data.
  if position('resolve_feature_flags' in v_body) > 0 then
    raise exception '0271: the writer reads the feature flag';
  end if;

  -- The key is the server's. A signature that accepted one would be a ceiling the caller sets.
  if position('p_idempotency_key' in v_body) > 0 then
    raise exception '0271: the caller can choose its own idempotency key';
  end if;
  if position('auth_org()' in v_body) = 0 then
    raise exception '0271: the tenant is not taken from auth_org()';
  end if;

  -- The organisation never comes from the payload. Checked against CODE rather than prose,
  -- because the comment explaining the rule names the thing the rule forbids.
  v_code := regexp_replace(v_body, '--[^' || chr(10) || ']*', '', 'g');
  if position('p_properties ->> ''org_id''' in v_code) > 0
     or position('p_org_id' in v_code) > 0 then
    raise exception '0271: the writer can be told which organisation to attribute to';
  end if;

  -- Both allowlists refuse by name rather than dropping silently.
  if position('event_not_allowed' in v_body) = 0
     or position('property_not_allowed' in v_body) = 0 then
    raise exception '0271: an allowlist drops instead of refusing';
  end if;

  if not has_function_privilege('authenticated',
        'public.record_my_countdown_event(text, jsonb)', 'execute')
     or has_function_privilege('anon',
        'public.record_my_countdown_event(text, jsonb)', 'execute') then
    raise exception '0271: the writer is not exactly authenticated-only';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0271 scope assertions failed:\n%', v_violations;
  end if;
end
$verify_0271$;
