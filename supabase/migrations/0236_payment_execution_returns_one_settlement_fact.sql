-- 0236: correct the 0234 JSON anchors. The stored payment was already correct; replay contained
-- duplicate settlement keys while commit/audit omitted them. Each surface now states one fact.

do $patch_execute_result_0236$
declare
  v_signature regprocedure:=
    'public.execute_payment_request(uuid,date,text,text,text,jsonb,numeric,text,text)'::regprocedure;
  v_definition text:=replace(pg_get_functiondef(v_signature),e'\r','');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor:=e'      ''payment_request_id'', v_request.id,\n      ''currency'', v_currency,\n'
    || e'      ''settlement_amount'', v_settlement_amount,\n      ''settlement_currency'', v_settlement_currency,\n'
    || '      ''status'', v_request.status,';
  v_replacement:=e'      ''payment_request_id'', v_request.id,\n      ''status'', v_request.status,';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0236: duplicate replay block anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'      ''status'', ''executed'',\n      ''payment_id'', v_payment.id,\n'
    || '      ''amount'', v_payment.amount,';
  v_replacement:=e'      ''status'', ''executed'',\n      ''payment_id'', v_payment.id,\n'
    || e'      ''amount'', v_payment.amount,\n      ''currency'', v_payment.currency,\n'
    || e'      ''settlement_amount'', v_payment.settlement_amount,\n'
    || '      ''settlement_currency'', v_payment.settlement_currency,';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0236: audit result anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'    ''status'', ''executed'',\n    ''invoice_ids'', to_jsonb(v_invoice_ids),';
  v_replacement:=e'    ''status'', ''executed'',\n    ''currency'', v_payment.currency,\n'
    || e'    ''settlement_amount'', v_payment.settlement_amount,\n'
    || e'    ''settlement_currency'', v_payment.settlement_currency,\n'
    || '    ''invoice_ids'', to_jsonb(v_invoice_ids),';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0236: commit result anchor count %',v_count; end if;
  execute replace(v_definition,v_anchor,v_replacement);
end
$patch_execute_result_0236$;

do $assert_0236$
declare v_body text; v_violations text;
begin
  select prosrc into v_body from pg_proc where oid=
    'public.execute_payment_request(uuid,date,text,text,text,jsonb,numeric,text,text)'::regprocedure;
  if position('''status'', ''executed'',
      ''payment_id'', v_payment.id,
      ''amount'', v_payment.amount,
      ''currency'', v_payment.currency' in v_body)=0 then
    raise exception '0236: audit does not state currency'; end if;
  if position('''status'', ''executed'',
    ''currency'', v_payment.currency' in v_body)=0 then
    raise exception '0236: commit response does not state currency'; end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0236 scope failed:\n%',v_violations; end if;
end
$assert_0236$;
