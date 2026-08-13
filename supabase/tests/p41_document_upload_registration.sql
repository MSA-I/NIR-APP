-- Browser document registration is idempotent across response loss and stays behind the
-- existing tenant/RLS/Storage ownership boundary.
\set ON_ERROR_STOP on

create extension if not exists dblink;

create function pg_temp.upload_registration_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'Document upload registration assertion failed: %', p_message;
  end if;
end
$$;

select pg_temp.upload_registration_assert(
  exists (
    select 1 from information_schema.tables
    where table_schema = 'private' and table_name = 'document_upload_registrations'
  )
  and exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'documents'
      and indexname = 'documents_org_storage_path_key'
      and indexdef ilike '%unique%org_id%storage_path%'
  )
  and exists (
    select 1
    from pg_constraint constraint_row
    join pg_class relation on relation.oid = constraint_row.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private'
      and relation.relname = 'document_upload_registrations'
      and constraint_row.contype = 'p'
  )
  and (
    select count(*) = 2
    from pg_constraint constraint_row
    join pg_class relation on relation.oid = constraint_row.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private'
      and relation.relname = 'document_upload_registrations'
      and constraint_row.contype = 'u'
  ),
  'the private stable-key registry or durable-object uniqueness is missing'
);

select pg_temp.upload_registration_assert(
  has_function_privilege(
    'authenticated',
    'public.register_uploaded_document(text,text,uuid,text,text,text,text,uuid,date)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.register_uploaded_document(text,text,uuid,text,text,text,text,uuid,date)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.register_uploaded_document(text,text,uuid,text,text,text,text,uuid,date)',
    'EXECUTE'
  )
  and (
    select prosecdef from pg_proc
    where oid = 'public.register_uploaded_document(text,text,uuid,text,text,text,text,uuid,date)'::regprocedure
  )
  and (
    select coalesce(proconfig, '{}'::text[])
             @> array['search_path=public, pg_temp']::text[]
    from pg_proc
    where oid = 'public.register_uploaded_document(text,text,uuid,text,text,text,text,uuid,date)'::regprocedure
  )
  and not has_table_privilege('authenticated', 'private.document_upload_registrations', 'SELECT')
  and not has_table_privilege('authenticated', 'private.document_upload_registrations', 'INSERT')
  and not has_table_privilege('authenticated', 'private.document_upload_registrations', 'UPDATE')
  and not has_table_privilege('authenticated', 'private.document_upload_registrations', 'DELETE')
  and not has_any_column_privilege('authenticated', 'public.documents', 'INSERT')
  and has_column_privilege('service_role', 'public.documents', 'storage_path', 'INSERT')
  and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'documents'
      and column_name = 'client_upload_key'
  )
  and exists (
    select 1
    from private.scope_definer_enforcements enforcement
    join pg_proc proc
      on proc.oid = 'public.register_uploaded_document(text,text,uuid,text,text,text,text,uuid,date)'::regprocedure
    where enforcement.function_signature = proc.oid::regprocedure::text
      and enforcement.body_hash = md5(replace(proc.prosrc, e'\r', ''))
      and private.sql_has_executable_scope_marker(proc.prosrc)
  ),
  'the definer registration RPC, search_path or private immutable registry boundary is missing'
);

select pg_temp.upload_registration_assert(
  (
    select proargnames = array[
      'p_client_upload_key', 'p_entity_type', 'p_entity_id', 'p_storage_path',
      'p_file_name', 'p_mime_type', 'p_document_kind', 'p_supplier_id', 'p_document_date'
    ]::text[]
    from pg_proc
    where oid = 'public.register_uploaded_document(text,text,uuid,text,text,text,text,uuid,date)'::regprocedure
  ),
  'the PostgREST argument names drifted from the TypeScript registration payload'
);

select pg_temp.upload_registration_assert(
  not exists (select 1 from private.tenant_export_registry_violations())
  and not exists (
    select 1 from private.tenant_export_registry
    where table_name = 'document_upload_registrations'
  ),
  'the private transport registry entered the tenant-business export surface or left A6 drift'
);

insert into public.organizations (id, name, status) values
  ('13100000-0000-4000-8000-000000000001', 'Upload registration tenant A', 'active'),
  ('13100000-0000-4000-8000-000000000002', 'Upload registration tenant B', 'active');

insert into auth.users (id, email) values
  ('13110000-0000-4000-8000-000000000001', 'upload-owner-a@example.test'),
  ('13110000-0000-4000-8000-000000000002', 'upload-owner-b@example.test'),
  ('13110000-0000-4000-8000-000000000003', 'upload-accountant-a@example.test'),
  ('13110000-0000-4000-8000-000000000004', 'upload-office-a@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  (
    '13110000-0000-4000-8000-000000000001',
    '13100000-0000-4000-8000-000000000001',
    'Upload owner A', 'owner'
  ),
  (
    '13110000-0000-4000-8000-000000000002',
    '13100000-0000-4000-8000-000000000002',
    'Upload owner B', 'owner'
  ),
  (
    '13110000-0000-4000-8000-000000000003',
    '13100000-0000-4000-8000-000000000001',
    'Upload accountant A', 'accountant'
  ),
  (
    '13110000-0000-4000-8000-000000000004',
    '13100000-0000-4000-8000-000000000001',
    'Upload office A', 'office'
  );

insert into public.suppliers (id, org_id, name) values (
  '13140000-0000-4000-8000-000000000001',
  '13100000-0000-4000-8000-000000000001',
  'Upload registration supplier'
);

insert into public.payments (
  id, org_id, supplier_id, amount, paid_date, method, reference, executed_by
) values
  (
    '13150000-0000-4000-8000-000000000001',
    '13100000-0000-4000-8000-000000000001',
    '13140000-0000-4000-8000-000000000001',
    118, '2026-08-12', 'bank_transfer', 'P41-ACCOUNTANT-PAYMENT',
    '13110000-0000-4000-8000-000000000003'
  );

insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values
  (
    'documents',
    '13100000-0000-4000-8000-000000000001/inbox/upload-key-0001_invoice.pdf',
    '13110000-0000-4000-8000-000000000001',
    '13110000-0000-4000-8000-000000000001',
    '{"mimetype":"application/pdf","size":8}'::jsonb
  ),
  (
    'documents',
    '13100000-0000-4000-8000-000000000001/inbox/different-object.pdf',
    '13110000-0000-4000-8000-000000000001',
    '13110000-0000-4000-8000-000000000001',
    '{"mimetype":"application/pdf","size":8}'::jsonb
  ),
  (
    'documents',
    '13100000-0000-4000-8000-000000000002/inbox/upload-key-0001_invoice.pdf',
    '13110000-0000-4000-8000-000000000002',
    '13110000-0000-4000-8000-000000000002',
    '{"mimetype":"application/pdf","size":8}'::jsonb
  ),
  (
    'documents',
    '13100000-0000-4000-8000-000000000001/inbox/legacy-key-0002_receipt.pdf',
    '13110000-0000-4000-8000-000000000001',
    '13110000-0000-4000-8000-000000000001',
    '{"mimetype":"application/pdf","size":8}'::jsonb
  ),
  (
    'documents',
    '13100000-0000-4000-8000-000000000001/inbox/retired-key-0004_note.pdf',
    '13110000-0000-4000-8000-000000000001',
    '13110000-0000-4000-8000-000000000001',
    '{"mimetype":"application/pdf","size":8}'::jsonb
  ),
  (
    'documents',
    '13100000-0000-4000-8000-000000000001/inbox/office-key-0005_office.pdf',
    '13110000-0000-4000-8000-000000000004',
    '13110000-0000-4000-8000-000000000004',
    '{"mimetype":"application/pdf","size":8}'::jsonb
  ),
  (
    'documents',
    '13100000-0000-4000-8000-000000000001/payment/13150000-0000-4000-8000-000000000001/accountant-key-0006_proof.pdf',
    '13110000-0000-4000-8000-000000000003',
    '13110000-0000-4000-8000-000000000003',
    '{"mimetype":"application/pdf","size":8}'::jsonb
  ),
  (
    'documents',
    '13100000-0000-4000-8000-000000000001/inbox/race-key-0009_race.pdf',
    '13110000-0000-4000-8000-000000000001',
    '13110000-0000-4000-8000-000000000001',
    '{"mimetype":"application/pdf","size":8}'::jsonb
  );

-- The stable-key RPC is now the mandatory browser boundary. Even an owner presenting a payload
-- that the historical row policy accepts cannot register directly.
begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  insert into public.documents (
    org_id, entity_type, entity_id, storage_path, file_name, mime_type, uploaded_by,
    document_kind, supplier_id, document_date
  ) values (
    '13100000-0000-4000-8000-000000000001', 'inbox', null,
    '13100000-0000-4000-8000-000000000001/inbox/different-object.pdf',
    'direct.pdf', 'application/pdf', '13110000-0000-4000-8000-000000000001',
    'other', null, null
  );
  raise exception 'expected direct document registration denial';
exception when insufficient_privilege then null;
end
$$;
reset role;
commit;

-- Office may register a regular inbox upload.
begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.register_uploaded_document(
  'office-key-0005', 'inbox', null,
  '13100000-0000-4000-8000-000000000001/inbox/office-key-0005_office.pdf',
  'office.pdf', 'application/pdf', 'other', null, null
)::text as result
\gset upload_office_
reset role;
commit;

select pg_temp.upload_registration_assert(
  not (:'upload_office_result'::jsonb ->> 'idempotent')::boolean
  and exists (
    select 1 from public.documents
    where id = (:'upload_office_result'::jsonb ->> 'document_id')::uuid
      and uploaded_by = '13110000-0000-4000-8000-000000000004'
      and entity_type = 'inbox'
  ),
  'office could not register its tenant-owned inbox upload through the RPC'
);

-- Accountant may register only proof for a payment that accountant executed.
begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.register_uploaded_document(
  'accountant-key-0006', 'payment', '13150000-0000-4000-8000-000000000001',
  '13100000-0000-4000-8000-000000000001/payment/13150000-0000-4000-8000-000000000001/accountant-key-0006_proof.pdf',
  'proof.pdf', 'application/pdf', 'payment_confirmation',
  '13140000-0000-4000-8000-000000000001', '2026-08-12'
)::text as result
\gset upload_accountant_
reset role;
commit;

select pg_temp.upload_registration_assert(
  not (:'upload_accountant_result'::jsonb ->> 'idempotent')::boolean
  and exists (
    select 1 from public.documents
    where id = (:'upload_accountant_result'::jsonb ->> 'document_id')::uuid
      and uploaded_by = '13110000-0000-4000-8000-000000000003'
      and entity_type = 'payment'
      and entity_id = '13150000-0000-4000-8000-000000000001'
      and document_kind = 'payment_confirmation'
  ),
  'accountant could not register proof for the payment they executed'
);

-- Simulate a row committed by a pre-0131 browser (or trusted importer) before stable keys existed.
-- The trusted suite fixture has the same durable path and no client key; the RPC must adopt it by
-- exact evidence without restoring a browser INSERT grant.
insert into public.documents (
  org_id, entity_type, entity_id, storage_path, file_name, mime_type, uploaded_by,
  document_kind, supplier_id, document_date
) values (
  '13100000-0000-4000-8000-000000000001', 'inbox', null,
  '13100000-0000-4000-8000-000000000001/inbox/legacy-key-0002_receipt.pdf',
  'receipt.pdf', 'application/pdf', '13110000-0000-4000-8000-000000000001',
  'other', null, null
)
returning id as document_id
\gset upload_legacy_direct_

begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.register_uploaded_document(
  'legacy-key-0002', 'inbox', null,
  '13100000-0000-4000-8000-000000000001/inbox/legacy-key-0002_receipt.pdf',
  'receipt.pdf', 'application/pdf', 'other', null, null
)::text as result
\gset upload_legacy_
reset role;
commit;

select pg_temp.upload_registration_assert(
  (:'upload_legacy_result'::jsonb ->> 'document_id')::uuid
    = :'upload_legacy_direct_document_id'::uuid
  and (:'upload_legacy_result'::jsonb ->> 'idempotent')::boolean
  and exists (
    select 1
    from private.document_upload_registrations registration
    where registration.org_id = '13100000-0000-4000-8000-000000000001'
      and registration.client_upload_key = 'legacy-key-0002'
      and registration.document_id = :'upload_legacy_direct_document_id'::uuid
  )
  and (
    select count(*) = 1
    from public.documents
    where org_id = '13100000-0000-4000-8000-000000000001'
      and storage_path = '13100000-0000-4000-8000-000000000001/inbox/legacy-key-0002_receipt.pdf'
  ),
  'a committed legacy/direct registration was duplicated or returned without adopting its key'
);

-- The adopted path now belongs to exactly one key, and the adopted key to exactly one payload.
begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.register_uploaded_document(
    'different-key-0002', 'inbox', null,
    '13100000-0000-4000-8000-000000000001/inbox/legacy-key-0002_receipt.pdf',
    'receipt.pdf', 'application/pdf', 'other', null, null
  );
  raise exception 'expected same-path different-key conflict';
exception when unique_violation then
  if sqlerrm <> 'document_upload_key_conflict' then raise; end if;
end
$$;
do $$
begin
  perform public.register_uploaded_document(
    'legacy-key-0002', 'inbox', null,
    '13100000-0000-4000-8000-000000000001/inbox/different-object.pdf',
    'receipt.pdf', 'application/pdf', 'other', null, null
  );
  raise exception 'expected adopted-key payload conflict';
exception when unique_violation then
  if sqlerrm <> 'document_upload_key_conflict' then raise; end if;
end
$$;
reset role;
commit;

-- Transaction A commits the registry row. Treat its result as lost: the next client action has
-- only the stable key and original arguments, exactly the HTTP response-loss recovery shape.
begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.register_uploaded_document(
  'upload-key-0001', 'inbox', null,
  '13100000-0000-4000-8000-000000000001/inbox/upload-key-0001_invoice.pdf',
  'invoice.pdf', 'application/pdf', 'other', null, null
);
reset role;
commit;

select document_id
from private.document_upload_registrations
where org_id = '13100000-0000-4000-8000-000000000001'
  and client_upload_key = 'upload-key-0001'
\gset upload_committed_

begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.register_uploaded_document(
  'upload-key-0001', 'inbox', null,
  '13100000-0000-4000-8000-000000000001/inbox/upload-key-0001_invoice.pdf',
  'invoice.pdf', 'application/pdf', 'other', null, null
)::text as result
\gset upload_replay_
reset role;
commit;

select pg_temp.upload_registration_assert(
  (:'upload_replay_result'::jsonb ->> 'document_id')::uuid
    = :'upload_committed_document_id'::uuid
  and (:'upload_replay_result'::jsonb ->> 'idempotent')::boolean
  and (
    select count(*) = 1
    from private.document_upload_registrations
    where org_id = '13100000-0000-4000-8000-000000000001'
      and client_upload_key = 'upload-key-0001'
  )
  and exists (
    select 1 from storage.objects
    where bucket_id = 'documents'
      and name = '13100000-0000-4000-8000-000000000001/inbox/upload-key-0001_invoice.pdf'
  ),
  'response-loss replay duplicated the row, changed its id or deleted the durable object'
);

-- A key remains retired after the row is soft-deleted. The replay lookup locks the row so a
-- concurrent delete cannot slip between the retired check and a successful response.
begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.register_uploaded_document(
  'retired-key-0004', 'inbox', null,
  '13100000-0000-4000-8000-000000000001/inbox/retired-key-0004_note.pdf',
  'note.pdf', 'application/pdf', 'other', null, null
);
reset role;
commit;

update public.documents
set deleted_at = statement_timestamp(),
    deleted_by = '13110000-0000-4000-8000-000000000001'
where id = (
  select registration.document_id
  from private.document_upload_registrations registration
  where registration.org_id = '13100000-0000-4000-8000-000000000001'
    and registration.client_upload_key = 'retired-key-0004'
);

begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.register_uploaded_document(
    'retired-key-0004', 'inbox', null,
    '13100000-0000-4000-8000-000000000001/inbox/retired-key-0004_note.pdf',
    'note.pdf', 'application/pdf', 'other', null, null
  );
  raise exception 'expected retired-key rejection';
exception when unique_violation then
  if sqlerrm <> 'document_upload_key_retired' then raise; end if;
end
$$;
do $$
begin
  perform public.register_uploaded_document(
    'different-key-0004', 'inbox', null,
    '13100000-0000-4000-8000-000000000001/inbox/retired-key-0004_note.pdf',
    'note.pdf', 'application/pdf', 'other', null, null
  );
  raise exception 'expected retired-path alias rejection';
exception when unique_violation then
  if sqlerrm <> 'document_upload_key_retired' then raise; end if;
end
$$;
reset role;
commit;

-- The key identifies exact immutable evidence. Rebinding it to another object or metadata is
-- rejected rather than silently treating a different upload as an idempotent replay.
begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.register_uploaded_document(
    'upload-key-0001', 'inbox', null,
    '13100000-0000-4000-8000-000000000001/inbox/different-object.pdf',
    'invoice.pdf', 'application/pdf', 'other', null, null
  );
  raise exception 'expected stable-key payload conflict';
exception when unique_violation then
  if sqlerrm <> 'document_upload_key_conflict' then raise; end if;
end
$$;
reset role;
commit;

-- The same opaque key is tenant-scoped. Tenant B may register its own object, while its RPC can
-- never name tenant A's object because the existing path/owner RLS predicate still executes.
begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.register_uploaded_document(
    'cross-tenant-key', 'inbox', null,
    '13100000-0000-4000-8000-000000000001/inbox/upload-key-0001_invoice.pdf',
    'invoice.pdf', 'application/pdf', 'other', null, null
  );
  raise exception 'expected cross-tenant storage path rejection';
exception when insufficient_privilege then null;
end
$$;
select public.register_uploaded_document(
  'upload-key-0001', 'inbox', null,
  '13100000-0000-4000-8000-000000000002/inbox/upload-key-0001_invoice.pdf',
  'invoice.pdf', 'application/pdf', 'other', null, null
)::text as result
\gset upload_tenant_b_
reset role;
commit;

select pg_temp.upload_registration_assert(
  not (:'upload_tenant_b_result'::jsonb ->> 'idempotent')::boolean
  and (select count(*) = 2 from private.document_upload_registrations where client_upload_key = 'upload-key-0001')
  and (select count(distinct org_id) = 2 from private.document_upload_registrations where client_upload_key = 'upload-key-0001'),
  'the stable key was global across tenants or tenant B could not register its own object'
);

-- EXECUTE alone is not authority to capture an inbox document. The invoker RPC must keep the
-- existing role/entity RLS boundary, including the accountant's payment-proof-only path.
begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.register_uploaded_document(
    'forbidden-key-0003', 'inbox', null,
    '13100000-0000-4000-8000-000000000001/inbox/different-object.pdf',
    'forbidden.pdf', 'application/pdf', 'other', null, null
  );
  raise exception 'expected accountant inbox registration rejection';
exception when insufficient_privilege then null;
end
$$;
reset role;
commit;

-- Browser roles cannot rewrite or delete the private mapping even when they can update document
-- soft-delete/refiling fields. Policy composition on documents is therefore irrelevant to keys.
begin;
select set_config('request.jwt.claim.sub', '13110000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  update private.document_upload_registrations
  set client_upload_key = 'replacement-key'
  where org_id = '13100000-0000-4000-8000-000000000001'
    and client_upload_key = 'upload-key-0001';
  raise exception 'expected immutable private upload mapping';
exception when insufficient_privilege then null;
end
$$;
reset role;
commit;

-- Two concurrent response paths for the same key/object converge on one document and one private
-- mapping. The loser waits on durable-object uniqueness and returns an idempotent replay.
select dblink_connect(
  'p41_registration_a',
  'host=127.0.0.1 port=5432 dbname=postgres user=supabase_admin password=postgres'
);
select dblink_connect(
  'p41_registration_b',
  'host=127.0.0.1 port=5432 dbname=postgres user=supabase_admin password=postgres'
);
select dblink_exec('p41_registration_a', 'set "request.jwt.claim.sub" = ''13110000-0000-4000-8000-000000000001''');
select dblink_exec('p41_registration_b', 'set "request.jwt.claim.sub" = ''13110000-0000-4000-8000-000000000001''');
select dblink_exec('p41_registration_a', 'set "request.jwt.claim.role" = ''authenticated''');
select dblink_exec('p41_registration_b', 'set "request.jwt.claim.role" = ''authenticated''');
select dblink_exec('p41_registration_a', 'set role authenticated');
select dblink_exec('p41_registration_b', 'set role authenticated');
select dblink_send_query(
  'p41_registration_a',
  $$select public.register_uploaded_document(
    'race-key-0009', 'inbox', null,
    '13100000-0000-4000-8000-000000000001/inbox/race-key-0009_race.pdf',
    'race.pdf', 'application/pdf', 'other', null, null
  )$$
);
select dblink_send_query(
  'p41_registration_b',
  $$select public.register_uploaded_document(
    'race-key-0009', 'inbox', null,
    '13100000-0000-4000-8000-000000000001/inbox/race-key-0009_race.pdf',
    'race.pdf', 'application/pdf', 'other', null, null
  )$$
);
create temp table p41_concurrent_results (caller text primary key, result jsonb not null);
insert into p41_concurrent_results
select 'a', result from dblink_get_result('p41_registration_a') as response(result jsonb);
insert into p41_concurrent_results
select 'b', result from dblink_get_result('p41_registration_b') as response(result jsonb);
select count(*) from dblink_get_result('p41_registration_a') as response(result jsonb);
select count(*) from dblink_get_result('p41_registration_b') as response(result jsonb);
select dblink_disconnect('p41_registration_a');
select dblink_disconnect('p41_registration_b');

select pg_temp.upload_registration_assert(
  (select count(*) = 2 from p41_concurrent_results)
  and (select count(distinct result ->> 'document_id') = 1 from p41_concurrent_results)
  and (select count(*) filter (where (result ->> 'idempotent')::boolean) = 1
       from p41_concurrent_results)
  and (select count(*) = 1 from private.document_upload_registrations
       where org_id = '13100000-0000-4000-8000-000000000001'
         and client_upload_key = 'race-key-0009')
  and (select count(*) = 1 from public.documents
       where org_id = '13100000-0000-4000-8000-000000000001'
         and storage_path = '13100000-0000-4000-8000-000000000001/inbox/race-key-0009_race.pdf'),
  'concurrent same-key registration created aliases or duplicate document rows'
);

select 'p41_document_upload_registration_passed' as result;
