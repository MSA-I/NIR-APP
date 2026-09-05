-- p111 -- a terminally failed scan can be superseded softly without deleting its evidence,
-- crossing a tenant/unit boundary, or turning a replay into another mutation.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p111_act(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end
$$;

insert into public.organizations (id, name, status) values
  ('11100000-0000-4000-8000-000000000001', 'P111 mine', 'active'),
  ('11100000-0000-4000-8000-000000000002', 'P111 neighbour', 'active');

insert into auth.users (id, email) values
  ('11100000-0000-4000-8000-000000000011', 'owner-p111@example.test'),
  ('11100000-0000-4000-8000-000000000012', 'office-p111@example.test'),
  ('11100000-0000-4000-8000-000000000013', 'accountant-p111@example.test'),
  ('11100000-0000-4000-8000-000000000014', 'scope-p111@example.test'),
  ('11100000-0000-4000-8000-000000000021', 'neighbour-p111@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('11100000-0000-4000-8000-000000000011', '11100000-0000-4000-8000-000000000001', 'P111 owner', 'owner'),
  ('11100000-0000-4000-8000-000000000012', '11100000-0000-4000-8000-000000000001', 'P111 office', 'office'),
  ('11100000-0000-4000-8000-000000000013', '11100000-0000-4000-8000-000000000001', 'P111 accountant', 'accountant'),
  ('11100000-0000-4000-8000-000000000014', '11100000-0000-4000-8000-000000000001', 'P111 no scope', 'owner'),
  ('11100000-0000-4000-8000-000000000021', '11100000-0000-4000-8000-000000000002', 'P111 neighbour', 'owner');

-- This owner deliberately has no visible unit. SECURITY DEFINER must not turn EXECUTE into scope.
delete from public.user_scope_grants
where org_id = '11100000-0000-4000-8000-000000000001'
  and user_id = '11100000-0000-4000-8000-000000000014';

insert into public.suppliers (id, org_id, name) values
  ('11100000-0000-4000-8000-000000000701',
   '11100000-0000-4000-8000-000000000001', 'P111 filed target');

insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  uploaded_by, document_kind, unit_id, deleted_at
) values
  ('11100000-0000-4000-8000-000000000101', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-owner-source.pdf',
   'p111-owner-source.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000011',
   'invoice', null, null),
  ('11100000-0000-4000-8000-000000000102', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-owner-replacement.pdf',
   'p111-owner-replacement.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000011',
   'invoice', null, null),
  ('11100000-0000-4000-8000-000000000103', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-office-source.pdf',
   'p111-office-source.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000012',
   'invoice', null, null),
  ('11100000-0000-4000-8000-000000000104', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-office-replacement.pdf',
   'p111-office-replacement.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000012',
   'invoice', null, null),
  ('11100000-0000-4000-8000-000000000105', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-never-failed.pdf',
   'p111-never-failed.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000011',
   'invoice', null, null),
  ('11100000-0000-4000-8000-000000000106', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-unused-replacement.pdf',
   'p111-unused-replacement.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000011',
   'invoice', null, null),
  ('11100000-0000-4000-8000-000000000107', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-recovered-source.pdf',
   'p111-recovered-source.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000011',
   'invoice', null, null),
  ('11100000-0000-4000-8000-000000000108', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-recovered-replacement.pdf',
   'p111-recovered-replacement.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000011',
   'invoice', null, null),
  ('11100000-0000-4000-8000-000000000109', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-scoped-source.pdf',
   'p111-scoped-source.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000014',
   'invoice', public.p0_default_unit('11100000-0000-4000-8000-000000000001', 'legal_entity'), null),
  ('11100000-0000-4000-8000-000000000110', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-scoped-replacement.pdf',
   'p111-scoped-replacement.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000014',
   'invoice', public.p0_default_unit('11100000-0000-4000-8000-000000000001', 'legal_entity'), null),
  ('11100000-0000-4000-8000-000000000111', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-conflict-source.pdf',
   'p111-conflict-source.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000011',
   'invoice', null, null),
  ('11100000-0000-4000-8000-000000000112', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-conflict-replacement.pdf',
   'p111-conflict-replacement.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000011',
   'invoice', null, null),
  ('11100000-0000-4000-8000-000000000113', '11100000-0000-4000-8000-000000000001',
   'supplier', '11100000-0000-4000-8000-000000000701',
   '11100000-0000-4000-8000-000000000001/inbox/p111-filed-replacement.pdf',
   'p111-filed-replacement.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000011',
   'invoice', null, null),
  ('11100000-0000-4000-8000-000000000114', '11100000-0000-4000-8000-000000000001',
   'inbox', null, '11100000-0000-4000-8000-000000000001/inbox/p111-deleted-replacement.pdf',
   'p111-deleted-replacement.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000011',
   'invoice', null, now()),
  ('11100000-0000-4000-8000-000000000201', '11100000-0000-4000-8000-000000000002',
   'inbox', null, '11100000-0000-4000-8000-000000000002/inbox/p111-neighbour-source.pdf',
   'p111-neighbour-source.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000021',
   'invoice', null, null),
  ('11100000-0000-4000-8000-000000000202', '11100000-0000-4000-8000-000000000002',
   'inbox', null, '11100000-0000-4000-8000-000000000002/inbox/p111-neighbour-replacement.pdf',
   'p111-neighbour-replacement.pdf', 'application/pdf', '11100000-0000-4000-8000-000000000021',
   'invoice', null, null);

insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values
  ('documents', '11100000-0000-4000-8000-000000000001/inbox/p111-owner-source.pdf',
   '11100000-0000-4000-8000-000000000011', '11100000-0000-4000-8000-000000000011',
   '{"mimetype":"application/pdf","size":8}'::jsonb);

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum, last_error_code, created_at
) values
  ('11100000-0000-4000-8000-000000000301', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000101', '11100000-0000-4000-8000-000000000011', 'failed', 'etag:' || repeat('1', 64), 'processing_timeout', '2026-09-05T00:01:00Z'),
  ('11100000-0000-4000-8000-000000000303', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000103', '11100000-0000-4000-8000-000000000012', 'failed', 'etag:' || repeat('3', 64), 'corrupt_document', '2026-09-05T00:03:00Z'),
  ('11100000-0000-4000-8000-000000000305', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000105', '11100000-0000-4000-8000-000000000011', 'queued', 'etag:' || repeat('5', 64), null, '2026-09-05T00:05:00Z'),
  ('11100000-0000-4000-8000-000000000307', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000107', '11100000-0000-4000-8000-000000000011', 'failed', 'etag:' || repeat('7', 64), 'processing_timeout', '2026-09-05T00:07:00Z'),
  ('11100000-0000-4000-8000-000000000308', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000107', '11100000-0000-4000-8000-000000000011', 'queued', 'etag:' || repeat('8', 64), null, '2026-09-05T00:08:00Z'),
  ('11100000-0000-4000-8000-000000000309', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000109', '11100000-0000-4000-8000-000000000014', 'failed', 'etag:' || repeat('9', 64), 'processing_timeout', '2026-09-05T00:09:00Z'),
  ('11100000-0000-4000-8000-000000000311', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000111', '11100000-0000-4000-8000-000000000011', 'failed', 'etag:' || repeat('a', 64), 'file_size_limit', '2026-09-05T00:11:00Z'),
  ('11100000-0000-4000-8000-000000000321', '11100000-0000-4000-8000-000000000002', '11100000-0000-4000-8000-000000000201', '11100000-0000-4000-8000-000000000021', 'failed', 'etag:' || repeat('b', 64), 'processing_timeout', '2026-09-05T00:21:00Z');

insert into public.document_scan_jobs (
  id, org_id, document_id, processing_job_id, requested_by, status,
  input_checksum, last_error_code, created_at
) values
  ('11100000-0000-4000-8000-000000000401', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000101', '11100000-0000-4000-8000-000000000301', '11100000-0000-4000-8000-000000000011', 'failed', 'etag:' || repeat('1', 64), 'processing_timeout', '2026-09-05T00:01:00Z'),
  ('11100000-0000-4000-8000-000000000403', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000103', '11100000-0000-4000-8000-000000000303', '11100000-0000-4000-8000-000000000012', 'failed', 'etag:' || repeat('3', 64), 'corrupt_document', '2026-09-05T00:03:00Z'),
  ('11100000-0000-4000-8000-000000000405', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000105', '11100000-0000-4000-8000-000000000305', '11100000-0000-4000-8000-000000000011', 'accepted', 'etag:' || repeat('5', 64), null, '2026-09-05T00:05:00Z'),
  ('11100000-0000-4000-8000-000000000407', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000107', '11100000-0000-4000-8000-000000000307', '11100000-0000-4000-8000-000000000011', 'failed', 'etag:' || repeat('7', 64), 'processing_timeout', '2026-09-05T00:07:00Z'),
  ('11100000-0000-4000-8000-000000000408', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000107', '11100000-0000-4000-8000-000000000308', '11100000-0000-4000-8000-000000000011', 'accepted', 'etag:' || repeat('8', 64), null, '2026-09-05T00:08:00Z'),
  ('11100000-0000-4000-8000-000000000409', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000109', '11100000-0000-4000-8000-000000000309', '11100000-0000-4000-8000-000000000014', 'failed', 'etag:' || repeat('9', 64), 'processing_timeout', '2026-09-05T00:09:00Z'),
  ('11100000-0000-4000-8000-000000000411', '11100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000111', '11100000-0000-4000-8000-000000000311', '11100000-0000-4000-8000-000000000011', 'failed', 'etag:' || repeat('a', 64), 'file_size_limit', '2026-09-05T00:11:00Z'),
  ('11100000-0000-4000-8000-000000000421', '11100000-0000-4000-8000-000000000002', '11100000-0000-4000-8000-000000000201', '11100000-0000-4000-8000-000000000321', '11100000-0000-4000-8000-000000000021', 'failed', 'etag:' || repeat('b', 64), 'processing_timeout', '2026-09-05T00:21:00Z');

do $suite$
declare
  v_first jsonb;
  v_replay jsonb;
  v_office jsonb;
  v_before_rows bigint;
  v_before_audit bigint;
  v_before_deleted bigint;
begin
  if to_regprocedure('public.supersede_failed_document(uuid,uuid,uuid,text)') is null
     or to_regclass('private.failed_document_replacements') is null then
    raise exception 'p111.0: failed-document supersede contracts are missing';
  end if;

  -- ===== 1. Owner supersedes softly; immutable bytes and document identity remain =====
  perform pg_temp.p111_act('11100000-0000-4000-8000-000000000011');
  v_first := public.supersede_failed_document(
    '11100000-0000-4000-8000-000000000101',
    '11100000-0000-4000-8000-000000000102',
    '11100000-0000-4000-8000-000000000601',
    'P111 reviewer replaced a terminally failed scan');
  if coalesce((v_first ->> 'idempotent')::boolean, true)
     or not coalesce((v_first ->> 'original_file_retained')::boolean, false) then
    raise exception 'p111.1: first supersede did not report one retained-source mutation';
  end if;
  if not exists (
    select 1 from public.documents document
    where document.id = '11100000-0000-4000-8000-000000000101'
      and document.org_id = '11100000-0000-4000-8000-000000000001'
      and document.deleted_at is not null
      and document.deleted_by = '11100000-0000-4000-8000-000000000011'
      and document.entity_type = 'inbox' and document.entity_id is null
      and document.storage_path = '11100000-0000-4000-8000-000000000001/inbox/p111-owner-source.pdf'
  ) then
    raise exception 'p111.1: failed document was hard-deleted, refiled or lost its immutable source identity';
  end if;
  if not exists (
    select 1 from storage.objects object
    where object.bucket_id = 'documents'
      and object.name = '11100000-0000-4000-8000-000000000001/inbox/p111-owner-source.pdf'
  ) then
    raise exception 'p111.1: supersede deleted the original storage object';
  end if;
  if not exists (
    select 1 from public.documents replacement
    where replacement.id = '11100000-0000-4000-8000-000000000102'
      and replacement.deleted_at is null
      and replacement.entity_type = 'inbox' and replacement.entity_id is null
  ) then
    raise exception 'p111.1: replacement did not remain the active inbox document';
  end if;
  if not exists (
    select 1 from public.audit_logs audit
    where audit.action = 'document_superseded'
      and audit.entity_id = '11100000-0000-4000-8000-000000000101'
      and audit.user_id = '11100000-0000-4000-8000-000000000011'
      and audit.reason = 'P111 reviewer replaced a terminally failed scan'
  ) then
    raise exception 'p111.1: supersede audit lost actor or non-null reason';
  end if;

  -- ===== 2. Exact replay returns the same result and writes nothing again =====
  v_replay := public.supersede_failed_document(
    '11100000-0000-4000-8000-000000000101',
    '11100000-0000-4000-8000-000000000102',
    '11100000-0000-4000-8000-000000000601',
    'P111 dropped-response retry');
  if not coalesce((v_replay ->> 'idempotent')::boolean, false)
     or v_replay ->> 'replacement_document_id' <> '11100000-0000-4000-8000-000000000102'
     or (select count(*) from private.failed_document_replacements
         where failed_document_id = '11100000-0000-4000-8000-000000000101') <> 1
     or (select count(*) from public.audit_logs
         where action = 'document_superseded'
           and entity_id = '11100000-0000-4000-8000-000000000101') <> 1 then
    raise exception 'p111.2: replay changed the result or multiplied mapping/audit rows';
  end if;

  -- ===== 3. Office has the same narrow command authority =====
  perform pg_temp.p111_act('11100000-0000-4000-8000-000000000012');
  v_office := public.supersede_failed_document(
    '11100000-0000-4000-8000-000000000103',
    '11100000-0000-4000-8000-000000000104',
    '11100000-0000-4000-8000-000000000602',
    'P111 office replaced a corrupt source');
  if coalesce((v_office ->> 'idempotent')::boolean, true)
     or not exists (
       select 1 from public.documents
       where id = '11100000-0000-4000-8000-000000000103'
         and deleted_at is not null
         and deleted_by = '11100000-0000-4000-8000-000000000012'
     ) then
    raise exception 'p111.3: office could not supersede its failed document softly';
  end if;

  select count(*) into v_before_rows from private.failed_document_replacements;
  select count(*) into v_before_audit from public.audit_logs;
  select count(*) into v_before_deleted from public.documents where deleted_at is not null;

  -- ===== 4. Role, tenant, scope, reason, source-state and replacement-shape denials =====
  perform pg_temp.p111_act('11100000-0000-4000-8000-000000000013');
  begin
    perform public.supersede_failed_document(
      '11100000-0000-4000-8000-000000000111', '11100000-0000-4000-8000-000000000112',
      '11100000-0000-4000-8000-000000000610', 'P111 denied accountant');
    raise exception 'p111.4: accountant superseded a document';
  exception when insufficient_privilege then
    if sqlerrm not like '%failed_document_supersede_not_authorized%' then raise; end if;
  end;

  perform pg_temp.p111_act('11100000-0000-4000-8000-000000000011');
  begin
    perform public.supersede_failed_document(
      '11100000-0000-4000-8000-000000000201', '11100000-0000-4000-8000-000000000202',
      '11100000-0000-4000-8000-000000000611', 'P111 cross tenant');
    raise exception 'p111.4: another tenant document was superseded';
  exception when no_data_found then
    if sqlerrm not like '%document_not_found%' then raise; end if;
  end;
  begin
    perform public.supersede_failed_document(
      '11100000-0000-4000-8000-000000000105', '11100000-0000-4000-8000-000000000106',
      '11100000-0000-4000-8000-000000000612', 'P111 source never failed');
    raise exception 'p111.4: a non-failed source was superseded';
  exception when sqlstate '55000' then
    if sqlerrm not like '%failed_document_supersede_source_not_failed%' then raise; end if;
  end;
  begin
    perform public.supersede_failed_document(
      '11100000-0000-4000-8000-000000000107', '11100000-0000-4000-8000-000000000108',
      '11100000-0000-4000-8000-000000000613', 'P111 old failure already recovered');
    raise exception 'p111.4: a recovered source with an old failed scan was superseded';
  exception when sqlstate '55000' then
    if sqlerrm not like '%failed_document_supersede_source_not_failed%' then raise; end if;
  end;
  begin
    perform public.supersede_failed_document(
      '11100000-0000-4000-8000-000000000111', '11100000-0000-4000-8000-000000000113',
      '11100000-0000-4000-8000-000000000614', 'P111 filed replacement');
    raise exception 'p111.4: a filed document became a replacement';
  exception when no_data_found then
    if sqlerrm not like '%failed_document_supersede_replacement_invalid%' then raise; end if;
  end;
  begin
    perform public.supersede_failed_document(
      '11100000-0000-4000-8000-000000000111', '11100000-0000-4000-8000-000000000114',
      '11100000-0000-4000-8000-000000000615', 'P111 deleted replacement');
    raise exception 'p111.4: a deleted document became a replacement';
  exception when no_data_found then
    if sqlerrm not like '%failed_document_supersede_replacement_invalid%' then raise; end if;
  end;
  begin
    perform public.supersede_failed_document(
      '11100000-0000-4000-8000-000000000111', '11100000-0000-4000-8000-000000000112',
      '11100000-0000-4000-8000-000000000616', '   ');
    raise exception 'p111.4: a reasonless supersede succeeded';
  exception when invalid_parameter_value then
    if sqlerrm not like '%failed_document_supersede_invalid%' then raise; end if;
  end;
  begin
    perform public.supersede_failed_document(
      '11100000-0000-4000-8000-000000000111', '11100000-0000-4000-8000-000000000111',
      '11100000-0000-4000-8000-000000000617', 'P111 same row');
    raise exception 'p111.4: one document superseded itself';
  exception when invalid_parameter_value then
    if sqlerrm not like '%failed_document_supersede_invalid%' then raise; end if;
  end;

  perform pg_temp.p111_act('11100000-0000-4000-8000-000000000014');
  begin
    perform public.supersede_failed_document(
      '11100000-0000-4000-8000-000000000109', '11100000-0000-4000-8000-000000000110',
      '11100000-0000-4000-8000-000000000618', 'P111 unit out of scope');
    raise exception 'p111.4: SECURITY DEFINER crossed the caller unit scope';
  exception when no_data_found then
    if sqlerrm not like '%document_not_found%' then raise; end if;
  end;

  -- Reusing a command key for another pair and reusing an already claimed replacement both fail.
  perform pg_temp.p111_act('11100000-0000-4000-8000-000000000011');
  begin
    perform public.supersede_failed_document(
      '11100000-0000-4000-8000-000000000111', '11100000-0000-4000-8000-000000000112',
      '11100000-0000-4000-8000-000000000601', 'P111 changed idempotency payload');
    raise exception 'p111.4: one idempotency key accepted a changed pair';
  exception when unique_violation then
    if sqlerrm not like '%failed_document_supersede_idempotency_conflict%' then raise; end if;
  end;
  begin
    perform public.supersede_failed_document(
      '11100000-0000-4000-8000-000000000111', '11100000-0000-4000-8000-000000000102',
      '11100000-0000-4000-8000-000000000619', 'P111 replacement already claimed');
    raise exception 'p111.4: one replacement superseded two failed documents';
  exception when unique_violation then null;
  end;

  if (select count(*) from private.failed_document_replacements) <> v_before_rows
     or (select count(*) from public.audit_logs) <> v_before_audit
     or (select count(*) from public.documents where deleted_at is not null) <> v_before_deleted
     or (select deleted_at is not null from public.documents
         where id = '11100000-0000-4000-8000-000000000111') then
    raise exception 'p111.4: a denied command wrote mapping, audit or soft-delete state';
  end if;

  -- ===== 5. Browser boundary is one RPC, never direct private-table DML =====
  if has_function_privilege('anon',
       'public.supersede_failed_document(uuid,uuid,uuid,text)', 'execute')
     or not has_function_privilege('authenticated',
       'public.supersede_failed_document(uuid,uuid,uuid,text)', 'execute')
     or has_table_privilege('authenticated', 'private.failed_document_replacements',
       'select,insert,update,delete') then
    raise exception 'p111.5: supersede grants do not match the browser boundary';
  end if;

  raise notice 'p111 passed: five failed-document supersede cases';
end
$suite$;

rollback;
