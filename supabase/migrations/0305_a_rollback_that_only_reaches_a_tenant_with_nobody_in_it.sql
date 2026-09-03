-- 0305 — the provisioning rollback may only reach a tenant that never got a user.
-- Codex review round 1, finding 12.
--
-- WHAT THE REVIEW CAUGHT. `0297` fenced the rollback on age (fifteen minutes) and on zero
-- business activity, both re-derived under the row lock. Neither of those says "this call is
-- compensating a provisioning attempt that failed". So **any holder of `service_role` could
-- delete a perfectly legitimate organization** that happened to be less than fifteen minutes old
-- and had not yet done anything — and a brand-new paying customer is exactly that shape for the
-- first quarter of an hour of their life. The reviewer is right that a uuid is no protection
-- here: `service_role` can read the organization ids too.
--
-- THE FENCE THAT CLOSES IT: **no profile.** A failed provision, by construction, has no user
-- attached — `provisionTenant` inserts the organization, then creates the auth user over a
-- separate HTTP call, and only then writes the `profiles` row
-- (`supabase/functions/_shared/provision.ts:439,518`). Every failure this door exists to
-- compensate happens at or before that user step, so the tenant it is aimed at has nobody in it.
-- A provisioning run that got as far as a profile is not a failed provision, and a tenant with a
-- member is somebody's business.
--
-- It is precise in both directions, which is why it is the fence and not merely another one:
--   * it does not narrow the door's real purpose — the in-flight window between the organization
--     insert and the profile insert is exactly when the rollback is called;
--   * it does not break `admin-provision`, whose failures are in the same window;
--   * and it turns "any young inactive tenant" into "a tenant that never had a user", which is
--     the definition of the thing being compensated rather than a proxy for it.
--
-- WHAT IT IS NOT, stated because the reviewer proposed something stronger and was not wrong to.
-- A per-attempt nonce — created with the organization, required by this function, consumed
-- atomically — would bind the call to ONE attempt rather than to a CLASS of tenants, and would
-- also refuse a replay of the same rollback. That is the stronger design. It is not taken here
-- because the token cannot live where the caller can read it (`service_role` reads every table),
-- so it would have to be stored as a digest with the plaintext held only in the Edge function's
-- memory across two HTTP calls — a new column on `organizations`, a registry schema-hash move,
-- and a change to the one code path in this product that has never been exercised end to end.
-- The profile fence removes the damage the reviewer described, with none of that. If the nonce is
-- wanted, it is a migration of its own and the argument for it is recorded here rather than lost.
--
-- ANCHORED, NOT REDECLARED, and read with the carriage returns stripped.

do $patch_rollback_0305$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.service_rollback_provisioned_tenant(uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  if position('provisioning_rollback_tenant_in_use' in v_definition) > 0 then
    return; -- already fenced; this migration is being re-applied
  end if;

  v_anchor := $anchor$  if now() - v_org.created_at >= private.provisioning_rollback_window() then
    raise exception 'provisioning_rollback_window_passed' using errcode = '22023';
  end if;$anchor$;
  v_replacement := $replacement$  if now() - v_org.created_at >= private.provisioning_rollback_window() then
    raise exception 'provisioning_rollback_window_passed' using errcode = '22023';
  end if;

  -- NOBODY IN IT. A failed provision has no user attached: the organization is inserted, the auth
  -- user is created over a separate call, and the profile is written only after that. So a tenant
  -- with a profile is not a failed provision -- it is somebody's business, and before 0305 any
  -- holder of service_role could delete it for the first fifteen minutes of its life.
  if exists (select 1 from public.profiles p where p.org_id = v_org.id) then
    raise exception 'provisioning_rollback_tenant_in_use' using errcode = '42501';
  end if;$replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0305: rollback window anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_rollback_0305$;

comment on function public.service_rollback_provisioned_tenant(uuid) is
  'Compensates a FAILED tenant provisioning by removing the organization and every tenant row '
  'through private.delete_tenant_rows. Fenced on age (private.provisioning_rollback_window()), on '
  'zero business activity, and from 0305 on the tenant having NO PROFILE -- a failed provision has '
  'no user attached, so a tenant with a member is somebody''s business and not debris. All three '
  'are re-derived under the row lock. Called by supabase/functions/_shared/provision.ts; a '
  'hand-written compensation cannot do this because PostgREST does not expose the private schema, '
  'where two on-delete-restrict children of every new organization live (0185:65, 0186:84).';

do $assert_0305$
declare
  v_source text := (select prosrc from pg_proc
                    where oid = 'public.service_rollback_provisioned_tenant(uuid)'::regprocedure);
  v_violations text;
begin
  if position('provisioning_rollback_tenant_in_use' in v_source) = 0 then
    raise exception '0305: the rollback still reaches a tenant that has a member';
  end if;
  -- The two fences 0297 argued for must survive the patch. A replacement that dropped one while
  -- adding another would read as a hardening and be a loosening.
  if position('provisioning_rollback_window' in v_source) = 0 then
    raise exception '0305: the age fence was lost';
  end if;
  if position('organization_has_business_activity' in v_source) = 0 then
    raise exception '0305: the activity fence was lost';
  end if;
  if position('for update' in v_source) = 0 then
    raise exception '0305: the fences are no longer re-derived under a lock';
  end if;
  -- And the door is still service-role only.
  if has_function_privilege('authenticated', 'public.service_rollback_provisioned_tenant(uuid)', 'execute')
     or has_function_privilege('anon', 'public.service_rollback_provisioned_tenant(uuid)', 'execute') then
    raise exception '0305: a browser role can tear down a tenant';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0305 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0305$;
