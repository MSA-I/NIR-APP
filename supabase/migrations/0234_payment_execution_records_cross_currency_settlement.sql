-- 0234: executing a request may record the account-side settlement amount/currency. The payment
-- and all invoice/credit allocations remain in the request currency; settlement is a second fact,
-- optional only when it differs. No exchange-rate column exists.

do $patch_execute_0234$
declare
  v_definition text:=replace(pg_get_functiondef(
    'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure),e'\r','');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor:='CREATE OR REPLACE FUNCTION public.execute_payment_request(p_payment_request_id uuid, '
    || 'p_paid_date date, p_method text, p_reference text, p_notes text, p_allocations jsonb, p_reason text)';
  v_replacement:='CREATE OR REPLACE FUNCTION public.execute_payment_request(p_payment_request_id uuid, '
    || 'p_paid_date date, p_method text, p_reference text, p_notes text, p_allocations jsonb, '
    || 'p_settlement_amount numeric, p_settlement_currency text, p_reason text)';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0234: execute signature anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'  v_invoice_ids uuid[] := ''{}''::uuid[];\nbegin';
  v_replacement:=e'  v_invoice_ids uuid[] := ''{}''::uuid[];\n  v_currency text;\n'
    || e'  v_minor_units smallint;\n  v_settlement_currency text := upper(nullif(trim(p_settlement_currency), ''''));\n'
    || e'  v_settlement_amount numeric;\n  v_settlement_minor_units smallint;\nbegin';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0234: execute declaration anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
  if not found then
    raise exception 'payment_request_not_executable' using errcode = 'P0002';
  end if;

  select count(*),$anchor$;
  v_replacement:=$replacement$
  if not found then
    raise exception 'payment_request_not_executable' using errcode = 'P0002';
  end if;
  v_currency:=v_request.currency;
  select currency.minor_units into v_minor_units from public.currencies currency
  where currency.code=v_currency and currency.active;
  if v_minor_units is null then raise exception 'payment_execution_currency_invalid' using errcode='22023'; end if;

  if num_nonnulls(p_settlement_amount,v_settlement_currency) not in (0,2) then
    raise exception 'payment_settlement_pair_invalid' using errcode='22023';
  end if;
  if p_settlement_amount is not null then
    select currency.minor_units into v_settlement_minor_units from public.currencies currency
    where currency.code=v_settlement_currency and currency.active;
    if v_settlement_minor_units is null or v_settlement_currency=v_currency
       or p_settlement_amount<=0
       or p_settlement_amount<>round(p_settlement_amount,v_settlement_minor_units) then
      raise exception 'payment_settlement_invalid' using errcode='22023';
    end if;
    v_settlement_amount:=round(p_settlement_amount,v_settlement_minor_units);
  end if;

  select count(*),$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0234: execute currency validation anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  -- Every round in this command is on request-currency allocations. Settlement is validated above
  -- against its own minor units and is never mixed into these sums.
  v_count:=(length(v_definition)-length(replace(v_definition,', 2)', '')))/length(', 2)');
  if v_count<8 then raise exception '0234: execute money rounding anchors unexpectedly %',v_count; end if;
  v_definition:=replace(v_definition,', 2)',', v_minor_units)');

  v_anchor:='if v_cash_sum < 0.01 then';
  v_replacement:='if v_cash_sum < (1::numeric / power(10::numeric,v_minor_units)) then';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0234: execute minimum cash anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
       or v_payment.reference is distinct from v_reference
       or v_payment.notes is distinct from v_notes
       or v_existing is distinct from v_input then$anchor$;
  v_replacement:=$replacement$
       or v_payment.reference is distinct from v_reference
       or v_payment.notes is distinct from v_notes
       or v_payment.settlement_amount is distinct from v_settlement_amount
       or v_payment.settlement_currency is distinct from v_settlement_currency
       or v_existing is distinct from v_input then$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0234: execute replay settlement anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
    org_id, supplier_id, payment_request_id, amount, paid_date,
    method, reference, executed_by, notes
  ) values (
    v_org, v_request.supplier_id, v_request.id, round(v_cash_sum, v_minor_units), p_paid_date,
    v_method, v_reference, v_user, v_notes
  ) returning * into v_payment;$anchor$;
  v_replacement:=$replacement$
    org_id,supplier_id,payment_request_id,amount,paid_date,method,reference,executed_by,notes,
    currency,settlement_amount,settlement_currency
  ) values (
    v_org,v_request.supplier_id,v_request.id,round(v_cash_sum,v_minor_units),p_paid_date,
    v_method,v_reference,v_user,v_notes,v_currency,v_settlement_amount,v_settlement_currency
  ) returning * into v_payment;$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0234: execute payment insert anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
  insert into public.payment_allocations (payment_id, invoice_id, credit_id, amount)
  select v_payment.id, invoice_id, credit_id, round(amount, v_minor_units)$anchor$;
  v_replacement:=$replacement$
  insert into public.payment_allocations (payment_id,invoice_id,credit_id,amount,currency)
  select v_payment.id,invoice_id,credit_id,round(amount,v_minor_units),v_currency$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0234: execute allocation currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'      ''payment_id'', v_payment.id,\n      ''payment_request_id'', v_request.id,';
  v_replacement:=e'      ''payment_id'', v_payment.id,\n      ''payment_request_id'', v_request.id,\n'
    || e'      ''currency'', v_currency,\n      ''settlement_amount'', v_settlement_amount,\n'
    || '      ''settlement_currency'', v_settlement_currency,';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0234: execute audit settlement anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'      ''status'', v_request.status,\n      ''invoice_ids'', coalesce((';
  v_replacement:=e'      ''status'', v_request.status,\n      ''currency'', v_payment.currency,\n'
    || e'      ''settlement_amount'', v_payment.settlement_amount,\n'
    || e'      ''settlement_currency'', v_payment.settlement_currency,\n'
    || '      ''invoice_ids'', coalesce((';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0234: execute replay return settlement anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  execute v_definition;
end
$patch_execute_0234$;

do $patch_emergency_0234$
declare
  v_definition text:=replace(pg_get_functiondef(
    'public.execute_emergency_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure),e'\r','');
  v_anchor text:=e'      p_allocations,\n      p_reason';
  v_replacement text:=e'      p_allocations,\n      null,\n      null,\n      p_reason';
  v_count integer;
begin
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0234: emergency wrapper anchor count %',v_count; end if;
  execute replace(v_definition,v_anchor,v_replacement);
end
$patch_emergency_0234$;

drop function public.execute_payment_request(uuid,date,text,text,text,jsonb,text);
revoke all on function public.execute_payment_request(
  uuid,date,text,text,text,jsonb,numeric,text,text) from public,anon;
grant execute on function public.execute_payment_request(
  uuid,date,text,text,text,jsonb,numeric,text,text) to authenticated;

update private.scope_definer_exemptions
set function_signature='execute_payment_request(uuid,date,text,text,text,jsonb,numeric,text,text)',
    reason='rls-preread-single-unit; 0234 keeps debt allocations in request currency and validates optional settlement separately'
where function_signature='execute_payment_request(uuid,date,text,text,text,jsonb,text)';

do $assert_0234$
declare v_violations text;
begin
  if to_regprocedure('public.execute_payment_request(uuid,date,text,text,text,jsonb,text)') is not null
     or to_regprocedure('public.execute_payment_request(uuid,date,text,text,text,jsonb,numeric,text,text)') is null then
    raise exception '0234: execute signature migration incomplete'; end if;
  if position('p_settlement_amount' in(select prosrc from pg_proc where oid=
       'public.execute_payment_request(uuid,date,text,text,text,jsonb,numeric,text,text)'::regprocedure))=0 then
    raise exception '0234: settlement is not written by the command'; end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0234 scope failed:\n%',v_violations; end if;
end
$assert_0234$;
