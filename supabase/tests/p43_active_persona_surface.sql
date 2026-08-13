-- P43 -- one active browser surface: owner, office and accountant.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p43_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P43 active persona assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p43_become(p_user_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user_id,
    'role', 'authenticated',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password',
      'timestamp', extract(epoch from clock_timestamp())::bigint
    ))
  )::text, true);
end
$$;

-- Trusted fixtures deliberately include active retired rows. Historical rows remain representable;
-- the browser identity resolvers below are the boundary that makes them unusable product logins.
insert into public.organizations (id, name, status, vat_rate) values
  ('10430000-0000-4000-8000-000000000001', 'P43 tenant', 'active', 18);

insert into auth.users (id, email) values
  ('20430000-0000-4000-8000-000000000001', 'owner-p43@example.test'),
  ('20430000-0000-4000-8000-000000000002', 'office-p43@example.test'),
  ('20430000-0000-4000-8000-000000000003', 'accountant-p43@example.test'),
  ('20430000-0000-4000-8000-000000000004', 'kitchen-history-p43@example.test'),
  ('20430000-0000-4000-8000-000000000005', 'payer-history-p43@example.test'),
  ('20430000-0000-4000-8000-000000000006', 'supplier-history-p43@example.test');

insert into public.suppliers (id, org_id, name, status) values
  ('30430000-0000-4000-8000-000000000001', '10430000-0000-4000-8000-000000000001',
   'P43 supplier', 'active');

insert into public.profiles (id, org_id, full_name, role, active, supplier_id) values
  ('20430000-0000-4000-8000-000000000001', '10430000-0000-4000-8000-000000000001',
   'P43 owner', 'owner', true, null),
  ('20430000-0000-4000-8000-000000000002', '10430000-0000-4000-8000-000000000001',
   'P43 office', 'office', true, null),
  ('20430000-0000-4000-8000-000000000003', '10430000-0000-4000-8000-000000000001',
   'P43 accountant', 'accountant', true, null),
  ('20430000-0000-4000-8000-000000000004', '10430000-0000-4000-8000-000000000001',
   'P43 historical kitchen', 'kitchen', true, null),
  ('20430000-0000-4000-8000-000000000005', '10430000-0000-4000-8000-000000000001',
   'P43 historical payer', 'payer', true, null),
  ('20430000-0000-4000-8000-000000000006', '10430000-0000-4000-8000-000000000001',
   'P43 historical supplier login', 'supplier', true,
   '30430000-0000-4000-8000-000000000001');

insert into public.products (id, org_id, name, unit) values
  ('40430000-0000-4000-8000-000000000001', '10430000-0000-4000-8000-000000000001',
   'P43 product', 'unit');

insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date, available
) values (
  '50430000-0000-4000-8000-000000000001', '10430000-0000-4000-8000-000000000001',
  '30430000-0000-4000-8000-000000000001', '40430000-0000-4000-8000-000000000001',
  10, current_date, true
);

insert into public.purchase_orders (id, org_id, supplier_id, status, created_by) values
  ('70430000-0000-4000-8000-000000000001', '10430000-0000-4000-8000-000000000001',
   '30430000-0000-4000-8000-000000000001', 'ready',
   '20430000-0000-4000-8000-000000000001'),
  ('70430000-0000-4000-8000-000000000002', '10430000-0000-4000-8000-000000000001',
   '30430000-0000-4000-8000-000000000001', 'confirmed',
   '20430000-0000-4000-8000-000000000001');

insert into public.purchase_order_items (
  id, org_id, order_id, product_id, qty, unit_price
) values
  ('71430000-0000-4000-8000-000000000001', '10430000-0000-4000-8000-000000000001',
   '70430000-0000-4000-8000-000000000001', '40430000-0000-4000-8000-000000000001', 2, 10),
  ('71430000-0000-4000-8000-000000000002', '10430000-0000-4000-8000-000000000001',
   '70430000-0000-4000-8000-000000000002', '40430000-0000-4000-8000-000000000001', 3, 10);

insert into public.audit_logs (
  org_id, user_id, action, entity_type, entity_id, new_values, reason
) values (
  '10430000-0000-4000-8000-000000000001', null, 'p43_historical_persona_evidence',
  'profiles', '20430000-0000-4000-8000-000000000006',
  jsonb_build_object('role', 'supplier', 'supplier_id', '30430000-0000-4000-8000-000000000001'),
  'P43 preserves retired-persona evidence'
);

set local role authenticated;

-- Retired rows cannot resolve a browser role or tenant, even when a trusted historical fixture is
-- still marked active. This is the database half of "cannot log in" and fails closed before RLS.
select pg_temp.p43_become('20430000-0000-4000-8000-000000000004');
select pg_temp.p43_assert(public.auth_role() is null and public.auth_org() is null,
  'kitchen resolved a browser identity');
select pg_temp.p43_become('20430000-0000-4000-8000-000000000005');
select pg_temp.p43_assert(public.auth_role() is null and public.auth_org() is null,
  'payer resolved a browser identity');
select pg_temp.p43_become('20430000-0000-4000-8000-000000000006');
select pg_temp.p43_assert(public.auth_role() is null and public.auth_org() is null,
  'supplier resolved a browser identity');

select pg_temp.p43_assert(
  to_regprocedure('public.auth_supplier()') is null
  and to_regprocedure('public.supplier_portal_context()') is null
  and to_regprocedure('public.supplier_price_upload_authorized(uuid,uuid,uuid)') is null
  and to_regprocedure('public.supplier_price_upload_reservation_active(text,text,uuid)') is null
  and to_regprocedure('public.supplier_price_document_owned(uuid,uuid,uuid)') is null,
  'a retired supplier-login RPC or helper still exists');

-- 0132 keeps three supplier-named service wrappers solely for immutable evidence recovery. They
-- are not a browser surface, and their context guard now requires the exact recovery fence.
select pg_temp.p43_assert(
  not has_function_privilege(
    'authenticated', 'public.begin_supplier_price_interpretation(uuid,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege(
    'authenticated',
    'public.save_supplier_price_interpretation(uuid,uuid,uuid,timestamptz,text,text,text,text,jsonb,jsonb,integer)',
    'EXECUTE')
  and not has_function_privilege(
    'authenticated',
    'public.fail_supplier_price_interpretation(uuid,uuid,uuid,timestamptz,text,text)', 'EXECUTE')
  and pg_get_functiondef(
    'public.assert_supplier_price_interpretation_context(uuid,uuid,uuid)'::regprocedure
  ) like '%and v_historical_recovery and p.role = ''supplier''%',
  'historical supplier evidence recovery is exposed or accepts ordinary active supplier work');

select pg_temp.p43_assert(
  not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname in ('public', 'storage')
      and policyname in (
        'supplier_price_documents_select',
        'supplier_price_document_jobs_select',
        'supplier_price_document_extractions_select',
        'supplier_price_document_interpretations_select',
        'supplier_price_document_annotations_select',
        'supplier_price_document_review_corrections_select',
        'supplier_price_document_type_review_decisions_select',
        'supplier_price_documents_storage_insert',
        'supplier_price_documents_storage_select',
        'supplier_price_documents_storage_delete'
      )
  ),
  'a retired supplier-login policy still exists');

select pg_temp.p43_assert(
  not exists (
    select 1
    from pg_catalog.pg_policy policy
    join pg_catalog.pg_class relation on relation.oid = policy.polrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname in ('public', 'storage')
      and (coalesce(pg_get_expr(policy.polqual, policy.polrelid), '') || ' '
        || coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), ''))
        ~* '''(kitchen|payer|supplier)''::(public\.)?user_role'
  ),
  'an RLS policy still contains a retired persona role');

-- The owner cannot create or activate a retired persona through product RPCs.
select pg_temp.p43_become('20430000-0000-4000-8000-000000000001');
do $$
declare
  retired record;
begin
  for retired in
    select * from (values
      ('20430000-0000-4000-8000-000000000004'::uuid, 'kitchen'::public.user_role, null::uuid),
      ('20430000-0000-4000-8000-000000000005'::uuid, 'payer'::public.user_role, null::uuid),
      ('20430000-0000-4000-8000-000000000006'::uuid, 'supplier'::public.user_role,
       '30430000-0000-4000-8000-000000000001'::uuid)
    ) rows(profile_id, role_name, supplier_id)
  loop
    begin
      perform public.manage_profile_access(
        retired.profile_id, retired.role_name, true, retired.supplier_id,
        'P43 retired activation must fail');
      raise exception 'P43 active persona assertion failed: % was activated', retired.role_name;
    exception when sqlstate '42501' then
      if sqlerrm <> 'account_role_retired' then raise; end if;
    end;
  end loop;

  begin
    perform public.create_invitation('kitchen-p43-new@example.test', 'kitchen');
    raise exception 'P43 active persona assertion failed: kitchen invitation was created';
  exception when sqlstate '42501' then
    if sqlerrm <> 'account_role_retired' then raise; end if;
  end;
  begin
    perform public.create_invitation('payer-p43-new@example.test', 'payer');
    raise exception 'P43 active persona assertion failed: payer invitation was created';
  exception when sqlstate '42501' then
    if sqlerrm <> 'account_role_retired' then raise; end if;
  end;
  begin
    perform public.create_invitation(
      'supplier-p43-new@example.test', 'supplier',
      '30430000-0000-4000-8000-000000000001');
    raise exception 'P43 active persona assertion failed: supplier invitation was created';
  exception when sqlstate '42501' then
    if sqlerrm <> 'account_role_retired' then raise; end if;
  end;
end
$$;

-- Owner financial setup: approved invoice and approved payment request for accountant execution.
select public.create_invoice(
  '60430000-0000-4000-8000-000000000001',
  '30430000-0000-4000-8000-000000000001',
  'P43-INV-1', current_date, 100, 18, 118, null, null, null, null,
  'P43 creates the payable invoice'
);
select public.set_invoice_review_status(
  '60430000-0000-4000-8000-000000000001', 'in_review', 'P43 begins invoice review');
select public.set_invoice_review_status(
  '60430000-0000-4000-8000-000000000001', 'approved', 'P43 approves invoice');
select public.create_payment_request(
  '80430000-0000-4000-8000-000000000001',
  '30430000-0000-4000-8000-000000000001',
  current_date + 7, null, 'pending_approval',
  '[{"invoice_id":"60430000-0000-4000-8000-000000000001","amount":118}]'::jsonb,
  'P43 prepares payment'
);
select public.transition_payment_request(
  '80430000-0000-4000-8000-000000000001', 'approved', 'P43 owner approval');

-- Office keeps procurement, receiving and price maintenance.
select pg_temp.p43_become('20430000-0000-4000-8000-000000000002');
select public.transition_purchase_order_status(
  '70430000-0000-4000-8000-000000000001', 'sent',
  'P43 office sends purchase order', null, null
);
select public.save_goods_receipt(
  '70430000-0000-4000-8000-000000000002',
  '72430000-0000-4000-8000-000000000001',
  true, 'P43 office receipt', false,
  '[{"order_item_id":"71430000-0000-4000-8000-000000000002","qty_received":3,"status":"full","notes":null}]'::jsonb,
  'P43 office records receipt'
);
select public.set_supplier_product_price(
  '50430000-0000-4000-8000-000000000001', 12, current_date, true,
  'P43 office updates price list'
);
select pg_temp.p43_assert(
  (select status = 'sent' from public.purchase_orders
   where id = '70430000-0000-4000-8000-000000000001')
  and (select received_qty = 3 from public.purchase_order_items
       where id = '71430000-0000-4000-8000-000000000002')
  and (select current_price = 12 from public.supplier_products
       where id = '50430000-0000-4000-8000-000000000001'),
  'office lost procurement, receiving or price maintenance');

-- Accountant keeps the narrow financial directory, payment execution and payment-proof upload.
select pg_temp.p43_become('20430000-0000-4000-8000-000000000003');
select pg_temp.p43_assert(
  exists (select 1 from public.financial_supplier_directory
          where id = '30430000-0000-4000-8000-000000000001'),
  'accountant lost the financial supplier directory');
select (public.execute_payment_request(
  '80430000-0000-4000-8000-000000000001', current_date,
  'העברה בנקאית', 'P43-REF-1', null,
  '[{"invoice_id":"60430000-0000-4000-8000-000000000001","credit_id":null,"amount":118}]'::jsonb,
  'P43 accountant executes approved payment'
)->>'payment_id') as p43_payment_id
\gset

insert into storage.objects (bucket_id, name, owner, metadata) values (
  'documents',
  '10430000-0000-4000-8000-000000000001/payment/' || :'p43_payment_id' || '/proof.pdf',
  auth.uid(), jsonb_build_object('mimetype', 'application/pdf', 'size', 128)
);
select public.register_uploaded_document(
  'p43-accountant-proof-key', 'payment', :'p43_payment_id'::uuid,
  '10430000-0000-4000-8000-000000000001/payment/' || :'p43_payment_id' || '/proof.pdf',
  'proof.pdf', 'application/pdf', 'payment_confirmation',
  '30430000-0000-4000-8000-000000000001', current_date
)::text as p43_payment_proof_result
\gset
select pg_temp.p43_assert(
  (select status = 'executed' from public.payment_requests
   where id = '80430000-0000-4000-8000-000000000001')
  and not (:'p43_payment_proof_result'::jsonb ->> 'idempotent')::boolean
  and exists (select 1 from public.documents
              where id = (:'p43_payment_proof_result'::jsonb ->> 'document_id')::uuid
                and entity_type = 'payment'),
  'accountant lost payment execution or payment-proof upload');

-- Cleanup removes no historical vocabulary or evidence.
select pg_temp.p43_assert(
  (select array_agg(enumlabel::text order by enumsortorder)
   from pg_catalog.pg_enum
   where enumtypid = 'public.user_role'::regtype)
    @> array['kitchen', 'payer', 'supplier']
  and (select count(*) = 3 from public.profiles
       where id in (
         '20430000-0000-4000-8000-000000000004',
         '20430000-0000-4000-8000-000000000005',
         '20430000-0000-4000-8000-000000000006'
       ))
  and (select supplier_id = '30430000-0000-4000-8000-000000000001'
       from public.profiles where id = '20430000-0000-4000-8000-000000000006')
  and exists (
    select 1 from public.audit_logs
    where action = 'p43_historical_persona_evidence'
      and new_values ->> 'role' = 'supplier'
  ),
  'historical enum, profile linkage or audit evidence was deleted');

reset role;
rollback;

\echo 'p43_active_persona_surface_passed'
