-- 0231: a payment request is one transfer in one currency. The command derives that currency from
-- its invoices; mixed input is refused by name. Approval snapshots and open-credit overrides read
-- only credits in the request currency.

do $patch_create_request_0231$
declare
  v_definition text:=replace(pg_get_functiondef(
    'public.create_payment_request(uuid,uuid,date,text,text,jsonb,text)'::regprocedure),e'\r','');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor:=e'  v_unit_count int;\n  v_unit uuid;';
  v_replacement:=e'  v_unit_count int;\n  v_unit uuid;\n  v_currency_count int;\n'
    || e'  v_currency text;\n  v_minor_units smallint;';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create declaration anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
  select count(*), count(distinct invoice_id), round(coalesce(sum(amount), 0), 2),
         coalesce(jsonb_agg(
           jsonb_build_object('invoice_id', invoice_id, 'amount', round(amount, 2))
           order by invoice_id
         ), '[]'::jsonb)$anchor$;
  v_replacement:=$replacement$
  select count(*), count(distinct invoice_id), coalesce(sum(amount), 0),
         coalesce(jsonb_agg(
           jsonb_build_object('invoice_id', invoice_id, 'amount', amount)
           order by invoice_id
         ), '[]'::jsonb)$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create input aggregate anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
    perform public.assert_unit_in_scope(v_request.unit_id);

    select coalesce(jsonb_agg($anchor$;
  v_replacement:=$replacement$
    perform public.assert_unit_in_scope(v_request.unit_id);
    v_currency:=v_request.currency;
    select currency.minor_units into v_minor_units from public.currencies currency
    where currency.code=v_currency and currency.active;
    if v_minor_units is null then raise exception 'payment_request_currency_invalid' using errcode='22023'; end if;
    v_amount:=round(v_amount,v_minor_units);
    select coalesce(jsonb_agg(
      jsonb_build_object('invoice_id',invoice_id,'amount',round(amount,v_minor_units))
      order by invoice_id),'[]'::jsonb) into v_input
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid,amount numeric);

    select coalesce(jsonb_agg($replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create replay currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:='jsonb_build_object(''invoice_id'', pri.invoice_id, ''amount'', round(pri.amount_allocated, 2))';
  v_replacement:='jsonb_build_object(''invoice_id'', pri.invoice_id, ''amount'', round(pri.amount_allocated, v_minor_units))';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create replay allocation anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:='       or round(v_request.amount, 2) <> v_amount';
  v_replacement:='       or round(v_request.amount, v_minor_units) <> v_amount';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create replay amount anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'      ''amount'', v_request.amount,\n      ''unit_id'', v_request.unit_id,\n'
    || '      ''idempotent'', true';
  v_replacement:=e'      ''amount'', v_request.amount,\n      ''currency'', v_request.currency,\n'
    || e'      ''unit_id'', v_request.unit_id,\n      ''idempotent'', true';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create replay return anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'    ''amount'', v_request.amount,\n    ''unit_id'', v_request.unit_id,\n'
    || '    ''idempotent'', false';
  v_replacement:=e'    ''amount'', v_request.amount,\n    ''currency'', v_request.currency,\n'
    || e'    ''unit_id'', v_request.unit_id,\n    ''idempotent'', false';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create commit return anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
  select count(u.id), count(distinct i.unit_id), min(i.unit_id::text)::uuid
    into v_visible_count, v_unit_count, v_unit$anchor$;
  v_replacement:=$replacement$
  select count(u.id), count(distinct i.unit_id), min(i.unit_id::text)::uuid,
         count(distinct i.currency), min(i.currency)
    into v_visible_count, v_unit_count, v_unit, v_currency_count, v_currency$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create scope currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
  if v_visible_count <> v_count or v_unit_count <> 1 or v_unit is null then
    raise exception 'payment_request_scope_invalid' using errcode = 'P0001';
  end if;
  perform public.assert_unit_in_scope(v_unit);$anchor$;
  v_replacement:=$replacement$
  if v_visible_count <> v_count or v_unit_count <> 1 or v_unit is null then
    raise exception 'payment_request_scope_invalid' using errcode = 'P0001';
  end if;
  if v_currency_count <> 1 or v_currency is null then
    raise exception 'payment_request_currency_mixed' using errcode = '22023';
  end if;
  perform public.assert_unit_in_scope(v_unit);
  select currency.minor_units into v_minor_units from public.currencies currency
  where currency.code=v_currency and currency.active;
  if v_minor_units is null then raise exception 'payment_request_currency_invalid' using errcode='22023'; end if;
  v_amount:=round(v_amount,v_minor_units);
  select coalesce(jsonb_agg(
    jsonb_build_object('invoice_id',invoice_id,'amount',round(amount,v_minor_units))
    order by invoice_id),'[]'::jsonb) into v_input
  from jsonb_to_recordset(p_allocations) as a(invoice_id uuid,amount numeric);$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create currency validation anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'       or i.deleted_at is not null\n       or round(a.amount, 2) > round(';
  v_replacement:=e'       or i.deleted_at is not null\n       or i.currency <> v_currency\n'
    || '       or round(a.amount, v_minor_units) > round(';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create invoice currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'         2\n       )';
  v_replacement:=e'         v_minor_units\n       )';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create allocation rounding anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'      and pr.supplier_id = p_supplier_id\n      and round(pr.amount, 2) = v_amount';
  v_replacement:=e'      and pr.supplier_id = p_supplier_id\n      and pr.currency = v_currency\n'
    || '      and round(pr.amount, v_minor_units) = v_amount';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create duplicate currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
    id, org_id, unit_id, supplier_id, amount, due_date, status, notes, created_by
  ) values (
    p_request_id, v_org, v_unit, p_supplier_id, v_amount, p_due_date, v_status, v_notes, v_user$anchor$;
  v_replacement:=$replacement$
    id, org_id, unit_id, supplier_id, amount, due_date, status, notes, created_by, currency
  ) values (
    p_request_id, v_org, v_unit, p_supplier_id, v_amount, p_due_date, v_status, v_notes, v_user,
    v_currency$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create request insert anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
  insert into public.payment_request_invoices (org_id, payment_request_id, invoice_id, amount_allocated)
  select v_org, v_request.id, invoice_id, round(amount, 2)$anchor$;
  v_replacement:=$replacement$
  insert into public.payment_request_invoices (
    org_id, payment_request_id, invoice_id, amount_allocated, currency)
  select v_org, v_request.id, invoice_id, round(amount, v_minor_units), v_currency$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create junction currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'      ''amount'', v_request.amount,\n      ''invoice_count'', v_count,';
  v_replacement:=e'      ''amount'', v_request.amount,\n      ''currency'', v_request.currency,\n'
    || '      ''invoice_count'', v_count,';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: create audit currency anchor count %',v_count; end if;
  execute replace(v_definition,v_anchor,v_replacement);
end
$patch_create_request_0231$;

do $patch_approval_0231$
declare
  v_definition text:=replace(pg_get_functiondef(
    'public.p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)'::regprocedure),e'\r','');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor:=e'  v_open_credit_total numeric(12,2) := 0;\n  v_approved_at timestamptz;';
  v_replacement:=e'  v_open_credit_total numeric(14,3) := 0;\n'
    || e'  v_minor_units smallint;\n  v_approved_at timestamptz;';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: approval declaration anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
  perform public.assert_unit_in_scope(v_request.unit_id);

  if p_expected_supplier_id is not null$anchor$;
  v_replacement:=$replacement$
  perform public.assert_unit_in_scope(v_request.unit_id);
  select currency.minor_units into v_minor_units from public.currencies currency
  where currency.code=v_request.currency and currency.active;
  if v_minor_units is null then raise exception 'payment_request_currency_invalid' using errcode='22023'; end if;

  if p_expected_supplier_id is not null$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: approval currency lookup anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_definition:=replace(v_definition,
    'round(v_request.open_credit_override_total, 2) = round(p_expected_open_credit_total, 2)',
    'round(v_request.open_credit_override_total, v_minor_units) = round(p_expected_open_credit_total, v_minor_units)');

  v_anchor:=e'          or i.unit_id is distinct from v_request.unit_id\n          or i.deleted_at is not null';
  v_replacement:=e'          or i.unit_id is distinct from v_request.unit_id\n'
    || e'          or i.currency <> v_request.currency or pri.currency <> v_request.currency\n'
    || '          or i.deleted_at is not null';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: approval invoice currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:='or round(pri.amount_allocated, 2) > round(';
  v_replacement:='or round(pri.amount_allocated, v_minor_units) > round(';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: approval allocation rounding head count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);
  v_anchor:=e'            2\n          )';
  v_replacement:=e'            v_minor_units\n          )';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: approval allocation rounding tail count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  -- Every open-credit scan in this command is about the request currency and no other.
  v_anchor:=$anchor$      and cr.status in ('open', 'requested', 'received')$anchor$;
  v_replacement:=v_anchor||e'\n      and cr.currency = v_request.currency';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>3 then raise exception '0231: approval credit currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=')::numeric(12,2)';
  v_replacement:=')::numeric(14,3)';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: approval credit cast anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);
  v_definition:=replace(v_definition,
    'round(v_open_credit_total, 2) <> round(p_expected_open_credit_total, 2)',
    'round(v_open_credit_total, v_minor_units) <> round(p_expected_open_credit_total, v_minor_units)');

  v_anchor:=e'        ''open_credit_total'', v_open_credit_total,\n        ''payment_request_amount'', v_request.amount,';
  v_replacement:=e'        ''open_credit_total'', v_open_credit_total,\n'
    || e'        ''currency'', v_request.currency,\n        ''payment_request_amount'', v_request.amount,';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: approval audit currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'    ''open_credit_total'', case when v_target = ''approved'' then v_open_credit_total end,\n'
    || '    ''idempotent'', false';
  v_replacement:=e'    ''open_credit_total'', case when v_target = ''approved'' then v_open_credit_total end,\n'
    || e'    ''currency'', v_request.currency,\n    ''idempotent'', false';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0231: approval return currency anchor count %',v_count; end if;
  execute replace(v_definition,v_anchor,v_replacement);
end
$patch_approval_0231$;

update private.scope_definer_enforcements enforcement
set body_hash=md5(replace(proc.prosrc,e'\r','')),
    scope_proof=case enforcement.function_signature
      when 'create_payment_request(uuid,uuid,date,text,text,jsonb,text)'
        then '0231 derives one currency from the already tenant/supplier/unit-filtered invoice set.'
      else '0231 filters invoices and credits to the locked request currency; tenant and unit fences remain.' end
from pg_proc proc
where (proc.oid='public.create_payment_request(uuid,uuid,date,text,text,jsonb,text)'::regprocedure
       and enforcement.function_signature='create_payment_request(uuid,uuid,date,text,text,jsonb,text)')
   or (proc.oid='public.p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)'::regprocedure
       and enforcement.function_signature='p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)');

do $assert_0231$
declare v_violations text;
begin
  if position('payment_request_currency_mixed' in (select prosrc from pg_proc where oid=
       'public.create_payment_request(uuid,uuid,date,text,text,jsonb,text)'::regprocedure))=0 then
    raise exception '0231: create command does not refuse mixed currency'; end if;
  if position('cr.currency = v_request.currency' in (select prosrc from pg_proc where oid=
       'public.p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)'::regprocedure))=0 then
    raise exception '0231: approval command does not filter credits by request currency'; end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0231 scope failed:\n%',v_violations; end if;
end
$assert_0231$;
