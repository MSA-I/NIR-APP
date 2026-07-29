-- PLAN-04 reusable document export template and immutable-ledger acceptance.
-- Run against a freshly reset disposable local database after migration 0047.
-- Every fixture is rolled back; the test never writes business data permanently.
\set ON_ERROR_STOP on

begin;

create schema document_export_test;

create function document_export_test.assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'Document export assertion failed: %', p_message;
  end if;
end
$$;

create function document_export_test.extraction_payload(p_text text default 'מסמך יצוא')
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 1,
      'detected_languages', jsonb_build_array('he'),
      'plain_text', p_text,
      'partial', false
    ),
    'blocks', jsonb_build_array(jsonb_build_object(
      'id', 'block-1', 'page', 1, 'type', 'text',
      'bbox', jsonb_build_array(0, 0, 1, 1),
      'text', p_text, 'confidence', 0.95
    )),
    'tables', '[]'::jsonb,
    'marks', '[]'::jsonb
  )
$$;

create function document_export_test.interpretation_payload(p_supplier_id uuid)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document_type', 'invoice',
    'document_type_confidence', 0.97,
    'supplier', jsonb_build_object(
      'suggested_id', p_supplier_id,
      'suggested_name', 'ספק א',
      'confidence', 0.93,
      'evidence_block_ids', jsonb_build_array('block-1')
    ),
    'fields', jsonb_build_array(
      jsonb_build_object(
        'key', 'invoice_number', 'value', 'INV-100', 'confidence', 0.91,
        'evidence_block_ids', jsonb_build_array('block-1')
      ),
      jsonb_build_object(
        'key', 'invoice_date', 'value', '2026-07-29', 'confidence', 0.90,
        'evidence_block_ids', jsonb_build_array('block-1')
      ),
      jsonb_build_object(
        'key', 'approved', 'value', true, 'confidence', 0.89,
        'evidence_block_ids', jsonb_build_array('block-1')
      )
    ),
    'line_items', jsonb_build_array(
      jsonb_build_object(
        'source_row', 1,
        'values', jsonb_build_object('description', 'פריט א', 'amount', 100),
        'evidence_block_ids', jsonb_build_array('block-1')
      ),
      jsonb_build_object(
        'source_row', 2,
        'values', jsonb_build_object('description', 'פריט ב', 'amount', 50),
        'evidence_block_ids', jsonb_build_array('block-1')
      )
    ),
    'suggested_annotations', '[]'::jsonb
  )
$$;

create function document_export_test.contract(
  p_name text,
  p_format text,
  p_document_type text,
  p_supplier_id uuid,
  p_user_id uuid,
  p_source_path text,
  p_type text default 'text',
  p_required boolean default true
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schema_version', '1',
    'name', p_name,
    'format', p_format,
    'scope', jsonb_build_object(
      'document_type', p_document_type,
      'supplier_id', p_supplier_id,
      'user_id', p_user_id
    ),
    'columns', jsonb_build_array(jsonb_build_object(
      'key', 'value',
      'label', 'ערך',
      'source_path', p_source_path,
      'type', p_type,
      'required', p_required
    ))
  )
$$;

grant usage on schema document_export_test to authenticated, service_role;
grant execute on function document_export_test.contract(
  text, text, text, uuid, uuid, text, text, boolean
) to authenticated, service_role;

-- Schema, tenant keys, RLS, immutable browser surface and RPC boundary.
select document_export_test.assert(
  to_regclass('public.document_export_templates') is not null
    and to_regclass('public.document_export_template_versions') is not null
    and to_regclass('public.document_exports') is not null,
  'one or more PLAN-04 tables are missing'
);

select document_export_test.assert(
  (select bool_and(c.relrowsecurity and c.relforcerowsecurity)
   from pg_class c
   where c.oid = any(array[
     'public.document_export_templates'::regclass,
     'public.document_export_template_versions'::regclass,
     'public.document_exports'::regclass
   ])),
  'RLS and FORCE RLS are not enabled on every PLAN-04 table'
);

select document_export_test.assert(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_export_templates'::regclass
      and pg_get_constraintdef(oid) ilike 'FOREIGN KEY (org_id, supplier_id)%'
  ) and exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_export_template_versions'::regclass
      and pg_get_constraintdef(oid) ilike 'FOREIGN KEY (org_id, template_id)%'
  ) and exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_exports'::regclass
      and pg_get_constraintdef(oid)
        ilike 'FOREIGN KEY (org_id, interpretation_id, extraction_id, document_id)%'
  ) and exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_exports'::regclass
      and pg_get_constraintdef(oid)
        ilike 'FOREIGN KEY (org_id, template_version_id, template_id, format)%'
  ),
  'tenant-composite template/supplier/source foreign keys are incomplete'
);

select document_export_test.assert(
  (select bool_and(
      has_table_privilege('authenticated', format('public.%I', table_name), 'SELECT')
      and not has_table_privilege('authenticated', format('public.%I', table_name), 'INSERT')
      and not has_table_privilege('authenticated', format('public.%I', table_name), 'UPDATE')
      and not has_table_privilege('authenticated', format('public.%I', table_name), 'DELETE')
      and has_table_privilege('service_role', format('public.%I', table_name), 'SELECT')
      and has_table_privilege('service_role', format('public.%I', table_name), 'INSERT')
      and has_table_privilege('service_role', format('public.%I', table_name), 'UPDATE')
      and has_table_privilege('service_role', format('public.%I', table_name), 'DELETE')
    )
   from unnest(array[
     'document_export_templates',
     'document_export_template_versions',
     'document_exports'
   ]) table_name),
  'browser read-only or trusted-server CRUD grants are incorrect'
);

select document_export_test.assert(
  has_function_privilege(
    'authenticated', 'public.propose_document_export_template(uuid,jsonb,text)', 'EXECUTE'
  ) and has_function_privilege(
    'authenticated', 'public.approve_document_export_template_version(uuid,text)', 'EXECUTE'
  ) and has_function_privilege(
    'authenticated', 'public.disable_document_export_template(uuid,text)', 'EXECUTE'
  ) and has_function_privilege(
    'authenticated',
    'public.record_document_export(uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'public.resolve_document_export_template_version(uuid,uuid,text,uuid)',
    'EXECUTE'
  ),
  'RPC grants expose an internal resolver or hide an authenticated command'
);

-- Closed declarative schema: no expressions, formulas, code, prototype paths or ambiguous scopes.
select document_export_test.assert(
  public.document_export_template_contract_valid(document_export_test.contract(
    'חשבונית', 'xlsx', 'invoice', null, null, 'fields.invoice_number'
  ))
    and not public.document_export_template_contract_valid(document_export_test.contract(
      'נוסחה', 'xlsx', 'invoice', null, null, 'fields.amount + 1'
    ))
    and not public.document_export_template_contract_valid(document_export_test.contract(
      'Expression', 'csv', 'invoice', null, null, 'line_items.values.constructor'
    ))
    and not public.document_export_template_contract_valid(
      document_export_test.contract(
        'SQL', 'csv', 'invoice', null, null, 'fields.invoice_number'
      ) || '{"sql":"select current_user"}'::jsonb
    )
    and not public.document_export_template_contract_valid(document_export_test.contract(
      'Scope ambiguity', 'json', 'invoice',
      '37000000-0000-4000-8000-000000000001', null, 'document_type'
    ))
    and not public.document_export_template_contract_valid(document_export_test.contract(
      'Personal global', 'table', null, null,
      '27000000-0000-4000-8000-000000000002', 'document_type'
    ))
    and not public.document_export_template_contract_valid(jsonb_set(
      document_export_test.contract(
        'Noncanonical UUID', 'table', null,
        '37000000-0000-4000-8000-000000000001', null,
        'supplier.suggested_name'
      ),
      '{scope,supplier_id}', '"37000000000040008000000000000001"'::jsonb
    )),
  'TemplateContract accepted executable/ambiguous input or rejected a valid path'
);

-- Two tenants, four tenant-A roles and immutable source/interpretation fixtures.
insert into public.organizations (id, name, status) values
  ('17000000-0000-4000-8000-000000000001', 'Document export tenant A', 'active'),
  ('17000000-0000-4000-8000-000000000002', 'Document export tenant B', 'active');

insert into auth.users (id, email) values
  ('27000000-0000-4000-8000-000000000001', 'export-owner-a@example.test'),
  ('27000000-0000-4000-8000-000000000002', 'export-office-a@example.test'),
  ('27000000-0000-4000-8000-000000000003', 'export-kitchen-a@example.test'),
  ('27000000-0000-4000-8000-000000000004', 'export-accountant-a@example.test'),
  ('27000000-0000-4000-8000-000000000005', 'export-owner-b@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('27000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-000000000001', 'Export owner A', 'owner'),
  ('27000000-0000-4000-8000-000000000002', '17000000-0000-4000-8000-000000000001', 'Export office A', 'office'),
  ('27000000-0000-4000-8000-000000000003', '17000000-0000-4000-8000-000000000001', 'Export kitchen A', 'kitchen'),
  ('27000000-0000-4000-8000-000000000004', '17000000-0000-4000-8000-000000000001', 'Export accountant A', 'accountant'),
  ('27000000-0000-4000-8000-000000000005', '17000000-0000-4000-8000-000000000002', 'Export owner B', 'owner');

insert into public.suppliers (id, org_id, name) values
  ('37000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-000000000001', 'ספק א'),
  ('37000000-0000-4000-8000-000000000002', '17000000-0000-4000-8000-000000000002', 'ספק ב');

insert into storage.objects (bucket_id, name, owner, metadata) values
  (
    'documents',
    '17000000-0000-4000-8000-000000000001/source/invoice-a.pdf',
    '27000000-0000-4000-8000-000000000001',
    jsonb_build_object('mimetype', 'application/pdf', 'eTag', repeat('a', 64))
  ),
  (
    'documents',
    '17000000-0000-4000-8000-000000000002/source/invoice-b.pdf',
    '27000000-0000-4000-8000-000000000005',
    jsonb_build_object('mimetype', 'application/pdf', 'eTag', repeat('b', 64))
  );

insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  document_kind, uploaded_by
) values
  (
    '47000000-0000-4000-8000-000000000001',
    '17000000-0000-4000-8000-000000000001', 'inbox', null,
    '17000000-0000-4000-8000-000000000001/source/invoice-a.pdf',
    'invoice-a.pdf', 'application/pdf', 'other',
    '27000000-0000-4000-8000-000000000001'
  ),
  (
    '47000000-0000-4000-8000-000000000002',
    '17000000-0000-4000-8000-000000000002', 'inbox', null,
    '17000000-0000-4000-8000-000000000002/source/invoice-b.pdf',
    'invoice-b.pdf', 'application/pdf', 'other',
    '27000000-0000-4000-8000-000000000005'
  );

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
) values
  (
    '57000000-0000-4000-8000-000000000001',
    '17000000-0000-4000-8000-000000000001',
    '47000000-0000-4000-8000-000000000001',
    '27000000-0000-4000-8000-000000000001', 'review',
    'etag:' || repeat('a', 64),
    '27000000-0000-4000-8000-000000000002', now()
  ),
  (
    '57000000-0000-4000-8000-000000000002',
    '17000000-0000-4000-8000-000000000002',
    '47000000-0000-4000-8000-000000000002',
    '27000000-0000-4000-8000-000000000005', 'review',
    'etag:' || repeat('b', 64),
    '27000000-0000-4000-8000-000000000005', now()
  );

insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
) values
  (
    '67000000-0000-4000-8000-000000000001',
    '17000000-0000-4000-8000-000000000001',
    '57000000-0000-4000-8000-000000000001',
    '47000000-0000-4000-8000-000000000001',
    'fixture', 'fixture-model', '1.0.0', 'etag:' || repeat('a', 64), '1',
    document_export_test.extraction_payload('חשבונית א')
  ),
  (
    '67000000-0000-4000-8000-000000000002',
    '17000000-0000-4000-8000-000000000002',
    '57000000-0000-4000-8000-000000000002',
    '47000000-0000-4000-8000-000000000002',
    'fixture', 'fixture-model', '1.0.0', 'etag:' || repeat('b', 64), '1',
    document_export_test.extraction_payload('חשבונית ב')
  );

insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
) values
  (
    '77000000-0000-4000-8000-000000000001',
    '17000000-0000-4000-8000-000000000001',
    '57000000-0000-4000-8000-000000000001',
    '67000000-0000-4000-8000-000000000001',
    '47000000-0000-4000-8000-000000000001',
    '27000000-0000-4000-8000-000000000002',
    'fixture', 'fixture-model', 'fixture-prompt-v1', '1',
    document_export_test.interpretation_payload(
      '37000000-0000-4000-8000-000000000001'
    )
  ),
  (
    '77000000-0000-4000-8000-000000000002',
    '17000000-0000-4000-8000-000000000002',
    '57000000-0000-4000-8000-000000000002',
    '67000000-0000-4000-8000-000000000002',
    '47000000-0000-4000-8000-000000000002',
    '27000000-0000-4000-8000-000000000005',
    'fixture', 'fixture-model', 'fixture-prompt-v1', '1',
    document_export_test.interpretation_payload(
      '37000000-0000-4000-8000-000000000002'
    )
  );

-- Organization templates: global, document type and supplier. Owner approves all three.
select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select public.propose_document_export_template(
  null,
  document_export_test.contract(
    'ארגוני כללי', 'table', null, null, null, 'document_type'
  ),
  'יצירת תבנית כללית'
) as version_id
\gset global_
select template_id::text as template_id
from public.document_export_template_versions where id = :'global_version_id'::uuid
\gset global_

select public.propose_document_export_template(
  null,
  document_export_test.contract(
    'ארגוני לחשבונית', 'table', 'invoice', null, null, 'fields.invoice_number'
  ),
  'יצירת תבנית לסוג מסמך'
) as version_id
\gset org_document_
select template_id::text as template_id
from public.document_export_template_versions where id = :'org_document_version_id'::uuid
\gset org_document_

select public.propose_document_export_template(
  null,
  document_export_test.contract(
    'ארגוני לספק', 'table', null,
    '37000000-0000-4000-8000-000000000001', null,
    'supplier.suggested_name'
  ),
  'יצירת תבנית לספק'
) as version_id
\gset org_supplier_
select template_id::text as template_id
from public.document_export_template_versions where id = :'org_supplier_version_id'::uuid
\gset org_supplier_

reset role;

-- Kitchen may propose, but may not approve an organization template.
select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000003', true);
select set_config('document_export_test.global_version_id', :'global_version_id', true);
set local role authenticated;
do $$
begin
  perform public.approve_document_export_template_version(
    current_setting('document_export_test.global_version_id')::uuid,
    'אישור אסור למשתמש מטבח'
  );
  raise exception 'expected organization approval denial';
exception when sqlstate '42501' then
  if sqlerrm <> 'document_export_org_template_not_authorized' then raise; end if;
end
$$;
reset role;

select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000001', true);
set local role authenticated;
select public.approve_document_export_template_version(
  :'global_version_id'::uuid, 'אישור תבנית כללית'
);
select public.approve_document_export_template_version(
  :'org_document_version_id'::uuid, 'אישור תבנית לסוג מסמך'
);
select public.approve_document_export_template_version(
  :'org_supplier_version_id'::uuid, 'אישור תבנית לספק'
);
-- Approval retry is idempotent and does not append another audit event.
select public.approve_document_export_template_version(
  :'global_version_id'::uuid, 'ניסיון חוזר זהה'
);
reset role;

-- Office creates and approves only its own personal document/supplier templates.
select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select public.propose_document_export_template(
  null,
  document_export_test.contract(
    'אישי לחשבונית', 'table', 'invoice', null,
    '27000000-0000-4000-8000-000000000002', 'fields.invoice_date', 'date'
  ),
  'יצירת תבנית אישית לסוג מסמך'
) as version_id
\gset personal_document_
select template_id::text as template_id
from public.document_export_template_versions where id = :'personal_document_version_id'::uuid
\gset personal_document_

select public.propose_document_export_template(
  null,
  document_export_test.contract(
    'אישי לספק', 'table', null,
    '37000000-0000-4000-8000-000000000001',
    '27000000-0000-4000-8000-000000000002',
    'line_items.values.amount', 'number'
  ),
  'יצירת תבנית אישית לספק'
) as version_id
\gset personal_supplier_v1_
select template_id::text as template_id
from public.document_export_template_versions
where id = :'personal_supplier_v1_version_id'::uuid
\gset personal_supplier_

select public.approve_document_export_template_version(
  :'personal_document_version_id'::uuid, 'אישור תבנית אישית לסוג מסמך'
);
select public.approve_document_export_template_version(
  :'personal_supplier_v1_version_id'::uuid, 'אישור תבנית אישית לספק'
);

-- Exact proposal retry returns the same version and does not append version 2.
select public.propose_document_export_template(
  :'personal_supplier_template_id'::uuid,
  document_export_test.contract(
    'אישי לספק', 'table', null,
    '37000000-0000-4000-8000-000000000001',
    '27000000-0000-4000-8000-000000000002',
    'line_items.values.amount', 'number'
  ),
  'ניסיון חוזר זהה'
) as version_id
\gset personal_supplier_retry_
reset role;

select document_export_test.assert(
  :'personal_supplier_retry_version_id'::uuid = :'personal_supplier_v1_version_id'::uuid
    and (select count(*) = 1
         from public.document_export_template_versions
         where template_id = :'personal_supplier_template_id'::uuid),
  'identical proposal retry created a second version'
);

-- Exact precedence: personal supplier > org supplier > personal doc > org doc > org global.
select document_export_test.assert(
  public.resolve_document_export_template_version(
    '17000000-0000-4000-8000-000000000001',
    '27000000-0000-4000-8000-000000000002',
    'invoice', '37000000-0000-4000-8000-000000000001'
  ) = :'personal_supplier_v1_version_id'::uuid
    and public.resolve_document_export_template_version(
      '17000000-0000-4000-8000-000000000001',
      '27000000-0000-4000-8000-000000000003',
      'invoice', '37000000-0000-4000-8000-000000000001'
    ) = :'org_supplier_version_id'::uuid
    and public.resolve_document_export_template_version(
      '17000000-0000-4000-8000-000000000001',
      '27000000-0000-4000-8000-000000000002',
      'invoice', null
    ) = :'personal_document_version_id'::uuid
    and public.resolve_document_export_template_version(
      '17000000-0000-4000-8000-000000000001',
      '27000000-0000-4000-8000-000000000003',
      'invoice', null
    ) = :'org_document_version_id'::uuid
    and public.resolve_document_export_template_version(
      '17000000-0000-4000-8000-000000000001',
      '27000000-0000-4000-8000-000000000003',
      'quote', null
    ) = :'global_version_id'::uuid,
  'the five required precedence tiers are not exact'
);

-- Personal RLS hides office-owned templates and versions from kitchen and owner.
select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000003', true);
set local role authenticated;
select count(*)::text as personal_count
from public.document_export_templates where owner_user_id is not null
\gset kitchen_
select set_config(
  'document_export_test.personal_supplier_template_id',
  :'personal_supplier_template_id', true
);
do $$
begin
  perform public.disable_document_export_template(
    current_setting('document_export_test.personal_supplier_template_id')::uuid,
    'משתמש אחר ניסה להשבית'
  );
  raise exception 'expected personal disable denial';
exception when sqlstate '42501' then
  if sqlerrm <> 'document_export_personal_template_not_owned' then raise; end if;
end
$$;
reset role;

select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000001', true);
set local role authenticated;
select count(*)::text as personal_count
from public.document_export_templates where owner_user_id is not null
\gset owner_
reset role;

select document_export_test.assert(
  :'kitchen_personal_count'::integer = 0 and :'owner_personal_count'::integer = 0,
  'personal template RLS leaked to another user or tenant owner'
);

-- Cross-tenant supplier/source/template contexts fail without changing either tenant.
select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000001', true);
set local role authenticated;
do $$
begin
  perform public.propose_document_export_template(
    null,
    document_export_test.contract(
      'חוצה דייר', 'table', null,
      '37000000-0000-4000-8000-000000000002', null,
      'supplier.suggested_name'
    ),
    'ניסיון חציית דייר'
  );
  raise exception 'expected cross-tenant supplier rejection';
exception when sqlstate 'P0002' then
  if sqlerrm <> 'document_export_supplier_unknown' then raise; end if;
end
$$;

select set_config('document_export_test.global_version_id', :'global_version_id', true);
do $$
begin
  perform public.record_document_export(
    '97000000-0000-4000-8000-000000000099',
    '47000000-0000-4000-8000-000000000002',
    '67000000-0000-4000-8000-000000000002',
    '77000000-0000-4000-8000-000000000002',
    current_setting('document_export_test.global_version_id')::uuid,
    'sha256:' || repeat('9', 64), null, '{"row_count":1}',
    'ניסיון export חוצה דייר'
  );
  raise exception 'expected cross-tenant interpretation rejection';
exception when sqlstate 'P0002' then
  if sqlerrm <> 'document_export_interpretation_unknown' then raise; end if;
end
$$;
reset role;

do $$
begin
  insert into public.document_export_templates (
    org_id, supplier_id, created_by
  ) values (
    '17000000-0000-4000-8000-000000000001',
    '37000000-0000-4000-8000-000000000002',
    '27000000-0000-4000-8000-000000000001'
  );
  raise exception 'expected composite supplier tenant FK rejection';
exception when foreign_key_violation then null;
end
$$;

-- First immutable export uses the approved personal-supplier version.
select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.record_document_export(
  '97000000-0000-4000-8000-000000000001',
  '47000000-0000-4000-8000-000000000001',
  '67000000-0000-4000-8000-000000000001',
  '77000000-0000-4000-8000-000000000001',
  :'personal_supplier_v1_version_id'::uuid,
  'sha256:' || repeat('1', 64), null,
  '{"row_count":2,"column_count":1}'::jsonb,
  'יצירת export טבלאי'
) as export_id
\gset export_v1_

-- Exact retry succeeds without a second row/audit; a conflicting retry is rejected.
select public.record_document_export(
  '97000000-0000-4000-8000-000000000001',
  '47000000-0000-4000-8000-000000000001',
  '67000000-0000-4000-8000-000000000001',
  '77000000-0000-4000-8000-000000000001',
  :'personal_supplier_v1_version_id'::uuid,
  'sha256:' || repeat('1', 64), null,
  '{"row_count":2,"column_count":1}'::jsonb,
  'ניסיון חוזר'
);
select set_config(
  'document_export_test.personal_supplier_v1_version_id',
  :'personal_supplier_v1_version_id', true
);
do $$
begin
  perform public.record_document_export(
    '97000000-0000-4000-8000-000000000001',
    '47000000-0000-4000-8000-000000000001',
    '67000000-0000-4000-8000-000000000001',
    '77000000-0000-4000-8000-000000000001',
    current_setting('document_export_test.personal_supplier_v1_version_id')::uuid,
    'sha256:' || repeat('2', 64), null,
    '{"row_count":2,"column_count":1}'::jsonb,
    'ניסיון חוזר סותר'
  );
  raise exception 'expected idempotency conflict';
exception when unique_violation then
  if sqlerrm <> 'document_export_conflict' then raise; end if;
end
$$;
reset role;

select document_export_test.assert(
  (select count(*) = 1 from public.document_exports
   where id = '97000000-0000-4000-8000-000000000001')
    and (select count(*) = 1 from public.audit_logs
         where action = 'document_export_recorded'
           and entity_id = '97000000-0000-4000-8000-000000000001'),
  'record idempotency duplicated the ledger or its audit event'
);

-- An unapproved version cannot record. Once approved, required and type mismatches still fail.
select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.propose_document_export_template(
  :'personal_supplier_template_id'::uuid,
  document_export_test.contract(
    'אישי לספק חסר', 'table', null,
    '37000000-0000-4000-8000-000000000001',
    '27000000-0000-4000-8000-000000000002',
    'fields.missing', 'text', true
  ),
  'הצעת גרסה עם שדה נדרש'
) as version_id
\gset personal_supplier_v2_

select set_config(
  'document_export_test.personal_supplier_v2_version_id',
  :'personal_supplier_v2_version_id', true
);
do $$
begin
  perform public.record_document_export(
    '97000000-0000-4000-8000-000000000002',
    '47000000-0000-4000-8000-000000000001',
    '67000000-0000-4000-8000-000000000001',
    '77000000-0000-4000-8000-000000000001',
    current_setting('document_export_test.personal_supplier_v2_version_id')::uuid,
    'sha256:' || repeat('3', 64), null, '{"row_count":2}',
    'גרסה טרם אושרה'
  );
  raise exception 'expected unapproved version rejection';
exception when sqlstate '55000' then
  if sqlerrm <> 'document_export_template_not_approved' then raise; end if;
end
$$;

select public.approve_document_export_template_version(
  :'personal_supplier_v2_version_id'::uuid, 'אישור בדיקת שדה נדרש'
);
do $$
begin
  perform public.record_document_export(
    '97000000-0000-4000-8000-000000000002',
    '47000000-0000-4000-8000-000000000001',
    '67000000-0000-4000-8000-000000000001',
    '77000000-0000-4000-8000-000000000001',
    current_setting('document_export_test.personal_supplier_v2_version_id')::uuid,
    'sha256:' || repeat('3', 64), null, '{"row_count":2}',
    'שדה נדרש חסר'
  );
  raise exception 'expected required-value rejection';
exception when sqlstate '22023' then
  if sqlerrm <> 'document_export_input_invalid' then raise; end if;
end
$$;

select public.propose_document_export_template(
  :'personal_supplier_template_id'::uuid,
  document_export_test.contract(
    'אישי לספק טיפוס שגוי', 'table', null,
    '37000000-0000-4000-8000-000000000001',
    '27000000-0000-4000-8000-000000000002',
    'fields.invoice_number', 'number', true
  ),
  'הצעת גרסה עם טיפוס מספר'
) as version_id
\gset personal_supplier_v3_
select public.approve_document_export_template_version(
  :'personal_supplier_v3_version_id'::uuid, 'אישור בדיקת טיפוס'
);
select set_config(
  'document_export_test.personal_supplier_v3_version_id',
  :'personal_supplier_v3_version_id', true
);
do $$
begin
  perform public.record_document_export(
    '97000000-0000-4000-8000-000000000003',
    '47000000-0000-4000-8000-000000000001',
    '67000000-0000-4000-8000-000000000001',
    '77000000-0000-4000-8000-000000000001',
    current_setting('document_export_test.personal_supplier_v3_version_id')::uuid,
    'sha256:' || repeat('4', 64), null, '{"row_count":1}',
    'טיפוס שגוי'
  );
  raise exception 'expected type mismatch rejection';
exception when sqlstate '22023' then
  if sqlerrm <> 'document_export_input_invalid' then raise; end if;
end
$$;

-- Version 4 is valid JSON and becomes the new active version without rewriting export v1.
select public.propose_document_export_template(
  :'personal_supplier_template_id'::uuid,
  document_export_test.contract(
    'אישי לספק JSON', 'json', null,
    '37000000-0000-4000-8000-000000000001',
    '27000000-0000-4000-8000-000000000002',
    'fields.invoice_number', 'text', true
  ),
  'הצעת גרסת JSON תקינה'
) as version_id
\gset personal_supplier_v4_
select public.approve_document_export_template_version(
  :'personal_supplier_v4_version_id'::uuid, 'אישור גרסת JSON'
);

-- JSON pre-registration upload is allowed only at the canonical private export path.
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'documents',
  '17000000-0000-4000-8000-000000000001/exports/97000000-0000-4000-8000-000000000004/export.json',
  '27000000-0000-4000-8000-000000000002',
  '{"mimetype":"application/json"}'::jsonb
);

select public.record_document_export(
  '97000000-0000-4000-8000-000000000004',
  '47000000-0000-4000-8000-000000000001',
  '67000000-0000-4000-8000-000000000001',
  '77000000-0000-4000-8000-000000000001',
  :'personal_supplier_v4_version_id'::uuid,
  'sha256:' || repeat('5', 64),
  '17000000-0000-4000-8000-000000000001/exports/97000000-0000-4000-8000-000000000004/export.json',
  '{"row_count":1,"byte_length":128}'::jsonb,
  'יצירת export JSON'
) as export_id
\gset export_json_

select count(*)::text as visible
from storage.objects
where bucket_id = 'documents'
  and name = '17000000-0000-4000-8000-000000000001/exports/97000000-0000-4000-8000-000000000004/export.json'
\gset office_export_

select public.p0_document_path_registered(
  '17000000-0000-4000-8000-000000000001/exports/97000000-0000-4000-8000-000000000004/export.json'
)::text as registered
\gset registered_

-- An unregistered canonical JSON object remains a recoverable orphan.
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'documents',
  '17000000-0000-4000-8000-000000000001/exports/97000000-0000-4000-8000-000000000005/orphan.json',
  '27000000-0000-4000-8000-000000000002',
  '{"mimetype":"application/json"}'::jsonb
);
select public.p0_document_path_registered(
  '17000000-0000-4000-8000-000000000001/exports/97000000-0000-4000-8000-000000000005/orphan.json'
)::text as registered
\gset orphan_
reset role;

select document_export_test.assert(
  :'office_export_visible'::integer = 1
    and :'registered_registered'::boolean
    and not :'orphan_registered'::boolean
    and exists (
      select 1
      from pg_policy
      where polrelid = 'storage.objects'::regclass
        and polname = 'docs_storage_delete'
        and pg_get_expr(polqual, polrelid) like '%p0_document_path_registered%'
    )
    and (select 'application/json' = any(allowed_mime_types)
         from storage.buckets where id = 'documents'),
  'Storage read/delete row backing or JSON MIME registration failed'
);

-- Kitchen still sees the existing source-document object, but not office's personal export.
select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000003', true);
set local role authenticated;
select count(*)::text as visible
from storage.objects
where bucket_id = 'documents'
  and name = '17000000-0000-4000-8000-000000000001/source/invoice-a.pdf'
\gset kitchen_source_
select count(*)::text as visible
from storage.objects
where bucket_id = 'documents'
  and name = '17000000-0000-4000-8000-000000000001/exports/97000000-0000-4000-8000-000000000004/export.json'
\gset kitchen_export_
reset role;

select document_export_test.assert(
  :'kitchen_source_visible'::integer = 1 and :'kitchen_export_visible'::integer = 0,
  'source-document read contract regressed or personal export Storage leaked'
);

-- New versions never mutate historical rows; trusted-server CRUD cannot bypass guards.
select document_export_test.assert(
  (select template_version_id = :'personal_supplier_v1_version_id'::uuid
          and format = 'table'
          and content_checksum = 'sha256:' || repeat('1', 64)
   from public.document_exports
   where id = '97000000-0000-4000-8000-000000000001')
    and (select active_version_id = :'personal_supplier_v4_version_id'::uuid
         from public.document_export_templates
         where id = :'personal_supplier_template_id'::uuid),
  'new version rewrote historical export or failed to become active'
);

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'document_export_test.personal_supplier_v1_version_id',
  :'personal_supplier_v1_version_id', true
);
set local role service_role;
do $$
begin
  update public.document_export_template_versions
  set contract = jsonb_set(contract, '{name}', '"mutated"')
  where id = current_setting('document_export_test.personal_supplier_v1_version_id')::uuid;
  raise exception 'expected immutable template-version rejection';
exception when sqlstate '42501' then
  if sqlerrm <> 'document_export_template_version_immutable' then raise; end if;
end
$$;
do $$
begin
  update public.document_exports set content_checksum = 'sha256:' || repeat('f', 64)
  where id = '97000000-0000-4000-8000-000000000001';
  raise exception 'expected immutable export update rejection';
exception when sqlstate '42501' then
  if sqlerrm <> 'document_export_immutable' then raise; end if;
end
$$;
do $$
begin
  delete from public.document_exports
  where id = '97000000-0000-4000-8000-000000000001';
  raise exception 'expected immutable export delete rejection';
exception when sqlstate '42501' then
  if sqlerrm <> 'document_export_immutable' then raise; end if;
end
$$;
reset role;

-- Personal owner may disable; history and exact retry remain readable/idempotent afterwards.
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.disable_document_export_template(
  :'personal_supplier_template_id'::uuid, 'המשתמש השבית את התבנית האישית'
);
select public.disable_document_export_template(
  :'personal_supplier_template_id'::uuid, 'ניסיון השבתה חוזר'
);
select public.record_document_export(
  '97000000-0000-4000-8000-000000000001',
  '47000000-0000-4000-8000-000000000001',
  '67000000-0000-4000-8000-000000000001',
  '77000000-0000-4000-8000-000000000001',
  :'personal_supplier_v1_version_id'::uuid,
  'sha256:' || repeat('1', 64), null,
  '{"row_count":2,"column_count":1}'::jsonb,
  'ניסיון חוזר היסטורי'
);
select count(*)::text as export_visible
from public.document_exports
where id in (
  '97000000-0000-4000-8000-000000000001',
  '97000000-0000-4000-8000-000000000004'
)
\gset disabled_
select count(*)::text as storage_visible
from storage.objects
where name = '17000000-0000-4000-8000-000000000001/exports/97000000-0000-4000-8000-000000000004/export.json'
\gset disabled_
reset role;

select document_export_test.assert(
  :'disabled_export_visible'::integer = 2
    and :'disabled_storage_visible'::integer = 1
    and (select not active and active_version_id = :'personal_supplier_v4_version_id'::uuid
         from public.document_export_templates
         where id = :'personal_supplier_template_id'::uuid)
    and (select count(*) = 1 from public.audit_logs
         where action = 'document_export_template_disabled'
           and entity_id = :'personal_supplier_template_id'::uuid),
  'disable erased history, broke exact retry, or duplicated audit'
);

-- Every sensitive command is reasoned and audit-backed.
select document_export_test.assert(
  not exists (
    select 1 from public.audit_logs
    where action like 'document_export_%'
      and nullif(trim(reason), '') is null
  )
    and exists (select 1 from public.audit_logs where action = 'document_export_template_proposed')
    and exists (select 1 from public.audit_logs where action = 'document_export_template_approved')
    and exists (select 1 from public.audit_logs where action = 'document_export_template_disabled')
    and exists (select 1 from public.audit_logs where action = 'document_export_recorded'),
  'reasoned document-export audit lifecycle is incomplete'
);

select 'document_export_templates_passed' as result;

rollback;
