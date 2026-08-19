-- P50 -- The internal customer record is unreachable from a tenant, its notes cannot be rewritten,
-- the platform timeline cannot be edited, and an operator writes to a suspended customer on
-- purpose rather than by accident (0152).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p50_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P50 customer operations assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p50_as(p_user uuid, p_fresh_password boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    case when p_user is null then '{}'::jsonb else jsonb_build_object(
      'sub', p_user,
      'amr', case when p_fresh_password then jsonb_build_array(jsonb_build_object(
        'method', 'password', 'timestamp', extract(epoch from clock_timestamp())
      )) else '[]'::jsonb end
    ) end::text,
    true
  );
end
$$;

-- ===== Structural claims =====
select pg_temp.p50_assert(
  not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename in ('customer_accounts', 'customer_contacts',
                        'customer_internal_notes', 'platform_lifecycle_events')
  ),
  'a policy appeared on a customer-operations table -- the definer commands are the only door');

select pg_temp.p50_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('customer_accounts', 'customer_contacts',
                         'customer_internal_notes', 'platform_lifecycle_events')
      and grantee in ('anon', 'authenticated')
  ),
  'a browser role holds a grant on a customer-operations table');

-- The export contract has decided about all four, and the decision is exclude. An internal note
-- leaving with a tenant export would be exactly the leak the brief names.
select pg_temp.p50_assert(
  (select count(*) from private.tenant_export_registry
    where table_name in ('customer_accounts', 'customer_contacts',
                         'customer_internal_notes', 'platform_lifecycle_events')
      and disposition = 'exclude') = 4,
  'a customer-operations table is missing from the export registry or is not excluded');

-- ===== Fixture =====
insert into public.organizations (id, name, status, created_at) values
  ('50000000-0000-4000-8000-000000000001', 'P50 tenant', 'active', now() - interval '90 days'),
  ('50000000-0000-4000-8000-000000000002', 'P50 other tenant', 'active', now() - interval '80 days');

insert into auth.users (id, email) values
  ('60000000-0000-4000-8000-000000000001', 'owner-p50@example.test'),
  ('60000000-0000-4000-8000-000000000002', 'super-p50@example.test'),
  ('60000000-0000-4000-8000-000000000003', 'support-p50@example.test'),
  ('60000000-0000-4000-8000-000000000004', 'analyst-p50@example.test'),
  ('60000000-0000-4000-8000-000000000005', 'account-owner-p50@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'P50 owner', 'owner');

insert into public.platform_admins (user_id, note) values
  ('60000000-0000-4000-8000-000000000002', 'P50 super operator'),
  ('60000000-0000-4000-8000-000000000003', 'P50 support operator'),
  ('60000000-0000-4000-8000-000000000004', 'P50 read-only analyst');

insert into public.platform_admin_roles (user_id, role_key) values
  ('60000000-0000-4000-8000-000000000002', 'super_admin'),
  ('60000000-0000-4000-8000-000000000003', 'support'),
  ('60000000-0000-4000-8000-000000000004', 'analyst');

-- ===== A tenant owner reaches none of it =====
select pg_temp.p50_as('60000000-0000-4000-8000-000000000001');
set local role authenticated;

select pg_temp.p50_assert(
  public.platform_customer_detail('50000000-0000-4000-8000-000000000001') is null,
  'a tenant owner read the internal customer detail');
select pg_temp.p50_assert(
  (select count(*) from public.platform_customer_contacts('50000000-0000-4000-8000-000000000001')) = 0
  and (select count(*) from public.platform_customer_notes('50000000-0000-4000-8000-000000000001')) = 0
  and (select count(*) from public.platform_customer_timeline('50000000-0000-4000-8000-000000000001')) = 0,
  'a tenant owner read internal contacts, notes or the platform timeline');

do $$
begin
  perform public.platform_add_internal_note(
    '50000000-0000-4000-8000-000000000001', 'note', 'a tenant should not be able to write this', null);
  raise exception 'expected a tenant note write to be refused';
exception when insufficient_privilege then null;
end
$$;

do $$
begin
  perform (select count(*) from public.customer_internal_notes);
  raise exception 'expected a direct tenant read of customer_internal_notes to be refused';
exception when insufficient_privilege then null;
end
$$;

reset role;

-- ===== Capability, not membership: a read-only analyst may look and may not write =====
select pg_temp.p50_as('60000000-0000-4000-8000-000000000004');
set local role authenticated;

select pg_temp.p50_assert(
  public.platform_customer_detail('50000000-0000-4000-8000-000000000001') is not null,
  'an analyst with customer.view could not read the customer detail');
do $$
begin
  perform public.platform_set_customer_account(
    '50000000-0000-4000-8000-000000000001', null, current_date, 'analyst tries to edit');
  raise exception 'expected an operator without customer.edit to be refused';
exception when insufficient_privilege then null;
end
$$;
-- The analyst holds no notes.view either, so the notes panel must come back empty rather than
-- leaking what support wrote.
select pg_temp.p50_assert(
  (select count(*) from public.platform_customer_notes('50000000-0000-4000-8000-000000000001')) = 0,
  'an operator without notes.view read internal notes');

reset role;

-- ===== The full operator writes the record =====
select pg_temp.p50_as('60000000-0000-4000-8000-000000000002');
set local role authenticated;

do $$
begin
  perform public.platform_set_customer_account(
    '50000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000005', current_date, '');
  raise exception 'expected a reasonless customer account write to be refused';
exception when invalid_parameter_value then null;
end
$$;

select pg_temp.p50_assert(
  (public.platform_set_customer_account(
    '50000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000005',
    current_date - 90,
    'P50: assigning the account owner') ->> 'created')::boolean,
  'the first customer account write did not report itself as a creation');

select pg_temp.p50_assert(
  not (public.platform_set_customer_account(
    '50000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000005',
    current_date - 90,
    'P50: same values again') ->> 'created')::boolean,
  'the second customer account write claimed to create a second row');

-- A contact nobody can reach is not a contact.
do $$
begin
  perform public.platform_upsert_customer_contact(
    '50000000-0000-4000-8000-000000000001', 'billing', 'ללא דרך ליצור קשר',
    null, null, null, null, 'P50: unreachable contact');
  raise exception 'expected a contact with no email and no phone to be refused';
exception when check_violation then null;
end
$$;

-- And a preferred channel we hold no address for is a promise we cannot keep.
do $$
begin
  perform public.platform_upsert_customer_contact(
    '50000000-0000-4000-8000-000000000001', 'billing', 'ערוץ ללא כתובת',
    null, 'billing@example.test', null, 'whatsapp', 'P50: channel without an address');
  raise exception 'expected a preferred channel without a matching address to be refused';
exception when check_violation then null;
end
$$;

select pg_temp.p50_assert(
  (public.platform_upsert_customer_contact(
    '50000000-0000-4000-8000-000000000001', 'billing', 'רות כהן', 'הנהלת חשבונות',
    'billing@example.test', null, 'email', 'P50: billing contact') ->> 'created')::boolean,
  'the first billing contact did not report itself as a creation');

-- Upsert, not duplicate: "which billing contact do we email" must have exactly one answer.
select pg_temp.p50_assert(
  not (public.platform_upsert_customer_contact(
    '50000000-0000-4000-8000-000000000001', 'billing', 'רות כהן-לוי', 'הנהלת חשבונות',
    'billing2@example.test', null, 'email', 'P50: renamed billing contact') ->> 'created')::boolean,
  'a second live billing contact was created instead of replacing the first');
select pg_temp.p50_assert(
  (select count(*) from public.platform_customer_contacts('50000000-0000-4000-8000-000000000001')
    where kind = 'billing') = 1,
  'more than one live billing contact exists');

reset role;

-- ===== Notes are append-only, and a follow-up closes exactly once =====
select pg_temp.p50_as('60000000-0000-4000-8000-000000000003');
set local role authenticated;

select pg_temp.p50_assert(
  public.platform_add_internal_note(
    '50000000-0000-4000-8000-000000000001', 'support',
    'הלקוח דיווח על איטיות בקליטת מחירונים.', null) ? 'note_id',
  'the support note was not recorded');

do $$
declare
  v_note_id uuid;
begin
  v_note_id := (public.platform_add_internal_note(
    '50000000-0000-4000-8000-000000000001', 'follow_up',
    'לחזור ללקוח אחרי שהמחירון ייקלט.', now() + interval '3 days') ->> 'note_id')::uuid;
  perform set_config('p50.follow_up_id', v_note_id::text, true);
end
$$;

-- A follow-up without a date, and a plain note with one, are both shape errors: one is a promise
-- with no deadline, the other a statement pretending to be a promise.
do $$
begin
  perform public.platform_add_internal_note(
    '50000000-0000-4000-8000-000000000001', 'follow_up', 'מעקב ללא תאריך', null);
  raise exception 'expected a follow-up without a due date to be refused';
exception when check_violation then null;
end
$$;
do $$
begin
  perform public.platform_add_internal_note(
    '50000000-0000-4000-8000-000000000001', 'note', 'הערה עם תאריך מעקב', now() + interval '1 day');
  raise exception 'expected a plain note carrying a follow-up date to be refused';
exception when check_violation then null;
end
$$;

select pg_temp.p50_assert(
  public.platform_resolve_follow_up(
    current_setting('p50.follow_up_id')::uuid, 'המחירון נקלט, הלקוח אישר.') ? 'note_id',
  'the follow-up did not resolve');

-- Once, and only once. Re-opening is a new note, not an edit of the record of the old one.
do $$
begin
  perform public.platform_resolve_follow_up(
    current_setting('p50.follow_up_id')::uuid, 'סוגר שוב');
  raise exception 'expected a second resolution of the same follow-up to be refused';
exception when insufficient_privilege then null;
end
$$;

reset role;

-- The body is immutable even to a superuser-owned path: the trigger, not a missing grant, is what
-- makes "append-only" true against a future command that decides to tidy a note.
do $$
begin
  update public.customer_internal_notes set body = 'rewritten' where kind = 'support';
  raise exception 'expected an internal note body rewrite to be refused';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  delete from public.customer_internal_notes where kind = 'support';
  raise exception 'expected an internal note delete to be refused';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  update public.platform_lifecycle_events set reason = 'rewritten';
  raise exception 'expected a platform timeline rewrite to be refused';
exception when insufficient_privilege then null;
end
$$;

-- ===== Every command left a timeline entry, with a reason and the acting operator =====
select pg_temp.p50_as('60000000-0000-4000-8000-000000000002');
set local role authenticated;

select pg_temp.p50_assert(
  (select count(*) from public.platform_customer_timeline('50000000-0000-4000-8000-000000000001')
    where action in ('customer_account_set', 'customer_contact_set',
                     'customer_internal_note_added', 'customer_follow_up_resolved')) >= 4,
  'the platform timeline is missing entries for commands that ran');
select pg_temp.p50_assert(
  not exists (
    select 1 from public.platform_customer_timeline('50000000-0000-4000-8000-000000000001')
    where reason is null or btrim(reason) = '' or actor_email is null),
  'a timeline entry carries no reason or no actor');

-- Tenant isolation of the record itself: the other organization sees none of this tenant's rows.
select pg_temp.p50_assert(
  (select count(*) from public.platform_customer_timeline('50000000-0000-4000-8000-000000000002')) = 0
  and (select count(*) from public.platform_customer_contacts('50000000-0000-4000-8000-000000000002')) = 0,
  'a command written against one organization appeared under another');

select pg_temp.p50_assert(
  public.platform_customer_detail('50000000-0000-4000-8000-000000000001') ->> 'internal_owner_email'
    = 'account-owner-p50@example.test',
  'the customer detail did not resolve the internal account owner');
select pg_temp.p50_assert(
  (public.platform_customer_detail('50000000-0000-4000-8000-000000000001')
    ->> 'open_follow_up_count')::int = 0,
  'the resolved follow-up is still counted as open');

do $$
begin
  perform public.platform_set_customer_account(
    '50000000-0000-4000-8000-000000000009', null, current_date, 'unknown organization');
  raise exception 'expected an unknown organization to be refused';
exception when no_data_found then null;
end
$$;

-- ===== A suspended customer still takes an operator note, on purpose =====
-- set_organization_lifecycle asserts a fresh password authentication (0061:51), so the claims are
-- re-issued with one; the note that follows deliberately does NOT need step-up.
select pg_temp.p50_as('60000000-0000-4000-8000-000000000002', true);
select public.set_organization_lifecycle(
  '50000000-0000-4000-8000-000000000002', 'suspended', null, 'P50: suspend before writing');
select pg_temp.p50_assert(
  public.platform_add_internal_note(
    '50000000-0000-4000-8000-000000000002', 'support',
    'הלקוח מושהה — תיעוד שיחה על החוב הפתוח.', null) ? 'note_id',
  'a suspended customer refused an operator note -- customer operations matters most exactly then');

reset role;
rollback;

\echo 'p50_customer_operations_record_passed'
