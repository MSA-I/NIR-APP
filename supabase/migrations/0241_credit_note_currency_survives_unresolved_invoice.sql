-- 0241: a credit note whose source invoice is unresolved still has a currency answer. It uses the
-- evidence/supplier resolver so the command can report the real credit-resolution blocker; once an
-- invoice is resolved, that invoice's currency remains authoritative.

do $patch_credit_currency_0241$
declare
  v_definition text:=replace(pg_get_functiondef(
    'public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)'::regprocedure),e'\r','');
  v_anchor text:=$anchor$
  if v_document_type = 'credit_note'
     and coalesce((v_credit_resolution ->> 'resolved')::boolean, false) then
    select invoice.currency into v_credit_currency
    from public.invoices invoice
    where invoice.org_id = v_org and invoice.id = (v_credit_resolution ->> 'invoice_id')::uuid;
    v_currency := v_credit_currency;
    v_assessment := v_assessment || jsonb_build_object('currency', v_currency);
  else
    v_currency := v_assessment ->> 'currency';
  end if;$anchor$;
  v_replacement text:=$replacement$
  if v_document_type = 'credit_note' then
    if coalesce((v_credit_resolution ->> 'resolved')::boolean, false) then
      select invoice.currency into v_credit_currency
      from public.invoices invoice
      where invoice.org_id = v_org and invoice.id = (v_credit_resolution ->> 'invoice_id')::uuid;
      v_currency := v_credit_currency;
    else
      v_currency := private.resolve_document_currency(
        v_org,v_supplier_id,v_interpretation.payload) ->> 'currency';
    end if;
    v_assessment := v_assessment || jsonb_build_object('currency', v_currency);
  else
    v_currency := v_assessment ->> 'currency';
  end if;$replacement$;
  v_count integer;
begin
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0241: credit currency anchor count %',v_count; end if;
  execute replace(v_definition,v_anchor,v_replacement);
end
$patch_credit_currency_0241$;

update private.scope_definer_enforcements enforcement
set body_hash=md5(replace(proc.prosrc,e'\r','')),
    scope_proof='0241 resolves currency for an unresolved credit note without changing tenant, role, document or unit fences.'
from pg_proc proc
where proc.oid='public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)'::regprocedure
  and enforcement.function_signature='apply_reviewed_document(uuid,uuid,jsonb,uuid,text)';

update private.document_automation_authoritative_functions registry
set body_hash=md5(replace(proc.prosrc,e'\r','')),
    responsibility=registry.responsibility||' 0241: unresolved credit notes retain evidence/supplier currency.'
from pg_proc proc
where proc.oid='public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)'::regprocedure
  and registry.function_signature='apply_reviewed_document(uuid,uuid,jsonb,uuid,text)';

do $assert_0241$
declare v_violations text;
begin
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.document_automation_negative_guard_violations();
  if v_violations is not null then raise exception e'0241 automation failed:\n%',v_violations; end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0241 scope failed:\n%',v_violations; end if;
end
$assert_0241$;
