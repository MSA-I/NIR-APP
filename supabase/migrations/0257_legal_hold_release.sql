-- 0257 -- The legal hold gets a way off. (Owner decision #306, 30.08.2026.)
--
-- WHAT WAS MEASURED, NOT ASSUMED. public.organization_offboarding_requests.legal_hold is
-- `not null default true` (0103:58), and 0197:24 states the rule that default serves in one
-- line: LEGAL HOLD FAILS CLOSED. The purge gate (0197:151) demands an explicit false and treats
-- everything else -- including "no request at all" -- as a hold. No migration in this repository
-- contains an `update ... set legal_hold`. The column every controlled teardown has to pass
-- through has therefore had NO WRITER AT ALL since 0103.
--
-- The consequence is not theoretical and it is not a fixture problem. The controlled-purge route
-- that DEBT §66 opened, 0254 finished and p86 exercises cannot open in production for any tenant,
-- ever, because the first of its four gates can never be satisfied by anything the product does.
-- p75 gets past that gate only because its fixture writes the column directly -- which is exactly
-- the shape of a suite proving a path a customer cannot walk.
--
-- THE RULING (#306, 30.08.2026), with the alternatives the owner rejected recorded here so that a
-- later reader does not quietly re-litigate them:
--   * a super_admin ALONE may lift a hold. NOT four eyes -- that was proposed and declined.
--   * a reason is mandatory, and it is written to both trails.
--   * a re-authentication is mandatory.
--   * NOT a structured external-evidence field (a court reference, a matter number, a date). The
--     reason text carries whatever the operator needs to say. A schema for it would be a guess
--     about Israeli legal process, and OPEN-DECISIONS:3 forbids guessing a business answer.
--   * NOT "leave it to a DBA". A lever that exists only as a psql session is a lever with no
--     capability, no step-up, no reason and no audit row -- which is the state this file ends.
--
-- WHY A NEW CAPABILITY AND NOT `offboarding.handle`. That one is held by customer_ops as well as
-- super_admin (0151:144), and rightly so: approving an offboarding and reissuing an export are
-- day-to-day customer work. Lifting a legal hold is not. It is the single act that turns a tenant
-- the law says to keep into a tenant the executor may delete. Reusing `offboarding.handle` would
-- have handed that act to a role the owner did not name, silently, in a file about something
-- else. The assertion in section 4 exists to prove the new capability leaked to no other role.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT BUILD: a command that PLACES a hold. #306 is about the
-- exit. The `not null default true` already places one on every request 0103 creates, so the
-- entrance is not missing. Placing a hold on a tenant that has none is a different decision with
-- a different blast radius, and it is not the one that was made. p75 therefore still emulates a
-- placement where it needs one, and says so at that line.
--
-- WHAT IT DOES NOT WEAKEN: the gate itself is untouched. `private.organization_purge_gates` still
-- reads `coalesce(request.legal_hold, true) = false`, still treats an unreadable hold as a hold,
-- and the executor still re-derives every gate under lock immediately before each deletion
-- (0197:453). This file adds a door; it does not move a wall.

-- =====================================================================================
-- 1. The capability
-- =====================================================================================
-- 0151:132 granted super_admin every capability that existed AT THAT MOMENT, by a set query.
-- Capabilities added later get nothing from it, so the grant below is not decoration (0249:49).
insert into private.platform_capability_definitions
  (capability, description, sensitivity, requires_step_up, enforced_since)
values
  ('offboarding.legal_hold',
   'Lift the legal hold that blocks a customer organization''s controlled purge.',
   'high', true, '0257');

-- Who gets it, and the reasoning per role -- the same roster 0249:41-47 argued through:
--   super_admin  -- the owner named this role and only this role (#306).
--   customer_ops -- NO. It holds `offboarding.handle` and `org.lifecycle`, which is everything
--                   needed to run an offboarding; none of that is authority over a legal hold.
--   support      -- NO. Read-only by construction.
--   billing      -- NO.
--   analyst      -- NO. Read-only by construction.
insert into platform_role_capabilities (role_key, capability) values
  ('super_admin', 'offboarding.legal_hold');

-- =====================================================================================
-- 2. The command
-- =====================================================================================
-- WHICH PREAMBLE, AND WHY BOTH HALVES. There are two:
--   private.assert_platform_command(org, capability, reason)  -- 0152:241
--   private.assert_platform_staff_command(capability, reason) -- 0249:124
-- The staff one adds the step-up but has no organization: its whole reason to exist is that a
-- change to OUR OWN roster has no honest org_id to be filed against (0249:60-66). This command
-- has one, and needs it for three separate things -- the tenant's own audit row, the platform
-- timeline's `not null` org_id, and the `app.organization_lifecycle_writer` handshake that
-- private.organization_row_write_guard (0103:2227) demands before anything may write to a tenant
-- the product has already made read-only, which every offboarding tenant is by definition.
-- So: the org-scoped preamble, plus the step-up asserted explicitly beside it, exactly as
-- 0249:425 does for `user.access`. `requires_step_up` in the registry is documentation of intent
-- and enforces nothing (0151:53-56); the line below is the enforcement.
create or replace function public.release_organization_legal_hold(
  p_org_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_reason  text;
  v_request public.organization_offboarding_requests;
  -- Captured in DECLARE, which runs BEFORE the preamble below sets it. See the restore at the
  -- end of every returning path for what it is for.
  v_prior_writer text := coalesce(current_setting('app.organization_lifecycle_writer', true), '');
begin
  -- Membership, capability, non-blank reason, a real organization, and the write handshake.
  v_reason := private.assert_platform_command(p_org_id, 'offboarding.legal_hold', p_reason);
  -- assert_platform_command does not ask for freshness. The owner asked for it by name, and
  -- every 'high' capability in this product owes it.
  perform public.assert_recent_password_authentication();

  -- THE LIVE REQUEST: the newest one that was not withdrawn. 'cancelled' and 'reactivated' are
  -- the two terminal states that mean the tenant came back, and a hold on a withdrawn request
  -- governs nothing. Everything else -- open, exported, completed -- can still reach the
  -- executor, so it can still be held. FOR UPDATE because the executor re-derives the gates
  -- under its own lock on the same row; whichever of the two arrives second must see the other.
  select * into v_request
  from public.organization_offboarding_requests request
  where request.org_id = p_org_id
    and request.status not in ('cancelled', 'reactivated')
  order by request.requested_at desc, request.id desc
  limit 1
  for update;

  if not found then
    raise exception 'offboarding_request_unknown' using errcode = 'P0002';
  end if;

  -- Idempotence is REPORTED, not re-written (the 0249:456 rule). A second call writes neither
  -- trail, so "how many times was this hold lifted" stays answerable from the logs rather than
  -- being inflated by however many times a console retried.
  if not v_request.legal_hold then
    perform set_config('app.organization_lifecycle_writer', v_prior_writer, true);
    return jsonb_build_object(
      'org_id', p_org_id,
      'request_id', v_request.id,
      'changed', false,
      'legal_hold', false,
      'purge_gate_legal_hold_clear',
      (private.organization_purge_gates(p_org_id) ->> 'legal_hold_clear')::boolean);
  end if;

  update public.organization_offboarding_requests
  set legal_hold = false
  where id = v_request.id;

  -- Both trails, deliberately, for the reason 0249:470-472 gives: the tenant's own audit trail so
  -- the customer can see what was done to their organization, and the platform timeline so we can
  -- read it back without holding SELECT on audit_logs (0006:160-162). The reason goes to both.
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    p_org_id, v_actor, 'organization_offboarding_legal_hold_released',
    'organization_offboarding_requests', v_request.id,
    jsonb_build_object('legal_hold', true),
    jsonb_build_object('legal_hold', false),
    v_reason
  );

  perform private.record_platform_lifecycle_event(
    p_org_id, v_actor, 'organization_offboarding_legal_hold_released',
    'organization_offboarding_requests', v_request.id,
    jsonb_build_object('legal_hold', true),
    jsonb_build_object('legal_hold', false),
    v_reason);

  -- THE HANDSHAKE IS CLOSED HERE, not merely at commit. `set_config(..., true)` lives for the
  -- whole transaction and PostgREST wraps one request in one transaction, so leaving the writer
  -- open would turn every later statement in that request into a second, unguarded write path
  -- into this tenant -- the argument 0249:462-465 makes for its own handshake. The PRIOR value is
  -- restored rather than blanked, so a future command that calls this one inside its own
  -- preamble keeps the door it opened. A refusal needs no restore: a caught exception rolls the
  -- subtransaction back, and a transaction-local setting goes back with it.
  perform set_config('app.organization_lifecycle_writer', v_prior_writer, true);

  -- The gate is re-read rather than assumed. It is the whole point of the decision, and it is
  -- NOT the same question as "is this row's hold false": the gate reads the newest request in
  -- ('export_ready', 'completed'), so lifting the hold on a request that has not exported yet
  -- honestly reports a gate that is still shut. Better a caller who sees that than one who is
  -- told the purge is unblocked because a boolean flipped somewhere.
  return jsonb_build_object(
    'org_id', p_org_id,
    'request_id', v_request.id,
    'changed', true,
    'legal_hold', false,
    'purge_gate_legal_hold_clear',
    (private.organization_purge_gates(p_org_id) ->> 'legal_hold_clear')::boolean);
end
$$;

-- =====================================================================================
-- 3. Grants
-- =====================================================================================
-- service_role is revoked as well, following the offboarding siblings (0197:391, 0197:496) and
-- for their reason: #261 forbids a deletion that happens because a clock elapsed, and a command
-- a worker can hold is a command a scheduler can reach. Lifting the hold is upstream of that
-- deletion, so it inherits the rule.
revoke all on function public.release_organization_legal_hold(uuid, text)
  from public, anon, service_role;
grant execute on function public.release_organization_legal_hold(uuid, text) to authenticated;

comment on function public.release_organization_legal_hold(uuid, text) is
  'Lifts the legal hold on a customer organization''s live offboarding request (#306, 0257). '
  'super_admin only, through offboarding.legal_hold, with a mandatory reason and fresh password '
  'authentication. Writes the tenant''s audit trail and the platform timeline, both with the '
  'reason. A no-op writes neither. There is deliberately no command that places a hold.';

-- =====================================================================================
-- 4. Anchors -- the claims this file makes, checked here
-- =====================================================================================
do $anchor_0257$
declare
  v_roles    text[];
  v_body     text;
  v_preamble text;
begin
  -- The capability exists, and it is declared the way a hold-lifting capability has to be.
  if not exists (
    select 1 from private.platform_capability_definitions definition
    where definition.capability = 'offboarding.legal_hold'
      and definition.sensitivity = 'high'
      and definition.requires_step_up
      and definition.enforced_since = '0257'
  ) then
    raise exception '0257: offboarding.legal_hold is not declared as an enforced step-up '
                    'capability of high sensitivity';
  end if;

  -- 0249:764-769's shape: the leak is counted, not assumed away. `array_agg` over the whole grant
  -- set answers "who holds it" rather than "does super_admin hold it", which is a different and
  -- much weaker question.
  select array_agg(granted.role_key order by granted.role_key) into v_roles
  from platform_role_capabilities granted
  where granted.capability = 'offboarding.legal_hold';
  if v_roles is distinct from array['super_admin'] then
    raise exception '0257: offboarding.legal_hold is held by [%] rather than by super_admin '
                    'alone -- #306 named one role',
                    coalesce(array_to_string(v_roles, ', '), 'no role at all');
  end if;

  -- The body is read with carriage returns stripped, so this assertion means the same thing
  -- whether the migration was applied from Windows or from a Linux runner (0209, and the guard
  -- scripts/check-anchored-replacements.mjs enforces).
  select replace(proc.prosrc, e'\r', '') into v_body
  from pg_catalog.pg_proc proc
  where proc.oid = 'public.release_organization_legal_hold(uuid,text)'::regprocedure;

  -- A blank reason is refused. It cannot be PROVEN by calling here -- there is no JWT subject in
  -- a migration, so the preamble refuses for membership long before it looks at the reason, and
  -- the behavioural proof therefore lives in p75 where an operator identity exists. What is
  -- checked here is the chain that produces it: this body delegates to the preamble that raises
  -- reason_required, and that preamble still raises it.
  if position('assert_platform_command' in v_body) = 0
     or position('offboarding.legal_hold' in v_body) = 0 then
    raise exception '0257: the command does not go through the org-scoped platform preamble '
                    'under its own capability -- the reason and the write handshake are lost';
  end if;
  select replace(preamble.prosrc, e'\r', '') into v_preamble
  from pg_catalog.pg_proc preamble
  where preamble.oid = 'private.assert_platform_command(uuid,text,text)'::regprocedure;
  if position('reason_required' in v_preamble) = 0 then
    raise exception '0257: private.assert_platform_command no longer refuses a blank reason, so '
                    'the mandatory reason #306 asked for is not enforced anywhere';
  end if;

  -- The re-authentication the owner asked for, by name, in this body and not merely in a flag.
  if position('assert_recent_password_authentication' in v_body) = 0 then
    raise exception '0257: the release command does not assert a fresh password authentication';
  end if;

  -- Both trails, with the reason.
  if position('audit_logs' in v_body) = 0
     or position('record_platform_lifecycle_event' in v_body) = 0 then
    raise exception '0257: the release command does not write both the tenant audit trail and '
                    'the platform timeline';
  end if;

  -- The tenant write handshake is closed on the way out, so the command is a door and not a
  -- door left ajar for the rest of the request.
  if position('set_config(''app.organization_lifecycle_writer''' in v_body) = 0 then
    raise exception '0257: the release command opens the tenant write handshake and never '
                    'closes it -- every later statement in the same request inherits it';
  end if;

  -- The capability that was deliberately NOT reused.
  if position('offboarding.handle' in v_body) > 0 then
    raise exception '0257: the release command names offboarding.handle, which customer_ops '
                    'holds -- #306 named super_admin alone';
  end if;

  -- Privileges are read from the catalogue. Calling a function as a role that lacks EXECUTE to
  -- catch insufficient_privilege segfaults this backend; has_function_privilege answers the same
  -- question without running anything.
  if has_function_privilege('anon', 'public.release_organization_legal_hold(uuid,text)', 'execute')
     or has_function_privilege('service_role',
          'public.release_organization_legal_hold(uuid,text)', 'execute')
     or not has_function_privilege('authenticated',
          'public.release_organization_legal_hold(uuid,text)', 'execute') then
    raise exception '0257: the release command is reachable by a role a scheduler can hold, or '
                    'unreachable by the browser role that is supposed to call it';
  end if;

  -- And it must not answer at all without a JWT subject. A definer that returns something during
  -- a migration returns it for anon at run time (0249:786).
  begin
    perform public.release_organization_legal_hold(
      '00000000-0000-4000-8000-000000000000'::uuid, '0257 anchor probe');
    raise exception '0257: the release command answered with no JWT subject at all';
  exception when sqlstate '42501' then
    null;
  end;
end
$anchor_0257$;

-- =====================================================================================
-- 5. Structural re-assertion (mandatory after 0057)
-- =====================================================================================
-- No exemption row is added and none is needed: the tables this command touches --
-- organization_offboarding_requests, audit_logs, platform_lifecycle_events -- are all registered
-- `enforced = false` in private.scope_registry (0103:189 for the first), so the A5 marker scan
-- has nothing to match in this body. That is a design choice, the same one 0254:258 made: the
-- cheapest exemption is the one you do not have to argue for.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0257 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
