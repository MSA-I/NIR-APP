-- p107 -- a failed signup leaves nothing behind, and a real tenant survives every attempt to
-- reach it through the same door.
--
-- The suite the Wave 3 brief asked for by name: "a failure-injection gate proving zero leftovers
-- immediately". `public.service_rollback_provisioned_tenant` was written, reviewed five times and
-- rewritten four -- and until this file, NOTHING RAN IT. Its only caller is
-- `supabase/functions/_shared/provision.ts`, which no suite exercises, so every property below
-- was an argument in a migration header rather than a measurement.
--
-- WHAT THIS PROVES, and why each case is here rather than trusted:
--   1. The compensation actually compensates: a two-minute-old organization whose only member is
--      the profile the attempt itself created leaves ZERO rows behind, counted across every public
--      table that carries an org_id -- not across a hand-picked list of five that would pass while
--      the sixth leaked.
--   2. Each of the three fences refuses BY NAME, and a refusal changes nothing. A fence that
--      raised the wrong error would still look like a refusal to a caller that only catches.
--   3. The named profile is deleted INSIDE the transaction, after the fences. Round 3 of the
--      review deleted it from the Edge function first and committed that, which left a tenant
--      holding its business data with no owner when the fences then refused. The activity case
--      here is the one that catches a regression to that shape: the fence refuses, and the profile
--      must still be standing.
--   4. Naming a profile that belongs to somebody ELSE does not open the member fence. The
--      exclusion is `p.id <> p_attempt_profile_id` over the tenant's own members, so a foreign id
--      excludes nobody and the real member still refuses.
--   5. An organization that is already gone is reported, not raised on -- a compensation that
--      throws on a partly-completed rollback cannot be retried.
--   7. The address the attempt registered is RELEASED with the tenant, and the two carve-outs
--      hold. Running the real signup end to end is what found this: the teardown left zero tenant
--      rows and an `auth.users` row, and a second signup with the same address returned the
--      endpoint's one reassuring sentence while creating nothing at all -- the address unusable
--      for ever, with nobody able to say why. `0313` copied `0289`'s rule; a CONFIRMED address
--      (which is what the federated branch attaches) and a platform operator both survive.
--   6. The door itself: no browser role holds EXECUTE, a non-service caller is refused by name,
--      the one-argument form does not resolve, and the second parameter has NO DEFAULT, so the
--      caller cannot decline to name the attempt. That last one is here because the assertion that
--      preceded it -- `to_regprocedure` on the one-argument signature -- answers for a DEFAULTED
--      parameter too, and passed for a full review round while the door stood open.
--
-- What this file deliberately does NOT prove, because it is not true: that the named profile
-- BELONGS to the failed attempt. It is a caller assertion, and a service_role holder can name a
-- legitimate young tenant's only owner. That is the open disagreement of the review, recorded in
-- DEBT-REGISTER section 110 -- not something a suite can assert its way out of.
--
-- THE SEVENTH CASE IS NOT IN THE GATE LABEL, AND THAT IS DELIBERATE. `check:baseline-drift`
-- identifies a gate step by its label, so sharpening the label of a suite that already exists
-- reads as the suite LEAVING CI -- the one thing that guard exists to catch. The claim therefore
-- lives here, in the file that makes it, where it can grow without lying to the guard.
--
-- Runs inside one transaction and rolls back. Every organization it may delete is registered in a
-- containment table first and the deleting helper refuses an id that is not in it: a test that can
-- reach a row it did not create is the worst outcome this file could have.

begin;

create table pg_temp.p107_fixture_orgs (org_id uuid primary key);

create function pg_temp.p107_fixture_only(p_org_id uuid)
returns uuid language plpgsql as $$
begin
  if not exists (select 1 from pg_temp.p107_fixture_orgs where org_id = p_org_id) then
    raise exception 'P107 BLAST RADIUS: % was not created by this transaction', p_org_id;
  end if;
  return p_org_id;
end
$$;

create function pg_temp.p107_service_claims()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
end
$$;

create function pg_temp.p107_refuses(p_org_id uuid, p_profile_id uuid, p_expect text)
returns boolean language plpgsql as $$
begin
  perform pg_temp.p107_service_claims();
  perform public.service_rollback_provisioned_tenant(
    pg_temp.p107_fixture_only(p_org_id), p_profile_id);
  return false;
exception when others then
  -- A containment breach is never "a refusal" -- let it out.
  if sqlerrm like '%BLAST RADIUS%' then raise; end if;
  return sqlerrm like '%' || p_expect || '%';
end
$$;

-- Every public table carrying an org_id, counted generically. A leak into a table the fixture
-- never wrote to is exactly the leak a hand-written list misses.
create function pg_temp.p107_tenant_rows(p_org_id uuid)
returns bigint language plpgsql as $$
declare
  v_table record;
  v_rows  bigint;
  v_total bigint := 0;
begin
  for v_table in
    select candidate.relname::text as table_name
    from pg_catalog.pg_class candidate
    join pg_catalog.pg_namespace space on space.oid = candidate.relnamespace
    where space.nspname = 'public' and candidate.relkind = 'r'
      and exists (
        select 1 from pg_catalog.pg_attribute column_info
        where column_info.attrelid = candidate.oid and column_info.attname = 'org_id'
          and column_info.attnum > 0 and not column_info.attisdropped)
    order by candidate.relname
  loop
    execute format('select count(*) from public.%I where org_id = $1', v_table.table_name)
      into v_rows using p_org_id;
    v_total := v_total + v_rows;
  end loop;
  return v_total;
end
$$;

-- ===== Fixture =====
insert into auth.users (id, email, email_confirmed_at) values
  ('a7000000-0000-4000-8000-000000000001', 'p107-failed@example.test',    null),
  ('a7000000-0000-4000-8000-000000000002', 'p107-old@example.test',       null),
  ('a7000000-0000-4000-8000-000000000003', 'p107-busy@example.test',      null),
  ('a7000000-0000-4000-8000-000000000004', 'p107-neighbour@example.test', null),
  -- A CONFIRMED address, which is the shape the federated branch attaches: an account that
  -- already existed and proved itself. Releasing it over a failed provision would destroy a real
  -- person's identity, so it must survive the teardown of the tenant it was attached to.
  ('a7000000-0000-4000-8000-000000000005', 'p107-federated@example.test', now()),
  -- Unconfirmed, but a platform operator. Staff standing lives on a different axis.
  ('a7000000-0000-4000-8000-000000000006', 'p107-operator@example.test',  null);

insert into public.organizations (id, name, status, created_at) values
  ('a7000000-0000-4000-8000-0000000000a1', 'P107 failed provision', 'active', now() - interval '2 minutes'),
  ('a7000000-0000-4000-8000-0000000000a2', 'P107 past the window',  'active', now() - interval '20 minutes'),
  ('a7000000-0000-4000-8000-0000000000a3', 'P107 did business',     'active', now() - interval '2 minutes'),
  ('a7000000-0000-4000-8000-0000000000a4', 'P107 real tenant',      'active', now() - interval '2 minutes'),
  ('a7000000-0000-4000-8000-0000000000a5', 'P107 federated owner',  'active', now() - interval '2 minutes'),
  ('a7000000-0000-4000-8000-0000000000a6', 'P107 operator owner',   'active', now() - interval '2 minutes');

insert into pg_temp.p107_fixture_orgs (org_id)
select id from public.organizations
where id between 'a7000000-0000-4000-8000-0000000000a1'
              and 'a7000000-0000-4000-8000-0000000000a6';

insert into public.profiles (id, org_id, full_name, role, active) values
  ('a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000a1', 'P107 attempt owner', 'owner', true),
  ('a7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-0000000000a2', 'P107 old attempt',   'owner', true),
  ('a7000000-0000-4000-8000-000000000003', 'a7000000-0000-4000-8000-0000000000a3', 'P107 busy attempt',  'owner', true),
  -- The real tenant's own member. Nobody named it, and it is what makes case 4 a refusal.
  ('a7000000-0000-4000-8000-000000000004', 'a7000000-0000-4000-8000-0000000000a4', 'P107 real member',   'owner', true),
  ('a7000000-0000-4000-8000-000000000005', 'a7000000-0000-4000-8000-0000000000a5', 'P107 federated owner', 'owner', true),
  ('a7000000-0000-4000-8000-000000000006', 'a7000000-0000-4000-8000-0000000000a6', 'P107 operator owner',  'owner', true);

insert into public.platform_admins (user_id, note)
values ('a7000000-0000-4000-8000-000000000006', 'P107 operator who also opened a tenant');

-- One row of real business, so the activity fence has something to find.
insert into public.suppliers (org_id, name)
values ('a7000000-0000-4000-8000-0000000000a3', 'P107 first supplier');

do $suite$
declare
  v_result jsonb;
  v_before bigint;
  v_after  bigint;
begin
  -- ===== 6a. A non-service caller is refused by name =====
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated')::text, true);
  begin
    perform public.service_rollback_provisioned_tenant(
      pg_temp.p107_fixture_only('a7000000-0000-4000-8000-0000000000a1'),
      'a7000000-0000-4000-8000-000000000001');
    raise exception 'p107.6: a non-service caller ran the rollback';
  exception when sqlstate '42501' then
    if sqlerrm not like '%service_role_required%' then raise; end if;
  end;

  -- ===== 2a. Past the window, by name =====
  if not pg_temp.p107_refuses('a7000000-0000-4000-8000-0000000000a2',
                              'a7000000-0000-4000-8000-000000000002',
                              'provisioning_rollback_window_passed') then
    raise exception 'p107.2: an organization past the rollback window was torn down';
  end if;
  if (select count(*) from public.organizations
      where id = 'a7000000-0000-4000-8000-0000000000a2') <> 1 then
    raise exception 'p107.2: the organization is gone despite the window refusal';
  end if;

  -- ===== 2b + 3. Business activity refuses, AND the named profile survives the refusal =====
  if not pg_temp.p107_refuses('a7000000-0000-4000-8000-0000000000a3',
                              'a7000000-0000-4000-8000-000000000003',
                              'provisioning_rollback_has_activity') then
    raise exception 'p107.2: an organization that did business was torn down';
  end if;
  -- THE regression case. Deleting the profile before the fences -- and committing it, as round 3
  -- did from the Edge function -- leaves a tenant with its supplier row and nobody who can sign in.
  if (select count(*) from public.profiles
      where id = 'a7000000-0000-4000-8000-000000000003') <> 1 then
    raise exception 'p107.3: a REFUSED rollback deleted the profile anyway, leaving an ownerless tenant';
  end if;
  if (select count(*) from public.suppliers
      where org_id = 'a7000000-0000-4000-8000-0000000000a3') <> 1 then
    raise exception 'p107.2: a refused rollback removed business rows';
  end if;

  -- ===== 2c + 4. A member nobody named refuses, and naming a FOREIGN profile does not help =====
  if not pg_temp.p107_refuses('a7000000-0000-4000-8000-0000000000a4', null,
                              'provisioning_rollback_tenant_in_use') then
    raise exception 'p107.2: a tenant with a member was torn down when nobody was named';
  end if;
  if not pg_temp.p107_refuses('a7000000-0000-4000-8000-0000000000a4',
                              'a7000000-0000-4000-8000-000000000001',
                              'provisioning_rollback_tenant_in_use') then
    raise exception 'p107.4: naming another tenant''s profile excused a real member';
  end if;
  if (select count(*) from public.profiles
      where org_id = 'a7000000-0000-4000-8000-0000000000a4') <> 1 then
    raise exception 'p107.4: the real tenant lost its member to a refused rollback';
  end if;

  -- ===== 1. The compensation compensates, and leaves NOTHING =====
  v_before := pg_temp.p107_tenant_rows('a7000000-0000-4000-8000-0000000000a1');
  if v_before = 0 then
    raise exception 'p107.1: the fixture wrote no tenant rows, so "zero after" would prove nothing';
  end if;
  perform pg_temp.p107_service_claims();
  v_result := public.service_rollback_provisioned_tenant(
    pg_temp.p107_fixture_only('a7000000-0000-4000-8000-0000000000a1'),
    'a7000000-0000-4000-8000-000000000001');
  if coalesce((v_result ->> 'already_absent')::boolean, true) then
    raise exception 'p107.1: the rollback reported the organization as already absent';
  end if;
  v_after := pg_temp.p107_tenant_rows('a7000000-0000-4000-8000-0000000000a1');
  if v_after <> 0 then
    raise exception 'p107.1: the rollback left % tenant row(s) behind, of % written', v_after, v_before;
  end if;
  if (select count(*) from public.organizations
      where id = 'a7000000-0000-4000-8000-0000000000a1') <> 0 then
    raise exception 'p107.1: the organization row itself survived its own rollback';
  end if;

  -- ===== 7a. The address is released, and the result says so =====
  if (select count(*) from auth.users
      where id = 'a7000000-0000-4000-8000-000000000001') <> 0 then
    raise exception 'p107.7: the address is still registered in GoTrue, so it can never sign up again';
  end if;
  if (v_result -> 'removed' ->> 'auth_identities')::int <> 1 then
    raise exception 'p107.7: the rollback did not report the identity it released';
  end if;

  -- ===== 5. Already gone is reported, not raised on =====
  perform pg_temp.p107_service_claims();
  v_result := public.service_rollback_provisioned_tenant(
    pg_temp.p107_fixture_only('a7000000-0000-4000-8000-0000000000a1'),
    'a7000000-0000-4000-8000-000000000001');
  if not coalesce((v_result ->> 'already_absent')::boolean, false) then
    raise exception 'p107.5: a second rollback did not report the organization as absent';
  end if;

  -- ===== 7b. A CONFIRMED address survives the teardown of the tenant it was attached to =====
  -- The federated branch attaches an account that already existed and proved itself. Deleting it
  -- over an unrelated failed provision would be far worse than the leak this release closes.
  perform pg_temp.p107_service_claims();
  v_result := public.service_rollback_provisioned_tenant(
    pg_temp.p107_fixture_only('a7000000-0000-4000-8000-0000000000a5'),
    'a7000000-0000-4000-8000-000000000005');
  if (select count(*) from public.organizations
      where id = 'a7000000-0000-4000-8000-0000000000a5') <> 0 then
    raise exception 'p107.7: the federated tenant was not rolled back';
  end if;
  if (select count(*) from auth.users
      where id = 'a7000000-0000-4000-8000-000000000005') <> 1 then
    raise exception 'p107.7: a rollback destroyed a real account that had proved its own address';
  end if;
  if (v_result -> 'removed' ->> 'auth_identities')::int <> 0 then
    raise exception 'p107.7: a confirmed account was counted as released';
  end if;

  -- ===== 7c. A platform operator keeps their console account =====
  perform pg_temp.p107_service_claims();
  v_result := public.service_rollback_provisioned_tenant(
    pg_temp.p107_fixture_only('a7000000-0000-4000-8000-0000000000a6'),
    'a7000000-0000-4000-8000-000000000006');
  if (select count(*) from public.organizations
      where id = 'a7000000-0000-4000-8000-0000000000a6') <> 0 then
    raise exception 'p107.7: the operator-owned tenant was not rolled back';
  end if;
  if (select count(*) from auth.users
      where id = 'a7000000-0000-4000-8000-000000000006') <> 1 then
    raise exception 'p107.7: a rollback deleted a platform operator''s console account';
  end if;
  if (v_result -> 'removed' ->> 'auth_identities')::int <> 0 then
    raise exception 'p107.7: the operator identity was counted as released';
  end if;

  -- The neighbours are untouched. A teardown that scanned without anchoring on org_id would have
  -- taken them with it.
  if (select count(*) from public.organizations
      where id in ('a7000000-0000-4000-8000-0000000000a2',
                   'a7000000-0000-4000-8000-0000000000a3',
                   'a7000000-0000-4000-8000-0000000000a4')) <> 3 then
    raise exception 'p107: the rollback reached beyond the organization it was given';
  end if;

  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);

  -- ===== 6b. The door, as a shape rather than as a behaviour =====
  if has_function_privilege('anon', 'public.service_rollback_provisioned_tenant(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.service_rollback_provisioned_tenant(uuid,uuid)', 'EXECUTE') then
    raise exception 'p107.6: a browser role can tear down a tenant';
  end if;
  if not has_function_privilege('service_role', 'public.service_rollback_provisioned_tenant(uuid,uuid)', 'EXECUTE') then
    raise exception 'p107.6: the rollback is unreachable by the only role that may run it';
  end if;
  if to_regprocedure('public.service_rollback_provisioned_tenant(uuid)') is not null then
    raise exception 'p107.6: the one-argument door -- the one that cannot name the attempt -- is back';
  end if;
  -- A DEFAULT makes the two-argument signature callable with one argument, which is the same door
  -- wearing a different shape. `to_regprocedure` above cannot see that; `pronargdefaults` can.
  if (select pronargdefaults from pg_catalog.pg_proc
      where oid = 'public.service_rollback_provisioned_tenant(uuid,uuid)'::regprocedure) <> 0 then
    raise exception 'p107.6: the rollback can be called without naming the attempt';
  end if;

  raise notice 'p107 passed: seven cases';
end
$suite$;

rollback;
