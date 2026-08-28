-- 0227: document intake carries the currency the evidence states.
--
-- No conversion exists here. The resolver translates only printed symbols/aliases into an active
-- ISO code, or falls back to the supplier default when the paper is silent. An unreadable token
-- remains a blocking finding. `apply_reviewed_document` rebuilds that answer from the immutable
-- interpretation; a browser may echo the answer but cannot replace it.

create or replace function private.resolve_document_currency(
  p_org_id uuid,
  p_supplier_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_printed text := nullif(btrim(
    private.interpretation_field(p_payload, array['currency', 'מטבע']) #>> '{}'), '');
  v_token text := upper(v_printed);
  v_currency text;
  v_base_currency text;
  v_supplier_default text;
  v_needs_confirmation boolean := false;
begin
  if p_org_id is null then
    raise exception 'document_currency_requires_org' using errcode = '22023';
  end if;

  select organization.base_currency into v_base_currency
  from public.organizations organization where organization.id = p_org_id;
  if v_base_currency is null then
    raise exception 'document_currency_org_unknown' using errcode = 'P0002';
  end if;

  if p_supplier_id is not null then
    select supplier.default_currency into v_supplier_default
    from public.suppliers supplier
    where supplier.org_id = p_org_id and supplier.id = p_supplier_id
      and supplier.deleted_at is null;
  end if;

  if v_printed is null then
    v_currency := coalesce(v_supplier_default, v_base_currency);
    v_needs_confirmation := p_supplier_id is not null and (
      v_currency <> v_base_currency
      or exists (
        select 1 from public.invoices invoice
        where invoice.org_id = p_org_id and invoice.supplier_id = p_supplier_id
          and invoice.deleted_at is null and invoice.currency <> v_base_currency));
    return jsonb_build_object(
      'status', case when v_needs_confirmation then 'assumed' else 'resolved' end,
      'currency', v_currency,
      'printed_currency', null,
      'assumed_from_supplier', v_needs_confirmation);
  end if;

  v_currency := case v_token
    when '₪' then 'ILS'
    when 'ILS' then 'ILS'
    when 'NIS' then 'ILS'
    when 'ש"ח' then 'ILS'
    when 'שח' then 'ILS'
    when '$' then 'USD'
    when '€' then 'EUR'
    when '£' then 'GBP'
    else v_token
  end;

  if v_currency !~ '^[A-Z]{3}$' or not exists (
    select 1 from public.currencies currency
    where currency.code = v_currency and currency.active
  ) then
    return jsonb_build_object(
      'status', 'unrecognised',
      'currency', null,
      'printed_currency', v_printed,
      'assumed_from_supplier', false);
  end if;

  return jsonb_build_object(
    'status', 'resolved',
    'currency', v_currency,
    'printed_currency', v_printed,
    'assumed_from_supplier', false);
end
$$;

revoke all on function private.resolve_document_currency(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

comment on function private.resolve_document_currency(uuid, uuid, jsonb) is
  'Resolves one document currency from immutable interpretation evidence (0227). A missing token '
  'may use the supplier default; an unreadable token never becomes ILS. No FX conversion occurs.';

-- The contractual price baseline names its own currency. Without this, assessment could compare
-- a USD document against an ILS catalogue and call the smaller number cheaper.
do $patch_price_baseline_0227$
declare
  v_definition text := replace(pg_get_functiondef(
    'private.supplier_price_effective_on(uuid,uuid,uuid,date)'::regprocedure), e'\r', '');
  v_anchor text;
  v_replacement text;
  v_count integer;
begin
  v_anchor := 'select sp.id, sp.current_price, sp.package_size, sp.available, sp.price_effective_date';
  v_replacement := 'select sp.id, sp.current_price, sp.package_size, sp.available, '
    || 'sp.price_effective_date, sp.currency';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: supplier baseline head anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := 'select h.id, h.price, h.effective_date';
  v_replacement := 'select h.id, h.price, h.effective_date, h.currency';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 2 then raise exception '0227: supplier baseline history anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := '''baseline_price'', v_hist.price,';
  v_replacement := v_anchor || e'\n        ''currency'', v_hist.currency,';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 2 then raise exception '0227: supplier baseline JSON history anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := '''baseline_price'', v_sp.current_price,';
  v_replacement := v_anchor || e'\n    ''currency'', v_sp.currency,';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: supplier baseline JSON current anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_price_baseline_0227$;

-- Patch the live assessment by exact anchors. Restating its 472 lines would risk dropping one of
-- the four-source comparisons; each changed clause must occur exactly once.
do $patch_assessment_0227$
declare
  v_definition text := replace(pg_get_functiondef(
    'private.document_reconciliation_assessment(uuid,text,uuid,uuid,jsonb,date)'::regprocedure), e'\r', '');
  v_anchor text;
  v_replacement text;
  v_count integer;
begin
  v_anchor := e'  v_currency text;\n  v_header_net numeric;';
  v_replacement := e'  v_currency text;\n  v_currency_resolution jsonb;\n'
    || e'  v_org_country text;\n  v_supplier_country text;\n  v_minor_units smallint;\n'
    || e'  v_line_tolerance numeric;\n  v_document_tolerance numeric;\n  v_header_net numeric;';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: assessment declaration anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
  v_currency := upper(nullif(btrim(
    private.interpretation_field(p_payload, array['currency', 'מטבע']) #>> '{}'), ''));

  select organization.vat_rate into v_org_vat_rate
  from public.organizations organization where organization.id = p_org_id;

  -- 0001 fixes this product to shekels and there is no currency column anywhere. A document
  -- printing another currency must reach a person, because recording its numbers as shekels is
  -- silent and expensive.
  if v_currency is not null and v_currency not in ('ILS', 'NIS', '₪', 'ש"ח', 'שח') then
    v_blocked := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'currency_not_ils', 'severity', 'error', 'printed_currency', v_currency,
      'message', 'המסמך מודפס במטבע שאינו שקל — המערכת רושמת שקלים בלבד'));
  end if;$anchor$;
  v_replacement := $replacement$
  v_currency_resolution := private.resolve_document_currency(p_org_id, p_supplier_id, p_payload);
  v_currency := v_currency_resolution ->> 'currency';

  select organization.vat_rate, organization.country_code
    into v_org_vat_rate, v_org_country
  from public.organizations organization where organization.id = p_org_id;
  select supplier.country_code into v_supplier_country
  from public.suppliers supplier
  where supplier.org_id = p_org_id and supplier.id = p_supplier_id
    and supplier.deleted_at is null;

  if v_currency_resolution ->> 'status' = 'unrecognised' then
    v_blocked := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'currency_unrecognised', 'severity', 'error',
      'printed_currency', v_currency_resolution ->> 'printed_currency',
      'message', 'לא ניתן לזהות את המטבע שהודפס במסמך — נדרש קוד ISO תקף'));
  elsif coalesce((v_currency_resolution ->> 'assumed_from_supplier')::boolean, false) then
    v_warning := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'currency_assumed_from_supplier', 'severity', 'warning',
      'currency', v_currency,
      'message', 'המטבע לא הודפס בבירור ונלקח מברירת המחדל של הספק'));
  end if;

  select currency.minor_units into v_minor_units
  from public.currencies currency where currency.code = v_currency and currency.active;
  v_minor_units := coalesce(v_minor_units, 2);
  v_line_tolerance := coalesce(
    private.money_tolerance(p_org_id, v_currency, 'invoice_line_amount_tolerance'),
    case when v_currency = 'ILS' then 0.05 end);
  v_document_tolerance := coalesce(
    private.money_tolerance(p_org_id, v_currency, 'invoice_document_amount_tolerance'),
    case when v_currency = 'ILS' then 1 end);
$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: assessment currency block anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'         and existing.deleted_at is null\n'
    || '         and private.document_text_key(existing.invoice_number) = v_number_key';
  v_replacement := e'         and existing.deleted_at is null\n'
    || e'         and existing.currency = v_currency\n'
    || '         and private.document_text_key(existing.invoice_number) = v_number_key';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: assessment duplicate anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := 'select po.id, po.supplier_id, po.status, po.number';
  v_replacement := 'select po.id, po.supplier_id, po.status, po.number, po.currency';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: assessment order select anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
      if p_supplier_id is not null and v_order.supplier_id <> p_supplier_id then
        -- The document was attached to an order belonging to a different supplier. Every
        -- quantity and price comparison below would be against the wrong contract.
        v_blocked := true;
        v_has_order := false;
        v_findings := v_findings || jsonb_build_array(jsonb_build_object(
          'code', 'supplier_mismatch', 'severity', 'error',
          'order_supplier_id', v_order.supplier_id, 'document_supplier_id', p_supplier_id,
          'message', 'ההזמנה שייכת לספק אחר מזה שעל המסמך'));
      end if;$anchor$;
  v_replacement := $replacement$
      if p_supplier_id is not null and v_order.supplier_id <> p_supplier_id then
        v_blocked := true;
        v_has_order := false;
        v_findings := v_findings || jsonb_build_array(jsonb_build_object(
          'code', 'supplier_mismatch', 'severity', 'error',
          'order_supplier_id', v_order.supplier_id, 'document_supplier_id', p_supplier_id,
          'message', 'ההזמנה שייכת לספק אחר מזה שעל המסמך'));
      elsif v_currency is not null and v_order.currency <> v_currency then
        v_blocked := true;
        v_has_order := false;
        v_findings := v_findings || jsonb_build_array(jsonb_build_object(
          'code', 'document_order_currency_mismatch', 'severity', 'error',
          'order_currency', v_order.currency, 'document_currency', v_currency,
          'message', 'מטבע המסמך שונה ממטבע ההזמנה ולכן אי אפשר להשוות ביניהם'));
      end if;$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: assessment order guard anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
    -- Arithmetic on the page, before any comparison to our records. ₪0.05 is 0099's line
    -- tolerance, and anchor (c) keeps it that way.
    if v_quantity is not null and v_unit_price is not null and v_line_total is not null then
      v_expected_total := round(
        (v_quantity * v_unit_price) - coalesce((v_line ->> 'discount_amount')::numeric, 0), 2);
      if abs(v_line_total - v_expected_total) > 0.05 then
        v_blocked := true;
        v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
          'code', 'line_arithmetic_discrepancy', 'severity', 'error',
          'expected', v_expected_total, 'actual', v_line_total, 'tolerance', 0.05,
          'message', 'סכום השורה אינו שווה לכמות × מחיר פחות ההנחה'));
      end if;
      v_lines_net := v_lines_net + v_line_total;
    end if;$anchor$;
  v_replacement := $replacement$
    if v_quantity is not null and v_unit_price is not null and v_line_total is not null then
      v_expected_total := round(
        (v_quantity * v_unit_price) - coalesce((v_line ->> 'discount_amount')::numeric, 0),
        v_minor_units);
      if v_line_tolerance is not null
         and abs(v_line_total - v_expected_total) > v_line_tolerance then
        v_blocked := true;
        v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
          'code', 'line_arithmetic_discrepancy', 'severity', 'error',
          'expected', v_expected_total, 'actual', v_line_total,
          'tolerance', v_line_tolerance,
          'message', 'סכום השורה אינו שווה לכמות × מחיר פחות ההנחה'));
      end if;
      v_lines_net := v_lines_net + v_line_total;
    end if;$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: assessment line arithmetic anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'    if (v_line ->> ''vat_rate'') is not null and v_org_vat_rate is not null\n'
    || '       and (v_line ->> ''vat_rate'')::numeric <> v_org_vat_rate then';
  v_replacement := e'    if (v_line ->> ''vat_rate'') is not null and v_org_vat_rate is not null\n'
    || e'       and v_org_country is not null and v_supplier_country = v_org_country\n'
    || '       and (v_line ->> ''vat_rate'')::numeric <> v_org_vat_rate then';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: assessment VAT anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
      if v_baseline ->> 'status' = 'resolved' then
        v_has_baseline := true;
        v_baseline_price := (v_baseline ->> 'baseline_price')::numeric;
      else
        v_warning := true;
        v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
          'code', 'price_baseline_unknown', 'severity', 'warning',
          'reason', v_baseline ->> 'reason',
          'message', 'אין מחיר מוסכם להשוואה עבור המוצר הזה'));
      end if;$anchor$;
  v_replacement := $replacement$
      if v_baseline ->> 'status' = 'resolved'
         and v_baseline ->> 'currency' = v_currency then
        v_has_baseline := true;
        v_baseline_price := (v_baseline ->> 'baseline_price')::numeric;
      elsif v_baseline ->> 'status' = 'resolved' then
        v_warning := true;
        v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
          'code', 'price_baseline_currency_mismatch', 'severity', 'warning',
          'baseline_currency', v_baseline ->> 'currency', 'document_currency', v_currency,
          'message', 'המחיר המוסכם שמור במטבע אחר ולכן לא בוצעה השוואת מחיר'));
      else
        v_warning := true;
        v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
          'code', 'price_baseline_unknown', 'severity', 'warning',
          'reason', v_baseline ->> 'reason',
          'message', 'אין מחיר מוסכם להשוואה עבור המוצר הזה'));
      end if;$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: assessment baseline anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
  -- ---- Header against the lines. ₪1 is 0099's document tolerance.
  if v_header_net is not null and jsonb_array_length(v_line_rows) > 0
     and abs(v_lines_net - v_header_net) > 1 then
    v_blocked := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'header_total_differs_from_lines', 'severity', 'error',
      'lines_total', round(v_lines_net, 2), 'header_total', v_header_net, 'tolerance', 1,
      'message', 'סה"כ שבכותרת אינו שווה לסכום השורות'));
  end if;
  if v_header_net is not null and v_header_vat is not null and v_header_total is not null
     and abs((v_header_net + v_header_vat) - v_header_total) > 1 then
    v_blocked := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'header_arithmetic_discrepancy', 'severity', 'error',
      'header_net', v_header_net, 'header_vat', v_header_vat, 'header_total', v_header_total,
      'tolerance', 1, 'message', 'סה"כ לפני מע"מ ועוד מע"מ אינם שווים לסה"כ לתשלום'));
  end if;$anchor$;
  v_replacement := $replacement$
  if v_document_tolerance is not null and v_header_net is not null
     and jsonb_array_length(v_line_rows) > 0
     and abs(v_lines_net - v_header_net) > v_document_tolerance then
    v_blocked := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'header_total_differs_from_lines', 'severity', 'error',
      'lines_total', round(v_lines_net, v_minor_units), 'header_total', v_header_net,
      'tolerance', v_document_tolerance,
      'message', 'סה"כ שבכותרת אינו שווה לסכום השורות'));
  end if;
  if v_document_tolerance is not null and v_header_net is not null
     and v_header_vat is not null and v_header_total is not null
     and abs((v_header_net + v_header_vat) - v_header_total) > v_document_tolerance then
    v_blocked := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'header_arithmetic_discrepancy', 'severity', 'error',
      'header_net', v_header_net, 'header_vat', v_header_vat, 'header_total', v_header_total,
      'tolerance', v_document_tolerance,
      'message', 'סה"כ לפני מע"מ ועוד מע"מ אינם שווים לסה"כ לתשלום'));
  end if;$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: assessment header arithmetic anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := '''overcharge_amount'', round(v_overcharge_total, 2),';
  v_replacement := '''overcharge_amount'', round(v_overcharge_total, v_minor_units),';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: assessment credit total anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'    ''document_type'', p_document_type,\n    ''document_number'', v_number,';
  v_replacement := e'    ''document_type'', p_document_type,\n    ''currency'', v_currency,\n'
    || '    ''document_number'', v_number,';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: assessment return currency anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
      'lines_net', case when jsonb_array_length(v_line_rows) > 0
                        then round(v_lines_net, 2) else null end,
      'header_net', v_header_net,
      'header_vat', v_header_vat,
      'header_total', v_header_total,
      'overcharge_total', round(v_overcharge_total, 2),
      'line_tolerance', 0.05,
      'document_tolerance', 1)$anchor$;
  v_replacement := $replacement$
      'lines_net', case when jsonb_array_length(v_line_rows) > 0
                        then round(v_lines_net, v_minor_units) else null end,
      'header_net', v_header_net,
      'header_vat', v_header_vat,
      'header_total', v_header_total,
      'overcharge_total', round(v_overcharge_total, v_minor_units),
      'line_tolerance', v_line_tolerance,
      'document_tolerance', v_document_tolerance)$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: assessment totals return anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_assessment_0227$;

-- The command rebuilds currency from immutable interpretation evidence and writes that answer.
do $patch_apply_0227$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)'::regprocedure), e'\r', '');
  v_anchor text;
  v_replacement text;
  v_count integer;
begin
  v_anchor := e'  v_batch_id uuid;\n  v_net numeric;';
  v_replacement := e'  v_batch_id uuid;\n  v_currency text;\n  v_minor_units smallint;\n'
    || e'  v_credit_currency text;\n  v_net numeric;';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: apply declaration anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := '(''currency'', p_reviewed ->> ''currency'')';
  v_replacement := '(''currency'', private.interpretation_field('
    || 'v_interpretation.payload, array[''currency'', ''מטבע'']) #>> ''{}'')';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: apply evidence currency anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'  if (v_assessment ->> ''approval_blocked'')::boolean then';
  v_replacement := $replacement$
  if v_document_type = 'credit_note'
     and coalesce((v_credit_resolution ->> 'resolved')::boolean, false) then
    select invoice.currency into v_credit_currency
    from public.invoices invoice
    where invoice.org_id = v_org and invoice.id = (v_credit_resolution ->> 'invoice_id')::uuid;
    v_currency := v_credit_currency;
    v_assessment := v_assessment || jsonb_build_object('currency', v_currency);
  else
    v_currency := v_assessment ->> 'currency';
  end if;

  if nullif(upper(btrim(p_reviewed ->> 'currency')), '') is not null
     and upper(btrim(p_reviewed ->> 'currency')) is distinct from v_currency then
    raise exception 'document_review_currency_mismatch' using errcode = '22023';
  end if;

  select currency.minor_units into v_minor_units
  from public.currencies currency where currency.code = v_currency and currency.active;
  if v_currency is null or v_minor_units is null then
    raise exception 'document_review_currency_invalid' using errcode = '22023';
  end if;

  if (v_assessment ->> 'approval_blocked')::boolean then$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: apply assessment gate anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
  v_total := private.interpretation_number(to_jsonb(p_reviewed #>> '{totals,total}'));

  -- ================= invoice =================$anchor$;
  v_replacement := $replacement$
  v_total := private.interpretation_number(to_jsonb(p_reviewed #>> '{totals,total}'));

  if (v_net is not null and v_net <> round(v_net, v_minor_units))
     or (v_vat is not null and v_vat <> round(v_vat, v_minor_units))
     or (v_total is not null and v_total <> round(v_total, v_minor_units)) then
    raise exception 'document_review_currency_precision_invalid' using errcode = '22023';
  end if;

  -- ================= invoice =================$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: apply precision anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
      received_by, amount_before_vat, vat_amount, total_amount, review_status, notes, unit_id
    ) values (
      v_invoice_id, v_org, v_supplier_id, v_document_number, v_document_date, current_date,
      v_actor, round(coalesce(v_net, v_total), 2), round(coalesce(v_vat, 0), 2),
      round(v_total, 2),$anchor$;
  v_replacement := $replacement$
      received_by, amount_before_vat, vat_amount, total_amount, review_status, notes, unit_id,
      currency
    ) values (
      v_invoice_id, v_org, v_supplier_id, v_document_number, v_document_date, current_date,
      v_actor, round(coalesce(v_net, v_total), v_minor_units),
      round(coalesce(v_vat, 0), v_minor_units), round(v_total, v_minor_units),$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: apply invoice insert head anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'      ''נוצרה מבדיקת מסמך שאושרה. פירוש '' || v_interpretation.id::text,\n'
    || '      v_document.unit_id);';
  v_replacement := e'      ''נוצרה מבדיקת מסמך שאושרה. פירוש '' || v_interpretation.id::text,\n'
    || '      v_document.unit_id, v_currency);';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: apply invoice currency value anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
      id, org_id, supplier_id, invoice_id, reason, amount, status, notes, created_by,
      source_document_id, source_extraction_id, source_interpretation_id
    ) values ($anchor$;
  v_replacement := $replacement$
      id, org_id, supplier_id, invoice_id, reason, amount, status, notes, created_by,
      source_document_id, source_extraction_id, source_interpretation_id, currency
    ) values ($replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: apply credit insert head anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
      'התקבל לפי מסמך זיכוי מאושר ' || v_document.id::text,
      v_actor, v_document.id, v_interpretation.extraction_id, v_interpretation.id
    );$anchor$;
  v_replacement := $replacement$
      'התקבל לפי מסמך זיכוי מאושר ' || v_document.id::text,
      v_actor, v_document.id, v_interpretation.extraction_id, v_interpretation.id,
      v_currency
    );$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: apply credit currency value anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'      where i.org_id = v_org and i.supplier_id = v_supplier_id and i.deleted_at is null\n'
    || '        and private.document_text_key(i.invoice_number)';
  v_replacement := e'      where i.org_id = v_org and i.supplier_id = v_supplier_id and i.deleted_at is null\n'
    || e'        and i.currency = v_currency\n        and private.document_text_key(i.invoice_number)';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: apply receipt invoice currency anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := '        and p.amount = round(v_total, 2)';
  v_replacement := e'        and p.currency = v_currency\n'
    || '        and p.amount = round(v_total, v_minor_units)';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 2 then raise exception '0227: apply receipt payment currency anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'      ''credit_id'', v_credit_id,\n      ''applied_lines'', v_applied,';
  v_replacement := e'      ''credit_id'', v_credit_id,\n      ''currency'', v_currency,\n'
    || '      ''applied_lines'', v_applied,';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0227: apply audit currency anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_apply_0227$;

-- A fact unit is either a named non-money unit or an ISO currency code in lower case. The CHECK
-- keeps the shape; the trigger ties the currency branch to the active reference table.
alter table public.assistant_facts drop constraint assistant_facts_unit_check;
alter table public.assistant_facts add constraint assistant_facts_unit_check check (
  unit in ('count', 'percent', 'date', 'text') or unit ~ '^[a-z]{3}$'
);

create or replace function private.assistant_fact_currency_unit_guard()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.unit not in ('count', 'percent', 'date', 'text')
     and not exists (
       select 1 from public.currencies currency
       where lower(currency.code) = new.unit and currency.active) then
    raise exception 'assistant_fact_currency_unit_invalid' using errcode = '22023';
  end if;
  return new;
end
$$;
revoke all on function private.assistant_fact_currency_unit_guard()
  from public, anon, authenticated;
create trigger assistant_fact_currency_unit_guard
before insert or update of unit on public.assistant_facts
for each row execute function private.assistant_fact_currency_unit_guard();

-- SECURITY DEFINER bodies changed. Hashes are computed from pg_proc, never pasted from one OS.
update private.scope_definer_enforcements enforcement
set body_hash = md5(replace(proc.prosrc, e'\r', '')),
    scope_proof = '0227 writes the evidence-derived currency; tenant, actor, role and scope checks remain.'
from pg_catalog.pg_proc proc
where proc.oid = 'public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)'::regprocedure
  and enforcement.function_signature = 'apply_reviewed_document(uuid,uuid,jsonb,uuid,text)';

do $assert_0227$
declare
  v_result jsonb;
  v_violations text;
  v_probe_org uuid := gen_random_uuid();
begin
  -- Migrations run before seed on a clean `supabase start`, so there may be no organisation to
  -- resolve against. Prove the live function on a real FK-valid row inside a subtransaction, then
  -- deliberately roll the entire fixture back. Any other error is re-raised and fails migration.
  begin
    insert into public.organizations (id, name)
    values (v_probe_org, '__0227_currency_probe__');

    v_result := private.resolve_document_currency(
      v_probe_org, null,
      jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('key', 'currency', 'value', 'USD'))));
    if v_result ->> 'currency' <> 'USD' then
      raise exception '0227: USD did not resolve';
    end if;
    v_result := private.resolve_document_currency(
      v_probe_org, null,
      jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('key', 'currency', 'value', 'US0'))));
    if v_result ->> 'status' <> 'unrecognised' then
      raise exception '0227: US0 was not refused';
    end if;

    raise exception '0227_probe_rollback';
  exception when others then
    if sqlerrm <> '0227_probe_rollback' then raise; end if;
  end;

  if position('currency_unrecognised' in (select prosrc from pg_proc where oid =
       'private.document_reconciliation_assessment(uuid,text,uuid,uuid,jsonb,date)'::regprocedure)) = 0
     or position('currency_not_ils' in (select prosrc from pg_proc where oid =
       'private.document_reconciliation_assessment(uuid,text,uuid,uuid,jsonb,date)'::regprocedure)) > 0 then
    raise exception '0227: assessment currency gate was not replaced';
  end if;
  if position('document_review_currency_mismatch' in (select prosrc from pg_proc where oid =
       'public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)'::regprocedure)) = 0 then
    raise exception '0227: apply command does not bind currency to evidence';
  end if;
  if has_function_privilege('authenticated',
       'private.resolve_document_currency(uuid,uuid,jsonb)', 'execute') then
    raise exception '0227: browser can call the private currency resolver';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0227 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0227$;
