-- P52 -- The first limit that refuses: counted once per unit of work, refused before anything is
-- written, silent about nothing, and never blocking a read (0155).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p52_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P52 usage limit assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p52_as(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'amr', '[]'::jsonb)::text, true);
end
$$;

-- ===== Structural claims =====
select pg_temp.p52_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private' and table_name in ('usage_events', 'usage_counters')
      and grantee in ('anon', 'authenticated')),
  'a browser role holds a grant on the metering tables');

-- Same rule as my_entitlements(): a tenant read of its own usage must not accept an organization
-- argument, because a parameter is a thing an attacker can change.
select pg_temp.p52_assert(
  (select pronargs from pg_proc procedure
    join pg_namespace space on space.oid = procedure.pronamespace
   where space.nspname = 'public' and procedure.proname = 'organization_usage_snapshot') = 0,
  'organization_usage_snapshot() grew a parameter');

-- ===== Fixture =====
insert into public.organizations (id, name, status) values
  ('52000000-0000-4000-8000-000000000001', 'P52 tenant A', 'active'),
  ('52000000-0000-4000-8000-000000000002', 'P52 tenant B', 'active');

insert into auth.users (id, email) values
  ('62000000-0000-4000-8000-000000000001', 'owner-a-p52@example.test'),
  ('62000000-0000-4000-8000-000000000002', 'owner-b-p52@example.test'),
  ('62000000-0000-4000-8000-000000000003', 'ops-p52@example.test'),
  ('62000000-0000-4000-8000-000000000004', 'support-p52@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('62000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001', 'P52 owner A', 'owner'),
  ('62000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-000000000002', 'P52 owner B', 'owner');

insert into public.platform_admins (user_id, note) values
  ('62000000-0000-4000-8000-000000000003', 'P52 customer ops'),
  ('62000000-0000-4000-8000-000000000004', 'P52 support');
insert into public.platform_admin_roles (user_id, role_key) values
  ('62000000-0000-4000-8000-000000000003', 'customer_ops'),
  ('62000000-0000-4000-8000-000000000004', 'support');

-- The enqueue path derives its idempotency checksum from the stored object's eTag (0045:551), so
-- a document row without a matching storage object cannot be enqueued at all. The fixture creates
-- both, which is also what makes the "counted once per unit of work" claim meaningful.
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('documents', '52000000-0000-4000-8000-000000000001/inbox/first.pdf',
   '62000000-0000-4000-8000-000000000001',
   '{"mimetype":"application/pdf","eTag":"aaaaaaaaaaaaaaaa","size":100}'::jsonb),
  ('documents', '52000000-0000-4000-8000-000000000001/inbox/second.pdf',
   '62000000-0000-4000-8000-000000000001',
   '{"mimetype":"application/pdf","eTag":"bbbbbbbbbbbbbbbb","size":100}'::jsonb),
  ('documents', '52000000-0000-4000-8000-000000000002/inbox/unknown.pdf',
   '62000000-0000-4000-8000-000000000002',
   '{"mimetype":"application/pdf","eTag":"cccccccccccccccc","size":100}'::jsonb);

insert into public.documents (
  org_id, entity_type, entity_id, storage_path, file_name, mime_type, uploaded_by,
  document_kind, supplier_id, document_date
) values
  ('52000000-0000-4000-8000-000000000001', 'inbox', null,
   '52000000-0000-4000-8000-000000000001/inbox/first.pdf', 'first.pdf', 'application/pdf',
   '62000000-0000-4000-8000-000000000001', 'other', null, null),
  ('52000000-0000-4000-8000-000000000001', 'inbox', null,
   '52000000-0000-4000-8000-000000000001/inbox/second.pdf', 'second.pdf', 'application/pdf',
   '62000000-0000-4000-8000-000000000001', 'other', null, null),
  -- Tenant B's document is created here rather than later: audit_row_change (0020:198) derives the
  -- acting organization from the JWT, and a fixture insert made while impersonating tenant A would
  -- be refused as a cross-tenant audit source.
  ('52000000-0000-4000-8000-000000000002', 'inbox', null,
   '52000000-0000-4000-8000-000000000002/inbox/unknown.pdf', 'unknown.pdf', 'application/pdf',
   '62000000-0000-4000-8000-000000000002', 'other', null, null);

-- ===== Idempotency is the primary key, not application logic =====
select pg_temp.p52_assert(
  (private.record_usage_event(
    '52000000-0000-4000-8000-000000000002', 'documents.monthly', 1, 'same-key', 'p52')
    ->> 'quantity')::numeric = 1,
  'the first metered event did not move the counter');
select pg_temp.p52_assert(
  (private.record_usage_event(
    '52000000-0000-4000-8000-000000000002', 'documents.monthly', 1, 'same-key', 'p52')
    ->> 'idempotent')::boolean,
  'a replayed event was not reported as already counted');
select pg_temp.p52_assert(
  (select quantity from private.usage_counters
    where org_id = '52000000-0000-4000-8000-000000000002'
      and metric_key = 'documents.monthly') = 1,
  'a replayed event moved the counter a second time');

-- An event against a running total is a category error, and the composite foreign key says so.
do $$
begin
  perform private.record_usage_event(
    '52000000-0000-4000-8000-000000000002', 'suppliers.max', 1, 'wrong-measure', 'p52');
  raise exception 'expected an event against a non-period metric to be refused';
exception when foreign_key_violation then null;
end
$$;

-- ===== The billing period says which definition produced it =====
select pg_temp.p52_assert(
  (select period_source from private.usage_period('52000000-0000-4000-8000-000000000001'))
    = 'calendar_month',
  'the period fell back to something other than a named calendar month');

update organization_subscriptions
   set current_period_start = now() - interval '3 days',
       current_period_end = now() + interval '27 days'
 where org_id = '52000000-0000-4000-8000-000000000001';
select pg_temp.p52_assert(
  (select period_source from private.usage_period('52000000-0000-4000-8000-000000000001'))
    = 'subscription',
  'a supplied billing window was ignored in favour of the calendar month');

-- ===== Enforcement: the seeded plan allows, so the pipeline still works =====
select pg_temp.p52_as('62000000-0000-4000-8000-000000000001');
set local role authenticated;

do $$
declare v_job uuid;
begin
  select id into v_job from public.documents
  where org_id = '52000000-0000-4000-8000-000000000001' and file_name = 'first.pdf';
  perform set_config('p52.first_doc', v_job::text, true);
  v_job := public.enqueue_document_processing(v_job);
  perform set_config('p52.first_job', v_job::text, true);
end
$$;

select pg_temp.p52_assert(
  (select used from public.organization_usage_snapshot() where metric_key = 'documents.monthly') = 1,
  'enqueuing a document did not count towards the monthly document usage');

-- Re-enqueuing the SAME document returns the existing job and must not count again: a retry is
-- not a new unit of work, and counting it would bill a customer for a lost response.
do $$
begin
  perform public.enqueue_document_processing(current_setting('p52.first_doc')::uuid);
end
$$;
select pg_temp.p52_assert(
  (select used from public.organization_usage_snapshot() where metric_key = 'documents.monthly') = 1,
  'a retried enqueue counted a second document');

reset role;

-- ===== Enforcement: at the limit, a NEW document is refused and nothing is written =====
update plan_entitlements set unlimited = false, numeric_limit = 1
where plan_key = (select plan_key from organization_subscriptions
                  where org_id = '52000000-0000-4000-8000-000000000001')
  and entitlement_key = 'documents.monthly';

select pg_temp.p52_as('62000000-0000-4000-8000-000000000001');
set local role authenticated;

do $$
declare v_doc uuid; v_before integer; v_after integer;
begin
  select id into v_doc from public.documents
  where org_id = '52000000-0000-4000-8000-000000000001' and file_name = 'second.pdf';
  select count(*) into v_before from public.document_processing_jobs
  where org_id = '52000000-0000-4000-8000-000000000001';
  begin
    perform public.enqueue_document_processing(v_doc);
    raise exception 'expected the document limit to refuse a new job';
  exception when raise_exception then
    if sqlerrm <> 'plan_limit_reached' then raise; end if;
  end;
  select count(*) into v_after from public.document_processing_jobs
  where org_id = '52000000-0000-4000-8000-000000000001';
  if v_after <> v_before then
    raise exception 'a refused enqueue still created % job row(s)', v_after - v_before;
  end if;
end
$$;

-- A customer at their limit keeps everything they already have. Blocking reads would punish them
-- for the thing they already paid for.
select pg_temp.p52_assert(
  (select count(*) from public.documents
    where org_id = '52000000-0000-4000-8000-000000000001') = 2,
  'reaching a creation limit hid the customer''s existing documents');

-- And the retry of the document that was already accepted still works at the limit.
do $$
begin
  perform public.enqueue_document_processing(current_setting('p52.first_doc')::uuid);
end
$$;

select pg_temp.p52_assert(
  (select remaining from public.organization_usage_snapshot()
    where metric_key = 'documents.monthly') = 0
  and (select percent_used from public.organization_usage_snapshot()
    where metric_key = 'documents.monthly') = 100,
  'the usage snapshot did not report the customer as being at their limit');

reset role;

-- ===== An unstated limit refuses, rather than being treated as infinite =====
update plan_entitlements set unlimited = false, numeric_limit = null
where plan_key = (select plan_key from organization_subscriptions
                  where org_id = '52000000-0000-4000-8000-000000000002')
  and entitlement_key = 'documents.monthly';

select pg_temp.p52_as('62000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
declare v_doc uuid;
begin
  select id into v_doc from public.documents
  where org_id = '52000000-0000-4000-8000-000000000002' and file_name = 'unknown.pdf';
  begin
    perform public.enqueue_document_processing(v_doc);
    raise exception 'expected an unstated limit to refuse rather than allow';
  exception when raise_exception then
    if sqlerrm <> 'plan_limit_unknown' then raise; end if;
  end;
end
$$;
select pg_temp.p52_assert(
  (select measured from public.organization_usage_snapshot()
    where metric_key = 'documents.monthly') = false,
  'an unstated limit reported itself as measured');
reset role;

-- ===== What is not counted says so, instead of reporting a zero =====
select pg_temp.p52_as('62000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p52_assert(
  (select measured from public.organization_usage_snapshot() where metric_key = 'suppliers.max')
    = false
  and (select used from public.organization_usage_snapshot() where metric_key = 'suppliers.max')
    is null,
  'an unmetered entitlement reported a zero instead of saying it is not measured');

-- Tenant isolation: A's usage is A's.
select pg_temp.p52_assert(
  (select used from public.organization_usage_snapshot() where metric_key = 'documents.monthly') = 1,
  'one tenant''s usage snapshot reported another tenant''s counter');
reset role;

-- ===== OCR pages are counted from the extraction, once per job =====
-- A real extraction row: the payload has to satisfy smart_document_extraction_valid (0045:253),
-- so the page count the trigger reads is the same field the contract validates rather than a
-- shape invented for the test.
create function pg_temp.p52_extraction(p_pages integer) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', p_pages, 'detected_languages', jsonb_build_array('he'),
      'plain_text', 'p52', 'partial', false),
    'blocks', '[]'::jsonb, 'tables', '[]'::jsonb, 'marks', '[]'::jsonb)
$$;

do $$
begin
  insert into public.document_extractions (
    org_id, job_id, document_id, engine, model, model_version, input_checksum,
    contract_version, payload
  ) values (
    '52000000-0000-4000-8000-000000000001', current_setting('p52.first_job')::uuid,
    current_setting('p52.first_doc')::uuid, 'p52', 'p52-model', '1',
    'etag:aaaaaaaaaaaaaaaa', '1', pg_temp.p52_extraction(7)
  );
end
$$;
select pg_temp.p52_assert(
  (select quantity from private.usage_counters
    where org_id = '52000000-0000-4000-8000-000000000001'
      and metric_key = 'ocr_pages.monthly') = 7,
  'the extraction did not record its page count');

-- A replayed completion for the same job must not bill the pages twice. The trigger keys on job
-- id, which is exactly the identifier a worker retry reuses.
do $$
begin
  begin
    insert into public.document_extractions (
      org_id, job_id, document_id, engine, model, model_version, input_checksum,
      contract_version, payload
    ) values (
      '52000000-0000-4000-8000-000000000001', current_setting('p52.first_job')::uuid,
      current_setting('p52.first_doc')::uuid, 'p52', 'p52-model', '1',
      'etag:aaaaaaaaaaaaaaaa', '1', pg_temp.p52_extraction(7)
    );
  exception when unique_violation then null;
  end;
end
$$;
select pg_temp.p52_assert(
  (select quantity from private.usage_counters
    where org_id = '52000000-0000-4000-8000-000000000001'
      and metric_key = 'ocr_pages.monthly') = 7,
  'a replayed extraction billed the same pages twice');

-- ===== The operator read is gated on usage.view =====
select pg_temp.p52_as('62000000-0000-4000-8000-000000000004');
set local role authenticated;
select pg_temp.p52_assert(
  (select count(*) from public.platform_org_usage('52000000-0000-4000-8000-000000000001')) = 0,
  'an operator without usage.view read a customer''s usage');
reset role;

select pg_temp.p52_as('62000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.p52_assert(
  (select used from public.platform_org_usage('52000000-0000-4000-8000-000000000001')
    where metric_key = 'ocr_pages.monthly') = 7,
  'the operator usage read did not see the recorded pages');
select pg_temp.p52_assert(
  (select period_source from public.platform_org_usage('52000000-0000-4000-8000-000000000001')
    limit 1) = 'subscription',
  'the operator usage read did not report which period definition produced the number');
reset role;

-- ===== A failed job gives the quota back (0160, owner decision 19.08.2026) =====
-- Measured in production: 15 of 67 jobs failed in the design partner's first sixteen days. Without
-- this, roughly one in five of a customer's quota is spent on our own unreliability.
select pg_temp.p52_as('62000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p52_assert(
  (select used from public.organization_usage_snapshot() where metric_key = 'documents.monthly') = 1,
  'the fixture does not start from the one counted document');
reset role;

-- Through the states the job guard actually allows (0045:485-493): queued -> leased -> failed.
-- A direct jump to failed is refused, and a fixture that forced it would be proving the refund
-- against a transition the product cannot produce.
update public.document_processing_jobs
   set status = 'leased', lease_owner = 'p52-worker', lease_until = now() + interval '5 minutes'
 where id = current_setting('p52.first_job')::uuid;
update public.document_processing_jobs
   set status = 'failed', lease_owner = null, lease_until = null,
       last_error_code = 'p52_simulated_failure',
       last_error_message = 'P52: the failure the refund is measured against'
 where id = current_setting('p52.first_job')::uuid;

select pg_temp.p52_as('62000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p52_assert(
  (select used from public.organization_usage_snapshot() where metric_key = 'documents.monthly') = 0,
  'a failed job still consumed the customer''s quota');
reset role;

-- The event is stamped rather than deleted: the attempt happened, and the stamp is what stops a
-- second transition refunding twice.
select pg_temp.p52_assert(
  (select refunded_at from private.usage_events
    where org_id = '52000000-0000-4000-8000-000000000001'
      and metric_key = 'documents.monthly'
      and idempotency_key = current_setting('p52.first_job')) is not null,
  'the refunded usage event was deleted instead of stamped');

-- A retried transition into failed must not refund again. The trigger only fires on the
-- transition, and the stamp catches anything that reaches the function anyway.
select private.refund_usage_event(
  '52000000-0000-4000-8000-000000000001', 'documents.monthly',
  current_setting('p52.first_job'));
select pg_temp.p52_assert(
  (select quantity from private.usage_counters
    where org_id = '52000000-0000-4000-8000-000000000001'
      and metric_key = 'documents.monthly') = 0,
  'a second refund drove the counter below what was actually used');

-- OCR pages are NOT refunded: they were really read and really billed by the provider.
select pg_temp.p52_assert(
  (select quantity from private.usage_counters
    where org_id = '52000000-0000-4000-8000-000000000001'
      and metric_key = 'ocr_pages.monthly') = 7,
  'a failed job clawed back pages the provider had already charged for');

-- ===== The page quota refuses at upload, on pages the server already owns (0162) =====
-- The new document's own page count is unknown until the provider reads it, so the check is on
-- what has ALREADY been read this period. That bounds the overshoot to one document, which the
-- worker caps at ExtractionLimits.max_ai_pages = 20 whatever the file contains.
update plan_entitlements set unlimited = false, numeric_limit = 5
where plan_key = (select plan_key from organization_subscriptions
                  where org_id = '52000000-0000-4000-8000-000000000001')
  and entitlement_key = 'ocr_pages.monthly';

-- The extraction earlier in this suite already recorded 7 pages, which is over the limit of 5.
select pg_temp.p52_assert(
  (select quantity from private.usage_counters
    where org_id = '52000000-0000-4000-8000-000000000001'
      and metric_key = 'ocr_pages.monthly') = 7,
  'the fixture does not start from the recorded pages');

-- Give the document quota room back, so the refusal that follows can only be the page one.
update plan_entitlements set unlimited = true, numeric_limit = null
where plan_key = (select plan_key from organization_subscriptions
                  where org_id = '52000000-0000-4000-8000-000000000001')
  and entitlement_key = 'documents.monthly';

select pg_temp.p52_as('62000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_doc uuid; v_before integer; v_after integer;
begin
  select id into v_doc from public.documents
  where org_id = '52000000-0000-4000-8000-000000000001' and file_name = 'second.pdf';
  select count(*) into v_before from public.document_processing_jobs
  where org_id = '52000000-0000-4000-8000-000000000001';
  begin
    perform public.enqueue_document_processing(v_doc);
    raise exception 'expected the page quota to refuse a new document';
  exception when raise_exception then
    if sqlerrm <> 'plan_limit_reached' then raise; end if;
  end;
  select count(*) into v_after from public.document_processing_jobs
  where org_id = '52000000-0000-4000-8000-000000000001';
  if v_after <> v_before then
    raise exception 'a page-refused enqueue still created % job row(s)', v_after - v_before;
  end if;
end
$$;
reset role;

-- Back under the page quota, and the same document is accepted -- the refusal was the quota, not
-- the document.
update plan_entitlements set unlimited = true, numeric_limit = null
where plan_key = (select plan_key from organization_subscriptions
                  where org_id = '52000000-0000-4000-8000-000000000001')
  and entitlement_key = 'ocr_pages.monthly';

select pg_temp.p52_as('62000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_doc uuid;
begin
  select id into v_doc from public.documents
  where org_id = '52000000-0000-4000-8000-000000000001' and file_name = 'second.pdf';
  perform public.enqueue_document_processing(v_doc);
end
$$;
reset role;

rollback;

\echo 'p52_usage_limit_enforcement_passed'
