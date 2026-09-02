-- 0289 -- An abandoned signup is released in a day, and the identity goes with the organization.
--
-- WHY THIS MOVED. Owner ruling #332 (02.09.2026) reversed the order of a self-signup: the account
-- is now created with NO password, and the first one is chosen only after the confirmation link has
-- proved who holds the address (`supabase/functions/_shared/provision.ts`). That changes what an
-- unconfirmed signup IS. Under 0159 it was a real account with a real password waiting for a click,
-- and thirty days of patience was the right answer (#175). Now it is a name, an address nobody
-- answered, and an auth row with nothing in it. Thirty days of holding somebody else's address
-- hostage — because a taken address is a taken address, confirmed or not — buys nothing.
--
-- THE WINDOW IS A DEFAULT PENDING OWNER RULING. #175 fixed thirty days for a shape that no longer
-- exists, and nobody has ruled on the replacement. `private.abandoned_signup_grace()` therefore
-- returns 24 hours as a DOCUMENTED DEFAULT, in one named place, so the ruling — when it comes —
-- moves one function body and not five call sites. `docs/OPEN-DECISIONS.md`'s rule applies: a
-- business question with no answer gets a written default, never a silent guess in a body.
--
-- WHAT DOES NOT MOVE, and the distinction is the point. This shortens the window for an EMPTY
-- organization whose owner never confirmed. An organization that did business still goes to the
-- operator quarantine queue at thirty days (`service_quarantine_abandoned_signups`), untouched:
-- #175 says an organization with activity is never removed automatically, and a shorter fuse on a
-- customer who actually started working would be the opposite of what was decided. The day-7 and
-- final-3-day reminder ledger is likewise left exactly as it is. It is inert (#236: no mail
-- provider), and its rows now cascade away with the organization long before they come due —
-- stated here rather than deleted, because the cadence belongs to whoever answers the window
-- question, not to this migration.
--
-- AND THE AUTH ROW GOES TOO. 0196 released the organization, the profile and the tenant rows, and
-- left `auth.users` standing. That was survivable at thirty days and is not at twenty-four hours:
-- an address released by the cleanup but still registered in GoTrue is an address that can never
-- sign up again, and the person it belongs to has no way to discover why. The identity is captured
-- BEFORE `delete_tenant_rows` (which removes the profiles it is read from) and deleted AFTER the
-- organization row, so a failure anywhere in between rolls the whole thing back rather than
-- leaving an account with no tenant.
--
-- One profile per identity is what makes that safe: `profiles.id` is the primary key AND the
-- foreign key to `auth.users` (0001:32), so an auth user belongs to at most one organization and
-- deleting it can never orphan a second tenant's member. A platform operator is excluded anyway —
-- staff standing lives on a different axis (`platform_admins`), and an operator who also happens to
-- own an abandoned trial must not lose their console account to a data-retention job.
--
-- WHAT COULD STILL REFUSE THE DELETE, and why refusing is the right answer. Seven tables carry an
-- `on delete restrict` foreign key to `auth.users`: six of them name the OPERATOR who acted
-- (`referral_grants.granted_by`, `billing_provider_boundary.enabled_by`,
-- `inbound_channel_boundary.enabled_by`, `customer_internal_notes.author`,
-- `customer_onboarding_steps.recorded_by`, `organization_entitlement_overrides.granted_by`) and the
-- seventh (`price_list_automation_scope_decisions.decided_by`) is a tenant table that
-- `delete_tenant_rows` removes first -- and any row in it would have counted as activity and
-- stopped the cleanup two checks earlier. An owner who never confirmed an address is none of those
-- actors. If one of them ever does hold the row, the FK raises, the whole transaction rolls back,
-- and nothing is half-done: the tenant survives with its identity, which is the state a human can
-- still reason about.
--
-- Every anchor below is CR-stripped as well as the body it is matched against. A literal that git
-- checks out with CRLF would otherwise never match a definition normalised to LF -- the failure
-- that aborted the 0171-0205 rollout at 0181, and the reason `check:anchored-replacements` exists.

-- =====================================================================================
-- 1. The window, named once
-- =====================================================================================
create function private.abandoned_signup_grace()
returns interval
language sql
immutable
set search_path = public, pg_temp
as $$
  select interval '24 hours'
$$;
revoke all on function private.abandoned_signup_grace()
  from public, anon, authenticated, service_role;

comment on function private.abandoned_signup_grace() is
  'How long an EMPTY, unconfirmed self-signup is kept before it is released (#332). '
  'DEFAULT PENDING OWNER RULING: 24 hours. #175 fixed thirty days for accounts that carried a '
  'password chosen at signup; #332 removed the password from that moment, so the thirty days '
  'protected nothing and held the address. Change this body, not a call site.';

-- =====================================================================================
-- 2. The cleanup: a shorter fuse, and the identity released with the tenant
-- =====================================================================================
-- Anchored replacement, not a redeclaration. `service_cleanup_abandoned_signup` was created by
-- 0196 and has not been touched since, but re-issuing it from that text is how a security property
-- added in between gets silently reverted; the live body is the authority and each anchor below is
-- asserted before anything is replaced.
do $patch_abandoned_signup_cleanup$
declare
  v_signature regprocedure := 'public.service_cleanup_abandoned_signup(uuid)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');

  -- Anchor 1: the declaration block, so the captured identities have somewhere to live.
  v_declare_anchor text := replace($anchor1$declare
  v_org     public.organizations;
  v_removed jsonb;
  v_age     integer;
begin$anchor1$, e'\r', '');
  v_declare_replacement text := replace($replacement1$declare
  v_org        public.organizations;
  v_removed    jsonb;
  v_age        integer;
  v_identities uuid[];
begin$replacement1$, e'\r', '');

  -- Anchor 2: the age gate. `v_age` stays because the retained record counts in days; what changes
  -- is what "due" means, and it now asks a named function instead of carrying a literal.
  v_due_anchor text := replace($anchor2$  v_age := floor(extract(epoch from (now() - v_org.created_at)) / 86400)::integer;
  if v_age < 30 then
    raise exception 'abandoned_signup_not_due' using errcode = '22023';
  end if;$anchor2$, e'\r', '');
  v_due_replacement text := replace($replacement2$  v_age := floor(extract(epoch from (now() - v_org.created_at)) / 86400)::integer;
  if now() - v_org.created_at < private.abandoned_signup_grace() then
    raise exception 'abandoned_signup_not_due' using errcode = '22023';
  end if;$replacement2$, e'\r', '');

  -- Anchor 3: the identities are read while the profiles that name them still exist.
  v_capture_anchor text := replace($anchor3$  perform set_config('app.audit_purge', 'organization_teardown', true);
  v_removed := private.delete_tenant_rows(v_org.id);$anchor3$, e'\r', '');
  v_capture_replacement text := replace($replacement3$  select coalesce(array_agg(member.id), '{}'::uuid[]) into v_identities
  from public.profiles member
  where member.org_id = v_org.id
    and not exists (
      select 1 from public.platform_admins operator where operator.user_id = member.id);

  perform set_config('app.audit_purge', 'organization_teardown', true);
  v_removed := private.delete_tenant_rows(v_org.id);
  v_removed := v_removed
    || jsonb_build_object('auth_identities', coalesce(array_length(v_identities, 1), 0));$replacement3$, e'\r', '');

  -- Anchor 4: and released after the organization row, inside the same transaction.
  v_release_anchor text := replace($anchor4$  perform private.delete_tenant_organization_row(v_org.id);
  perform set_config('app.audit_purge', '', true);$anchor4$, e'\r', '');
  v_release_replacement text := replace($replacement4$  perform private.delete_tenant_organization_row(v_org.id);

  -- An address released by this job but still registered in GoTrue can never sign up again, and
  -- nobody can find out why. Refuse rather than half-finish: raising here rolls back the tenant
  -- deletion too, which is the honest outcome if the grant is ever taken away.
  if not has_table_privilege('auth.users', 'delete') then
    raise exception 'abandoned_signup_identity_not_released' using errcode = '42501';
  end if;
  delete from auth.users account where account.id = any(v_identities);

  perform set_config('app.audit_purge', '', true);$replacement4$, e'\r', '');
begin
  if position(v_declare_anchor in v_definition) = 0 then
    raise exception '0289: the cleanup declaration block is not where 0196 left it';
  end if;
  if position(v_due_anchor in v_definition) = 0 then
    raise exception '0289: the thirty-day gate is not where 0196 left it';
  end if;
  if position(v_capture_anchor in v_definition) = 0 then
    raise exception '0289: the audit-purge window around delete_tenant_rows moved';
  end if;
  if position(v_release_anchor in v_definition) = 0 then
    raise exception '0289: the organization-row deletion is not where 0196 left it';
  end if;
  -- 0196 put the lock and the two re-checks in this body, and they are the reason the report is
  -- not an authorization (p75 C3). Refusing to patch a body that lost them keeps the two from
  -- drifting apart silently, exactly as 0282 did for 0089's consent ancestry.
  if position('for update' in v_definition) = 0
     or position('abandoned_signup_owner_verified' in v_definition) = 0
     or position('abandoned_signup_has_activity' in v_definition) = 0 then
    raise exception '0289: refusing to patch the cleanup without its 0196 lock-and-recheck ancestry';
  end if;

  v_definition := replace(v_definition, v_declare_anchor, v_declare_replacement);
  v_definition := replace(v_definition, v_due_anchor, v_due_replacement);
  v_definition := replace(v_definition, v_capture_anchor, v_capture_replacement);
  v_definition := replace(v_definition, v_release_anchor, v_release_replacement);
  execute v_definition;
end
$patch_abandoned_signup_cleanup$;

comment on function public.service_cleanup_abandoned_signup(uuid) is
  'Removes one empty, unverified organization past private.abandoned_signup_grace() (#175, #332), '
  'and releases the auth identities that belonged to it. Locks the row and re-derives owner '
  'verification and activity inside the deleting transaction; the report is not authority.';

-- =====================================================================================
-- 3. The grant this now depends on, measured rather than assumed
-- =====================================================================================
-- Deleting from `auth.users` needs a privilege this repository has never exercised: 0127 UPDATEs
-- that table, and the SQL suites INSERT into it, but nothing has ever deleted from it. The function
-- is SECURITY DEFINER and therefore runs as its owner, so the question is about the owner and not
-- about `service_role`. Asked HERE, at apply time, because the alternative is discovering it inside
-- a scheduled job at three in the morning: a migration that aborts has changed nothing and names
-- its own remedy, while a cleanup that refuses every night is a silence with a green tick over it.
--
-- IF THIS FIRES, the fallback is the admin API rather than SQL: the identity release moves to the
-- Edge caller (the `outbox-worker` cron shape, `auth.admin.deleteUser`), the anchor above drops its
-- `delete from auth.users`, and the function returns `v_identities` for that caller to spend.
do $assert_0289_identity_grant$
declare
  v_owner name;
begin
  select pg_get_userbyid(p.proowner) into v_owner
  from pg_catalog.pg_proc p
  where p.oid = 'public.service_cleanup_abandoned_signup(uuid)'::regprocedure;

  if not has_table_privilege(v_owner, 'auth.users', 'delete') then
    raise exception '0289: % cannot delete from auth.users, so the cleanup cannot release the '
      'identity it removes the tenant for. Move the release to the Edge admin API (see the note '
      'above this assertion) rather than shipping a cleanup that refuses every night.', v_owner;
  end if;
end
$assert_0289_identity_grant$;

-- =====================================================================================
-- 4. Structural re-assertion (mandatory after 0057)
-- =====================================================================================
do $assert_0289$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0289 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0289 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0289$;

-- =====================================================================================
-- 5. Anchors
-- =====================================================================================
do $anchor_0289$
begin
  -- The window function is server-side only, like everything else 0196 put in `private`.
  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'abandoned_signup_grace'
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('service_role', p.oid, 'execute'))
  ) then
    raise exception '0289: a browser or service role can read the cleanup window function';
  end if;

  -- The cleanup stayed service-only. A grant that widened here would hand tenant deletion to a
  -- browser role, which is the one mistake this whole family of functions is shaped to prevent.
  if has_function_privilege('anon', 'public.service_cleanup_abandoned_signup(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.service_cleanup_abandoned_signup(uuid)', 'execute') then
    raise exception '0289: a browser role can run the abandoned-signup cleanup';
  end if;
  if not has_function_privilege('service_role', 'public.service_cleanup_abandoned_signup(uuid)', 'execute') then
    raise exception '0289: the anchored replacement dropped the service_role grant';
  end if;

  -- And it is still SECURITY DEFINER with a pinned search_path: `execute v_definition` replays
  -- whatever the live body said, so a patch that lost either property would be invisible here
  -- without this.
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = 'public.service_cleanup_abandoned_signup(uuid)'::regprocedure
      and p.prosecdef
      and array_to_string(p.proconfig, ',') like '%search_path=%'
  ) then
    raise exception '0289: the cleanup lost SECURITY DEFINER or its pinned search_path';
  end if;

  -- The behaviour this migration exists for, read off the body that is actually installed.
  if (select position('abandoned_signup_grace' in p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'public.service_cleanup_abandoned_signup(uuid)'::regprocedure) = 0 then
    raise exception '0289: the cleanup still carries a hardcoded window';
  end if;
  if (select position('delete from auth.users' in p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'public.service_cleanup_abandoned_signup(uuid)'::regprocedure) = 0 then
    raise exception '0289: the cleanup does not release the identity it removes the tenant for';
  end if;
  -- Captured BEFORE the profiles are deleted, or the array is always empty and the delete is a
  -- no-op that looks like it worked.
  --
  -- The needle is `private.delete_tenant_rows(` and not the bare name, because 0196's own comment
  -- discusses `delete_tenant_rows` four lines ABOVE the call it describes. `position()` returns the
  -- first occurrence, so the bare name would compare the capture against a COMMENT and report a
  -- correct body as broken -- the failure mode where a guard is wrong and confident.
  if (select position('array_agg(member.id)' in p.prosrc)
             < position('private.delete_tenant_rows(' in p.prosrc)
      from pg_catalog.pg_proc p
      where p.oid = 'public.service_cleanup_abandoned_signup(uuid)'::regprocedure) is not true then
    raise exception '0289: the identities are read after the profiles that name them are gone';
  end if;
end
$anchor_0289$;
