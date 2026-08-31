-- P91 — the date an invoice is due, and the four ways it must refuse to invent one.
--
-- `0264` adds `invoices.due_date` and the command that fills it. The column is the easy half. What
-- this suite pins is the half that decides whether a "scheduled payments" card tells the truth:
--
--   NOTHING IS GIVEN A DATE IT DOES NOT HAVE. No default, no backfill, and nothing derived from
--   `suppliers.payment_terms` — free text nobody parses, which the alerts screen already says out
--   loud. A guessed date is an invented debt with a day attached to it.
--
--   THE COMMAND IS THE ONLY DOOR. `p1_financial_command_guard` (0023) refuses a direct write, so a
--   screen cannot set this field by updating the row, and that is asserted by trying it.
--
--   IT IS SCOPED, AUDITED AND IDEMPOTENT. Owner and office only; the audit row carries the old and
--   the new value and can never be reasonless; re-sending the same date writes nothing at all.
--
--   AND CLEARING IT IS AN ANSWER. NULL means "not known" — a real state a person can choose, not a
--   deletion and not a zero.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p91_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P91 due date assertion failed: %', p_message;
  end if;
end
$$;

insert into public.organizations(id, name, status, vat_rate, base_currency, country_code)
values ('a0910000-0000-4000-8000-000000000001', 'P91 org', 'active', 18, 'ILS', 'IL');
insert into auth.users (id, email) values
  ('b0910000-0000-4000-8000-000000000001', 'p91-owner@example.test'),
  ('b0910000-0000-4000-8000-000000000002', 'p91-accountant@example.test');
insert into public.profiles(id, org_id, full_name, role, active) values
  ('b0910000-0000-4000-8000-000000000001', 'a0910000-0000-4000-8000-000000000001',
   'P91 owner', 'owner', true),
  ('b0910000-0000-4000-8000-000000000002', 'a0910000-0000-4000-8000-000000000001',
   'P91 accountant', 'accountant', true);
insert into public.suppliers(id, org_id, name, status, default_currency, country_code,
                             payment_terms)
values ('c0910000-0000-4000-8000-000000000001', 'a0910000-0000-4000-8000-000000000001',
        'P91 supplier', 'active', 'ILS', 'IL', 'שוטף + 60');
insert into public.invoices
  (id, org_id, supplier_id, invoice_number, invoice_date, amount_before_vat, vat_amount,
   total_amount, currency)
values ('d0910000-0000-4000-8000-000000000001', 'a0910000-0000-4000-8000-000000000001',
        'c0910000-0000-4000-8000-000000000001', 'P91-1', '2026-08-01', 100, 18, 118, 'ILS');

-- ---- 1. A supplier with stated payment terms still has an invoice with NO date. ---------------
-- The terms say "net 60". Nothing read them, and that is the point: the column is free text and
-- parsing it would produce a debt with a date the document never carried.
select pg_temp.p91_assert(
  (select due_date from public.invoices
   where id = 'd0910000-0000-4000-8000-000000000001') is null,
  'a new invoice was given a due date');
select pg_temp.p91_assert(
  (select payment_terms from public.suppliers
   where id = 'c0910000-0000-4000-8000-000000000001') is not null,
  'the fixture does not actually state payment terms, so the assertion above proves nothing');

-- ---- 2. The command is the only door. --------------------------------------------------------
select set_config('request.jwt.claim.sub', 'b0910000-0000-4000-8000-000000000001', true);
do $direct$
declare v_refused boolean := false;
begin
  begin
    update public.invoices set due_date = date '2026-09-30'
    where id = 'd0910000-0000-4000-8000-000000000001';
  exception when insufficient_privilege then
    v_refused := sqlerrm = 'financial_command_rpc_required';
  end;
  if not v_refused then
    raise exception 'P91 due date assertion failed: a direct update set the due date';
  end if;
end
$direct$;

-- ---- 3. The command works, and says what it did. ---------------------------------------------
select pg_temp.p91_assert(
  (public.set_invoice_due_date('d0910000-0000-4000-8000-000000000001', date '2026-09-30')
    ->> 'changed')::boolean,
  'the command did not report the change it made');
select pg_temp.p91_assert(
  (select due_date from public.invoices
   where id = 'd0910000-0000-4000-8000-000000000001') = date '2026-09-30',
  'the command did not store the date');

-- Idempotent: the same date again is not an event, and the log does not gain a row for it.
select pg_temp.p91_assert(
  not (public.set_invoice_due_date('d0910000-0000-4000-8000-000000000001', date '2026-09-30')
    ->> 'changed')::boolean,
  'sending the same date twice reported a second change');
select pg_temp.p91_assert(
  (select count(*) from public.audit_logs
   where entity_id = 'd0910000-0000-4000-8000-000000000001'
     and action = 'invoice_due_date_set') = 1,
  'the idempotent call still wrote an audit row');

-- ---- 4. The audit row carries both values and a reason. --------------------------------------
select pg_temp.p91_assert(
  (select old_values ->> 'due_date' is null and new_values ->> 'due_date' = '2026-09-30'
          and length(trim(coalesce(reason, ''))) > 0
   from public.audit_logs
   where entity_id = 'd0910000-0000-4000-8000-000000000001'
     and action = 'invoice_due_date_set'),
  'the audit row does not carry the old value, the new value and a reason');

-- ---- 5. Clearing it is an answer, not a deletion. --------------------------------------------
select pg_temp.p91_assert(
  (public.set_invoice_due_date('d0910000-0000-4000-8000-000000000001', null)
    ->> 'changed')::boolean,
  'clearing the date was not treated as a change');
select pg_temp.p91_assert(
  (select due_date from public.invoices
   where id = 'd0910000-0000-4000-8000-000000000001') is null,
  'the date was not cleared back to unknown');

-- ---- 6. A date far from its invoice is a typing accident, and is refused. ---------------------
do $implausible$
declare v_refused boolean := false;
begin
  begin
    perform public.set_invoice_due_date('d0910000-0000-4000-8000-000000000001', date '2036-01-01');
  exception when check_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'P91 due date assertion failed: a date ten years out was accepted';
  end if;
end
$implausible$;

-- ---- 7. Only the roles the server means. ------------------------------------------------------
select set_config('request.jwt.claim.sub', 'b0910000-0000-4000-8000-000000000002', true);
do $role$
declare v_refused boolean := false;
begin
  begin
    perform public.set_invoice_due_date('d0910000-0000-4000-8000-000000000001', date '2026-09-30');
  exception when insufficient_privilege then
    v_refused := sqlerrm = 'not_authorized';
  end;
  if not v_refused then
    raise exception 'P91 due date assertion failed: an accountant set an invoice due date';
  end if;
end
$role$;

-- Read as a privilege rather than by provoking a denial under `set role`, which takes the backend
-- down with it.
select pg_temp.p91_assert(
  has_function_privilege('authenticated', 'public.set_invoice_due_date(uuid, date, text)', 'execute')
  and not has_function_privilege('anon', 'public.set_invoice_due_date(uuid, date, text)', 'execute'),
  'the command is not exactly authenticated-only');

-- ---- 8. The definer function is pinned to a ledger a reviewer reads. --------------------------
select pg_temp.p91_assert(
  exists (select 1 from private.scope_definer_enforcements
          where function_signature = 'set_invoice_due_date(uuid,date,text)'),
  'the command is not registered as a scope-enforced definer function');
select pg_temp.p91_assert(
  not exists (select 1 from private.scope_enforcement_violations()),
  'the scope assertions do not hold with the command in place');

rollback;

select 'P91_invoice_due_date_passed' as result;
