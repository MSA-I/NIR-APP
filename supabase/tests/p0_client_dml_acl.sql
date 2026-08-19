-- P0 browser-write, trusted-server CRUD and reasoned-command regression harness. Run only against an isolated local
-- database after applying migrations through 0042_profile_self_service_acl.sql.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p0_acl_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P0 ACL assertion failed: %', p_message;
  end if;
end
$$;

-- ===== Static browser-write and trusted-server CRUD contract =====

-- The trusted server holds full CRUD on every public table except the named command-only
-- ledgers below. Each exception is listed rather than pattern-matched so that the next table
-- to drop a grant has to make its own case here instead of being absorbed silently.
--
-- org_autonomy_policies (0076) governs whether the system may write a financial record with no
-- human approval. Its only legitimate writer is platform_set_autonomy_policy, a SECURITY
-- DEFINER owned by postgres, which writes AS postgres regardless of the caller's own grants --
-- so the service_role grant buys that table nothing. What it cost was measurable: review ran
-- `set role service_role` and a plain INSERT stored min_confidence = 0.050, BELOW the
-- documented 0.900 floor, with zero reasoned audit rows. The tighten-only law and the
-- mandatory reason both live inside the command body, so a writer that skips the command
-- skips both. TRUNCATE is revoked with the rest because it fires no row trigger and would
-- empty every tenant's configuration without leaving an audit row.
--
-- The opposite assertion -- that this table exposes NO DML to any non-superuser role -- lives
-- in supabase/tests/p13_document_autonomy_config.sql:249-259. The two suites are deliberate
-- mirrors: land on either one and the other is one grep away.
create function pg_temp.p0_service_role_write_exceptions()
returns table (table_name text, why text)
language sql
immutable
as $$
  select * from (values
    (
      'org_autonomy_policies'::text,
      'autonomy configuration (0076): the only legitimate writer is a SECURITY DEFINER owned by '
      || 'postgres, so the grant buys nothing and costs a bypass of the tighten-only floor and '
      || 'the mandatory reason'::text
    ),
    (
      'org_assistant_policies'::text,
      'assistant permission policy (0164): the only legitimate writer is a SECURITY DEFINER owned '
      || 'by postgres, so the grant buys nothing and costs a bypass of the mandatory reason and '
      || 'the audit row to the target organization'::text
    ),
    (
      'price_list_shadow_runs'::text,
      'immutable automation evidence (0096): writes require the bounded shadow RPC and its '
      || 'document/job/interpretation chain; direct service DML could forge or erase evidence'::text
    ),
    (
      'price_list_shadow_lines'::text,
      'immutable line evidence (0096): writes are owned by the same bounded shadow RPC; direct '
      || 'service DML could change the prediction later compared with a human decision'::text
    ),
    (
      'price_list_calibration_reviews'::text,
      'human calibration evidence (0096): only the authenticated reviewed command may append a '
      || 'reasoned revision; service DML could impersonate a reviewer'::text
    ),
    (
      'price_list_empty_run_reviews'::text,
      'human empty-run evidence (0096): only the authenticated reviewed command may append a '
      || 'reasoned revision; service DML could impersonate a reviewer'::text
    ),
    (
      'price_list_automation_scope_decisions'::text,
      'platform eligibility evidence (0096): only the step-up, reasoned platform command may '
      || 'append a decision; service DML would bypass corpus and audit checks'::text
    )
  ) as exceptions(table_name, why)
$$;

select pg_temp.p0_acl_assert(
  not exists (
    select 1
    from pg_temp.p0_service_role_write_exceptions() exceptions
    left join pg_catalog.pg_class relation
      on relation.oid = to_regclass(format('%I.%I', 'public', exceptions.table_name))
    left join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where relation.oid is null
       or relation.relkind not in ('r', 'p')
       or namespace.nspname is distinct from 'public'
  ),
  'a service_role write exception does not resolve to an existing public table'
);

select pg_temp.p0_acl_assert(
  not exists (
    select 1
    from pg_catalog.pg_tables table_info
    where table_info.schemaname = 'public'
      and table_info.tablename not in (
        select exceptions.table_name from pg_temp.p0_service_role_write_exceptions() exceptions)
      and (
        not has_table_privilege(
          'service_role', format('%I.%I', table_info.schemaname, table_info.tablename), 'SELECT'
        )
        or not has_table_privilege(
          'service_role', format('%I.%I', table_info.schemaname, table_info.tablename), 'INSERT'
        )
        or not has_table_privilege(
          'service_role', format('%I.%I', table_info.schemaname, table_info.tablename), 'UPDATE'
        )
        or not has_table_privilege(
          'service_role', format('%I.%I', table_info.schemaname, table_info.tablename), 'DELETE'
        )
      )
  ),
  'service_role is missing full CRUD on a public server table'
);

-- The latch, in the spirit of p9_five_domains.sql's exemption-count pin: the exception list
-- stays at exactly seven entries. An agent that revokes the grant on another table must edit THIS
-- line and argue for it, rather than appending a row and watching the suite stay green.
-- The seventh is org_assistant_policies (0164), and the argument is the one 0076 already made and
-- measured: the switch that lets a confirmed assistant proposal execute may only be moved by a
-- reasoned, audited platform command, so a service_role grant buys nothing and costs that guarantee.
select pg_temp.p0_acl_assert(
  (select count(*) from pg_temp.p0_service_role_write_exceptions()) = 7,
  'the service_role write-exception list must stay at exactly seven command-only tables; a new '
  || 'exception is a security decision, not an append'
);

-- The exception must be EXERCISED, not merely declared. A listed table that still holds the
-- grant would be a rubber stamp: the main assertion would skip it, and a restored grant would
-- go unnoticed forever. This is the same defect class review found in p13 -- a predicate that
-- does not check what its sentence claims.
select pg_temp.p0_acl_assert(
  not exists (
    select 1
    from pg_temp.p0_service_role_write_exceptions() exceptions
    cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) privileges(privilege)
    where has_table_privilege(
      'service_role', format('public.%I', exceptions.table_name), privileges.privilege)
  ),
  'a table listed as a service_role write exception still holds write privileges -- the '
  || 'exception is hiding a grant instead of documenting its absence'
);

-- SELECT deliberately survives on the exception: a trusted server reading the configuration
-- that governs it is legitimate, and revoking it would push a future reader toward re-deriving
-- the answer from parts.
select pg_temp.p0_acl_assert(
  not exists (
    select 1
    from pg_temp.p0_service_role_write_exceptions() exceptions
    where not has_table_privilege(
      'service_role', format('public.%I', exceptions.table_name), 'SELECT')
  ),
  'a service_role write exception must keep SELECT -- only its write path is closed'
);

select pg_temp.p0_acl_assert(
  not has_table_privilege('anon', 'public.notification_event_states', 'SELECT')
  and not has_table_privilege('anon', 'public.notification_event_states', 'INSERT')
  and not has_table_privilege('anon', 'public.notification_event_states', 'UPDATE')
  and not has_table_privilege('anon', 'public.notification_event_states', 'DELETE')
  and not has_table_privilege('authenticated', 'public.notification_event_states', 'SELECT')
  and not has_table_privilege('authenticated', 'public.notification_event_states', 'INSERT')
  and not has_table_privilege('authenticated', 'public.notification_event_states', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.notification_event_states', 'DELETE')
  and has_table_privilege('service_role', 'public.notification_event_states', 'SELECT')
  and has_table_privilege('service_role', 'public.notification_event_states', 'INSERT')
  and has_table_privilege('service_role', 'public.notification_event_states', 'UPDATE')
  and has_table_privilege('service_role', 'public.notification_event_states', 'DELETE'),
  'notification delivery state ACL is not service-only'
);

-- 0091: feedback notes are append-only from the browser, and "delivered" is not a claim the client
-- is able to make. The author's columns hold INSERT; sent_at and send_error hold no grant at all,
-- which is what lets the UI's "נשלח" mean the server observed a delivery. Same column-grant
-- discipline as suppliers.bank_details (0061/0088), applied to an honesty boundary instead of a
-- fraud surface.
select pg_temp.p0_acl_assert(
  has_table_privilege('authenticated', 'public.feedback_notes', 'SELECT')
  and has_column_privilege('authenticated', 'public.feedback_notes', 'note', 'INSERT')
  and has_column_privilege('authenticated', 'public.feedback_notes', 'route', 'INSERT')
  and has_column_privilege('authenticated', 'public.feedback_notes', 'viewport_width', 'INSERT')
  and not has_column_privilege('authenticated', 'public.feedback_notes', 'sent_at', 'INSERT')
  and not has_column_privilege('authenticated', 'public.feedback_notes', 'send_error', 'INSERT')
  and not has_column_privilege('authenticated', 'public.feedback_notes', 'created_at', 'INSERT')
  and not has_any_column_privilege('authenticated', 'public.feedback_notes', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.feedback_notes', 'DELETE')
  and not has_table_privilege('anon', 'public.feedback_notes', 'SELECT')
  and not has_any_column_privilege('anon', 'public.feedback_notes', 'INSERT'),
  'feedback notes ACL must be append-only for the browser, with no grant on the delivery columns'
);

select pg_temp.p0_acl_assert(
  not exists (
    select 1
    from (values
      ('public.organizations'::regclass, false),
      ('public.categories'::regclass, true),
      ('public.suppliers'::regclass, false),
      ('public.products'::regclass, false),
      ('public.purchase_requests'::regclass, false),
      ('public.purchase_request_items'::regclass, false),
      ('public.purchase_orders'::regclass, false),
      ('public.exceptions'::regclass, false),
      ('public.documents'::regclass, false),
      ('public.push_subscriptions'::regclass, true)
    ) as protected_tables(relation, browser_delete_allowed)
    where has_table_privilege('anon', relation, 'INSERT')
       or has_table_privilege('anon', relation, 'UPDATE')
       or has_table_privilege('anon', relation, 'DELETE')
       or has_table_privilege('authenticated', relation, 'INSERT')
       or has_table_privilege('authenticated', relation, 'UPDATE')
       or (
         has_table_privilege('authenticated', relation, 'DELETE')
         and not browser_delete_allowed
       )
       or (
         not has_table_privilege('authenticated', relation, 'DELETE')
         and browser_delete_allowed
       )
  ),
  'browser role received broad DML outside the 0030 allowlist'
);

select pg_temp.p0_acl_assert(
  has_column_privilege('authenticated', 'public.organizations', 'name', 'UPDATE')
  and has_column_privilege('authenticated', 'public.categories', 'org_id', 'INSERT')
  and has_column_privilege('authenticated', 'public.categories', 'name', 'UPDATE')
  and has_table_privilege('authenticated', 'public.categories', 'DELETE')
  and has_column_privilege('authenticated', 'public.suppliers', 'name', 'INSERT')
  and has_column_privilege('authenticated', 'public.suppliers', 'name', 'UPDATE')
  and has_column_privilege('authenticated', 'public.products', 'active', 'INSERT')
  and has_column_privilege('authenticated', 'public.products', 'name', 'UPDATE')
  and has_column_privilege('authenticated', 'public.exceptions', 'status', 'UPDATE')
  and has_column_privilege('authenticated', 'public.documents', 'deleted_at', 'UPDATE')
  and has_table_privilege('authenticated', 'public.push_subscriptions', 'DELETE'),
  'required browser DML privilege is missing'
);

select pg_temp.p0_acl_assert(
  not has_column_privilege('authenticated', 'public.organizations', 'status', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.suppliers', 'org_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.suppliers', 'deleted_at', 'UPDATE')
  -- 0089: joining without consenting to a named terms version must be impossible from the
  -- browser — the 3-arg accept_invitation lost its grant; only the consent-taking 4-arg
  -- overload remains callable.
  and not has_function_privilege('authenticated', 'public.accept_invitation(text, text, text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.accept_invitation(text, text, text, text)', 'EXECUTE')
  -- Bank details are payment-diversion surface in BOTH directions now: 0061 revoked the
  -- UPDATE column grant, and 0088 (#106, decided 09.08.2026) revoked INSERT too — a fresh
  -- supplier row with substituted details is the same fraud with one extra step. The only
  -- path, creation included, is update_supplier_bank_details (owner/office + step-up +
  -- reason + audit).
  and not has_column_privilege('authenticated', 'public.suppliers', 'bank_details', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.suppliers', 'bank_details', 'INSERT')
  and not has_column_privilege('authenticated', 'public.products', 'org_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.products', 'active', 'UPDATE')
  and not has_any_column_privilege('authenticated', 'public.purchase_requests', 'INSERT')
  and not has_any_column_privilege('authenticated', 'public.purchase_requests', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.purchase_requests', 'DELETE')
  and not has_any_column_privilege('authenticated', 'public.purchase_request_items', 'INSERT')
  and not has_any_column_privilege('authenticated', 'public.purchase_request_items', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.purchase_request_items', 'DELETE')
  and not has_column_privilege('authenticated', 'public.purchase_orders', 'status', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.purchase_orders', 'sent_at', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.purchase_orders', 'confirmed_at', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.purchase_orders', 'confirmation_note', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.purchase_orders', 'expected_date', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.purchase_orders', 'org_id', 'UPDATE')
  and not has_any_column_privilege('authenticated', 'public.documents', 'INSERT')
  and not has_column_privilege('authenticated', 'public.documents', 'storage_path', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.suppliers', 'DELETE')
  and not has_table_privilege('authenticated', 'public.products', 'DELETE')
  and not has_table_privilege('authenticated', 'public.purchase_orders', 'DELETE'),
  'sensitive or destructive browser privilege is exposed'
);

select pg_temp.p0_acl_assert(
  to_regprocedure('public.finalize_purchase_request_draft(uuid,numeric)') is null
  or not has_function_privilege(
    'authenticated',
    to_regprocedure('public.finalize_purchase_request_draft(uuid,numeric)'),
    'EXECUTE'
  ),
  'legacy two-argument finalize overload is executable without an audit reason'
);

-- Exercise the exact provisioning regression: service_role keeps the table privileges needed to
-- create, read and modify an organization even though browser roles do not. A tenant hard-delete
-- is no longer a valid CRUD probe: since 0092 the trial/lifecycle latch deliberately blocks its
-- cascading child deletes (the org row vanishes before the cascade runs, and every child guard
-- then reads the missing tenant as suspended) until an explicit offboarding contract exists.
set local role service_role;
insert into public.organizations (id, name, status)
values ('13000000-0000-0000-0000-000000000009', 'P0 ACL service probe', 'active');
update public.organizations
set name = 'P0 ACL service probe updated'
where id = '13000000-0000-0000-0000-000000000009';
select id, name, status
from public.organizations
where id = '13000000-0000-0000-0000-000000000009';
do $$
begin
  delete from public.organizations
  where id = '13000000-0000-0000-0000-000000000009';
  raise exception 'expected organization hard-delete to remain blocked';
exception when sqlstate '42501' then
  if sqlerrm <> 'organization_read_only' then raise; end if;
end
$$;
reset role;

select pg_temp.p0_acl_assert(
  exists (
    select 1 from public.organizations
    where id = '13000000-0000-0000-0000-000000000009'
      and name = 'P0 ACL service probe updated'
  ),
  'service_role organization provisioning probe was lost or hard-delete bypassed the lifecycle latch'
);

-- ===== Trusted fixtures =====

insert into public.organizations (id, name, status) values
  ('13000000-0000-0000-0000-000000000001', 'P0 ACL tenant A', 'active'),
  ('13000000-0000-0000-0000-000000000002', 'P0 ACL tenant B', 'active');

insert into auth.users (id, email) values
  ('23000000-0000-0000-0000-000000000001', 'owner-a-p0-acl@example.test'),
  ('23000000-0000-0000-0000-000000000002', 'office-a-p0-acl@example.test'),
  ('23000000-0000-0000-0000-000000000003', 'office-a-p0-acl-2@example.test'),
  ('23000000-0000-0000-0000-000000000004', 'accountant-a-p0-acl@example.test'),
  ('23000000-0000-0000-0000-000000000005', 'accountant-a-p0-acl-2@example.test'),
  ('23000000-0000-0000-0000-000000000006', 'owner-b-p0-acl@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('23000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'P0 ACL owner A', 'owner'),
  ('23000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000001', 'P0 ACL office A', 'office'),
  ('23000000-0000-0000-0000-000000000003', '13000000-0000-0000-0000-000000000001', 'P0 ACL office A', 'office'),
  ('23000000-0000-0000-0000-000000000004', '13000000-0000-0000-0000-000000000001', 'P0 ACL accountant A', 'accountant'),
  ('23000000-0000-0000-0000-000000000005', '13000000-0000-0000-0000-000000000001', 'P0 ACL accountant A', 'accountant'),
  ('23000000-0000-0000-0000-000000000006', '13000000-0000-0000-0000-000000000002', 'P0 ACL owner B', 'owner');

insert into public.suppliers (id, org_id, name) values
  ('33000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'P0 ACL deletable supplier'),
  ('33000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000001', 'P0 ACL active supplier'),
  ('33000000-0000-0000-0000-000000000003', '13000000-0000-0000-0000-000000000002', 'P0 ACL tenant B supplier'),
  -- 0146 deletion-predicate fixtures. Each carries exactly one reason to be judged, so a failure
  -- names which half of the guard moved.
  ('33000000-0000-0000-0000-000000000004', '13000000-0000-0000-0000-000000000001', 'P0 ACL evidence-only supplier'),
  ('33000000-0000-0000-0000-000000000005', '13000000-0000-0000-0000-000000000001', 'P0 ACL draft-order supplier'),
  ('33000000-0000-0000-0000-000000000006', '13000000-0000-0000-0000-000000000001', 'P0 ACL live-order supplier');

insert into public.products (id, org_id, name, unit) values
  ('43000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'P0 ACL product A', 'unit'),
  ('43000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000002', 'P0 ACL product B', 'unit');

insert into public.purchase_orders (id, org_id, supplier_id, status, created_by) values
  ('53000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000002', 'ready', '23000000-0000-0000-0000-000000000002'),
  ('53000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000003', 'ready', '23000000-0000-0000-0000-000000000006'),
  -- 0146: a draft is an intention and must not block deletion; 'ready' onward must.
  ('53000000-0000-0000-0000-000000000003', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000005', 'draft', '23000000-0000-0000-0000-000000000002'),
  ('53000000-0000-0000-0000-000000000004', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000006', 'ready', '23000000-0000-0000-0000-000000000002');

insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status
) values (
  '63000000-0000-0000-0000-000000000001',
  '13000000-0000-0000-0000-000000000001',
  '33000000-0000-0000-0000-000000000002',
  'P0-ACL-EXISTING', '2026-07-23', 100, 18, 118, 'received'
);

-- 0146: an interim invoice consolidated under an anchor keeps its total_amount and gains no
-- allocation and no credit — it is evidence, not debt. Every money reader filters it out
-- (0137:2449); soft_delete_supplier did not, which is the bug the owner reported.
insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status, financial_role
) values (
  '63000000-0000-0000-0000-000000000002',
  '13000000-0000-0000-0000-000000000001',
  '33000000-0000-0000-0000-000000000004',
  'P0-ACL-EVIDENCE', '2026-07-23', 500, 90, 590, 'received', 'supporting_evidence'
);

insert into public.payments (
  id, org_id, supplier_id, amount, paid_date, method, reference, executed_by
) values (
  '73000000-0000-0000-0000-000000000001',
  '13000000-0000-0000-0000-000000000001',
  '33000000-0000-0000-0000-000000000002',
  118, '2026-07-23', 'bank_transfer', 'P0-ACL-PAYMENT',
  '23000000-0000-0000-0000-000000000004'
);

insert into storage.objects (bucket_id, name, owner, metadata) values
  (
    'documents',
    '13000000-0000-0000-0000-000000000001/invoice/63000000-0000-0000-0000-000000000001/accountant-invoice.pdf',
    '23000000-0000-0000-0000-000000000004',
    '{"mimetype":"application/pdf"}'::jsonb
  ),
  (
    'documents',
    '13000000-0000-0000-0000-000000000001/payment/73000000-0000-0000-0000-000000000001/accountant-proof.pdf',
    '23000000-0000-0000-0000-000000000004',
    '{"mimetype":"application/pdf"}'::jsonb
  );

-- ===== Owner and tenant boundaries =====

select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000001', true);
set local role authenticated;

with changed as (
  update public.organizations set name = 'P0 ACL tenant A renamed'
  where id = '13000000-0000-0000-0000-000000000001'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 1 from changed),
  'owner could not update an allowed organization column'
);

with changed as (
  update public.suppliers set name = 'cross-tenant write'
  where id = '33000000-0000-0000-0000-000000000003'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 0 from changed),
  'owner crossed the supplier tenant boundary'
);

-- Draft save/update/cancel work only through SECURITY DEFINER commands. The same browser role
-- has no direct INSERT, UPDATE or DELETE privilege on either draft table.
do $$
begin
  insert into public.purchase_requests (org_id, status, created_by)
  values (
    '13000000-0000-0000-0000-000000000001',
    'draft',
    '23000000-0000-0000-0000-000000000001'
  );
  raise exception 'expected direct purchase-request insert denial';
exception when insufficient_privilege then
  null;
end
$$;

select (
  public.save_purchase_request_draft(
    null,
    'initial ACL draft',
    '2026-07-30',
    1::smallint,
    '[{"product_id":"43000000-0000-0000-0000-000000000001","qty":2,"chosen_supplier_id":null}]'::jsonb
  )->>'request_id'
) as p0_acl_draft_id
\gset

select set_config('app.p0_acl_test_draft_id', :'p0_acl_draft_id', true);

select pg_temp.p0_acl_assert(
  (public.save_purchase_request_draft(
    :'p0_acl_draft_id'::uuid,
    'updated ACL draft',
    '2026-07-31',
    2::smallint,
    '[{"product_id":"43000000-0000-0000-0000-000000000001","qty":3,"chosen_supplier_id":null}]'::jsonb
  )->>'request_id')::uuid = :'p0_acl_draft_id'::uuid,
  'draft RPC could not update its own existing request without direct table DML'
);

do $$
begin
  update public.purchase_requests
  set notes = 'direct update must fail'
  where id = current_setting('app.p0_acl_test_draft_id')::uuid;
  raise exception 'expected direct purchase-request update denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  delete from public.purchase_requests
  where id = current_setting('app.p0_acl_test_draft_id')::uuid;
  raise exception 'expected direct purchase-request delete denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  insert into public.purchase_request_items (request_id, product_id, qty)
  values (
    current_setting('app.p0_acl_test_draft_id')::uuid,
    '43000000-0000-0000-0000-000000000001',
    1
  );
  raise exception 'expected direct purchase-request-item insert denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  update public.purchase_request_items
  set qty = 4
  where request_id = current_setting('app.p0_acl_test_draft_id')::uuid;
  raise exception 'expected direct purchase-request-item update denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  delete from public.purchase_request_items
  where request_id = current_setting('app.p0_acl_test_draft_id')::uuid;
  raise exception 'expected direct purchase-request-item delete denial';
exception when insufficient_privilege then
  null;
end
$$;

select public.cancel_purchase_request_draft(
  :'p0_acl_draft_id'::uuid,
  'draft no longer needed'
);

reset role;
select pg_temp.p0_acl_assert(
  exists (
    select 1 from public.purchase_requests
    where id = :'p0_acl_draft_id'::uuid
      and status = 'cancelled'
      and notes = 'updated ACL draft'
      and editor_step = 2
  )
  and exists (
    select 1 from public.audit_logs
    where entity_type = 'purchase_requests'
      and entity_id = :'p0_acl_draft_id'::uuid
      and action = 'purchase_request_cancelled'
      and reason = 'draft no longer needed'
  ),
  'draft command path did not persist the update/cancellation audit'
);

select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000001', true);
set local role authenticated;

do $$
begin
  update public.suppliers
  set org_id = '13000000-0000-0000-0000-000000000002'
  where id = '33000000-0000-0000-0000-000000000001';
  raise exception 'expected supplier org_id column denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  perform public.set_product_active(
    '43000000-0000-0000-0000-000000000002', false, 'cross-tenant test'
  );
  raise exception 'expected cross-tenant product rejection';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%product_not_found%' then raise; end if;
end
$$;

reset role;

-- Office cannot change the organization, but can edit and reason-soft-delete its suppliers.
select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000002', true);
set local role authenticated;

with changed as (
  update public.organizations set name = 'office must not rename org'
  where id = '13000000-0000-0000-0000-000000000001'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 0 from changed),
  'office changed an owner-only organization field'
);

with changed as (
  update public.suppliers set contact_name = 'Allowed office edit'
  where id = '33000000-0000-0000-0000-000000000001'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 1 from changed),
  'office could not update an allowed supplier field'
);

do $$
begin
  update public.suppliers
  set deleted_at = clock_timestamp()
  where id = '33000000-0000-0000-0000-000000000001';
  raise exception 'expected direct supplier soft-delete denial';
exception when insufficient_privilege then
  null;
end
$$;

select pg_temp.p0_acl_assert(
  (public.soft_delete_supplier(
    '33000000-0000-0000-0000-000000000001', 'supplier no longer used'
  )->>'idempotent')::boolean = false,
  'office supplier soft-delete RPC did not commit'
);

reset role;
select pg_temp.p0_acl_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = '13000000-0000-0000-0000-000000000001'
      and entity_type = 'suppliers'
      and entity_id = '33000000-0000-0000-0000-000000000001'
      and action = 'supplier_deleted'
      and reason = 'supplier no longer used'
  ),
  'supplier soft-delete has no server-authored reasoned audit'
);

select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000002', true);
set local role authenticated;

do $$
begin
  perform public.soft_delete_supplier(
    '33000000-0000-0000-0000-000000000002', 'must fail with an open balance'
  );
  raise exception 'expected supplier open-balance rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%supplier_has_open_balance%' then raise; end if;
end
$$;

-- 0146 -- the three deletion outcomes, one supplier each.
--
-- (a) Only supporting-evidence invoices: not money owed. This is the owner-reported failure --
-- /suppliers reads p0_supplier_balance_rows (payable-only) and shows ₪0, while this command used
-- to sum every financial_role and refuse. The screen and the guard now answer one question.
select pg_temp.p0_acl_assert(
  (public.soft_delete_supplier(
    '33000000-0000-0000-0000-000000000004', 'consolidated evidence is not an open balance'
  )->>'idempotent')::boolean = false,
  'supporting-evidence invoices still block supplier deletion'
);

-- (b) A purchase order that was never sent commits the business to nothing (owner decision,
-- 19.08.2026). src/pages/Suppliers.tsx carries the same status list.
select pg_temp.p0_acl_assert(
  (public.soft_delete_supplier(
    '33000000-0000-0000-0000-000000000005', 'an unsent draft is not an active order'
  )->>'idempotent')::boolean = false,
  'a draft purchase order still blocks supplier deletion'
);

-- (c) 'ready' onward is a live commitment and must still refuse -- and must say so in its own
-- name, not through the open-balance sentence the two guards used to share.
do $$
begin
  perform public.soft_delete_supplier(
    '33000000-0000-0000-0000-000000000006', 'must fail with a live order'
  );
  raise exception 'expected supplier active-order rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%supplier_has_active_orders%' then raise; end if;
end
$$;

-- Every order lifecycle transition is RPC-only and carries its audit reason atomically.
do $$
begin
  update public.purchase_orders
  set status = 'sent', sent_at = '2026-07-23 10:00:00+00'
  where id = '53000000-0000-0000-0000-000000000001';
  raise exception 'expected direct purchase-order status denial';
exception when insufficient_privilege then
  null;
end
$$;

select pg_temp.p0_acl_assert(
  (public.transition_purchase_order_status(
    '53000000-0000-0000-0000-000000000001',
    'sent',
    'supplier message sent',
    null,
    null
  )->>'idempotent')::boolean = false,
  'office purchase-order status RPC did not commit'
);

do $$
begin
  update public.purchase_orders
  set status = 'cancelled'
  where id = '53000000-0000-0000-0000-000000000001';
  raise exception 'expected direct purchase-order cancellation denial';
exception when insufficient_privilege then
  null;
end
$$;

select pg_temp.p0_acl_assert(
  (public.cancel_purchase_order(
    '53000000-0000-0000-0000-000000000001', 'supplier confirmed cancellation'
  )->>'idempotent')::boolean = false,
  'office purchase-order cancellation RPC did not commit'
);

reset role;
select pg_temp.p0_acl_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = '13000000-0000-0000-0000-000000000001'
      and entity_type = 'purchase_orders'
      and entity_id = '53000000-0000-0000-0000-000000000001'
      and action = 'purchase_order_status_changed'
      and reason = 'supplier message sent'
      and old_values ->> 'status' = 'ready'
      and new_values ->> 'status' = 'sent'
  ),
  'purchase-order status change has no server-authored reasoned audit'
);

select pg_temp.p0_acl_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = '13000000-0000-0000-0000-000000000001'
      and entity_type = 'purchase_orders'
      and entity_id = '53000000-0000-0000-0000-000000000001'
      and action = 'order_status:cancelled'
      and reason = 'supplier confirmed cancellation'
  ),
  'purchase-order cancellation has no server-authored reasoned audit'
);

reset role;

-- Office may edit products, but active state changes always require the reasoned RPC.
select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000003', true);
set local role authenticated;

with changed as (
  update public.products set notes = 'Allowed office edit'
  where id = '43000000-0000-0000-0000-000000000001'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 1 from changed),
  'office could not update an allowed product field'
);

do $$
begin
  update public.products
  set active = false
  where id = '43000000-0000-0000-0000-000000000001';
  raise exception 'expected direct product active-state denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  perform public.set_product_active(
    '43000000-0000-0000-0000-000000000001', false, null
  );
  raise exception 'expected product reason requirement';
exception when sqlstate '22023' then
  if sqlerrm not like '%reason_required%' then raise; end if;
end
$$;

select pg_temp.p0_acl_assert(
  (public.set_product_active(
    '43000000-0000-0000-0000-000000000001', false, 'temporarily unavailable'
  )->>'idempotent')::boolean = false,
  'office product active-state RPC did not commit'
);

reset role;
select pg_temp.p0_acl_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = '13000000-0000-0000-0000-000000000001'
      and entity_type = 'products'
      and entity_id = '43000000-0000-0000-0000-000000000001'
      and action = 'product_deactivated'
      and reason = 'temporarily unavailable'
  ),
  'product active-state change has no server-authored reasoned audit'
);

reset role;

-- Accountant has the shared authenticated ACL but RLS/RPC role checks deny purchasing writes.
select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000004', true);
set local role authenticated;

with changed as (
  update public.suppliers set name = 'accountant must not edit supplier'
  where id = '33000000-0000-0000-0000-000000000002'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 0 from changed),
  'accountant edited a supplier through shared column ACL'
);

with changed as (
  update public.products set notes = 'accountant must not edit product'
  where id = '43000000-0000-0000-0000-000000000001'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 0 from changed),
  'accountant edited a product through shared column ACL'
);

do $$
begin
  perform public.soft_delete_supplier(
    '33000000-0000-0000-0000-000000000002', 'accountant denial'
  );
  raise exception 'expected accountant supplier command denial';
exception when insufficient_privilege then
  if sqlerrm not like '%supplier_soft_delete_not_authorized%' then raise; end if;
end
$$;

do $$
begin
  perform public.set_product_active(
    '43000000-0000-0000-0000-000000000001', true, 'accountant denial'
  );
  raise exception 'expected accountant product command denial';
exception when insufficient_privilege then
  if sqlerrm not like '%product_active_not_authorized%' then raise; end if;
end
$$;

do $$
begin
  perform public.cancel_purchase_order(
    '53000000-0000-0000-0000-000000000001', 'accountant denial'
  );
  raise exception 'expected accountant order command denial';
exception when insufficient_privilege then
  if sqlerrm not like '%purchase_order_cancel_not_authorized%' then raise; end if;
end
$$;

-- 0131 makes the stable-key RPC the mandatory registration boundary: even a payload that the
-- documents RLS policy would accept cannot be inserted directly by an authenticated browser.
do $$
begin
  insert into public.documents (
    org_id, entity_type, entity_id, storage_path, file_name, mime_type, uploaded_by,
    document_kind, supplier_id, document_date
  ) values (
    '13000000-0000-0000-0000-000000000001',
    'payment',
    '73000000-0000-0000-0000-000000000001',
    '13000000-0000-0000-0000-000000000001/payment/73000000-0000-0000-0000-000000000001/accountant-proof.pdf',
    'accountant-proof.pdf',
    'application/pdf',
    '23000000-0000-0000-0000-000000000004',
    'payment_confirmation',
    '33000000-0000-0000-0000-000000000002',
    '2026-07-23'
  );
  raise exception 'expected direct document registration denial';
exception when insufficient_privilege then
  null;
end
$$;

-- Accountant may register proof only for a payment they executed. An existing invoice stays
-- readable but cannot receive an accountant-authored attachment.
do $$
begin
  perform public.register_uploaded_document(
    'p0-accountant-invoice-key', 'invoice',
    '63000000-0000-0000-0000-000000000001',
    '13000000-0000-0000-0000-000000000001/invoice/63000000-0000-0000-0000-000000000001/accountant-invoice.pdf',
    'accountant-invoice.pdf', 'application/pdf', 'invoice',
    '33000000-0000-0000-0000-000000000002', '2026-07-23'
  );
  raise exception 'expected accountant invoice attachment denial';
exception when insufficient_privilege then
  null;
end
$$;

select public.register_uploaded_document(
  'p0-accountant-proof-key', 'payment',
  '73000000-0000-0000-0000-000000000001',
  '13000000-0000-0000-0000-000000000001/payment/73000000-0000-0000-0000-000000000001/accountant-proof.pdf',
  'accountant-proof.pdf', 'application/pdf', 'payment_confirmation',
  '33000000-0000-0000-0000-000000000002', '2026-07-23'
);

select pg_temp.p0_acl_assert(
  exists (
    select 1 from public.documents
    where entity_type = 'payment'
      and entity_id = '73000000-0000-0000-0000-000000000001'
      and uploaded_by = '23000000-0000-0000-0000-000000000004'
      and document_kind = 'payment_confirmation'
  )
  and not exists (
    select 1 from public.documents
    where entity_type = 'invoice'
      and entity_id = '63000000-0000-0000-0000-000000000001'
      and uploaded_by = '23000000-0000-0000-0000-000000000004'
  ),
  'accountant document policy did not separate payment proof from invoice upload'
);

reset role;
rollback;
