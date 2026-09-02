-- 0286 -- a platform writer carries the capability it was declared to need.
--
-- WHAT WAS MEASURED, NOT ASSUMED. 0151 built a SECOND authority axis on top of
-- `platform_admins`: a capability vocabulary, five named roles, and `platform_has_capability()`.
-- 0151:53-56 says plainly that the registry is declaration and the command is enforcement -- each
-- capability is wired by the wave that owns its surface. Five commands were never wired, and the
-- narrowing that 0151 promised has therefore been decorative on all five since the day the second
-- operator role existed:
--
--   set_organization_lifecycle      -- latest body: 0195:90-176 anchor-patched over 0134:164.
--                                      Guards on `is_platform_admin()` (0134:164) plus a step-up
--                                      (0134:177). It never asks for `org.lifecycle`, although
--                                      0151:68 declares that capability high/step-up FOR THIS
--                                      COMMAND and 0151:143 grants it to super_admin and
--                                      customer_ops only.
--   platform_set_approval_policy    -- 0070:115, membership only.
--   platform_set_autonomy_policy    -- 0076:259, membership only.
--   platform_set_assistant_policy   -- 0164:1496, membership only.
--   platform_set_org_flag           -- 0059:247, membership only, no capability, no step-up.
--                                      0059 is the only definition of it in the tree.
--
-- WHAT AN UNAUTHORISED OPERATOR COULD DO, concretely, before this file. Any row in
-- `platform_admins` -- a `support` operator hired to answer "why can't this person sign in", a
-- `billing` operator, an `analyst` whose four capabilities are all reads, or an operator with no
-- role row at all -- could SUSPEND any tenant in the product and reactivate it; could turn a
-- feature flag on or off for any tenant or one of its units; could raise or lower any tenant's
-- approval policy, autonomy policy and assistant policy. `analyst` is described in 0151:127 as
-- "read-only across customers"; it was not. The suspension is the sharpest of the five: a
-- suspended tenant's `auth_org()` answers NULL, so the customer's whole product goes dark.
--
-- WHAT THIS FILE CHANGES. Each of the five now goes through `private.assert_platform_command`
-- (0152:241) -- the one preamble that proves membership AND the capability AND a non-blank reason
-- AND that the target organization exists, and that takes the 0103:2570 tenant write handshake.
-- Nothing else in any body moves: the patches are anchored replacements in the 0195/0249/0257
-- style, each anchor asserted to occur exactly once in the LIVE body before it is touched, so a
-- body that drifted since it was written aborts the migration instead of being silently rewritten
-- from a stale copy.
--
--   * `set_organization_lifecycle` KEEPS its explicit `assert_recent_password_authentication()`.
--     The preamble does not ask for freshness (0257:100 states this, 0249:424 works around it),
--     and 0195:291-292 asserts the step-up is present in the body by name. Both stay.
--   * The four others gain the capability line AFTER their own argument, definition and
--     organization checks, so every refusal those commands already made BY NAME --
--     `flag_unknown`, `approval_policy_reason_required`, `autonomy_policy_not_tightening`,
--     `assistant_policy_unknown` and the rest -- still fires with the same name and the same
--     SQLSTATE. Putting the preamble first would have renamed four of them to `reason_required`,
--     which is a worse answer for the operator and would silently retire suite assertions that
--     exist to keep those refusals honest.
--
-- ONE CONSEQUENCE WORTH STATING, because it is a widening and not a narrowing.
-- `assert_platform_command` opens `app.organization_lifecycle_writer`, so an operator may now
-- configure a flag or a policy on a SUSPENDED or offboarding tenant, where
-- `private.organization_row_write_guard` (0103:2227) previously refused the write and the audit
-- row with it. That is the correct direction -- configuring a customer matters most exactly when
-- they are in trouble, which is the argument p50 already makes for operator notes -- and it is the
-- same handshake `set_organization_lifecycle` has taken since 0134:180. Like that one, and unlike
-- 0257, the four do not restore the prior writer on the way out; PostgREST wraps one request
-- around one RPC, so the setting dies with the statement's transaction.
--
-- DEFAULT PENDING OWNER RULING (two of them, both recorded rather than guessed --
-- OPEN-DECISIONS:3, and written down as OPEN-DECISIONS #333 so the default has a row to be
-- overturned in rather than living only in this comment):
--   (a) `policy.configure` and `flag.configure` are NEW capabilities, granted by default to
--       super_admin and customer_ops -- the same pair that holds `org.lifecycle`, on the argument
--       that whoever may darken a tenant may certainly configure one. The owner may want
--       `flag.configure` on its own axis (a rollout is not customer operations) or want `billing`
--       excluded explicitly; nothing here forecloses that -- a role grant is one row.
--   (b) Both are declared `high` sensitivity and `requires_step_up = false`. `high` because they
--       reach across the tenant boundary and change how the product behaves for a customer who
--       did not ask -- the same blast-radius class as `org.lifecycle`, and the reason the
--       assertion in section 5 covers them. `requires_step_up` is left FALSE deliberately: in
--       this product the flag is not documentation, it is a promise that the body calls
--       `assert_recent_password_authentication()` (0154:448, 0249:425, 0257:101), and the only
--       console that reaches these four -- src/operator/AutonomyPolicyPanel.tsx:95 -- has no
--       re-authentication flow. Declaring a step-up nobody enforces would be this file's own
--       finding, one column over. Whether these four writes deserve a re-authentication is an
--       owner ruling; until it is made, the flag says what is true.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT FIX, recorded so a later reader finds it named rather than
-- missing: `public.platform_set_price_list_automation_scope` (0096:2060) is the SIXTH command of
-- exactly this shape -- `is_platform_admin()` plus a step-up, granted to `authenticated`, and no
-- capability at all. It was not in the scope this file was given, its surface (price-list
-- calibration activation) has its own guard registry at 0182:228, and pinning it here would have
-- meant re-opening the 0181 anchored rewrite of the same body. Section 5 lists it BY NAME in the
-- no-capability arm, so it cannot pass as covered and cannot be forgotten.
--
-- Forward-only. No column, table, policy, grant or signature changes; five function bodies are
-- patched in place and two capability rows are added. Production is at 0242, so all five findings
-- bind on production today.

-- =====================================================================================
-- 1. The two capabilities that did not exist, and the one that did
-- =====================================================================================
-- 0151:132 granted super_admin every capability that existed AT THAT MOMENT, by a set query.
-- Capabilities added later get nothing from it, so the grants below are not decoration
-- (0249:49, 0257:47).
insert into private.platform_capability_definitions
  (capability, description, sensitivity, requires_step_up, enforced_since)
values
  ('policy.configure',
   'Set a customer organization''s approval, autonomy or assistant policy.',
   'high', false, '0286'),
  ('flag.configure',
   'Turn a feature flag on or off for a customer organization or one of its units.',
   'high', false, '0286');

-- Who gets them, and the reasoning per role -- the roster 0249:41-47 and 0257:57-63 argue through:
--   super_admin  -- everything, by its own definition (0152's anchor asserts this globally).
--   customer_ops -- holds `org.lifecycle` already (0151:143). A role trusted to darken a tenant is
--                   trusted to configure one; refusing here would make suspension the ONLY lever
--                   customer operations has, which is the opposite of proportionate.
--   support      -- NO. Read a customer and record a support interaction; that is the whole role.
--   billing      -- NO. Subscription, entitlement and usage. A flag is not a price.
--   analyst      -- NO. Read-only by construction, which is precisely what this file restores.
insert into platform_role_capabilities (role_key, capability) values
  ('super_admin',  'policy.configure'),
  ('super_admin',  'flag.configure'),
  ('customer_ops', 'policy.configure'),
  ('customer_ops', 'flag.configure')
on conflict (role_key, capability) do nothing;

-- `org.lifecycle` was declared in 0151 with `enforced_since` NULL -- 0151:26-29 is explicit that
-- NULL means "declared for a later wave and enforced nowhere yet". This is that wave. The same
-- update shape as 0152:46.
update private.platform_capability_definitions
   set enforced_since = '0286'
 where capability = 'org.lifecycle';

-- =====================================================================================
-- 2. The lifecycle command
-- =====================================================================================
-- ANCHORED REPLACEMENT, the 0195:91 pattern. Both sides are read with carriage returns stripped,
-- so the patch means the same thing whether the body it is patching was applied from Windows or
-- from a Linux runner -- the 0181 failure, and what scripts/check-anchored-replacements.mjs
-- enforces. The anchor is required to occur EXACTLY once; anything else aborts rather than
-- patching a body that has moved.
do $mig_0286_lifecycle$
declare
  v_def     text;
  v_anchor  text;
  v_patched text;
  v_signature constant text :=
    'public.set_organization_lifecycle(uuid,public.org_status,timestamptz,text,text,text)';
begin
  select replace(pg_get_functiondef(p.oid), e'\r', '') into v_def
  from pg_catalog.pg_proc p
  where p.oid = v_signature::regprocedure;
  if v_def is null then
    raise exception '0286: set_organization_lifecycle not found at the 0195 six-argument signature';
  end if;

  v_anchor := replace($anchor$  if v_actor is null or not public.is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;$anchor$, e'\r', '');
  v_patched := replace($patched$  -- 0286: membership, the capability, a non-blank reason, a real target and the tenant write
  -- handshake -- the one preamble every other reasoned platform command already goes through.
  v_reason := private.assert_platform_command(p_org_id, 'org.lifecycle', p_reason);$patched$, e'\r', '');
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0286: the lifecycle membership anchor moved -- refusing to patch blindly';
  end if;
  v_def := replace(v_def, v_anchor, v_patched);

  execute v_def;
end
$mig_0286_lifecycle$;

-- =====================================================================================
-- 3. The four configuration commands
-- =====================================================================================
-- All four share one anchor -- the "does the target organization exist" block, which each body
-- carries exactly once and which is the LAST check before any of them writes. Patching there is
-- what keeps every earlier by-name refusal intact (see the header). The loop is not brevity for
-- its own sake: four hand-copied blocks would be four chances for one of them to drift.
do $mig_0286_config$
declare
  v_target  record;
  v_def     text;
  v_anchor  text;
  v_patched text;
begin
  v_anchor := replace($anchor$  if not exists (select 1 from organizations o where o.id = p_org_id) then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;$anchor$, e'\r', '');

  for v_target in
    select *
    from (values
      ('public.platform_set_org_flag(uuid,text,boolean,jsonb,uuid,text)',             'flag.configure'),
      ('public.platform_set_approval_policy(uuid,text,numeric,integer,boolean,text)', 'policy.configure'),
      ('public.platform_set_autonomy_policy(uuid,text,boolean,numeric,text)',         'policy.configure'),
      ('public.platform_set_assistant_policy(uuid,text,boolean,text)',                'policy.configure')
    ) as t(signature, capability)
  loop
    select replace(pg_get_functiondef(p.oid), e'\r', '') into v_def
    from pg_catalog.pg_proc p
    where p.oid = v_target.signature::regprocedure;
    if v_def is null then
      raise exception '0286: % not found', v_target.signature;
    end if;

    if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
      raise exception '0286: the organization-exists anchor occurs % time(s) in % -- refusing to '
                      'patch blindly',
                      (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor),
                      v_target.signature;
    end if;

    -- The anchor is kept and the capability line appended after it, so the target is proven to
    -- exist before the authority question is asked and the write still follows both.
    v_patched := replace(format($patched$  if not exists (select 1 from organizations o where o.id = p_org_id) then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;
  -- 0286: the capability 0151 declared for this surface, asked for where the reason is already
  -- non-blank and the target is already proven -- so this preamble can only refuse for authority.
  perform private.assert_platform_command(p_org_id, %L, v_reason);$patched$,
      v_target.capability), e'\r', '');

    execute replace(v_def, v_anchor, v_patched);
  end loop;
end
$mig_0286_config$;

-- =====================================================================================
-- 4. Structural re-assertion (mandatory after 0057)
-- =====================================================================================
do $assert_0286$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0286 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0286 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0286$;

-- =====================================================================================
-- 5. Anchors -- the claims this file makes, checked here
-- =====================================================================================
-- The mapping is written out BY NAME rather than derived by a regular expression over bodies. A
-- regex over `platform_has_capability\('([^']+)'\)` would happily accept a command that names the
-- WRONG capability, which is the failure this whole file is about; and it would go quiet the day
-- somebody spells the call differently. A list can be wrong only by being edited.
do $anchor_0286$
declare
  v_row        record;
  v_body       text;
  v_capability text;
  v_roles      text[];
  v_uncovered  text;
begin
  -- ----- (a) The two new capabilities are declared the way section 1 says -----
  if not exists (
    select 1 from private.platform_capability_definitions definition
    where definition.capability = 'policy.configure'
      and definition.sensitivity = 'high'
      and not definition.requires_step_up
      and definition.enforced_since = '0286'
  ) or not exists (
    select 1 from private.platform_capability_definitions definition
    where definition.capability = 'flag.configure'
      and definition.sensitivity = 'high'
      and not definition.requires_step_up
      and definition.enforced_since = '0286'
  ) then
    raise exception '0286: the two new capabilities are not declared high / no-step-up / 0286';
  end if;

  if (select enforced_since from private.platform_capability_definitions
       where capability = 'org.lifecycle') is distinct from '0286' then
    raise exception '0286: org.lifecycle still reads as declared-but-unenforced';
  end if;

  -- The 0249:764 shape: who holds it is counted, not assumed away.
  foreach v_capability in array array['policy.configure', 'flag.configure'] loop
    select array_agg(granted.role_key order by granted.role_key) into v_roles
    from platform_role_capabilities granted
    where granted.capability = v_capability;
    if v_roles is distinct from array['customer_ops', 'super_admin'] then
      raise exception '0286: % is held by [%] rather than by customer_ops and super_admin',
        v_capability, coalesce(array_to_string(v_roles, ', '), 'no role at all');
    end if;
  end loop;

  -- ----- (b) Every high-sensitivity platform writer names its capability in its LIVE body -----
  -- Read with carriage returns stripped, for the 0209 reason.
  for v_row in
    select *
    from (values
      ('public.set_organization_lifecycle(uuid,public.org_status,timestamptz,text,text,text)', 'org.lifecycle'),
      ('public.platform_set_org_flag(uuid,text,boolean,jsonb,uuid,text)',                      'flag.configure'),
      ('public.platform_set_approval_policy(uuid,text,numeric,integer,boolean,text)',          'policy.configure'),
      ('public.platform_set_autonomy_policy(uuid,text,boolean,numeric,text)',                  'policy.configure'),
      ('public.platform_set_assistant_policy(uuid,text,boolean,text)',                         'policy.configure'),
      ('public.platform_set_org_subscription(uuid,text,text,text,text)',                       'subscription.edit'),
      ('public.platform_set_user_access(uuid,public.user_role,boolean,text)',                  'user.access'),
      ('public.platform_set_operator_roles(uuid,text[],text)',                                 'operator.manage')
    ) as t(signature, capability)
  loop
    if to_regprocedure(v_row.signature) is null then
      raise exception '0286: % is not in the catalogue under that signature', v_row.signature;
    end if;

    if not exists (
      select 1 from private.platform_capability_definitions definition
      where definition.capability = v_row.capability
        and (definition.sensitivity = 'high' or definition.requires_step_up)
    ) then
      raise exception '0286: % is pinned to %, which is no longer declared high or step-up -- the '
                      'assertion would silently stop covering it',
                      v_row.signature, v_row.capability;
    end if;

    select replace(proc.prosrc, e'\r', '') into v_body
    from pg_catalog.pg_proc proc
    where proc.oid = v_row.signature::regprocedure;

    if strpos(v_body, v_row.capability) = 0 then
      raise exception '0286: % does not name % anywhere in its body -- it is guarded by '
                      'membership alone, which is what this migration exists to end',
                      v_row.signature, v_row.capability;
    end if;

    -- Naming the capability in a comment while checking nothing would satisfy the line above and
    -- nothing else, so the call that consumes it is required too.
    if position('assert_platform_command' in v_body) = 0
       and position('assert_platform_staff_command' in v_body) = 0
       and position('platform_has_capability' in v_body) = 0 then
      raise exception '0286: % names its capability but calls no preamble that reads one',
                      v_row.signature;
    end if;

    -- A command that stopped being reachable by the browser, or became reachable by anon, is a
    -- different bug wearing the same signature. Privileges are READ from the catalogue rather
    -- than discovered by calling as the wrong role, which segfaults this backend (0249:780).
    if not has_function_privilege('authenticated', v_row.signature, 'execute')
       or has_function_privilege('anon', v_row.signature, 'execute') then
      raise exception '0286: % is unreachable by the browser role or reachable by anon',
                      v_row.signature;
    end if;
  end loop;

  -- ----- (c) Completeness: nothing of this shape escaped the list -----
  -- Without this arm the list above is a set of claims about eight functions and says nothing
  -- about the ninth somebody adds next month. The only member of the no-capability arm is the
  -- finding the header records by name.
  -- `not exists` rather than `not in`: a signature that no longer resolves yields NULL, and NULL
  -- inside a `not in` list turns the whole predicate NULL, which would report NOTHING and read
  -- exactly like a pass. Here an unresolvable entry simply stops covering, and the candidate it
  -- was meant to cover is reported. Fail-closed in both directions.
  select string_agg(candidate.signature, e'\n' order by candidate.signature) into v_uncovered
  from (
    select proc.oid::regprocedure::text as signature, proc.oid as oid
    from pg_catalog.pg_proc proc
    join pg_catalog.pg_namespace space on space.oid = proc.pronamespace
    where space.nspname = 'public'
      and proc.prosecdef
      and (proc.proname like 'platform\_set\_%' or proc.proname like 'set\_organization\_%')
      and has_function_privilege('authenticated', proc.oid, 'execute')
  ) candidate
  where not exists (
    select 1
    from (values
      ('public.set_organization_lifecycle(uuid,public.org_status,timestamptz,text,text,text)'),
      ('public.platform_set_org_flag(uuid,text,boolean,jsonb,uuid,text)'),
      ('public.platform_set_approval_policy(uuid,text,numeric,integer,boolean,text)'),
      ('public.platform_set_autonomy_policy(uuid,text,boolean,numeric,text)'),
      ('public.platform_set_assistant_policy(uuid,text,boolean,text)'),
      ('public.platform_set_org_subscription(uuid,text,text,text,text)'),
      ('public.platform_set_user_access(uuid,public.user_role,boolean,text)'),
      ('public.platform_set_operator_roles(uuid,text[],text)'),
      -- Carry a capability, but a `write` one rather than a high one: they are outside the
      -- assertion in (b) by classification, not by oversight.
      ('public.platform_set_customer_account(uuid,uuid,date,text)'),
      ('public.platform_set_onboarding_step(uuid,text,text,text)'),
      -- CARRIES NO CAPABILITY AT ALL. The sixth instance of this file's finding, left standing
      -- on purpose and named here so it cannot pass as covered. See the header.
      ('public.platform_set_price_list_automation_scope(uuid,uuid,text,uuid,text)')
    ) as covered(signature)
    where to_regprocedure(covered.signature)::oid = candidate.oid
  );
  if v_uncovered is not null then
    -- One literal, deliberately: an E-string continued onto a second line is a shape this file
    -- should not be the place to find out about.
    raise exception e'0286: platform writer(s) this file neither wired nor recorded:\n%', v_uncovered;
  end if;

  -- ----- (d) And the five must still refuse with no JWT subject at all -----
  -- A definer that answers during a migration answers for anon at run time (0249:786). There is
  -- no subject here, so `not_platform_admin` is the only honest outcome; anything else, including
  -- success, is the door standing open.
  begin
    perform public.platform_set_org_flag(
      '00000000-0000-4000-8000-000000000000'::uuid, 'assistant.ui', true, null, null,
      '0286 anchor probe');
    raise exception '0286: platform_set_org_flag answered with no JWT subject at all';
  exception
    when sqlstate '42501' then null;
  end;
end
$anchor_0286$;

comment on function public.platform_set_org_flag(uuid, text, boolean, jsonb, uuid, text) is
  'Sets one feature flag for one organization, or for one of its units (0059). Since 0286 it '
  'demands `flag.configure` as well as platform membership, plus a reason, and audits to the '
  'target organization.';
comment on function public.platform_set_approval_policy(uuid, text, numeric, integer, boolean, text) is
  'Configures an organization''s approval policy, tighten-only (0070). Since 0286 it demands '
  '`policy.configure` as well as platform membership.';
comment on function public.platform_set_autonomy_policy(uuid, text, boolean, numeric, text) is
  'Configures an organization''s document-autonomy policy, tighten-only (0076). Since 0286 it '
  'demands `policy.configure` as well as platform membership.';
comment on function public.platform_set_assistant_policy(uuid, text, boolean, text) is
  'Configures an organization''s assistant policy (0164). Since 0286 it demands '
  '`policy.configure` as well as platform membership.';
