-- P4 flags, identity and step-up harness for 0059-0061. Run only against an isolated
-- local database with every migration applied. The transaction is rolled back.
--
-- What it proves, per PLAN-04 §2.5:
--   (a) the flag law: resolve_feature_flags() never returns a key outside the definitions
--       (an orphan config row cannot expand the surface), a raised kill switch forces off,
--       and the resolver is referenced from no policy and no other function;
--   (b) platform_set_org_flag demands platform membership and a reason, audits, targets
--       (percentage / date window / unit focus) evaluate fail-closed, and configuration
--       never leaks across tenants;
--   (c) step-up: structurally, every path SECURITY-MODEL §6 names carries the assertion
--       call (signature-resolved, and proven non-vacuous by mutation -- the UI-less SSO
--       path cannot quietly lose it); then behaviourally, EVERY wired path fails on
--       missing, stale and future (beyond the +30s skew ceiling) password AMR with
--       'fresh_authentication_required'/42501 and passes on a fresh one;
--   (d) suppliers.bank_details: the direct column write is revoked, the rest of the 0036
--       allowlist survives, and update_supplier_bank_details enforces role + step-up +
--       reason + tenant with a reasoned audit;
--   (e) security_events rows are written by the wired successes and are not readable by
--       the browser role (nor are the two identity tables);
--   (f) a duplicate (provider, external_subject) mapping and a cross-tenant mapping are
--       both structurally rejected.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p4_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P4 flags/identity assertion failed: %', p_message;
  end if;
end
$$;

-- Stamp the JWT claims for a user with a password AMR entry aged by p_offset
-- (interval '0' = fresh; negative = stale; positive = future). NULL offset = no amr at
-- all. The claims shape is the p1_financial_commands.sql:1219-1225 idiom.
create function pg_temp.p4_claims(p_sub uuid, p_offset interval)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  if p_offset is null then
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_sub::text)::text, true);
  else
    perform set_config('request.jwt.claims', jsonb_build_object(
      'sub', p_sub::text,
      'amr', jsonb_build_array(jsonb_build_object(
        'method', 'password',
        'timestamp', extract(epoch from clock_timestamp() + p_offset)::bigint))
    )::text, true);
  end if;
end
$$;

-- ===== Trusted fixtures (no JWT: migration/seed-style work) =====

insert into organizations (id, name, status) values
  ('17000000-0000-0000-0000-000000000001', 'P4 flags tenant A', 'active'),
  ('17000000-0000-0000-0000-000000000002', 'P4 flags tenant B', 'active');

insert into auth.users (id, email) values
  ('27000000-0000-0000-0000-000000000001', 'p4-owner-a@example.test'),
  ('27000000-0000-0000-0000-000000000002', 'p4-office-a@example.test'),
  ('27000000-0000-0000-0000-000000000003', 'p4-kitchen-a@example.test'),
  ('27000000-0000-0000-0000-000000000004', 'p4-accountant-a@example.test'),
  ('27000000-0000-0000-0000-000000000005', 'p4-payer-a@example.test'),
  ('27000000-0000-0000-0000-000000000009', 'p4-owner-b@example.test'),
  ('27000000-0000-0000-0000-000000000010', 'p4-platform-op@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('27000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000001', 'P4 Owner A', 'owner'),
  ('27000000-0000-0000-0000-000000000002', '17000000-0000-0000-0000-000000000001', 'P4 Office A', 'office'),
  ('27000000-0000-0000-0000-000000000003', '17000000-0000-0000-0000-000000000001', 'P4 Kitchen A', 'kitchen'),
  ('27000000-0000-0000-0000-000000000004', '17000000-0000-0000-0000-000000000001', 'P4 Accountant A', 'accountant'),
  ('27000000-0000-0000-0000-000000000005', '17000000-0000-0000-0000-000000000001', 'P4 Payer A', 'payer'),
  ('27000000-0000-0000-0000-000000000009', '17000000-0000-0000-0000-000000000002', 'P4 Owner B', 'owner');

-- The platform operator deliberately has NO profile: platform work is cross-tenant and
-- auth_org() answers NULL for them -- the exact shape platform_set_org_flag must accept.
insert into platform_admins (user_id, note) values
  ('27000000-0000-0000-0000-000000000010', 'P4 platform operator fixture');

insert into suppliers (id, org_id, name, bank_details) values
  ('37000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000001',
   'P4 supplier A1', 'בנק 12 סניף 345 חשבון 67890'),
  ('37000000-0000-0000-0000-000000000009', '17000000-0000-0000-0000-000000000002',
   'P4 supplier B1', null);

-- Payment fixtures for the execution paths (p1_financial_commands.sql:1079-1107 idiom).
insert into invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status
) values
  ('67000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000001',
   '37000000-0000-0000-0000-000000000001', 'P4-INV-PAYER', '2026-07-15', 100, 18, 118, 'approved'),
  ('67000000-0000-0000-0000-000000000002', '17000000-0000-0000-0000-000000000001',
   '37000000-0000-0000-0000-000000000001', 'P4-INV-EMERGENCY', '2026-07-16', 50, 9, 59, 'approved');
insert into payment_requests (
  id, org_id, supplier_id, amount, status, created_by, approved_by, approved_at
) values
  ('87000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000001',
   '37000000-0000-0000-0000-000000000001', 118, 'approved',
   '27000000-0000-0000-0000-000000000001', '27000000-0000-0000-0000-000000000001', now()),
  ('87000000-0000-0000-0000-000000000002', '17000000-0000-0000-0000-000000000001',
   '37000000-0000-0000-0000-000000000001', 59, 'approved',
   '27000000-0000-0000-0000-000000000001', '27000000-0000-0000-0000-000000000001', now());
insert into payment_request_invoices (org_id, payment_request_id, invoice_id, amount_allocated) values
  ('17000000-0000-0000-0000-000000000001', '87000000-0000-0000-0000-000000000001',
   '67000000-0000-0000-0000-000000000001', 118),
  ('17000000-0000-0000-0000-000000000001', '87000000-0000-0000-0000-000000000002',
   '67000000-0000-0000-0000-000000000002', 59);

-- Units of tenant A (created by the 0054 seeding trigger), captured for targeting tests.
select u.id as warehouse_a from org_units u
where u.org_id = '17000000-0000-0000-0000-000000000001' and u.unit_type = 'warehouse'
\gset unit_
select u.id as warehouse_b from org_units u
where u.org_id = '17000000-0000-0000-0000-000000000002' and u.unit_type = 'warehouse'
\gset unit_

-- ===== (a) The flag law =====

select pg_temp.p4_claims('27000000-0000-0000-0000-000000000003', interval '0');
set local role authenticated;
select count(*)::text as total,
       count(*) filter (where state)::text as enabled
from resolve_feature_flags() \gset flags_base_
reset role;
-- Three since 0090 added `feedback.notes` (the design-partner feedback surface). The number is
-- pinned rather than derived on purpose, in the spirit of the exemption-registry pin: a flag is a
-- new switch on the product, so adding one must edit THIS line and argue for it, not slip in and
-- watch the suite stay green. This run is that argument -- the gate caught the third flag on its
-- first execution, which is the latch doing its job.
--
-- What stays non-negotiable is the second half: `enabled = 0`. Every flag is born off for every
-- tenant, and `feedback.notes` is too; only platform_set_org_flag (platform admin + reason + audit)
-- turns one on. A flag that shipped on would defeat the whole law.
select pg_temp.p4_assert(
  :'flags_base_total'::int = 3 and :'flags_base_enabled'::int = 0,
  'the defined surface is exactly three flags, all born off');

-- An orphan config row (no definition) must NOT expand the resolved surface.
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
insert into org_flag_configurations (org_id, flag_key, state)
values ('17000000-0000-0000-0000-000000000001', 'rogue.flag', true);
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000003', interval '0');
set local role authenticated;
select count(*)::text as total from resolve_feature_flags() \gset flags_rogue_
reset role;
-- Three, matching the definition count above: the rogue config row must not add a fourth.
select pg_temp.p4_assert(
  :'flags_rogue_total'::int = 3,
  'resolve must never return a key outside private.flag_definitions -- no expansion');
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
delete from org_flag_configurations where flag_key = 'rogue.flag';

-- The resolver is structural UI plumbing: referenced from no policy and no other routine.
select pg_temp.p4_assert(
  not exists (
    select 1 from pg_catalog.pg_policy pol
    where coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') ~ 'resolve_feature_flags'
       or coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ 'resolve_feature_flags')
  and not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname <> 'resolve_feature_flags'
      and p.prosrc ~ 'resolve_feature_flags'),
  'resolve_feature_flags leaked into a policy or another routine -- the §8 law forbids it');

-- ===== (b) platform_set_org_flag =====

-- A tenant owner is not a platform operator.
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '0');
do $$
begin
  perform platform_set_org_flag(
    '17000000-0000-0000-0000-000000000001', 'receiving.barcode', true, '{}'::jsonb, null,
    'owner attempt');
  raise exception 'P4 flags/identity assertion failed: a tenant owner configured a flag';
exception when sqlstate '42501' then
  if sqlerrm not like '%not_platform_admin%' then raise; end if;
end
$$;

-- The operator without a reason is refused.
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000010', interval '0');
do $$
begin
  perform platform_set_org_flag(
    '17000000-0000-0000-0000-000000000001', 'receiving.barcode', true, '{}'::jsonb, null, '  ');
  raise exception 'P4 flags/identity assertion failed: a flag change without a reason was accepted';
exception when sqlstate '22023' then
  if sqlerrm not like '%flag_reason_required%' then raise; end if;
end
$$;

-- An undefined key is refused.
do $$
begin
  perform platform_set_org_flag(
    '17000000-0000-0000-0000-000000000001', 'no.such.flag', true, '{}'::jsonb, null,
    'P4: undefined key');
  raise exception 'P4 flags/identity assertion failed: an undefined flag key was accepted';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%flag_unknown%' then raise; end if;
end
$$;

-- The real change: on for tenant A, audited, invisible to tenant B.
select platform_set_org_flag(
  '17000000-0000-0000-0000-000000000001', 'receiving.barcode', true, '{}'::jsonb, null,
  'P4: enable barcode receiving for tenant A');
select pg_temp.p4_assert(
  exists (
    select 1 from audit_logs
    where org_id = '17000000-0000-0000-0000-000000000001'
      and action = 'org_flag_configured'
      and new_values ->> 'flag_key' = 'receiving.barcode'
      and reason = 'P4: enable barcode receiving for tenant A'),
  'the flag change must write a reasoned audit row for the TARGET organization');

select pg_temp.p4_claims('27000000-0000-0000-0000-000000000003', interval '0');
set local role authenticated;
select state::text as barcode from resolve_feature_flags()
where flag_key = 'receiving.barcode' \gset tenant_a_
reset role;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000009', interval '0');
set local role authenticated;
select state::text as barcode from resolve_feature_flags()
where flag_key = 'receiving.barcode' \gset tenant_b_
reset role;
select pg_temp.p4_assert(
  :'tenant_a_barcode'::boolean and not :'tenant_b_barcode'::boolean,
  'tenant A''s configuration must never resolve for tenant B');

-- Targeting evaluates fail-closed: percentage 0 disables, an expired window disables, a
-- foreign unit_ids list disables; a matching unit focus (most specific row) wins.
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000010', interval '0');
select platform_set_org_flag(
  '17000000-0000-0000-0000-000000000001', 'receiving.barcode', true,
  '{"percentage": 0}'::jsonb, null, 'P4: zero-percentage rollout');
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000003', interval '0');
set local role authenticated;
select state::text as barcode from resolve_feature_flags()
where flag_key = 'receiving.barcode' \gset pct0_
reset role;
select pg_temp.p4_assert(not :'pct0_barcode'::boolean,
  'percentage 0 must resolve to off for every user');

select pg_temp.p4_claims('27000000-0000-0000-0000-000000000010', interval '0');
select platform_set_org_flag(
  '17000000-0000-0000-0000-000000000001', 'receiving.barcode', true,
  jsonb_build_object('ends_at', (clock_timestamp() - interval '1 day')::text), null,
  'P4: expired rollout window');
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000003', interval '0');
set local role authenticated;
select state::text as barcode from resolve_feature_flags()
where flag_key = 'receiving.barcode' \gset ended_
reset role;
select pg_temp.p4_assert(not :'ended_barcode'::boolean,
  'an ended rollout window must resolve to off');

select pg_temp.p4_claims('27000000-0000-0000-0000-000000000010', interval '0');
select set_config('p4.unit_warehouse_b', :'unit_warehouse_b', true);
select platform_set_org_flag(
  '17000000-0000-0000-0000-000000000001', 'receiving.barcode', true,
  jsonb_build_object('unit_ids', jsonb_build_array(current_setting('p4.unit_warehouse_b'))), null,
  'P4: targeting a unit outside the caller scopes');
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000003', interval '0');
set local role authenticated;
select state::text as barcode from resolve_feature_flags()
where flag_key = 'receiving.barcode' \gset foreignunit_
reset role;
select pg_temp.p4_assert(not :'foreignunit_barcode'::boolean,
  'unit_ids targeting outside the caller''s scopes must resolve to off');

-- Unit-focused row beats the org-wide row (most specific wins): org-wide OFF, warehouse ON,
-- and the root-anchored user holds the warehouse in their closure.
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000010', interval '0');
select platform_set_org_flag(
  '17000000-0000-0000-0000-000000000001', 'receiving.barcode', false, '{}'::jsonb, null,
  'P4: org-wide off');
select platform_set_org_flag(
  '17000000-0000-0000-0000-000000000001', 'receiving.barcode', true, '{}'::jsonb,
  :'unit_warehouse_a', 'P4: warehouse-focused on');
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000003', interval '0');
set local role authenticated;
select state::text as barcode from resolve_feature_flags()
where flag_key = 'receiving.barcode' \gset unitfocus_
reset role;
select pg_temp.p4_assert(:'unitfocus_barcode'::boolean,
  'the unit-focused row must beat the org-wide row for a user holding that unit');

-- A cross-tenant unit focus is refused before any row exists.
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000010', interval '0');
do $$
begin
  perform platform_set_org_flag(
    '17000000-0000-0000-0000-000000000001', 'receiving.barcode', true, '{}'::jsonb,
    current_setting('p4.unit_warehouse_b')::uuid, 'P4: cross-tenant unit focus');
  raise exception 'P4 flags/identity assertion failed: a cross-tenant unit focus was accepted';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%unit_unknown%' then raise; end if;
end
$$;

-- The kill switch forces off regardless of configuration (trusted-console write, like
-- platform_admins membership).
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
update private.flag_definitions set kill_switch = true where flag_key = 'receiving.barcode';
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000003', interval '0');
set local role authenticated;
select state::text as barcode from resolve_feature_flags()
where flag_key = 'receiving.barcode' \gset killed_
reset role;
select pg_temp.p4_assert(not :'killed_barcode'::boolean,
  'a raised kill switch must force the flag off despite an enabling configuration');
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
update private.flag_definitions set kill_switch = false where flag_key = 'receiving.barcode';

-- ===== (c) Step-up on every wired path =====

-- (c0) STRUCTURAL COVERAGE FIRST -- the §6 equivalent of A1/A3/A5.
-- The behavioural tests below drive each path through a screen-shaped call, but a path
-- with no UI has nothing to remind a later wave that it must keep the assertion: a
-- redeclaration that silently drops `perform assert_recent_password_authentication()`
-- would leave those tests passing only for the paths someone remembered to exercise.
-- This helper pins the SECURITY-MODEL §6 list itself, resolved by exact signature, so an
-- argument drift fails here instead of degrading quietly. update_identity_provider_settings
-- is on the list precisely because it has no screen in this wave.
create function pg_temp.p4_stepup_uncovered()
returns setof text
language sql stable
as $$
  select wired.signature
  from (values
    ('public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'),
    ('public.execute_emergency_payment_request(uuid,date,text,text,text,jsonb,text)'),
    ('public.manage_profile_access(uuid,user_role,boolean,uuid,text)'),
    ('public.mark_month_export_sent(date,uuid[],text)'),
    ('public.grant_user_scope(uuid,uuid,text)'),
    ('public.revoke_user_scope(uuid,uuid,text)'),
    ('public.update_identity_provider_settings(text,boolean,jsonb,jsonb,text)'),
    ('public.update_supplier_bank_details(uuid,text,text)'),
    -- Wave 7's ninth path, added to this registry in wave 10 (audit Finding 5). 0066:285
    -- calls flipping a webhook subscription active "the same exfiltration class as changing a
    -- supplier's bank_details, so #85 applies" -- and then did not extend the list, which is
    -- the exact failure this mechanism was built one wave earlier to prevent. Its behavioural
    -- arm lives in p7_integration_adapters.sql:643-657; this is the structural half.
    ('public.set_webhook_subscription_active(uuid,boolean,text)')
  ) as wired(signature)
  where to_regprocedure(wired.signature) is null
     or coalesce(
          (select p.prosrc
             from pg_catalog.pg_proc p
            where p.oid = to_regprocedure(wired.signature)::oid),
          '') !~ 'assert_recent_password_authentication'
$$;

select pg_temp.p4_assert(
  not exists (select 1 from pg_temp.p4_stepup_uncovered()),
  'a SECURITY-MODEL §6 path lost its step-up call or drifted its signature -- every named '
  || 'path must call assert_recent_password_authentication, including the ones with no UI');

-- The check must actually DETECT the loss (the p3 mutation idiom): redeclare the one
-- UI-less path as a stub without the call, expect the helper to flag exactly it, roll
-- back, and prove coverage is whole again.
savepoint mutation_stepup;
create or replace function update_identity_provider_settings(
  p_provider text,
  p_enabled boolean,
  p_config jsonb,
  p_secret_config jsonb,
  p_reason text
) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'p4_mutated_stub' using errcode = 'P0001';
end
$$;
select pg_temp.p4_assert(
  exists (
    select 1 from pg_temp.p4_stepup_uncovered() uncovered
    where uncovered = 'public.update_identity_provider_settings(text,boolean,jsonb,jsonb,text)'),
  'the §6 coverage check must detect a redeclaration that drops the step-up call');
rollback to savepoint mutation_stepup;
select pg_temp.p4_assert(
  not exists (select 1 from pg_temp.p4_stepup_uncovered()),
  'rolling the mutation back must restore full §6 coverage');

-- Every path behaviourally: missing AMR, stale (10 minutes old), future (10 minutes
-- ahead -- beyond the +30s skew ceiling), then fresh succeeds.

-- --- execute_payment_request (payer) ---
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000005', null);
set local role authenticated;
do $$
begin
  perform execute_payment_request(
    '87000000-0000-0000-0000-000000000001', '2026-07-20', 'העברה בנקאית', 'P4-REF-1', null,
    '[{"invoice_id":"67000000-0000-0000-0000-000000000001","credit_id":null,"amount":118}]'::jsonb,
    'P4: no amr');
  raise exception 'P4 flags/identity assertion failed: payer executed without amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000005', interval '-10 minutes');
set local role authenticated;
do $$
begin
  perform execute_payment_request(
    '87000000-0000-0000-0000-000000000001', '2026-07-20', 'העברה בנקאית', 'P4-REF-1', null,
    '[{"invoice_id":"67000000-0000-0000-0000-000000000001","credit_id":null,"amount":118}]'::jsonb,
    'P4: stale amr');
  raise exception 'P4 flags/identity assertion failed: payer executed with stale amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000005', interval '10 minutes');
set local role authenticated;
do $$
begin
  perform execute_payment_request(
    '87000000-0000-0000-0000-000000000001', '2026-07-20', 'העברה בנקאית', 'P4-REF-1', null,
    '[{"invoice_id":"67000000-0000-0000-0000-000000000001","credit_id":null,"amount":118}]'::jsonb,
    'P4: future amr');
  raise exception 'P4 flags/identity assertion failed: payer executed with a future amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000005', interval '0');
set local role authenticated;
select pg_temp.p4_assert(
  (execute_payment_request(
    '87000000-0000-0000-0000-000000000001', '2026-07-20', 'העברה בנקאית', 'P4-REF-1', null,
    '[{"invoice_id":"67000000-0000-0000-0000-000000000001","credit_id":null,"amount":118}]'::jsonb,
    'P4: ביצוע עם אימות טרי'
  )->>'idempotent')::boolean = false,
  'fresh payer execution must commit');
reset role;

-- --- execute_emergency_payment_request (owner) ---
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', null);
set local role authenticated;
do $$
begin
  perform execute_emergency_payment_request(
    '87000000-0000-0000-0000-000000000002', '2026-07-21', 'העברה בנקאית', 'P4-EMG-1', null,
    '[{"invoice_id":"67000000-0000-0000-0000-000000000002","credit_id":null,"amount":59}]'::jsonb,
    'P4: emergency no amr');
  raise exception 'P4 flags/identity assertion failed: emergency executed without amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '-10 minutes');
set local role authenticated;
do $$
begin
  perform execute_emergency_payment_request(
    '87000000-0000-0000-0000-000000000002', '2026-07-21', 'העברה בנקאית', 'P4-EMG-1', null,
    '[{"invoice_id":"67000000-0000-0000-0000-000000000002","credit_id":null,"amount":59}]'::jsonb,
    'P4: emergency stale amr');
  raise exception 'P4 flags/identity assertion failed: emergency executed with stale amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '10 minutes');
set local role authenticated;
do $$
begin
  perform execute_emergency_payment_request(
    '87000000-0000-0000-0000-000000000002', '2026-07-21', 'העברה בנקאית', 'P4-EMG-1', null,
    '[{"invoice_id":"67000000-0000-0000-0000-000000000002","credit_id":null,"amount":59}]'::jsonb,
    'P4: emergency future amr');
  raise exception 'P4 flags/identity assertion failed: emergency executed with a future amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '0');
set local role authenticated;
select pg_temp.p4_assert(
  (execute_emergency_payment_request(
    '87000000-0000-0000-0000-000000000002', '2026-07-21', 'העברה בנקאית', 'P4-EMG-1', null,
    '[{"invoice_id":"67000000-0000-0000-0000-000000000002","credit_id":null,"amount":59}]'::jsonb,
    'P4: תשלום חירום מאומת'
  )->>'emergency')::boolean,
  'fresh owner emergency execution must commit');
reset role;

-- --- manage_profile_access (owner -> kitchen) ---
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', null);
do $$
begin
  perform manage_profile_access(
    '27000000-0000-0000-0000-000000000003', 'kitchen', false, null, 'P4: no amr');
  raise exception 'P4 flags/identity assertion failed: access changed without amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '-10 minutes');
do $$
begin
  perform manage_profile_access(
    '27000000-0000-0000-0000-000000000003', 'kitchen', false, null, 'P4: stale amr');
  raise exception 'P4 flags/identity assertion failed: access changed with stale amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '10 minutes');
do $$
begin
  perform manage_profile_access(
    '27000000-0000-0000-0000-000000000003', 'kitchen', false, null, 'P4: future amr');
  raise exception 'P4 flags/identity assertion failed: access changed with a future amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '0');
select manage_profile_access(
  '27000000-0000-0000-0000-000000000003', 'kitchen', false, null,
  'P4: השבתה עם אימות טרי');
select pg_temp.p4_assert(
  (select not active from profiles where id = '27000000-0000-0000-0000-000000000003')
  and exists (
    select 1 from security_events
    where org_id = '17000000-0000-0000-0000-000000000001'
      and actor_user_id = '27000000-0000-0000-0000-000000000001'
      and event_type = 'permission_change'
      and details ->> 'profile_id' = '27000000-0000-0000-0000-000000000003'),
  'a fresh access change must land and record its permission_change security event');
select manage_profile_access(
  '27000000-0000-0000-0000-000000000003', 'kitchen', true, null,
  'P4: החזרת המשתמש לפעיל');

-- --- mark_month_export_sent (owner) ---
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', null);
do $$
begin
  perform mark_month_export_sent(
    '2026-07-01', array['67000000-0000-0000-0000-000000000001'::uuid], 'P4: no amr');
  raise exception 'P4 flags/identity assertion failed: month export sent without amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '-10 minutes');
do $$
begin
  perform mark_month_export_sent(
    '2026-07-01', array['67000000-0000-0000-0000-000000000001'::uuid], 'P4: stale amr');
  raise exception 'P4 flags/identity assertion failed: month export sent with stale amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '10 minutes');
do $$
begin
  perform mark_month_export_sent(
    '2026-07-01', array['67000000-0000-0000-0000-000000000001'::uuid], 'P4: future amr');
  raise exception 'P4 flags/identity assertion failed: month export sent with a future amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '0');
select pg_temp.p4_assert(
  (mark_month_export_sent(
    '2026-07-01',
    array['67000000-0000-0000-0000-000000000001'::uuid,
          '67000000-0000-0000-0000-000000000002'::uuid],
    'P4: העברת דוח יולי עם אימות טרי'
  )->>'idempotent')::boolean = false,
  'fresh month export must commit');

-- --- grant_user_scope / revoke_user_scope (owner) ---
select set_config('p4.unit_warehouse_a', :'unit_warehouse_a', true);
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', null);
do $$
begin
  perform grant_user_scope(
    '27000000-0000-0000-0000-000000000003',
    current_setting('p4.unit_warehouse_a')::uuid, 'P4: no amr');
  raise exception 'P4 flags/identity assertion failed: scope granted without amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '-10 minutes');
do $$
begin
  perform grant_user_scope(
    '27000000-0000-0000-0000-000000000003',
    current_setting('p4.unit_warehouse_a')::uuid, 'P4: stale amr');
  raise exception 'P4 flags/identity assertion failed: scope granted with stale amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '10 minutes');
do $$
begin
  perform grant_user_scope(
    '27000000-0000-0000-0000-000000000003',
    current_setting('p4.unit_warehouse_a')::uuid, 'P4: future amr');
  raise exception 'P4 flags/identity assertion failed: scope granted with a future amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '0');
select grant_user_scope(
  '27000000-0000-0000-0000-000000000003',
  current_setting('p4.unit_warehouse_a')::uuid, 'P4: הרחבת סקופ עם אימות טרי');
select pg_temp.p4_assert(
  exists (
    select 1 from security_events
    where org_id = '17000000-0000-0000-0000-000000000001'
      and event_type = 'scope_grant_change'
      and details ->> 'change' = 'granted'
      and details ->> 'user_id' = '27000000-0000-0000-0000-000000000003'),
  'a fresh scope grant must record its scope_grant_change security event');

select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', null);
do $$
begin
  perform revoke_user_scope(
    '27000000-0000-0000-0000-000000000003',
    current_setting('p4.unit_warehouse_a')::uuid, 'P4: no amr');
  raise exception 'P4 flags/identity assertion failed: scope revoked without amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '-10 minutes');
do $$
begin
  perform revoke_user_scope(
    '27000000-0000-0000-0000-000000000003',
    current_setting('p4.unit_warehouse_a')::uuid, 'P4: stale amr');
  raise exception 'P4 flags/identity assertion failed: scope revoked with stale amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '10 minutes');
do $$
begin
  perform revoke_user_scope(
    '27000000-0000-0000-0000-000000000003',
    current_setting('p4.unit_warehouse_a')::uuid, 'P4: future amr');
  raise exception 'P4 flags/identity assertion failed: scope revoked with a future amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '0');
select revoke_user_scope(
  '27000000-0000-0000-0000-000000000003',
  current_setting('p4.unit_warehouse_a')::uuid, 'P4: צמצום סקופ עם אימות טרי');
select pg_temp.p4_assert(
  exists (
    select 1 from security_events
    where org_id = '17000000-0000-0000-0000-000000000001'
      and event_type = 'scope_grant_change'
      and details ->> 'change' = 'revoked'),
  'a fresh scope revoke must record its scope_grant_change security event');

-- --- update_identity_provider_settings (owner) ---
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', null);
do $$
begin
  perform update_identity_provider_settings(
    'okta', true, '{"issuer":"https://example.okta.com"}'::jsonb,
    '{"client_secret":"p4-super-secret-value"}'::jsonb, 'P4: no amr');
  raise exception 'P4 flags/identity assertion failed: SSO settings changed without amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '-10 minutes');
do $$
begin
  perform update_identity_provider_settings(
    'okta', true, '{}'::jsonb, '{}'::jsonb, 'P4: stale amr');
  raise exception 'P4 flags/identity assertion failed: SSO settings changed with stale amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '10 minutes');
do $$
begin
  perform update_identity_provider_settings(
    'okta', true, '{}'::jsonb, '{}'::jsonb, 'P4: future amr');
  raise exception 'P4 flags/identity assertion failed: SSO settings changed with a future amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '0');
do $$
begin
  perform update_identity_provider_settings(
    'facebook', true, '{}'::jsonb, '{}'::jsonb, 'P4: unknown provider');
  raise exception 'P4 flags/identity assertion failed: an unknown provider was accepted';
exception when sqlstate '22023' then
  if sqlerrm not like '%sso_provider_invalid%' then raise; end if;
end
$$;
select update_identity_provider_settings(
  'okta', true, '{"issuer":"https://example.okta.com"}'::jsonb,
  '{"client_secret":"p4-super-secret-value"}'::jsonb,
  'P4: חיבור Okta עם אימות טרי');

-- The audit trail redacts the secret; the reader hides it; the event is recorded.
select pg_temp.p4_assert(
  exists (
    select 1 from audit_logs
    where org_id = '17000000-0000-0000-0000-000000000001'
      and action = 'sso_settings_changed'
      and new_values -> 'secret_keys' = '["client_secret"]'::jsonb)
  and not exists (
    select 1 from audit_logs
    where new_values::text like '%p4-super-secret-value%'
       or old_values::text like '%p4-super-secret-value%'),
  'the SSO audit row must name secret keys and never contain a secret value');
select pg_temp.p4_assert(
  exists (
    select 1 from security_events
    where org_id = '17000000-0000-0000-0000-000000000001'
      and event_type = 'sso_config_change'
      and details ->> 'provider' = 'okta'),
  'the SSO change must record its sso_config_change security event');

set local role authenticated;
select count(*)::text as visible, bool_or(config ? 'issuer')::text as has_config
from read_identity_provider_settings() \gset owner_sso_
reset role;
select pg_temp.p4_assert(
  :'owner_sso_visible'::int = 1 and :'owner_sso_has_config'::boolean,
  'the owner reader must return the provider row with its non-secret config');
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000003', interval '0');
set local role authenticated;
select count(*)::text as visible from read_identity_provider_settings() \gset kitchen_sso_
reset role;
select pg_temp.p4_assert(
  :'kitchen_sso_visible'::int = 0,
  'a non-owner must read zero SSO settings rows');

-- --- update_supplier_bank_details (owner/office) + the revoked column =====
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '0');
set local role authenticated;
do $$
begin
  update suppliers
  set bank_details = 'בנק גנוב 99'
  where id = '37000000-0000-0000-0000-000000000001';
  raise exception 'P4 flags/identity assertion failed: direct bank_details update was accepted';
exception when insufficient_privilege then
  null;
end
$$;
-- The rest of the 0036 allowlist keeps working through the same session.
with changed as (
  update suppliers set contact_name = 'P4 allowed edit'
  where id = '37000000-0000-0000-0000-000000000001'
  returning 1
)
select pg_temp.p4_assert(
  (select count(*) = 1 from changed),
  'the non-bank supplier columns must stay browser-writable');
reset role;

select pg_temp.p4_claims('27000000-0000-0000-0000-000000000004', interval '0');
do $$
begin
  perform update_supplier_bank_details(
    '37000000-0000-0000-0000-000000000001', 'בנק 98', 'P4: accountant attempt');
  raise exception 'P4 flags/identity assertion failed: accountant changed bank details';
exception when sqlstate '42501' then
  if sqlerrm not like '%supplier_bank_details_not_authorized%' then raise; end if;
end
$$;

select pg_temp.p4_claims('27000000-0000-0000-0000-000000000002', null);
do $$
begin
  perform update_supplier_bank_details(
    '37000000-0000-0000-0000-000000000001', 'בנק 98', 'P4: no amr');
  raise exception 'P4 flags/identity assertion failed: bank details changed without amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000002', interval '-10 minutes');
do $$
begin
  perform update_supplier_bank_details(
    '37000000-0000-0000-0000-000000000001', 'בנק 98', 'P4: stale amr');
  raise exception 'P4 flags/identity assertion failed: bank details changed with stale amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000002', interval '10 minutes');
do $$
begin
  perform update_supplier_bank_details(
    '37000000-0000-0000-0000-000000000001', 'בנק 98', 'P4: future amr');
  raise exception 'P4 flags/identity assertion failed: bank details changed with a future amr';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000002', interval '0');
do $$
begin
  perform update_supplier_bank_details(
    '37000000-0000-0000-0000-000000000001', 'בנק 98', '   ');
  raise exception 'P4 flags/identity assertion failed: bank details changed without a reason';
exception when sqlstate '22023' then
  if sqlerrm not like '%supplier_bank_details_reason_required%' then raise; end if;
end
$$;
do $$
begin
  perform update_supplier_bank_details(
    '37000000-0000-0000-0000-000000000009', 'בנק 98', 'P4: cross-tenant attempt');
  raise exception 'P4 flags/identity assertion failed: a cross-tenant supplier was accepted';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%supplier_unknown%' then raise; end if;
end
$$;
select update_supplier_bank_details(
  '37000000-0000-0000-0000-000000000001', 'בנק 20 סניף 555 חשבון 11111',
  'P4: עדכון פרטי בנק עם אימות טרי');
select pg_temp.p4_assert(
  (select bank_details = 'בנק 20 סניף 555 חשבון 11111'
   from suppliers where id = '37000000-0000-0000-0000-000000000001')
  and exists (
    select 1 from audit_logs
    where org_id = '17000000-0000-0000-0000-000000000001'
      and action = 'supplier_bank_details_changed'
      and entity_id = '37000000-0000-0000-0000-000000000001'
      and reason = 'P4: עדכון פרטי בנק עם אימות טרי'),
  'the reasoned bank-details command must land with its audit row');

-- ===== (e) security_events: written by the successes, unreadable by the browser =====
select pg_temp.p4_assert(
  (select count(*) >= 4 from security_events
   where org_id = '17000000-0000-0000-0000-000000000001'
     and event_type = 'step_up_success'),
  'each fresh wired success must have recorded a step_up_success event');
select pg_temp.p4_assert(
  not has_table_privilege('authenticated', 'public.security_events', 'SELECT')
  and not has_table_privilege('authenticated', 'public.identity_provider_settings', 'SELECT')
  and not has_table_privilege('authenticated', 'public.external_identity_mappings', 'SELECT')
  and not has_table_privilege('anon', 'public.security_events', 'SELECT'),
  'the three identity-wave tables must carry no browser read privilege');
-- "The RPC is the only write path" must be STRUCTURALLY true, not intended: a permissive
-- policy plus a column grant IS a write path (the pre-0061 bank_details lesson). None of
-- the four wave tables may hold any browser DML privilege, table- or column-level.
select pg_temp.p4_assert(
  not exists (
    select 1
    from (values ('public.identity_provider_settings'::regclass),
                 ('public.external_identity_mappings'::regclass),
                 ('public.security_events'::regclass),
                 ('public.org_flag_configurations'::regclass)) t(relation)
    cross join (values ('anon'), ('authenticated')) r(role_name)
    cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) p(privilege)
    where has_table_privilege(r.role_name, t.relation, p.privilege)
       -- column privileges exist only for SELECT/INSERT/UPDATE/REFERENCES
       or (p.privilege in ('INSERT', 'UPDATE')
           and has_any_column_privilege(r.role_name, t.relation, p.privilege))),
  'a wave-4 table exposes browser DML -- the reasoned RPCs must be the only write path');
select pg_temp.p4_claims('27000000-0000-0000-0000-000000000001', interval '0');
set local role authenticated;
do $$
begin
  perform count(*) from security_events;
  raise exception 'P4 flags/identity assertion failed: the browser read security_events';
exception when insufficient_privilege then
  null;
end
$$;
do $$
begin
  perform count(*) from identity_provider_settings;
  raise exception 'P4 flags/identity assertion failed: the browser read identity_provider_settings';
exception when insufficient_privilege then
  null;
end
$$;
do $$
begin
  perform count(*) from external_identity_mappings;
  raise exception 'P4 flags/identity assertion failed: the browser read external_identity_mappings';
exception when insufficient_privilege then
  null;
end
$$;
reset role;

-- ===== (f) identity mappings: duplicate and cross-tenant are structurally refused =====
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
insert into external_identity_mappings (org_id, user_id, provider, external_subject) values
  ('17000000-0000-0000-0000-000000000001', '27000000-0000-0000-0000-000000000001',
   'entra_id', 'p4-subject-1');
do $$
begin
  insert into external_identity_mappings (org_id, user_id, provider, external_subject) values
    ('17000000-0000-0000-0000-000000000001', '27000000-0000-0000-0000-000000000002',
     'entra_id', 'p4-subject-1');
  raise exception 'P4 flags/identity assertion failed: a duplicate identity mapping was accepted';
exception when unique_violation then
  null;
end
$$;
do $$
begin
  insert into external_identity_mappings (org_id, user_id, provider, external_subject) values
    ('17000000-0000-0000-0000-000000000001', '27000000-0000-0000-0000-000000000009',
     'entra_id', 'p4-subject-2');
  raise exception 'P4 flags/identity assertion failed: a cross-tenant identity mapping was accepted';
exception when foreign_key_violation then
  null;
end
$$;

rollback;

\echo 'p4_flags_identity_passed'
