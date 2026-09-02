-- 0288 -- the automatic path stops filing "an item you did not order" under a borrowed name.
--
-- DEBT §17, and it is the last step of a job `0086` and `0087` already did most of.
--
-- When a person opens this exception by hand it is an `item_not_ordered`. When
-- `apply_document_interpretation` opens the very same exception on its own it has been writing
-- `receipt_mismatch` and hiding the real name in `details.code`. The reason is written into
-- `0077` and it was a good one at the time: the enum value did not exist, `alter type add value`
-- cannot be used in the transaction that adds it, and the Hebrew label lived in a file that task
-- did not own.
--
-- All three of those are gone. `0086` added the enum value in its own migration precisely so this
-- one could use it. `0087` gave it a title. `src/lib/status.ts:266` already maps
-- `item_not_ordered` to its own label and carries a note pointing at this injection as the
-- remaining work. The only thing left was the write itself.
--
-- WHY IT MATTERS AND IS NOT COSMETIC. Every screen and report that groups exceptions by type puts
-- the automatic ones in a different bucket from the identical manual ones, so the same event is
-- counted twice under two names and neither count is the truth. A manager filtering for
-- "פריט שלא הוזמן" does not see what the machine found.
--
-- ANCHORED, NOT REDECLARED. Only `0077` ever wrote this function's body; `0107`, `0120`, `0147`,
-- `0168`, `0182` and `0242` have each patched the live one since. Re-declaring from `0077` would
-- silently roll all six back -- the exact failure this repository has already paid for. So the
-- live body is read, one line is asserted to appear exactly once, and only that line changes.
--
-- `details.code` stays. It is the evidence three separate p14 assertions read, and dropping it
-- would trade one honest label for a lost one.

do $do_0288$
declare
  v_def     text;
  v_anchor  text;
  v_patched text;
  v_signature constant text := 'public.apply_document_interpretation(uuid,uuid,uuid)';
begin
  -- Normalised in the same breath as it is read. A body applied from Windows stores CRLF and one
  -- applied on CI stores LF; an anchor built against one matches only that one, and the gate only
  -- ever sees CI. `check:anchored-replacements` requires this exact shape for that reason.
  select replace(pg_get_functiondef(p.oid), e'\r', '') into v_def
  from pg_catalog.pg_proc p
  where p.oid = v_signature::regprocedure;
  if v_def is null then
    raise exception '0288: apply_document_interpretation not found';
  end if;

  v_anchor := replace($anchor$          v_org, 'receipt_mismatch', 'medium', 'open',$anchor$, e'\r', '');
  v_patched := replace($patched$          v_org, 'item_not_ordered', 'medium', 'open',$patched$, e'\r', '');
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0288: the exception-type anchor moved -- refusing to patch blindly';
  end if;
  v_def := replace(v_def, v_anchor, v_patched);

  execute v_def;
end
$do_0288$;

-- 0182 pins this function's body by hash in private.document_automation_authoritative_functions,
-- and private.document_automation_negative_guard_violations() reports any body that has drifted
-- from its pin. Patching the body without moving the pin is not a smaller change -- it is the
-- same change with the alarm still ringing, and P14 #20 rings it.
--
-- The hash is recomputed HERE, from the body this migration just wrote, rather than written in
-- as a literal. `md5(replace(prosrc, e'\r', ''))` is the shape 0242 established and it is immune to
-- the CRLF difference between a body applied from Windows and one applied on CI; a static hash
-- in this file would be correct on exactly one of those two machines.
update private.document_automation_authoritative_functions registry
set body_hash = md5(replace(proc.prosrc, e'\r', '')),
    responsibility = registry.responsibility
      || ' 0288: the automatic path raises item_not_ordered under its own name.'
from pg_proc proc
where proc.oid = 'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure
  and registry.function_signature = 'apply_document_interpretation(uuid,uuid,uuid)';

do $assert_0288$
declare
  v_body text;
  v_violations text;
begin
  select prosrc into v_body
  from pg_catalog.pg_proc
  where oid = 'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure;

  if position($needle$'item_not_ordered', 'medium', 'open'$needle$ in v_body) = 0 then
    raise exception '0288: the automatic path does not raise item_not_ordered after the patch';
  end if;
  -- The evidence key survives the rename; three p14 assertions read it.
  if position($needle$'code', 'item_not_ordered'$needle$ in v_body) = 0 then
    raise exception '0288: details.code was lost in the patch';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = 'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure
      and prosecdef
  ) then
    raise exception '0288: apply_document_interpretation lost SECURITY DEFINER';
  end if;

  -- The pin above must have landed, or the alarm 0182 installed is still ringing.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.document_automation_negative_guard_violations();
  if v_violations is not null then
    raise exception e'0288: the automation negative guard is not silent after the repin:\n%', v_violations;
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0288 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0288$;
