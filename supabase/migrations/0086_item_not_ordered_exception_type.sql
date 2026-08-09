-- Adds the exception_type value DEBT-REGISTER §17 planned: 'item_not_ordered'.
--
-- ALONE in its own migration on purpose, and §17 says why, with a measurement: a value added
-- and used inside the same transaction raises
--   ERROR: unsafe use of new value "item_not_ordered" of enum type exception_type
-- so the first consumer (open_manual_exception, 0087) lives one migration later.
--
-- What this deliberately does NOT do: it does not touch the live body of
-- apply_document_interpretation (0077), whose automatic path still opens 'receipt_mismatch'
-- with details.code='item_not_ordered'. That injection plus the p14 assertion update is §17's
-- remaining step and stays recorded there — replacing a literal inside a live financial
-- command is not a rider on an enum migration.
alter type exception_type add value if not exists 'item_not_ordered';

-- Re-assert the 0057 scope-enforcement invariants (DEBT-REGISTER §9: the block is remembered,
-- not structural — so every migration carries it explicitly).
do $reassert$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0086 scope enforcement assertions failed:\n%', v_violations;
  end if;
end
$reassert$;
