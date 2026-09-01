-- 0273 — one enum value, alone in its own file, and that is the entire point.
--
-- WHY THIS IS NOT PART OF `0272`. Postgres refuses to USE an enum value in the same transaction
-- that added it: `ERROR: unsafe use of new value "..." of enum type`. `0086` is the precedent and
-- it exists for exactly this reason. So the value lands here, and the scanner that opens exceptions
-- of this type comes after — a migration that added the value and opened an exception with it in
-- one file would fail on the second statement, every time, on every database.
--
-- WHAT IT MEANS. An expectation whose waiting window and grace period both passed with no matching
-- document is a finding, not an absence of one: a supplier invoice that never arrived is a month
-- about to close on an expense nobody recorded. Until now the exception vocabulary had ten values
-- and none of them could say it — the closest, `receipt_mismatch`, is about a document that DID
-- arrive and disagreed.

alter type exception_type add value if not exists 'expected_document_missing';

comment on type exception_type is
  'What kinds of thing can go wrong and be tracked as an exception. From 0273 the list can say '
  'that something EXPECTED never arrived, which is a finding rather than the absence of one — see '
  '0272 for the expectation and the occurrence it belongs to. Added in its own migration because '
  'a new enum value cannot be used in the transaction that created it.';

do $verify_0273$
declare
  v_violations text;
begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'exception_type' and e.enumlabel = 'expected_document_missing') then
    raise exception '0273: the exception type was not added';
  end if;

  -- NOTHING ELSE MOVED. The ten values that were already there are what other code switches on,
  -- and an enum is one of the few things in this schema that cannot be quietly reordered back.
  if (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'exception_type') <> 11 then
    raise exception '0273: the exception vocabulary is % values, not the eleven this leaves',
      (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
       where t.typname = 'exception_type');
  end if;

  -- Every migration after 0057 re-runs the scope assertions, including one that only adds an enum
  -- value. The guard does not make an exception for small files, and it is right not to: "this one
  -- is too small to matter" is how a policy or a definer function slips past a gate.
  select string_agg(detail, chr(10) order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0273 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$verify_0273$;
