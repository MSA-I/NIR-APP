-- 0228: the manual invoice command names the currency it writes, then the temporary ILS default
-- comes off. The two changes are one transaction: dropping the default before the command exists
-- would break manual intake; keeping it afterwards would preserve a silent shekel path.

do $patch_create_invoice_0228$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.create_invoice(uuid,uuid,text,date,numeric,numeric,numeric,text,uuid,uuid,text,text)'::regprocedure),
    e'\r', '');
  v_anchor text;
  v_replacement text;
  v_count integer;
begin
  v_anchor := 'CREATE OR REPLACE FUNCTION public.create_invoice(p_invoice_id uuid, '
    || 'p_supplier_id uuid, p_invoice_number text,';
  v_replacement := 'CREATE OR REPLACE FUNCTION public.create_invoice(p_invoice_id uuid, '
    || 'p_supplier_id uuid, p_currency text, p_invoice_number text,';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0228: create_invoice signature anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
  v_notes text := nullif(trim(p_notes), '');
  v_before numeric := round(coalesce(p_amount_before_vat, 0), 2);
  v_vat numeric := round(coalesce(p_vat_amount, 0), 2);
  v_total numeric := round(p_total_amount, 2);
  v_duplicate boolean := false;$anchor$;
  v_replacement := $replacement$
  v_notes text := nullif(trim(p_notes), '');
  v_currency text := upper(nullif(trim(p_currency), ''));
  v_minor_units smallint;
  v_before numeric;
  v_vat numeric;
  v_total numeric;
  v_duplicate boolean := false;
  v_receipt_order_currency text;$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0228: create_invoice declaration anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
  if p_invoice_id is null or p_supplier_id is null or v_number is null
     or p_invoice_date is null or p_total_amount is null or v_reason is null then
    raise exception 'invoice_fields_required' using errcode = '22023';
  end if;
  if v_before < 0 or v_vat < 0 or v_total < 0
     or round(v_before + v_vat, 2) <> v_total then
    raise exception 'invoice_amounts_invalid' using errcode = '22023';
  end if;$anchor$;
  v_replacement := $replacement$
  if p_invoice_id is null or p_supplier_id is null or v_currency is null or v_number is null
     or p_invoice_date is null or p_total_amount is null or v_reason is null then
    raise exception 'invoice_fields_required' using errcode = '22023';
  end if;
  select currency.minor_units into v_minor_units
  from public.currencies currency where currency.code = v_currency and currency.active;
  if v_minor_units is null then
    raise exception 'invoice_currency_invalid' using errcode = '22023';
  end if;
  if coalesce(p_amount_before_vat, 0) <> round(coalesce(p_amount_before_vat, 0), v_minor_units)
     or coalesce(p_vat_amount, 0) <> round(coalesce(p_vat_amount, 0), v_minor_units)
     or p_total_amount <> round(p_total_amount, v_minor_units) then
    raise exception 'invoice_currency_precision_invalid' using errcode = '22023';
  end if;
  v_before := round(coalesce(p_amount_before_vat, 0), v_minor_units);
  v_vat := round(coalesce(p_vat_amount, 0), v_minor_units);
  v_total := round(p_total_amount, v_minor_units);
  if v_before < 0 or v_vat < 0 or v_total < 0
     or round(v_before + v_vat, v_minor_units) <> v_total then
    raise exception 'invoice_amounts_invalid' using errcode = '22023';
  end if;$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0228: create_invoice validation anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
       or v_invoice.invoice_date <> p_invoice_date
       or round(v_invoice.amount_before_vat, 2) <> v_before
       or round(v_invoice.vat_amount, 2) <> v_vat
       or round(v_invoice.total_amount, 2) <> v_total$anchor$;
  v_replacement := $replacement$
       or v_invoice.invoice_date <> p_invoice_date
       or v_invoice.currency <> v_currency
       or round(v_invoice.amount_before_vat, v_minor_units) <> v_before
       or round(v_invoice.vat_amount, v_minor_units) <> v_vat
       or round(v_invoice.total_amount, v_minor_units) <> v_total$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0228: create_invoice idempotency anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
    if not found or v_order.supplier_id <> p_supplier_id then
      raise exception 'invoice_order_invalid' using errcode = '22023';
    end if;$anchor$;
  v_replacement := $replacement$
    if not found or v_order.supplier_id <> p_supplier_id then
      raise exception 'invoice_order_invalid' using errcode = '22023';
    end if;
    if v_order.currency <> v_currency then
      raise exception 'invoice_order_currency_mismatch' using errcode = '22023';
    end if;$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0228: create_invoice order currency anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
    if not found or (p_order_id is not null and v_receipt.order_id <> p_order_id) then
      raise exception 'invoice_receipt_invalid' using errcode = '22023';
    end if;$anchor$;
  v_replacement := $replacement$
    if not found or (p_order_id is not null and v_receipt.order_id <> p_order_id) then
      raise exception 'invoice_receipt_invalid' using errcode = '22023';
    end if;
    select purchase_order.currency into v_receipt_order_currency
    from public.purchase_orders purchase_order
    where purchase_order.org_id = v_org and purchase_order.id = v_receipt.order_id;
    if v_receipt_order_currency <> v_currency then
      raise exception 'invoice_receipt_currency_mismatch' using errcode = '22023';
    end if;$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0228: create_invoice receipt currency anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'      and i.invoice_number = v_number\n      and i.deleted_at is null';
  v_replacement := e'      and i.invoice_number = v_number\n'
    || e'      and i.currency = v_currency\n      and i.deleted_at is null';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0228: create_invoice duplicate anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$
    received_by, amount_before_vat, vat_amount, total_amount, review_status, notes
  ) values (
    p_invoice_id, v_org, p_supplier_id, v_number, p_invoice_date, current_date,
    v_user, v_before, v_vat, v_total,$anchor$;
  v_replacement := $replacement$
    received_by, amount_before_vat, vat_amount, total_amount, review_status, notes, currency
  ) values (
    p_invoice_id, v_org, p_supplier_id, v_number, p_invoice_date, current_date,
    v_user, v_before, v_vat, v_total,$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0228: create_invoice insert head anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'    end,\n    v_notes\n  ) returning * into v_invoice;';
  v_replacement := e'    end,\n    v_notes, v_currency\n  ) returning * into v_invoice;';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0228: create_invoice insert value anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'      ''total_amount'', v_total,\n      ''review_status'', v_invoice.review_status,';
  v_replacement := e'      ''total_amount'', v_total,\n      ''currency'', v_currency,\n'
    || '      ''review_status'', v_invoice.review_status,';
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0228: create_invoice audit currency anchor count %', v_count; end if;

  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_create_invoice_0228$;

drop function public.create_invoice(
  uuid, uuid, text, date, numeric, numeric, numeric, text, uuid, uuid, text, text
);

revoke all on function public.create_invoice(
  uuid, uuid, text, text, date, numeric, numeric, numeric, text, uuid, uuid, text, text
) from public, anon;
grant execute on function public.create_invoice(
  uuid, uuid, text, text, date, numeric, numeric, numeric, text, uuid, uuid, text, text
) to authenticated;

update private.scope_definer_exemptions
set function_signature = 'create_invoice(uuid,uuid,text,text,date,numeric,numeric,numeric,text,uuid,uuid,text,text)',
    reason = 'rls-preread-single-unit; currency and linked order/receipt identity enforced by 0228'
where function_signature = 'create_invoice(uuid,uuid,text,date,numeric,numeric,numeric,text,uuid,uuid,text,text)';

alter table public.invoices alter column currency drop default;

do $assert_0228$
declare
  v_violations text;
begin
  if to_regprocedure(
       'public.create_invoice(uuid,uuid,text,date,numeric,numeric,numeric,text,uuid,uuid,text,text)')
       is not null then
    raise exception '0228: old create_invoice signature still exists';
  end if;
  if to_regprocedure(
       'public.create_invoice(uuid,uuid,text,text,date,numeric,numeric,numeric,text,uuid,uuid,text,text)')
       is null then
    raise exception '0228: currency-aware create_invoice signature is missing';
  end if;
  if (select column_default is not null from information_schema.columns
      where table_schema = 'public' and table_name = 'invoices' and column_name = 'currency') then
    raise exception '0228: invoices.currency still has a default';
  end if;
  if not has_function_privilege('authenticated',
       'public.create_invoice(uuid,uuid,text,text,date,numeric,numeric,numeric,text,uuid,uuid,text,text)',
       'execute') then
    raise exception '0228: authenticated lost the manual invoice command';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0228 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0228$;
