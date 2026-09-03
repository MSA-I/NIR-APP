-- 0297 — the signup rollback needs a teardown the Edge function can reach. Wave 3.
--
-- THE LIVE EVIDENCE IS AN ORPHAN IN PRODUCTION NAMED `QA-AGENT10-DO-NOT-KEEP`, and the cause is
-- not "the compensation has a bug". Inserting ONE row into `organizations` fires five AFTER
-- INSERT triggers writing six tables, and the hand-written rollback deleted three of them. Two of
-- the rest — `private.referral_codes` (`0186:84`) and `private.organization_usage_anchors`
-- (`0185:65`) — are `on delete restrict`, so Postgres REFUSES `delete from organizations` while
-- they stand. Every self-signup that failed after the organization insert left the organization
-- behind, including the commonest failure of all: an address that is already registered, where
-- nothing but the organization and its trigger rows exists yet.
--
-- AND IT CANNOT BE FIXED IN THE EDGE FUNCTION. `supabase/config.toml:6` exposes `public` and
-- `graphql_public` to PostgREST, so a function holding the service key has NO route to either
-- blocker. Lengthening a list in TypeScript cannot work, and would drift again on the next
-- trigger somebody adds.
--
-- `0289` DOES NOT COVER THIS, and the plan overstated it before this was measured. It releases an
-- abandoned signup after 24 hours and refuses anything younger (`abandoned_signup_not_due`). A
-- next-day sweep bounds how long the debris lives; it does not repair the rollback, and a
-- prospect who hits "sign up" twice in a minute is inside the window both times.
--
-- WHY THIS IS A WRAPPER AND NOT NEW TEARDOWN CODE. The database already owns a complete
-- teardown: `private.delete_tenant_rows` walks the registry in foreign-key order, breaks
-- reference cycles first, repeats until a pass removes nothing, and raises
-- `tenant_delete_orphans_remain` if a stage is left holding a row. All six blockers are in that
-- registry, and `service_cleanup_abandoned_signup` already calls it. A second teardown would be a
-- second thing to keep complete, and the first one to fall behind a new trigger.
--
-- THE FENCE, AND THE ONE FENCE DELIBERATELY LEFT OUT. Age (owner ruling #348, fifteen minutes,
-- named once in a function rather than sprinkled as a literal) and zero business activity, both
-- re-derived under the row lock because the caller's belief is not the authority. NOT fenced on
-- `private.organization_owner_verified`, although `0289` is: `admin-provision` creates owners
-- with `email_confirm: true`, so an owner-verified condition would refuse exactly the door whose
-- rollback is most likely to be needed — shipping a rollback that silently does not roll back,
-- which is the defect this file exists to end.
--
-- Filed as a request by the Wave 3 agent, which does not own `supabase/migrations/`; the number,
-- the header and the ruling reference are the migration owner's. The failure-injection gate that
-- proves it is `supabase/functions/_shared/provision-rollback.test.ts`, whose positive control
-- (the pre-fix body restored) fails six of its seven cases and names the surviving rows.

-- =====================================================================================
-- 1. The window, named once (0289's pattern)
-- =====================================================================================
create function private.provisioning_rollback_window()
returns interval
language sql
immutable
set search_path = public, pg_temp
as $$
  select interval '15 minutes'
$$;
revoke all on function private.provisioning_rollback_window()
  from public, anon, authenticated, service_role;

comment on function private.provisioning_rollback_window() is
  'How long after creation an organization may still be torn down as a FAILED PROVISION '
  'rather than as an abandoned signup. owner ruling #348: fifteen minutes. It bounds '
  'a compensation for a request that is still in flight, so it is minutes and not days; '
  'anything older is private.abandoned_signup_grace()''s business. Change this body, not a '
  'call site.';

-- =====================================================================================
-- 2. The rollback door
-- =====================================================================================
create function public.service_rollback_provisioned_tenant(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     public.organizations;
  v_removed jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_org_id is null then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  -- Locked, then re-derived under the lock. Everything below is decided here and not by
  -- whatever the caller believed when it sent the id.
  select * into v_org from public.organizations where id = p_org_id for update;
  if not found then
    -- Already gone is the outcome the caller wanted. Reporting it as an error would make a
    -- retried rollback look like a failure and push an operator towards deleting by hand.
    return jsonb_build_object('org_id', p_org_id, 'removed', '{}'::jsonb, 'already_absent', true);
  end if;

  if now() - v_org.created_at >= private.provisioning_rollback_window() then
    raise exception 'provisioning_rollback_window_passed' using errcode = '22023';
  end if;
  if private.organization_has_business_activity(v_org.id) then
    raise exception 'provisioning_rollback_has_activity' using errcode = '42501';
  end if;

  -- 0175 made the raw audit ledger immutable: DELETE is refused unconditionally unless the
  -- transaction declares an authorized purge. The declaration has to open AROUND
  -- delete_tenant_rows, which is the call that removes audit_logs; opening it only around
  -- the organization-row deletion leaves the ledger outside the window and the guard refuses.
  perform set_config('app.audit_purge', 'organization_teardown', true);
  v_removed := private.delete_tenant_rows(v_org.id);
  perform private.delete_tenant_organization_row(v_org.id);
  perform set_config('app.audit_purge', '', true);

  -- No cleanup-log row, and that is deliberate: private.abandoned_signup_cleanup_log records
  -- RETENTION decisions about tenants that existed. A provisioning rollback is the removal of
  -- something that never came into being, and a row there would put failed signups into a
  -- ledger an operator reads as "customers we released".
  return jsonb_build_object('org_id', v_org.id, 'removed', v_removed, 'already_absent', false);
end
$$;

revoke all on function public.service_rollback_provisioned_tenant(uuid) from public, anon, authenticated;
grant execute on function public.service_rollback_provisioned_tenant(uuid) to service_role;

comment on function public.service_rollback_provisioned_tenant(uuid) is
  'Compensates a FAILED tenant provisioning by removing the organization and every tenant '
  'row through private.delete_tenant_rows. Fenced on age '
  '(private.provisioning_rollback_window()) and on zero business activity, both re-derived '
  'under the row lock. Called by supabase/functions/_shared/provision.ts; a hand-written '
  'compensation cannot do this because PostgREST does not expose the private schema, where '
  'two on-delete-restrict children of every new organization live (0185:65, 0186:84).';

-- =====================================================================================
-- 3. Structural re-assertion (mandatory after 0057)
-- =====================================================================================
do $assert_rollback_scope$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_rollback_scope$;

-- =====================================================================================
-- 4. Anchors
-- =====================================================================================
do $anchor_rollback$
begin
  if has_function_privilege('anon', 'public.service_rollback_provisioned_tenant(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.service_rollback_provisioned_tenant(uuid)', 'execute') then
    raise exception 'a browser role can tear down a tenant';
  end if;
  if not has_function_privilege('service_role', 'public.service_rollback_provisioned_tenant(uuid)', 'execute') then
    raise exception 'the provisioning rollback is unreachable from the Edge function that needs it';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'provisioning_rollback_window'
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('service_role', p.oid, 'execute'))
  ) then
    raise exception 'the rollback window function is readable outside the server';
  end if;

  -- SECURITY DEFINER with a pinned search_path, like every other service_* door.
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = 'public.service_rollback_provisioned_tenant(uuid)'::regprocedure
      and p.prosecdef
      and array_to_string(p.proconfig, ',') like '%search_path=%'
  ) then
    raise exception 'the provisioning rollback lost SECURITY DEFINER or its pinned search_path';
  end if;

  -- The two fences and the registry call, read off the body that is actually installed. A
  -- rollback that lost the age fence would be a service-role door onto any tenant at all.
  if (select position('provisioning_rollback_window' in p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'public.service_rollback_provisioned_tenant(uuid)'::regprocedure) = 0 then
    raise exception 'the provisioning rollback has no age fence';
  end if;
  if (select position('organization_has_business_activity' in p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'public.service_rollback_provisioned_tenant(uuid)'::regprocedure) = 0 then
    raise exception 'the provisioning rollback does not re-check business activity under the lock';
  end if;
  if (select position('private.delete_tenant_rows(' in p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'public.service_rollback_provisioned_tenant(uuid)'::regprocedure) = 0 then
    raise exception 'the provisioning rollback does not use the registry teardown, so it will drift';
  end if;
  if (select position('for update' in p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'public.service_rollback_provisioned_tenant(uuid)'::regprocedure) = 0 then
    raise exception 'the provisioning rollback re-checks nothing under a lock';
  end if;
end
$anchor_rollback$;
