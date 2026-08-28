-- 0230: 0227 intentionally changed apply_reviewed_document. The document-automation negative
-- guard pins authoritative bodies separately from A5, so its hash must move in the same campaign.

update private.document_automation_authoritative_functions registry
set body_hash = md5(replace(proc.prosrc, e'\r', '')),
    responsibility = registry.responsibility
      || ' 0230: currency is derived from immutable interpretation evidence and cannot be client-forced.'
from pg_proc proc
where proc.oid = 'public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)'::regprocedure
  and registry.function_signature = 'apply_reviewed_document(uuid,uuid,jsonb,uuid,text)';

do $assert_0230$
declare v_violations text;
begin
  if not exists (
    select 1 from private.document_automation_authoritative_functions registry
    join pg_proc proc on proc.oid = 'public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)'::regprocedure
    where registry.function_signature = 'apply_reviewed_document(uuid,uuid,jsonb,uuid,text)'
      and registry.body_hash = md5(replace(proc.prosrc, e'\r', ''))
  ) then
    raise exception '0230: apply_reviewed_document authoritative hash did not move';
  end if;
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.document_automation_negative_guard_violations();
  if v_violations is not null then
    raise exception e'0230 document automation guards failed:\n%', v_violations;
  end if;
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0230 scope failed:\n%', v_violations; end if;
end
$assert_0230$;
