-- 0311 — the rollback becomes one transaction again, and a live lockout survives its migration.
-- Codex review round 4, findings 3 and 2.
--
-- ---------------------------------------------------------------------------------------------
-- FINDING 3 (HIGH) — the profile sweep was a separate transaction, before the fences.
--
-- Round 3 had `rollbackTenant` delete the attempt's profile over PostgREST and THEN call the
-- teardown. Two transactions, and the reviewer found what falls between them:
--
--   the federated profile is created and committed. The authenticated owner does something —
--   anything that counts as business activity. A later provisioning step fails. The rollback
--   deletes the profile and COMMITS that. Only then does the RPC evaluate its fences, find the
--   activity, and refuse to remove the organization.
--
-- The tenant is left with its business data and NO OWNER PROFILE — nobody can sign in to it, and
-- the rollback reported a failure that had already destroyed something. My fix for finding 4 of
-- round 2 created that window; the reviewer is right that org id plus profile id is also not
-- proof the row belongs to this attempt, and the fix for both is the same: do it in ONE place,
-- under the lock the RPC already takes.
--
-- So the profile the attempt created is named TO the rollback, and the rollback deletes it after
-- its fences pass and inside the same transaction as the teardown. Either everything goes or
-- nothing does — which is what a compensation is.
--
-- The fence keeps its meaning: a tenant with a member that is not this attempt's own profile is
-- somebody's business and is still refused. Passing null keeps the old behaviour exactly, so the
-- ordinary path is unchanged.
--
-- ---------------------------------------------------------------------------------------------
-- FINDING 2 (MEDIUM) — `0310` reset a live failure run to zero.
--
-- `add column failed_at ... default '{}'` gave every existing row an empty array. A row sitting
-- at nine failures a minute ago became a row with no failures, and the next attempt built an
-- array of one and was allowed. On a real deployment that is a lockout quietly lifted at the
-- moment the migration runs — the one moment an attacker cannot predict, but also cannot be
-- relied upon not to hit.
--
-- Unlike round 4's other backfill defect this one IS repairable from the row: `failed_count` and
-- `last_failed_at` are still there. The reconstruction is deliberately conservative — every
-- surviving failure is dated at `last_failed_at`, the most recent moment it could have been — so
-- the run is preserved and never lengthened.

-- ---------------------------------------------------------------------------------------------
-- 1. One transaction for the rollback.
-- ---------------------------------------------------------------------------------------------
create or replace function public.service_rollback_provisioned_tenant(
  p_org_id uuid, p_attempt_profile_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
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

  select * into v_org from public.organizations where id = p_org_id for update;
  if not found then
    return jsonb_build_object('org_id', p_org_id, 'removed', '{}'::jsonb, 'already_absent', true);
  end if;

  if now() - v_org.created_at >= private.provisioning_rollback_window() then
    raise exception 'provisioning_rollback_window_passed' using errcode = '22023';
  end if;

  -- NOBODY IN IT, except the profile this attempt itself created. A failed provision has no user
  -- attached in the ordinary path; the federated path attaches an EXISTING account and writes a
  -- profile for it, which is the row named here. Any OTHER member means somebody's business.
  if exists (
    select 1 from public.profiles p
    where p.org_id = v_org.id
      and (p_attempt_profile_id is null or p.id <> p_attempt_profile_id)
  ) then
    raise exception 'provisioning_rollback_tenant_in_use' using errcode = '42501';
  end if;
  if private.organization_has_business_activity(v_org.id) then
    raise exception 'provisioning_rollback_has_activity' using errcode = '42501';
  end if;

  -- Only now, and inside this transaction. Deleting it before the fences -- and in a separate
  -- PostgREST call -- left a tenant with its business data and no owner when the fences then
  -- refused. Either everything goes or nothing does.
  if p_attempt_profile_id is not null then
    delete from public.profiles
    where org_id = v_org.id and id = p_attempt_profile_id;
  end if;

  -- 0175 made the raw audit ledger immutable: DELETE is refused unless the transaction declares
  -- an authorized purge, and the declaration has to open AROUND delete_tenant_rows, which is the
  -- call that removes audit_logs.
  perform set_config('app.audit_purge', 'organization_teardown', true);
  v_removed := private.delete_tenant_rows(v_org.id);
  perform private.delete_tenant_organization_row(v_org.id);
  perform set_config('app.audit_purge', '', true);

  return jsonb_build_object('org_id', v_org.id, 'removed', v_removed, 'already_absent', false);
end
$function$;

revoke all on function public.service_rollback_provisioned_tenant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.service_rollback_provisioned_tenant(uuid, uuid) to service_role;

comment on function public.service_rollback_provisioned_tenant(uuid, uuid) is
  'Compensates a FAILED tenant provisioning: removes the organization and every tenant row through '
  'private.delete_tenant_rows, in ONE transaction under the organization row lock. Fenced on age, '
  'on zero business activity, and on the tenant having no member other than the profile this '
  'attempt itself created -- named by p_attempt_profile_id, which the federated path needs because '
  'it attaches an existing account and writes a profile for it. Deleting that profile from the '
  'Edge function beforehand (0305 + round 3) left a tenant with business data and no owner when '
  'the fences then refused, which is why it happens here.';

-- The single-argument form goes: leaving it would keep a door that cannot name the attempt, and
-- every caller is `service_role` code in this repository.
drop function if exists public.service_rollback_provisioned_tenant(uuid);

-- ---------------------------------------------------------------------------------------------
-- 2. A live failure run survives 0310.
-- ---------------------------------------------------------------------------------------------
-- `array_fill` rather than an aggregate over `generate_series`: an aggregate that reads the row
-- being updated is not allowed in an UPDATE target, and the value is the same instant repeated.
update private.password_attempt_counters
set failed_at = array_fill(last_failed_at, array[least(failed_count, 10)])
where cardinality(failed_at) = 0
  and failed_count > 0
  and last_failed_at is not null
  and last_failed_at > now() - interval '15 minutes';

do $assert_0311$
declare
  v_violations text;
  v_source text := (select prosrc from pg_proc
                    where oid = 'public.service_rollback_provisioned_tenant(uuid,uuid)'::regprocedure);
begin
  if to_regprocedure('public.service_rollback_provisioned_tenant(uuid)') is not null then
    raise exception '0311: the door that cannot name the attempt is still there';
  end if;
  if position('p_attempt_profile_id' in v_source) = 0 then
    raise exception '0311: the rollback cannot name the profile it created';
  end if;
  if position('delete from public.profiles' in v_source) = 0 then
    raise exception '0311: the profile deletion did not move into the transaction';
  end if;
  -- All three fences must survive, or a patch that reads as a hardening is a loosening.
  if position('provisioning_rollback_window' in v_source) = 0
     or position('organization_has_business_activity' in v_source) = 0
     or position('for update' in v_source) = 0 then
    raise exception '0311: a fence was lost';
  end if;
  if has_function_privilege('authenticated', 'public.service_rollback_provisioned_tenant(uuid,uuid)', 'execute')
     or has_function_privilege('anon', 'public.service_rollback_provisioned_tenant(uuid,uuid)', 'execute') then
    raise exception '0311: a browser role can tear down a tenant';
  end if;
  -- And no counter may be left claiming a run it cannot evidence.
  if exists (
    select 1 from private.password_attempt_counters
    where cardinality(failed_at) = 0 and failed_count > 0
      and last_failed_at > now() - interval '15 minutes'
  ) then
    raise exception '0311: a live failure run was left with no timestamps';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0311 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0311$;
