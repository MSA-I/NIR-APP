-- P25 -- tenant offboarding, export checkpoints and external-egress fencing.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p25_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P25 tenant offboarding assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p25_actor(p_user uuid, p_fresh boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user, 'role', 'authenticated',
    'amr', case when p_fresh then jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())
    )) else '[]'::jsonb end
  )::text, true);
end
$$;

create function pg_temp.p25_actor_amr(p_user uuid, p_state text)
returns void language plpgsql as $$
declare
  v_claims jsonb;
  v_timestamp double precision;
begin
  if p_state = 'missing' then
    v_claims := jsonb_build_object('sub', p_user, 'role', 'authenticated');
  elsif p_state in ('stale', 'future', 'fresh') then
    v_timestamp := extract(epoch from clock_timestamp() + case p_state
      when 'stale' then interval '-6 minutes'
      when 'future' then interval '31 seconds'
      else interval '0 seconds'
    end);
    v_claims := jsonb_build_object(
      'sub', p_user, 'role', 'authenticated',
      'amr', jsonb_build_array(jsonb_build_object(
        'method', 'password', 'timestamp', v_timestamp
      ))
    );
  else
    raise exception 'P25 unknown AMR fixture state: %', p_state;
  end if;
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', v_claims::text, true);
end
$$;

create function pg_temp.p25_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end
$$;

create function pg_temp.p25_clear_writers()
returns void language plpgsql as $$
begin
  perform set_config('app.organization_offboarding_writer_org', '', true);
  perform set_config('app.organization_lifecycle_writer', '', true);
end
$$;

create function pg_temp.p25_expect_error(p_sql text, p_fragment text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'P25 expected error containing %, statement succeeded: %', p_fragment, p_sql;
  exception when others then
    if sqlerrm like 'P25 expected error%' or position(p_fragment in sqlerrm) = 0 then
      raise;
    end if;
  end;
end
$$;

create function pg_temp.p25_valid_extraction_payload_of_size(p_target_bytes integer)
returns jsonb language plpgsql immutable as $$
declare
  v_payload jsonb := jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 1,
      'detected_languages', jsonb_build_array('he'),
      'plain_text', 'x',
      'partial', false
    ),
    'blocks', jsonb_build_array(jsonb_build_object(
      'id', 'p25-block', 'page', 1, 'type', 'text',
      'bbox', jsonb_build_array(0, 0, 1, 1), 'text', 'x', 'confidence', 0.91
    )),
    'tables', jsonb_build_array(jsonb_build_object(
      'id', 'p25-table', 'page', 1, 'bbox', jsonb_build_array(0, 0, 1, 1),
      'rows', jsonb_build_array(jsonb_build_array(jsonb_build_object('text', '', 'bbox', null)))
    )),
    'marks', '[]'::jsonb
  );
  v_filler_bytes integer;
begin
  v_filler_bytes := p_target_bytes - octet_length(v_payload::text);
  if v_filler_bytes < 0 then raise exception 'p25_payload_target_too_small'; end if;
  v_payload := jsonb_set(
    v_payload, '{tables,0,rows,0,0,text}', to_jsonb(repeat('x', v_filler_bytes)), false
  );
  if octet_length(v_payload::text) <> p_target_bytes then
    raise exception 'p25_payload_fixture_size_mismatch';
  end if;
  return v_payload;
end
$$;

-- Static machine-enforced contracts.
select pg_temp.p25_assert(
  (select provolatile = 'v' from pg_proc where oid = 'public.organization_write_allowed()'::regprocedure),
  'organization_write_allowed must remain VOLATILE');
select pg_temp.p25_assert(
  position('for key share' in lower(pg_get_functiondef(
    'private.organization_write_allowed_fenced(uuid)'::regprocedure
  ))) > 0,
  'the canonical write predicate does not lock the organization');
select pg_temp.p25_assert(
  not exists (select 1 from private.tenant_export_registry_violations()),
  'the tenant export registry/schema pin has violations');
select pg_temp.p25_assert(
  (select disposition = 'exclude' from private.tenant_export_registry
   where table_name = 'supplier_price_submission_intakes'),
  'transient supplier intake claims must not be exported');
select pg_temp.p25_assert(
  not exists (
    select 1
    from private.tenant_export_registry registry
    join information_schema.columns column_info
      on column_info.table_schema = 'public' and column_info.table_name = registry.table_name
    where registry.disposition = 'include'
      and column_info.column_name ~* '(secret|token|password|credential|p256dh|^auth$)'
      and not (column_info.column_name = any(registry.excluded_columns))
  ),
  'a secret-like public column is exportable');
select pg_temp.p25_assert(
  (select file_size_limit is null
          and allowed_mime_types @> array[
            'application/json', 'text/csv', 'application/octet-stream'
          ]::text[]
   from storage.buckets where id = 'tenant-exports'),
  'tenant-exports bucket cap/MIME contract is wrong');
select pg_temp.p25_assert(
  not has_table_privilege('authenticated', 'private.organization_export_parts', 'SELECT')
  and not has_table_privilege('service_role', 'private.organization_export_parts', 'SELECT')
  and not has_table_privilege('authenticated',
    'private.organization_external_egress_leases', 'SELECT')
  and not has_table_privilege('service_role',
    'private.organization_external_egress_evidence', 'SELECT')
  and not has_table_privilege('authenticated',
    'private.organization_external_egress_evidence', 'SELECT'),
  'private export/egress ledgers leaked table privileges');
select pg_temp.p25_assert(
  not exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and (
        procedure.proname like 'service_%organization_export%'
        or procedure.proname like 'service_%organization_external_egress%'
        or procedure.proname like 'service_%claimed_integration_outbox%'
      )
      and (
        has_function_privilege('public', procedure.oid, 'EXECUTE')
        or has_function_privilege('anon', procedure.oid, 'EXECUTE')
        or has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
      )
  ),
  'a service export/egress function is browser executable');
select pg_temp.p25_assert(
  not exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and (
        procedure.proname like 'service_%organization_export%'
        or procedure.proname like 'service_%organization_external_egress%'
        or procedure.proname like 'service_%claimed_integration_outbox%'
      )
      and not has_function_privilege('service_role', procedure.oid, 'EXECUTE')
  ),
  'a service export/egress function is not service-role executable');
select pg_temp.p25_assert(
  not exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'service_acknowledge_document_processing_download',
        'service_record_document_ocr_evidence',
        'heartbeat_document_processing_job',
        'complete_document_processing_job',
        'fail_document_processing_job',
        'service_recover_document_extraction_from_egress',
        'service_recover_document_interpretation_from_egress'
      )
      and (
        has_function_privilege('public', procedure.oid, 'EXECUTE')
        or has_function_privilege('anon', procedure.oid, 'EXECUTE')
        or has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
        or not has_function_privilege('service_role', procedure.oid, 'EXECUTE')
      )
  ),
  'an OCR attempt/evidence RPC has an unsafe execution grant');
select pg_temp.p25_assert(
  to_regprocedure('public.heartbeat_document_processing_job(uuid,text,integer)') is null
  and to_regprocedure('public.complete_document_processing_job(uuid,text,text,text,text,text,text,jsonb,integer,jsonb)') is null
  and to_regprocedure('public.complete_document_processing_job(uuid,text,uuid,uuid,text,text,text,text,text,jsonb,integer,jsonb)') is null
  and to_regprocedure('public.fail_document_processing_job(uuid,text,text,text)') is null,
  'a pre-egress-binding OCR worker signature remains callable');
select pg_temp.p25_assert(
  not has_table_privilege('public', 'public.webhook_subscriptions', 'SELECT')
  and not has_table_privilege('anon', 'public.webhook_subscriptions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.webhook_subscriptions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.webhook_subscriptions', 'INSERT')
  and not has_table_privilege('authenticated', 'public.webhook_subscriptions', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.webhook_subscriptions', 'DELETE')
  and has_table_privilege('service_role', 'public.webhook_subscriptions', 'SELECT')
  and has_table_privilege('service_role', 'public.webhook_subscriptions', 'INSERT')
  and has_table_privilege('service_role', 'public.webhook_subscriptions', 'UPDATE')
  and has_table_privilege('service_role', 'public.webhook_subscriptions', 'DELETE'),
  'webhook_subscriptions no longer satisfies the Shape-2 trusted-worker ACL');
select pg_temp.p25_assert(
  private.tenant_export_source_logical_name(
    'documents', 'ארגון/מסמכים/חשבונית מקור.pdf'
  ) = 'original-files/documents/ארגון/מסמכים/חשבונית מקור.pdf',
  'safe Hebrew source names were not preserved');
select pg_temp.p25_expect_error(
  $$select private.tenant_export_source_logical_name('documents','tenant/../secret.pdf')$$,
  'tenant_export_source_name_invalid');
select pg_temp.p25_expect_error(
  $$select private.tenant_export_source_logical_name('documents',E'tenant/bad\\name.pdf')$$,
  'tenant_export_source_name_invalid');

-- Three tenants: A is the full campaign, B proves isolation, C proves expired leases do not block.
insert into public.organizations (id, name, status) values
  ('1a250000-0000-4000-8000-000000000001', 'P25 tenant A', 'active'),
  ('1a250000-0000-4000-8000-000000000002', 'P25 tenant B', 'active'),
  ('1a250000-0000-4000-8000-000000000003', 'P25 tenant C', 'active');

insert into auth.users (id, email) values
  ('2a250000-0000-4000-8000-000000000001', 'owner-a-p25@example.test'),
  ('2a250000-0000-4000-8000-000000000002', 'office-a-p25@example.test'),
  ('2a250000-0000-4000-8000-000000000003', 'owner-b-p25@example.test'),
  ('2a250000-0000-4000-8000-000000000004', 'platform-p25@example.test'),
  ('2a250000-0000-4000-8000-000000000005', 'owner-c-p25@example.test'),
  ('2a250000-0000-4000-8000-000000000006', 'accountant-a-p25@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('2a250000-0000-4000-8000-000000000001', '1a250000-0000-4000-8000-000000000001', 'P25 owner A', 'owner'),
  ('2a250000-0000-4000-8000-000000000002', '1a250000-0000-4000-8000-000000000001', 'P25 office A', 'office'),
  ('2a250000-0000-4000-8000-000000000003', '1a250000-0000-4000-8000-000000000002', 'P25 owner B', 'owner'),
  ('2a250000-0000-4000-8000-000000000004', '1a250000-0000-4000-8000-000000000002', 'P25 platform', 'owner'),
  ('2a250000-0000-4000-8000-000000000005', '1a250000-0000-4000-8000-000000000003', 'P25 owner C', 'owner'),
  ('2a250000-0000-4000-8000-000000000006', '1a250000-0000-4000-8000-000000000001', 'P25 accountant A', 'accountant');
insert into public.platform_admins (user_id, note)
values ('2a250000-0000-4000-8000-000000000004', 'P25 platform operator');

insert into public.suppliers (id, org_id, name) values
  ('3a250000-0000-4000-8000-000000000001', '1a250000-0000-4000-8000-000000000001', 'P25 supplier A'),
  ('3a250000-0000-4000-8000-000000000002', '1a250000-0000-4000-8000-000000000002', 'P25 supplier B');
insert into storage.objects (bucket_id, name, metadata) values (
  'documents',
  '1a250000-0000-4000-8000-000000000001/מסמכים/חשבונית מקור.pdf',
  '{"size":321,"mimetype":"application/pdf"}'::jsonb
);

-- Shared workers must skip tenant A after offboarding without starving eligible work in B.
insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  document_kind, uploaded_by
) values
  ('4d250000-0000-4000-8000-000000000001', '1a250000-0000-4000-8000-000000000001',
   'inbox', null, '1a250000-0000-4000-8000-000000000001/p25/worker-a.pdf',
   'worker-a.pdf', 'application/pdf', 'other', '2a250000-0000-4000-8000-000000000001'),
  ('4d250000-0000-4000-8000-000000000002', '1a250000-0000-4000-8000-000000000002',
   'inbox', null, '1a250000-0000-4000-8000-000000000002/p25/worker-b.pdf',
   'worker-b.pdf', 'application/pdf', 'other', '2a250000-0000-4000-8000-000000000003');
insert into storage.objects (bucket_id, name, metadata) values
  ('documents', '1a250000-0000-4000-8000-000000000001/p25/worker-a.pdf',
   jsonb_build_object('size', 100, 'mimetype', 'application/pdf', 'eTag', repeat('a', 64))),
  ('documents', '1a250000-0000-4000-8000-000000000002/p25/worker-b.pdf',
   jsonb_build_object('size', 100, 'mimetype', 'application/pdf', 'eTag', repeat('b', 64)));
insert into storage.objects (bucket_id, name, metadata)
select 'documents',
       '1a250000-0000-4000-8000-000000000001/p25/bulk/object-' || lpad(series::text, 3, '0') || '.pdf',
       jsonb_build_object('size', 10 + series, 'mimetype', 'application/pdf')
from generate_series(1, 75) series;
insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, input_checksum, contract_version, priority
) values
  ('5d250000-0000-4000-8000-000000000001', '1a250000-0000-4000-8000-000000000001',
   '4d250000-0000-4000-8000-000000000001', '2a250000-0000-4000-8000-000000000001',
   'etag:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '1', 1000),
  ('5d250000-0000-4000-8000-000000000002', '1a250000-0000-4000-8000-000000000002',
   '4d250000-0000-4000-8000-000000000002', '2a250000-0000-4000-8000-000000000003',
   'etag:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '1', 999);
insert into public.documents (
  id, org_id, entity_type, storage_path, file_name, mime_type, document_kind, uploaded_by
) values (
  '4d250000-0000-4000-8000-000000000009', '1a250000-0000-4000-8000-000000000001',
  'inbox', '1a250000-0000-4000-8000-000000000001/p25/export-cap.pdf',
  'export-cap.pdf', 'application/pdf', 'other', '2a250000-0000-4000-8000-000000000001'
);
insert into storage.objects (bucket_id, name, metadata) values (
  'documents', '1a250000-0000-4000-8000-000000000001/p25/export-cap.pdf',
  jsonb_build_object('size', 100, 'mimetype', 'application/pdf', 'eTag', repeat('c', 64))
);
insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, input_checksum, contract_version, priority,
  status, attempt_count
) values (
  '5d250000-0000-4000-8000-000000000009', '1a250000-0000-4000-8000-000000000001',
  '4d250000-0000-4000-8000-000000000009', '2a250000-0000-4000-8000-000000000001',
  'etag:' || repeat('c', 64), '1', 1, 'extracted', 1
);
insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload, duration_ms, resource_metadata
) values (
  '5e250000-0000-4000-8000-000000000009', '1a250000-0000-4000-8000-000000000001',
  '5d250000-0000-4000-8000-000000000009', '4d250000-0000-4000-8000-000000000009',
  'p25', 'p25-cap', '1', 'etag:' || repeat('c', 64), '1',
  pg_temp.p25_valid_extraction_payload_of_size(26214400), 1,
  jsonb_build_object('fixture', 'exact-25-mib-source-payload')
);

select vault.create_secret(
  'p25-whatsapp-token-a', 'p25-whatsapp-a', 'P25 tenant A WhatsApp token'
) as whatsapp_secret_a \gset
select vault.create_secret(
  'p25-whatsapp-token-b', 'p25-whatsapp-b', 'P25 tenant B WhatsApp token'
) as whatsapp_secret_b \gset
insert into public.whatsapp_connections (
  org_id, phone_number_id, waba_id, display_phone_number, token_secret_id,
  status, order_template_name, reminder_template_name, language_code
) values
  ('1a250000-0000-4000-8000-000000000001', 'p25-phone-a', 'p25-waba-a',
   '+972500000001', :'whatsapp_secret_a', 'active', 'p25_order', 'p25_reminder', 'he'),
  ('1a250000-0000-4000-8000-000000000002', 'p25-phone-b', 'p25-waba-b',
   '+972500000002', :'whatsapp_secret_b', 'active', 'p25_order', 'p25_reminder', 'he');
insert into public.purchase_orders (id, org_id, supplier_id, status, created_by) values
  ('6d250000-0000-4000-8000-000000000001', '1a250000-0000-4000-8000-000000000001',
   '3a250000-0000-4000-8000-000000000001', 'sent', '2a250000-0000-4000-8000-000000000001'),
  ('6d250000-0000-4000-8000-000000000002', '1a250000-0000-4000-8000-000000000001',
   '3a250000-0000-4000-8000-000000000001', 'sent', '2a250000-0000-4000-8000-000000000001'),
  ('6d250000-0000-4000-8000-000000000003', '1a250000-0000-4000-8000-000000000002',
   '3a250000-0000-4000-8000-000000000002', 'sent', '2a250000-0000-4000-8000-000000000003');
insert into public.whatsapp_order_messages (
  id, org_id, order_id, kind, status, recipient_number, confirm_token_hash,
  attempt_count, lease_expires_at, created_by, created_at
) values
  ('7d250000-0000-4000-8000-000000000001', '1a250000-0000-4000-8000-000000000001',
   '6d250000-0000-4000-8000-000000000001', 'reminder', 'sending', '972500000001',
   repeat('a', 64), 1, statement_timestamp() - interval '1 minute',
   '2a250000-0000-4000-8000-000000000001', statement_timestamp() - interval '3 minutes'),
  ('7d250000-0000-4000-8000-000000000002', '1a250000-0000-4000-8000-000000000001',
   '6d250000-0000-4000-8000-000000000002', 'reminder', 'queued', '972500000001',
   null, 0, null, '2a250000-0000-4000-8000-000000000001',
   statement_timestamp() - interval '2 minutes'),
  ('7d250000-0000-4000-8000-000000000003', '1a250000-0000-4000-8000-000000000002',
   '6d250000-0000-4000-8000-000000000003', 'reminder', 'queued', '972500000002',
   null, 0, null, '2a250000-0000-4000-8000-000000000003',
   statement_timestamp() - interval '1 minute');
insert into public.categories (org_id, name, sort)
select '1a250000-0000-4000-8000-000000000001', 'P25 page row ' || series, series
from generate_series(1, 501) series;
insert into public.categories (org_id, name, sort)
values ('1a250000-0000-4000-8000-000000000002', 'P25 tenant B only', 1);

insert into public.supplier_price_submission_intakes (
  id, org_id, actor_id, supplier_id, submission_id, target_month,
  file_name, storage_path, object_id, object_updated_at, mime_type,
  reason, status, created_at, expires_at
) values
  ('7a250000-0000-4000-8000-000000000001', '1a250000-0000-4000-8000-000000000001',
   '2a250000-0000-4000-8000-000000000001', '3a250000-0000-4000-8000-000000000001',
   '6a250000-0000-4000-8000-000000000001', date '2026-08-01', 'expired.csv',
   '1a250000-0000-4000-8000-000000000001/price-submissions/3a250000-0000-4000-8000-000000000001/6a250000-0000-4000-8000-000000000001/expired.csv',
   '7b250000-0000-4000-8000-000000000001', statement_timestamp() - interval '15 minutes',
   'text/csv', 'P25 expired transient claim', 'claimed',
   statement_timestamp() - interval '20 minutes', statement_timestamp() - interval '10 minutes'),
  ('7a250000-0000-4000-8000-000000000002', '1a250000-0000-4000-8000-000000000001',
   '2a250000-0000-4000-8000-000000000001', '3a250000-0000-4000-8000-000000000001',
   '6a250000-0000-4000-8000-000000000002', date '2026-08-01', 'live.csv',
   '1a250000-0000-4000-8000-000000000001/price-submissions/3a250000-0000-4000-8000-000000000001/6a250000-0000-4000-8000-000000000002/live.csv',
   '7b250000-0000-4000-8000-000000000002', statement_timestamp(),
   'text/csv', 'P25 live transient claim', 'claimed',
   statement_timestamp(), statement_timestamp() + interval '10 minutes');

insert into public.supplier_price_document_upload_reservations (
  document_id, org_id, actor_id, supplier_id, file_name, mime_type,
  storage_path, created_at, expires_at
) values
  ('4a250000-0000-4000-8000-000000000001', '1a250000-0000-4000-8000-000000000001',
   '2a250000-0000-4000-8000-000000000001', '3a250000-0000-4000-8000-000000000001',
   'expired.pdf', 'application/pdf',
   '1a250000-0000-4000-8000-000000000001/supplier/3a250000-0000-4000-8000-000000000001/4a250000-0000-4000-8000-000000000001/expired.pdf',
   statement_timestamp() - interval '2 hours', statement_timestamp() - interval '61 minutes'),
  ('4a250000-0000-4000-8000-000000000002', '1a250000-0000-4000-8000-000000000001',
   '2a250000-0000-4000-8000-000000000001', '3a250000-0000-4000-8000-000000000001',
   'live.pdf', 'application/pdf',
   '1a250000-0000-4000-8000-000000000001/supplier/3a250000-0000-4000-8000-000000000001/4a250000-0000-4000-8000-000000000002/live.pdf',
   statement_timestamp(), statement_timestamp() + interval '15 minutes');

insert into public.domain_events (id, event_type, org_id, entity_type) values
  ('5a250000-0000-4000-8000-000000000001', 'p25.pending', '1a250000-0000-4000-8000-000000000001', 'probe'),
  ('5a250000-0000-4000-8000-000000000002', 'p25.claimed', '1a250000-0000-4000-8000-000000000001', 'probe'),
  ('5a250000-0000-4000-8000-000000000003', 'p25.after', '1a250000-0000-4000-8000-000000000001', 'probe'),
  ('5a250000-0000-4000-8000-000000000004', 'p25.ambiguous', '1a250000-0000-4000-8000-000000000001', 'probe');
insert into private.integration_outbox (
  id, org_id, event_id, target, status, attempt_count, claimed_by, claimed_at, correlation_id
) values
  ('5b250000-0000-4000-8000-000000000001', '1a250000-0000-4000-8000-000000000001',
   '5a250000-0000-4000-8000-000000000001', 'p25-target', 'pending', 0, null, null,
   '5c250000-0000-4000-8000-000000000001'),
  ('5b250000-0000-4000-8000-000000000002', '1a250000-0000-4000-8000-000000000001',
   '5a250000-0000-4000-8000-000000000002', 'p25-target', 'claimed', 1, 'p25-worker',
   statement_timestamp(), '5c250000-0000-4000-8000-000000000002'),
  ('5b250000-0000-4000-8000-000000000004', '1a250000-0000-4000-8000-000000000001',
   '5a250000-0000-4000-8000-000000000004', 'p25-target', 'claimed', 1, 'p25-worker',
   statement_timestamp(), '5c250000-0000-4000-8000-000000000004');

insert into public.notifications (
  id, org_id, user_id, event_code, entity_key, severity,
  title, body, target_url, dedupe_key
) values
  ('8d250000-0000-4000-8000-000000000001', '1a250000-0000-4000-8000-000000000002',
   '2a250000-0000-4000-8000-000000000003', 'p25_push', 'terminal', 'warning',
   'P25 terminal push', 'P25 no delivery', '/alerts', 'p25-push-terminal'),
  ('8d250000-0000-4000-8000-000000000002', '1a250000-0000-4000-8000-000000000002',
   '2a250000-0000-4000-8000-000000000003', 'p25_push', 'retry', 'warning',
   'P25 retry push', 'P25 provider failed', '/alerts', 'p25-push-retry');

-- no_delivery is terminal without claiming provider success; failed remains retryable.
select pg_temp.p25_service();
set local role service_role;
select pg_temp.p25_assert(
  not (public.record_notification_push_delivery_outcome(
    '8d250000-0000-4000-8000-000000000001', 'no_delivery', 'push_endpoints_removed'
  ) ->> 'idempotent')::boolean,
  'first no-delivery outcome was not recorded');
select pg_temp.p25_assert(
  (public.record_notification_push_delivery_outcome(
    '8d250000-0000-4000-8000-000000000001', 'no_delivery', 'push_endpoints_removed'
  ) ->> 'idempotent')::boolean,
  'exact no-delivery replay was not idempotent');
select public.record_notification_push_delivery_outcome(
  '8d250000-0000-4000-8000-000000000002', 'failed', 'provider_timeout'
);
select pg_temp.p25_assert(
  not exists (
    select 1 from public.enqueue_notification_delivery(
      '1a250000-0000-4000-8000-000000000002', 'p25_push', 'terminal', 'warning',
      'P25 terminal push', 'P25 no delivery', '/alerts', 'p25-push-terminal'
    ) delivery
    where delivery.notification_id = '8d250000-0000-4000-8000-000000000001'
  ),
  'terminal no-delivery notification was offered again');
reset role;
select pg_temp.p25_assert(
  (select push_sent_at is null and push_terminal_at is not null
          and push_terminal_reason = 'no_delivery' and push_attempts = 1
   from public.notifications where id = '8d250000-0000-4000-8000-000000000001'),
  'no-delivery outcome fabricated push_sent_at or remained pending');
select pg_temp.p25_assert(
  (select push_sent_at is null and push_terminal_at is null
          and push_terminal_reason is null and push_attempts = 1
   from public.notifications where id = '8d250000-0000-4000-8000-000000000002'),
  'failed push was incorrectly made terminal');

-- Generic egress fencing: same correlation is idempotent, stale tokens fail, and a live lease
-- blocks offboarding. A released or genuinely expired lease does not.
select pg_temp.p25_service();
set local role service_role;
select result ->> 'lease_id' as lease_a,
       result ->> 'lease_token' as lease_token_a
from (select public.service_reserve_organization_external_egress(
  '1a250000-0000-4000-8000-000000000001', 'integration_webhook',
  '8a250000-0000-4000-8000-000000000001', 90
) result) reserved \gset
select pg_temp.p25_assert(
  (select result ->> 'lease_token' = :'lease_token_a' and (result ->> 'idempotent')::boolean
   from (select public.service_reserve_organization_external_egress(
     '1a250000-0000-4000-8000-000000000001', 'integration_webhook',
     '8a250000-0000-4000-8000-000000000001', 90
   ) result) repeated),
  'same egress correlation did not return the active lease idempotently');
select pg_temp.p25_expect_error(format(
  'select public.service_release_organization_external_egress(%L::uuid,%L::uuid,''delivered'',''http_200'',200)',
  :'lease_a', '8f250000-0000-4000-8000-000000000001'
), 'organization_external_egress_lease_lost');
reset role;

select pg_temp.p25_actor('2a250000-0000-4000-8000-000000000001', true);
set local role authenticated;
select pg_temp.p25_expect_error(
  $$select public.request_organization_offboarding('9a250000-0000-4000-8000-000000000001')$$,
  'organization_external_activity_in_progress');
reset role;

select pg_temp.p25_service();
set local role service_role;
select public.service_release_organization_external_egress(
  :'lease_a', :'lease_token_a', 'delivered', 'http_200', 200
);
select pg_temp.p25_assert(
  (select (result ->> 'idempotent')::boolean
   from (select public.service_release_organization_external_egress(
     :'lease_a', :'lease_token_a', 'delivered', 'http_200', 200
   ) result) settled),
  'egress release was not exact-evidence idempotent');
select pg_temp.p25_assert(
  not (public.service_settle_organization_external_egress_evidence(
    :'lease_a', :'lease_token_a', 'delivered', 'http_200', 200,
    '{"provider":"p25","result":{"marker":"private-full-provider-evidence"}}'::jsonb
  ) ->> 'idempotent')::boolean,
  'full provider evidence was not appended to the settled exact lease');
select pg_temp.p25_assert(
  (public.service_settle_organization_external_egress_evidence(
    :'lease_a', :'lease_token_a', 'delivered', 'http_200', 200,
    '{"provider":"p25","result":{"marker":"private-full-provider-evidence"}}'::jsonb
  ) ->> 'idempotent')::boolean,
  'exact full-evidence replay was not idempotent');
select pg_temp.p25_expect_error(format(
  'select public.service_settle_organization_external_egress_evidence(%L::uuid,%L::uuid,''delivered'',''http_200'',200,''{"provider":"changed"}''::jsonb)',
  :'lease_a', :'lease_token_a'
), 'organization_external_egress_evidence_conflict');
select pg_temp.p25_assert(
  (public.service_get_organization_external_egress_evidence(
    '1a250000-0000-4000-8000-000000000001', 'integration_webhook',
    '8a250000-0000-4000-8000-000000000001'
  ) -> 'evidence' -> 'result' ->> 'marker') = 'private-full-provider-evidence',
  'service recovery lookup did not return the exact provider evidence');
select pg_temp.p25_assert(
  not exists (
    select 1 from public.audit_logs audit
    where coalesce(audit.old_values::text, '') || coalesce(audit.new_values::text, '')
      like '%private-full-provider-evidence%'
  ),
  'raw provider evidence leaked into the public audit ledger');
reset role;
select pg_temp.p25_expect_error(format(
  'update private.organization_external_egress_evidence set evidence = ''{}''::jsonb where lease_id = %L::uuid',
  :'lease_a'
), 'organization_external_egress_evidence_immutable');

-- A forced platform lifecycle flip may block business persistence, but must not erase the
-- already-received provider response.
select pg_temp.p25_service();
set local role service_role;
select result ->> 'lease_id' as lease_flip,
       result ->> 'lease_token' as lease_token_flip
from (select public.service_reserve_organization_external_egress(
  '1a250000-0000-4000-8000-000000000002', 'document_interpretation',
  '8a250000-0000-4000-8000-000000000005', 90
) result) reserved \gset
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'fresh');
set local role authenticated;
select public.set_organization_lifecycle(
  '1a250000-0000-4000-8000-000000000002', 'suspended', null,
  'P25 provider-response lifecycle flip'
);
reset role;
select pg_temp.p25_service();
set local role service_role;
select pg_temp.p25_assert(
  (public.service_settle_organization_external_egress_evidence(
    :'lease_flip', :'lease_token_flip', 'delivered', 'provider_response', 200,
    '{"interpretation":{"document_type":"invoice"},"model":"p25"}'::jsonb
  ) ->> 'evidence_outcome') = 'delivered',
  'provider evidence was lost after a lifecycle flip');
select pg_temp.p25_assert(
  (select receipt ->> 'provider_result_sha256'
   from (select public.service_settle_organization_external_egress_evidence(
     :'lease_flip', :'lease_token_flip', 'delivered', 'provider_response', 200,
     '{"provider_result_sha256":"caller-value-is-not-authoritative","interpretation":{"document_type":"invoice"},"model":"p25"}'::jsonb
   ) receipt) replay)
    = encode(digest(convert_to('{"document_type": "invoice"}'::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
  'interpretation evidence did not return the canonical PostgreSQL JSONB hash');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'fresh');
set local role authenticated;
select public.set_organization_lifecycle(
  '1a250000-0000-4000-8000-000000000002', 'active', null,
  'P25 restore tenant B after lifecycle-flip evidence test'
);
reset role;

select pg_temp.p25_service();
set local role service_role;
select result ->> 'lease_id' as lease_logo,
       result ->> 'lease_token' as lease_token_logo
from (select public.service_reserve_organization_external_egress(
  '1a250000-0000-4000-8000-000000000002', 'organization_logo_storage',
  '8a250000-0000-4000-8000-000000000006', 30
) result) reserved \gset
select public.service_release_organization_external_egress(
  :'lease_logo', :'lease_token_logo', 'delivered', 'storage_mutation_committed', null
);
select result ->> 'lease_id' as lease_c,
       result ->> 'lease_token' as lease_token_c
from (select public.service_reserve_organization_external_egress(
  '1a250000-0000-4000-8000-000000000003', 'push_notification',
  '8a250000-0000-4000-8000-000000000003', 5
) result) reserved \gset
reset role;
update private.organization_external_egress_leases
set reserved_at = statement_timestamp() - interval '10 seconds',
    expires_at = statement_timestamp() - interval '1 second'
where lease_id = :'lease_c';

select pg_temp.p25_service();
set local role service_role;
select pg_temp.p25_assert(
  (select not (result ->> 'egress_allowed')::boolean
          and result ->> 'settled_outcome' = 'ambiguous'
   from (select public.service_reserve_organization_external_egress(
     '1a250000-0000-4000-8000-000000000003', 'push_notification',
     '8a250000-0000-4000-8000-000000000003', 5
   ) result) expired_retry),
  'an expired correlation was re-armed instead of frozen ambiguous');
reset role;
select pg_temp.p25_assert(
  (select status = 'settled' and outcome = 'ambiguous'
          and evidence_code = 'lease_expired_without_settlement'
   from private.organization_external_egress_leases where lease_id = :'lease_c'),
  'expired active lease did not preserve an ambiguous terminal outcome');

select pg_temp.p25_actor('2a250000-0000-4000-8000-000000000005', true);
set local role authenticated;
select public.request_organization_offboarding(
  '9a250000-0000-4000-8000-000000000003'
) as expired_lease_request \gset
select public.cancel_organization_offboarding(
  :'expired_lease_request', '9b250000-0000-4000-8000-000000000003'
);
reset role;
select pg_temp.p25_clear_writers();

-- Step-up, role boundary and idempotency on the actual A request.
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000001', 'missing');
set local role authenticated;
select pg_temp.p25_expect_error(
  $$select public.request_organization_offboarding('9a250000-0000-4000-8000-000000000001')$$,
  'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000001', 'stale');
set local role authenticated;
select pg_temp.p25_expect_error(
  $$select public.request_organization_offboarding('9a250000-0000-4000-8000-000000000001')$$,
  'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000001', 'future');
set local role authenticated;
select pg_temp.p25_expect_error(
  $$select public.request_organization_offboarding('9a250000-0000-4000-8000-000000000001')$$,
  'fresh_authentication_required');
reset role;
select pg_temp.p25_actor('2a250000-0000-4000-8000-000000000002', true);
set local role authenticated;
select pg_temp.p25_expect_error(
  $$select public.request_organization_offboarding('9a250000-0000-4000-8000-000000000001')$$,
  'offboarding_owner_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000006', 'fresh');
set local role authenticated;
select pg_temp.p25_expect_error(
  $$select public.request_organization_offboarding('9a250000-0000-4000-8000-000000000001')$$,
  'offboarding_owner_required');
reset role;
select pg_temp.p25_actor('2a250000-0000-4000-8000-000000000001', true);
set local role authenticated;
select public.request_organization_offboarding(
  '9a250000-0000-4000-8000-000000000001'
) as request_a \gset
select pg_temp.p25_assert(
  public.request_organization_offboarding('9a250000-0000-4000-8000-000000000001') = :'request_a',
  'offboarding request retry changed the request id');
select pg_temp.p25_assert(not public.organization_write_allowed(),
  'offboarding tenant remained writable');
select pg_temp.p25_assert((select count(*) = 501 from public.categories),
  'owner lost read-only tenant data');
select pg_temp.p25_expect_error(
  $$insert into public.categories(org_id,name,sort) values
    ('1a250000-0000-4000-8000-000000000001','must fail',999)$$,
  'organization_read_only');
reset role;
select pg_temp.p25_clear_writers();

select pg_temp.p25_service();
set local role service_role;
select pg_temp.p25_expect_error(
  $$select public.service_reserve_organization_external_egress(
    '1a250000-0000-4000-8000-000000000001','document_signed_url',
    '8a250000-0000-4000-8000-000000000004',30)$$,
  'organization_external_egress_not_allowed');
select pg_temp.p25_expect_error(
  $$select public.service_reserve_organization_external_egress(
    '1a250000-0000-4000-8000-000000000001','organization_logo_storage',
    '8a250000-0000-4000-8000-000000000007',30)$$,
  'organization_external_egress_not_allowed');

select result ->> 'job_id' as claimed_document_job,
       result ->> 'org_id' as claimed_document_org,
       result ->> 'processing_attempt_id' as claimed_document_attempt
from (select public.claim_document_processing_job('p25-document-worker', 60) result) claim
\gset
select pg_temp.p25_assert(
  :'claimed_document_job'::uuid = '5d250000-0000-4000-8000-000000000002'
  and :'claimed_document_org'::uuid = '1a250000-0000-4000-8000-000000000002',
  'offboarding OCR work poisoned the active tenant claim');
select pg_temp.p25_assert(
  :'claimed_document_attempt'::uuid is not null
  and (select processing_attempt_id = :'claimed_document_attempt'::uuid
       from public.document_processing_jobs where id = :'claimed_document_job'::uuid),
  'OCR claim did not persist and return an attempt-bound egress correlation');
select pg_temp.p25_assert(
  (select status = 'queued' and attempt_count = 0
   from public.document_processing_jobs
   where id = '5d250000-0000-4000-8000-000000000001'),
  'offboarding OCR job was mutated while being skipped');

select public.claim_whatsapp_confirmation_reminders(10) as whatsapp_claims \gset
select pg_temp.p25_assert(
  jsonb_array_length(:'whatsapp_claims'::jsonb) = 1
  and :'whatsapp_claims'::jsonb -> 0 ->> 'message_id'
    = '7d250000-0000-4000-8000-000000000003',
  'offboarding WhatsApp work poisoned the active tenant claim');
select pg_temp.p25_assert(
  (select status = 'sending' and error_code is null
   from public.whatsapp_order_messages
   where id = '7d250000-0000-4000-8000-000000000001')
  and (select status = 'queued' and lease_expires_at is null
       from public.whatsapp_order_messages
       where id = '7d250000-0000-4000-8000-000000000002'),
  'offboarding WhatsApp rows were cleaned or leased');
select pg_temp.p25_expect_error(
  $$select public.begin_whatsapp_reminder_send(
    '7d250000-0000-4000-8000-000000000002'
  )$$,
  'organization_external_egress_not_allowed');
select result ->> 'egress_lease_id' as whatsapp_lease_b,
       result ->> 'egress_lease_token' as whatsapp_lease_token_b,
       (result ->> 'should_send')::boolean as whatsapp_should_send_b
from (select public.begin_whatsapp_reminder_send(
  '7d250000-0000-4000-8000-000000000003'
) result) begin_send \gset
select pg_temp.p25_assert(
  :'whatsapp_should_send_b'::boolean
  and :'whatsapp_lease_b' <> '' and :'whatsapp_lease_token_b' <> '',
  'WhatsApp begin-send did not reserve egress before provider authorization');
select pg_temp.p25_expect_error(format(
  'select public.service_settle_organization_external_egress_evidence(%L::uuid,%L::uuid,''denied'',''p25_large_cross_kind'',null,jsonb_build_object(''blob'',repeat(''x'',2097153)))',
  :'whatsapp_lease_b', :'whatsapp_lease_token_b'
), 'organization_external_egress_evidence_invalid');
select public.service_settle_organization_external_egress_evidence(
  :'whatsapp_lease_b', :'whatsapp_lease_token_b', 'denied',
  'p25_provider_not_called', null,
  '{"provider":"meta","attempt":"not_called_in_db_test"}'::jsonb
);
reset role;

select pg_temp.p25_assert(
  (select status = 'parked' and next_attempt_at = 'infinity'::timestamptz
          and offboarding_request_id = :'request_a'
   from private.integration_outbox where id = '5b250000-0000-4000-8000-000000000001'),
  'pending outbox row was not safely parked');
select pg_temp.p25_assert(
  (select status = 'claimed' and claimed_by = 'p25-worker'
   from private.integration_outbox where id = '5b250000-0000-4000-8000-000000000002'),
  'request blindly parked an already-claimed outbox attempt');

insert into private.integration_outbox (
  id, org_id, event_id, target, status, correlation_id
) values (
  '5b250000-0000-4000-8000-000000000003', '1a250000-0000-4000-8000-000000000001',
  '5a250000-0000-4000-8000-000000000003', 'p25-target', 'pending',
  '5c250000-0000-4000-8000-000000000003'
);
select pg_temp.p25_assert(
  (select status = 'parked' and next_attempt_at = 'infinity'::timestamptz
   from private.integration_outbox where id = '5b250000-0000-4000-8000-000000000003'),
  'new pending outbox row was not parked by the insertion fence');

select pg_temp.p25_service();
set local role service_role;
select pg_temp.p25_assert(
  (select count(*) = 0 from public.claim_integration_outbox('p25-other-worker', 10)),
  'offboarding outbox work was claimable');
select public.service_park_claimed_integration_outbox(
  '5b250000-0000-4000-8000-000000000002', 'p25-worker', 'offboarding_started'
);
select public.service_settle_claimed_integration_outbox(
  '5b250000-0000-4000-8000-000000000004', 'p25-worker', 'ambiguous', null,
  'provider_timeout_after_send'
);
reset role;
select pg_temp.p25_assert(
  (select status = 'parked' and next_attempt_at = 'infinity'::timestamptz
   from private.integration_outbox where id = '5b250000-0000-4000-8000-000000000002'),
  'pre-egress denied claimed row was not safely parked');
select pg_temp.p25_assert(
  exists (select 1 from private.integration_deliveries
          where outbox_id = '5b250000-0000-4000-8000-000000000002'
            and attempt = 1 and error = 'pre_egress_denied:offboarding_started'),
  'pre-egress denial did not preserve attempt evidence');
select pg_temp.p25_assert(
  (select status = 'dead_letter' and last_error like 'ambiguous_after_egress:%'
   from private.integration_outbox where id = '5b250000-0000-4000-8000-000000000004')
  and exists (select 1 from private.dead_letter_records
              where outbox_id = '5b250000-0000-4000-8000-000000000004'),
  'ambiguous post-egress attempt was left retryable or lost its evidence');

-- Read-only cleanup may delete only expired transient claims, never live ones.
select pg_temp.p25_service();
set local role service_role;
delete from public.supplier_price_submission_intakes
where id = '7a250000-0000-4000-8000-000000000001';
delete from public.supplier_price_document_upload_reservations
where document_id = '4a250000-0000-4000-8000-000000000001';
select pg_temp.p25_expect_error(
  $$delete from public.supplier_price_submission_intakes
    where id = '7a250000-0000-4000-8000-000000000002'$$,
  'organization_read_only');
select pg_temp.p25_expect_error(
  $$delete from public.supplier_price_document_upload_reservations
    where document_id = '4a250000-0000-4000-8000-000000000002'$$,
  'organization_read_only');
reset role;
select pg_temp.p25_clear_writers();

-- Tenant B sees only its own state and cannot operate on A.
select pg_temp.p25_actor('2a250000-0000-4000-8000-000000000003', true);
set local role authenticated;
select pg_temp.p25_assert(
  not exists (select 1 from public.organization_offboarding_state() where id = :'request_a'),
  'tenant B observed tenant A offboarding state');
select pg_temp.p25_expect_error(format(
  'select public.cancel_organization_offboarding(%L::uuid,%L::uuid)',
  :'request_a', '9b250000-0000-4000-8000-000000000002'
), 'offboarding_request_unknown');
reset role;

select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000006', 'fresh');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.cancel_organization_offboarding(%L::uuid,%L::uuid)',
  :'request_a', '9b250000-0000-4000-8000-000000000006'
), 'offboarding_owner_required');
select pg_temp.p25_expect_error(format(
  'select public.authorize_organization_export_action(%L::uuid,''download'')', :'request_a'
), 'offboarding_export_download_not_authorized');
reset role;

-- Platform approval/build authorization is step-up protected; owner cannot build.
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'missing');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.approve_organization_offboarding(%L::uuid)', :'request_a'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'stale');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.approve_organization_offboarding(%L::uuid)', :'request_a'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'future');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.approve_organization_offboarding(%L::uuid)', :'request_a'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'fresh');
set local role authenticated;
select public.approve_organization_offboarding(:'request_a');
reset role;

select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'missing');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.authorize_organization_export_action(%L::uuid,''build'')', :'request_a'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'stale');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.authorize_organization_export_action(%L::uuid,''build'')', :'request_a'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'future');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.authorize_organization_export_action(%L::uuid,''build'')', :'request_a'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'fresh');
set local role authenticated;
select pg_temp.p25_assert(
  public.authorize_organization_export_action(:'request_a', 'build'),
  'fresh platform admin was not authorized to build');
reset role;
select pg_temp.p25_clear_writers();
select pg_temp.p25_actor('2a250000-0000-4000-8000-000000000001', true);
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.authorize_organization_export_action(%L::uuid,''build'')', :'request_a'
), 'offboarding_export_build_not_authorized');
select pg_temp.p25_expect_error(format(
  'select public.authorize_organization_export_action(%L::uuid,''download'')', :'request_a'
), 'offboarding_export_download_not_authorized');
reset role;

-- Incremental immutable snapshots, bounded pages, durable part queue and fenced workers.
select pg_temp.p25_service();
set local role service_role;
select result -> 'request' ->> 'export_generation' as generation_a,
       (result ->> 'part_count')::integer as initial_part_count
from (select public.service_claim_organization_export(
  :'request_a', '8a250000-0000-4000-8000-000000000010'
) result) claimed \gset
select pg_temp.p25_clear_writers();
select pg_temp.p25_assert(:'initial_part_count'::integer = 0,
  'bounded export claim copied rows or Storage objects synchronously');
select pg_temp.p25_assert(
  (select public.service_claim_organization_export_part(
    :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000010'
  ) is null), 'artifact claim opened before snapshot states completed');
select pg_temp.p25_assert(
  (select not (result ->> 'build_required')::boolean
   from (select public.service_claim_organization_export(
     :'request_a', '8f250000-0000-4000-8000-000000000010'
   ) result) active_claim),
  'an active export lease did not return build_required=false');

create or replace function pg_temp.p25_finish_export_snapshots(
  p_request_id uuid, p_generation uuid, p_worker_token uuid
) returns integer language plpgsql as $$
declare
  v_result jsonb;
  v_calls integer := 0;
begin
  loop
    v_result := public.service_snapshot_organization_export_batch(
      p_request_id, p_generation, p_worker_token, 50, 1048576
    );
    v_calls := v_calls + 1;
    exit when (v_result ->> 'all_snapshots_completed')::boolean;
    if v_calls > 5000 then raise exception 'p25_snapshot_loop_exceeded'; end if;
  end loop;
  return v_calls;
end
$$;
select pg_temp.p25_finish_export_snapshots(
  :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000010'
) as snapshot_call_count \gset
select pg_temp.p25_assert(:'snapshot_call_count'::integer > 1,
  'snapshot did not require durable incremental calls');
select pg_temp.p25_assert(
  (select count(*) = 50 from public.service_get_organization_export_snapshot_page(
    :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000010',
    'categories', 0, 50
  )), 'first category snapshot page was not exactly 50 rows');
select pg_temp.p25_assert(
  (select count(*) = 50 from public.service_get_organization_export_snapshot_page(
    :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000010',
    'categories', 50, 50
  )), 'second category snapshot page did not resume at the exact cursor');
select pg_temp.p25_expect_error(format(
  'select * from public.service_get_organization_export_snapshot_page(%L::uuid,%L::uuid,%L::uuid,''categories'',0,50)',
  :'request_a', :'generation_a', '8f250000-0000-4000-8000-000000000010'
), 'offboarding_export_lease_lost');
reset role;
select count(*)::integer as initial_part_count
from private.organization_export_parts
where request_id = :'request_a' and generation = :'generation_a' \gset
select pg_temp.p25_assert(
  (select count(*) = 22 from private.organization_export_parts
   where request_id = :'request_a' and generation = :'generation_a'
     and payload ->> 'table_name' = 'categories'
     and kind in ('table_json', 'table_csv')),
  '501 categories did not create eleven bounded JSON and CSV batch pairs');
select pg_temp.p25_assert(
  (select bool_and(
     (payload ->> 'batch_row_count')::integer between 1 and 50
     and (payload ->> 'batch_bytes')::bigint > 0
     and (payload ->> 'batch_bytes')::bigint <= 1048576
     and (payload ->> 'last_ordinal')::bigint
       = (payload ->> 'after_ordinal')::bigint + (payload ->> 'batch_row_count')::integer
   ) from private.organization_export_parts
   where request_id = :'request_a' and generation = :'generation_a'
     and payload ->> 'table_name' = 'categories' and kind = 'table_json'),
  'category batches did not preserve exact count, bytes and ordinal evidence');
select pg_temp.p25_assert(
  (select next_ordinal = 501 and batch_count = 11 and status = 'completed'
   from private.organization_export_snapshot_table_states
   where request_id = :'request_a' and generation = :'generation_a'
     and table_name = 'categories'),
  'category cursor did not finish exactly at row 501');
select pg_temp.p25_assert(
  exists (
    select 1 from private.organization_export_parts
    where request_id = :'request_a' and generation = :'generation_a'
      and kind = 'table_json' and payload ->> 'table_name' = 'document_extractions'
      and (payload ->> 'batch_row_count')::integer = 1
      and (payload ->> 'oversized_single_row')::boolean
      and (payload ->> 'batch_bytes')::bigint > 26214400
      and (payload ->> 'batch_bytes')::bigint <= 27262976
  ), 'legal 25 MiB OCR payload plus bounded row envelope was rejected by export snapshotting');
select pg_temp.p25_assert(
  (select next_ordinal > 50 and batch_count >= 2 and status = 'completed'
   from private.organization_export_snapshot_storage_states
   where request_id = :'request_a' and generation = :'generation_a'),
  'Storage metadata did not use a bounded multi-batch snapshot');
select pg_temp.p25_assert(
  (select bool_and(batch_count <= 50) from (
     select (payload ->> 'batch_index')::integer, count(*)::integer as batch_count
     from private.organization_export_parts
     where request_id = :'request_a' and generation = :'generation_a'
       and kind = 'source_object'
     group by (payload ->> 'batch_index')::integer
   ) batches),
  'Storage snapshot created an oversized source-object batch');
select pg_temp.p25_assert(
  exists (select 1 from private.organization_export_parts
          where request_id = :'request_a' and generation = :'generation_a'
            and kind = 'table_csv' and (payload ->> 'row_count')::bigint = 0
            and jsonb_array_length(payload -> 'columns') > 0),
  'an empty CSV table task did not preserve its explicit header columns');
select pg_temp.p25_assert(
  not exists (select 1 from private.organization_export_parts
              where request_id = :'request_a' and generation = :'generation_a'
                and kind in ('manifest_page', 'manifest')),
  'manifest work was created before data artifacts completed');
select pg_temp.p25_assert(
  (select count(*) = 1 from private.organization_export_snapshot_rows
   where request_id = :'request_a' and generation = :'generation_a'
     and table_name = 'organization_offboarding_requests'
     and row_data ->> 'id' = :'request_a'),
  'current offboarding request was not snapshotted exactly once');
select pg_temp.p25_service();
set local role service_role;
select public.service_heartbeat_organization_export(
  :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000010'
);
reset role;
update private.organization_export_snapshot_table_states
set status = 'copying', completed_at = null
where request_id = :'request_a' and generation = :'generation_a'
  and table_name = 'organization_offboarding_requests';
select pg_temp.p25_service();
set local role service_role;
select public.service_snapshot_organization_export_batch(
  :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000010', 50, 1048576
);
reset role;
select pg_temp.p25_assert(
  (select count(*) = 1 from private.organization_export_snapshot_rows
   where request_id = :'request_a' and generation = :'generation_a'
     and table_name = 'organization_offboarding_requests'
     and row_data ->> 'id' = :'request_a'),
  'lease heartbeat duplicated the mutable offboarding request snapshot');
select pg_temp.p25_service();
set local role service_role;
select result ->> 'part_id' as part_one,
       result ->> 'claim_token' as part_token_one,
       result ->> 'mime_type' as part_mime_one,
       result ->> 'object_path' as ignored_part_path
from (select public.service_claim_organization_export_part(
  :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000010'
) result) part \gset
select pg_temp.p25_expect_error(format(
  'select public.service_heartbeat_organization_export_part(%L::uuid,%L::uuid,%L::uuid,%L::uuid)',
  :'request_a', :'generation_a', :'part_one', '8f250000-0000-4000-8000-000000000011'
), 'offboarding_export_part_lease_lost');
select format(
  '%s/offboarding/%s/%s/parts/%s.part',
  '1a250000-0000-4000-8000-000000000001', :'request_a', :'generation_a', :'part_one'
) as part_path_one \gset
reset role;
insert into storage.objects (bucket_id, name, metadata) values (
  'tenant-exports', :'part_path_one',
  jsonb_build_object('size', 11, 'mimetype', :'part_mime_one')
);
select pg_temp.p25_service();
set local role service_role;
select public.service_complete_organization_export_part(
  :'request_a', :'generation_a', :'part_one', :'part_token_one',
  :'part_path_one', repeat('a', 64), 11
);
select public.service_complete_organization_export_part(
  :'request_a', :'generation_a', :'part_one', :'part_token_one',
  :'part_path_one', repeat('a', 64), 11
);
select public.service_fail_organization_export(
  :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000010',
  'worker_process_lost'
);
select pg_temp.p25_clear_writers();
select (result -> 'request' ->> 'export_generation') as resumed_generation,
       (result ->> 'resumed')::boolean as was_resumed
from (select public.service_claim_organization_export(
  :'request_a', '8a250000-0000-4000-8000-000000000011'
) result) resumed \gset
select pg_temp.p25_clear_writers();
select pg_temp.p25_assert(
  :'resumed_generation'::uuid = :'generation_a'::uuid and :'was_resumed'::boolean,
  'export retry recreated the generation instead of resuming checkpoints');
reset role;
select pg_temp.p25_assert(
  (select status = 'completed' and attempts = 1
   from private.organization_export_parts
   where request_id = :'request_a' and generation = :'generation_a' and part_id = :'part_one'),
  'resume changed a completed part or its attempt count');
select pg_temp.p25_service();
set local role service_role;
select result ->> 'part_id' as part_two,
       result ->> 'claim_token' as part_token_two
from (select public.service_claim_organization_export_part(
  :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000011'
) result) part \gset
select public.service_fail_organization_export_part(
  :'request_a', :'generation_a', :'part_two',
  '8f250000-0000-4000-8000-000000000012', 'wrong_token_must_not_win'
);
reset role;
select pg_temp.p25_assert(
  (select status = 'claimed' from private.organization_export_parts
   where request_id = :'request_a' and generation = :'generation_a' and part_id = :'part_two'),
  'stale part token changed the current claim');
select pg_temp.p25_service();
set local role service_role;
select public.service_fail_organization_export_part(
  :'request_a', :'generation_a', :'part_two', :'part_token_two', 'provider_timeout'
);
reset role;
select pg_temp.p25_assert(
  (select status = 'failed' and attempts = 1 and last_error_code = 'provider_timeout'
   from private.organization_export_parts
   where request_id = :'request_a' and generation = :'generation_a' and part_id = :'part_two'),
  'part failure did not preserve retry evidence');

select format(
  '%s/offboarding/%s/%s/manifest.json',
  '1a250000-0000-4000-8000-000000000001', :'request_a', :'generation_a'
) as export_path_a \gset
select pg_temp.p25_service();
set local role service_role;
select pg_temp.p25_expect_error(format(
  'select public.service_complete_organization_export(%L::uuid,%L::uuid,%L::uuid,%L,repeat(''b'',64))',
  :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000011',
  :'export_path_a'
), 'offboarding_export_snapshot_incomplete');
reset role;

-- Test fixture completes untouched artifacts directly; the two exercised parts above prove the
-- public object/token fence. Manifest remains pending until every data artifact is complete.
update private.organization_export_parts part
set status = 'completed',
    object_path = part.org_id::text || '/offboarding/' || part.request_id::text || '/'
      || part.generation::text || '/parts/' || part.part_id::text || '.part',
    sha256 = repeat('c', 64), size_bytes = 1, claim_token = null, lease_until = null
where part.request_id = :'request_a' and part.generation = :'generation_a'
  and part.status = 'pending' and part.kind not in ('manifest_page', 'manifest');
insert into storage.objects (bucket_id, name, metadata)
select 'tenant-exports', part.object_path,
       jsonb_build_object('size', part.size_bytes, 'mimetype', part.mime_type)
from private.organization_export_parts part
where part.request_id = :'request_a' and part.generation = :'generation_a'
  and part.status = 'completed'
on conflict (bucket_id, name) do nothing;

select pg_temp.p25_service();
set local role service_role;
select result ->> 'part_id' as part_retry,
       result ->> 'claim_token' as part_retry_token,
       result ->> 'mime_type' as part_retry_mime,
       (result ->> 'attempts')::integer as part_retry_attempts
from (select public.service_claim_organization_export_part(
  :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000011'
) result) retried \gset
select pg_temp.p25_assert(
  :'part_retry'::uuid = :'part_two'::uuid and :'part_retry_attempts'::integer = 2,
  'failed part was not reclaimed with a new attempt');
select format(
  '%s/offboarding/%s/%s/parts/%s.part',
  '1a250000-0000-4000-8000-000000000001', :'request_a', :'generation_a', :'part_retry'
) as part_retry_path \gset
reset role;
insert into storage.objects (bucket_id, name, metadata) values (
  'tenant-exports', :'part_retry_path',
  jsonb_build_object('size', 12, 'mimetype', :'part_retry_mime')
);
select pg_temp.p25_service();
set local role service_role;
select public.service_complete_organization_export_part(
  :'request_a', :'generation_a', :'part_retry', :'part_retry_token',
  :'part_retry_path', repeat('d', 64), 12
);
create or replace function pg_temp.p25_build_manifest_pages(
  p_request_id uuid, p_generation uuid, p_worker_token uuid
) returns jsonb language plpgsql as $$
declare
  v_claim jsonb;
  v_path text;
  v_calls integer := 0;
begin
  loop
    v_claim := public.service_claim_organization_export_part(
      p_request_id, p_generation, p_worker_token
    );
    if v_claim is null then raise exception 'p25_manifest_claim_missing'; end if;
    if v_claim ->> 'kind' = 'manifest' then return v_claim; end if;
    if v_claim ->> 'kind' <> 'manifest_page' then
      raise exception 'p25_unexpected_manifest_part:%', v_claim ->> 'kind';
    end if;
    v_path := (v_claim ->> 'org_id') || '/offboarding/' || p_request_id::text || '/'
      || p_generation::text || '/parts/' || (v_claim ->> 'part_id') || '.part';
    insert into storage.objects (bucket_id, name, metadata) values (
      'tenant-exports', v_path,
      jsonb_build_object('size', 17, 'mimetype', 'application/json')
    );
    perform public.service_complete_organization_export_part(
      p_request_id, p_generation, (v_claim ->> 'part_id')::uuid,
      (v_claim ->> 'claim_token')::uuid, v_path, repeat('f', 64), 17
    );
    v_calls := v_calls + 1;
    if v_calls > 1000 then raise exception 'p25_manifest_page_loop_exceeded'; end if;
  end loop;
end
$$;
select result ->> 'part_id' as manifest_part,
       result ->> 'claim_token' as manifest_token,
       result ->> 'mime_type' as manifest_mime,
       (result -> 'payload' ->> 'page_count')::integer as manifest_page_count,
       (result -> 'payload' ->> 'artifact_count')::integer as manifest_artifact_count
from (select pg_temp.p25_build_manifest_pages(
  :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000011'
) result) manifest \gset
select pg_temp.p25_assert(:'manifest_mime' = 'application/json',
  'the last checkpoint is not a JSON manifest');
select pg_temp.p25_assert(:'manifest_page_count'::integer > 1,
  'large export did not create bounded manifest pages');
reset role;
select pg_temp.p25_assert(
  (select payload ->> 'contract' = 'paged_artifact_index_v1'
          and payload -> 'artifact_fields' @> '["name"]'::jsonb
          and jsonb_array_length(payload -> 'pages') = :'manifest_page_count'::integer
          and not (payload ? 'artifacts')
   from private.organization_export_parts
   where request_id = :'request_a' and generation = :'generation_a'
     and part_id = :'manifest_part'),
  'root manifest is not a bounded page index');
select pg_temp.p25_assert(
  (select bool_and((payload ->> 'artifact_count')::integer between 1 and 100)
   from private.organization_export_parts
   where request_id = :'request_a' and generation = :'generation_a'
     and kind = 'manifest_page'),
  'manifest page exceeded the 100-artifact cap');
select pg_temp.p25_assert(
  exists (
    select 1
    from private.organization_export_parts page,
         jsonb_array_elements(page.payload -> 'artifacts') artifact
    where page.request_id = :'request_a' and page.generation = :'generation_a'
      and page.kind = 'manifest_page'
      and artifact ->> 'name' =
        'original-files/documents/1a250000-0000-4000-8000-000000000001/מסמכים/חשבונית מקור.pdf'
  ),
  'manifest did not preserve the safe Hebrew original-file path');
select pg_temp.p25_assert(
  exists (
    select 1
    from private.organization_export_parts page,
         jsonb_array_elements(page.payload -> 'artifacts') artifact
    where page.request_id = :'request_a' and page.generation = :'generation_a'
      and page.kind = 'manifest_page'
      and artifact ->> 'name' = 'data/categories/json/part-1.json'
  ),
  'manifest did not map a table page to a usable logical filename');
select pg_temp.p25_assert(
  not exists (
    select 1
    from private.organization_export_parts page,
         jsonb_array_elements(page.payload -> 'artifacts') artifact
    where page.request_id = :'request_a' and page.generation = :'generation_a'
      and page.kind = 'manifest_page'
      and (
        coalesce(artifact ->> 'name', '') = ''
        or artifact ->> 'name' like '%../%'
        or artifact ->> 'name' like '%/./%'
        or artifact ->> 'name' ~ '[[:cntrl:]]'
      )
  ),
  'manifest emitted an empty, traversing or control-character logical name');
insert into storage.objects (bucket_id, name, metadata) values (
  'tenant-exports', :'export_path_a',
  jsonb_build_object('size', 13, 'mimetype', 'application/json')
);
select pg_temp.p25_service();
set local role service_role;
select public.service_complete_organization_export_part(
  :'request_a', :'generation_a', :'manifest_part', :'manifest_token',
  :'export_path_a', repeat('e', 64), 13
);
reset role;
select count(*)::integer as completed_part_count,
       sum(size_bytes)::bigint as aggregate_export_size
from private.organization_export_parts
where request_id = :'request_a' and generation = :'generation_a' and status = 'completed' \gset
select pg_temp.p25_service();
set local role service_role;
select public.service_complete_organization_export(
  :'request_a', :'generation_a', '8a250000-0000-4000-8000-000000000011',
  :'export_path_a', repeat('e', 64)
);
reset role;
select pg_temp.p25_clear_writers();
select pg_temp.p25_assert(
  (select status = 'export_ready' and export_file_count = :'completed_part_count'::integer
   from public.organization_offboarding_requests where id = :'request_a'),
  'complete part set did not finalize the export');
select pg_temp.p25_assert(
  not exists (select 1 from private.organization_export_snapshot_rows
              where request_id = :'request_a' and generation = :'generation_a')
  and not exists (select 1 from private.organization_export_snapshot_table_states
                  where request_id = :'request_a' and generation = :'generation_a')
  and not exists (select 1 from private.organization_export_snapshot_storage_states
                  where request_id = :'request_a' and generation = :'generation_a')
  and not exists (select 1 from private.organization_export_snapshot_objects
                  where request_id = :'request_a' and generation = :'generation_a')
  and not exists (select 1 from private.organization_export_manifest_states
                  where request_id = :'request_a' and generation = :'generation_a')
  and exists (select 1 from private.organization_export_parts
              where request_id = :'request_a' and generation = :'generation_a'
                and kind = 'manifest' and status = 'completed'),
  'finalizer did not remove transient snapshots while preserving artifact evidence');

-- Progress is tenant-scoped and counts the actual current generation.
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000001', 'missing');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.authorize_organization_export_action(%L::uuid,''download'')', :'request_a'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000001', 'stale');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.authorize_organization_export_action(%L::uuid,''download'')', :'request_a'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000001', 'future');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.authorize_organization_export_action(%L::uuid,''download'')', :'request_a'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000001', 'fresh');
set local role authenticated;
select pg_temp.p25_assert(
  (select export_parts_total = :'completed_part_count'::integer
          and export_parts_completed = :'completed_part_count'::integer
   from public.organization_offboarding_state() where id = :'request_a'),
  'owner export progress is not based on part checkpoints');
select pg_temp.p25_assert(
  public.authorize_organization_export_action(:'request_a', 'download'),
  'fresh tenant owner could not authorize a ready download');
reset role;
select pg_temp.p25_actor('2a250000-0000-4000-8000-000000000003', true);
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.authorize_organization_export_action(%L::uuid,''download'')', :'request_a'
), 'offboarding_request_unknown');
reset role;

-- Token resolution is side-effect free. Access is recorded only after a verified response or
-- signed artifact handoff, with access-kind-specific counters and idempotency.
select pg_temp.p25_service();
set local role service_role;
select pg_temp.p25_expect_error(format(
  'select public.service_issue_organization_export_link(%L::uuid,%L::uuid,repeat(''e'',64),statement_timestamp()+interval ''7 days'')',
  :'request_a', '2a250000-0000-4000-8000-000000000003'
), 'offboarding_export_owner_required');
select public.service_issue_organization_export_link(
  :'request_a', '2a250000-0000-4000-8000-000000000001', repeat('e', 64),
  statement_timestamp() + interval '7 days'
);
select pg_temp.p25_clear_writers();
select pg_temp.p25_assert(
  public.service_revalidate_organization_export_link(repeat('e', 64), :'export_path_a'),
  'fresh export link did not revalidate');
reset role;
select pg_temp.p25_clear_writers();
select pg_temp.p25_assert(
  (select download_count = 0 from public.organization_offboarding_requests where id = :'request_a'),
  'link revalidation incremented the download counter');
select pg_temp.p25_service();
set local role service_role;
select pg_temp.p25_assert(
  (select count(*) = 1 from public.service_resolve_organization_export_link(repeat('e', 64))),
  'valid export token did not resolve once');
select pg_temp.p25_assert(
  (select generation = :'generation_a'::uuid and object_path = :'export_path_a'
          and object_sha256 = repeat('e', 64) and object_size_bytes = 13
   from public.service_resolve_organization_export_link(repeat('e', 64))),
  'root resolver omitted immutable generation/hash/size evidence');
reset role;
select pg_temp.p25_clear_writers();
select pg_temp.p25_assert(
  (select download_count = 0 and portal_open_count = 0
          and artifact_link_issued_count = 0
   from public.organization_offboarding_requests where id = :'request_a'),
  'side-effect-free token resolution changed an access counter');
select private.tenant_export_part_logical_name(kind, payload) as artifact_name,
       object_path as artifact_path, sha256 as artifact_sha256
from private.organization_export_parts
where request_id = :'request_a' and generation = :'generation_a'
  and kind = 'table_json' and status = 'completed'
order by part_id limit 1 \gset
select pg_temp.p25_service();
set local role service_role;
select pg_temp.p25_assert(
  (public.service_record_organization_export_access(
    repeat('e', 64), 'portal_opened',
    'aa250000-0000-4000-8000-000000000001'
  ) ->> 'portal_open_count')::integer = 1,
  'successful portal response was not recorded');
select pg_temp.p25_assert(
  (public.service_record_organization_export_access(
    repeat('e', 64), 'portal_opened',
    'aa250000-0000-4000-8000-000000000001'
  ) ->> 'idempotent')::boolean,
  'portal access A/A replay was not idempotent');
select pg_temp.p25_expect_error(format(
  'select public.service_record_organization_export_access(repeat(''e'',64),''manifest_downloaded'',%L::uuid,''manifest.json'',%L,repeat(''e'',64))',
  'aa250000-0000-4000-8000-000000000001', :'export_path_a'
), 'organization_export_access_idempotency_conflict');
select pg_temp.p25_expect_error(format(
  'select public.service_record_organization_export_access(repeat(''e'',64),''manifest_downloaded'',%L::uuid,''manifest.json'',%L,repeat(''0'',64))',
  'aa250000-0000-4000-8000-000000000002', :'export_path_a'
), 'organization_export_artifact_unverified');
select pg_temp.p25_assert(
  (public.service_record_organization_export_access(
    repeat('e', 64), 'manifest_downloaded',
    'aa250000-0000-4000-8000-000000000003',
    'manifest.json', :'export_path_a', repeat('e', 64)
  ) ->> 'download_count')::integer = 1,
  'verified manifest response did not increment its precise counter');
reset role;
select private.tenant_export_part_logical_name(kind, payload) as page_name,
       object_path as page_path, sha256 as page_sha256
from private.organization_export_parts
where request_id = :'request_a' and generation = :'generation_a'
  and kind = 'manifest_page' and status = 'completed'
order by (payload ->> 'page_index')::integer limit 1 \gset
select pg_temp.p25_service();
set local role service_role;
select pg_temp.p25_assert(
  (public.service_record_organization_export_access(
    repeat('e', 64), 'manifest_page_downloaded',
    'aa250000-0000-4000-8000-000000000005',
    :'page_name', :'page_path', :'page_sha256'
  ) ->> 'download_count')::integer = 2,
  'verified manifest-page response was not recorded as downloaded bytes');
select pg_temp.p25_assert(
  (select count(*) = 1 from public.service_resolve_organization_export_artifact(
    repeat('e', 64), :'artifact_path'
  )), 'completed artifact did not resolve through the narrow broker contract');
select pg_temp.p25_assert(
  (public.service_record_organization_export_access(
    repeat('e', 64), 'artifact_link_issued',
    'aa250000-0000-4000-8000-000000000004',
    :'artifact_name', :'artifact_path', :'artifact_sha256'
  ) ->> 'artifact_link_issued_count')::integer = 1,
  'verified signed artifact handoff was not recorded precisely');
reset role;
select pg_temp.p25_assert(
  (select download_count = 2 and portal_open_count = 1
          and artifact_link_issued_count = 1
   from public.organization_offboarding_requests where id = :'request_a'),
  'access counters conflated portal, manifest bytes and signed-link issuance');

-- Owner cancellation is tenant-bound, step-up protected and idempotent. Only safe parked work is
-- restored; the signed token is invalidated and ordinary writes resume.
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000001', 'missing');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.cancel_organization_offboarding(%L::uuid,%L::uuid)',
  :'request_a', '9b250000-0000-4000-8000-000000000001'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000001', 'stale');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.cancel_organization_offboarding(%L::uuid,%L::uuid)',
  :'request_a', '9b250000-0000-4000-8000-000000000001'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000001', 'future');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.cancel_organization_offboarding(%L::uuid,%L::uuid)',
  :'request_a', '9b250000-0000-4000-8000-000000000001'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000001', 'fresh');
set local role authenticated;
select public.cancel_organization_offboarding(
  :'request_a', '9b250000-0000-4000-8000-000000000001'
);
select public.cancel_organization_offboarding(
  :'request_a', '9b250000-0000-4000-8000-000000000001'
);
reset role;
select pg_temp.p25_clear_writers();
select pg_temp.p25_service();
set local role service_role;
select pg_temp.p25_assert(
  not public.service_revalidate_organization_export_link(repeat('e', 64), :'export_path_a'),
  'cancelled export link still revalidated');
reset role;
select pg_temp.p25_assert(
  not exists (select 1 from private.integration_outbox
              where org_id = '1a250000-0000-4000-8000-000000000001'
                and status = 'parked'),
  'safe pre-egress outbox work was not restored after cancellation');
select pg_temp.p25_assert(
  (select bool_and(status = 'pending' and next_attempt_at <> 'infinity'::timestamptz)
   from private.integration_outbox
   where id in (
     '5b250000-0000-4000-8000-000000000001',
     '5b250000-0000-4000-8000-000000000002',
     '5b250000-0000-4000-8000-000000000003'
   )),
  'cancel restored an outbox row into an unsafe state');
select pg_temp.p25_assert(
  (select status = 'dead_letter' from private.integration_outbox
   where id = '5b250000-0000-4000-8000-000000000004'),
  'cancel restored ambiguous post-egress work');
insert into public.categories (org_id, name, sort)
values ('1a250000-0000-4000-8000-000000000001', 'write after cancel', 999);

-- A second request proves platform-only reactivation and exact outbox restoration.
select pg_temp.p25_actor('2a250000-0000-4000-8000-000000000001', true);
set local role authenticated;
select public.request_organization_offboarding(
  '9a250000-0000-4000-8000-000000000011'
) as request_reactivate \gset
reset role;
select pg_temp.p25_clear_writers();
select pg_temp.p25_actor('2a250000-0000-4000-8000-000000000001', true);
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.reactivate_organization_from_offboarding(%L::uuid)', :'request_reactivate'
), 'not_platform_admin');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'missing');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.reactivate_organization_from_offboarding(%L::uuid)', :'request_reactivate'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'stale');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.reactivate_organization_from_offboarding(%L::uuid)', :'request_reactivate'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'future');
set local role authenticated;
select pg_temp.p25_expect_error(format(
  'select public.reactivate_organization_from_offboarding(%L::uuid)', :'request_reactivate'
), 'fresh_authentication_required');
reset role;
select pg_temp.p25_actor_amr('2a250000-0000-4000-8000-000000000004', 'fresh');
set local role authenticated;
select public.reactivate_organization_from_offboarding(:'request_reactivate');
reset role;
select pg_temp.p25_clear_writers();
select pg_temp.p25_assert(
  (select status = 'active' and trial_ends_at is null
   from public.organizations where id = '1a250000-0000-4000-8000-000000000001'),
  'platform reactivation did not restore active lifecycle');
select pg_temp.p25_assert(
  not exists (select 1 from private.integration_outbox
              where org_id = '1a250000-0000-4000-8000-000000000001'
                and status = 'parked'),
  'reactivation did not restore safe pending outbox work');

select pg_temp.p25_assert(
  exists (select 1 from public.audit_logs
          where org_id = '1a250000-0000-4000-8000-000000000001'
            and action = 'organization_offboarding_requested')
  and exists (select 1 from public.audit_logs
              where org_id = '1a250000-0000-4000-8000-000000000001'
                and action = 'organization_export_completed')
  and exists (select 1 from public.audit_logs
              where org_id = '1a250000-0000-4000-8000-000000000001'
                and action = 'organization_offboarding_reactivated'),
  'offboarding/export/reactivation audit evidence is incomplete');

rollback;

select 'P25 tenant offboarding/export/egress tests passed' as result;
