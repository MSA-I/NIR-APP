-- 0291 — one enum value, alone in its own file, for the same reason `0086` and `0273` are.
--
-- WHY IT IS NOT PART OF `0292`. Postgres refuses to USE an enum value in the transaction that
-- added it: `ERROR: unsafe use of new value "..." of enum type`. `0292` patches
-- `match_bank_transaction` to open an exception of this type and asserts, in its own verify block,
-- that the value is reachable — both of which would fail if the value were added in the same file.
--
-- WHAT IT MEANS, AND WHY THE VOCABULARY DID NOT ALREADY HAVE IT. Bank matching has two jobs that
-- look identical from the outside and are not: PAYING a supplier through the product, and
-- RECORDING money that already left the account at the bank. Recording is never refused — refusing
-- to record money that has already moved makes the ledger less true and strands the transaction.
-- But an invoice that was never approved and is nonetheless settled is a finding, and until now
-- the eleven exception values had no way to say it. The closest, `amount_mismatch`, is about two
-- figures that disagree; here the figures agree perfectly and the AUTHORITY is what is missing.
--
-- This is the control that owner decision C actually asks for: not a door that refuses, but a door
-- that cannot be walked through quietly. `0292` opens one of these in the same transaction as the
-- allocations, so a settlement and its exception can never disagree.

alter type exception_type add value if not exists 'unapproved_invoice_settled';

comment on type exception_type is
  'What kinds of thing can go wrong and be tracked as an exception. From 0291 the list can say '
  'that money was recorded against an invoice nobody approved — which is a finding about '
  'authority, not about amounts; see 0292 for the bank match that opens it. Added in its own '
  'migration because a new enum value cannot be used in the transaction that created it.';

do $verify_0291$
declare
  v_violations text;
begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'exception_type' and e.enumlabel = 'unapproved_invoice_settled') then
    raise exception '0291: the exception type was not added';
  end if;

  -- NOTHING ELSE MOVED. The eleven values that were already there are what other code switches
  -- on, and an enum is one of the few things in this schema that cannot be quietly reordered back.
  if (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'exception_type') <> 12 then
    raise exception '0291: the exception vocabulary is % values, not the twelve this leaves',
      (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
       where t.typname = 'exception_type');
  end if;

  -- Every migration after 0057 re-runs the scope assertions, including one that only adds an enum
  -- value. The guard does not make an exception for small files, and it is right not to.
  select string_agg(detail, chr(10) order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0291 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$verify_0291$;
