-- p110 -- one document-level feedback note, with no arbitrary annotation choice and no learning
-- rule mutation.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p110_act(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end
$$;

insert into public.organizations (id, name, status) values
  ('11000000-0000-4000-8000-000000000001', 'P110 mine', 'active'),
  ('11000000-0000-4000-8000-000000000002', 'P110 neighbour', 'active');
insert into auth.users (id, email) values
  ('11000000-0000-4000-8000-000000000011', 'owner-p110@example.test'),
  ('11000000-0000-4000-8000-000000000012', 'accountant-p110@example.test'),
  ('11000000-0000-4000-8000-000000000021', 'neighbour-p110@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('11000000-0000-4000-8000-000000000011', '11000000-0000-4000-8000-000000000001', 'P110 owner', 'owner'),
  ('11000000-0000-4000-8000-000000000012', '11000000-0000-4000-8000-000000000001', 'P110 accountant', 'accountant'),
  ('11000000-0000-4000-8000-000000000021', '11000000-0000-4000-8000-000000000002', 'P110 neighbour', 'owner');

insert into public.documents (
  id, org_id, entity_type, storage_path, file_name, mime_type, document_kind, uploaded_by
) values
  ('11000000-0000-4000-8000-000000000101', '11000000-0000-4000-8000-000000000001',
   'inbox', '11000000-0000-4000-8000-000000000001/p110.pdf', 'p110.pdf',
   'application/pdf', 'invoice', '11000000-0000-4000-8000-000000000011'),
  ('11000000-0000-4000-8000-000000000201', '11000000-0000-4000-8000-000000000002',
   'inbox', '11000000-0000-4000-8000-000000000002/p110-other.pdf', 'p110-other.pdf',
   'application/pdf', 'invoice', '11000000-0000-4000-8000-000000000021');

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
) values (
  '11000000-0000-4000-8000-000000000301', '11000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000101', '11000000-0000-4000-8000-000000000011',
  'review', 'etag:' || repeat('b', 64), '11000000-0000-4000-8000-000000000011', now()
);
insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
) values (
  '11000000-0000-4000-8000-000000000401', '11000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000301', '11000000-0000-4000-8000-000000000101',
  'fixture', 'fixture', '1', 'etag:' || repeat('b', 64), '1',
  jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object('page_count', 1, 'detected_languages', jsonb_build_array('he'),
      'plain_text', 'P110', 'partial', false),
    'blocks', '[]'::jsonb, 'tables', '[]'::jsonb, 'marks', '[]'::jsonb)
);
insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
) values (
  '11000000-0000-4000-8000-000000000501', '11000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000301', '11000000-0000-4000-8000-000000000401',
  '11000000-0000-4000-8000-000000000101', '11000000-0000-4000-8000-000000000011',
  'fixture', 'fixture', 'interpret-document-v10', '1',
  jsonb_build_object(
    'schema_version', '1', 'document_type', 'invoice', 'document_type_confidence', 0.9,
    'supplier', jsonb_build_object('suggested_id', null, 'suggested_name', null,
      'confidence', null, 'evidence_block_ids', '[]'::jsonb),
    'fields', '[]'::jsonb, 'line_items', '[]'::jsonb, 'suggested_annotations', '[]'::jsonb)
);

do $suite$
declare
  v_first jsonb;
  v_replay jsonb;
  v_before_rows bigint;
  v_before_audit bigint;
begin
  perform pg_temp.p110_act('11000000-0000-4000-8000-000000000011');
  v_first := public.add_document_review_feedback(
    '11000000-0000-4000-8000-000000000101',
    '11000000-0000-4000-8000-000000000501',
    '  The VAT total is wrong  ',
    '11000000-0000-4000-8000-000000000601',
    'The reviewer says the VAT total is wrong');
  if coalesce((v_first ->> 'idempotent')::boolean, true)
     or coalesce((v_first ->> 'already_recorded')::boolean, true) then
    raise exception 'p110.1: the first feedback did not create one row';
  end if;
  if not exists (
    select 1 from public.document_review_feedback feedback
    where feedback.id = (v_first ->> 'feedback_id')::uuid
      and feedback.org_id = '11000000-0000-4000-8000-000000000001'
      and feedback.document_id = '11000000-0000-4000-8000-000000000101'
      and feedback.interpretation_id = '11000000-0000-4000-8000-000000000501'
      and feedback.note = 'The VAT total is wrong'
  ) then
    raise exception 'p110.1: document, interpretation, tenant or note was not stored';
  end if;
  if not exists (
    select 1 from public.audit_logs audit
    where audit.entity_type = 'document_review_feedback'
      and audit.entity_id = (v_first ->> 'feedback_id')::uuid
      and audit.user_id = '11000000-0000-4000-8000-000000000011'
      and audit.reason = 'The reviewer says the VAT total is wrong'
  ) then
    raise exception 'p110.1: the feedback audit lost actor or reason';
  end if;

  -- Exact replay, and a fresh button press with the same note, both keep one row.
  v_replay := public.add_document_review_feedback(
    '11000000-0000-4000-8000-000000000101',
    '11000000-0000-4000-8000-000000000501',
    'The VAT total is wrong',
    '11000000-0000-4000-8000-000000000601',
    'The reviewer says the VAT total is wrong');
  if not coalesce((v_replay ->> 'idempotent')::boolean, false)
     or v_replay ->> 'feedback_id' <> v_first ->> 'feedback_id' then
    raise exception 'p110.2: exact replay did not return the first row';
  end if;
  v_replay := public.add_document_review_feedback(
    '11000000-0000-4000-8000-000000000101',
    '11000000-0000-4000-8000-000000000501',
    'The VAT total is wrong',
    '11000000-0000-4000-8000-000000000602',
    'The reviewer says the VAT total is wrong');
  if not coalesce((v_replay ->> 'already_recorded')::boolean, false)
     or (select count(*) from public.document_review_feedback
         where document_id = '11000000-0000-4000-8000-000000000101') <> 1 then
    raise exception 'p110.2: a second press multiplied document feedback';
  end if;
  begin
    perform public.add_document_review_feedback(
      '11000000-0000-4000-8000-000000000101',
      '11000000-0000-4000-8000-000000000501',
      'A different immutable note',
      '11000000-0000-4000-8000-000000000603', 'P110 changed note');
    raise exception 'p110.2: an immutable note was silently replaced';
  exception when unique_violation then
    if sqlerrm not like '%document_review_feedback_already_recorded%' then raise; end if;
  end;

  select count(*) into v_before_rows from public.document_review_feedback;
  select count(*) into v_before_audit from public.audit_logs;

  -- Accountant, missing reason, foreign document and wrong interpretation all write nothing.
  perform pg_temp.p110_act('11000000-0000-4000-8000-000000000012');
  begin
    perform public.add_document_review_feedback(
      '11000000-0000-4000-8000-000000000101',
      '11000000-0000-4000-8000-000000000501', 'denied',
      '11000000-0000-4000-8000-000000000604', 'denied');
    raise exception 'p110.3: accountant wrote feedback';
  exception when insufficient_privilege then
    if sqlerrm not like '%document_review_feedback_not_authorized%' then raise; end if;
  end;
  perform pg_temp.p110_act('11000000-0000-4000-8000-000000000011');
  begin
    perform public.add_document_review_feedback(
      '11000000-0000-4000-8000-000000000101',
      '11000000-0000-4000-8000-000000000501', 'no reason',
      '11000000-0000-4000-8000-000000000605', ' ');
    raise exception 'p110.3: reasonless feedback was stored';
  exception when invalid_parameter_value then
    if sqlerrm not like '%document_review_feedback_invalid%' then raise; end if;
  end;
  begin
    perform public.add_document_review_feedback(
      '11000000-0000-4000-8000-000000000201',
      '11000000-0000-4000-8000-000000000501', 'foreign',
      '11000000-0000-4000-8000-000000000606', 'foreign');
    raise exception 'p110.3: another tenant document accepted feedback';
  exception when no_data_found then
    if sqlerrm not like '%document_not_found%' then raise; end if;
  end;
  begin
    perform public.add_document_review_feedback(
      '11000000-0000-4000-8000-000000000101',
      '11000000-0000-4000-8000-000000000401', 'wrong interpretation',
      '11000000-0000-4000-8000-000000000607', 'wrong interpretation');
    raise exception 'p110.3: an extraction id was accepted as an interpretation';
  exception when no_data_found then
    if sqlerrm not like '%document_interpretation_unknown%' then raise; end if;
  end;
  if (select count(*) from public.document_review_feedback) <> v_before_rows
     or (select count(*) from public.audit_logs) <> v_before_audit then
    raise exception 'p110.3: a denied feedback attempt wrote a row or audit';
  end if;

  -- The old annotation feedback ledger is untouched, and browser roles have only read + RPC.
  if exists (
    select 1 from public.document_feedback old_feedback
    where old_feedback.org_id = '11000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'p110.4: document-level feedback chose an annotation behind the user';
  end if;
  if has_table_privilege('authenticated', 'public.document_review_feedback', 'insert')
     or has_table_privilege('authenticated', 'public.document_review_feedback', 'update')
     or has_table_privilege('authenticated', 'public.document_review_feedback', 'delete')
     or has_function_privilege('anon',
       'public.add_document_review_feedback(uuid,uuid,text,uuid,text)', 'execute') then
    raise exception 'p110.4: the feedback write boundary is open';
  end if;

  raise notice 'p110 passed: four document-feedback cases';
end
$suite$;

rollback;
