-- 0242: two trusted-server invoice writers were the last intake paths that did not name money.
--
-- 0228 deliberately removed invoices.currency's temporary ILS default after the reviewed and
-- manual writers carried currency. The consolidated writer, introduced by 0137, was missed: a
-- clean SQL gate caught its NOT NULL failure. This patch resolves currency from the immutable
-- interpretation with the same private resolver as ordinary document intake, requires every page
-- in the packet to agree, rounds by minor_units, scopes duplicate detection to that currency, and
-- records the currency on the invoice, result and audit fact. It performs no FX conversion.

do $patch_consolidated_currency_0242$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.apply_consolidated_invoice_interpretation(uuid,uuid,uuid)'::regprocedure), e'\r', '');
  v_anchor text;
  v_replacement text;
  v_count integer;
begin
  v_anchor := e'  v_total numeric;\n  v_block_code text;';
  v_replacement := e'  v_total numeric;\n  v_currency_resolution jsonb;\n'
    || e'  v_page_currency_resolution jsonb;\n  v_currency text;\n'
    || e'  v_minor_units smallint;\n  v_block_code text;';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: declaration anchor count %', v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := $anchor$
  v_total := private.interpretation_number(private.interpretation_field(v_payload,array[
    'total','total_amount','grand_total','amount_due','סכום כולל','סה"כ לתשלום']));
  if v_payload ->> 'document_type' <> 'invoice'$anchor$;
  v_replacement := $replacement$
  v_total := private.interpretation_number(private.interpretation_field(v_payload,array[
    'total','total_amount','grand_total','amount_due','סכום כולל','סה"כ לתשלום']));

  v_currency_resolution := private.resolve_document_currency(
    v_case.org_id,v_case.supplier_id,v_payload);
  v_currency := v_currency_resolution->>'currency';
  select currency.minor_units into v_minor_units
  from public.currencies currency where currency.code=v_currency and currency.active;
  if v_currency_resolution->>'status'='unrecognised'
     or v_currency is null or v_minor_units is null then
    v_block_code := 'consolidated_currency_unrecognised';
  else
    -- A consolidated invoice is one document split into pages. A page that states a different
    -- currency cannot be folded into the anchor merely because its header is not the primary one.
    for v_page_payload in
      select distinct on (page.page_number)
        page.page_number,interpretation.payload
      from public.consolidated_invoice_intake_pages page
      join lateral (
        select job.* from public.document_processing_jobs job
        where job.org_id=page.org_id and job.document_id=page.document_id
          and job.status<>'failed'
        order by job.created_at desc,job.id desc limit 1
      ) current_job on true
      join public.document_interpretations interpretation
        on interpretation.org_id=current_job.org_id and interpretation.job_id=current_job.id
        and interpretation.document_id=page.document_id
      join public.profiles evidence_actor
        on evidence_actor.org_id=interpretation.org_id
        and evidence_actor.id=interpretation.interpreted_for_user_id
      where page.org_id=v_intake.org_id and page.intake_id=v_intake.id
        and current_job.interpretation_actor_id=interpretation.interpreted_for_user_id
      order by page.page_number
    loop
      v_page_currency_resolution := private.resolve_document_currency(
        v_case.org_id,v_case.supplier_id,v_page_payload.payload);
      if v_page_currency_resolution->>'status'='unrecognised'
         or v_page_currency_resolution->>'currency' is distinct from v_currency then
        v_block_code := 'consolidated_currency_mismatch';
        exit;
      end if;
    end loop;
  end if;

  if v_block_code is not null then
    null;
  elsif v_payload ->> 'document_type' <> 'invoice'$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: resolver anchor count %', v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := '     or round(v_before,2) + round(v_vat,2) <> round(v_total,2) then';
  v_replacement := '     or round(v_before,v_minor_units) + round(v_vat,v_minor_units) '
    || '<> round(v_total,v_minor_units) then';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: precision anchor count %', v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := e'      and duplicate.deleted_at is null\n'
    || '      and private.document_text_key(duplicate.invoice_number) = v_number_key';
  v_replacement := e'      and duplicate.deleted_at is null\n'
    || e'      and duplicate.currency = v_currency\n'
    || '      and private.document_text_key(duplicate.invoice_number) = v_number_key';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: duplicate anchor count %', v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := $anchor$
    received_by,amount_before_vat,vat_amount,total_amount,review_status,financial_role,notes
  ) values ($anchor$;
  v_replacement := $replacement$
    received_by,amount_before_vat,vat_amount,total_amount,review_status,financial_role,notes,currency
  ) values ($replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: insert columns anchor count %', v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := $anchor$
    null,round(v_before,2),round(v_vat,2),round(v_total,2),'received','payable',
    'חשבונית מרכזת; intake ' || v_intake.id::text
  );$anchor$;
  v_replacement := $replacement$
    null,round(v_before,v_minor_units),round(v_vat,v_minor_units),
    round(v_total,v_minor_units),'received','payable',
    'חשבונית מרכזת; intake ' || v_intake.id::text,v_currency
  );$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: insert values anchor count %', v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := e'      ''interpretation_id'',v_interpretation.id,''supplier_id'',v_case.supplier_id,\n'
    || '      ''target_month'',v_case.target_month,''legal_entity_id'',v_case.legal_entity_id,';
  v_replacement := e'      ''interpretation_id'',v_interpretation.id,''supplier_id'',v_case.supplier_id,\n'
    || e'      ''currency'',v_currency,\n'
    || '      ''target_month'',v_case.target_month,''legal_entity_id'',v_case.legal_entity_id,';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: audit anchor count %', v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := e'    ''invoice_id'',v_invoice_id,''revision_id'',(v_revision->>''revision_id'')::uuid,\n'
    || '    ''warnings'',coalesce(v_snapshot_payload->''warnings'',''[]''::jsonb),''idempotent'',false';
  v_replacement := e'    ''invoice_id'',v_invoice_id,''revision_id'',(v_revision->>''revision_id'')::uuid,\n'
    || e'    ''currency'',v_currency,\n'
    || '    ''warnings'',coalesce(v_snapshot_payload->''warnings'',''[]''::jsonb),''idempotent'',false';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: result anchor count %', v_count; end if;

  execute replace(v_definition,v_anchor,v_replacement);
end
$patch_consolidated_currency_0242$;

-- The autonomous writer is a second trusted-server invoice path. It must carry the same evidence
-- currency and must scope duplicate/allocation checks to that currency before writing anything.
do $patch_auto_currency_0242$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure), e'\r', '');
  v_anchor text;
  v_replacement text;
  v_count integer;
begin
  v_anchor := e'  v_vat             numeric;\n  v_order_number';
  v_replacement := e'  v_vat             numeric;\n  v_currency_resolution jsonb;\n'
    || e'  v_currency        text;\n  v_minor_units     smallint;\n  v_order_number';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: auto declaration anchor count %',v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := $anchor$
  v_vat := private.interpretation_number(
    private.interpretation_field(v_payload, array[
      'vat_amount', 'vat', 'tax_amount', 'מעמ', 'מע"מ']));

  select status into v_org_status from public.organizations where id = v_org;$anchor$;
  v_replacement := $replacement$
  v_vat := private.interpretation_number(
    private.interpretation_field(v_payload, array[
      'vat_amount', 'vat', 'tax_amount', 'מעמ', 'מע"מ']));
  v_currency_resolution := private.resolve_document_currency(v_org,v_supplier_id,v_payload);
  v_currency := v_currency_resolution->>'currency';
  select currency.minor_units into v_minor_units
  from public.currencies currency where currency.code=v_currency and currency.active;

  select status into v_org_status from public.organizations where id = v_org;$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: auto resolver anchor count %',v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := $anchor$
    v_outcome := 'queued_for_review'; v_reason_code := 'supplier_unidentified';
  elsif v_number is null or v_date is null then$anchor$;
  v_replacement := $replacement$
    v_outcome := 'queued_for_review'; v_reason_code := 'supplier_unidentified';
  elsif v_currency_resolution->>'status'='unrecognised'
        or v_currency is null or v_minor_units is null then
    v_outcome := 'queued_for_review'; v_reason_code := 'currency_unrecognised';
  elsif v_number is null or v_date is null then$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: auto refusal anchor count %',v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := '        or round(v_before, 2) + round(v_vat, 2) <> round(v_total, 2) then';
  v_replacement := '        or round(v_before,v_minor_units) + round(v_vat,v_minor_units) '
    || '<> round(v_total,v_minor_units) then';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: auto precision anchor count %',v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := e'    where i.org_id = v_org and i.supplier_id = v_supplier_id\n'
    || '      and private.document_text_key(i.invoice_number) = v_number_key';
  v_replacement := e'    where i.org_id = v_org and i.supplier_id = v_supplier_id\n'
    || e'      and i.currency = v_currency\n'
    || '      and private.document_text_key(i.invoice_number) = v_number_key';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 2 then raise exception '0242: auto duplicate anchors count %',v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := $anchor$
    'min_confidence', to_jsonb(v_policy.min_confidence),
    'reason_code', to_jsonb(v_reason_code));$anchor$;
  v_replacement := $replacement$
    'min_confidence', to_jsonb(v_policy.min_confidence),
    'currency', to_jsonb(v_currency),
    'reason_code', to_jsonb(v_reason_code));$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: auto decision anchor count %',v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := $anchor$
      received_by, amount_before_vat, vat_amount, total_amount, review_status, notes
    ) values ($anchor$;
  v_replacement := $replacement$
      received_by, amount_before_vat, vat_amount, total_amount, review_status, notes, currency
    ) values ($replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: auto insert columns anchor count %',v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := $anchor$
      null, round(v_before, 2), round(v_vat, 2), round(v_total, 2),$anchor$;
  v_replacement := $replacement$
      null, round(v_before,v_minor_units), round(v_vat,v_minor_units),
      round(v_total,v_minor_units),$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: auto insert amounts anchor count %',v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := $anchor$      'נוצר אוטומטית מפירוש מסמך ' || v_i.id::text);$anchor$;
  v_replacement := $replacement$      'נוצר אוטומטית מפירוש מסמך ' || v_i.id::text, v_currency);$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: auto insert currency anchor count %',v_count; end if;
  v_definition := replace(v_definition,v_anchor,v_replacement);

  v_anchor := $anchor$
        'total_amount', round(v_total, 2),
        'document_id', v_doc.id,$anchor$;
  v_replacement := $replacement$
        'total_amount', round(v_total,v_minor_units),
        'currency', v_currency,
        'document_id', v_doc.id,$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0242: auto audit anchor count %',v_count; end if;

  execute replace(v_definition,v_anchor,v_replacement);
end
$patch_auto_currency_0242$;

update private.scope_definer_exemptions
set reason='service-role-trusted-path; 0242 binds every automatic invoice write and duplicate check to evidence currency'
where function_signature in (
  'apply_consolidated_invoice_interpretation(uuid,uuid,uuid)',
  'apply_document_interpretation(uuid,uuid,uuid)');

do $assert_0242$
declare v_body text; v_auto_body text; v_violations text;
begin
  select replace(prosrc,e'\r','') into v_body from pg_proc
  where oid='public.apply_consolidated_invoice_interpretation(uuid,uuid,uuid)'::regprocedure;
  if position('private.resolve_document_currency' in v_body)=0
     or position('consolidated_currency_mismatch' in v_body)=0
     or position('duplicate.currency = v_currency' in v_body)=0
     or position('notes,currency' in v_body)=0 then
    raise exception '0242: consolidated currency contract is incomplete';
  end if;
  select replace(prosrc,e'\r','') into v_auto_body from pg_proc
  where oid='public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure;
  if position('private.resolve_document_currency' in v_auto_body)=0
     or position('currency_unrecognised' in v_auto_body)=0
     or position('i.currency = v_currency' in v_auto_body)=0
     or position('notes, currency' in v_auto_body)=0 then
    raise exception '0242: autonomous currency contract is incomplete';
  end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0242 scope failed:\n%',v_violations; end if;
  select string_agg(detail,e'\n' order by detail) into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0242 export failed:\n%',v_violations; end if;
end
$assert_0242$;
