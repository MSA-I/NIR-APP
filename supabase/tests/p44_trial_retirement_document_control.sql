-- P43 -- Trial is retired and document control exposes only customer-safe owner read models.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p43_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P43 document-control assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p43_actor(
  p_user uuid,
  p_fresh boolean default false
) returns void language plpgsql as $$
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

create function pg_temp.p43_expect_error(p_sql text, p_fragment text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'P43 expected error containing %, statement succeeded: %', p_fragment, p_sql;
  exception when others then
    if sqlerrm like 'P43 expected error%' or position(p_fragment in sqlerrm) = 0 then
      raise;
    end if;
  end;
end
$$;

-- The schema itself makes Trial unreachable, without rewriting the historical enum or column.
select pg_temp.p43_assert(
  (select column_default like '%active%'
   from information_schema.columns
   where table_schema = 'public' and table_name = 'organizations' and column_name = 'status'),
  'organizations.status does not default to active');
select pg_temp.p43_assert(
  exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.organizations'::regclass
      and constraint_row.conname = 'organizations_trial_retired'
      and constraint_row.convalidated
      and pg_get_constraintdef(constraint_row.oid) like '%status <>%trial%'
      and pg_get_constraintdef(constraint_row.oid) like '%trial_ends_at IS NULL%'
  ),
  'the validated Trial-retirement constraint is missing or incomplete');
select pg_temp.p43_assert(
  not exists (
    select 1 from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.organizations'::regclass
      and trigger_row.tgname = 'organizations_default_trial_period'
      and not trigger_row.tgisinternal
  )
  and pg_catalog.to_regprocedure('private.organizations_default_trial_period()') is null,
  'the retired automatic Trial trigger/function still exists');
select pg_temp.p43_assert(
  not exists (
    select 1 from public.organizations
    where status = 'trial' or trial_ends_at is not null
  ),
  'a migrated organization still carries Trial state');

insert into public.organizations (id, name) values
  ('14300000-0000-4000-8000-000000000001', 'P43 active'),
  ('14300000-0000-4000-8000-000000000002', 'P43 suspended'),
  ('14300000-0000-4000-8000-000000000003', 'P43 offboarding'),
  ('14300000-0000-4000-8000-000000000004', 'P43 platform');

select pg_temp.p43_assert(
  (select bool_and(status = 'active' and trial_ends_at is null)
   from public.organizations where id::text like '14300000-0000-4000-8000-%'),
  'a newly provisioned organization did not start active without a deadline');

select pg_temp.p43_expect_error(
  $$insert into public.organizations (id, name, status)
    values ('14300000-0000-4000-8000-000000000005', 'P43 forbidden Trial', 'trial')$$,
  'trial');
select pg_temp.p43_expect_error(
  $$insert into public.organizations (id, name, trial_ends_at)
    values (
      '14300000-0000-4000-8000-000000000006', 'P43 forbidden deadline',
      statement_timestamp() + interval '30 days'
    )$$,
  'trial');

insert into auth.users (id, email) values
  ('24300000-0000-4000-8000-000000000001', 'active-owner-p43@example.test'),
  ('24300000-0000-4000-8000-000000000002', 'suspended-owner-p43@example.test'),
  ('24300000-0000-4000-8000-000000000003', 'offboarding-owner-p43@example.test'),
  ('24300000-0000-4000-8000-000000000004', 'platform-p43@example.test'),
  ('24300000-0000-4000-8000-000000000005', 'active-office-p43@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('24300000-0000-4000-8000-000000000001', '14300000-0000-4000-8000-000000000001', 'P43 active owner', 'owner'),
  ('24300000-0000-4000-8000-000000000002', '14300000-0000-4000-8000-000000000002', 'P43 suspended owner', 'owner'),
  ('24300000-0000-4000-8000-000000000003', '14300000-0000-4000-8000-000000000003', 'P43 offboarding owner', 'owner'),
  ('24300000-0000-4000-8000-000000000004', '14300000-0000-4000-8000-000000000004', 'P43 platform owner', 'owner'),
  ('24300000-0000-4000-8000-000000000005', '14300000-0000-4000-8000-000000000001', 'P43 active office', 'office');
insert into public.platform_admins (user_id, note)
values ('24300000-0000-4000-8000-000000000004', 'P43 platform operator');

-- 0286 routes this command through private.assert_platform_command, so platform membership is
-- no longer enough on its own: the operator must hold the capability too. super_admin is what this
-- fixture always meant -- an operator with unrestricted authority -- and 0151:165 backfilled every
-- operator that existed to exactly that. p104 is where the NARROWED operator is proved refused.
insert into public.platform_admin_roles (user_id, role_key)
values ('24300000-0000-4000-8000-000000000004', 'super_admin');

insert into public.categories (org_id, name, sort) values
  ('14300000-0000-4000-8000-000000000002', 'suspended readable fixture', 1),
  ('14300000-0000-4000-8000-000000000003', 'offboarding readable fixture', 1);

-- Active is the only writable mode, and its compatibility response has null legacy deadlines.
select pg_temp.p43_actor('24300000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p43_assert(public.organization_write_allowed(), 'an active organization was read-only');
select pg_temp.p43_assert(
  (select access_mode = 'active'
          and trial_ends_at is null
          and grace_ends_at is null
          and grace_days_remaining is null
   from public.organization_access_state()),
  'the active compatibility response is not canonical');
insert into public.categories (org_id, name, sort)
values ('14300000-0000-4000-8000-000000000001', 'active write succeeds', 1);
reset role;

-- The lifecycle RPC keeps its deployed signature but rejects every attempt to revive Trial.
select pg_temp.p43_actor('24300000-0000-4000-8000-000000000004', true);
set local role authenticated;
select pg_temp.p43_expect_error(
  $$select public.set_organization_lifecycle(
    '14300000-0000-4000-8000-000000000001', 'trial',
    statement_timestamp() + interval '30 days', 'P43 forbidden Trial transition'
  )$$,
  'trial_retired');
select public.set_organization_lifecycle(
  '14300000-0000-4000-8000-000000000002', 'suspended', null,
  'P43 verify suspended read-only state'
);
reset role;
select set_config('app.organization_lifecycle_writer', '', true);

-- Suspended users have no auth_org by design; the access-state definer must still identify them.
select pg_temp.p43_actor('24300000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p43_assert(public.auth_org() is null, 'suspended auth_org unexpectedly remained open');
select pg_temp.p43_assert(not public.organization_write_allowed(), 'a suspended organization was writable');
select pg_temp.p43_assert(
  (select access_mode = 'suspended'
          and trial_ends_at is null
          and grace_ends_at is null
          and grace_days_remaining is null
   from public.organization_access_state()),
  'the suspended compatibility response is missing or carries retired deadlines');
reset role;

-- Offboarding remains readable but every row/storage writer observes the same fenced latch.
select pg_temp.p43_actor('24300000-0000-4000-8000-000000000003', true);
set local role authenticated;
select public.request_organization_offboarding(
  '94300000-0000-4000-8000-000000000003'
);
select pg_temp.p43_assert(not public.organization_write_allowed(), 'an offboarding organization was writable');
select pg_temp.p43_assert(
  (select access_mode = 'offboarding'
          and trial_ends_at is null
          and grace_ends_at is null
          and grace_days_remaining is null
   from public.organization_access_state()),
  'the offboarding compatibility response is not canonical');
select pg_temp.p43_assert(
  (select count(*) = 1 from public.categories),
  'offboarding lost tenant-scoped read access');
select pg_temp.p43_expect_error(
  $$insert into public.categories (org_id, name, sort)
    values ('14300000-0000-4000-8000-000000000003', 'must fail', 2)$$,
  'organization_read_only');
reset role;
select set_config('app.organization_offboarding_writer_org', '', true);

-- Browser ACLs expose only the three customer-safe owner read models, not laboratory RPCs.
select pg_temp.p43_assert(
  has_function_privilege('authenticated',
    'public.get_document_operations_metrics(integer)', 'EXECUTE')
  and has_function_privilege('authenticated',
    'public.get_document_control_attempts(uuid,integer)', 'EXECUTE')
  and has_function_privilege('authenticated',
    'public.get_document_control_price_review_queue(integer)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.get_document_operations_metrics(integer)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.get_document_control_attempts(uuid,integer)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.get_document_control_price_review_queue(integer)', 'EXECUTE'),
  'the safe read-model execute grants are wrong');
select pg_temp.p43_assert(
  not has_function_privilege('authenticated',
    'public.get_document_processing_attempts(uuid,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.get_price_list_calibration_metrics(timestamptz,timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.get_price_list_calibration_queue(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.get_price_list_drift_metrics(integer)', 'EXECUTE'),
  'a retired technical RPC is still browser-executable');

select pg_temp.p43_assert(
  lower(pg_get_function_result(
    'public.get_document_control_attempts(uuid,integer)'::regprocedure
  )) !~ '(provider|model|token|prompt|schema|confidence|drift|cost|engine|last_error|stuck_reason)'
  and lower(pg_get_function_result(
    'public.get_document_control_price_review_queue(integer)'::regprocedure
  )) !~ '(provider|model|token|prompt|schema|confidence|drift|cost|engine)',
  'a customer read-model result exposes technical telemetry');

select pg_temp.p43_actor('24300000-0000-4000-8000-000000000001');
set local role authenticated;
select get_document_operations_metrics(30) as owner_metrics \gset
select pg_temp.p43_assert(
  (select count(*) = 10 from jsonb_object_keys(:'owner_metrics'::jsonb))
  and :'owner_metrics'::jsonb ?& array[
    'window_days', 'documents_waiting', 'documents_processing', 'documents_stuck',
    'documents_review_required', 'documents_failed', 'documents_completed', 'retry_count',
    'average_processing_duration_ms', 'last_processing_at'
  ],
  'the operations summary is not the exact customer-safe metric set');
select pg_temp.p43_assert(
  (select count(*) = 0 from public.get_document_control_attempts(null, 100))
  and (select count(*) = 0 from public.get_document_control_price_review_queue(50)),
  'empty owner read models returned unrelated tenant data');
reset role;

select pg_temp.p43_actor('24300000-0000-4000-8000-000000000005');
set local role authenticated;
select pg_temp.p43_expect_error(
  $$select public.get_document_operations_metrics(30)$$,
  'not_authorized');
select pg_temp.p43_expect_error(
  $$select * from public.get_document_control_attempts(null, 100)$$,
  'not_authorized');
select pg_temp.p43_expect_error(
  $$select * from public.get_document_control_price_review_queue(50)$$,
  'not_authorized');
reset role;

select pg_temp.p43_assert(
  not exists (
    select 1
    from (values
      ('get_document_operations_metrics(integer)'::text),
      ('get_document_control_attempts(uuid,integer)'::text),
      ('get_document_control_price_review_queue(integer)'::text)
    ) expected(function_signature)
    left join private.scope_definer_enforcements enforcement
      on enforcement.function_signature = expected.function_signature
    left join pg_catalog.pg_proc proc
      on proc.oid = pg_catalog.to_regprocedure(expected.function_signature)
    where enforcement.function_signature is null
       or enforcement.enforcement_kind <> 'filtered_read'
       or enforcement.body_hash <> md5(replace(proc.prosrc, e'\r', ''))
  ),
  'a safe read-model body is not pinned in the scope-enforcement ledger');
select pg_temp.p43_assert(
  not exists (select 1 from private.scope_enforcement_violations()),
  'the scope-enforcement assertions have violations');

rollback;
