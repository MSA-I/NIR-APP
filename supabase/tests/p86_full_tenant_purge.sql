-- P86 -- the controlled purge, proven on a tenant that used the product (#261, DEBT §66).
-- Run only against an isolated local database with every migration applied. The transaction is
-- rolled back.
--
-- WHY THIS SUITE EXISTS. p75 already proves the four gates, the manifest replay, the per-tenant
-- re-lock and the staged delete -- on a tenant holding a supplier, a product and a comment. That
-- fixture is exactly why the gate stayed green while `private.delete_tenant_rows` halted on the
-- first real customer: an account that never used the product has no evidence rows, and evidence
-- rows are what refused. DEBT §66 measured two of them by running the code, not by reading it:
--
--   ERROR:  organization_external_egress_evidence_immutable
--   ERROR:  invoice_three_way_evidence_immutable
--
-- So the fixture here writes both of those before deleting anything, plus the residue that
-- carries no org_id and is therefore invisible to the delete graph, plus stored objects.
--
-- BLAST RADIUS. Every organization this file touches is created inside this transaction and
-- registered in pg_temp.p86_fixture_orgs; the manifest is checked against that table before the
-- executor runs, and the whole file rolls back. Nothing here can reach a row it did not create.
--
-- What it proves:
--   E1 -- the §66 register query is empty. Every BEFORE DELETE guard on a tenant table now honours
--         a declared teardown except the purge ledger, which is meant to outlive the tenant. This
--         is the claim that keeps the gap from coming back with the next evidence table.
--   E2 -- the window is a DELETE window and nothing more: inside a declared teardown, an UPDATE of
--         either evidence table is still refused by its own name.
--   E3 -- storage fails CLOSED. A tenant whose files are still stored is skipped by name, its
--         organization row survives, and not one tenant row is removed.
--   E4/E5 -- once the files are gone, the same tenant is purged and EVERY table in
--         private.tenant_delete_stages() answers zero for it.
--   E6 -- the six org-less private tables that hold tenant rows are empty for it too.
--   E7 -- nothing survives under {org_id}/ in any bucket.
--   E8 -- the purge reached exactly one tenant: the referrer organization and its own grant are
--         untouched, the organization row is gone, and the purge ledger survived the tenant.
--   E9 -- neither new function is reachable from a browser or a service key.
--
-- ONE THING THIS FILE CANNOT DO, STATED PLAINLY. Deleting the bytes is a Storage API call and SQL
-- cannot make one -- that is the whole finding behind the design. Where the operator's service
-- step would run, this file removes the storage.objects rows directly under
-- `storage.allow_delete_query`, the escape hatch Supabase's own protect_delete() trigger reads.
-- That stands in for the API call and is marked where it happens. What is NOT simulated is the
-- part that matters: the executor's refusal in E3 is the real code path, reached with real rows.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p86_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P86 full tenant purge assertion failed: %', p_message;
  end if;
end
$$;

-- The session-identity helper every platform suite uses (p50:17-33, p75:38-56).
create function pg_temp.p86_as(p_user uuid, p_fresh_password boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    case when p_user is null then '{}'::jsonb else jsonb_build_object(
      'sub', p_user,
      'role', 'authenticated',
      'amr', case when p_fresh_password then jsonb_build_array(jsonb_build_object(
        'method', 'password', 'timestamp', extract(epoch from clock_timestamp())
      )) else '[]'::jsonb end
    ) end::text,
    true
  );
end
$$;

create function pg_temp.p86_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end
$$;

create function pg_temp.p86_expect_error(p_sql text, p_fragment text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'P86 expected an error containing %, statement succeeded: %',
      p_fragment, p_sql;
  exception when others then
    if position(p_fragment in sqlerrm) = 0 then
      raise exception 'P86 expected an error containing %, got: %', p_fragment, sqlerrm;
    end if;
  end;
end
$$;

create temp table p86_fixture_orgs (org_id uuid primary key);

-- =====================================================================================
-- Fixture: one tenant that actually used the product, and one bystander
-- =====================================================================================
-- Written with no end-user subject, which is the seed/migration path every financial guard
-- already exempts by name (p1_financial_command_guard:8). Stated rather than inherited: a stray
-- claim left in the session would change which guard answers.
select pg_temp.p86_as(null);

insert into auth.users (id, email) values
  ('86100000-0000-4000-8000-000000000001', 'p86-owner@example.test'),
  ('86100000-0000-4000-8000-000000000002', 'p86-operator@example.test'),
  ('86100000-0000-4000-8000-000000000003', 'p86-bystander-owner@example.test');

-- Created active, for the reason p75:880-883 records: 0103 does not move organizations.status
-- when a tenant offboards, so 'active' IS the shape a purge target has.
insert into public.organizations (id, name, status) values
  ('86000000-0000-4000-8000-000000000001', 'P86 fully exercised tenant', 'active'),
  ('86000000-0000-4000-8000-000000000002', 'P86 referrer bystander',     'active'),
  -- A third organization exists only so the bystander can hold a referral and a grant that name
  -- NOBODY being purged. Without it the "did not reach beyond the tenant" check would be asserted
  -- against rows that the sweep was never asked to consider.
  ('86000000-0000-4000-8000-000000000003', 'P86 unrelated referred',     'active');

insert into pg_temp.p86_fixture_orgs (org_id)
select id from public.organizations
where id between '86000000-0000-4000-8000-000000000001'
             and '86000000-0000-4000-8000-000000000003';

insert into public.profiles (id, org_id, full_name, role) values
  ('86100000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001',
   'P86 owner', 'owner'),
  ('86100000-0000-4000-8000-000000000003', '86000000-0000-4000-8000-000000000002',
   'P86 bystander owner', 'owner');

insert into public.platform_admins (user_id, note) values
  ('86100000-0000-4000-8000-000000000002', 'P86 operator');
insert into public.platform_admin_roles (user_id, role_key) values
  ('86100000-0000-4000-8000-000000000002', 'super_admin');

-- ----- the invoice evidence that halted the purge -----
insert into public.suppliers (id, org_id, name) values
  ('86200000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001',
   'P86 supplier');

insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, currency
) values (
  '86300000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001',
  '86200000-0000-4000-8000-000000000001', 'P86-INV-1', current_date,
  100, 17, 117, 'ILS');

-- invoice_three_way_immutable_guard demands the named writer on INSERT; that IS the approval
-- path's own declaration and nothing about it is weakened here.
select set_config('app.invoice_three_way_writer', 'approval_snapshot', true);
insert into public.invoice_three_way_approval_snapshots (
  id, org_id, invoice_id, revision, assessment_hash, assessment, approved_by
) values (
  '86400000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001',
  '86300000-0000-4000-8000-000000000001', 1, repeat('a', 64),
  '{"p86": "approved"}'::jsonb, '86100000-0000-4000-8000-000000000001');
select set_config('app.invoice_three_way_writer', '', true);

-- ----- the egress evidence that halted the purge, written through the real command -----
select pg_temp.p86_service();
set local role service_role;
select result ->> 'lease_id' as lease_id, result ->> 'lease_token' as lease_token
from (select public.service_reserve_organization_external_egress(
  '86000000-0000-4000-8000-000000000001', 'integration_webhook',
  '86500000-0000-4000-8000-000000000001', 90
) result) reserved \gset p86_
select public.service_release_organization_external_egress(
  :'p86_lease_id'::uuid, :'p86_lease_token'::uuid, 'delivered', 'http_200', 200);
select public.service_settle_organization_external_egress_evidence(
  :'p86_lease_id'::uuid, :'p86_lease_token'::uuid, 'delivered', 'http_200', 200,
  '{"provider":"p86","result":{"marker":"p86-evidence"}}'::jsonb);
reset role;
select pg_temp.p86_as(null);

select pg_temp.p86_assert(
  exists (select 1 from public.invoice_three_way_approval_snapshots
          where org_id = '86000000-0000-4000-8000-000000000001')
  and exists (select 1 from private.organization_external_egress_evidence
              where org_id = '86000000-0000-4000-8000-000000000001'),
  'fixture: the two evidence rows DEBT §66 measured as blockers were not written, so this suite '
  || 'would prove nothing');

-- ----- the residue that carries no org_id -----
-- `sequence` is a GENERATED ALWAYS identity: the database assigns it, and naming it in the
-- column list is refused outright rather than ignored.
insert into public.domain_events (id, event_type, org_id, entity_type, entity_id)
values ('86600000-0000-4000-8000-000000000001', 'p86.tested',
        '86000000-0000-4000-8000-000000000001', 'invoice',
        '86300000-0000-4000-8000-000000000001');

insert into private.integration_outbox (id, org_id, event_id, target, correlation_id)
values ('86700000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001',
        '86600000-0000-4000-8000-000000000001', 'p86-webhook',
        '86500000-0000-4000-8000-000000000002');

insert into private.integration_deliveries (id, outbox_id, attempt, status)
values ('86800000-0000-4000-8000-000000000001', '86700000-0000-4000-8000-000000000001',
        1, 'failed');

insert into private.dead_letter_records
  (id, outbox_id, event_id, target, failure_reason, attempts)
values ('86800000-0000-4000-8000-000000000002', '86700000-0000-4000-8000-000000000001',
        '86600000-0000-4000-8000-000000000001', 'p86-webhook', 'p86 exhausted', 5);

insert into private.idempotency_keys (target, event_id, idempotency_key)
values ('p86-webhook', '86600000-0000-4000-8000-000000000001', 'p86-key-1');

-- ON DELETE RESTRICT straight into organizations, from both sides: without the residue sweep the
-- organization row is not deletable at all. referral_grants also holds a RESTRICT key into
-- organization_referrals, so the sweep has to remove the grant before the referral -- asserted
-- here by the fact that the purge succeeds at all.
insert into private.organization_referrals
  (referred_org_id, referrer_org_id, referral_code)
values ('86000000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000002',
        'P86-CODE-PURGED'),
       -- The bystander's other referral, naming nobody being purged. It must survive.
       ('86000000-0000-4000-8000-000000000003', '86000000-0000-4000-8000-000000000002',
        'P86-CODE-KEPT');

insert into private.referral_grants
  (id, referred_org_id, beneficiary_org_id, metric_key, period_start, period_end, quantity)
values ('86800000-0000-4000-8000-000000000003',
        '86000000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000002',
        'documents.included', now() - interval '30 days', now(), 50),
       ('86800000-0000-4000-8000-000000000004',
        '86000000-0000-4000-8000-000000000003', '86000000-0000-4000-8000-000000000002',
        'documents.included', now() - interval '30 days', now(), 10);

-- ----- stored objects, in more than one bucket -----
insert into storage.objects (bucket_id, name, metadata) values
  ('documents', '86000000-0000-4000-8000-000000000001/p86-invoice.pdf', '{"size": 10}'::jsonb),
  ('documents', '86000000-0000-4000-8000-000000000001/nested/p86-scan.pdf', '{"size": 10}'::jsonb),
  ('feedback', '86000000-0000-4000-8000-000000000001/p86-note.txt', '{"size": 4}'::jsonb),
  -- The bystander's file, one character away from the purged prefix. It must survive.
  ('documents', '86000000-0000-4000-8000-000000000002/p86-other.pdf', '{"size": 10}'::jsonb);

-- =====================================================================================
-- E1 -- the §66 register query is empty except for the ledger that is meant to survive
-- =====================================================================================
-- This is 0254's post-condition restated where it will keep being run. A future evidence table
-- that refuses DELETE unconditionally fails HERE, on a fixture, instead of failing on a real
-- customer deletion months later.
create function pg_temp.p86_undeclared_guards()
returns setof text language sql stable as $$
  with del_trig as (
    select distinct guard_schema.nspname || '.' || guard.proname as fn,
           replace(pg_get_functiondef(guard.oid), e'\r', '') as def
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class guarded on guarded.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace guarded_schema on guarded_schema.oid = guarded.relnamespace
    join pg_catalog.pg_proc guard on guard.oid = trigger_row.tgfoid
    join pg_catalog.pg_namespace guard_schema on guard_schema.oid = guard.pronamespace
    join pg_catalog.pg_attribute tenant_key on tenant_key.attrelid = guarded.oid
      and tenant_key.attname = 'org_id'
      and tenant_key.attnum > 0 and not tenant_key.attisdropped
    where not trigger_row.tgisinternal
      and guarded_schema.nspname in ('public', 'private')
      and (trigger_row.tgtype & 8) > 0
      and (trigger_row.tgtype & 2) > 0
  )
  select fn from del_trig
  where position('organization_teardown' in def) = 0
    and position('raise exception' in def) > 0
    and position('p1_financial_writer' in def) = 0
    and position('organization_lifecycle_writer' in def) = 0
    and fn <> 'private.reject_purge_ledger_change'
  order by fn
$$;

select pg_temp.p86_assert(
  not exists (select 1 from pg_temp.p86_undeclared_guards()),
  'E1: ' || coalesce((select string_agg(fn, ', ') from pg_temp.p86_undeclared_guards() fn), '')
  || ' still refuses a declared organization teardown -- a tenant that used the product cannot '
  || 'be deleted');

-- The check would be worthless if it could not see a real violation, so it is falsified: the one
-- guard deliberately left out IS returned when the exclusion is lifted.
select pg_temp.p86_assert(
  position('organization_teardown' in
           replace(pg_get_functiondef('private.reject_purge_ledger_change()'::regprocedure),
                   e'\r', '')) = 0,
  'E1: the purge ledger guard was given a teardown window -- the ledger is meant to outlive the '
  || 'tenant it records, and E1 would then be asserting nothing');

-- =====================================================================================
-- E2 -- a DELETE window, and nothing wider
-- =====================================================================================
-- Run BEFORE the offboarding request exists, so the refusal that comes back is the evidence
-- guard's own and not organization_row_write_guard refusing a read-only tenant.
select set_config('app.audit_purge', 'organization_teardown', true);
select pg_temp.p86_expect_error(
  $$update public.invoice_three_way_approval_snapshots
      set assessment = '{"rewritten": true}'::jsonb
    where id = '86400000-0000-4000-8000-000000000001'$$,
  'invoice_three_way_evidence_immutable');
select pg_temp.p86_expect_error(
  format($$update private.organization_external_egress_evidence
             set evidence = '{}'::jsonb where lease_id = %L::uuid$$, :'p86_lease_id'),
  'organization_external_egress_evidence_immutable');
select set_config('app.audit_purge', '', true);

-- And with no declaration at all, DELETE is refused exactly as before. The window is a door that
-- opens on a name, not a door that was removed.
select pg_temp.p86_expect_error(
  $$delete from public.invoice_three_way_approval_snapshots
    where id = '86400000-0000-4000-8000-000000000001'$$,
  'invoice_three_way_evidence_immutable');

-- =====================================================================================
-- Offboarding request and backup evidence -- the four gates p75 already proves
-- =====================================================================================
-- requested_at is eight years back because financial_records_retain_until is the binding
-- boundary (p75:914-917). legal_hold false, as p75 sets it.
insert into public.organization_offboarding_requests (
  id, org_id, status, request_idempotency_key, requested_by, requested_at,
  previous_org_status, cancellation_deadline, platform_reactivation_deadline,
  operational_purge_eligible_at, security_logs_retain_until, financial_records_retain_until,
  legal_hold, export_generation, export_completed_at, export_object_path, export_sha256,
  export_size_bytes, export_file_count
) values (
  '86900000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001',
  'export_ready', gen_random_uuid(), '86100000-0000-4000-8000-000000000002',
  now() - interval '8 years', 'active',
  now() - interval '8 years' + interval '30 days',
  now() - interval '8 years' + interval '120 days',
  now() - interval '8 years' + interval '30 days',
  now() - interval '8 years' + interval '24 months',
  now() - interval '8 years' + interval '7 years',
  false, '86a00000-0000-4000-8000-000000000001',
  now() - interval '8 years' + interval '1 day',
  '86000000-0000-4000-8000-000000000001/offboarding/manifest.json',
  repeat('a', 64), 1024, 3);

select pg_temp.p86_as('86100000-0000-4000-8000-000000000002', true);
select public.record_organization_purge_backup_evidence(
  '86000000-0000-4000-8000-000000000001', 'backup://p86/a', now() - interval '2 days',
  now() - interval '1 day', 'P86 restore rehearsal');
select pg_temp.p86_as(null);

select pg_temp.p86_assert(
  (private.organization_purge_gates('86000000-0000-4000-8000-000000000001')
     ->> 'eligible')::boolean,
  'fixture: the tenant is not purge-eligible, so nothing below tests the teardown');

-- =====================================================================================
-- E3 -- storage fails closed
-- =====================================================================================
select pg_temp.p86_assert(
  (select count(*) from private.organization_storage_residue(
     '86000000-0000-4000-8000-000000000001')) = 2,
  'fixture: the storage residue reader does not see the two buckets the tenant stored into');

select pg_temp.p86_as('86100000-0000-4000-8000-000000000002', true);
select public.approve_organization_purge_batch(
  array['86000000-0000-4000-8000-000000000001'::uuid],
  'P86 approved purge batch, files still stored') as batch_id \gset p86_blocked_

select pg_temp.p86_assert(
  not exists (
    select 1 from private.organization_purge_manifest_items item
    where item.batch_id = :'p86_blocked_batch_id'::uuid
      and item.org_id not in (select org_id from pg_temp.p86_fixture_orgs)),
  'E3: the approved manifest names an organization this file did not create');

select public.execute_organization_purge_batch(:'p86_blocked_batch_id'::uuid) as outcome
  \gset p86_blocked_
select pg_temp.p86_as(null);

select pg_temp.p86_assert(
  (:'p86_blocked_outcome'::jsonb ->> 'purged') = '0'
  and (:'p86_blocked_outcome'::jsonb ->> 'skipped') = '1',
  'E3: a tenant whose files are still stored was purged instead of skipped');
select pg_temp.p86_assert(
  exists (
    select 1 from private.organization_purge_executions execution
    where execution.batch_id = :'p86_blocked_batch_id'::uuid
      and execution.org_id = '86000000-0000-4000-8000-000000000001'
      and execution.outcome = 'skipped'
      and execution.skip_reason like 'storage_not_cleared:%'
      and execution.skip_reason like '%documents=2%'
      and execution.skip_reason like '%feedback=1%'),
  'E3: the skip did not name storage, or did not say which buckets still held files');
select pg_temp.p86_assert(
  exists (select 1 from public.organizations
          where id = '86000000-0000-4000-8000-000000000001')
  and exists (select 1 from public.invoice_three_way_approval_snapshots
              where org_id = '86000000-0000-4000-8000-000000000001')
  and exists (select 1 from public.suppliers
              where org_id = '86000000-0000-4000-8000-000000000001'),
  'E3: the refused purge deleted tenant rows anyway -- a skip has to be a no-op');

-- =====================================================================================
-- The service-role Storage API step, standing in for the call SQL cannot make
-- =====================================================================================
-- In production this is supabase/functions/organization-storage-purge: it reads the exact paths
-- from public.platform_organization_storage_objects and removes them through the Storage API,
-- which is the only thing that deletes the bytes. Here the rows are removed directly under
-- storage.allow_delete_query -- the escape hatch Supabase's own protect_delete() trigger reads --
-- because a SQL suite has no way to call the API. That the trigger refuses without it is
-- asserted first, so this file cannot quietly stop depending on the API being the only door.
select pg_temp.p86_expect_error(
  $$delete from storage.objects where bucket_id = 'feedback'
      and name like '86000000-0000-4000-8000-000000000001/%'$$,
  'Direct deletion from storage tables is not allowed');

select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects
where name like '86000000-0000-4000-8000-000000000001/%';
select set_config('storage.allow_delete_query', 'false', true);

select pg_temp.p86_assert(
  not exists (select 1 from private.organization_storage_residue(
    '86000000-0000-4000-8000-000000000001')),
  'the stand-in for the Storage API step left objects behind');

-- =====================================================================================
-- E4/E5 -- the same tenant, purged all the way through
-- =====================================================================================
select pg_temp.p86_as('86100000-0000-4000-8000-000000000002', true);
select public.approve_organization_purge_batch(
  array['86000000-0000-4000-8000-000000000001'::uuid],
  'P86 approved purge batch, files removed') as batch_id \gset p86_
select public.execute_organization_purge_batch(:'p86_batch_id'::uuid) as outcome \gset p86_
select pg_temp.p86_as(null);

select pg_temp.p86_assert(
  (:'p86_outcome'::jsonb ->> 'purged') = '1' and (:'p86_outcome'::jsonb ->> 'skipped') = '0',
  'E4: the tenant that used the product was not purged -- this is the whole claim of DEBT §66');

select pg_temp.p86_assert(
  (select removed_row_counts ? 'public.invoice_three_way_approval_snapshots'
   from private.organization_purge_executions
   where batch_id = :'p86_batch_id'::uuid
     and org_id = '86000000-0000-4000-8000-000000000001')
  and (select removed_row_counts ? 'private.organization_external_egress_evidence'
       from private.organization_purge_executions
       where batch_id = :'p86_batch_id'::uuid
         and org_id = '86000000-0000-4000-8000-000000000001'),
  'E4: the two evidence tables §66 measured as blockers are not in the removed-row report');

create function pg_temp.p86_stage_leftovers(p_org_id uuid)
returns setof text language plpgsql as $$
declare
  v_target record;
  v_rows   bigint;
begin
  for v_target in
    select stages.schema_name, stages.table_name
    from private.tenant_delete_stages() stages
    order by stages.schema_name, stages.table_name
  loop
    execute format('select count(*) from %I.%I where org_id = $1',
      v_target.schema_name, v_target.table_name) into v_rows using p_org_id;
    if v_rows > 0 then
      return next v_target.schema_name || '.' || v_target.table_name || '=' || v_rows;
    end if;
  end loop;
end
$$;

select pg_temp.p86_assert(
  not exists (
    select 1 from pg_temp.p86_stage_leftovers('86000000-0000-4000-8000-000000000001')),
  'E5: ' || coalesce((
    select string_agg(leftover, ', ')
    from pg_temp.p86_stage_leftovers('86000000-0000-4000-8000-000000000001') leftover), '')
  || ' still holds rows for the purged tenant');

-- =====================================================================================
-- E6 -- the residue the delete graph cannot see
-- =====================================================================================
-- Asserted by the exact row identifiers the fixture wrote, not by re-deriving them from parents
-- that are themselves gone: after the purge `where event_id in (select id from domain_events
-- where org_id = ...)` matches nothing whether the rows survived or not.
select pg_temp.p86_assert(
  not exists (select 1 from private.integration_deliveries
              where id = '86800000-0000-4000-8000-000000000001')
  and not exists (select 1 from private.dead_letter_records
                  where id = '86800000-0000-4000-8000-000000000002')
  and not exists (select 1 from private.idempotency_keys
                  where event_id = '86600000-0000-4000-8000-000000000001')
  and not exists (select 1 from private.organization_referrals
                  where referred_org_id = '86000000-0000-4000-8000-000000000001'
                     or referrer_org_id = '86000000-0000-4000-8000-000000000001')
  and not exists (select 1 from private.referral_grants
                  where id = '86800000-0000-4000-8000-000000000003'),
  'E6: an org-less private table still holds the purged tenant''s rows -- invisible to the '
  || 'delete graph is not the same as gone');

-- =====================================================================================
-- E7 -- nothing survives under the tenant prefix, in any bucket
-- =====================================================================================
select pg_temp.p86_assert(
  not exists (
    select 1 from storage.objects
    where starts_with(name, '86000000-0000-4000-8000-000000000001/')),
  'E7: a stored object survived the purge under the tenant prefix');

-- =====================================================================================
-- E8 -- exactly one tenant, and the ledger outlived it
-- =====================================================================================
select pg_temp.p86_assert(
  not exists (select 1 from public.organizations
              where id = '86000000-0000-4000-8000-000000000001'),
  'E8: the organization row itself survived the purge');
select pg_temp.p86_assert(
  exists (select 1 from public.organizations
          where id = '86000000-0000-4000-8000-000000000002')
  and exists (select 1 from public.organizations
              where id = '86000000-0000-4000-8000-000000000003')
  and exists (select 1 from public.profiles
              where org_id = '86000000-0000-4000-8000-000000000002')
  and exists (select 1 from private.organization_referrals
              where referred_org_id = '86000000-0000-4000-8000-000000000003')
  and exists (select 1 from private.referral_grants
              where id = '86800000-0000-4000-8000-000000000004')
  and exists (select 1 from storage.objects
              where name = '86000000-0000-4000-8000-000000000002/p86-other.pdf'),
  'E8: the purge reached beyond the tenant it was executing');
select pg_temp.p86_assert(
  (select count(*) from private.organization_purge_executions
   where org_id = '86000000-0000-4000-8000-000000000001') = 2
  and exists (select 1 from private.organization_purge_manifest_items
              where org_id = '86000000-0000-4000-8000-000000000001')
  and exists (select 1 from private.organization_purge_backup_evidence
              where org_id = '86000000-0000-4000-8000-000000000001'),
  'E8: the purge ledger was deleted with the tenant it records -- it is excluded on purpose '
  || '(0197:127-134) and is the only durable record that the deletion happened');

-- =====================================================================================
-- E9 -- neither new door is reachable from a browser or a service key
-- =====================================================================================
-- Asked through has_function_privilege rather than by calling as the wrong role: reading as a
-- role that lacks EXECUTE to catch insufficient_privilege crashes the backend, and a crashed
-- backend is not a passing test.
select pg_temp.p86_assert(
  not has_function_privilege('anon',
    'public.platform_organization_storage_objects(uuid)', 'execute')
  and not has_function_privilege('service_role',
    'public.platform_organization_storage_objects(uuid)', 'execute')
  and has_function_privilege('authenticated',
    'public.platform_organization_storage_objects(uuid)', 'execute'),
  'E9: the storage enumerator is reachable by a role no human sits behind, or unreachable by the '
  || 'operator who needs it');
select pg_temp.p86_assert(
  not has_function_privilege('anon', 'private.organization_storage_residue(uuid)', 'execute')
  and not has_function_privilege('authenticated',
    'private.organization_storage_residue(uuid)', 'execute')
  and not has_function_privilege('service_role',
    'private.organization_storage_residue(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.delete_tenant_residue_rows(uuid)', 'execute')
  and not has_function_privilege('authenticated',
    'private.delete_tenant_residue_rows(uuid)', 'execute')
  and not has_function_privilege('service_role',
    'private.delete_tenant_residue_rows(uuid)', 'execute'),
  'E9: a browser or service role holds EXECUTE on the teardown internals');

rollback;
