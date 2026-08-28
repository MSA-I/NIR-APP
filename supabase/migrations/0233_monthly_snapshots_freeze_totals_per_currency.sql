-- 0233: immutable monthly snapshots freeze currency on every money row and totals per currency.
-- Existing v1/v2 rows remain byte-for-byte in their JSONB and keep their content_hash; the new
-- base_currency column records ILS for that shekel-only history without rewriting the hash.

create temp table v0233_existing_hashes as
select id,content_hash from public.monthly_report_snapshots;

alter table public.monthly_report_snapshots
  add column base_currency text not null default 'ILS' references public.currencies(code);

do $patch_snapshot_0233$
declare
  v_definition text:=replace(pg_get_functiondef(
    'public.create_monthly_report_snapshot(date,uuid)'::regprocedure),e'\r','');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor:=e'        ''total_amount'', i.total_amount,\n        ''review_status'', i.review_status,';
  v_replacement:=e'        ''total_amount'', i.total_amount,\n        ''currency'', i.currency,\n'
    || '        ''review_status'', i.review_status,';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0233: invoice row currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'        ''amount'', p.amount,\n        ''method'', p.method,';
  v_replacement:=e'        ''amount'', p.amount,\n        ''currency'', p.currency,\n'
    || '        ''method'', p.method,';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0233: payment row currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'        ''amount'', c.amount,\n        ''status'', c.status,';
  v_replacement:=e'        ''amount'', c.amount,\n        ''currency'', c.currency,\n'
    || '        ''status'', c.status,';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0233: credit row currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'        ''amount'', b.amount,\n        ''is_debit'', b.is_debit,';
  v_replacement:=e'        ''amount'', b.amount,\n        ''currency'', b.currency,\n'
    || '        ''is_debit'', b.is_debit,';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0233: bank row currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
      o.name as organization_name,
      u.name as legal_entity_name,$anchor$;
  v_replacement:=$replacement$
      o.name as organization_name,
      o.base_currency as base_currency,
      u.name as legal_entity_name,$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0233: assembled base currency anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
      jsonb_build_object(
        'invoice_count', invoices.row_count,
        'invoice_total', invoices.invoice_total,
        'before_vat_total', invoices.before_vat_total,
        'vat_total', invoices.vat_total,
        'payment_count', payments.row_count,
        'payment_total', payments.payment_total,
        'credit_count', credits.row_count,
        'credit_total', credits.credit_total,
        'exception_count', exceptions.row_count,
        'bank_transaction_count', bank.row_count,
        'bank_total', bank.bank_total,
        'unpaid_invoice_count', invoices.unpaid_count
      ) as totals$anchor$;
  v_replacement:=$replacement$
      jsonb_build_object(
        'invoice_count', invoices.row_count,
        'payment_count', payments.row_count,
        'credit_count', credits.row_count,
        'exception_count', exceptions.row_count,
        'bank_transaction_count', bank.row_count,
        'unpaid_invoice_count', invoices.unpaid_count,
        'by_currency', coalesce((
          select jsonb_agg(jsonb_build_object(
            'currency', codes.currency,
            'invoice_total', coalesce((select sum(i.total_amount) from invoice_source i
              where i.legal_entity_id=p_unit_id and i.currency=codes.currency),0),
            'before_vat_total', coalesce((select sum(i.amount_before_vat) from invoice_source i
              where i.legal_entity_id=p_unit_id and i.currency=codes.currency),0),
            'vat_total', coalesce((select sum(i.vat_amount) from invoice_source i
              where i.legal_entity_id=p_unit_id and i.currency=codes.currency),0),
            'payment_total', coalesce((select sum(p.amount) from payment_source p
              where p.legal_entity_id=p_unit_id and p.currency=codes.currency),0),
            'credit_total', coalesce((select sum(c.amount) from credit_source c
              where c.legal_entity_id=p_unit_id and c.currency=codes.currency),0),
            'bank_total', coalesce((select sum(b.amount) from bank_source b
              where b.legal_entity_ids[1]=p_unit_id and b.currency=codes.currency
                and b.tx_date>=p_month and b.tx_date<(p_month+interval '1 month')::date),0)
          ) order by case when codes.currency=o.base_currency then 0 else 1 end,codes.currency)
          from (
            select i.currency from invoice_source i where i.legal_entity_id=p_unit_id
            union select p.currency from payment_source p where p.legal_entity_id=p_unit_id
            union select c.currency from credit_source c where c.legal_entity_id=p_unit_id
            union select b.currency from bank_source b where b.legal_entity_ids[1]=p_unit_id
              and b.tx_date>=p_month and b.tx_date<(p_month+interval '1 month')::date
          ) codes
        ),'[]'::jsonb)
      ) as totals$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0233: totals map anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'    org_id, unit_id, report_month, version, report_version,\n'
    || '    organization_name, legal_entity_name, created_by, created_by_name, created_at,';
  v_replacement:=e'    org_id, unit_id, report_month, version, report_version, base_currency,\n'
    || '    organization_name, legal_entity_name, created_by, created_by_name, created_at,';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0233: snapshot insert columns anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$
    'monthly-accountant-legal-entity-v2',
    assembled.organization_name,$anchor$;
  v_replacement:=$replacement$
    'monthly-accountant-legal-entity-v3',
    assembled.base_currency,
    assembled.organization_name,$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0233: snapshot version value anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=$anchor$'report_version', 'monthly-accountant-legal-entity-v2',$anchor$;
  v_replacement:=$replacement$'report_version', 'monthly-accountant-legal-entity-v3',$replacement$;
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0233: hash report version anchor count %',v_count; end if;
  v_definition:=replace(v_definition,v_anchor,v_replacement);

  v_anchor:=e'      ''organization_id'', v_org,\n      ''organization_name'', assembled.organization_name,';
  v_replacement:=e'      ''organization_id'', v_org,\n      ''base_currency'', assembled.base_currency,\n'
    || '      ''organization_name'', assembled.organization_name,';
  v_count:=(length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count<>1 then raise exception '0233: hash base currency anchor count %',v_count; end if;
  execute replace(v_definition,v_anchor,v_replacement);
end
$patch_snapshot_0233$;

update private.scope_definer_enforcements enforcement
set body_hash=md5(replace(proc.prosrc,e'\r','')),
    scope_proof='0233 adds currency fields and per-currency totals; the legal-entity, tenant and source-completeness filters remain.'
from pg_proc proc
where proc.oid='public.create_monthly_report_snapshot(date,uuid)'::regprocedure
  and enforcement.function_signature='create_monthly_report_snapshot(date,uuid)';

update private.tenant_export_registry registry
set exported_columns=case when registry.disposition='exclude' then '{}'::text[] else(
      select array_agg(c.column_name order by c.ordinal_position) from information_schema.columns c
      where c.table_schema='public' and c.table_name=registry.table_name
        and not(c.column_name=any(registry.excluded_columns)))end,
    schema_hash=(select md5(string_agg(c.column_name||':'||c.data_type||':'||c.is_nullable,'|'
      order by c.ordinal_position)) from information_schema.columns c
      where c.table_schema='public' and c.table_name=registry.table_name)
where registry.table_name='monthly_report_snapshots';

do $assert_0233$
declare v_violations text;
begin
  if exists(select 1 from v0233_existing_hashes before_row
    join public.monthly_report_snapshots after_row using(id)
    where before_row.content_hash<>after_row.content_hash) then
    raise exception '0233: historical snapshot content_hash changed'; end if;
  if position('''by_currency''' in(select prosrc from pg_proc where oid=
       'public.create_monthly_report_snapshot(date,uuid)'::regprocedure))=0
     or position('monthly-accountant-legal-entity-v3' in(select prosrc from pg_proc where oid=
       'public.create_monthly_report_snapshot(date,uuid)'::regprocedure))=0 then
    raise exception '0233: snapshot command is not v3 per currency'; end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0233 scope failed:\n%',v_violations; end if;
  select string_agg(detail,e'\n' order by detail) into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0233 export failed:\n%',v_violations; end if;
end
$assert_0233$;

drop table v0233_existing_hashes;
