-- P22 -- 30-day trial, 7-day grace, then DB-authoritative read-only.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p22_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P22 trial assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p22_actor(p_user uuid, p_fresh boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user,
    'role', 'authenticated',
    'amr', case when p_fresh then jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())
    )) else '[]'::jsonb end
  )::text, true);
end
$$;

insert into public.organizations (id, name, status) values
  ('1a220000-0000-4000-8000-000000000001', 'P22 active', 'active'),
  ('1a220000-0000-4000-8000-000000000002', 'P22 trial', 'active'),
  ('1a220000-0000-4000-8000-000000000003', 'P22 grace', 'active'),
  ('1a220000-0000-4000-8000-000000000004', 'P22 expired', 'active'),
  ('1a220000-0000-4000-8000-000000000005', 'P22 platform', 'active');

insert into auth.users (id, email) values
  ('2a220000-0000-4000-8000-000000000001', 'active-p22@example.test'),
  ('2a220000-0000-4000-8000-000000000002', 'trial-p22@example.test'),
  ('2a220000-0000-4000-8000-000000000003', 'grace-p22@example.test'),
  ('2a220000-0000-4000-8000-000000000004', 'expired-p22@example.test'),
  ('2a220000-0000-4000-8000-000000000005', 'platform-p22@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('2a220000-0000-4000-8000-000000000001', '1a220000-0000-4000-8000-000000000001', 'P22 active owner', 'owner'),
  ('2a220000-0000-4000-8000-000000000002', '1a220000-0000-4000-8000-000000000002', 'P22 trial owner', 'owner'),
  ('2a220000-0000-4000-8000-000000000003', '1a220000-0000-4000-8000-000000000003', 'P22 grace owner', 'owner'),
  ('2a220000-0000-4000-8000-000000000004', '1a220000-0000-4000-8000-000000000004', 'P22 expired owner', 'owner'),
  ('2a220000-0000-4000-8000-000000000005', '1a220000-0000-4000-8000-000000000005', 'P22 platform owner', 'owner');
insert into public.platform_admins (user_id, note)
values ('2a220000-0000-4000-8000-000000000005', 'P22 platform operator');

-- 0285 routes this command through private.assert_platform_command, so platform membership is
-- no longer enough on its own: the operator must hold the capability too. super_admin is what this
-- fixture always meant -- an operator with unrestricted authority -- and 0151:165 backfilled every
-- operator that existed to exactly that. p104 is where the NARROWED operator is proved refused.
insert into public.platform_admin_roles (user_id, role_key)
values ('2a220000-0000-4000-8000-000000000005', 'super_admin');

insert into public.categories (org_id, name, sort)
values ('1a220000-0000-4000-8000-000000000004', 'expired readable fixture', 1);

-- Fixture state transitions use the same explicit platform-writer latch as the production RPC.
select pg_temp.p22_actor('2a220000-0000-4000-8000-000000000005', true);
select set_config('app.organization_lifecycle_writer', '2a220000-0000-4000-8000-000000000005', true);
update public.organizations set status = 'trial', trial_ends_at = statement_timestamp() + interval '20 days'
where id = '1a220000-0000-4000-8000-000000000002';
update public.organizations set status = 'trial', trial_ends_at = statement_timestamp() - interval '2 days'
where id = '1a220000-0000-4000-8000-000000000003';
update public.organizations set status = 'trial', trial_ends_at = statement_timestamp() - interval '8 days'
where id = '1a220000-0000-4000-8000-000000000004';
select set_config('app.organization_lifecycle_writer', '', true);

insert into public.categories (org_id, name, sort) values
  ('1a220000-0000-4000-8000-000000000001', 'active fixture', 1),
  ('1a220000-0000-4000-8000-000000000002', 'trial fixture', 1),
  ('1a220000-0000-4000-8000-000000000003', 'grace fixture', 1);

-- Default provisioning contract: a null trial end is filled with 30 days, never unlimited.
insert into public.organizations (id, name) values
  ('1a220000-0000-4000-8000-000000000006', 'P22 default trial');
select pg_temp.p22_assert(
  (select status = 'trial'
          and trial_ends_at between statement_timestamp() + interval '29 days 23 hours'
                                and statement_timestamp() + interval '30 days 1 minute'
   from public.organizations where id = '1a220000-0000-4000-8000-000000000006'),
  'new tenant did not receive the 30-day trial default');

-- Grace is still fully writable.
select pg_temp.p22_actor('2a220000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.p22_assert(public.organization_write_allowed(), 'grace tenant was not writable');
select pg_temp.p22_assert(
  (select access_mode = 'grace' and grace_days_remaining between 1 and 5
   from public.organization_access_state()),
  'grace state/countdown was not returned canonically');
insert into public.categories (org_id, name, sort)
values ('1a220000-0000-4000-8000-000000000003', 'grace write', 2);
reset role;

-- Expired tenants retain SELECT but every DML shape fails with the named read-only error.
select pg_temp.p22_actor('2a220000-0000-4000-8000-000000000004');
set local role authenticated;
select pg_temp.p22_assert(not public.organization_write_allowed(), 'expired tenant was writable');
select pg_temp.p22_assert(
  (select access_mode = 'read_only' and grace_days_remaining is null
   from public.organization_access_state()),
  'expired tenant did not receive read_only state');
select pg_temp.p22_assert(
  (select count(*) = 1 from public.categories),
  'expired tenant SELECT did not remain tenant-scoped');

do $$
begin
  insert into public.categories (org_id, name, sort)
  values ('1a220000-0000-4000-8000-000000000004', 'must fail', 1);
  raise exception 'expected expired insert rejection';
exception when insufficient_privilege then
  if sqlerrm not like '%organization_read_only%' then raise; end if;
end
$$;

do $$
begin
  update public.organizations set name = 'must fail'
  where id = '1a220000-0000-4000-8000-000000000004';
  raise exception 'expected expired organization update rejection';
exception when insufficient_privilege then
  if sqlerrm not like '%organization_read_only%' then raise; end if;
end
$$;

do $$
begin
  insert into storage.objects (bucket_id, name, owner, metadata) values (
    'documents',
    '1a220000-0000-4000-8000-000000000004/expired.png',
    '2a220000-0000-4000-8000-000000000004',
    '{"mimetype":"image/png","size":100}'::jsonb
  );
  raise exception 'expected expired storage upload rejection';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- service_role/RLS bypass cannot bypass the row trigger.
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
begin
  update public.categories
     set org_id = '1a220000-0000-4000-8000-000000000001'
   where org_id = '1a220000-0000-4000-8000-000000000004';
  raise exception 'expected expired OLD tenant move rejection';
exception when insufficient_privilege then
  if sqlerrm not like '%organization_read_only%' then raise; end if;
end
$$;
do $$
begin
  insert into public.categories (org_id, name, sort)
  values ('1a220000-0000-4000-8000-000000000004', 'service bypass', 1);
  raise exception 'expected service-role expired insert rejection';
exception when insufficient_privilege then
  if sqlerrm not like '%organization_read_only%' then raise; end if;
end
$$;
reset role;

-- Trial extension is platform-only, future-dated, reasoned and step-up protected.
select pg_temp.p22_actor('2a220000-0000-4000-8000-000000000005', false);
set local role authenticated;
do $$
begin
  perform public.set_organization_lifecycle(
    '1a220000-0000-4000-8000-000000000004', 'trial',
    statement_timestamp() + interval '30 days', 'P22 stale extension'
  );
  raise exception 'expected fresh authentication requirement';
exception when insufficient_privilege then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;

-- Reactivation is also a write-enabling lifecycle transition and must fail on stale auth.
select pg_temp.p22_actor('2a220000-0000-4000-8000-000000000005', false);
set local role authenticated;
do $$
begin
  perform public.set_organization_lifecycle(
    '1a220000-0000-4000-8000-000000000004', 'active',
    statement_timestamp() + interval '30 days', 'P22 stale reactivation'
  );
  raise exception 'expected fresh authentication for reactivation';
exception when insufficient_privilege then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;

-- Suspension is equally sensitive: a stolen/stale platform JWT must not make a tenant read-only.
select pg_temp.p22_actor('2a220000-0000-4000-8000-000000000005', false);
set local role authenticated;
do $$
begin
  perform public.set_organization_lifecycle(
    '1a220000-0000-4000-8000-000000000001', 'suspended', null,
    'P22 stale suspension attempt'
  );
  raise exception 'expected fresh authentication for suspension';
exception when insufficient_privilege then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;

select pg_temp.p22_actor('2a220000-0000-4000-8000-000000000005', true);
set local role authenticated;
select public.set_organization_lifecycle(
  '1a220000-0000-4000-8000-000000000004', 'trial',
  statement_timestamp() + interval '30 days', 'P22 approved extension'
);
reset role;
select pg_temp.p22_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = '1a220000-0000-4000-8000-000000000004'
      and user_id = '2a220000-0000-4000-8000-000000000005'
      and action = 'organization_lifecycle_changed'
      and reason = 'P22 approved extension'
  ),
  'extension did not preserve platform actor/reason in audit');
set local role authenticated;
select public.set_organization_lifecycle(
  '1a220000-0000-4000-8000-000000000004', 'active',
  statement_timestamp() + interval '30 days', 'P22 reactivate active'
);
select pg_temp.p22_assert(
  (select status = 'active' from public.organizations
   where id = '1a220000-0000-4000-8000-000000000004'),
  'reactivation did not produce active status');
reset role;

-- Future tenant tables cannot silently omit the DB write latch.
select pg_temp.p22_assert(
  not exists (
    select 1
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'org_id'
      and t.table_type = 'BASE TABLE'
      and c.table_name <> 'security_events'
      and not exists (
        select 1 from pg_catalog.pg_trigger trigger_row
        join pg_catalog.pg_class table_row on table_row.oid = trigger_row.tgrelid
        join pg_catalog.pg_namespace schema_row on schema_row.oid = table_row.relnamespace
        where schema_row.nspname = 'public'
          and table_row.relname = c.table_name
          and trigger_row.tgname = 'zz_organization_write_guard'
          and not trigger_row.tgisinternal
      )
  ),
  'an org-owned table is missing the read-only write trigger');

rollback;
