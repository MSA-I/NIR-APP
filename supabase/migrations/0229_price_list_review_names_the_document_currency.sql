-- 0229: the two price-list review read models name the currency of every price they return.
-- The source is the immutable interpretation plus the same 0227 resolver used by invoice review.

do $patch_dry_run_0229$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.get_qualified_product_creation_dry_run(uuid)'::regprocedure), e'\r', '');
  v_anchor text;
  v_replacement text;
  v_count integer;
begin
  v_anchor := e'  v_missing integer:=0; v_invalid integer:=0;';
  v_replacement := e'  v_missing integer:=0; v_invalid integer:=0;\n'
    || e'  v_currency text; v_minor_units smallint;';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0229: dry-run declaration anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
  if jsonb_typeof(v_interpretation.payload->'line_items')<>'array' then
    raise exception 'document_interpretation_invalid' using errcode='22023';
  end if;$anchor$;
  v_replacement := $replacement$
  v_currency := private.resolve_document_currency(
    v_org, v_document.supplier_id, v_interpretation.payload) ->> 'currency';
  select currency.minor_units into v_minor_units
  from public.currencies currency where currency.code=v_currency and currency.active;
  if v_currency is null or v_minor_units is null then
    raise exception 'price_list_currency_unrecognised' using errcode='22023';
  end if;
  if jsonb_typeof(v_interpretation.payload->'line_items')<>'array' then
    raise exception 'document_interpretation_invalid' using errcode='22023';
  end if;$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0229: dry-run context anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$v_price_text:=regexp_replace(btrim(coalesce(v_values->>'unit_price','')),'[[:space:]₪,]','','g');$anchor$;
  v_replacement := $replacement$v_price_text:=regexp_replace(btrim(coalesce(v_values->>'unit_price','')),'[^0-9.]','','g');$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0229: dry-run numeric parser anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := 'v_price:=round(v_price_text::numeric,2);';
  v_replacement := 'v_price:=round(v_price_text::numeric,v_minor_units);';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0229: dry-run rounding anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
  return jsonb_build_object('interpretation_id',v_interpretation.id,'supplier_id',v_document.supplier_id,
    'qualified_create_count',v_qualified$anchor$;
  v_replacement := $replacement$
  return jsonb_build_object('interpretation_id',v_interpretation.id,'supplier_id',v_document.supplier_id,
    'currency',v_currency,'qualified_create_count',v_qualified$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0229: dry-run return anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_dry_run_0229$;

do $patch_queue_0229$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure),
    e'\r', '');
  v_anchor text;
  v_replacement text;
  v_count integer;
begin
  v_anchor := 'pending_total_count bigint)';
  v_replacement := 'pending_total_count bigint, currency text)';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0229: queue return shape anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
      run.supplier_id as run_supplier_id,supplier.name as run_supplier_name,
      line.line_index as pending_line_index$anchor$;
  v_replacement := $replacement$
      run.supplier_id as run_supplier_id,supplier.name as run_supplier_name,
      private.resolve_document_currency(run.org_id,run.supplier_id,interpretation.payload)
        ->>'currency' as pending_currency,
      line.line_index as pending_line_index$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0229: queue pending currency anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
    join public.documents document on document.org_id=run.org_id and document.id=run.document_id
      and document.deleted_at is null$anchor$;
  v_replacement := $replacement$
    join public.documents document on document.org_id=run.org_id and document.id=run.document_id
      and document.deleted_at is null$replacement$
    || e'\n    join public.document_interpretations interpretation'
    || e' on interpretation.org_id=run.org_id and interpretation.id=run.interpretation_id';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0229: queue interpretation join anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
    pending.pending_product_name,pending.pending_unit,pending.pending_proposed_unit_price,
    pending.pending_current_unit_price,count(*) over ()$anchor$;
  v_replacement := $replacement$
    pending.pending_product_name,pending.pending_unit,pending.pending_proposed_unit_price,
    pending.pending_current_unit_price,count(*) over (),pending.pending_currency$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0229: queue output currency anchor count %', v_count; end if;

  execute 'drop function public.get_price_list_calibration_preparation_queue(uuid,integer,integer)';
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_queue_0229$;

revoke all on function public.get_price_list_calibration_preparation_queue(uuid,integer,integer)
  from public,anon,service_role;
grant execute on function public.get_price_list_calibration_preparation_queue(uuid,integer,integer)
  to authenticated;

update private.scope_definer_enforcements enforcement
set body_hash=md5(replace(proc.prosrc,e'\r','')),
    scope_proof=case enforcement.function_signature
      when 'get_qualified_product_creation_dry_run(uuid)'
        then '0229 adds evidence currency and minor-unit parsing; the org, actor, role and document scope checks remain.'
      else '0229 adds the interpretation join and evidence currency; the org, role and auth_scopes filters remain.'
    end
from pg_proc proc
where (proc.oid='public.get_qualified_product_creation_dry_run(uuid)'::regprocedure
       and enforcement.function_signature='get_qualified_product_creation_dry_run(uuid)')
   or (proc.oid='public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure
       and enforcement.function_signature='get_price_list_calibration_preparation_queue(uuid,integer,integer)');

do $assert_0229$
declare v_violations text;
begin
  if position('''currency'',v_currency' in (select prosrc from pg_proc where oid=
       'public.get_qualified_product_creation_dry_run(uuid)'::regprocedure))=0 then
    raise exception '0229: dry run does not return currency';
  end if;
  if position('pending_currency' in (select prosrc from pg_proc where oid=
       'public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure))=0 then
    raise exception '0229: calibration queue does not return currency';
  end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0229 scope assertions failed:\n%',v_violations; end if;
end
$assert_0229$;
