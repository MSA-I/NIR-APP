-- P66 -- #233: historical kind precedence and allowlisted entity inference.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p66_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'P66: %', p_message; end if;
end $$;

-- RED contract: migration 0178 must expose a provenance-bearing dry-run read model.
select pg_temp.p66_assert(to_regprocedure('public.get_document_kind_history_preview()') is not null,
  'get_document_kind_history_preview is missing');
select pg_temp.p66_assert(to_regprocedure('public.apply_document_kind_history(uuid,text,text,uuid,text)') is not null,
  'apply_document_kind_history is missing');

-- Structural anchors: explicit precedence and allowlist, never a catch-all entity cast.
select pg_temp.p66_assert(pg_get_functiondef('public.get_document_kind_history_preview()'::regprocedure)
  like '%human_review%' and pg_get_functiondef('public.get_document_kind_history_preview()'::regprocedure)
  like '%verified_interpretation%' and pg_get_functiondef('public.get_document_kind_history_preview()'::regprocedure)
  like '%existing_kind%' and pg_get_functiondef('public.get_document_kind_history_preview()'::regprocedure)
  like '%entity_inference%', 'precedence provenance is not explicit');
select pg_temp.p66_assert(pg_get_functiondef('public.get_document_kind_history_preview()'::regprocedure)
  like '%when ''invoice'' then ''invoice''%' and pg_get_functiondef('public.get_document_kind_history_preview()'::regprocedure)
  like '%when ''goods_receipt'' then ''delivery_note''%', 'entity allowlist is missing');

create function pg_temp.p66_extraction_payload()
returns jsonb language sql immutable as $$ select jsonb_build_object(
  'schema_version', '1',
  'document', jsonb_build_object('page_count', 1, 'detected_languages', jsonb_build_array('he'),
    'plain_text', 'P66', 'partial', false),
  'blocks', jsonb_build_array(jsonb_build_object('id', 'block-1', 'page', 1, 'type', 'text',
    'bbox', jsonb_build_array(0,0,1,1), 'text', 'P66', 'confidence', 0.99)),
  'tables', '[]'::jsonb, 'marks', '[]'::jsonb
) $$;
create function pg_temp.p66_interpretation_payload(p_type text)
returns jsonb language sql immutable as $$ select jsonb_build_object(
  'schema_version', '1', 'document_type', p_type, 'document_type_confidence', 0.99,
  'supplier', jsonb_build_object('suggested_id', '66200000-0000-4000-8000-000000000001',
    'suggested_name', 'P66 supplier', 'confidence', 0.99,
    'evidence_block_ids', jsonb_build_array('block-1')),
  'fields', '[]'::jsonb, 'line_items', '[]'::jsonb, 'suggested_annotations', '[]'::jsonb
) $$;

-- The two EVIDENCE branches are allowlists as well, not just the entity branch. `else <stored
-- value>` would echo the interpretation/review vocabulary straight into `documents.document_kind`,
-- and those are two separately maintained closed domains: the moment one moves without the other,
-- `apply_document_kind_history` raises 23514 check_violation on a document a person has just
-- approved instead of refusing by name. Both branches carry the same seven pairs, so one
-- measurement covers both.
select pg_temp.p66_assert(
  pg_get_functiondef('public.get_document_kind_history_preview()'::regprocedure)
    not like '%else human.approved_document_type%'
  and pg_get_functiondef('public.get_document_kind_history_preview()'::regprocedure)
    not like '%else verified.document_type%',
  'an evidence branch still passes a stored type through as a document kind');

-- Every type the LIVE interpretation contract accepts must be NAMED by the map. A type the
-- contract accepts and the map does not degrades silently to `other` -- storable, and wrong -- and
-- that is exactly the gap 0104 opened when it widened the contract for `tax_receipt`. The last four
-- candidates are probes rather than members: they must stay OUT of the contract, so the `where`
-- removes them and they never assert anything about the map.
select pg_temp.p66_assert(
  (select bool_and(position('''' || candidate || '''' in pg_get_functiondef(
     'public.get_document_kind_history_preview()'::regprocedure)) > 0)
   from unnest(array[
     'invoice', 'delivery_note', 'credit_note', 'price_list', 'quote',
     'payment_confirmation', 'tax_receipt', 'other',
     'receipt', 'statement', 'purchase_order', 'bank_statement'
   ]) candidate
   where public.smart_document_interpretation_valid(
     pg_temp.p66_interpretation_payload(candidate), '1')),
  'the interpretation contract accepts a document type the historical map does not name');

insert into public.organizations (id, name, status)
values ('66000000-0000-4000-8000-000000000001', 'P66 tenant', 'active');
insert into auth.users (id, email)
values ('66100000-0000-4000-8000-000000000001', 'owner-p66@example.test');
insert into public.profiles (id, org_id, full_name, role)
values ('66100000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001', 'P66 owner', 'owner');
insert into public.suppliers (id, org_id, name, status)
values ('66200000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001', 'P66 supplier', 'active');
insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, received_by
) values
  ('66300000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001',
   '66200000-0000-4000-8000-000000000001', 'P66-1', current_date, 100, 18, 118,
   '66100000-0000-4000-8000-000000000001'),
  ('66300000-0000-4000-8000-000000000002', '66000000-0000-4000-8000-000000000001',
   '66200000-0000-4000-8000-000000000001', 'P66-2', current_date, 100, 18, 118,
   '66100000-0000-4000-8000-000000000001');
insert into public.purchase_orders (id, org_id, supplier_id, status, created_by)
values ('66400000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001',
  '66200000-0000-4000-8000-000000000001', 'draft', '66100000-0000-4000-8000-000000000001');
insert into public.goods_receipts (id, org_id, order_id, status, received_by)
values ('66500000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001',
  '66400000-0000-4000-8000-000000000001', 'draft', '66100000-0000-4000-8000-000000000001');

-- Human, verified interpretation, existing kind, invoice inference, receipt inference, fallback.
insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type, document_kind, uploaded_by
) values
  ('66600000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001', 'inbox', null,
   '66000000-0000-4000-8000-000000000001/p66/1.pdf', '1.pdf', 'application/pdf', 'other', '66100000-0000-4000-8000-000000000001'),
  ('66600000-0000-4000-8000-000000000002', '66000000-0000-4000-8000-000000000001', 'inbox', null,
   '66000000-0000-4000-8000-000000000001/p66/2.pdf', '2.pdf', 'application/pdf', 'quote', '66100000-0000-4000-8000-000000000001'),
  ('66600000-0000-4000-8000-000000000003', '66000000-0000-4000-8000-000000000001', 'invoice', '66300000-0000-4000-8000-000000000001',
   '66000000-0000-4000-8000-000000000001/p66/3.pdf', '3.pdf', 'application/pdf', 'quote', '66100000-0000-4000-8000-000000000001'),
  ('66600000-0000-4000-8000-000000000004', '66000000-0000-4000-8000-000000000001', 'invoice', '66300000-0000-4000-8000-000000000002',
   '66000000-0000-4000-8000-000000000001/p66/4.pdf', '4.pdf', 'application/pdf', 'other', '66100000-0000-4000-8000-000000000001'),
  ('66600000-0000-4000-8000-000000000005', '66000000-0000-4000-8000-000000000001', 'goods_receipt', '66500000-0000-4000-8000-000000000001',
   '66000000-0000-4000-8000-000000000001/p66/5.pdf', '5.pdf', 'application/pdf', 'other', '66100000-0000-4000-8000-000000000001'),
  ('66600000-0000-4000-8000-000000000006', '66000000-0000-4000-8000-000000000001', 'inbox', null,
   '66000000-0000-4000-8000-000000000001/p66/6.pdf', '6.pdf', 'application/pdf', 'other', '66100000-0000-4000-8000-000000000001'),
  -- 0104 added `tax_receipt` to the interpretation contract AND to documents_kind_check together.
  -- The map must carry that pair through: degrading a receipt to `other` would be an allowlist that
  -- is safe for the CHECK and wrong about the document.
  ('66600000-0000-4000-8000-000000000007', '66000000-0000-4000-8000-000000000001', 'inbox', null,
   '66000000-0000-4000-8000-000000000001/p66/7.pdf', '7.pdf', 'application/pdf', 'other', '66100000-0000-4000-8000-000000000001');

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum
) values
  ('66700000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001',
   '66600000-0000-4000-8000-000000000001', '66100000-0000-4000-8000-000000000001', 'review', 'etag:' || repeat('a', 64)),
  ('66700000-0000-4000-8000-000000000002', '66000000-0000-4000-8000-000000000001',
   '66600000-0000-4000-8000-000000000002', '66100000-0000-4000-8000-000000000001', 'review', 'etag:' || repeat('b', 64)),
  ('66700000-0000-4000-8000-000000000003', '66000000-0000-4000-8000-000000000001',
   '66600000-0000-4000-8000-000000000007', '66100000-0000-4000-8000-000000000001', 'review', 'etag:' || repeat('c', 64));
insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version, input_checksum, contract_version, payload
) values
  ('66800000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001',
   '66700000-0000-4000-8000-000000000001', '66600000-0000-4000-8000-000000000001',
   'fixture', 'p66', '1', 'etag:' || repeat('a', 64), '1', pg_temp.p66_extraction_payload()),
  ('66800000-0000-4000-8000-000000000002', '66000000-0000-4000-8000-000000000001',
   '66700000-0000-4000-8000-000000000002', '66600000-0000-4000-8000-000000000002',
   'fixture', 'p66', '1', 'etag:' || repeat('b', 64), '1', pg_temp.p66_extraction_payload()),
  ('66800000-0000-4000-8000-000000000003', '66000000-0000-4000-8000-000000000001',
   '66700000-0000-4000-8000-000000000003', '66600000-0000-4000-8000-000000000007',
   'fixture', 'p66', '1', 'etag:' || repeat('c', 64), '1', pg_temp.p66_extraction_payload());
insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
) values
  ('66900000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001',
   '66700000-0000-4000-8000-000000000001', '66800000-0000-4000-8000-000000000001',
   '66600000-0000-4000-8000-000000000001', '66100000-0000-4000-8000-000000000001',
   'fixture', 'p66', 'p66', '1', pg_temp.p66_interpretation_payload('price_list')),
  ('66900000-0000-4000-8000-000000000002', '66000000-0000-4000-8000-000000000001',
   '66700000-0000-4000-8000-000000000002', '66800000-0000-4000-8000-000000000002',
   '66600000-0000-4000-8000-000000000002', '66100000-0000-4000-8000-000000000001',
   'fixture', 'p66', 'p66', '1', pg_temp.p66_interpretation_payload('price_list')),
  ('66900000-0000-4000-8000-000000000003', '66000000-0000-4000-8000-000000000001',
   '66700000-0000-4000-8000-000000000003', '66800000-0000-4000-8000-000000000003',
   '66600000-0000-4000-8000-000000000007', '66100000-0000-4000-8000-000000000001',
   'fixture', 'p66', 'p66', '1', pg_temp.p66_interpretation_payload('tax_receipt'));
insert into public.document_type_review_decisions (
  id, org_id, interpretation_id, extraction_id, document_id, revision, decision,
  suggested_document_type, approved_document_type, input_checksum, contract_version, actor_id, reason
) values (
  '66a00000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001',
  '66900000-0000-4000-8000-000000000001', '66800000-0000-4000-8000-000000000001',
  '66600000-0000-4000-8000-000000000001', 1, 'approved', 'price_list', 'invoice',
  'etag:' || repeat('a', 64), '1', '66100000-0000-4000-8000-000000000001', 'P66 human correction'
);

select set_config('request.jwt.claim.sub', '66100000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select pg_temp.p66_assert((select source_type = 'human_review' and proposed_kind = 'invoice'
  from public.get_document_kind_history_preview() where document_id = '66600000-0000-4000-8000-000000000001'),
  'human review did not outrank verified interpretation');
select pg_temp.p66_assert((select source_type = 'verified_interpretation' and proposed_kind = 'price_list'
  from public.get_document_kind_history_preview() where document_id = '66600000-0000-4000-8000-000000000002'),
  'verified interpretation did not outrank existing kind');
select pg_temp.p66_assert((select source_type = 'existing_kind' and proposed_kind = 'quote'
  from public.get_document_kind_history_preview() where document_id = '66600000-0000-4000-8000-000000000003'),
  'existing non-other kind did not outrank entity inference');
select pg_temp.p66_assert((select source_type = 'entity_inference' and proposed_kind = 'invoice'
  from public.get_document_kind_history_preview() where document_id = '66600000-0000-4000-8000-000000000004'),
  'invoice inference is wrong');
select pg_temp.p66_assert((select source_type = 'entity_inference' and proposed_kind = 'delivery_note'
  from public.get_document_kind_history_preview() where document_id = '66600000-0000-4000-8000-000000000005'),
  'goods_receipt inference is wrong');
select pg_temp.p66_assert((select source_type = 'fallback_other' and proposed_kind = 'other'
  from public.get_document_kind_history_preview() where document_id = '66600000-0000-4000-8000-000000000006'),
  'unknown/inbox must fall back to other');
select pg_temp.p66_assert((select source_type = 'verified_interpretation' and proposed_kind = 'tax_receipt'
  from public.get_document_kind_history_preview() where document_id = '66600000-0000-4000-8000-000000000007'),
  'a verified tax receipt must keep its own kind instead of degrading to other');

-- Measured against the LIVE constraint rather than a list copied into this file. Whatever the
-- preview proposes has to be a value `documents.document_kind` can actually hold, or `apply` is a
-- 23514 check_violation waiting for the first person who clicks the row.
select pg_temp.p66_assert((
  select bool_and(position('''' || preview.proposed_kind || '''' in kind_check.def) > 0)
  from public.get_document_kind_history_preview() preview
  cross join (
    select pg_get_constraintdef(c.oid) as def from pg_constraint c
    where c.conrelid = 'public.documents'::regclass and c.conname = 'documents_kind_check'
  ) kind_check),
  'the preview proposed a kind documents_kind_check cannot store');

select public.apply_document_kind_history(
  '66600000-0000-4000-8000-000000000004', 'other', 'entity_inference',
  '66b00000-0000-4000-8000-000000000001', 'P66 approved historical inference');
select pg_temp.p66_assert((public.apply_document_kind_history(
  '66600000-0000-4000-8000-000000000004', 'other', 'entity_inference',
  '66b00000-0000-4000-8000-000000000001', 'P66 approved historical inference'
) ->> 'idempotent')::boolean, 'same historical apply must be idempotent');
reset role;
select pg_temp.p66_assert((select document_kind = 'invoice' from public.documents
  where id = '66600000-0000-4000-8000-000000000004'), 'historical mapping did not land');
select pg_temp.p66_assert((select count(*) = 1 from public.document_kind_resolution_history
  where document_id = '66600000-0000-4000-8000-000000000004'
    and source_type = 'entity_inference' and source_rank = 4
    and reason = 'P66 approved historical inference'), 'provenance ledger is incomplete');

-- ===== Falsification: the map's `else 'other'` arm has to actually fire =====
-- While the interpretation contract and documents_kind_check agree on every value, that arm is
-- unreachable and "no failure observed" says nothing about it. Here the payload contract is stood
-- down for the length of one probe row -- the shape a stored interpretation takes as soon as
-- either domain moves, which is what 0104 did once already -- and the arm is measured: it must
-- resolve to a kind the CHECK can store and `apply` must land it, not die with 23514.
savepoint p66_unmapped_interpretation_type;
alter table public.document_interpretations drop constraint document_interpretations_payload_check;
-- 0084's classifier refuses a type it cannot map. That refusal is its own contract, proven where
-- 0084 is proven, and here it would abort the probe insert before 0178 is ever consulted.
alter table public.document_interpretations disable trigger document_interpretation_syncs_kind;

insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type, document_kind, uploaded_by
) values (
  '66600000-0000-4000-8000-000000000008', '66000000-0000-4000-8000-000000000001', 'inbox', null,
  '66000000-0000-4000-8000-000000000001/p66/8.pdf', '8.pdf', 'application/pdf', 'quote',
  '66100000-0000-4000-8000-000000000001');
insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum
) values (
  '66700000-0000-4000-8000-000000000004', '66000000-0000-4000-8000-000000000001',
  '66600000-0000-4000-8000-000000000008', '66100000-0000-4000-8000-000000000001', 'review',
  'etag:' || repeat('d', 64));
insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version, input_checksum, contract_version, payload
) values (
  '66800000-0000-4000-8000-000000000004', '66000000-0000-4000-8000-000000000001',
  '66700000-0000-4000-8000-000000000004', '66600000-0000-4000-8000-000000000008',
  'fixture', 'p66', '1', 'etag:' || repeat('d', 64), '1', pg_temp.p66_extraction_payload());
insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
) values (
  '66900000-0000-4000-8000-000000000004', '66000000-0000-4000-8000-000000000001',
  '66700000-0000-4000-8000-000000000004', '66800000-0000-4000-8000-000000000004',
  '66600000-0000-4000-8000-000000000008', '66100000-0000-4000-8000-000000000001',
  'fixture', 'p66', 'p66', '1', pg_temp.p66_interpretation_payload('p66_unmapped_type'));

set local role authenticated;
select pg_temp.p66_assert((select source_type = 'verified_interpretation'
    and proposed_kind = 'other' and would_change
  from public.get_document_kind_history_preview()
  where document_id = '66600000-0000-4000-8000-000000000008'),
  'an interpretation type the map does not name must resolve to other, not pass through');
select pg_temp.p66_assert((public.apply_document_kind_history(
  '66600000-0000-4000-8000-000000000008', 'quote', 'verified_interpretation',
  '66b00000-0000-4000-8000-000000000002', 'P66 unmapped interpretation type'
) ->> 'new_kind') = 'other', 'applying an unmapped interpretation type must land a storable kind');
reset role;
select pg_temp.p66_assert((select document_kind = 'other' from public.documents
  where id = '66600000-0000-4000-8000-000000000008'),
  'the probe left the document holding a kind documents_kind_check cannot store');
rollback to savepoint p66_unmapped_interpretation_type;
select pg_temp.p66_assert(
  exists (select 1 from pg_constraint
    where conrelid = 'public.document_interpretations'::regclass
      and conname = 'document_interpretations_payload_check')
  and (select tgenabled <> 'D' from pg_trigger
       where tgrelid = 'public.document_interpretations'::regclass
         and tgname = 'document_interpretation_syncs_kind'),
  'the falsification probe leaked past its savepoint');

rollback;
