-- 0313 — a rolled-back signup releases the address it registered, so the person can try again.
--
-- FOUND BY RUNNING THE PATH, WHICH IS THE POINT. The Wave 3 brief said the successful signup had
-- never been exercised end to end and must not be silently skipped. It was run: `public-signup`
-- against the local stack, a real tenant provisioned (organization active, owner profile active,
-- an `auth.users` row unconfirmed with a password nobody holds), then the real rollback called on
-- it. The teardown removed 38 rows across nine tables and left ZERO tenant rows behind.
--
-- And left the `auth.users` row standing.
--
-- WHY THAT IS NOT UNTIDINESS. The next thing measured was a second signup with the SAME address.
-- It returned `pending_confirmation` -- the endpoint answers one sentence for every email-shaped
-- outcome ON PURPOSE, so it cannot be used to discover who has an account -- and created NOTHING.
-- No organization, no profile. The address is permanently unusable, the product says a
-- confirmation mail is on the way, and nobody can tell the person why. `service_cleanup_abandoned_signup`
-- will never reach it either: that job scans ORGANIZATIONS past a grace window, and the
-- organization is exactly what the rollback removed.
--
-- THIS IS THE FAILURE `0289` ALREADY FIXED, ON THE OTHER TEARDOWN OF THE SAME SIGNUP. There are
-- two: one for a signup ABANDONED (nobody confirmed, a day passes) and one for a signup that
-- FAILED (a provisioning step threw, seconds later). `0289` gave the first one the identity
-- release and wrote down why -- "still registered in GoTrue, unable to sign up again, with nobody
-- able to say why". The second one never got it, and it is the more common of the two: the
-- abandoned path needs a person to walk away, the failed path needs one bad deploy.
--
-- SO THIS MIGRATION COPIES `0289`'s RULE RATHER THAN INVENTING A SECOND ONE, carve-outs included:
--
--   * `email_confirmed_at is null`. This is not a nicety, it is what makes the change safe on the
--     FEDERATED branch: that path attaches an EXISTING Google or Microsoft account and writes a
--     profile for it, and that account is confirmed by construction. Deleting it would destroy a
--     real person's identity over an unrelated failed provision. Confirmed means kept.
--   * Never a `platform_admins` row. Staff standing lives on a different axis, and a compensation
--     job must not be able to remove a console account as a side effect.
--   * The delete happens AFTER `delete_tenant_organization_row`, because nine `on delete restrict`
--     foreign keys point at `auth.users` and every one of them is a tenant row that has just gone.
--
-- WHAT IT DOES NOT FIX, and the answer is unchanged. `p_attempt_profile_id` is still a caller
-- ASSERTION rather than proof of a failed attempt -- DEBT-REGISTER section 110, the open
-- disagreement of the review. This migration does not widen that: the identity released is the one
-- the caller already names, under the same three fences, and it can only be an UNCONFIRMED
-- non-operator account. A `service_role` holder who could already delete a young tenant through
-- this door could already delete its profile; they now also delete an address nobody has proved.
-- The nonce is what closes that, and it belongs to the same piece of work as the signup path.

-- ---------------------------------------------------------------------------------------------
-- 1. The release, patched into the LIVE body through anchors.
-- ---------------------------------------------------------------------------------------------
-- Read from `pg_get_functiondef`, never re-declared from an ancestor: `0297`, `0305`, `0311` and
-- `0312` each rewrote this body, and reciting any one of them would silently revert the other
-- three. Each anchor is asserted to occur exactly once before it is used.
do $release_identity_0313$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.service_rollback_provisioned_tenant(uuid,uuid)'::regprocedure), e'\r', '');
  v_declare constant text :=
    'declare' || chr(10) ||
    '  v_org     public.organizations;' || chr(10) ||
    '  v_removed jsonb;' || chr(10) ||
    'begin';
  v_profile constant text :=
    '  if p_attempt_profile_id is not null then' || chr(10) ||
    '    delete from public.profiles' || chr(10) ||
    '    where org_id = v_org.id and id = p_attempt_profile_id;' || chr(10) ||
    '  end if;';
  v_return constant text :=
    '  perform set_config(''app.audit_purge'', '''', true);' || chr(10) || chr(10) ||
    '  return jsonb_build_object(''org_id'', v_org.id, ''removed'', v_removed, ''already_absent'', false);';
  v_patched text;

  procedure_anchor text;
  v_count integer;
begin
  if position('delete from auth.users' in v_definition) > 0 then
    return; -- already released; this migration is being re-applied
  end if;

  foreach procedure_anchor in array array[v_declare, v_profile, v_return] loop
    v_count := (length(v_definition) - length(replace(v_definition, procedure_anchor, '')))
               / length(procedure_anchor);
    if v_count <> 1 then
      raise exception '0313: anchor occurs % times, not once: %', v_count,
        left(procedure_anchor, 40);
    end if;
  end loop;

  v_patched := replace(v_definition, v_declare,
    'declare' || chr(10) ||
    '  v_org      public.organizations;' || chr(10) ||
    '  v_removed  jsonb;' || chr(10) ||
    '  -- The identity this attempt registered, captured BEFORE its profile goes, because the' || chr(10) ||
    '  -- profile is what proves the account belongs to this tenant. Null means "keep it".' || chr(10) ||
    '  v_identity uuid;' || chr(10) ||
    'begin');

  v_patched := replace(v_patched, v_profile,
    '  if p_attempt_profile_id is not null then' || chr(10) ||
    '    -- 0289''s rule, not a second one: an address that was never confirmed, belonging to' || chr(10) ||
    '    -- somebody who is not a platform operator. A CONFIRMED address is a real account -- the' || chr(10) ||
    '    -- federated branch attaches an existing Google or Microsoft one and writes a profile for' || chr(10) ||
    '    -- it -- and destroying that over a failed provision would be far worse than the leak.' || chr(10) ||
    '    select member.id into v_identity' || chr(10) ||
    '    from public.profiles member' || chr(10) ||
    '    join auth.users account on account.id = member.id' || chr(10) ||
    '    where member.org_id = v_org.id' || chr(10) ||
    '      and member.id = p_attempt_profile_id' || chr(10) ||
    '      and account.email_confirmed_at is null' || chr(10) ||
    '      and not exists (' || chr(10) ||
    '        select 1 from public.platform_admins operator where operator.user_id = member.id);' || chr(10) ||
    chr(10) ||
    '    delete from public.profiles' || chr(10) ||
    '    where org_id = v_org.id and id = p_attempt_profile_id;' || chr(10) ||
    '  end if;');

  v_patched := replace(v_patched, v_return,
    '  perform set_config(''app.audit_purge'', '''', true);' || chr(10) || chr(10) ||
    '  -- LAST, and not by accident: seven tables carry nine `on delete restrict` foreign keys to' || chr(10) ||
    '  -- auth.users, and every one of them is a tenant row that has just been removed above.' || chr(10) ||
    '  if v_identity is not null then' || chr(10) ||
    '    delete from auth.users account where account.id = v_identity;' || chr(10) ||
    '  end if;' || chr(10) ||
    '  v_removed := coalesce(v_removed, ''{}''::jsonb) || jsonb_build_object(' || chr(10) ||
    '    ''auth_identities'', case when v_identity is null then 0 else 1 end);' || chr(10) ||
    chr(10) ||
    '  return jsonb_build_object(''org_id'', v_org.id, ''removed'', v_removed, ''already_absent'', false);');

  execute v_patched;
end
$release_identity_0313$;

comment on function public.service_rollback_provisioned_tenant(uuid, uuid) is
  'Compensates a FAILED tenant provisioning: removes the organization and every tenant row through '
  'private.delete_tenant_rows, in ONE transaction under the organization row lock, and releases the '
  'auth.users row the attempt registered so the address can be used again -- 0289''s rule and its '
  'carve-outs, an unconfirmed address belonging to somebody who is not a platform operator, never a '
  'confirmed account (which is what the federated branch attaches). Fenced on age, on zero business '
  'activity, and on the tenant having no member other than the profile this attempt itself created, '
  'named by p_attempt_profile_id.';

-- ---------------------------------------------------------------------------------------------
-- 2. The privilege the release needs, asserted rather than discovered at 3am.
-- ---------------------------------------------------------------------------------------------
-- Same guard `0289` wrote for the other teardown, for the same reason: a definer function that
-- cannot delete from auth.users would refuse EVERY rollback rather than skip the release, turning
-- a leak into an outage.
do $assert_0313_grant$
declare
  v_owner name;
begin
  select pg_get_userbyid(p.proowner) into v_owner
  from pg_catalog.pg_proc p
  where p.oid = 'public.service_rollback_provisioned_tenant(uuid,uuid)'::regprocedure;

  if not has_table_privilege(v_owner, 'auth.users', 'delete') then
    raise exception '0313: % cannot delete from auth.users, so the rollback cannot release the '
      'address it registered.', v_owner;
  end if;
end
$assert_0313_grant$;

-- ---------------------------------------------------------------------------------------------
-- 3. Assertions, including the structural re-assertion every post-0057 migration owes.
-- ---------------------------------------------------------------------------------------------
do $assert_0313$
declare
  v_violations text;
  v_source text := (select prosrc from pg_catalog.pg_proc
                    where oid = 'public.service_rollback_provisioned_tenant(uuid,uuid)'::regprocedure);
begin
  if position('delete from auth.users' in v_source) = 0 then
    raise exception '0313: the rollback still strands the address it registered';
  end if;
  -- Both carve-outs, by name. A release without them is not the same change: one destroys a real
  -- federated account, the other removes a console operator.
  if position('email_confirmed_at is null' in v_source) = 0
     or position('platform_admins' in v_source) = 0 then
    raise exception '0313: the identity release lost a carve-out';
  end if;
  -- And all three fences survive, or a patch that reads as a fix is a loosening.
  if position('provisioning_rollback_window' in v_source) = 0
     or position('organization_has_business_activity' in v_source) = 0
     or position('for update' in v_source) = 0
     or position('p_attempt_profile_id' in v_source) = 0 then
    raise exception '0313: a fence was lost';
  end if;
  if (select pronargdefaults from pg_catalog.pg_proc
      where oid = 'public.service_rollback_provisioned_tenant(uuid,uuid)'::regprocedure) <> 0 then
    raise exception '0313: the rollback can be called without naming the attempt again';
  end if;
  if has_function_privilege('anon', 'public.service_rollback_provisioned_tenant(uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.service_rollback_provisioned_tenant(uuid,uuid)', 'execute') then
    raise exception '0313: a browser role can tear down a tenant';
  end if;
  if not has_function_privilege('service_role', 'public.service_rollback_provisioned_tenant(uuid,uuid)', 'execute') then
    raise exception '0313: the rollback is unreachable by the only role that may run it';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0313 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0313$;
