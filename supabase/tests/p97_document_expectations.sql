-- P97 — what a person declared should arrive, and the four things the model must not lose.
--
-- `0272` gives the product its first way to say "one of these is due each month". The table shapes
-- are easy; what this suite pins is the handful of decisions that a reasonable-looking schema gets
-- wrong:
--
--   ONE ACTIVE SERIES, INCLUDING THE COMMON CASE. `unit_id` is nullable, and in an ordinary UNIQUE
--   every NULL differs from every other NULL — so a single constraint would have enforced nothing
--   at all for organisation-wide expectations, which is most of them. Two partial indexes. This
--   suite inserts the duplicate that a naive schema would have accepted.
--
--   TWO STATE FIELDS. `missed → received` on one field destroys the fact that the document was
--   late, and the measure of this item is computed on exactly that intersection.
--
--   A PROPOSAL IS NOT AN EXPECTATION. A row nobody approved must be unable to enforce anything.
--
--   AND EVERY CROSS-TABLE REFERENCE IS SCOPED. A simple foreign key lets a row in one tenant point
--   at a document or an exception in another, and RLS does not catch it — so the suite tries it.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p97_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P97 expectation assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p97_refuses(p_sql text)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end
$$;

insert into public.organizations(id, name, status, vat_rate, base_currency, country_code) values
  ('a0970000-0000-4000-8000-000000000001', 'P97 org', 'active', 18, 'ILS', 'IL'),
  ('a0970000-0000-4000-8000-000000000002', 'P97 other tenant', 'active', 18, 'ILS', 'IL');
insert into auth.users (id, email) values
  ('b0970000-0000-4000-8000-000000000001', 'p97-owner@example.test');
insert into public.profiles(id, org_id, full_name, role, active) values
  ('b0970000-0000-4000-8000-000000000001', 'a0970000-0000-4000-8000-000000000001',
   'P97 owner', 'owner', true);
insert into public.suppliers(id, org_id, name, status, default_currency, country_code) values
  ('c0970000-0000-4000-8000-000000000001', 'a0970000-0000-4000-8000-000000000001',
   'P97 electricity', 'active', 'ILS', 'IL'),
  ('c0970000-0000-4000-8000-000000000002', 'a0970000-0000-4000-8000-000000000002',
   'P97 other tenant supplier', 'active', 'ILS', 'IL');

-- ---- 1. THE ASSERTION THIS SCHEMA EXISTS FOR: one active series, org-wide included. -----------
insert into public.supplier_document_expectations
  (id, org_id, supplier_id, document_type, cadence, expected_day_from, expected_day_to,
   state, created_by)
values ('d0970000-0000-4000-8000-000000000001', 'a0970000-0000-4000-8000-000000000001',
        'c0970000-0000-4000-8000-000000000001', 'invoice', 'monthly', 3, 7, 'active',
        'b0970000-0000-4000-8000-000000000001');

-- A second ACTIVE one for the same supplier and type, also organisation-wide. An ordinary UNIQUE
-- would have accepted this, because NULL <> NULL, and "one active series" would have been a
-- comment rather than a rule.
select pg_temp.p97_assert(
  pg_temp.p97_refuses($$
    insert into public.supplier_document_expectations
      (org_id, supplier_id, document_type, cadence, expected_day_from, expected_day_to,
       state, created_by)
    values ('a0970000-0000-4000-8000-000000000001', 'c0970000-0000-4000-8000-000000000001',
            'invoice', 'monthly', 10, 12, 'active', 'b0970000-0000-4000-8000-000000000001')$$),
  'a second active organisation-wide series was accepted for the same supplier and type');

-- But a PROPOSAL alongside it is fine: proposing is not competing, and the index says so.
insert into public.supplier_document_expectations
  (id, org_id, supplier_id, document_type, cadence, expected_day_from, expected_day_to,
   state, created_by)
values ('d0970000-0000-4000-8000-000000000002', 'a0970000-0000-4000-8000-000000000001',
        'c0970000-0000-4000-8000-000000000001', 'invoice', 'monthly', 10, 12, 'proposed',
        'b0970000-0000-4000-8000-000000000001');
select pg_temp.p97_assert(
  (select count(*) from public.supplier_document_expectations
   where supplier_id = 'c0970000-0000-4000-8000-000000000001') = 2,
  'a proposal could not sit beside the active series it might replace');

-- And a different document type is a different series.
insert into public.supplier_document_expectations
  (org_id, supplier_id, document_type, cadence, expected_weekday, state, created_by)
values ('a0970000-0000-4000-8000-000000000001', 'c0970000-0000-4000-8000-000000000001',
        'delivery_note', 'weekly', 1, 'active', 'b0970000-0000-4000-8000-000000000001');

-- ---- 2. A born expectation proposes; it does not enforce. -------------------------------------
insert into public.supplier_document_expectations
  (id, org_id, supplier_id, document_type, cadence, expected_day_from, expected_day_to, created_by)
values ('d0970000-0000-4000-8000-000000000003', 'a0970000-0000-4000-8000-000000000001',
        'c0970000-0000-4000-8000-000000000001', 'credit_note', 'monthly', 1, 5,
        'b0970000-0000-4000-8000-000000000001');
select pg_temp.p97_assert(
  (select state from public.supplier_document_expectations
   where id = 'd0970000-0000-4000-8000-000000000003') = 'proposed',
  'an expectation is born active instead of proposed');
select pg_temp.p97_assert(
  (select source from public.supplier_document_expectations
   where id = 'd0970000-0000-4000-8000-000000000003') = 'stated',
  'an expectation is born claiming it was learned');

-- ---- 3. The cadence decides which columns must be there. --------------------------------------
-- A monthly expectation with no day range is not a weaker expectation; it is an unanswerable one.
select pg_temp.p97_assert(
  pg_temp.p97_refuses($$
    insert into public.supplier_document_expectations
      (org_id, supplier_id, document_type, cadence, created_by)
    values ('a0970000-0000-4000-8000-000000000001', 'c0970000-0000-4000-8000-000000000001',
            'statement', 'monthly', 'b0970000-0000-4000-8000-000000000001')$$),
  'a monthly expectation with no day range was accepted');
select pg_temp.p97_assert(
  pg_temp.p97_refuses($$
    insert into public.supplier_document_expectations
      (org_id, supplier_id, document_type, cadence, expected_day_from, expected_day_to, created_by)
    values ('a0970000-0000-4000-8000-000000000001', 'c0970000-0000-4000-8000-000000000001',
            'statement', 'monthly', 20, 4, 'b0970000-0000-4000-8000-000000000001')$$),
  'a day range that ends before it starts was accepted');
select pg_temp.p97_assert(
  pg_temp.p97_refuses($$
    insert into public.supplier_document_expectations
      (org_id, supplier_id, document_type, cadence, created_by)
    values ('a0970000-0000-4000-8000-000000000001', 'c0970000-0000-4000-8000-000000000001',
            'statement', 'weekly', 'b0970000-0000-4000-8000-000000000001')$$),
  'a weekly expectation with no weekday was accepted');

-- ---- 4. TWO STATE FIELDS, because one cannot hold both facts. ---------------------------------
insert into public.expectation_occurrences
  (org_id, expectation_id, period_start, period_end, due_status, missed_at)
values ('a0970000-0000-4000-8000-000000000001', 'd0970000-0000-4000-8000-000000000001',
        '2026-08-01', '2026-08-31', 'missed', '2026-09-08T00:00:00+00');

-- The document turns up late. On a single field this update would ERASE the fact that it was
-- missed, and the measure of this whole item is computed on exactly that intersection.
update public.expectation_occurrences
   set due_status = 'received', resolution = 'resolved_by_document',
       received_at = '2026-09-10T00:00:00+00', received_late = true
 where expectation_id = 'd0970000-0000-4000-8000-000000000001';

select pg_temp.p97_assert(
  (select due_status = 'received' and resolution = 'resolved_by_document'
          and missed_at is not null and received_at is not null and received_late
   from public.expectation_occurrences
   where expectation_id = 'd0970000-0000-4000-8000-000000000001'),
  'a late arrival erased the fact that the document had been missed');

-- One occurrence per period. A second scanner run must not open a second one.
select pg_temp.p97_assert(
  pg_temp.p97_refuses($$
    insert into public.expectation_occurrences (org_id, expectation_id, period_start, period_end)
    values ('a0970000-0000-4000-8000-000000000001', 'd0970000-0000-4000-8000-000000000001',
            '2026-08-01', '2026-08-31')$$),
  'a second occurrence was opened for a period that already had one');
select pg_temp.p97_assert(
  pg_temp.p97_refuses($$
    insert into public.expectation_occurrences (org_id, expectation_id, period_start, period_end)
    values ('a0970000-0000-4000-8000-000000000001', 'd0970000-0000-4000-8000-000000000001',
            '2026-09-30', '2026-09-01')$$),
  'a period that ends before it starts was accepted');

-- ---- 5. Every reference is scoped to the tenant. ----------------------------------------------
-- An occurrence in one organisation pointing at an expectation in another. A simple foreign key
-- would have accepted this, and RLS would not have caught it.
insert into public.supplier_document_expectations
  (id, org_id, supplier_id, document_type, cadence, expected_day_from, expected_day_to,
   state, created_by)
values ('d0970000-0000-4000-8000-000000000009', 'a0970000-0000-4000-8000-000000000002',
        'c0970000-0000-4000-8000-000000000002', 'invoice', 'monthly', 1, 5, 'active',
        'b0970000-0000-4000-8000-000000000001');
select pg_temp.p97_assert(
  pg_temp.p97_refuses($$
    insert into public.expectation_occurrences (org_id, expectation_id, period_start, period_end)
    values ('a0970000-0000-4000-8000-000000000001', 'd0970000-0000-4000-8000-000000000009',
            '2026-10-01', '2026-10-31')$$),
  'an occurrence reached across tenants to an expectation that is not its own');

-- And the key this migration had to add before that was even expressible.
select pg_temp.p97_assert(
  exists (select 1 from pg_constraint
          where conname = 'p0_exceptions_org_id_id_key'
            and conrelid = 'public.exceptions'::regclass),
  'exceptions never got the composite key the scoped reference needs');

-- ---- 6. Read by the two roles that own the work, and by nobody else. --------------------------
select pg_temp.p97_assert(
  not has_table_privilege('authenticated', 'public.supplier_document_expectations', 'insert')
  and not has_table_privilege('authenticated', 'public.expectation_occurrences', 'update')
  and has_table_privilege('authenticated', 'public.supplier_document_expectations', 'select'),
  'the expectation tables are not read-only to the tenant');
select pg_temp.p97_assert(
  (select count(*) from pg_policies
   where tablename in ('supplier_document_expectations', 'expectation_occurrences')) = 2,
  'the two tables do not each carry exactly one read policy');

-- ---- 7. The command is the only door, and it cannot ask for authority it does not have. -------
select set_config('request.jwt.claim.sub', 'b0970000-0000-4000-8000-000000000001', true);
select pg_temp.p97_assert(
  (public.declare_document_expectation(
     'c0970000-0000-4000-8000-000000000001', 'statement', 'monthly', 8, 12) ->> 'state')
   = 'proposed',
  'the command did not create a proposal');

-- BORN PROPOSED AND STATED, ALWAYS. A caller that could ask for `active` would be approving its
-- own expectation, and one that could claim `learned` would put unearned confidence on the card.
select pg_temp.p97_assert(
  (select count(*) from public.supplier_document_expectations
   where document_type = 'statement' and state = 'proposed' and source = 'stated') = 1,
  'the command created something other than a stated proposal');
select pg_temp.p97_assert(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'declare_document_expectation'
      and (pg_get_function_arguments(p.oid) like '%p_state%'
        or pg_get_function_arguments(p.oid) like '%p_source%')),
  'the command lets the caller choose its own state or source');

-- A supplier from another tenant is refused by name rather than by a constraint violation.
select pg_temp.p97_assert(
  pg_temp.p97_refuses($$select public.declare_document_expectation(
    'c0970000-0000-4000-8000-000000000002', 'invoice', 'monthly', 1, 5)$$),
  'an expectation was declared against another tenant''s supplier');

-- And the declaration is in the ledger, because a standing statement about a supplier is one.
select pg_temp.p97_assert(
  (select count(*) from audit_logs
   where org_id = 'a0970000-0000-4000-8000-000000000001'
     and action = 'document_expectation_declared') = 1,
  'declaring an expectation was not written to the ledger');

-- ---- 8. And the exception vocabulary can name the finding. ------------------------------------
select pg_temp.p97_assert(
  exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = 'exception_type' and e.enumlabel = 'expected_document_missing'),
  'the exception type for a document that never arrived does not exist');

rollback;

select 'P97_document_expectations_passed' as result;
