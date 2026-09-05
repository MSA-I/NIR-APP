-- P115 — a statement line is spent once.
--
-- Run only against a disposable database with every migration applied. This file COMMITS its
-- fixtures and opens independent sessions with dblink, exactly as p108_one_balance_one_approval.sql
-- and p63_financial_credit_concurrency.sql do; reset the database before every run and run psql as
-- the disposable DB superuser.
--
-- WHAT IS UNDER TEST. `MON-04`: `public.bank_allocations` carried no bound on how much of a
-- statement line its rows may claim. `match_bank_transaction` compares the payload it was HANDED
-- against the line, and nothing compares the line against what it already holds — so a line that
-- already carries a full allocation accepts a second one, and an UPDATE that moves an allocation
-- onto a full line was checked by nothing at all.
--
-- THE FINDING'S OWN WORDING IS NOT WHAT PRODUCTION HOLDS, and the suite is built on the
-- measurement rather than on the wording. Measured read-only on 05.09.2026: zero lines whose
-- CONFIRMED allocations exceed the line, and one line carrying a confirmed match of 2,950.00 ILS
-- beside a leftover SUGGESTION of 2,950.00 written by the demo seed. A suggestion claims no money,
-- so the bound counts confirmed rows and only those — and `suggestion_beside_a_full_line` below is
-- a control that says so, in both runs.
--
-- TWO ARMS, AND WHY BOTH ARE NEEDED.
--
--   The COMMAND arm is the guarded path: role `authenticated` with a real
--   `request.jwt.claim.sub`, calling `public.match_bank_transaction` as the owner, so RLS,
--   `auth_role()` and `p1_financial_command_guard` are all in front of the write. It proves the
--   refusal reaches an end user by name through the product's own door.
--
--   The TABLE arm writes `bank_allocations` directly, and cannot do otherwise: `0023:166` revokes
--   insert, update and delete on this table from `authenticated`, so EVERY product write to it
--   happens inside a SECURITY DEFINER function, at the definer owner's privilege. A direct write
--   here is therefore not a way around the guard — it is the exact privilege level at which every
--   real write runs, and the level at which nothing else bounds this table. It is also the only
--   way to reach two of the oracle's three cases at all: no command moves an allocation between
--   lines, and no two commands can write one line concurrently, because `match_bank_transaction`
--   locks the line before my guard ever sees it. The command's lock serialises command against
--   command; the guard's lock is what serialises everything else, and that is what the race below
--   measures.
--
-- Fixtures are written with no end-user subject — `p1_financial_command_guard` lets such a caller
-- through, which is what a migration or a seed is — and every COMMAND arm call sets the subject
-- first.
--
-- The outcomes are RECORDED and asserted at the end rather than asserted where they happen: under
-- ON_ERROR_STOP a suite that asserts inline stops at the first failure and reports one line, and a
-- suite that commits its fixtures cannot simply be run twice for the second one.
\set ON_ERROR_STOP on

create extension if not exists dblink;
drop schema if exists p115 cascade;
create schema p115;

create table p115.results (step text primary key, outcome text not null);
grant usage on schema p115 to authenticated;
grant insert, select on p115.results to authenticated;

-- 'ok', or the server's own message.
create function p115.try_sql(p_sql text)
returns text language plpgsql security invoker as $$
begin
  begin
    execute p_sql;
  exception when others then
    return sqlerrm;
  end;
  return 'ok';
end
$$;
grant execute on function p115.try_sql(text) to authenticated;

create function p115.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P115 assertion failed: %', p_message;
  end if;
end
$$;

-- ===== Fixture =====

insert into public.organizations (id, name, status, vat_rate, base_currency, country_code, settings)
values ('f1150000-0000-4000-8000-000000000001', 'P115 tenant', 'active', 18, 'ILS', 'IL',
        jsonb_build_object('bank_match_amount_tolerance', 1));

select u.id as legal_entity
from public.org_units u
where u.org_id = 'f1150000-0000-4000-8000-000000000001'
  and u.unit_type = 'legal_entity'
order by u.created_at, u.id
limit 1
\gset p115_

insert into auth.users (id, email) values
  ('f1150000-0000-4000-8000-000000000002', 'p115-owner@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('f1150000-0000-4000-8000-000000000002', 'f1150000-0000-4000-8000-000000000001',
   'P115 owner', 'owner');

insert into public.suppliers (id, org_id, name, status, default_currency, country_code) values
  ('f1150000-0000-4000-8000-000000000011', 'f1150000-0000-4000-8000-000000000001',
   'P115 supplier', 'active', 'ILS', 'IL');

-- One invoice per scenario, each large enough that the command's OWN balance check
-- (`allocation_exceeds_balance`) is never the thing that refuses. The bound under test is the
-- statement line, not the debt.
insert into public.invoices (
  id, org_id, unit_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status, payment_status, currency
) values
  ('f1150000-0000-4000-8000-000000000021', 'f1150000-0000-4000-8000-000000000001',
   :'p115_legal_entity', 'f1150000-0000-4000-8000-000000000011',
   'P115-CMD-FULL', current_date, 2950, 0, 2950, 'received', 'unpaid', 'ILS'),
  ('f1150000-0000-4000-8000-000000000022', 'f1150000-0000-4000-8000-000000000001',
   :'p115_legal_entity', 'f1150000-0000-4000-8000-000000000011',
   'P115-CMD-SUGGESTED', current_date, 2950, 0, 2950, 'received', 'unpaid', 'ILS'),
  ('f1150000-0000-4000-8000-000000000023', 'f1150000-0000-4000-8000-000000000001',
   :'p115_legal_entity', 'f1150000-0000-4000-8000-000000000011',
   'P115-TABLE', current_date, 40000, 0, 40000, 'received', 'unpaid', 'ILS');

insert into public.bank_imports (
  id, org_id, filename, file_hash, column_mapping, row_count, imported_by, currency
) values
  ('f1150000-0000-4000-8000-000000000031', 'f1150000-0000-4000-8000-000000000001',
   'p115.csv', 'p115-hash', '{}', 8, 'f1150000-0000-4000-8000-000000000002', 'ILS');

-- Eight lines of 2,950.00 ILS except where a scenario needs room, each with its own row hash
-- because `bank_transactions_org_row_hash_idx` is unique per tenant.
insert into public.bank_transactions (
  id, org_id, import_id, tx_date, description, amount, is_debit, reference, raw,
  supplier_id, status, row_hash, currency
) values
  -- COMMAND arm
  ('f1150000-0000-4000-8000-000000000041', 'f1150000-0000-4000-8000-000000000001',
   'f1150000-0000-4000-8000-000000000031', current_date, 'P115 line already fully allocated',
   2950, true, 'P115-CMD-FULL', '{}', 'f1150000-0000-4000-8000-000000000011', 'suggested',
   'p115-row-1', 'ILS'),
  ('f1150000-0000-4000-8000-000000000042', 'f1150000-0000-4000-8000-000000000001',
   'f1150000-0000-4000-8000-000000000031', current_date, 'P115 line carrying only a suggestion',
   2950, true, 'P115-CMD-SUGGESTED', '{}', 'f1150000-0000-4000-8000-000000000011', 'suggested',
   'p115-row-2', 'ILS'),
  -- TABLE arm: sequential
  ('f1150000-0000-4000-8000-000000000043', 'f1150000-0000-4000-8000-000000000001',
   'f1150000-0000-4000-8000-000000000031', current_date, 'P115 direct second confirmed',
   2950, true, 'P115-DIRECT', '{}', 'f1150000-0000-4000-8000-000000000011', 'matched',
   'p115-row-3', 'ILS'),
  ('f1150000-0000-4000-8000-000000000044', 'f1150000-0000-4000-8000-000000000001',
   'f1150000-0000-4000-8000-000000000031', current_date, 'P115 direct split',
   2950, true, 'P115-SPLIT', '{}', 'f1150000-0000-4000-8000-000000000011', 'matched',
   'p115-row-4', 'ILS'),
  -- TABLE arm: the move
  ('f1150000-0000-4000-8000-000000000045', 'f1150000-0000-4000-8000-000000000001',
   'f1150000-0000-4000-8000-000000000031', current_date, 'P115 move source',
   5000, true, 'P115-SOURCE', '{}', 'f1150000-0000-4000-8000-000000000011', 'matched',
   'p115-row-5', 'ILS'),
  ('f1150000-0000-4000-8000-000000000046', 'f1150000-0000-4000-8000-000000000001',
   'f1150000-0000-4000-8000-000000000031', current_date, 'P115 move destination with room',
   5000, true, 'P115-ROOM', '{}', 'f1150000-0000-4000-8000-000000000011', 'matched',
   'p115-row-6', 'ILS'),
  -- TABLE arm: the two races
  ('f1150000-0000-4000-8000-000000000047', 'f1150000-0000-4000-8000-000000000001',
   'f1150000-0000-4000-8000-000000000031', current_date, 'P115 race that overflows',
   2950, true, 'P115-RACE-OVER', '{}', 'f1150000-0000-4000-8000-000000000011', 'matched',
   'p115-row-7', 'ILS'),
  ('f1150000-0000-4000-8000-000000000048', 'f1150000-0000-4000-8000-000000000001',
   'f1150000-0000-4000-8000-000000000031', current_date, 'P115 race that fits',
   2950, true, 'P115-RACE-FITS', '{}', 'f1150000-0000-4000-8000-000000000011', 'matched',
   'p115-row-8', 'ILS');

-- What each line starts holding. Written as the fixture writer, which is the level every real
-- write to this table runs at, and never over the bound: 2,950.00 against a 2,950.00 line is
-- EQUAL, and equal is allowed. A fixture that was already over the bound would be refused by the
-- guard under test and would be measuring the fixture rather than the finding.
insert into public.bank_allocations (
  bank_transaction_id, invoice_id, payment_id, amount, confidence, confirmed, created_by, currency
) values
  -- 41: full, confirmed. The command arm's overflow case.
  ('f1150000-0000-4000-8000-000000000041', 'f1150000-0000-4000-8000-000000000021', null,
   2950, 0.900, true, 'f1150000-0000-4000-8000-000000000002', 'ILS'),
  -- 42: full, but only a SUGGESTION — the demo seed's shape and production's shape.
  ('f1150000-0000-4000-8000-000000000042', 'f1150000-0000-4000-8000-000000000022', null,
   2950, 0.820, false, null, 'ILS'),
  -- 43: full, confirmed. The table arm's overflow case.
  ('f1150000-0000-4000-8000-000000000043', 'f1150000-0000-4000-8000-000000000023', null,
   2950, 0.900, true, 'f1150000-0000-4000-8000-000000000002', 'ILS'),
  -- 45: 2,950.00 of a 5,000.00 line, confirmed — the row that will be MOVED.
  ('f1150000-0000-4000-8000-000000000045', 'f1150000-0000-4000-8000-000000000023', null,
   2950, 0.900, true, 'f1150000-0000-4000-8000-000000000002', 'ILS');

select ba.id as movable
from public.bank_allocations ba
where ba.bank_transaction_id = 'f1150000-0000-4000-8000-000000000045'
\gset p115_

-- ===== The COMMAND arm: an authenticated owner, through the product's own door =====

select set_config('request.jwt.claim.sub', 'f1150000-0000-4000-8000-000000000002', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'f1150000-0000-4000-8000-000000000002', 'role', 'authenticated'
)::text, false);
set role authenticated;

-- MON-04 through the command. The line already holds 2,950.00 confirmed; the payload's own total
-- is 2,950.00, which is exactly what `bank_allocation_total_mismatch` permits — so nothing in the
-- command refuses it and the line ends up holding 5,900.00 against 2,950.00.
insert into p115.results(step, outcome) values ('command_second_full_match', p115.try_sql($sql$
  select public.match_bank_transaction(
    'f1150000-0000-4000-8000-000000000041'::uuid,
    'f1150000-0000-4000-8000-000000000011'::uuid,
    null::uuid,
    'f1150000-0000-4000-8000-000000000051'::uuid,
    jsonb_build_array(jsonb_build_object(
      'invoice_id', 'f1150000-0000-4000-8000-000000000021', 'amount', 2950)),
    0.9, 'P115 matches a line that is already fully allocated')
$sql$));

-- The control, and the reason the bound counts confirmed rows only: a line carrying a full-amount
-- SUGGESTION is the ordinary state of every suggested line in this product, and matching it must
-- still work. This passes in both runs.
insert into p115.results(step, outcome) values ('suggestion_beside_a_full_line', p115.try_sql($sql$
  select public.match_bank_transaction(
    'f1150000-0000-4000-8000-000000000042'::uuid,
    'f1150000-0000-4000-8000-000000000011'::uuid,
    null::uuid,
    'f1150000-0000-4000-8000-000000000052'::uuid,
    jsonb_build_array(jsonb_build_object(
      'invoice_id', 'f1150000-0000-4000-8000-000000000022', 'amount', 2950)),
    0.9, 'P115 confirms a suggested line')
$sql$));

reset role;
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', '', false);
select set_config('request.jwt.claims', '', false);

-- ===== The TABLE arm: the invariant against every writer =====

insert into p115.results(step, outcome) values ('direct_second_confirmed', p115.try_sql($sql$
  insert into public.bank_allocations (
    bank_transaction_id, invoice_id, payment_id, amount, confidence, confirmed, created_by, currency
  ) values (
    'f1150000-0000-4000-8000-000000000043', 'f1150000-0000-4000-8000-000000000023', null,
    2950, 0.900, true, 'f1150000-0000-4000-8000-000000000002', 'ILS')
$sql$));

-- A suggestion on top of a full line claims nothing and is accepted. Both runs.
insert into p115.results(step, outcome) values ('direct_suggestion_on_full_line', p115.try_sql($sql$
  insert into public.bank_allocations (
    bank_transaction_id, invoice_id, payment_id, amount, confidence, confirmed, created_by, currency
  ) values (
    'f1150000-0000-4000-8000-000000000043', 'f1150000-0000-4000-8000-000000000023', null,
    2950, 0.700, false, null, 'ILS')
$sql$));

-- Splitting a line across two confirmed allocations that TOGETHER equal it stays legal. Both runs.
insert into p115.results(step, outcome) values ('direct_split_first', p115.try_sql($sql$
  insert into public.bank_allocations (
    bank_transaction_id, invoice_id, payment_id, amount, confidence, confirmed, created_by, currency
  ) values (
    'f1150000-0000-4000-8000-000000000044', 'f1150000-0000-4000-8000-000000000023', null,
    1000, 0.900, true, 'f1150000-0000-4000-8000-000000000002', 'ILS')
$sql$));
insert into p115.results(step, outcome) values ('direct_split_second', p115.try_sql($sql$
  insert into public.bank_allocations (
    bank_transaction_id, invoice_id, payment_id, amount, confidence, confirmed, created_by, currency
  ) values (
    'f1150000-0000-4000-8000-000000000044', 'f1150000-0000-4000-8000-000000000023', null,
    1950, 0.900, true, 'f1150000-0000-4000-8000-000000000002', 'ILS')
$sql$));
-- And one shekel more than the line does not.
insert into p115.results(step, outcome) values ('direct_split_one_over', p115.try_sql($sql$
  insert into public.bank_allocations (
    bank_transaction_id, invoice_id, payment_id, amount, confidence, confirmed, created_by, currency
  ) values (
    'f1150000-0000-4000-8000-000000000044', 'f1150000-0000-4000-8000-000000000023', null,
    1, 0.900, true, 'f1150000-0000-4000-8000-000000000002', 'ILS')
$sql$));

-- THE MOVE. An UPDATE, not an INSERT, and the case a guard written only for INSERT misses. The
-- row is 2,950.00 sitting on a 5,000.00 line; line 43 already holds 2,950.00 of 2,950.00.
insert into p115.results(step, outcome) values ('move_onto_a_full_line', p115.try_sql(format($sql$
  update public.bank_allocations
  set bank_transaction_id = 'f1150000-0000-4000-8000-000000000043'
  where id = %L
$sql$, :'p115_movable')));

-- The same move onto a line with room is accepted, so the refusal above is the bound and not a
-- blanket refusal of UPDATE. Both runs.
insert into p115.results(step, outcome) values ('move_onto_a_line_with_room', p115.try_sql(format($sql$
  update public.bank_allocations
  set bank_transaction_id = 'f1150000-0000-4000-8000-000000000046'
  where id = %L
$sql$, :'p115_movable')));

-- ===== Two sessions, one statement line =====
--
-- 2,000 and 2,000 each fit a 2,950.00 line on their own and cannot both stand. The first session
-- inserts and then SLEEPS INSIDE ITS TRANSACTION — after the guard has taken the line's row lock
-- and before it commits — so the second is measurably behind rather than merely second in the
-- file. Without the pause the two could serialise by luck and the suite would go green having
-- proved nothing.
create function p115.insert_allocation(
  p_line uuid, p_amount numeric, p_confirmed boolean, p_hold numeric
)
returns text language plpgsql security invoker as $$
begin
  perform set_config('statement_timeout', '20000', true);
  begin
    insert into public.bank_allocations (
      bank_transaction_id, invoice_id, payment_id, amount, confidence, confirmed, created_by, currency
    ) values (
      p_line, 'f1150000-0000-4000-8000-000000000023', null,
      p_amount, 0.900, p_confirmed, 'f1150000-0000-4000-8000-000000000002', 'ILS');
    perform pg_sleep(p_hold);
  exception when others then
    return sqlerrm;
  end;
  return 'ok';
end
$$;

select dblink_connect('p115_a', 'dbname=' || current_database());
select dblink_connect('p115_b', 'dbname=' || current_database());

select dblink_send_query('p115_a', $$select p115.insert_allocation(
  'f1150000-0000-4000-8000-000000000047', 2000, true, 1.2)$$);
select pg_sleep(0.2);
select dblink_send_query('p115_b', $$select p115.insert_allocation(
  'f1150000-0000-4000-8000-000000000047', 2000, true, 0)$$);
insert into p115.results(step, outcome)
select 'race_over_session_a', result from dblink_get_result('p115_a') as t(result text);
insert into p115.results(step, outcome)
select 'race_over_session_b', result from dblink_get_result('p115_b') as t(result text);
-- Drain the async end-of-results markers; without this the next send_query on the same
-- connection reports the connection is busy.
select count(*) from dblink_get_result('p115_a') as t(result text);
select count(*) from dblink_get_result('p115_b') as t(result text);

-- The same race with amounts that TOGETHER fit: 1,000 + 1,000 against 2,950.00. Both must stand,
-- so the lock the guard takes is not a way of refusing whoever arrives second. Both runs.
select dblink_send_query('p115_a', $$select p115.insert_allocation(
  'f1150000-0000-4000-8000-000000000048', 1000, true, 1.2)$$);
select pg_sleep(0.2);
select dblink_send_query('p115_b', $$select p115.insert_allocation(
  'f1150000-0000-4000-8000-000000000048', 1000, true, 0)$$);
insert into p115.results(step, outcome)
select 'race_fits_session_a', result from dblink_get_result('p115_a') as t(result text);
insert into p115.results(step, outcome)
select 'race_fits_session_b', result from dblink_get_result('p115_b') as t(result text);
select count(*) from dblink_get_result('p115_a') as t(result text);
select count(*) from dblink_get_result('p115_b') as t(result text);

select dblink_disconnect('p115_a');
select dblink_disconnect('p115_b');

-- ===== One report =====

create table p115.expectations (step text primary key, expected text not null, note text not null);
insert into p115.expectations (step, expected, note) values
  ('command_second_full_match', 'bank_allocation_exceeds_statement_line',
   'MON-04 on the guarded path: matching a line that already holds its whole amount confirmed must be refused BY NAME'),
  ('suggestion_beside_a_full_line', 'ok',
   'a full-amount SUGGESTION claims no money, so confirming a suggested line must still work'),
  ('direct_second_confirmed', 'bank_allocation_exceeds_statement_line',
   'and the table itself refuses a second confirmed allocation whatever wrote it'),
  ('direct_suggestion_on_full_line', 'ok',
   'a suggestion on top of a full line is not an over-allocation'),
  ('direct_split_first', 'ok', 'splitting a line across two confirmed allocations stays legal'),
  ('direct_split_second', 'ok',
   '1,000 + 1,950 = 2,950 against a 2,950.00 line: equal is allowed, the bound is on EXCEEDING'),
  ('direct_split_one_over', 'bank_allocation_exceeds_statement_line',
   'and one shekel past the line is refused, so the boundary is where it is claimed to be'),
  ('move_onto_a_full_line', 'bank_allocation_exceeds_statement_line',
   'the UPDATE case: an allocation MOVED from another line onto a full one is refused BY NAME'),
  ('move_onto_a_line_with_room', 'ok',
   'and the same move onto a line with room is accepted, so it is the bound and not the UPDATE');

do $report$
declare
  v_lines text;
  v_ok int;
  v_refused int;
begin
  select string_agg(format('  %s: expected %L, got %L  (%s)',
                           e.step, e.expected, coalesce(r.outcome, '(no row)'), e.note), e'\n'
                    order by e.step)
    into v_lines
  from p115.expectations e
  left join p115.results r on r.step = e.step
  where r.outcome is null
     or (e.expected = 'ok' and r.outcome <> 'ok')
     or (e.expected <> 'ok' and position(e.expected in r.outcome) = 0);

  select count(*) filter (where outcome = 'ok'),
         count(*) filter (where position('bank_allocation_exceeds_statement_line' in outcome) > 0)
    into v_ok, v_refused
  from p115.results where step in ('race_over_session_a', 'race_over_session_b');
  if v_ok <> 1 or v_refused <> 1 then
    v_lines := concat_ws(e'\n', v_lines, format(
      '  race that overflows: %s insert(s) succeeded and %s were refused by name; exactly one of each is required'
      || e'\n    session a: %L\n    session b: %L',
      v_ok, v_refused,
      (select outcome from p115.results where step = 'race_over_session_a'),
      (select outcome from p115.results where step = 'race_over_session_b')));
  end if;

  select count(*) filter (where outcome = 'ok') into v_ok
  from p115.results where step in ('race_fits_session_a', 'race_fits_session_b');
  if v_ok <> 2 then
    v_lines := concat_ws(e'\n', v_lines, format(
      '  race that fits: %s of 2 concurrent inserts stood; both must, or the guard is refusing the second writer rather than the overflow'
      || e'\n    session a: %L\n    session b: %L',
      v_ok,
      (select outcome from p115.results where step = 'race_fits_session_a'),
      (select outcome from p115.results where step = 'race_fits_session_b')));
  end if;

  if v_lines is not null then
    raise exception e'P115 failed — a statement line is not spent once:\n%', v_lines;
  end if;
end
$report$;

-- The arithmetic, not only the refusals: what each line actually holds afterwards. Asserted per
-- line rather than as one count, because a count agrees for the wrong reasons.
select p115.assert(
  (select coalesce(sum(ba.amount), 0) = 2950 and count(*) = 1
   from public.bank_allocations ba
   where ba.bank_transaction_id = 'f1150000-0000-4000-8000-000000000041' and ba.confirmed),
  'the line the command tried to match twice ended up holding more than 2,950.00 confirmed');
select p115.assert(
  (select count(*) = 0
   from public.payments p where p.id = 'f1150000-0000-4000-8000-000000000051'),
  'the refused match left a payment behind, so the refusal was a partial write rather than a refusal');
select p115.assert(
  (select coalesce(sum(ba.amount) filter (where ba.confirmed), 0) = 2950
      and coalesce(sum(ba.amount) filter (where not ba.confirmed), 0) = 2950
   from public.bank_allocations ba
   where ba.bank_transaction_id = 'f1150000-0000-4000-8000-000000000042'),
  'the suggested line did not end up with its suggestion and exactly one confirmed match beside it');
select p115.assert(
  (select coalesce(sum(ba.amount) filter (where ba.confirmed), 0) = 2950
   from public.bank_allocations ba
   where ba.bank_transaction_id = 'f1150000-0000-4000-8000-000000000043'),
  'the directly written line ended up holding more confirmed money than the line');
select p115.assert(
  (select coalesce(sum(ba.amount) filter (where ba.confirmed), 0) = 2950
   from public.bank_allocations ba
   where ba.bank_transaction_id = 'f1150000-0000-4000-8000-000000000044'),
  'the split line did not end up with exactly its two halves');
select p115.assert(
  (select bank_transaction_id = 'f1150000-0000-4000-8000-000000000046'
   from public.bank_allocations where id = :'p115_movable'::uuid),
  'the moved allocation did not end on the line with room');
select p115.assert(
  (select coalesce(sum(ba.amount) filter (where ba.confirmed), 0) = 2000
   from public.bank_allocations ba
   where ba.bank_transaction_id = 'f1150000-0000-4000-8000-000000000047'),
  'the raced line ended up holding both inserts');
select p115.assert(
  (select coalesce(sum(ba.amount) filter (where ba.confirmed), 0) = 2000
   from public.bank_allocations ba
   where ba.bank_transaction_id = 'f1150000-0000-4000-8000-000000000048'),
  'the race that fits did not leave both of its inserts standing');

-- The guard is a NON-DEFERRABLE constraint trigger, which is what stops a session switching it
-- off with `set constraints`. A guard that can be deferred away is a guard for whoever does not
-- know the command.
select p115.assert(
  (select count(*) = 1
   from pg_catalog.pg_trigger tg
   join pg_catalog.pg_class c on c.oid = tg.tgrelid
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'bank_allocations'
     and tg.tgname = 'bank_allocations_statement_line_guard'
     and tg.tgconstraint <> 0 and not tg.tgdeferrable),
  'the statement-line guard is not installed as a non-deferrable constraint trigger');

drop schema p115 cascade;

select 'p115_a_statement_line_is_spent_once_passed' as result;
