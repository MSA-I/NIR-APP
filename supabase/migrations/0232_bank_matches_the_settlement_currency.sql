-- 0232: a bank line matches the money that left the account. A USD debt paid from an ILS account
-- links through payments.settlement_*; a bank row never links directly to an invoice in another
-- currency. The derived rate remains settlement_amount / amount and is stored nowhere.

alter table public.payments
  add column bank_currency text generated always as (coalesce(settlement_currency,currency)) stored;
alter table public.payments
  add constraint payments_org_id_bank_currency_key unique(org_id,id,bank_currency);
alter table public.bank_allocations drop constraint bank_allocations_payment_currency_fk;
alter table public.bank_allocations add constraint bank_allocations_payment_currency_fk
  foreign key(org_id,payment_id,currency)
  references public.payments(org_id,id,bank_currency) on delete restrict;

comment on column public.payments.bank_currency is
  'Generated currency of the account-side amount: settlement_currency when present, otherwise '
  'the debt currency. Used only by the bank-allocation identity FK (0232).';

do $patch_bank_match_0232$
declare
  v_definition text:=replace(pg_get_functiondef(
    'public.match_bank_transaction(uuid,uuid,uuid,uuid,jsonb,numeric,text)'::regprocedure),e'\r','');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor:=e'  v_tolerance numeric;\n  v_count int := 0;';
  v_replacement:=e'  v_tolerance numeric;\n  v_minor_units smallint;\n'
    || e'  v_payment_match_amount numeric;\n  v_payment_match_currency text;\n  v_count int := 0;';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank declaration anchor count %',v_count; end if;
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
  if v_count<>1 then raise exception '0232: bank input aggregate anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
  if not found then
    raise exception 'bank_transaction_unknown' using errcode = 'P0002';
  end if;

  if v_tx.status = 'matched' then$anchor$;
  v_replacement:=$replacement$
  if not found then
    raise exception 'bank_transaction_unknown' using errcode = 'P0002';
  end if;
  select currency.minor_units into v_minor_units from public.currencies currency
  where currency.code=v_tx.currency and currency.active;
  if v_minor_units is null then raise exception 'bank_match_currency_invalid' using errcode='22023'; end if;
  v_sum:=round(v_sum,v_minor_units);
  if p_payment_id is not null then
    select coalesce(jsonb_agg(
      jsonb_build_object('invoice_id',invoice_id,'amount',round(amount,v_minor_units))
      order by invoice_id),'[]'::jsonb) into v_input
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid,amount numeric);
  end if;

  if v_tx.status = 'matched' then$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank currency setup anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$jsonb_build_object('invoice_id', ba.invoice_id, 'amount', round(ba.amount, 2))$anchor$;
  v_replacement:=$replacement$jsonb_build_object('invoice_id', ba.invoice_id, 'amount', round(ba.amount, v_minor_units))$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank replay rounding anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
  select coalesce(nullif(o.settings->>'bank_match_amount_tolerance', '')::numeric, 1)
    into v_tolerance
  from organizations o
  where o.id = v_org;$anchor$;
  v_replacement:=$replacement$
  v_tolerance:=coalesce(
    private.money_tolerance(v_org,v_tx.currency,'bank_match_amount_tolerance'),
    case when v_tx.currency='ILS' then 1 end);
  if v_tolerance is null then
    raise exception 'bank_match_tolerance_unconfigured' using errcode='22023';
  end if;$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank tolerance anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
    if not found or v_payment.supplier_id <> v_supplier
       or abs(round(v_payment.amount, 2) - round(v_tx.amount, 2)) > v_tolerance then
      raise exception 'bank_payment_invalid' using errcode = 'P0001';
    end if;$anchor$;
  v_replacement:=$replacement$
    v_payment_match_currency:=coalesce(v_payment.settlement_currency,v_payment.currency);
    v_payment_match_amount:=coalesce(v_payment.settlement_amount,v_payment.amount);
    if not found or v_payment.supplier_id <> v_supplier
       or v_payment_match_currency <> v_tx.currency
       or abs(round(v_payment_match_amount,v_minor_units)-round(v_tx.amount,v_minor_units))>v_tolerance then
      raise exception 'bank_payment_invalid' using errcode = 'P0001';
    end if;$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank settlement comparison anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
    insert into bank_allocations (
      bank_transaction_id, invoice_id, payment_id, amount, confidence, confirmed, created_by
    ) values (
      v_tx.id, null, v_payment.id, round(v_tx.amount, 2), p_confidence, true, v_user
    );$anchor$;
  v_replacement:=$replacement$
    insert into bank_allocations (
      bank_transaction_id, invoice_id, payment_id, amount, confidence, confirmed, created_by,currency
    ) values (
      v_tx.id,null,v_payment.id,round(v_tx.amount,v_minor_units),p_confidence,true,v_user,v_tx.currency
    );$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank existing allocation currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:='if abs(v_sum - round(v_tx.amount, 2)) > v_tolerance or v_sum > round(v_tx.amount, 2) then';
  v_replacement:='if abs(v_sum-round(v_tx.amount,v_minor_units))>v_tolerance '
    || 'or v_sum>round(v_tx.amount,v_minor_units) then';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank direct total anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
    if exists (
      select 1
      from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
      left join invoices i on i.id = a.invoice_id
      where i.id is null or i.org_id <> v_org or i.supplier_id <> v_supplier$anchor$;
  v_replacement:=$replacement$
    if exists (
      select 1 from jsonb_to_recordset(p_allocations) as a(invoice_id uuid,amount numeric)
      join public.invoices i on i.id=a.invoice_id
      where i.org_id=v_org and i.currency<>v_tx.currency
    ) then
      raise exception 'bank_match_currency_mismatch' using errcode='22023';
    end if;

    if exists (
      select 1
      from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
      left join invoices i on i.id = a.invoice_id
      where i.id is null or i.org_id <> v_org or i.supplier_id <> v_supplier$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank direct mismatch anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_definition:=replace(v_definition,'round(a.amount, 2) > round(','round(a.amount,v_minor_units)>round(');
  v_definition:=replace(v_definition,e'            2\n          )',e'            v_minor_units\n          )');

  v_anchor:=$anchor$
    insert into payments (
      id, org_id, supplier_id, amount, paid_date, method,
      reference, executed_by, notes
    ) values (
      p_payment_id, v_org, v_supplier, round(v_tx.amount, 2), v_tx.tx_date,$anchor$;
  v_replacement:=$replacement$
    insert into payments (
      id,org_id,supplier_id,amount,paid_date,method,reference,executed_by,notes,currency
    ) values (
      p_payment_id,v_org,v_supplier,round(v_tx.amount,v_minor_units),v_tx.tx_date,$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank payment insert head anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);
  v_anchor:=e'      ''נוצר מהתאמת תנועת בנק''\n    ) returning * into v_payment;';
  v_replacement:=e'      ''נוצר מהתאמת תנועת בנק'',v_tx.currency\n    ) returning * into v_payment;';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank payment currency value anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
    insert into payment_allocations (payment_id, invoice_id, amount)
    select v_payment.id, invoice_id, round(amount, 2)$anchor$;
  v_replacement:=$replacement$
    insert into payment_allocations (payment_id,invoice_id,amount,currency)
    select v_payment.id,invoice_id,round(amount,v_minor_units),v_tx.currency$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank payment allocation currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
      bank_transaction_id, invoice_id, payment_id, amount, confidence, confirmed, created_by
    )
    select v_tx.id, invoice_id, null, round(amount, 2), p_confidence, true, v_user$anchor$;
  v_replacement:=$replacement$
      bank_transaction_id,invoice_id,payment_id,amount,confidence,confirmed,created_by,currency
    )
    select v_tx.id,invoice_id,null,round(amount,v_minor_units),p_confidence,true,v_user,v_tx.currency$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank direct allocation currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'      ''payment_id'', v_payment.id,\n      ''confidence'', p_confidence';
  v_replacement:=e'      ''payment_id'', v_payment.id,\n      ''currency'', v_tx.currency,\n'
    || e'      ''payment_currency'', v_payment.currency,\n'
    || e'      ''settlement_currency'', v_payment.settlement_currency,\n      ''confidence'', p_confidence';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0232: bank audit currency anchor count %',v_count; end if;
  execute replace(v_definition,v_anchor,v_replacement);
end
$patch_bank_match_0232$;

update private.scope_definer_exemptions
set reason='rls-preread-single-unit; 0232 matches only transaction currency or payment settlement currency'
where function_signature='match_bank_transaction(uuid,uuid,uuid,uuid,jsonb,numeric,text)';

update private.tenant_export_registry registry
set exported_columns=case when registry.disposition='exclude' then '{}'::text[] else(
      select array_agg(c.column_name order by c.ordinal_position) from information_schema.columns c
      where c.table_schema='public' and c.table_name=registry.table_name
        and not(c.column_name=any(registry.excluded_columns)))end,
    schema_hash=(select md5(string_agg(c.column_name||':'||c.data_type||':'||c.is_nullable,'|'
      order by c.ordinal_position)) from information_schema.columns c
      where c.table_schema='public' and c.table_name=registry.table_name)
where registry.table_name='payments';

do $assert_0232$
declare v_violations text;
begin
  if not exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='payments' and column_name='bank_currency' and is_generated='ALWAYS') then
    raise exception '0232: generated bank_currency missing'; end if;
  if position('bank_match_currency_mismatch' in(select prosrc from pg_proc where oid=
       'public.match_bank_transaction(uuid,uuid,uuid,uuid,jsonb,numeric,text)'::regprocedure))=0 then
    raise exception '0232: direct cross-currency match is not refused by name'; end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0232 scope failed:\n%',v_violations; end if;
  select string_agg(detail,e'\n' order by detail) into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0232 export failed:\n%',v_violations; end if;
end
$assert_0232$;
