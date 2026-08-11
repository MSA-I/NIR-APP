-- P36 -- the preview a person reads before pressing a button that destroys something.
--
-- The destructive option is offered ONLY where a safe reversal can be proven, and every assertion
-- below is one of the ways "proven" could quietly degrade into "looked fine". The refusals matter
-- more than the permissions here: a blocker that stops firing does not produce an error, it
-- produces a button that works and a record that is gone.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p36_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P36 removal assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p36_impact(p_document uuid)
returns jsonb language sql stable as $$
  select private.document_removal_impact('10360000-0000-4000-8000-000000000001', p_document);
$$;

create function pg_temp.p36_has_blocker(p_document uuid, p_kind text)
returns boolean language sql stable as $$
  select exists (
    select 1 from jsonb_array_elements(pg_temp.p36_impact(p_document) -> 'blockers') b
    where b ->> 'kind' = p_kind);
$$;

insert into public.organizations (id, name, status, vat_rate) values
  ('10360000-0000-4000-8000-000000000001', 'P36 tenant', 'active', 18);
insert into auth.users (id, email) values
  ('20360000-0000-4000-8000-000000000001', 'owner-p36@example.test'),
  ('20360000-0000-4000-8000-000000000002', 'kitchen-p36@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('20360000-0000-4000-8000-000000000001', '10360000-0000-4000-8000-000000000001',
   'P36 owner', 'owner'),
  ('20360000-0000-4000-8000-000000000002', '10360000-0000-4000-8000-000000000001',
   'P36 kitchen', 'kitchen');
insert into public.suppliers (id, org_id, name, status) values
  ('40360000-0000-4000-8000-000000000001', '10360000-0000-4000-8000-000000000001',
   'P36 ספק', 'active');
insert into public.products (id, org_id, name, unit) values
  ('30360000-0000-4000-8000-000000000001', '10360000-0000-4000-8000-000000000001',
   'P36 מוצר', 'unit');
insert into public.purchase_orders (id, org_id, supplier_id, status) values
  ('50360000-0000-4000-8000-000000000001', '10360000-0000-4000-8000-000000000001',
   '40360000-0000-4000-8000-000000000001', 'sent');
insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('80360000-0000-4000-8000-000000000001', '10360000-0000-4000-8000-000000000001',
   '50360000-0000-4000-8000-000000000001', '30360000-0000-4000-8000-000000000001', 5, 10);

insert into public.documents (
  id, org_id, entity_type, storage_path, file_name, mime_type, document_kind
)
select ('60360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10360000-0000-4000-8000-000000000001', 'inbox',
       '10360000-0000-4000-8000-000000000001/p36-' || n || '.pdf',
       'p36-' || n || '.pdf', 'application/pdf', 'invoice'
from generate_series(1, 5) as n;

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
)
select ('90360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10360000-0000-4000-8000-000000000001',
       ('60360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '20360000-0000-4000-8000-000000000001', 'review',
       'etag:' || lpad(n::text, 16, '0'), '20360000-0000-4000-8000-000000000001', now()
from generate_series(1, 5) as n;
insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
)
select ('a0360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10360000-0000-4000-8000-000000000001',
       ('90360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       ('60360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'fixture', 'fixture-model', '1.0.0', 'etag:' || lpad(n::text, 16, '0'), '1',
       jsonb_build_object(
         'schema_version', '1',
         'document', jsonb_build_object('page_count', 1,
           'detected_languages', jsonb_build_array('he'), 'plain_text', 'P36', 'partial', false),
         'blocks', jsonb_build_array(jsonb_build_object(
           'id', 'block-1', 'page', 1, 'type', 'text',
           'bbox', jsonb_build_array(0, 0, 1, 1), 'text', 'P36', 'confidence', 0.95)),
         'tables', '[]'::jsonb, 'marks', '[]'::jsonb)
from generate_series(1, 5) as n;
insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
)
select ('b0360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10360000-0000-4000-8000-000000000001',
       ('90360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       ('a0360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       ('60360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '20360000-0000-4000-8000-000000000001',
       'p36', 'p36-model', 'interpret-document-v10', '1',
       jsonb_build_object(
         'schema_version', '1', 'document_type', 'invoice', 'document_type_confidence', 0.97,
         'supplier', jsonb_build_object('suggested_id', null, 'suggested_name', 'P36 ספק',
           'confidence', 0.9, 'evidence_block_ids', jsonb_build_array('block-1')),
         'fields', '[]'::jsonb, 'line_items', '[]'::jsonb, 'suggested_annotations', '[]'::jsonb)
from generate_series(1, 5) as n;

alter table public.invoices disable trigger invoice_three_way_approval_guard_insert;
insert into public.invoices
  (id, org_id, supplier_id, invoice_number, invoice_date, total_amount,
   review_status, payment_status) values
  -- 1: still in review and unpaid — the only genuinely reversible case.
  ('c0360000-0000-4000-8000-000000000001', '10360000-0000-4000-8000-000000000001',
   '40360000-0000-4000-8000-000000000001', 'INV-1', '2026-08-10', 50, 'received', 'unpaid'),
  ('c0360000-0000-4000-8000-000000000002', '10360000-0000-4000-8000-000000000001',
   '40360000-0000-4000-8000-000000000001', 'INV-2', '2026-08-10', 50, 'approved', 'unpaid'),
  ('c0360000-0000-4000-8000-000000000003', '10360000-0000-4000-8000-000000000001',
   '40360000-0000-4000-8000-000000000001', 'INV-3', '2026-08-10', 50, 'received', 'paid');
alter table public.invoices enable trigger invoice_three_way_approval_guard_insert;

insert into public.goods_receipts (id, org_id, order_id, status, received_at) values
  ('d0360000-0000-4000-8000-000000000001', '10360000-0000-4000-8000-000000000001',
   '50360000-0000-4000-8000-000000000001', 'draft', '2026-08-10'),
  ('d0360000-0000-4000-8000-000000000002', '10360000-0000-4000-8000-000000000001',
   '50360000-0000-4000-8000-000000000001', 'completed', '2026-08-11');

insert into public.document_review_applications (
  org_id, document_id, interpretation_id, idempotency_key, actor_id, document_type,
  supplier_id, order_id, outcome, invoice_id, receipt_id, reviewed, assessment, reason
) values
  ('10360000-0000-4000-8000-000000000001', '60360000-0000-4000-8000-000000000001',
   'b0360000-0000-4000-8000-000000000001', gen_random_uuid(),
   '20360000-0000-4000-8000-000000000001', 'invoice',
   '40360000-0000-4000-8000-000000000001', null, 'invoice_created',
   'c0360000-0000-4000-8000-000000000001', null, '{}'::jsonb, '{}'::jsonb, 'P36'),
  ('10360000-0000-4000-8000-000000000001', '60360000-0000-4000-8000-000000000002',
   'b0360000-0000-4000-8000-000000000002', gen_random_uuid(),
   '20360000-0000-4000-8000-000000000001', 'invoice',
   '40360000-0000-4000-8000-000000000001', null, 'invoice_created',
   'c0360000-0000-4000-8000-000000000002', null, '{}'::jsonb, '{}'::jsonb, 'P36'),
  ('10360000-0000-4000-8000-000000000001', '60360000-0000-4000-8000-000000000003',
   'b0360000-0000-4000-8000-000000000003', gen_random_uuid(),
   '20360000-0000-4000-8000-000000000001', 'invoice',
   '40360000-0000-4000-8000-000000000001', null, 'invoice_created',
   'c0360000-0000-4000-8000-000000000003', null, '{}'::jsonb, '{}'::jsonb, 'P36'),
  ('10360000-0000-4000-8000-000000000001', '60360000-0000-4000-8000-000000000004',
   'b0360000-0000-4000-8000-000000000004', gen_random_uuid(),
   '20360000-0000-4000-8000-000000000001', 'delivery_note',
   '40360000-0000-4000-8000-000000000001', '50360000-0000-4000-8000-000000000001',
   'receipt_draft_created', null, 'd0360000-0000-4000-8000-000000000001',
   '{}'::jsonb, '{}'::jsonb, 'P36'),
  ('10360000-0000-4000-8000-000000000001', '60360000-0000-4000-8000-000000000005',
   'b0360000-0000-4000-8000-000000000005', gen_random_uuid(),
   '20360000-0000-4000-8000-000000000001', 'delivery_note',
   '40360000-0000-4000-8000-000000000001', '50360000-0000-4000-8000-000000000001',
   'receipt_draft_created', null, 'd0360000-0000-4000-8000-000000000002',
   '{}'::jsonb, '{}'::jsonb, 'P36');

-- ===== 1. The reversible case, and it is the only one =====

select pg_temp.p36_assert(
  (select (r ->> 'can_remove_derived')::boolean = true
          and (r ->> 'derived_count')::integer = 1
          and jsonb_array_length(r -> 'blockers') = 0
   from pg_temp.p36_impact('60360000-0000-4000-8000-000000000001') r),
  'an unapproved, unpaid invoice created by this document could not be reversed. If nothing is '
  'ever reversible the destructive option is decoration, and people route around it');

select pg_temp.p36_assert(
  (select e ->> 'action' = 'soft_delete' and e ->> 'kind' = 'invoice'
   from jsonb_array_elements(
     pg_temp.p36_impact('60360000-0000-4000-8000-000000000001') -> 'effects') e),
  'the preview does not say what would actually happen to the invoice, in words, before a person '
  'presses the button');

-- ===== 2. The refusals. Each one is a record somebody else built on. =====

select pg_temp.p36_assert(
  pg_temp.p36_has_blocker('60360000-0000-4000-8000-000000000002', 'invoice_approved')
  and (select (r ->> 'can_remove_derived')::boolean = false
       from pg_temp.p36_impact('60360000-0000-4000-8000-000000000002') r),
  'AN APPROVED INVOICE WAS SILENTLY REVERSIBLE from a document screen. Cancelling an approval is '
  'a separate financial decision with its own command and its own audit');

select pg_temp.p36_assert(
  pg_temp.p36_has_blocker('60360000-0000-4000-8000-000000000003', 'invoice_paid')
  and (select (r ->> 'can_remove_derived')::boolean = false
       from pg_temp.p36_impact('60360000-0000-4000-8000-000000000003') r),
  'A PAID INVOICE WAS REVERSIBLE. Money that has left the building is not undone by deleting the '
  'piece of paper that described it');

select pg_temp.p36_assert(
  (select (r ->> 'can_remove_derived')::boolean = true
   from pg_temp.p36_impact('60360000-0000-4000-8000-000000000004') r),
  'a DRAFT receipt could not be reversed. A draft moved no stock; that is what makes it a draft');

select pg_temp.p36_assert(
  pg_temp.p36_has_blocker('60360000-0000-4000-8000-000000000005', 'receipt_completed')
  and (select (r ->> 'can_remove_derived')::boolean = false
       from pg_temp.p36_impact('60360000-0000-4000-8000-000000000005') r),
  'A COMPLETED RECEIPT WAS REVERSIBLE. Somebody counted those goods and the stock moved; undoing '
  'it here would leave the shelves disagreeing with the system and nothing to explain why');

-- Every refusal names itself. "Cannot be deleted" with no reason is how a person concludes the
-- software is broken and goes looking for another way to do it.
select pg_temp.p36_assert(
  (select bool_and(length(coalesce(b ->> 'description', '')) > 10)
   from jsonb_array_elements(
     pg_temp.p36_impact('60360000-0000-4000-8000-000000000003') -> 'blockers') b),
  'a blocker carries no explanation a person can read');

-- ===== 3. Removing the document alone is ALWAYS available =====

select pg_temp.p36_assert(
  (select bool_and((r ->> 'can_remove_document_only')::boolean)
   from (select pg_temp.p36_impact(
           ('60360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) r
         from generate_series(1, 5) n) t),
  'removing the document itself was blocked. Filing a document away never destroys anything, and '
  'a person must always be able to say "this does not belong here"');

select pg_temp.p36_assert(
  (select bool_and((r ->> 'original_file_retained')::boolean)
   from (select pg_temp.p36_impact(
           ('60360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) r
         from generate_series(1, 5) n) t),
  'the preview stops promising that the original file survives. It always does — soft delete, '
  'immutable evidence, the object stays in private storage — and the person pressing remove is '
  'exactly who needs to know that');

-- ===== 4. A month that has been reported is closed =====

insert into public.monthly_report_snapshots (
  org_id, unit_id, report_month, version, report_version, organization_name,
  legal_entity_name, created_by, created_by_name,
  invoice_rows, payment_rows, credit_rows, exception_rows, bank_rows, totals, content_hash
) values (
  '10360000-0000-4000-8000-000000000001',
  (select id from public.org_units
   where org_id = '10360000-0000-4000-8000-000000000001' and parent_id is null limit 1),
  '2026-08-01', 1, '1', 'P36 tenant', 'P36 legal entity',
  '20360000-0000-4000-8000-000000000001', 'P36 owner',
  '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, repeat('a', 64));

select pg_temp.p36_assert(
  pg_temp.p36_has_blocker('60360000-0000-4000-8000-000000000001', 'month_reported'),
  'an invoice inside a month that has already been reported was still reversible. Reopening a '
  'closed month is not something a document screen does');

-- ===== 5. Reading the preview changes nothing =====

create temp table p36_before as
  select (select count(*) from public.invoices) as invoices,
         (select count(*) from public.goods_receipts) as receipts,
         (select count(*) from public.documents where deleted_at is null) as documents;

select pg_temp.p36_impact(('60360000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid)
from generate_series(1, 5) n;

select pg_temp.p36_assert(
  (select b.invoices = (select count(*) from public.invoices)
          and b.receipts = (select count(*) from public.goods_receipts)
          and b.documents = (select count(*) from public.documents where deleted_at is null)
   from p36_before b),
  'READING THE PREVIEW DESTROYED SOMETHING. It is what a person looks at while deciding');

-- ===== 6. Who may look =====

set local role authenticated;
select set_config('request.jwt.claim.sub', '20360000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
begin
  perform public.get_document_removal_impact('60360000-0000-4000-8000-000000000001');
  raise exception 'P36 removal assertion failed: a kitchen manager can see what removing a '
    'document would destroy, on records they cannot otherwise read';
exception when sqlstate '42501' then
  if sqlerrm <> 'document_removal_not_authorized' then raise; end if;
end
$$;

select set_config('request.jwt.claim.sub', '20360000-0000-4000-8000-000000000001', true);
select pg_temp.p36_assert(
  (select (r ->> 'found')::boolean
   from public.get_document_removal_impact('60360000-0000-4000-8000-000000000001') r),
  'the owner cannot read the impact preview through the public wrapper');

reset role;
rollback;
