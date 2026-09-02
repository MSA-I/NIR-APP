-- p105 -- an abandoned signup is released in a day, and its identity is released with it.
--
-- The suite for `0289`, which shortened #175's thirty-day window and made the cleanup release
-- the `auth.users` row along with the tenant.
--
-- WHAT THIS PROVES, and why each case is here rather than trusted:
--   1. The window is a named function, not a literal, and it reads 24 hours -- the documented
--      default #332 left pending an owner ruling. A suite that asserted "less than thirty days"
--      would pass on any number at all, which is the shape of an assertion that proves nothing.
--   2. An empty, unconfirmed organization older than that window is removed AND its owner's
--      `auth.users` row goes with it. 0196 released the tenant and left the identity standing,
--      which at thirty days was untidy and at twenty-four hours is an address held hostage: still
--      registered in GoTrue, unable to sign up again, with nobody able to say why.
--   3. An organization younger than the window is still refused by name. The fuse got shorter, not
--      absent.
--   4. The two refusals 0196 built are untouched: a confirmed owner and any business activity both
--      still stop the delete, and neither the organization nor the identity moves.
--   5. A platform operator's identity is NEVER deleted, even when they own the abandoned tenant.
--      Staff standing lives on a different axis (`platform_admins`); a data-retention job must not
--      be able to remove a console account as a side effect.
--   6. The retained record says how many identities were released, and still carries no PII.
--   7. No browser role can run any of it, and the command still refuses a caller that is not
--      service_role.
--
-- Runs entirely inside one transaction and rolls back. Every organization it may delete is
-- registered in a containment table first and the deleting helper refuses an id that is not in it:
-- a test that can reach a row it did not create is the worst outcome this file could have.

begin;

create table pg_temp.p105_fixture_orgs (org_id uuid primary key);

create function pg_temp.p105_fixture_only(p_org_id uuid)
returns uuid language plpgsql as $$
begin
  if not exists (select 1 from pg_temp.p105_fixture_orgs where org_id = p_org_id) then
    raise exception 'P105 BLAST RADIUS: % was not created by this transaction', p_org_id;
  end if;
  return p_org_id;
end
$$;

create function pg_temp.p105_service_claims()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
end
$$;

create function pg_temp.p105_refuses(p_org_id uuid, p_expect text)
returns boolean language plpgsql as $$
begin
  perform pg_temp.p105_service_claims();
  perform public.service_cleanup_abandoned_signup(pg_temp.p105_fixture_only(p_org_id));
  return false;
exception when others then
  -- A containment breach is never "a refusal" -- let it out.
  if sqlerrm like '%BLAST RADIUS%' then raise; end if;
  return sqlerrm like '%' || p_expect || '%';
end
$$;

-- ===== Fixture =====
insert into auth.users (id, email, email_confirmed_at) values
  ('a5000000-0000-4000-8000-000000000001', 'p105-abandoned@example.test', null),
  ('a5000000-0000-4000-8000-000000000002', 'p105-young@example.test',     null),
  ('a5000000-0000-4000-8000-000000000003', 'p105-verified@example.test',  now()),
  ('a5000000-0000-4000-8000-000000000004', 'p105-operator@example.test',  null),
  ('a5000000-0000-4000-8000-000000000005', 'p105-busy@example.test',      null);

insert into public.organizations (id, name, status, created_at) values
  ('a5000000-0000-4000-8000-0000000000a1', 'P105 abandoned empty', 'active', now() - interval '2 days'),
  ('a5000000-0000-4000-8000-0000000000a2', 'P105 young signup',    'active', now() - interval '2 hours'),
  ('a5000000-0000-4000-8000-0000000000a3', 'P105 verified owner',  'active', now() - interval '2 days'),
  ('a5000000-0000-4000-8000-0000000000a4', 'P105 operator owner',  'active', now() - interval '2 days'),
  ('a5000000-0000-4000-8000-0000000000a5', 'P105 did business',    'active', now() - interval '2 days');

insert into pg_temp.p105_fixture_orgs (org_id)
select id from public.organizations
where id between 'a5000000-0000-4000-8000-0000000000a1'
              and 'a5000000-0000-4000-8000-0000000000a5';

insert into public.profiles (id, org_id, full_name, role, active) values
  ('a5000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-0000000000a1', 'P105 abandoned owner', 'owner', true),
  ('a5000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-0000000000a2', 'P105 young owner',     'owner', true),
  ('a5000000-0000-4000-8000-000000000003', 'a5000000-0000-4000-8000-0000000000a3', 'P105 verified owner',  'owner', true),
  ('a5000000-0000-4000-8000-000000000004', 'a5000000-0000-4000-8000-0000000000a4', 'P105 operator owner',  'owner', true),
  ('a5000000-0000-4000-8000-000000000005', 'a5000000-0000-4000-8000-0000000000a5', 'P105 busy owner',      'owner', true);

-- The one identity that must survive its own tenant's removal.
insert into public.platform_admins (user_id, note)
values ('a5000000-0000-4000-8000-000000000004', 'P105 operator who also opened a trial');

-- One row of real business, so the activity refusal has something to find.
insert into public.suppliers (org_id, name)
values ('a5000000-0000-4000-8000-0000000000a5', 'P105 first supplier');

do $suite$
declare
  v_result   jsonb;
  v_released int;
begin
  -- ===== 1. The window is named, and it is the documented default =====
  if private.abandoned_signup_grace() <> interval '24 hours' then
    raise exception 'p105.1: the grace window is %, not the 24 hours #332 left as the default',
      private.abandoned_signup_grace();
  end if;
  -- Named rather than inlined, so the owner ruling moves one body and not five call sites.
  if (select position('abandoned_signup_grace' in p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'public.service_cleanup_abandoned_signup(uuid)'::regprocedure) = 0 then
    raise exception 'p105.1: the cleanup carries its window as a literal again';
  end if;

  -- ===== 3. Younger than the window is still refused, by name =====
  if not pg_temp.p105_refuses('a5000000-0000-4000-8000-0000000000a2', 'not_due') then
    raise exception 'p105.3: an organization inside the grace window was deleted';
  end if;
  if (select count(*) from public.organizations
      where id = 'a5000000-0000-4000-8000-0000000000a2') <> 1 then
    raise exception 'p105.3: the young organization is gone despite the refusal';
  end if;

  -- ===== 4. The two refusals 0196 built are untouched =====
  if not pg_temp.p105_refuses('a5000000-0000-4000-8000-0000000000a3', 'owner_verified') then
    raise exception 'p105.4: an organization whose owner confirmed their address was deleted';
  end if;
  if not pg_temp.p105_refuses('a5000000-0000-4000-8000-0000000000a5', 'has_activity') then
    raise exception 'p105.4: an organization that did business was deleted automatically';
  end if;
  -- The identity is released only WITH a successful deletion. A refusal that had already taken the
  -- auth row would be the worst of both: the tenant survives and its owner cannot sign in.
  if (select count(*) from auth.users
      where id in ('a5000000-0000-4000-8000-000000000003',
                   'a5000000-0000-4000-8000-000000000005')) <> 2 then
    raise exception 'p105.4: a refused cleanup deleted the identity anyway';
  end if;

  -- ===== 7a. service_role is still required =====
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated')::text, true);
  begin
    perform public.service_cleanup_abandoned_signup(
      pg_temp.p105_fixture_only('a5000000-0000-4000-8000-0000000000a1'));
    raise exception 'p105.7: a non-service caller ran the cleanup';
  exception when sqlstate '42501' then
    if sqlerrm not like '%service_role_required%' then raise; end if;
  end;

  -- ===== 2. Past the window: the tenant AND the identity are released =====
  perform pg_temp.p105_service_claims();
  v_result := public.service_cleanup_abandoned_signup(
    pg_temp.p105_fixture_only('a5000000-0000-4000-8000-0000000000a1'));
  if (v_result ->> 'org_id') <> 'a5000000-0000-4000-8000-0000000000a1' then
    raise exception 'p105.2: the two-day-old empty organization was not removed';
  end if;
  if (select count(*) from public.organizations
      where id = 'a5000000-0000-4000-8000-0000000000a1') <> 0
     or (select count(*) from public.profiles
         where org_id = 'a5000000-0000-4000-8000-0000000000a1') <> 0 then
    raise exception 'p105.2: the cleanup left tenant rows behind';
  end if;
  if (select count(*) from auth.users
      where id = 'a5000000-0000-4000-8000-000000000001') <> 0 then
    raise exception 'p105.2: the address is still registered in GoTrue, so it can never sign up again';
  end if;

  -- ===== 6. The retained record counts what it released, and still carries no PII =====
  v_released := (v_result -> 'removed' ->> 'auth_identities')::int;
  if v_released <> 1 then
    raise exception 'p105.6: the cleanup reported % identities released, not 1', v_released;
  end if;
  if (select (removed_row_counts ->> 'auth_identities')::int
      from private.abandoned_signup_cleanup_log
      where org_id = 'a5000000-0000-4000-8000-0000000000a1') <> 1 then
    raise exception 'p105.6: the retained record does not say the identity was released';
  end if;
  if exists (
    select 1 from private.abandoned_signup_cleanup_log entry
    where entry.org_id = 'a5000000-0000-4000-8000-0000000000a1'
      and entry.removed_row_counts::text ~* '(p105-abandoned|example\.test|P105 abandoned)') then
    raise exception 'p105.6: the retained record picked up raw PII from the deleted organization';
  end if;

  -- ===== 5. An operator keeps their console account when their trial is released =====
  perform pg_temp.p105_service_claims();
  v_result := public.service_cleanup_abandoned_signup(
    pg_temp.p105_fixture_only('a5000000-0000-4000-8000-0000000000a4'));
  if (select count(*) from public.organizations
      where id = 'a5000000-0000-4000-8000-0000000000a4') <> 0 then
    raise exception 'p105.5: the operator-owned abandoned organization was not removed';
  end if;
  if (select count(*) from auth.users
      where id = 'a5000000-0000-4000-8000-000000000004') <> 1 then
    raise exception 'p105.5: a data-retention job deleted a platform operator''s account';
  end if;
  if (v_result -> 'removed' ->> 'auth_identities')::int <> 0 then
    raise exception 'p105.5: the operator identity was counted as released';
  end if;

  -- The neighbours are untouched. A predicate that scanned without anchoring on org_id would have
  -- taken them with it.
  if (select count(*) from public.organizations
      where id in ('a5000000-0000-4000-8000-0000000000a2',
                   'a5000000-0000-4000-8000-0000000000a3',
                   'a5000000-0000-4000-8000-0000000000a5')) <> 3 then
    raise exception 'p105: the cleanup reached beyond the organization it was given';
  end if;

  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);

  -- ===== 7b. Nothing here is reachable from a browser =====
  if has_function_privilege('anon', 'public.service_cleanup_abandoned_signup(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.service_cleanup_abandoned_signup(uuid)', 'EXECUTE') then
    raise exception 'p105.7: a browser role can run the abandoned-signup cleanup';
  end if;
  if has_function_privilege('anon', 'private.abandoned_signup_grace()', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.abandoned_signup_grace()', 'EXECUTE')
     or has_function_privilege('service_role', 'private.abandoned_signup_grace()', 'EXECUTE') then
    raise exception 'p105.7: the cleanup window function is reachable outside the server';
  end if;

  raise notice 'p105 passed: seven cases';
end
$suite$;

rollback;
