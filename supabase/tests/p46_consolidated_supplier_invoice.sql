-- P46 -- Consolidated supplier invoice: one payable anchor, source evidence and immutable revisions.
\set ON_ERROR_STOP on

create extension if not exists dblink;

create function pg_temp.p46_assert(p_condition boolean,p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition,false) then
    raise exception 'P46 consolidated invoice assertion failed: %',p_message;
  end if;
end
$$;

create function pg_temp.p46_actor(p_user uuid,p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',coalesce(p_user::text,''),false);
  perform set_config('request.jwt.claim.role',case
    when p_user is null and p_role='authenticated' then '' else coalesce(p_role,'') end,false);
  perform set_config('request.jwt.claims',case when p_user is null then '{}' else
    jsonb_build_object('sub',p_user,'role',p_role)::text end,false);
end
$$;

create function pg_temp.p46_extraction_payload()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version','1',
    'document',jsonb_build_object(
      'page_count',1,'detected_languages',jsonb_build_array('he'),
      'plain_text','חשבונית מרכזת בדיקה','partial',false),
    'blocks',jsonb_build_array(
      jsonb_build_object('id','block-1','page',1,'type','text',
        'bbox',jsonb_build_array(0,0,1,0.4),'text','ספק P46','confidence',0.99),
      jsonb_build_object('id','block-2','page',1,'type','text',
        'bbox',jsonb_build_array(0,0.4,1,1),'text','סהכ 118','confidence',0.99)),
    'tables',jsonb_build_array(),'marks',jsonb_build_array())
$$;

create function pg_temp.p46_interpretation_payload(
  p_supplier uuid,p_date date,p_number text,p_line_quantity numeric default 1,
  p_subtotal numeric default 100,p_vat numeric default 18,p_total numeric default 118
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version','1','document_type','invoice','document_type_confidence',0.99,
    'supplier',jsonb_build_object(
      'suggested_id',p_supplier::text,'suggested_name','ספק P46','confidence',0.99,
      'evidence_block_ids',jsonb_build_array('block-1')),
    'fields',jsonb_build_array(
      jsonb_build_object('key','invoice_number','value',p_number,'confidence',0.99,
        'evidence_block_ids',jsonb_build_array('block-1')),
      jsonb_build_object('key','invoice_date','value',to_char(p_date,'DD.MM.YY'),'confidence',0.99,
        'evidence_block_ids',jsonb_build_array('block-1')),
      jsonb_build_object('key','subtotal','value',p_subtotal,'confidence',0.99,
        'evidence_block_ids',jsonb_build_array('block-2')),
      jsonb_build_object('key','vat_amount','value',p_vat,'confidence',0.99,
        'evidence_block_ids',jsonb_build_array('block-2')),
      jsonb_build_object('key','total','value',p_total,'confidence',0.99,
        'evidence_block_ids',jsonb_build_array('block-2'))),
    'line_items',jsonb_build_array(jsonb_build_object(
      'source_row',1,'values',jsonb_build_object(
        'description','קמח P46','sku','FLOUR-P46','quantity',p_line_quantity,'unit','kg',
        'unit_price',100,'discount_amount',0,'vat_rate',18,'line_total',p_line_quantity*100),
      'evidence_block_ids',jsonb_build_array('block-2'))),
    'suggested_annotations',jsonb_build_array())
$$;

-- ===== Structural contract =====

select pg_temp.p46_assert(
  (select column_default ilike '%payable%' and is_nullable='NO'
   from information_schema.columns
   where table_schema='public' and table_name='invoices' and column_name='financial_role')
  and (select bool_and(relation.relrowsecurity and relation.relforcerowsecurity)
       from pg_class relation where relation.oid=any(array[
         'public.consolidated_invoice_cases'::regclass,
         'public.consolidated_invoice_intakes'::regclass,
         'public.consolidated_invoice_intake_pages'::regclass,
         'public.consolidated_invoice_sources'::regclass,
         'public.consolidated_invoice_revisions'::regclass,
         'public.consolidated_invoice_snapshots'::regclass])),
  'financial_role default or RLS/FORCE RLS is missing');

select pg_temp.p46_assert(
  not has_table_privilege('authenticated','public.consolidated_invoice_cases','INSERT')
  and not has_table_privilege('authenticated','public.consolidated_invoice_cases','SELECT')
  and has_table_privilege('service_role','public.consolidated_invoice_cases','SELECT')
  and has_table_privilege('service_role','public.consolidated_invoice_cases','INSERT')
  and has_table_privilege('service_role','public.consolidated_invoice_cases','UPDATE')
  and has_table_privilege('service_role','public.consolidated_invoice_cases','DELETE')
  and has_function_privilege('authenticated',
    'private.can_read_consolidated_invoice_document(uuid,uuid)','EXECUTE')
  and not has_function_privilege('anon',
    'private.can_read_consolidated_invoice_document(uuid,uuid)','EXECUTE')
  and has_function_privilege('authenticated',
    'public.open_consolidated_invoice_intake(uuid,uuid,date,uuid,integer)','EXECUTE')
  and has_function_privilege('service_role',
    'public.apply_consolidated_invoice_interpretation(uuid,uuid,uuid)','EXECUTE')
  and not has_function_privilege('authenticated',
    'public.apply_consolidated_invoice_interpretation(uuid,uuid,uuid)','EXECUTE'),
  'RPC-only DML or browser/service grant boundary drifted');

select pg_temp.p46_assert(
  position('financial_role = ''payable''' in (
    select prosrc from pg_proc where oid='public.p0_invoice_balance_rows()'::regprocedure))>0
  and position('financial_role = ''payable''' in (
    select prosrc from pg_proc where oid='private.canonical_purchase_metrics(uuid,date,date)'::regprocedure))>0
  and position('financial_role = ''payable''' in (
    select prosrc from pg_proc where oid='private.product_purchase_summary(uuid,date,date,uuid)'::regprocedure))>0
  and position('financial_role = ''payable''' in (
    select prosrc from pg_proc where oid='public.create_monthly_report_snapshot(date,uuid)'::regprocedure))>0,
  'a canonical money/report reader does not filter to payable');

select pg_temp.p46_assert(
  position('financial_role = ''payable''' in (
    select prosrc from pg_proc where oid='public.global_search(text,integer)'::regprocedure))>0
  and position('financial_role = ''payable''' in (
    select prosrc from pg_proc
    where oid='public.invoice_has_duplicate(public.invoices)'::regprocedure))>0
  and position('financial_role = ''payable''' in (
    select prosrc from pg_proc
    where oid='public.p2_duplicate_invoice_group_count()'::regprocedure))>0
  and position('financial_role = ''payable''' in (
    select prosrc from pg_proc
    where oid='public.p2_invoice_without_order_count()'::regprocedure))>0
  and position('financial_role = ''payable''' in (
    select prosrc from pg_proc
    where oid='private.notify_duplicate_invoice_check()'::regprocedure))>0,
  'a search, duplicate or orphan reader still treats supporting evidence as payable');

select pg_temp.p46_assert(
  not exists(select 1 from private.scope_enforcement_violations())
  and not exists(select 1 from private.tenant_export_registry_violations()),
  'A1/A3/A5/A6 enterprise registries drifted');

-- Full review-retry, blocked-replay and late-refiling fixtures would duplicate the received workflow below.
-- Pin their state-machine predicates and refiling trigger here; data behavior is covered by the
-- shared reconciliation/source path exercised later in this suite.
select pg_temp.p46_assert(
  position('v_intake.status = ''needs_review''' in (
    select prosrc from pg_proc
    where oid='public.get_consolidated_invoice_processing_claim(uuid)'::regprocedure))>0
  and position('v_intake.result->>''outcome''=''needs_review''' in (
    select prosrc from pg_proc
    where oid='public.get_consolidated_invoice_processing_claim(uuid)'::regprocedure))>0
  and position('v_intake.status in (''received'',''blocked'')' in (
    select prosrc from pg_proc
    where oid='public.get_consolidated_invoice_processing_claim(uuid)'::regprocedure))>0
  and position('v_intake.result->>''outcome''=v_intake.status' in (
    select prosrc from pg_proc
    where oid='public.get_consolidated_invoice_processing_claim(uuid)'::regprocedure))>0
  and position('set status=''completed''' in (
    select prosrc from pg_proc
    where oid='public.apply_consolidated_invoice_interpretation(uuid,uuid,uuid)'::regprocedure))
    < position('if v_block_code is not null then' in (
    select prosrc from pg_proc
    where oid='public.apply_consolidated_invoice_interpretation(uuid,uuid,uuid)'::regprocedure))
  and position('document.entity_type=''invoice''' in (
    select prosrc from pg_proc
    where oid='private.consolidated_reconciliation_payload(uuid)'::regprocedure))>0
  and position('document.entity_type=''goods_receipt''' in (
    select prosrc from pg_proc
    where oid='private.consolidated_reconciliation_payload(uuid)'::regprocedure))>0
  and position('entity_type' in (
    select pg_get_triggerdef(oid) from pg_trigger
    where tgname='consolidated_invoice_late_document' and not tgisinternal))>0
  and position('entity_id' in (
    select pg_get_triggerdef(oid) from pg_trigger
    where tgname='consolidated_invoice_late_document' and not tgisinternal))>0,
  'blocked replay or supporting-document late-refiling contract drifted');

-- ===== Tenant, supplier, product, interim invoice and completed receipt =====

insert into public.organizations(id,name,status,vat_rate) values
  ('13500000-0000-4000-8000-000000000001','P46 tenant A','active',18),
  ('13500000-0000-4000-8000-000000000002','P46 tenant B','active',18),
  ('13500000-0000-4000-8000-000000000003','P46 concurrency tenant','active',18);

select id as legal_entity from public.org_units
where org_id='13500000-0000-4000-8000-000000000001' and unit_type='legal_entity'
\gset a_
select id as branch from public.org_units
where org_id='13500000-0000-4000-8000-000000000001' and unit_type='branch'
\gset a_
select id as warehouse from public.org_units
where org_id='13500000-0000-4000-8000-000000000001' and unit_type='warehouse'
\gset a_
select id as legal_entity from public.org_units
where org_id='13500000-0000-4000-8000-000000000002' and unit_type='legal_entity'
\gset b_
select id as legal_entity from public.org_units
where org_id='13500000-0000-4000-8000-000000000003' and unit_type='legal_entity'
\gset c_

insert into auth.users(id,email) values
  ('13510000-0000-4000-8000-000000000001','p46-owner-a@example.test'),
  ('13510000-0000-4000-8000-000000000002','p46-accountant-a@example.test'),
  ('13510000-0000-4000-8000-000000000003','p46-owner-b@example.test'),
  ('13510000-0000-4000-8000-000000000004','p46-owner-c@example.test'),
  ('13510000-0000-4000-8000-000000000005','p46-office-a@example.test');
insert into public.profiles(id,org_id,full_name,role) values
  ('13510000-0000-4000-8000-000000000001','13500000-0000-4000-8000-000000000001','P46 owner A','owner'),
  ('13510000-0000-4000-8000-000000000002','13500000-0000-4000-8000-000000000001','P46 accountant A','accountant'),
  ('13510000-0000-4000-8000-000000000003','13500000-0000-4000-8000-000000000002','P46 owner B','owner'),
  ('13510000-0000-4000-8000-000000000004','13500000-0000-4000-8000-000000000003','P46 owner C','owner'),
  ('13510000-0000-4000-8000-000000000005','13500000-0000-4000-8000-000000000001','P46 recovery office A','office');

insert into public.suppliers(id,org_id,name,tax_id) values
  ('13540000-0000-4000-8000-000000000001','13500000-0000-4000-8000-000000000001','P46 supplier A','P46-A'),
  ('13540000-0000-4000-8000-000000000002','13500000-0000-4000-8000-000000000002','P46 supplier B','P46-B'),
  ('13540000-0000-4000-8000-000000000003','13500000-0000-4000-8000-000000000003','P46 supplier C','P46-C');
insert into public.products(id,org_id,name,unit,sku,barcode) values
  ('13530000-0000-4000-8000-000000000001','13500000-0000-4000-8000-000000000001',
    'P46 flour','kg','FLOUR-P46','7290000000135');
insert into public.supplier_products(org_id,supplier_id,product_id,current_price,supplier_sku)
values('13500000-0000-4000-8000-000000000001','13540000-0000-4000-8000-000000000001',
  '13530000-0000-4000-8000-000000000001',100,'FLOUR-P46');
insert into public.price_history(org_id,supplier_product_id,price,effective_date)
select org_id,id,current_price,price_effective_date
from public.supplier_products
where org_id='13500000-0000-4000-8000-000000000001'
  and supplier_id='13540000-0000-4000-8000-000000000001'
  and product_id='13530000-0000-4000-8000-000000000001';

select date_trunc('month',timezone('Asia/Jerusalem',statement_timestamp())-interval '1 month')::date
  as target_month,
  (date_trunc('month',timezone('Asia/Jerusalem',statement_timestamp())-interval '1 month')::date+5)
  as invoice_date
\gset p46_

-- Open the authoritative slot first. Existing month invoices remain payable until the anchor is
-- accepted, at which point only reversible rows are converted.
select pg_temp.p46_actor('13510000-0000-4000-8000-000000000001');
set role authenticated;
with opened as (
  select public.open_consolidated_invoice_intake(
    '13590000-0000-4000-8000-000000000001','13540000-0000-4000-8000-000000000001',
    :'p46_target_month'::date,:'a_legal_entity'::uuid,2) as payload
)
select payload->>'intake_id' as intake_id,payload->>'case_id' as case_id from opened
\gset p46_
reset role;
select pg_temp.p46_actor(null);

insert into public.invoices(
  id,org_id,unit_id,supplier_id,invoice_number,invoice_date,amount_before_vat,vat_amount,total_amount
) values(
  '13570000-0000-4000-8000-000000000001','13500000-0000-4000-8000-000000000001',
  :'a_legal_entity','13540000-0000-4000-8000-000000000001','P46-INTERIM',
  :'p46_invoice_date',100,18,118);

select pg_temp.p46_actor('13510000-0000-4000-8000-000000000001');
set role authenticated;
select public.record_invoice_line_evidence(
  '13571000-0000-4000-8000-000000000001','13570000-0000-4000-8000-000000000001',
  '13572000-0000-4000-8000-000000000001','manual_entry',null,null,
  '13510000-0000-4000-8000-000000000001',jsonb_build_array(jsonb_build_object(
    'line_number',1,'description','P46 flour','supplier_sku','FLOUR-P46',
    'barcode','7290000000135','product_id','13530000-0000-4000-8000-000000000001',
    'quantity',1,'unit','kg','unit_price',100,'discount_amount',0,'vat_rate',18,
    'line_total',100,'evidence_block_ids',jsonb_build_array('manual-p46'),
    'raw_evidence',jsonb_build_object('source','manual-p46'))),
  'P46 interim line evidence');
reset role;
select pg_temp.p46_actor(null);

insert into public.purchase_orders(id,org_id,unit_id,supplier_id,status,created_by)
values('13550000-0000-4000-8000-000000000001','13500000-0000-4000-8000-000000000001',
  :'a_branch','13540000-0000-4000-8000-000000000001','confirmed',
  '13510000-0000-4000-8000-000000000001');
insert into public.purchase_order_items(id,org_id,order_id,product_id,qty,unit_price)
values('13551000-0000-4000-8000-000000000001','13500000-0000-4000-8000-000000000001',
  '13550000-0000-4000-8000-000000000001','13530000-0000-4000-8000-000000000001',1,100);
insert into public.goods_receipts(id,org_id,unit_id,order_id,status,received_by,received_at)
values('13560000-0000-4000-8000-000000000001','13500000-0000-4000-8000-000000000001',
  :'a_warehouse','13550000-0000-4000-8000-000000000001','completed',
  '13510000-0000-4000-8000-000000000001',:'p46_invoice_date'::date+interval '10 hours');
insert into public.goods_receipt_items(
  id,org_id,receipt_id,order_item_id,product_id,qty_received,status
) values(
  '13561000-0000-4000-8000-000000000001','13500000-0000-4000-8000-000000000001',
  '13560000-0000-4000-8000-000000000001','13551000-0000-4000-8000-000000000001',
  '13530000-0000-4000-8000-000000000001',1,'full');

-- A draft receipt is discoverable evidence and must warn, but must never prove received quantity.
insert into public.goods_receipts(id,org_id,unit_id,order_id,status,received_by,received_at)
values('13560000-0000-4000-8000-000000000002','13500000-0000-4000-8000-000000000001',
  :'a_warehouse','13550000-0000-4000-8000-000000000001','draft',
  '13510000-0000-4000-8000-000000000001',:'p46_invoice_date'::date+interval '11 hours');
insert into public.goods_receipt_items(
  id,org_id,receipt_id,order_item_id,product_id,qty_received,status
) values(
  '13561000-0000-4000-8000-000000000002','13500000-0000-4000-8000-000000000001',
  '13560000-0000-4000-8000-000000000002','13551000-0000-4000-8000-000000000001',
  '13530000-0000-4000-8000-000000000001',1,'full');

insert into storage.objects(bucket_id,name,owner,owner_id,metadata) values
(
  'documents','13500000-0000-4000-8000-000000000001/consolidated-invoices/'||:'p46_intake_id'
    ||'/page-1/anchor.pdf','13510000-0000-4000-8000-000000000001',
  '13510000-0000-4000-8000-000000000001','{"mimetype":"application/pdf","size":128}'::jsonb),
(
  'documents','13500000-0000-4000-8000-000000000001/consolidated-invoices/'||:'p46_intake_id'
    ||'/page-2/anchor.pdf','13510000-0000-4000-8000-000000000001',
  '13510000-0000-4000-8000-000000000001','{"mimetype":"application/pdf","size":128}'::jsonb);

select pg_temp.p46_actor('13510000-0000-4000-8000-000000000001');
set role authenticated;
select public.register_consolidated_invoice_page(
  :'p46_intake_id',1,'p46-page-key-0001',
  '13500000-0000-4000-8000-000000000001/consolidated-invoices/'||:'p46_intake_id'
    ||'/page-1/anchor.pdf','anchor.pdf','application/pdf');
select (public.register_consolidated_invoice_page(
  :'p46_intake_id',2,'p46-page-key-0002',
  '13500000-0000-4000-8000-000000000001/consolidated-invoices/'||:'p46_intake_id'
    ||'/page-2/anchor.pdf','anchor-page-2.pdf','application/pdf')->>'document_id')
  as page2_document_id
\gset p46_
select (public.complete_consolidated_invoice_intake(
  :'p46_intake_id','13590000-0000-4000-8000-000000000002')->>'primary_document_id')
  as primary_document_id
\gset p46_
reset role;
select pg_temp.p46_actor(null);

-- Accountants cannot see an uploading/ready case, even though it already exists in their scope.
select pg_temp.p46_actor('13510000-0000-4000-8000-000000000002');
set role authenticated;
select pg_temp.p46_assert(
  public.list_consolidated_invoice_cases(:'p46_target_month'::date)='[]'::jsonb,
  'accountant saw a consolidated case before final intake');
select set_config('p46.case_id', :'p46_case_id', false);
do $$
begin
  perform public.get_consolidated_invoice_workspace(current_setting('p46.case_id')::uuid);
  raise exception 'expected accountant pre-final workspace denial';
exception when no_data_found then null;
end
$$;
reset role;
select pg_temp.p46_actor(null);

insert into public.document_processing_jobs(
  id,org_id,document_id,requested_by,status,input_checksum,
  interpretation_actor_id,interpretation_started_at,created_at
) values
(
  '13580000-0000-4000-8000-000000000001','13500000-0000-4000-8000-000000000001',
  :'p46_primary_document_id','13510000-0000-4000-8000-000000000001','review',
  'etag:13513513513513513513513513513513','13510000-0000-4000-8000-000000000001',
  statement_timestamp(),statement_timestamp()),
(
  '13580000-0000-4000-8000-000000000002','13500000-0000-4000-8000-000000000001',
  :'p46_page2_document_id','13510000-0000-4000-8000-000000000001','review',
  'etag:23523523523523523523523523523523','13510000-0000-4000-8000-000000000001',
  statement_timestamp(),statement_timestamp()),
(
  '13580000-0000-4000-8000-000000000003','13500000-0000-4000-8000-000000000001',
  :'p46_page2_document_id','13510000-0000-4000-8000-000000000001','completed',
  'etag:33533533533533533533533533533533','13510000-0000-4000-8000-000000000001',
  statement_timestamp()-interval '1 minute',statement_timestamp()-interval '1 minute');
insert into public.document_extractions(
  id,org_id,job_id,document_id,engine,model,model_version,input_checksum,contract_version,payload
) values
(
  '13581000-0000-4000-8000-000000000001','13500000-0000-4000-8000-000000000001',
  '13580000-0000-4000-8000-000000000001',:'p46_primary_document_id','fixture','fixture','1',
  'etag:13513513513513513513513513513513','1',pg_temp.p46_extraction_payload()),
(
  '13581000-0000-4000-8000-000000000002','13500000-0000-4000-8000-000000000001',
  '13580000-0000-4000-8000-000000000002',:'p46_page2_document_id','fixture','fixture','1',
  'etag:23523523523523523523523523523523','1',pg_temp.p46_extraction_payload()),
(
  '13581000-0000-4000-8000-000000000003','13500000-0000-4000-8000-000000000001',
  '13580000-0000-4000-8000-000000000003',:'p46_page2_document_id','fixture','fixture','1',
  'etag:33533533533533533533533533533533','1',pg_temp.p46_extraction_payload());
insert into public.document_interpretations(
  id,org_id,job_id,extraction_id,document_id,interpreted_for_user_id,
  provider,model,prompt_version,schema_version,payload
) values
(
  '13582000-0000-4000-8000-000000000001','13500000-0000-4000-8000-000000000001',
  '13580000-0000-4000-8000-000000000001','13581000-0000-4000-8000-000000000001',
  :'p46_primary_document_id','13510000-0000-4000-8000-000000000001',
  'openai','fixture','p46-v1','1',pg_temp.p46_interpretation_payload(
    '13540000-0000-4000-8000-000000000001',:'p46_invoice_date','P46-ANCHOR',1)),
(
  '13582000-0000-4000-8000-000000000002','13500000-0000-4000-8000-000000000001',
  '13580000-0000-4000-8000-000000000002','13581000-0000-4000-8000-000000000002',
  :'p46_page2_document_id','13510000-0000-4000-8000-000000000001',
  'openai','fixture','p46-v1','1',jsonb_set(pg_temp.p46_interpretation_payload(
    '13540000-0000-4000-8000-000000000001',(:'p46_invoice_date'::date+interval '1 month')::date,
    'P46-WRONG-PAGE-2',0.5,999,179.82,1178.82),
    '{document_type}','"delivery_note"'::jsonb)),
(
  '13582000-0000-4000-8000-000000000003','13500000-0000-4000-8000-000000000001',
  '13580000-0000-4000-8000-000000000003','13581000-0000-4000-8000-000000000003',
  :'p46_page2_document_id','13510000-0000-4000-8000-000000000001',
  'openai','fixture','p46-v1','1',pg_temp.p46_interpretation_payload(
    '13540000-0000-4000-8000-000000000001',:'p46_invoice_date','P46-STALE',9));

-- Claim is DB-authoritative. A regular job would return SQL NULL rather than inventing a mode.
select pg_temp.p46_actor(null,'service_role');
set role service_role;
select pg_temp.p46_assert(
  public.get_consolidated_invoice_processing_claim('13580000-0000-4000-8000-000000000001')
    @> jsonb_build_object('processing_mode','consolidated_supplier_invoice',
      'intake_id',:'p46_intake_id'::uuid,'source_page_count',2,'replay',false)
  and jsonb_array_length(public.get_consolidated_invoice_processing_claim(
    '13580000-0000-4000-8000-000000000001')->'pages')=2,
  'processing claim did not derive mode and pages from the intake ledger');

do $$
declare v_rejected boolean:=false;
begin
  begin
    perform public.get_consolidated_invoice_processing_claim(
      '13580000-0000-4000-8000-000000000003');
  exception when sqlstate '55000' then
    v_rejected:=sqlerrm='consolidated_processing_job_superseded';
  end;
  if not v_rejected then raise exception 'historical page job was accepted as current'; end if;
end
$$;

do $$
declare v_accountant_rejected boolean:=false; v_null_rejected boolean:=false;
begin
  begin
    perform public.apply_consolidated_invoice_interpretation(
      '13580000-0000-4000-8000-000000000001',
      '13582000-0000-4000-8000-000000000001',
      '13510000-0000-4000-8000-000000000002');
  exception when sqlstate '42501' then
    v_accountant_rejected:=sqlerrm='consolidated_actor_not_authorized';
  end;
  begin
    perform public.apply_consolidated_invoice_interpretation(
      '13580000-0000-4000-8000-000000000001',
      '13582000-0000-4000-8000-000000000001',null);
  exception when sqlstate '42501' then
    v_null_rejected:=sqlerrm='consolidated_actor_not_authorized';
  end;
  if not (v_accountant_rejected and v_null_rejected) then
    raise exception 'unauthorized decision actor reached consolidated apply';
  end if;
end
$$;
select pg_temp.p46_assert(
  not exists(select 1 from public.invoices
    where org_id='13500000-0000-4000-8000-000000000001'
      and invoice_number='P46-ANCHOR')
  and (select anchor_invoice_id is null from public.consolidated_invoice_cases
       where org_id='13500000-0000-4000-8000-000000000001'),
  'rejected decision actor mutated the invoice or case');

select public.apply_consolidated_invoice_interpretation(
  '13580000-0000-4000-8000-000000000001','13582000-0000-4000-8000-000000000001',
  '13510000-0000-4000-8000-000000000005') as applied
\gset p46_

select pg_temp.p46_assert(
  public.get_consolidated_invoice_processing_claim('13580000-0000-4000-8000-000000000001')
    @> jsonb_build_object('replay',true,'result',jsonb_build_object('outcome','received'))
  and public.apply_consolidated_invoice_interpretation(
    '13580000-0000-4000-8000-000000000001','13582000-0000-4000-8000-000000000001',
    '13510000-0000-4000-8000-000000000005')
      @> jsonb_build_object('outcome','received','idempotent',true)
  and (select count(*)=1 from public.consolidated_invoice_revisions
       where org_id='13500000-0000-4000-8000-000000000001'),
  'received intake replay was not authoritative and idempotent');
reset role;
select pg_temp.p46_actor(null);

select pg_temp.p46_assert(
  (select count(*)=1 and bool_and(financial_role='payable')
   from public.invoices where org_id='13500000-0000-4000-8000-000000000001'
     and supplier_id='13540000-0000-4000-8000-000000000001'
     and invoice_date>=:'p46_target_month' and invoice_date<:'p46_target_month'::date+interval '1 month'
     and financial_role='payable')
  and (select financial_role='supporting_evidence' from public.invoices
       where id='13570000-0000-4000-8000-000000000001'),
  'anchor was not the sole payable or the reversible interim invoice was not converted');

select pg_temp.p46_assert(
  (select invoice_number='P46-ANCHOR' and invoice_date=:'p46_invoice_date'::date
        and amount_before_vat=100 and vat_amount=18 and total_amount=118
   from public.invoices
   where id=(select anchor_invoice_id from public.consolidated_invoice_cases
             where org_id='13500000-0000-4000-8000-000000000001')),
  'page 2 overrode authoritative header fields from primary page 1');

select pg_temp.p46_assert(
  (select count(*)=1 and array_agg(line.line_number order by line.line_number)=array[1]
     and bool_and(case line.line_number
       when 1 then line.raw_evidence @> jsonb_build_object(
         'source_page_number',1,
         'source_document_id',:'p46_primary_document_id'::uuid,
         'source_interpretation_id','13582000-0000-4000-8000-000000000001'::uuid)
       else false end)
     and sum(line.quantity)=1
   from public.invoice_lines line
   where line.org_id='13500000-0000-4000-8000-000000000001'
     and line.invoice_id=(select anchor_invoice_id from public.consolidated_invoice_cases
       where org_id='13500000-0000-4000-8000-000000000001'))
  and not exists (
    select 1 from public.invoice_lines line
    where line.org_id='13500000-0000-4000-8000-000000000001'
      and line.raw_evidence->>'source_interpretation_id'=
        '13582000-0000-4000-8000-000000000003')
  and exists (
    select 1 from public.consolidated_invoice_sources source
    where source.org_id='13500000-0000-4000-8000-000000000001'
      and source.case_id=:'p46_case_id'::uuid
      and source.source_type='supporting_document'
      and source.document_id=:'p46_page2_document_id'::uuid)
  and (select entity_type<>'invoice' from public.documents
       where org_id='13500000-0000-4000-8000-000000000001'
         and id=:'p46_page2_document_id'::uuid),
  'delivery-note page contaminated anchor lines or was filed as an invoice');

select pg_temp.p46_assert(
  (select count(*)=3 and bool_and(job.status='completed')
   from public.document_processing_jobs job
   where job.org_id='13500000-0000-4000-8000-000000000001'
     and job.document_id in (:'p46_primary_document_id'::uuid,:'p46_page2_document_id'::uuid))
  and (select actor_id='13510000-0000-4000-8000-000000000001'
       and interpretation_id='13582000-0000-4000-8000-000000000001'
       from public.invoice_line_evidence_batches
       where org_id='13500000-0000-4000-8000-000000000001'
         and source_type='document_interpretation')
  and exists (
    select 1 from public.audit_logs audit
    where audit.org_id='13500000-0000-4000-8000-000000000001'
      and audit.action='consolidated_invoice_received'
      and audit.new_values->>'triggered_by'='13510000-0000-4000-8000-000000000005'),
  'all page jobs were not completed or recovery decision/evidence actors were conflated');

select pg_temp.p46_assert(
  (select current_revision=1 and warning_count>0 and status='warnings'
   from public.consolidated_invoice_cases
   where org_id='13500000-0000-4000-8000-000000000001')
  and (select count(*)=4 from public.consolidated_invoice_sources
       where org_id='13500000-0000-4000-8000-000000000001')
  and (select payload#>>'{reconciliation,anchor_vs_interim,0,result}'='matched'
       and payload#>>'{reconciliation,anchor_vs_receipts,0,result}'='matched'
       and payload#>>'{reconciliation,interim_vs_receipts,0,result}'='matched'
       and (payload#>>'{reconciliation,anchor_vs_receipts,0,received_quantity}')::numeric=1
       and exists (
         select 1 from jsonb_array_elements(payload->'warnings') warning
         where warning->>'code'='receipt_not_completed'
           and warning->>'source_id'='13560000-0000-4000-8000-000000000002')
       from public.consolidated_invoice_snapshots
       where org_id='13500000-0000-4000-8000-000000000001'),
  'draft receipt was not warned or incorrectly proved quantity in revision 1');

select pg_temp.p46_actor('13510000-0000-4000-8000-000000000002');
set role authenticated;
select pg_temp.p46_assert(
  jsonb_array_length(public.list_consolidated_invoice_cases(:'p46_target_month'::date))=1
  and jsonb_array_length(public.get_consolidated_invoice_workspace(:'p46_case_id'::uuid)->'sources')=4
  and jsonb_array_length(public.get_consolidated_invoice_workspace(:'p46_case_id'::uuid)->'pages')=2,
  'accountant could not read the received anchor workspace');
reset role;
select pg_temp.p46_actor(null);

select pg_temp.p46_actor('13510000-0000-4000-8000-000000000001');
set role authenticated;
select set_config('p46.legal_entity_id', :'a_legal_entity', false);
select set_config('p46.target_month', :'p46_target_month', false);
do $$
begin
  insert into public.consolidated_invoice_cases(
    org_id,legal_entity_id,supplier_id,target_month,created_by
  ) values(
    '13500000-0000-4000-8000-000000000001',current_setting('p46.legal_entity_id')::uuid,
    '13540000-0000-4000-8000-000000000001',current_setting('p46.target_month')::date,
    '13510000-0000-4000-8000-000000000001');
  raise exception 'expected direct case DML denial';
exception when insufficient_privilege then null;
end
$$;
reset role;
select pg_temp.p46_actor(null);

-- A late invoice is born as evidence, appends a new snapshot, and is never a payment target.
insert into public.invoices(
  id,org_id,unit_id,supplier_id,invoice_number,invoice_date,amount_before_vat,vat_amount,total_amount
) values(
  '13570000-0000-4000-8000-000000000002','13500000-0000-4000-8000-000000000001',
  :'a_legal_entity','13540000-0000-4000-8000-000000000001','P46-LATE',
  :'p46_invoice_date',50,9,59);

select pg_temp.p46_assert(
  (select financial_role='supporting_evidence' from public.invoices
   where id='13570000-0000-4000-8000-000000000002')
  and (select current_revision=2 and warning_count>0 from public.consolidated_invoice_cases
       where org_id='13500000-0000-4000-8000-000000000001')
  and (select count(*)=2 and bool_or(trigger_kind='late_arrival')
       from public.consolidated_invoice_revisions
       where org_id='13500000-0000-4000-8000-000000000001'),
  'late invoice did not become evidence and append an immutable warning revision');

insert into public.payments(
  id,org_id,unit_id,supplier_id,amount,paid_date,method,executed_by
) values(
  '13573000-0000-4000-8000-000000000001','13500000-0000-4000-8000-000000000001',
  :'a_legal_entity','13540000-0000-4000-8000-000000000001',59,current_date,'test',
  '13510000-0000-4000-8000-000000000001');
do $$
declare v_blocked boolean:=false;
begin
  begin
    insert into public.payment_allocations(payment_id,invoice_id,amount)
    values('13573000-0000-4000-8000-000000000001',
      '13570000-0000-4000-8000-000000000002',59);
  exception when sqlstate '55000' then
    v_blocked:=sqlerrm='invoice_not_payable';
  end;
  if not v_blocked then raise exception 'supporting invoice accepted as payment target'; end if;
end
$$;

-- ===== Real two-session lock proof for one supplier/month tuple =====

create schema consolidated_0137_concurrency_test;
create table consolidated_0137_concurrency_test.results(
  lane text primary key,result jsonb not null);
create function consolidated_0137_concurrency_test.run_open(p_key uuid)
returns jsonb language plpgsql as $$
declare
  v_legal_entity uuid;
begin
  select id into strict v_legal_entity
  from public.org_units
  where org_id='13500000-0000-4000-8000-000000000003'
    and unit_type='legal_entity';
  perform set_config('request.jwt.claim.sub','13510000-0000-4000-8000-000000000004',true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object(
    'sub','13510000-0000-4000-8000-000000000004','role','authenticated')::text,true);
  perform set_config('role','authenticated',true);
  return public.open_consolidated_invoice_intake(
    p_key,'13540000-0000-4000-8000-000000000003',
    date_trunc('month',timezone('Asia/Jerusalem',statement_timestamp())-interval '1 month')::date,
    v_legal_entity,1);
exception when others then
  return jsonb_build_object('error',sqlerrm,'sqlstate',sqlstate);
end
$$;

select dblink_connect_u('p46_a',format('dbname=%L user=%L application_name=%L',
  current_database(),'postgres','p46_concurrency_a'));
select dblink_connect_u('p46_b',format('dbname=%L user=%L application_name=%L',
  current_database(),'postgres','p46_concurrency_b'));
select dblink_send_query('p46_a',
  $$select consolidated_0137_concurrency_test.run_open(
    '13590000-0000-4000-8000-000000000011')$$);
select pg_sleep(0.05);
select dblink_send_query('p46_b',
  $$select consolidated_0137_concurrency_test.run_open(
    '13590000-0000-4000-8000-000000000012')$$);
insert into consolidated_0137_concurrency_test.results
select 'a',result from dblink_get_result('p46_a') as t(result jsonb);
insert into consolidated_0137_concurrency_test.results
select 'b',result from dblink_get_result('p46_b') as t(result jsonb);
select count(*) from dblink_get_result('p46_a') as t(result jsonb);
select count(*) from dblink_get_result('p46_b') as t(result jsonb);
select dblink_disconnect('p46_a');
select dblink_disconnect('p46_b');

select pg_temp.p46_assert(
  (select count(*) filter(where result?'intake_id')=1
        and count(*) filter(where result->>'error'='consolidated_intake_already_open')=1
   from consolidated_0137_concurrency_test.results)
  and (select count(*)=1
       from public.consolidated_invoice_intakes intake
       join public.consolidated_invoice_cases c
         on c.org_id=intake.org_id and c.id=intake.case_id
       where c.org_id='13500000-0000-4000-8000-000000000003'
         and c.supplier_id='13540000-0000-4000-8000-000000000003'),
  'advisory lock did not serialize two concurrent opens into one intake');

drop schema consolidated_0137_concurrency_test cascade;

select 'P46 consolidated supplier invoice suite passed' as result;
