-- P113 — a currency this role cannot value returns no row, and the owner's ledger does not move.
--
-- `MON-03` / `FIN-04`. `0218` wrote the supplier ledger in two halves that disagree about the role:
-- the invoice reader filters the accountant's arm to `review_status = 'approved'`, and the supplier
-- reader LEFT JOINs those balances onto an unfiltered `public.invoices` and `coalesce(…, 0)`s the
-- result. So the accountant's supplier card printed `$ 0` for a currency it is not shown — over a
-- real `$300` the supplier is still owed. `FIN-04` recorded that as "a phantom row on a supplier
-- with no dollar activity"; the diagnosis is INVERTED, and this suite is built to say so out loud:
-- supplier `A` below HAS the dollar debt, and it is the ZERO that is the false statement.
--
-- `0320` narrows the join to INNER, so every emitted row was valued by the caller's own read.
--
-- WHAT IS PROVED, AND ON WHICH PATH. Every reading below happens with `role` set to `authenticated`
-- and a real `request.jwt.claim.sub`, so `auth_org()`, `auth_role()`, `auth_scopes()` and the view's
-- own grants are all actually in the path. A reading taken as `postgres` skips RLS and the financial
-- command guard and proves nothing at all — the fixtures are written that way on purpose (a seed has
-- no end-user subject, which is what `p1_financial_command_guard` lets through) and every assertion
-- is not.
--
-- EVERY ASSERTION IS PER ROW. `owner_all_rows` and `accountant_all_rows` enumerate each
-- (supplier, currency) with its amount AND its open-invoice count; a count of rows would pass for
-- the wrong reason, which is exactly how a zero-valued row hides. The per-row steps beside them
-- exist so a red run names the individual disagreement rather than one long string.
--
-- THE CONTROLS, which pass on the unfixed tree and must keep passing:
--   `owner_*`              the owner sees an unapproved invoice, so `0320` must change NOTHING for
--                          that role. The four predicates the supplier reader puts on `invoices`
--                          are the same four the invoice reader applies, so for an owner every
--                          joined invoice already has a balance row.
--   `accountant_b_*`       a currency the accountant CAN value is still reported, in full. The fix
--                          hides nothing it was allowed to show.
--   `accountant_c_ils`     a MEASURED zero stays a zero. Supplier C's shekel invoice is approved
--                          and paid to exactly 0.00: the accountant can value it, the answer is 0,
--                          and turning that into an em dash would be the mirror mistake the
--                          constitution also forbids.
--
-- Run only against a disposable database with every migration applied. The whole file is one
-- transaction and ends in `rollback`, so it commits no fixture and the suites after it observe the
-- database they would have observed anyway.
\set ON_ERROR_STOP on

begin;

drop schema if exists p113 cascade;
create schema p113;
create table p113.observed(step text primary key, actual text not null);
create table p113.expected(step text primary key, want text not null, note text not null);
-- The readings are TAKEN as `authenticated`, so the row that records them is written by that role
-- too. Granting the schema is what lets the measurement and its record share one statement.
grant usage on schema p113 to authenticated;
grant insert, select on p113.observed to authenticated;

create function p113.act(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user::text,
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
    ))
  )::text, true);
end
$$;

-- One supplier and one currency, read through the VIEW the client actually reads — not the function
-- behind it — so the grant and `security_invoker` are in the path as well as the body.
create function p113.balance(p_supplier uuid, p_currency text)
returns text language sql stable as $$
  select coalesce(
    (select b.open_balance_in_currency::numeric(14,3)::text || '/' || b.open_invoices::text
       from public.supplier_balances_by_currency b
      where b.supplier_id = p_supplier and b.currency = p_currency),
    'no row')
$$;
grant execute on function p113.balance(uuid, text) to authenticated;

-- The whole picture in one string: every (supplier, currency) this role is given, with its amount
-- and its open-invoice count. The tags are joined from a literal list rather than from
-- `public.suppliers`, because the accountant is not a reader of that table and a join through it
-- would go empty for reasons that have nothing to do with what is under test.
create function p113.all_rows()
returns text language sql stable as $$
  select coalesce(string_agg(
           fixture.tag || '/' || b.currency || '='
             || b.open_balance_in_currency::numeric(14,3)::text || '/' || b.open_invoices::text,
           ' ' order by fixture.tag, b.currency), 'none')
  from public.supplier_balances_by_currency b
  join (values
    ('a1130000-0000-4000-8000-000000000001'::uuid, 'A'),
    ('a1130000-0000-4000-8000-000000000002'::uuid, 'B'),
    ('a1130000-0000-4000-8000-000000000003'::uuid, 'C'),
    ('a1130000-0000-4000-8000-000000000004'::uuid, 'D')
  ) fixture(id, tag) on fixture.id = b.supplier_id
$$;
grant execute on function p113.all_rows() to authenticated;

-- ===== Fixture =====

insert into public.organizations (id, name, status, vat_rate, base_currency, country_code) values
  ('01130000-0000-4000-8000-000000000001', 'P113 tenant', 'active', 18, 'ILS', 'IL');

-- `p0_invoices_set_unit` fills a null unit_id with the legal entity, so the legal-entity predicate
-- is genuinely exercised rather than short-circuited by a null. Both profiles reach it: inserting a
-- profile seeds a root-unit scope grant, whose closure is the whole subtree.
select u.id as legal_entity
from public.org_units u
where u.org_id = '01130000-0000-4000-8000-000000000001'
  and u.unit_type = 'legal_entity'
order by u.created_at, u.id
limit 1
\gset p113_

insert into auth.users (id, email) values
  ('02130000-0000-4000-8000-000000000001', 'p113-owner@example.test'),
  ('02130000-0000-4000-8000-000000000002', 'p113-accountant@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('02130000-0000-4000-8000-000000000001', '01130000-0000-4000-8000-000000000001',
   'P113 owner', 'owner'),
  ('02130000-0000-4000-8000-000000000002', '01130000-0000-4000-8000-000000000001',
   'P113 accountant', 'accountant');

insert into public.suppliers (id, org_id, name, status, default_currency, country_code) values
  -- A: the MON-03 supplier. Shekels the accountant may value, dollars it may not.
  ('a1130000-0000-4000-8000-000000000001', '01130000-0000-4000-8000-000000000001',
   'P113 A two currencies', 'active', 'ILS', 'IL'),
  -- B: both currencies approved. The control that the fix hides nothing it may show.
  ('a1130000-0000-4000-8000-000000000002', '01130000-0000-4000-8000-000000000001',
   'P113 B both approved', 'active', 'ILS', 'IL'),
  -- C: approved and paid to exactly zero. The control that a MEASURED zero stays a zero.
  ('a1130000-0000-4000-8000-000000000003', '01130000-0000-4000-8000-000000000001',
   'P113 C settled', 'active', 'ILS', 'IL'),
  -- D: nothing the accountant may value at all — FIN-04's screen, where a whole card must read `—`.
  ('a1130000-0000-4000-8000-000000000004', '01130000-0000-4000-8000-000000000001',
   'P113 D nothing approved', 'active', 'USD', 'US');

insert into public.invoices (
  id, org_id, unit_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status, payment_status, currency
) values
  ('11130000-0000-4000-8000-000000000001', '01130000-0000-4000-8000-000000000001',
   :'p113_legal_entity', 'a1130000-0000-4000-8000-000000000001',
   'P113-A-ILS', current_date, 150, 0, 150, 'received', 'unpaid', 'ILS'),
  -- The $300 FIN-04 called a supplier with "no dollar activity". It is a real debt, and it is the
  -- reason a `$ 0` on that card is a false statement rather than a harmless extra line.
  ('11130000-0000-4000-8000-000000000002', '01130000-0000-4000-8000-000000000001',
   :'p113_legal_entity', 'a1130000-0000-4000-8000-000000000001',
   'P113-A-USD', current_date, 300, 0, 300, 'received', 'unpaid', 'USD'),
  ('11130000-0000-4000-8000-000000000003', '01130000-0000-4000-8000-000000000001',
   :'p113_legal_entity', 'a1130000-0000-4000-8000-000000000002',
   'P113-B-ILS', current_date, 640, 0, 640, 'received', 'unpaid', 'ILS'),
  ('11130000-0000-4000-8000-000000000004', '01130000-0000-4000-8000-000000000001',
   :'p113_legal_entity', 'a1130000-0000-4000-8000-000000000002',
   'P113-B-USD', current_date, 200, 0, 200, 'received', 'unpaid', 'USD'),
  ('11130000-0000-4000-8000-000000000005', '01130000-0000-4000-8000-000000000001',
   :'p113_legal_entity', 'a1130000-0000-4000-8000-000000000003',
   'P113-C-ILS', current_date, 400, 0, 400, 'received', 'unpaid', 'ILS'),
  ('11130000-0000-4000-8000-000000000006', '01130000-0000-4000-8000-000000000001',
   :'p113_legal_entity', 'a1130000-0000-4000-8000-000000000004',
   'P113-D-USD', current_date, 500, 0, 500, 'received', 'unpaid', 'USD');

-- 0099 forbids a trusted fixture from materialising an approved invoice without the same
-- server-authoritative transition production uses. Everything the accountant may value is approved
-- here; A's dollars and D's dollars deliberately are not.
select p113.act('02130000-0000-4000-8000-000000000001');
set local role authenticated;
select public.set_invoice_review_status('11130000-0000-4000-8000-000000000001', 'in_review', 'P113 fixture review started');
select public.set_invoice_review_status('11130000-0000-4000-8000-000000000001', 'approved', 'P113 fixture approved');
select public.set_invoice_review_status('11130000-0000-4000-8000-000000000003', 'in_review', 'P113 fixture review started');
select public.set_invoice_review_status('11130000-0000-4000-8000-000000000003', 'approved', 'P113 fixture approved');
select public.set_invoice_review_status('11130000-0000-4000-8000-000000000004', 'in_review', 'P113 fixture review started');
select public.set_invoice_review_status('11130000-0000-4000-8000-000000000004', 'approved', 'P113 fixture approved');
select public.set_invoice_review_status('11130000-0000-4000-8000-000000000005', 'in_review', 'P113 fixture review started');
select public.set_invoice_review_status('11130000-0000-4000-8000-000000000005', 'approved', 'P113 fixture approved');
reset role;

-- The subject goes with the role. `p1_financial_command_guard` lets a caller with no end-user
-- subject through — that is what a seed is — and refuses one that has a subject but did not arrive
-- through an RPC, so leaving the owner's `sub` set would turn the payment rows below into
-- `financial_command_rpc_required`.
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '', true);

-- Supplier C, paid to exactly 400.00 of 400.00. This is the measured zero: the accountant can read
-- the invoice, the arithmetic really is nil, and the answer must stay `0.000`.
insert into public.payments (
  id, org_id, unit_id, supplier_id, amount, paid_date, method, reference, executed_by, currency
) values (
  '31130000-0000-4000-8000-000000000001', '01130000-0000-4000-8000-000000000001',
  :'p113_legal_entity', 'a1130000-0000-4000-8000-000000000003', 400, current_date,
  'transfer', 'P113-C-SETTLED', '02130000-0000-4000-8000-000000000001', 'ILS');

insert into public.payment_allocations (id, org_id, payment_id, invoice_id, credit_id, amount, currency)
values (
  '41130000-0000-4000-8000-000000000001', '01130000-0000-4000-8000-000000000001',
  '31130000-0000-4000-8000-000000000001', '11130000-0000-4000-8000-000000000005',
  null, 400, 'ILS');

-- ===== The readings, every one of them on the guarded path =====

select p113.act('02130000-0000-4000-8000-000000000001');
set local role authenticated;

insert into p113.observed(step, actual) values
  ('owner_all_rows',  p113.all_rows()),
  ('owner_a_ils',     p113.balance('a1130000-0000-4000-8000-000000000001', 'ILS')),
  ('owner_a_usd',     p113.balance('a1130000-0000-4000-8000-000000000001', 'USD')),
  ('owner_b_ils',     p113.balance('a1130000-0000-4000-8000-000000000002', 'ILS')),
  ('owner_b_usd',     p113.balance('a1130000-0000-4000-8000-000000000002', 'USD')),
  ('owner_c_ils',     p113.balance('a1130000-0000-4000-8000-000000000003', 'ILS')),
  ('owner_d_usd',     p113.balance('a1130000-0000-4000-8000-000000000004', 'USD')),
  -- Nothing anywhere may add ₪150 to $300. Asked as its own question so a body that ever merged
  -- them would be named here rather than merely making the enumeration above look odd.
  ('owner_a_merged',  (select coalesce(count(*)::text, '0') from public.supplier_balances_by_currency
                       where supplier_id = 'a1130000-0000-4000-8000-000000000001'
                         and open_balance_in_currency = 450));

reset role;
select p113.act('02130000-0000-4000-8000-000000000002');
set local role authenticated;

insert into p113.observed(step, actual) values
  ('accountant_all_rows', p113.all_rows()),
  ('accountant_a_ils',    p113.balance('a1130000-0000-4000-8000-000000000001', 'ILS')),
  ('accountant_a_usd',    p113.balance('a1130000-0000-4000-8000-000000000001', 'USD')),
  ('accountant_b_ils',    p113.balance('a1130000-0000-4000-8000-000000000002', 'ILS')),
  ('accountant_b_usd',    p113.balance('a1130000-0000-4000-8000-000000000002', 'USD')),
  ('accountant_c_ils',    p113.balance('a1130000-0000-4000-8000-000000000003', 'ILS')),
  ('accountant_d_usd',    p113.balance('a1130000-0000-4000-8000-000000000004', 'USD')),
  -- The role boundary the reader must NOT have widened: what the accountant is shown of A's dollars
  -- is nothing at all, neither the debt nor a zero standing in for it.
  ('accountant_a_usd_leak', (select coalesce(max(open_balance_in_currency)::text, 'none')
                             from public.supplier_balances_by_currency
                             where supplier_id = 'a1130000-0000-4000-8000-000000000001'
                               and currency = 'USD'));

reset role;

-- ===== What each of those must say =====

insert into p113.expected(step, want, note) values
  ('owner_all_rows',
   'A/ILS=150.000/1 A/USD=300.000/1 B/ILS=640.000/1 B/USD=200.000/1 C/ILS=0.000/0 D/USD=500.000/1',
   'CONTROL: the owner values every payable invoice in scope, approved or not, so 0320 changes nothing here'),
  ('owner_a_ils',    '150.000/1', 'CONTROL: the shekel debt'),
  ('owner_a_usd',    '300.000/1', 'CONTROL: the dollar debt FIN-04 said did not exist'),
  ('owner_b_ils',    '640.000/1', 'CONTROL'),
  ('owner_b_usd',    '200.000/1', 'CONTROL'),
  ('owner_c_ils',    '0.000/0',   'CONTROL: a measured zero, and it stays a zero for the owner too'),
  ('owner_d_usd',    '500.000/1', 'CONTROL'),
  ('owner_a_merged', '0',         'CONTROL: 150 and 300 are never one row of 450'),
  ('accountant_all_rows',
   'A/ILS=150.000/1 B/ILS=640.000/1 B/USD=200.000/1 C/ILS=0.000/0',
   'MON-03: exactly the rows this role can value. A/USD and D/USD must be ABSENT, not zero'),
  ('accountant_a_ils',      '150.000/1', 'CONTROL: what the accountant may value is unchanged'),
  ('accountant_a_usd',      'no row',
   'MON-03/FIN-04: the accountant cannot value this currency, so it gets no row and the card draws an em dash. `0.000` here is the sentence "this supplier owes nothing in dollars", and it is false against a real $300'),
  ('accountant_b_ils',      '640.000/1', 'CONTROL'),
  ('accountant_b_usd',      '200.000/1', 'CONTROL: a currency this role CAN value is still reported in full'),
  ('accountant_c_ils',      '0.000/0',   'CONTROL: a measured zero must not become an em dash — the mirror mistake'),
  ('accountant_d_usd',      'no row',
   'FIN-04 as the whole card: a supplier this role can value nothing of returns nothing at all'),
  ('accountant_a_usd_leak', 'none',
   'and the fix is not a widening: the accountant is shown neither the $300 nor a zero standing in for it');

-- ONE raise with every disagreement inside it. A report that stops at the first mismatch sends the
-- reader back for another full run to learn the second one.
do $report$
declare v_lines text;
begin
  select string_agg(format('  %s: expected %L, got %L  (%s)',
                           e.step, e.want, coalesce(o.actual, '(no row recorded)'), e.note), e'\n'
                    order by e.step)
    into v_lines
  from p113.expected e
  left join p113.observed o on o.step = e.step
  where o.actual is null or o.actual <> e.want;

  if v_lines is not null then
    raise exception e'P113 failed — the supplier ledger states a balance in a currency its reader cannot value:\n%', v_lines;
  end if;
end
$report$;

-- Every expectation was actually taken. A suite whose readings silently stopped being recorded
-- would otherwise pass with an empty comparison, which is the failure mode the campaign exists for.
do $coverage$
declare v_missing int;
begin
  select count(*) into v_missing
  from p113.expected e left join p113.observed o on o.step = e.step
  where o.step is null;
  if v_missing <> 0 then
    raise exception 'P113: % expectation(s) had no reading at all', v_missing;
  end if;
end
$coverage$;

rollback;

select 'p113_a_currency_this_role_cannot_value_passed' as result;
