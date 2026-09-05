-- 0322: a statement line is spent once.
--
-- MON-04. `public.bank_allocations` has carried, since `0001`, no bound of any kind on how much of
-- a statement line its rows may claim. Two constraints look like one and are not:
--
--   * `bank_allocations_amount_positive` (`0023:15`) bounds ONE row from below.
--   * `match_bank_transaction` (`0023:951`, currency-corrected by `0232`) refuses a payload whose
--     own total exceeds the line — `bank_allocation_total_mismatch`. It compares `v_sum`, computed
--     from the JSONB it was handed, against `v_tx.amount`. It never reads what the line ALREADY
--     carries, and there is no check on UPDATE at all.
--
-- So the invariant "the confirmed allocations of a statement line do not exceed the line" was
-- asserted nowhere: not as a constraint, not as a trigger, and only within a single call of a
-- single command. Everything else that writes this table — `unmatch_bank_transaction` (`0034:546`),
-- the `0232` settlement inserts, a migration, a repair script — was free of it.
--
-- WHAT PRODUCTION ACTUALLY HOLDS, measured read-only on 05.09.2026 against `rkftlbctohswhbbiaqin`
-- (9 bank transactions, 9 allocations, 8 confirmed, 1 tenant):
--
--   lines whose CONFIRMED allocations exceed the line ................ 0
--   lines whose allocations INCLUDING suggestions exceed the line .... 1, by exactly 2,950.00 ILS
--
-- The finding reads "two confirmed allocations of 2,950.00 each". That is not what is there. The
-- line `fa000000-…-0008` carries two rows of 2,950.00 to the same target: one written by the demo
-- seed on 16.07.2026 with `confirmed = false` and `confidence 0.820` — a SUGGESTION — and one
-- written by a real `match_bank_transaction` call on 02.09.2026 with `confirmed = true`. One claim
-- on the money, not two. The pair is left exactly as it is: which row survives is the owner's
-- decision and financial rows are soft-deleted only.
--
-- WHY THE BOUND COUNTS `confirmed` ROWS AND ONLY THOSE. A suggestion is a proposal the matching
-- heuristic printed; it claims nothing. The whole product already reads the table that way —
-- `Bank.tsx:502` filters `confirmed = true` to decide which recorded transfers are still open,
-- `match_bank_transaction`'s idempotent replay compares only confirmed rows, and
-- `unmatch_bank_transaction` counts only confirmed ones. A bound that counted suggestions would
-- refuse the product's ordinary path: confirming a full-line suggestion inserts a SECOND row
-- rather than flipping the first, so seed line `fa000000-…-0008` — a 2,950.00 line already
-- carrying a 2,950.00 suggestion — could never be matched again.
--
-- THE MECHANISM IS A TRIGGER BECAUSE IT CANNOT BE A KEY. `0217` states the schema's preference
-- plainly: a composite foreign key makes a bad row unrepresentable, while a trigger is code that
-- has to run. A sum across sibling rows compared against a parent column is not expressible as a
-- foreign key or as a table CHECK — a CHECK may not read another row. A CONSTRAINT trigger is the
-- nearest thing the engine offers: it is NOT DEFERRABLE, so no session can switch it off with
-- `set constraints`, and it fires at the end of the statement, so a multi-row
-- `insert … select` (the direct-match path, `0023:1000`) is judged on its total rather than on
-- its first row.
--
-- Currency needs no separate arm and gets one anyway. `bank_allocations.currency` is tied to
-- `bank_transactions.currency` by `bank_allocations_transaction_currency_fk` (`0217:395`), so every
-- allocation on a line is already in the line's currency and the sum below cannot span two. The
-- predicate states it regardless: the guard must remain a per-currency comparison if that key is
-- ever replaced, and a money sum that does not name its currency is exactly what `check:currency`
-- exists to refuse.

create or replace function public.guard_bank_allocation_within_statement_line()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $guard_bank_allocation_within_statement_line$
declare
  v_candidates uuid[];
  v_line_ids uuid[];
  v_line record;
  v_claimed numeric;
begin
  -- BOTH lines when a row MOVES between them, one when it does not, and always in id order.
  -- The move is the case a naive guard misses: it is an UPDATE, the row's new home is the one
  -- that can overflow, and two sessions moving rows in opposite directions between the same two
  -- lines would deadlock rather than serialise if each locked in its own arrival order.
  --
  -- The branch is explicit rather than a CASE over `tg_op` inside one expression: on INSERT the
  -- OLD record has no row assigned to it, and PL/pgSQL raises on the field reference before any
  -- CASE arm is chosen.
  if tg_op = 'UPDATE' then
    v_candidates := array[new.bank_transaction_id, old.bank_transaction_id];
  else
    v_candidates := array[new.bank_transaction_id];
  end if;

  select array_agg(distinct candidate order by candidate)
    into v_line_ids
  from unnest(v_candidates) as t(candidate)
  where candidate is not null;

  -- Taken BEFORE the sum and in one statement, so the lock order is the sort order. A second
  -- session blocks here; when the first commits, this statement re-reads the winner and the
  -- aggregate below runs under a fresh statement snapshot that contains the winner's row. That
  -- is what turns "two sessions each saw room" into "one wins, one is refused by name".
  perform 1
  from public.bank_transactions t
  where t.id = any(v_line_ids)
  order by t.id
  for update;

  for v_line in
    select t.id, t.amount, t.currency
    from public.bank_transactions t
    where t.id = any(v_line_ids)
    order by t.id
  loop
    select coalesce(sum(ba.amount), 0)
      into v_claimed
    from public.bank_allocations ba
    where ba.bank_transaction_id = v_line.id
      and ba.currency = v_line.currency
      and ba.confirmed;

    if v_claimed > v_line.amount then
      raise exception 'bank_allocation_exceeds_statement_line'
        using errcode = 'P0001',
              detail = format(
                'statement line %s holds %s confirmed of %s %s',
                v_line.id, v_claimed, v_line.amount, v_line.currency);
    end if;
  end loop;

  return null;
end
$guard_bank_allocation_within_statement_line$;

revoke all on function public.guard_bank_allocation_within_statement_line()
  from public, anon, authenticated, service_role;

comment on function public.guard_bank_allocation_within_statement_line() is
  'MON-04 (0322). Refuses a write that would leave a bank statement line holding more CONFIRMED '
  'allocation than the line itself, in the line''s own currency — on INSERT, on UPDATE, and when '
  'a row is moved from another line. Locks the affected lines in id order first, so two sessions '
  'serialise instead of both seeing room. Suggestions are not counted: they claim no money.';

-- Nothing in the tree may be over-allocated when the bound arrives. Measured zero on production
-- and zero on the demo seed (line `fa000000-…-0004` holds 590 + 413 + 826 = 1,829.00 against
-- 1,829.00 — equal, which is allowed; the bound is on EXCEEDING). Installing a bound over data
-- that already breaks it is how a guard comes to mean "from now on, mostly".
do $assert_no_existing_overspend_0322$
declare
  v_offenders text;
begin
  select string_agg(format('  line %s: %s confirmed against %s %s',
                           line.id, line.claimed, line.amount, line.currency), e'\n'
                    order by line.id)
    into v_offenders
  from (
    select t.id, t.amount, t.currency,
           coalesce(sum(ba.amount) filter (where ba.confirmed), 0) as claimed
    from public.bank_transactions t
    left join public.bank_allocations ba
      on ba.bank_transaction_id = t.id and ba.currency = t.currency
    group by t.id, t.amount, t.currency
  ) line
  where line.claimed > line.amount;

  if v_offenders is not null then
    raise exception e'0322: statement lines already over-allocated:\n%', v_offenders;
  end if;
end
$assert_no_existing_overspend_0322$;

create constraint trigger bank_allocations_statement_line_guard
  after insert or update on public.bank_allocations
  for each row execute function public.guard_bank_allocation_within_statement_line();

do $assert_0322$
declare
  v_violations text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_trigger tg
    join pg_catalog.pg_class c on c.oid = tg.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'bank_allocations'
      and tg.tgname = 'bank_allocations_statement_line_guard'
      and tg.tgconstraint <> 0
      and not tg.tgdeferrable
  ) then
    raise exception '0322: the statement-line guard is not installed as a non-deferrable constraint trigger';
  end if;
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0322 scope failed:\n%', v_violations; end if;
end
$assert_0322$;
