-- P9 harness for 0068-0070 (wave 9, PLAN-10 §2). Run only against an isolated local database
-- with every migration applied. The transaction is rolled back.
--
-- What it proves:
--   (a) structure: Shape-1 ACLs and registry rows for the two new public tables, the private
--       vocabulary tables' Shape-2 ACLs, the grant matrix of the five new functions, the A5
--       discipline (zero exemption additions, every wave-9 body word-clean of the enforced
--       table names, three of the five functions deliberately NOT definers), and that
--       global_search kept its invoker rights, its limit 30 and its trigram indexes;
--   (b) notification preferences END TO END through the REAL, UNEDITED delivery command:
--       an absent row reproduces the previous audience byte for byte; a Push opt-out removes
--       Push and LEAVES the notification row (the #39 badge contract); an in-app opt-out
--       removes the row; a preference cannot widen the audience; the command is self-only and
--       rejects an uncatalogued code; the reader is complete and tenant-pinned;
--   (c) the search type gate: as payer and as supplier agent global_search returns NOTHING;
--       as accountant it returns no supplier/product/order hit; as owner it returns all six;
--   (d) the approval policy: tighten-only enforcement, the platform-operator write boundary,
--       the evaluator's threshold arithmetic and tenant pinning, and the STRUCTURAL proof
--       that no financial command and no RLS expression anywhere mentions the evaluator;
--   (e) read_allowed_transitions mirrors the live matrices EXACTLY -- proved by probing the
--       four real commands for every ordered pair of statuses and comparing;
--   (f) the mutation proof: weakening the search type gate is DETECTED by (c)'s assertion.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p9_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P9 five domains assertion failed: %', p_message;
  end if;
end
$$;

-- JWT-claims stamp, the p5/p7 idiom. A NULL subject clears both spellings, which is how the
-- fixture blocks below act as "migration/seed work" (auth.uid() null) and slip past the P1
-- direct-write guard exactly as a migration does.
create function pg_temp.p9_claims(p_sub uuid)
returns void
language plpgsql
as $$
begin
  if p_sub is null then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
  else
    perform set_config('request.jwt.claim.sub', p_sub::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub::text)::text, true);
  end if;
end
$$;

-- ===== (a) structural proofs =====

-- Shape-1 on both new public tables: a permissive SELECT policy exists <=> authenticated
-- holds SELECT, and there is NO browser DML (p1_financial_commands.sql:18-64).
select pg_temp.p9_assert(
  has_table_privilege('authenticated', 'public.notification_preferences', 'SELECT')
    and not has_table_privilege('authenticated', 'public.notification_preferences', 'INSERT')
    and not has_table_privilege('authenticated', 'public.notification_preferences', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.notification_preferences', 'DELETE')
    and not has_table_privilege('anon', 'public.notification_preferences', 'SELECT'),
  'notification_preferences must be SELECT-only for authenticated, nothing for anon');

select pg_temp.p9_assert(
  has_table_privilege('authenticated', 'public.approval_policy_configurations', 'SELECT')
    and not has_table_privilege('authenticated', 'public.approval_policy_configurations', 'INSERT')
    and not has_table_privilege('authenticated', 'public.approval_policy_configurations', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.approval_policy_configurations', 'DELETE')
    and not has_table_privilege('anon', 'public.approval_policy_configurations', 'SELECT'),
  'approval_policy_configurations must be SELECT-only for authenticated');

select pg_temp.p9_assert(
  (select count(*) from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('notification_preferences', 'approval_policy_configurations')
     and c.relrowsecurity) = 2,
  'RLS must be enabled on both wave-9 public tables');

select pg_temp.p9_assert(
  exists (
    select 1
    from pg_catalog.pg_policy pol
    join pg_catalog.pg_class c on c.oid = pol.polrelid
    where c.relname = 'notification_preferences'
      and pol.polname = 'notification_preferences_select_own'
      and pol.polpermissive
      and pol.polcmd = 'r'
      and pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) like '%auth.uid()%'),
  'the preference read policy must be permissive, SELECT-only and pinned to the caller');

select pg_temp.p9_assert(
  (select count(*) from pg_catalog.pg_policy pol
   join pg_catalog.pg_class c on c.oid = pol.polrelid
   where c.relname in ('notification_preferences', 'approval_policy_configurations')) = 2,
  'neither wave-9 table may carry a second policy -- read only, writes through an RPC');

-- The private vocabularies are Shape-2 and carry no registry row: A1 scans public base
-- tables only (the 0059:21-23 note).
select pg_temp.p9_assert(
  not has_table_privilege('authenticated', 'private.notification_event_definitions', 'SELECT')
    and not has_table_privilege('anon', 'private.notification_event_definitions', 'SELECT')
    and not has_table_privilege('authenticated', 'private.approval_policy_definitions', 'SELECT')
    and not has_table_privilege('anon', 'private.approval_policy_definitions', 'SELECT'),
  'the private wave-9 vocabularies must be unreadable by the browser roles');

select pg_temp.p9_assert(
  not exists (
    select 1 from private.scope_registry r
    where r.table_name in ('notification_event_definitions', 'approval_policy_definitions')),
  'a private vocabulary table must NOT hold a scope_registry row');

select pg_temp.p9_assert(
  (select count(*) from private.scope_registry
   where (table_name, scope_class, enforced) in (
     ('notification_preferences',       'org_global', false),
     ('approval_policy_configurations', 'org_global', false))) = 2,
  'both wave-9 public tables must be registered org_global / not enforced');

-- The seeded vocabularies.
select pg_temp.p9_assert(
  (select count(*) from private.notification_event_definitions) = 3
    and (select count(*) from private.notification_event_definitions
         where event_code in ('price_increase', 'duplicate_invoice', 'payment_due')) = 3,
  'the notification catalog must hold exactly the three live event codes');

select pg_temp.p9_assert(
  (select count(*) from private.approval_policy_definitions
   where baseline_required_approvals = 1 and not baseline_step_up_required) = 2,
  'both seeded approval policies must carry TODAY''S behaviour as their baseline');

-- The composite tenant FK is the ONLY FK from notification_preferences to profiles: a second
-- single-column FK is what 0024:21-52 removed everywhere and what p2_data_reliability.sql:188
-- keeps out (two relationships make PostgREST embeds ambiguous).
select pg_temp.p9_assert(
  (select count(*) from pg_constraint
   where conrelid = 'public.notification_preferences'::regclass
     and contype = 'f' and confrelid = 'public.profiles'::regclass) = 1
    and exists (
      select 1 from pg_constraint
      where conname = 'notification_preferences_user_fk'
        and cardinality(conkey) = 2 and confdeltype = 'c'),
  'notification_preferences must reach profiles through exactly one composite cascading FK');

-- approval_policy_configurations must NOT be FK-bound to the private definitions (0059:66-68):
-- an orphan is a preflight anomaly, not a broken cascade.
select pg_temp.p9_assert(
  (select count(*) from pg_constraint
   where conrelid = 'public.approval_policy_configurations'::regclass and contype = 'f') = 1,
  'the policy configuration must carry exactly one FK -- the tenant, never the definition');

-- Grant matrix.
select pg_temp.p9_assert(
  has_function_privilege('authenticated',
    'public.set_notification_preference(text,boolean,boolean)', 'EXECUTE')
    and not has_function_privilege('anon',
      'public.set_notification_preference(text,boolean,boolean)', 'EXECUTE')
    and has_function_privilege('authenticated',
      'public.read_notification_preferences()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.read_notification_preferences()', 'EXECUTE')
    and has_function_privilege('authenticated',
      'public.read_allowed_transitions(text,text)', 'EXECUTE')
    and not has_function_privilege('anon',
      'public.read_allowed_transitions(text,text)', 'EXECUTE')
    and has_function_privilege('authenticated',
      'public.evaluate_approval_policy(text,numeric)', 'EXECUTE')
    and not has_function_privilege('anon',
      'public.evaluate_approval_policy(text,numeric)', 'EXECUTE')
    and has_function_privilege('authenticated',
      'public.platform_set_approval_policy(uuid,text,numeric,integer,boolean,text)', 'EXECUTE')
    and not has_function_privilege('anon',
      'public.platform_set_approval_policy(uuid,text,numeric,integer,boolean,text)', 'EXECUTE'),
  'the wave-9 RPC grant matrix must hold');

-- The delivery boundary stays service-only (0024:257-262 survived CREATE OR REPLACE).
select pg_temp.p9_assert(
  has_function_privilege('service_role',
    'public.enqueue_notification_delivery(uuid,text,text,text,text,text,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated',
      'public.enqueue_notification_delivery(uuid,text,text,text,text,text,text,text)', 'EXECUTE')
    and not has_function_privilege('anon',
      'public.enqueue_notification_delivery(uuid,text,text,text,text,text,text,text)', 'EXECUTE'),
  'the notification delivery boundary must remain service_role only');

-- A5 discipline. Three of the five new functions are deliberately NOT definers, so they never
-- enter A5 at all; the two that are, name no enforced table.
select pg_temp.p9_assert(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('global_search', 'evaluate_approval_policy', 'read_allowed_transitions')
     and not p.prosecdef) = 3,
  'global_search, the policy evaluator and the transition reader must stay SECURITY INVOKER');

select pg_temp.p9_assert(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (select table_name from private.scope_registry where enforced) r
    where n.nspname in ('public', 'private')
      and p.proname in ('set_notification_preference', 'read_notification_preferences',
                        'platform_set_approval_policy', 'evaluate_approval_policy',
                        'read_allowed_transitions', 'enqueue_notification_delivery')
      and p.prosrc ~ ('\m' || r.table_name || '\M')),
  'no wave-9 function body may name an enforced table -- entity names are data');

select pg_temp.p9_assert(
  (select count(*) from private.scope_definer_exemptions) = 59,
  'the definer exemption registry must stay frozen at 59 rows -- zero wave-9 additions');

select pg_temp.p9_assert(
  (select count(*) from private.scope_enforcement_violations()) = 0,
  'A1/A3/A5 must all be silent after the wave-9 migrations');

-- global_search: what 0069 promised not to touch.
select pg_temp.p9_assert(
  (select prosrc like '%limit 30%' and prosrc like '%auth_role()%'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'global_search'),
  'global_search must keep limit 30 and now consult auth_role()');

select pg_temp.p9_assert(
  (select pg_get_function_arg_default(p.oid, 2) = '5'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'global_search'),
  'the per_type default must stay 5');

select pg_temp.p9_assert(
  (select count(*) from pg_indexes
   where schemaname = 'public'
     and indexname in ('suppliers_name_trgm', 'suppliers_contact_trgm', 'products_name_trgm',
                       'products_sku_trgm', 'invoices_number_trgm', 'payments_ref_trgm')) = 6,
  'all six trigram indexes of 0011 must survive -- replacing pg_trgm is a wave-10 decision');

-- ===== Trusted fixtures (no JWT: migration/seed-style work) =====
select pg_temp.p9_claims(null);

insert into organizations (id, name, status) values
  ('19000000-0000-4000-8000-000000000001', 'P9 tenant', 'active'),
  ('19000000-0000-4000-8000-000000000002', 'P9 foreign tenant', 'active');

insert into auth.users (id, email) values
  ('29000000-0000-4000-8000-000000000001', 'p9-owner@example.test'),
  ('29000000-0000-4000-8000-000000000002', 'p9-office@example.test'),
  ('29000000-0000-4000-8000-000000000003', 'p9-kitchen@example.test'),
  ('29000000-0000-4000-8000-000000000004', 'p9-accountant@example.test'),
  ('29000000-0000-4000-8000-000000000005', 'p9-payer@example.test'),
  ('29000000-0000-4000-8000-000000000006', 'p9-agent@example.test'),
  ('29000000-0000-4000-8000-000000000007', 'p9-foreign-owner@example.test'),
  ('29000000-0000-4000-8000-000000000008', 'p9-operator@example.test');

insert into suppliers (id, org_id, name) values
  ('39000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001',
   'P9SEARCH Supplier'),
  ('39000000-0000-4000-8000-000000000002', '19000000-0000-4000-8000-000000000002',
   'P9SEARCH Foreign Supplier');

insert into profiles (id, org_id, full_name, role, supplier_id) values
  ('29000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001',
   'P9 Owner', 'owner', null),
  ('29000000-0000-4000-8000-000000000002', '19000000-0000-4000-8000-000000000001',
   'P9 Office', 'office', null),
  ('29000000-0000-4000-8000-000000000003', '19000000-0000-4000-8000-000000000001',
   'P9 Kitchen', 'kitchen', null),
  ('29000000-0000-4000-8000-000000000004', '19000000-0000-4000-8000-000000000001',
   'P9 Accountant', 'accountant', null),
  ('29000000-0000-4000-8000-000000000005', '19000000-0000-4000-8000-000000000001',
   'P9 Payer', 'payer', null),
  ('29000000-0000-4000-8000-000000000006', '19000000-0000-4000-8000-000000000001',
   'P9 Supplier Agent', 'supplier', '39000000-0000-4000-8000-000000000001'),
  ('29000000-0000-4000-8000-000000000007', '19000000-0000-4000-8000-000000000002',
   'P9 Foreign Owner', 'owner', null);

insert into platform_admins (user_id, note) values
  ('29000000-0000-4000-8000-000000000008', 'P9 platform operator');

insert into categories (id, org_id, name) values
  ('49000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001', 'P9 Category');

insert into products (id, org_id, category_id, name, unit) values
  ('59000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001',
   '49000000-0000-4000-8000-000000000001', 'P9SEARCH Product', 'ק"ג');

-- One approved charge, so the accountant branch has a row it may legally see and so the
-- payment-request approval preconditions of 0031:887-917 are satisfiable.
insert into invoices (id, org_id, supplier_id, invoice_number, invoice_date, total_amount,
                      review_status) values
  ('69000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001',
   '39000000-0000-4000-8000-000000000001', 'P9SEARCH-INV-1', current_date, 500, 'approved'),
  ('69000000-0000-4000-8000-000000000002', '19000000-0000-4000-8000-000000000001',
   '39000000-0000-4000-8000-000000000001', 'P9SEARCH-INV-2', current_date, 300, 'received');

insert into purchase_orders (id, org_id, supplier_id, status, created_by) values
  ('79000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001',
   '39000000-0000-4000-8000-000000000001', 'draft', '29000000-0000-4000-8000-000000000001');

insert into payments (id, org_id, supplier_id, amount, paid_date, method, reference) values
  ('89000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001',
   '39000000-0000-4000-8000-000000000001', 250, current_date, 'העברה בנקאית', 'P9SEARCH-REF');

insert into credit_requests (id, org_id, supplier_id, invoice_id, reason, amount, status) values
  ('99000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001',
   '39000000-0000-4000-8000-000000000001', null, 'damaged', 40, 'open');

insert into payment_requests (id, org_id, supplier_id, amount, status, created_by) values
  ('a9000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001',
   '39000000-0000-4000-8000-000000000001', 500, 'draft',
   '29000000-0000-4000-8000-000000000001');

-- org_id carries a default of auth_org(), and this fixture block runs without a subject on
-- purpose (see p9_claims). Name it explicitly rather than let a NOT NULL default resolve to NULL.
insert into payment_request_invoices (org_id, payment_request_id, invoice_id, amount_allocated)
values ('19000000-0000-4000-8000-000000000001',
        'a9000000-0000-4000-8000-000000000001',
        '69000000-0000-4000-8000-000000000001', 500);

-- ===== (b) notification preferences, through the REAL delivery command =====

-- The audience with no preference row anywhere: owner + office, active, this tenant. This is
-- the control reading, computed independently of the command.
select pg_temp.p9_assert(
  (select count(*) from profiles p
   where p.org_id = '19000000-0000-4000-8000-000000000001'
     and p.active and p.role in ('owner', 'office')) = 2,
  'the P9 fixture must hold exactly two members of the notification audience');

-- (b1) ABSENT ROW = the previous behaviour, byte for byte.
select pg_temp.p9_assert(
  (select array_agg(d.user_id order by d.user_id)
   from public.enqueue_notification_delivery(
     '19000000-0000-4000-8000-000000000001', 'duplicate_invoice', 'p9-key-baseline',
     'critical', 'P9 title', 'P9 body', '/alerts', 'p9:baseline') d)
  = array['29000000-0000-4000-8000-000000000001'::uuid,
          '29000000-0000-4000-8000-000000000002'::uuid],
  'with no preference rows the command must return exactly the historical audience');

select pg_temp.p9_assert(
  (select count(*) from notifications
   where entity_key = 'p9-key-baseline' and push_sent_at is null) = 2,
  'both baseline rows must exist with the Push leg still pending');

-- (b2) A PUSH opt-out removes Push and LEAVES the row (the #39 badge contract).
select pg_temp.p9_claims('29000000-0000-4000-8000-000000000001');
select set_notification_preference('payment_due', false, true);
select pg_temp.p9_claims(null);

select pg_temp.p9_assert(
  (select array_agg(d.user_id)
   from public.enqueue_notification_delivery(
     '19000000-0000-4000-8000-000000000001', 'payment_due', 'p9-key-push-off',
     'warning', 'P9 title', 'P9 body', '/payment-requests', 'p9:push-off') d)
  = array['29000000-0000-4000-8000-000000000002'::uuid],
  'a Push opt-out must remove the muted member from the PUSH work list only');

select pg_temp.p9_assert(
  (select count(*) from notifications
   where entity_key = 'p9-key-push-off'
     and user_id = '29000000-0000-4000-8000-000000000001'
     and push_sent_at is not null and push_attempts = 0) = 1,
  'the muted member must still receive the bell row, with the Push leg settled unattempted');

select pg_temp.p9_assert(
  (select count(*) from notifications where entity_key = 'p9-key-push-off') = 2,
  'a Push opt-out must not reduce the number of stored notifications');

-- (b3) An IN-APP opt-out removes the row itself -- and Push with it, because Push rides on
-- the row.
select pg_temp.p9_claims('29000000-0000-4000-8000-000000000002');
select set_notification_preference('price_increase', true, false);
select pg_temp.p9_claims(null);

select pg_temp.p9_assert(
  (select array_agg(d.user_id)
   from public.enqueue_notification_delivery(
     '19000000-0000-4000-8000-000000000001', 'price_increase', 'p9-key-inapp-off',
     'warning', 'P9 title', 'P9 body', '/prices', 'p9:inapp-off') d)
  = array['29000000-0000-4000-8000-000000000001'::uuid],
  'an in-app opt-out must remove that member from the delivery entirely');

select pg_temp.p9_assert(
  (select count(*) from notifications
   where entity_key = 'p9-key-inapp-off'
     and user_id = '29000000-0000-4000-8000-000000000002') = 0,
  'an in-app opt-out must leave NO stored notification for that member');

select pg_temp.p9_assert(
  (select count(*) from notifications where entity_key = 'p9-key-inapp-off') = 1,
  'the other member must still be served while one opts out of the in-app record');

-- (b4) A preference cannot WIDEN the audience. The payer stores the most permissive
-- preference possible and still receives nothing.
select pg_temp.p9_claims('29000000-0000-4000-8000-000000000005');
select set_notification_preference('duplicate_invoice', true, true);
select pg_temp.p9_claims(null);

select pg_temp.p9_assert(
  (select array_agg(d.user_id order by d.user_id)
   from public.enqueue_notification_delivery(
     '19000000-0000-4000-8000-000000000001', 'duplicate_invoice', 'p9-key-widen',
     'critical', 'P9 title', 'P9 body', '/alerts', 'p9:widen') d)
  = array['29000000-0000-4000-8000-000000000001'::uuid,
          '29000000-0000-4000-8000-000000000002'::uuid],
  'an opted-IN preference must not add a member the role gate excludes');

select pg_temp.p9_assert(
  (select count(*) from notifications
   where entity_key = 'p9-key-widen'
     and user_id = '29000000-0000-4000-8000-000000000005') = 0,
  'the payer must hold a preference row and still receive no notification');

-- (b5) The command surface: self only, catalogued codes only, reasoned audit.
select pg_temp.p9_assert(
  (select array_length(p.proargnames, 1) = 3
     and not (p.proargnames && array['p_user_id'])
   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'set_notification_preference'),
  'set_notification_preference must take three arguments and no target user');

select pg_temp.p9_assert(
  (select count(*) from audit_logs
   where action = 'notification_preference_set'
     and org_id = '19000000-0000-4000-8000-000000000001'
     and nullif(btrim(reason), '') is not null) = 3,
  'every preference write must leave a reasoned audit row in the same transaction');

select pg_temp.p9_claims('29000000-0000-4000-8000-000000000001');
do $$
begin
  begin
    perform set_notification_preference('p9_not_a_real_event', true, true);
    raise exception 'P9 five domains assertion failed: an uncatalogued event code must be rejected';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform set_notification_preference('payment_due', null, true);
    raise exception 'P9 five domains assertion failed: a null flag must be rejected';
  exception when sqlstate '22023' then null;
  end;
end
$$;

-- (b6) The reader: complete, defaulted, tenant-and-caller pinned.
select pg_temp.p9_assert(
  (select count(*) from read_notification_preferences()) = 3
    and (select count(*) from read_notification_preferences() where configured) = 1
    and (select push_enabled = false and inapp_enabled = true
         from read_notification_preferences() where event_code = 'payment_due')
    and (select push_enabled and inapp_enabled
         from read_notification_preferences() where event_code = 'price_increase'),
  'the reader must return every catalogued code, stored values first, defaults elsewhere');

select pg_temp.p9_claims('29000000-0000-4000-8000-000000000007');
select pg_temp.p9_assert(
  (select count(*) from read_notification_preferences() where configured) = 0,
  'a member of another tenant must see none of this tenant''s preferences');

select pg_temp.p9_claims(null);
select pg_temp.p9_assert(
  (select count(*) from read_notification_preferences()) = 0,
  'without a subject the reader must return nothing at all');

-- ===== (c) the search type gate =====
-- The subject under test is the TYPE gate inside the function body, which is why this runs as
-- the harness role: row visibility (RLS) is a separate contract with its own suites, and the
-- gate must hold regardless of it. Tenant scoping still applies -- every branch filters on
-- auth_org(), which resolves from the stamped claims.

create function pg_temp.p9_search_entities(p_sub uuid)
returns text[]
language plpgsql
as $$
declare
  v_entities text[];
begin
  perform pg_temp.p9_claims(p_sub);
  select coalesce(array_agg(distinct g.entity order by g.entity), '{}'::text[])
    into v_entities
  from global_search('P9SEARCH', 5) g;
  perform pg_temp.p9_claims(null);
  return v_entities;
end
$$;

select pg_temp.p9_assert(
  pg_temp.p9_search_entities('29000000-0000-4000-8000-000000000001')
    = array['credit', 'invoice', 'order', 'payment', 'product', 'supplier'],
  'an owner must still receive all six result types');

select pg_temp.p9_assert(
  not (pg_temp.p9_search_entities('29000000-0000-4000-8000-000000000002') && array['payment'])
    and pg_temp.p9_search_entities('29000000-0000-4000-8000-000000000002') && array['supplier'],
  'office may not receive payment hits -- /payments is owner/accountant only');

select pg_temp.p9_assert(
  not (pg_temp.p9_search_entities('29000000-0000-4000-8000-000000000003') && array['payment']),
  'kitchen may not receive payment hits');

select pg_temp.p9_assert(
  not (pg_temp.p9_search_entities('29000000-0000-4000-8000-000000000004')
       && array['supplier', 'product', 'order']),
  'an accountant may not receive supplier, product or order hits -- those routes are staff');

select pg_temp.p9_assert(
  pg_temp.p9_search_entities('29000000-0000-4000-8000-000000000005') = '{}'::text[],
  'a payer must receive NOTHING from global search -- their only route is the pay queue');

select pg_temp.p9_assert(
  pg_temp.p9_search_entities('29000000-0000-4000-8000-000000000006') = '{}'::text[],
  'a supplier agent must receive NOTHING from global search');

select pg_temp.p9_assert(
  pg_temp.p9_search_entities(null) = '{}'::text[],
  'an unresolvable role must receive nothing -- the gate fails closed');

-- ===== (d) the approval policy =====

select pg_temp.p9_claims('29000000-0000-4000-8000-000000000001');
select pg_temp.p9_assert(
  (select not configured and not applies
     and threshold_amount is null and required_approvals is null
   from evaluate_approval_policy('payment_request.approval', 1000)),
  'with no configuration the evaluator must report a MARK, never a zero');

-- Only the platform operator writes, and only with a reason.
do $$
begin
  begin
    perform platform_set_approval_policy(
      '19000000-0000-4000-8000-000000000001', 'payment_request.approval',
      null, 2, false, 'P9 owner attempt');
    raise exception 'P9 five domains assertion failed: an owner must not configure a policy';
  exception when sqlstate '42501' then null;
  end;
end
$$;

select pg_temp.p9_claims('29000000-0000-4000-8000-000000000008');
do $$
begin
  begin
    perform platform_set_approval_policy(
      '19000000-0000-4000-8000-000000000001', 'payment_request.approval', null, 2, false, '   ');
    raise exception 'P9 five domains assertion failed: a blank reason must be rejected';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform platform_set_approval_policy(
      '19000000-0000-4000-8000-000000000001', 'p9.no.such.policy', null, 2, false, 'P9');
    raise exception 'P9 five domains assertion failed: an undefined policy must be rejected';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform platform_set_approval_policy(
      '19000000-0000-4000-8000-000000000001', 'payment_request.approval', null, 0, false, 'P9');
    raise exception 'P9 five domains assertion failed: fewer than one approval must be rejected';
  exception when sqlstate '22023' then null;
  end;
end
$$;

-- The tighten-only law (#104), against a definition whose baseline is genuinely strict.
insert into private.approval_policy_definitions
  (policy_key, description, baseline_required_approvals, baseline_step_up_required)
values ('p9.strict', 'P9 strict baseline, for the tighten-only proof', 2, true);

do $$
begin
  begin
    perform platform_set_approval_policy(
      '19000000-0000-4000-8000-000000000001', 'p9.strict', null, 1, true, 'P9 loosen count');
    raise exception 'P9 five domains assertion failed: fewer approvals than the baseline must be rejected';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform platform_set_approval_policy(
      '19000000-0000-4000-8000-000000000001', 'p9.strict', null, 3, false, 'P9 drop step-up');
    raise exception 'P9 five domains assertion failed: withdrawing a baseline step-up must be rejected';
  exception when sqlstate '22023' then null;
  end;
end
$$;

select pg_temp.p9_assert(
  platform_set_approval_policy(
    '19000000-0000-4000-8000-000000000001', 'p9.strict', null, 3, true,
    'P9 tightening beyond the baseline') is not null,
  'a strictly tighter configuration must be accepted');

select platform_set_approval_policy(
  '19000000-0000-4000-8000-000000000001', 'payment_request.approval', 1000, 2, true,
  'P9 threshold configuration');
select platform_set_approval_policy(
  '19000000-0000-4000-8000-000000000002', 'payment_request.approval', 1, 4, true,
  'P9 foreign tenant configuration');

select pg_temp.p9_assert(
  (select count(*) from audit_logs
   where action = 'approval_policy_configured'
     and org_id = '19000000-0000-4000-8000-000000000001'
     and nullif(btrim(reason), '') is not null) = 2,
  'every policy write must audit to the TARGET organization with its reason');

-- The evaluator: threshold arithmetic, and the tenant boundary through plain RLS.
select pg_temp.p9_claims('29000000-0000-4000-8000-000000000001');
select pg_temp.p9_assert(
  (select configured and not applies
   from evaluate_approval_policy('payment_request.approval', 999.99)),
  'below the threshold the requirement is configured but does not apply');

select pg_temp.p9_assert(
  (select configured and applies and required_approvals = 2 and step_up_required
   from evaluate_approval_policy('payment_request.approval', 1000)),
  'at the threshold the configured requirement applies exactly as stored');

select pg_temp.p9_assert(
  (select required_approvals = 2
   from evaluate_approval_policy('payment_request.approval', 5000)),
  'this tenant must see its OWN configuration, not the foreign tenant''s stricter one');

select pg_temp.p9_claims('29000000-0000-4000-8000-000000000007');
select pg_temp.p9_assert(
  (select required_approvals = 4
   from evaluate_approval_policy('payment_request.approval', 5000)),
  'the foreign tenant must see its own configuration -- invoker rights plus RLS, no filter code');

select pg_temp.p9_claims('29000000-0000-4000-8000-000000000001');
do $$
begin
  begin
    perform 1 from evaluate_approval_policy('payment_request.approval', null);
    raise exception 'P9 five domains assertion failed: a null amount must be rejected';
  exception when sqlstate '22023' then null;
  end;
end
$$;

-- THE STRUCTURAL PROOF: nothing calls the evaluator. Not a command, not a policy.
select pg_temp.p9_assert(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname <> 'evaluate_approval_policy'
      and p.prosrc ~ '\mevaluate_approval_policy\M'),
  'NO function may call evaluate_approval_policy -- wiring it re-decides OPEN-DECISIONS #2');

select pg_temp.p9_assert(
  not exists (
    select 1 from pg_catalog.pg_policy pol
    where coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '')
            ~ '\mevaluate_approval_policy\M'
       or coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '')
            ~ '\mevaluate_approval_policy\M'),
  'no RLS USING/WITH CHECK expression may mention the evaluator (SECURITY-MODEL:246-251)');

-- Named explicitly, because these five are the commands a future wave would be tempted to
-- wire, and PLAN-10 forbids touching them at all this wave.
select pg_temp.p9_assert(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('transition_payment_request', 'set_invoice_review_status',
                        'execute_payment_request', 'execute_emergency_payment_request',
                        'transition_credit_request')
      and (p.prosrc ilike '%approval_polic%' or p.prosrc ilike '%evaluate_approval%')),
  'not one financial command may know that approval policies exist');

-- ===== (e) read_allowed_transitions mirrors the live matrices =====

select pg_temp.p9_assert(
  (select count(*) from read_allowed_transitions('invoice_review', 'approved')) = 1
    and exists (select 1 from read_allowed_transitions('invoice_review', 'approved')
                where next_status = 'investigation'),
  'approved -> investigation must be reported -- the drift #105 documents');

do $$
begin
  begin
    perform 1 from read_allowed_transitions('p9_not_an_entity', 'draft');
    raise exception 'P9 five domains assertion failed: an unknown entity type must be rejected';
  exception when sqlstate 'P0002' then null;
  end;
end
$$;

select pg_temp.p9_assert(
  (select count(*) from read_allowed_transitions('purchase_order', 'confirmed')) = 0
    and (select count(*) from read_allowed_transitions('credit_request', 'closed')) = 0
    and (select count(*) from read_allowed_transitions('payment_request', 'executed')) = 0,
  'a terminal status must answer with zero rows, not an error');

select pg_temp.p9_assert(
  not exists (
    select 1
    from (values ('invoice_review', 'in_review'), ('payment_request', 'approved'),
                 ('credit_request', 'open'), ('purchase_order', 'draft')) as probe(e, s)
    cross join lateral read_allowed_transitions(probe.e, probe.s) t
    where t.next_status = probe.s),
  'a self-transition is never a transition -- every command calls it idempotent success');

-- The probe. For every ordered pair of statuses: put the fixture row in the FROM status as
-- untrusted-free seed work, call the REAL command as the owner, and compare "the command did
-- not reject the graph" against "the reader listed it". Anything else the command raises is a
-- test defect and stops the run, so the comparison can never be laundered into a pass.
create function pg_temp.p9_probe(
  p_entity text,
  p_states text[],
  p_targets text[],
  p_call text,
  p_reject text,
  p_reset text
) returns void
language plpgsql
as $$
declare
  v_from text;
  v_to text;
  v_reader boolean;
  v_error text;
begin
  foreach v_from in array p_states loop
    foreach v_to in array p_targets loop
      if v_from = v_to then continue; end if;

      select exists (
        select 1 from read_allowed_transitions(p_entity, v_from) t where t.next_status = v_to
      ) into v_reader;

      perform pg_temp.p9_claims(null);
      execute format(p_reset, v_from);
      perform pg_temp.p9_claims('29000000-0000-4000-8000-000000000001');

      v_error := null;
      begin
        execute format(p_call, v_to);
      exception when others then
        v_error := sqlerrm;
      end;
      perform pg_temp.p9_claims(null);

      if v_error is not null and v_error <> p_reject then
        raise exception
          'P9 probe (%): % -> % raised an unexpected error: %', p_entity, v_from, v_to, v_error;
      end if;

      if v_reader <> (v_error is null) then
        raise exception
          'P9 probe (%): % -> % -- reader says %, the live command says %',
          p_entity, v_from, v_to, v_reader, v_error is null;
      end if;
    end loop;
  end loop;
end
$$;

select pg_temp.p9_probe(
  'invoice_review',
  array['received', 'in_review', 'pending_approval', 'approved', 'investigation'],
  array['received', 'in_review', 'pending_approval', 'approved', 'investigation'],
  $$select set_invoice_review_status(
      '69000000-0000-4000-8000-000000000002', %L::invoice_review_status, 'P9 probe')$$,
  'invoice_review_transition_invalid',
  $$update invoices set review_status = %L::invoice_review_status
     where id = '69000000-0000-4000-8000-000000000002'$$);

select pg_temp.p9_probe(
  'payment_request',
  array['draft', 'pending_approval', 'approved', 'sent_for_execution', 'executed', 'matched',
        'investigation', 'suspected_duplicate', 'cancelled'],
  array['pending_approval', 'approved', 'sent_for_execution', 'investigation', 'cancelled'],
  $$select transition_payment_request(
      'a9000000-0000-4000-8000-000000000001', %L, 'P9 probe')$$,
  'payment_request_transition_invalid',
  $$update payment_requests set status = %L::payment_request_status
     where id = 'a9000000-0000-4000-8000-000000000001'$$);

select pg_temp.p9_probe(
  'credit_request',
  array['open', 'requested', 'received', 'offset', 'closed'],
  array['open', 'requested', 'received', 'offset', 'closed'],
  $$select transition_credit_request(
      '99000000-0000-4000-8000-000000000001', %L::credit_status, 'P9 probe')$$,
  'credit_request_transition_invalid',
  $$update credit_requests set status = %L::credit_status
     where id = '99000000-0000-4000-8000-000000000001'$$);

select pg_temp.p9_probe(
  'purchase_order',
  array['draft', 'ready', 'sent', 'confirmed', 'partial', 'received', 'cancelled'],
  array['ready', 'sent', 'confirmed'],
  $$select transition_purchase_order_status(
      '79000000-0000-4000-8000-000000000001', %L, 'P9 probe', null, null)$$,
  'purchase_order_status_transition_invalid',
  $$update purchase_orders set status = %L::po_status, sent_at = null, confirmed_at = null,
       confirmation_note = null
     where id = '79000000-0000-4000-8000-000000000001'$$);

-- ===== (f) the mutation proof: a weakened type gate is detected =====
-- The gate assertion in (c) has teeth only if it fails against a search that ignores the
-- role. A deliberately weakened stand-in with the same signature is installed, the payer
-- probe is re-run, and it must now find rows -- then the savepoint takes it away again.
savepoint p9_search_gate_mutation;

create or replace function global_search(q text, per_type int default 5)
returns table (
  entity text, id uuid, title text, subtitle text,
  status text, amount numeric(12,2), occurred_at date, rank int
)
language plpgsql stable set search_path = public as $$
begin
  -- The defect this wave fixed: results chosen without consulting the caller's role.
  return query
  select 'supplier'::text, s.id, s.name, null::text, s.status::text,
         null::numeric(12,2), null::date, 1
  from suppliers s
  where s.org_id = auth_org() and s.name ilike '%' || q || '%';
end $$;

select pg_temp.p9_assert(
  pg_temp.p9_search_entities('29000000-0000-4000-8000-000000000005') <> '{}'::text[],
  'the mutation must be visible -- otherwise the payer assertion above proves nothing');

rollback to savepoint p9_search_gate_mutation;

select pg_temp.p9_assert(
  pg_temp.p9_search_entities('29000000-0000-4000-8000-000000000005') = '{}'::text[],
  'with the real function restored the payer must again receive nothing');

rollback;

\echo 'p9_five_domains_passed'
