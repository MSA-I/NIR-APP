-- p109 -- a document with no supplier can create one without crossing a tenant, losing its
-- reason, or multiplying the row after a dropped response; the folder reads every unresolved
-- state in one bounded call.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p109_act(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end
$$;

insert into public.organizations (id, name, status) values
  ('10900000-0000-4000-8000-000000000001', 'P109 mine', 'active'),
  ('10900000-0000-4000-8000-000000000002', 'P109 neighbour', 'active');

insert into auth.users (id, email) values
  ('10900000-0000-4000-8000-000000000011', 'owner-p109@example.test'),
  ('10900000-0000-4000-8000-000000000012', 'accountant-p109@example.test'),
  ('10900000-0000-4000-8000-000000000021', 'neighbour-p109@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('10900000-0000-4000-8000-000000000011', '10900000-0000-4000-8000-000000000001', 'P109 owner', 'owner'),
  ('10900000-0000-4000-8000-000000000012', '10900000-0000-4000-8000-000000000001', 'P109 accountant', 'accountant'),
  ('10900000-0000-4000-8000-000000000021', '10900000-0000-4000-8000-000000000002', 'P109 neighbour', 'owner');

insert into public.documents (
  id, org_id, entity_type, storage_path, file_name, mime_type,
  document_kind, uploaded_by
) values
  ('10900000-0000-4000-8000-000000000101', '10900000-0000-4000-8000-000000000001',
   'inbox', '10900000-0000-4000-8000-000000000001/p109-create.pdf', 'p109-create.pdf',
   'application/pdf', 'invoice', '10900000-0000-4000-8000-000000000011'),
  ('10900000-0000-4000-8000-000000000102', '10900000-0000-4000-8000-000000000001',
   'inbox', '10900000-0000-4000-8000-000000000001/p109-unresolved.pdf', 'p109-unresolved.pdf',
   'application/pdf', 'invoice', '10900000-0000-4000-8000-000000000011'),
  ('10900000-0000-4000-8000-000000000201', '10900000-0000-4000-8000-000000000002',
   'inbox', '10900000-0000-4000-8000-000000000002/p109-neighbour.pdf', 'p109-neighbour.pdf',
   'application/pdf', 'invoice', '10900000-0000-4000-8000-000000000021');

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
) values (
  '10900000-0000-4000-8000-000000000301', '10900000-0000-4000-8000-000000000001',
  '10900000-0000-4000-8000-000000000102', '10900000-0000-4000-8000-000000000011',
  'review', 'etag:' || repeat('a', 64), '10900000-0000-4000-8000-000000000011', now()
);

insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
) values (
  '10900000-0000-4000-8000-000000000401', '10900000-0000-4000-8000-000000000001',
  '10900000-0000-4000-8000-000000000301', '10900000-0000-4000-8000-000000000102',
  'fixture', 'fixture', '1', 'etag:' || repeat('a', 64), '1',
  jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object('page_count', 1, 'detected_languages', jsonb_build_array('he'),
      'plain_text', 'P109', 'partial', false),
    'blocks', jsonb_build_array(jsonb_build_object(
      'id', 'block-1', 'page', 1, 'type', 'text',
      'bbox', jsonb_build_array(0, 0, 1, 1), 'text', 'P109', 'confidence', 0.95)),
    'tables', '[]'::jsonb, 'marks', '[]'::jsonb)
);

insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
) values (
  '10900000-0000-4000-8000-000000000501', '10900000-0000-4000-8000-000000000001',
  '10900000-0000-4000-8000-000000000301', '10900000-0000-4000-8000-000000000401',
  '10900000-0000-4000-8000-000000000102', '10900000-0000-4000-8000-000000000011',
  'fixture', 'fixture', 'interpret-document-v10', '1',
  jsonb_build_object(
    'schema_version', '1', 'document_type', 'invoice', 'document_type_confidence', 0.9,
    'supplier', jsonb_build_object(
      'suggested_id', null, 'suggested_name', 'P109 supplier printed but unknown',
      'confidence', 0.8, 'evidence_block_ids', jsonb_build_array('block-1')),
    'fields', '[]'::jsonb, 'line_items', '[]'::jsonb, 'suggested_annotations', '[]'::jsonb)
);

do $suite$
declare
  v_created jsonb;
  v_replayed jsonb;
  v_before_suppliers bigint;
  v_before_audit bigint;
  v_before_commands bigint;
  v_rows bigint;
begin
  if to_regprocedure('public.create_supplier_from_document(uuid,text,text,uuid,text)') is null
     or to_regprocedure('public.get_document_folder_review_states(uuid[])') is null then
    raise exception 'p109.0: document supplier contracts are missing';
  end if;

  -- ===== 1. The owner creates through the document-scoped command =====
  perform pg_temp.p109_act('10900000-0000-4000-8000-000000000011');
  v_created := public.create_supplier_from_document(
    '10900000-0000-4000-8000-000000000101',
    '  P109 created supplier  ', null,
    '10900000-0000-4000-8000-000000000601',
    'P109 human confirmed the supplier while reviewing the document');
  if coalesce((v_created ->> 'idempotent')::boolean, true)
     or v_created ->> 'name' <> 'P109 created supplier' then
    raise exception 'p109.1: the first command did not create the trimmed supplier';
  end if;

  if not exists (
    select 1 from public.suppliers supplier
    where supplier.id = (v_created ->> 'supplier_id')::uuid
      and supplier.org_id = '10900000-0000-4000-8000-000000000001'
      and supplier.name = 'P109 created supplier'
  ) then
    raise exception 'p109.1: the returned supplier is not in the actor tenant';
  end if;
  if not exists (
    select 1 from public.audit_logs audit
    where audit.entity_type = 'suppliers'
      and audit.entity_id = (v_created ->> 'supplier_id')::uuid
      and audit.user_id = '10900000-0000-4000-8000-000000000011'
      and audit.reason = 'P109 human confirmed the supplier while reviewing the document'
  ) then
    raise exception 'p109.1: the supplier audit row lost its actor or reason';
  end if;

  -- ===== 2. A dropped response replays, and a changed payload conflicts =====
  v_replayed := public.create_supplier_from_document(
    '10900000-0000-4000-8000-000000000101',
    'P109 created supplier', null,
    '10900000-0000-4000-8000-000000000601',
    'a replay may carry a different explanatory sentence');
  if not coalesce((v_replayed ->> 'idempotent')::boolean, false)
     or v_replayed ->> 'supplier_id' <> v_created ->> 'supplier_id' then
    raise exception 'p109.2: the replay did not return the first supplier';
  end if;
  if (select count(*) from public.suppliers where name = 'P109 created supplier') <> 1
     or (select count(*) from private.document_supplier_creation_commands
         where idempotency_key = '10900000-0000-4000-8000-000000000601') <> 1 then
    raise exception 'p109.2: replay multiplied a supplier or command row';
  end if;
  begin
    perform public.create_supplier_from_document(
      '10900000-0000-4000-8000-000000000101',
      'P109 changed payload', null,
      '10900000-0000-4000-8000-000000000601', 'P109 conflict');
    raise exception 'p109.2: one idempotency key accepted a changed supplier';
  exception when unique_violation then
    if sqlerrm not like '%supplier_create_idempotency_conflict%' then raise; end if;
  end;

  -- ===== 3. Role, reason and tenant denials write absolutely nothing =====
  select count(*) into v_before_suppliers from public.suppliers;
  select count(*) into v_before_audit from public.audit_logs;
  select count(*) into v_before_commands from private.document_supplier_creation_commands;

  perform pg_temp.p109_act('10900000-0000-4000-8000-000000000012');
  begin
    perform public.create_supplier_from_document(
      '10900000-0000-4000-8000-000000000101', 'P109 denied role', null,
      '10900000-0000-4000-8000-000000000602', 'P109 denied role');
    raise exception 'p109.3: accountant created a supplier';
  exception when insufficient_privilege then
    if sqlerrm not like '%supplier_create_not_authorized%' then raise; end if;
  end;

  perform pg_temp.p109_act('10900000-0000-4000-8000-000000000011');
  begin
    perform public.create_supplier_from_document(
      '10900000-0000-4000-8000-000000000101', 'P109 no reason', null,
      '10900000-0000-4000-8000-000000000603', '   ');
    raise exception 'p109.3: a reasonless command created a supplier';
  exception when invalid_parameter_value then
    if sqlerrm not like '%supplier_create_invalid%' then raise; end if;
  end;
  begin
    perform public.create_supplier_from_document(
      '10900000-0000-4000-8000-000000000201', 'P109 foreign document', null,
      '10900000-0000-4000-8000-000000000604', 'P109 cross tenant attempt');
    raise exception 'p109.3: another tenant document authorized creation';
  exception when no_data_found then
    if sqlerrm not like '%document_not_found%' then raise; end if;
  end;

  if (select count(*) from public.suppliers) <> v_before_suppliers
     or (select count(*) from public.audit_logs) <> v_before_audit
     or (select count(*) from private.document_supplier_creation_commands) <> v_before_commands then
    raise exception 'p109.3: a denied command wrote supplier, audit, or replay state';
  end if;

  -- ===== 4. One bounded folder call returns mine, never the neighbour =====
  perform pg_temp.p109_act('10900000-0000-4000-8000-000000000011');
  select count(*) into v_rows
  from public.get_document_folder_review_states(array[
    '10900000-0000-4000-8000-000000000102'::uuid,
    '10900000-0000-4000-8000-000000000201'::uuid
  ]) state_row
  where state_row.document_id = '10900000-0000-4000-8000-000000000102'
    and state_row.state = 'supplier_unresolved'
    and state_row.suggested_supplier_name = 'P109 supplier printed but unknown';
  if v_rows <> 1 then
    raise exception 'p109.4: the batched read did not return the unresolved own-tenant document';
  end if;
  if exists (
    select 1 from public.get_document_folder_review_states(array[
      '10900000-0000-4000-8000-000000000201'::uuid
    ])
  ) then
    raise exception 'p109.4: the folder read returned another tenant document';
  end if;

  -- Accountant may read the folder state but still may not create the supplier.
  perform pg_temp.p109_act('10900000-0000-4000-8000-000000000012');
  if (select count(*) from public.get_document_folder_review_states(array[
      '10900000-0000-4000-8000-000000000102'::uuid
    ])) <> 1 then
    raise exception 'p109.4: the accountant lost the document state they may review';
  end if;

  -- ===== 5. Door shape and the printed-name provenance =====
  if has_function_privilege('anon',
       'public.create_supplier_from_document(uuid,text,text,uuid,text)', 'execute')
     or has_function_privilege('anon',
       'public.get_document_folder_review_states(uuid[])', 'execute')
     or not has_function_privilege('authenticated',
       'public.create_supplier_from_document(uuid,text,text,uuid,text)', 'execute')
     or not has_function_privilege('authenticated',
       'public.get_document_folder_review_states(uuid[])', 'execute') then
    raise exception 'p109.5: function grants do not match the browser boundary';
  end if;
  perform pg_temp.p109_act('10900000-0000-4000-8000-000000000011');
  if public.get_document_review_assessment('10900000-0000-4000-8000-000000000102')
       #>> '{supplier_resolution,suggested_name}'
     <> 'P109 supplier printed but unknown' then
    raise exception 'p109.5: the review read lost the machine-read supplier name';
  end if;

  raise notice 'p109 passed: five supplier-resolution cases';
end
$suite$;

rollback;
