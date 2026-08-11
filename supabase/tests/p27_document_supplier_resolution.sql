-- P27 -- who sent this document, decided from evidence, and never guessed.
--
-- Before 0106 the only answer the product had was `documents.suggested_supplier_id`, a generated
-- column over the model's own guess (0046:222-224) validated against a candidate list the edge
-- function itself supplied (core.ts:829-831) -- and `suppliers.tax_id` was not even sent to the
-- model as context (index.ts:1134 selects id,name,status). Every assertion below is one way a
-- resolver can attach a document to the wrong supplier: a wrong tenant, a soft-deleted row, a
-- shared SKU, a name that merely looks the same, or the model's guess quietly promoted to a fact.
-- Attaching a document to the wrong supplier is how a credit request lands on an innocent one.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p27_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P27 supplier resolution assertion failed: %', p_message;
  end if;
end
$$;

-- The payload shape the extraction contract produces: `fields` is a list of {key,value} objects and
-- `line_items` a list whose per-line values live under `values`. Anything the resolver reads, a
-- caller has to be able to build -- so the suite builds it the same way the pipeline does.
create function pg_temp.p27_payload(
  p_vat text default null,
  p_name text default null,
  p_suggested uuid default null,
  p_lines jsonb default '[]'::jsonb
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'fields', case when p_vat is null then '[]'::jsonb
                   else jsonb_build_array(jsonb_build_object('key', 'supplier_vat_id', 'value', p_vat))
              end,
    'line_items', p_lines,
    'supplier', jsonb_strip_nulls(jsonb_build_object(
      'suggested_name', p_name, 'suggested_id', p_suggested))
  );
$$;

create function pg_temp.p27_resolve(p_payload jsonb, p_document uuid default null)
returns jsonb language sql as $$
  select private.resolve_document_supplier(
    '1a270000-0000-4000-8000-000000000001', p_document, p_payload);
$$;

create function pg_temp.p27_line(p_sku text default null, p_barcode text default null)
returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object('values',
    jsonb_strip_nulls(jsonb_build_object('sku', p_sku, 'barcode', p_barcode))));
$$;

insert into public.organizations (id, name, status) values
  ('1a270000-0000-4000-8000-000000000001', 'P27 mine', 'active'),
  ('1a270000-0000-4000-8000-000000000002', 'P27 other tenant', 'active');

-- Two suppliers whose names normalise to the SAME key -- Hebrew gershayim and doubled spacing are
-- what real invoices print. Tier 4 must report both rather than pick the first.
insert into public.suppliers (id, org_id, name, tax_id, status) values
  ('4a270000-0000-4000-8000-000000000001', '1a270000-0000-4000-8000-000000000001',
   'מרכז הבשר בן דוד', '511234567', 'active'),
  ('4a270000-0000-4000-8000-000000000002', '1a270000-0000-4000-8000-000000000001',
   'מרכז  ה"בשר בן דוד', '512222222', 'active'),
  -- An inactive supplier: still a candidate, with its status surfaced. Suppressing it would turn a
  -- document from a supplier someone paused into "unknown supplier" (p16_inactive_supplier_semantics).
  ('4a270000-0000-4000-8000-000000000003', '1a270000-0000-4000-8000-000000000001',
   'ספק מושהה', '513333333', 'inactive'),
  -- Soft-deleted, sharing the deleted supplier's printed VAT number with nobody.
  ('4a270000-0000-4000-8000-000000000004', '1a270000-0000-4000-8000-000000000001',
   'ספק שנמחק', '514444444', 'active'),
  ('4a270000-0000-4000-8000-000000000005', '1a270000-0000-4000-8000-000000000001',
   'ספק יחיד לזיהוי', '515555555', 'active'),
  ('4a270000-0000-4000-8000-000000000006', '1a270000-0000-4000-8000-000000000001',
   'ספק שני עם אותו מק"ט', '516666666', 'active'),
  -- Another tenant's supplier, deliberately carrying the SAME tax id and the SAME normalised name
  -- as one of ours. Every tier must be blind to it.
  ('4a270000-0000-4000-8000-000000000007', '1a270000-0000-4000-8000-000000000002',
   'מרכז הבשר בן דוד', '511234567', 'active');
update public.suppliers set deleted_at = now()
  where id = '4a270000-0000-4000-8000-000000000004';

insert into public.products (id, org_id, name, unit, barcode) values
  ('3a270000-0000-4000-8000-000000000001', '1a270000-0000-4000-8000-000000000001',
   'P27 מוצר עם ברקוד', 'unit', '7290000000017'),
  ('3a270000-0000-4000-8000-000000000002', '1a270000-0000-4000-8000-000000000001',
   'P27 מוצר משותף', 'unit', '7290000000024');

insert into public.supplier_products (org_id, supplier_id, product_id, current_price, supplier_sku) values
  -- A SKU only supplier 5 lists: decisive.
  ('1a270000-0000-4000-8000-000000000001', '4a270000-0000-4000-8000-000000000005',
   '3a270000-0000-4000-8000-000000000001', 10, 'SKU-UNIQUE'),
  -- The same printed SKU string on two suppliers: evidence about nothing.
  ('1a270000-0000-4000-8000-000000000001', '4a270000-0000-4000-8000-000000000005',
   '3a270000-0000-4000-8000-000000000002', 11, 'SKU-SHARED'),
  ('1a270000-0000-4000-8000-000000000001', '4a270000-0000-4000-8000-000000000006',
   '3a270000-0000-4000-8000-000000000002', 12, 'SKU-SHARED');

insert into public.documents (
  id, org_id, entity_type, storage_path, file_name, document_kind, supplier_id
) values
  ('6a270000-0000-4000-8000-000000000001', '1a270000-0000-4000-8000-000000000001',
   'inbox', '1a270000-0000-4000-8000-000000000001/p27-linked.pdf', 'p27-linked.pdf',
   'invoice', '4a270000-0000-4000-8000-000000000005'),
  ('6a270000-0000-4000-8000-000000000002', '1a270000-0000-4000-8000-000000000001',
   'inbox', '1a270000-0000-4000-8000-000000000001/p27-unlinked.pdf', 'p27-unlinked.pdf',
   'invoice', null),
  ('6a270000-0000-4000-8000-000000000003', '1a270000-0000-4000-8000-000000000001',
   'inbox', '1a270000-0000-4000-8000-000000000001/p27-deleted.pdf', 'p27-deleted.pdf',
   'invoice', '4a270000-0000-4000-8000-000000000005');
update public.documents set deleted_at = now()
  where id = '6a270000-0000-4000-8000-000000000003';

-- ===== 1. The ladder resolves, and says which rung it stood on =====

select pg_temp.p27_assert(
  (pg_temp.p27_resolve(pg_temp.p27_payload(p_vat => '51-123456-7')) || '{}'::jsonb)
    @> jsonb_build_object(
      'resolved', true,
      'supplier_id', '4a270000-0000-4000-8000-000000000001',
      'matched_by', 'tax_id'),
  'a printed VAT number with separators did not match the registered tax id');

select pg_temp.p27_assert(
  (pg_temp.p27_resolve(pg_temp.p27_payload(), '6a270000-0000-4000-8000-000000000001')
   || '{}'::jsonb) @> jsonb_build_object(
     'resolved', true,
     'supplier_id', '4a270000-0000-4000-8000-000000000005',
     'matched_by', 'document_supplier'),
  'the supplier already recorded on the document row was ignored');

select pg_temp.p27_assert(
  (pg_temp.p27_resolve(pg_temp.p27_payload(p_lines => pg_temp.p27_line(p_sku => 'SKU-UNIQUE')))
   || '{}'::jsonb) @> jsonb_build_object(
     'resolved', true,
     'supplier_id', '4a270000-0000-4000-8000-000000000005',
     'matched_by', 'supplier_sku'),
  'a printed SKU that only one supplier lists did not identify that supplier');

select pg_temp.p27_assert(
  (pg_temp.p27_resolve(pg_temp.p27_payload(p_lines => pg_temp.p27_line(p_barcode => '7290000000017')))
   || '{}'::jsonb) @> jsonb_build_object(
     'resolved', true,
     'supplier_id', '4a270000-0000-4000-8000-000000000005',
     'matched_by', 'barcode'),
  'a printed barcode whose product exactly one supplier lists did not identify that supplier');

select pg_temp.p27_assert(
  (pg_temp.p27_resolve(pg_temp.p27_payload(p_name => 'ספק יחיד לזיהוי')) || '{}'::jsonb)
    @> jsonb_build_object(
      'resolved', true,
      'supplier_id', '4a270000-0000-4000-8000-000000000005',
      'matched_by', 'exact_name'),
  'an exactly-matching normalised name did not resolve');

-- Rung order matters, not just rung existence. The VAT number here belongs to supplier 1 while the
-- document row points at supplier 5 and the printed name matches supplier 5: the strongest evidence
-- has to win, or the ladder is decoration.
select pg_temp.p27_assert(
  (pg_temp.p27_resolve(
     pg_temp.p27_payload(p_vat => '511234567', p_name => 'ספק יחיד לזיהוי'),
     '6a270000-0000-4000-8000-000000000001') || '{}'::jsonb)
    @> jsonb_build_object('matched_by', 'tax_id',
                          'supplier_id', '4a270000-0000-4000-8000-000000000001'),
  'a weaker rung overrode the printed VAT number');

-- ===== 2. What must never resolve =====

select pg_temp.p27_assert(
  (select r ->> 'resolved' = 'false' and r ->> 'reason' = 'ambiguous'
          and jsonb_array_length(r -> 'candidates') = 2
   from pg_temp.p27_resolve(pg_temp.p27_payload(p_name => 'מרכז הבשר בן דוד')) r),
  'two suppliers whose names normalise identically produced a single answer -- the resolver chose '
  'among candidates, which is the one thing it must never do');

select pg_temp.p27_assert(
  (select r ->> 'resolved' = 'false' and r ->> 'reason' = 'no_evidence'
   from pg_temp.p27_resolve(pg_temp.p27_payload(p_lines => pg_temp.p27_line(p_sku => 'SKU-SHARED'))) r),
  'a SKU printed by two suppliers was treated as evidence for one of them');

select pg_temp.p27_assert(
  (select r ->> 'resolved' = 'false' and r ->> 'reason' = 'no_evidence'
          and jsonb_array_length(r -> 'candidates') = 0
   from pg_temp.p27_resolve(pg_temp.p27_payload(p_vat => '514444444')) r),
  'a soft-deleted supplier was offered as a match');

select pg_temp.p27_assert(
  (select r ->> 'resolved' = 'false' and r ->> 'reason' = 'no_evidence'
   from pg_temp.p27_resolve(pg_temp.p27_payload(), '6a270000-0000-4000-8000-000000000003') r),
  'a soft-deleted document still handed over its recorded supplier');

select pg_temp.p27_assert(
  (select r ->> 'resolved' = 'false' and r ->> 'reason' = 'no_evidence'
   from pg_temp.p27_resolve(pg_temp.p27_payload(p_name => 'שם שלא קיים אצל אף ספק')) r),
  'a name matching nobody produced a match');

-- A short number is a document number, an order number, a phone extension -- not a company id.
select pg_temp.p27_assert(
  (select r ->> 'reason' = 'no_evidence'
   from pg_temp.p27_resolve(pg_temp.p27_payload(p_vat => '1234')) r),
  'a four-digit string was accepted as a VAT number');

select pg_temp.p27_assert(
  (select r ->> 'reason' = 'missing_identifiers'
   from private.resolve_document_supplier(
     null, '6a270000-0000-4000-8000-000000000001',
     pg_temp.p27_payload(p_vat => '511234567')) r),
  'a null org_id produced an answer instead of missing_identifiers');

select pg_temp.p27_assert(
  (select r ->> 'reason' = 'missing_identifiers'
   from private.resolve_document_supplier(
     '1a270000-0000-4000-8000-000000000001',
     '6a270000-0000-4000-8000-000000000001', null) r),
  'a null payload produced an answer instead of missing_identifiers');

-- ===== 3. Tenancy: the org_id argument is the boundary, on every rung =====
--
-- The other tenant's supplier carries the same tax id AND the same normalised name as ours. If any
-- rung leaks, this is where it shows -- and it would show as a document attached to a company in
-- someone else's business.

select pg_temp.p27_assert(
  (select bool_and((c ->> 'supplier_id')::uuid <> '4a270000-0000-4000-8000-000000000007')
   from jsonb_array_elements(
     pg_temp.p27_resolve(pg_temp.p27_payload(p_vat => '511234567')) -> 'candidates') as c),
  'the VAT rung returned another tenant''s supplier');

select pg_temp.p27_assert(
  (select private.resolve_document_supplier(
     '1a270000-0000-4000-8000-000000000002', null,
     pg_temp.p27_payload(p_name => 'מרכז הבשר בן דוד')) ->> 'supplier_id'
   = '4a270000-0000-4000-8000-000000000007'),
  'read as the other tenant, the name rung did not return that tenant''s own supplier -- the org_id '
  'argument is not what the resolver filters on');

select pg_temp.p27_assert(
  (select r ->> 'reason' = 'no_evidence'
   from private.resolve_document_supplier(
     '1a270000-0000-4000-8000-000000000002',
     '6a270000-0000-4000-8000-000000000001', pg_temp.p27_payload()) r),
  'a document id from another org was read by passing that org''s id alongside it');

-- ===== 4. The model's guess is a candidate, never an answer =====
--
-- This is the whole difference from what exists today. `suggested_supplier_id` (0046:222-224) is the
-- model's guess promoted to a column; here the same guess arrives as a candidate flagged
-- authoritative=false, and it must not move `resolved` even when it is the only thing present.

select pg_temp.p27_assert(
  (select r ->> 'resolved' = 'false' and r ->> 'reason' = 'no_evidence'
          and jsonb_array_length(r -> 'candidates') = 1
          and r #>> '{candidates,0,matched_by}' = 'model_suggestion'
          and (r #> '{candidates,0,authoritative}')::boolean = false
   from pg_temp.p27_resolve(
     pg_temp.p27_payload(p_suggested => '4a270000-0000-4000-8000-000000000005')) r),
  'the model''s suggestion resolved a document by itself');

-- When the evidence disagrees with the model, both are shown. That disagreement is the most useful
-- thing on the review screen and the easiest thing to drop.
select pg_temp.p27_assert(
  (select r ->> 'supplier_id' = '4a270000-0000-4000-8000-000000000001'
          and jsonb_array_length(r -> 'candidates') = 2
          and r #>> '{candidates,1,matched_by}' = 'model_suggestion'
   from pg_temp.p27_resolve(pg_temp.p27_payload(
     p_vat => '511234567',
     p_suggested => '4a270000-0000-4000-8000-000000000005')) r),
  'evidence and the model disagreed and the disagreement was hidden');

select pg_temp.p27_assert(
  (select jsonb_array_length(r -> 'candidates') = 1
   from pg_temp.p27_resolve(pg_temp.p27_payload(
     p_vat => '511234567',
     p_suggested => '4a270000-0000-4000-8000-000000000001')) r),
  'the model agreeing with the evidence produced the same supplier twice');

select pg_temp.p27_assert(
  (select jsonb_array_length(r -> 'candidates') = 0
   from pg_temp.p27_resolve(
     pg_temp.p27_payload(p_suggested => '4a270000-0000-4000-8000-000000000007')) r),
  'the model suggested another tenant''s supplier and it was echoed back as a candidate');

-- ===== 5. A paused supplier is still the supplier =====

select pg_temp.p27_assert(
  (pg_temp.p27_resolve(pg_temp.p27_payload(p_vat => '513333333')) || '{}'::jsonb)
    @> jsonb_build_object('resolved', true,
                          'supplier_id', '4a270000-0000-4000-8000-000000000003'),
  'an inactive supplier was excluded, turning a known supplier into an unknown one');
select pg_temp.p27_assert(
  (select r #>> '{candidates,0,status}' = 'inactive'
   from pg_temp.p27_resolve(pg_temp.p27_payload(p_vat => '513333333')) r),
  'the candidate did not carry the status the reviewer needs to see before approving');

-- ===== 6. Resolving is a read =====

create temp table p27_before as
  select id, supplier_id, document_kind from public.documents
  where org_id = '1a270000-0000-4000-8000-000000000001';

select pg_temp.p27_resolve(pg_temp.p27_payload(p_vat => '511234567'),
                           '6a270000-0000-4000-8000-000000000002');
select pg_temp.p27_resolve(pg_temp.p27_payload(p_name => 'מרכז הבשר בן דוד'),
                           '6a270000-0000-4000-8000-000000000002');

select pg_temp.p27_assert(
  not exists (
    select 1 from p27_before b join public.documents d on d.id = b.id
    where d.supplier_id is distinct from b.supplier_id
       or d.document_kind is distinct from b.document_kind),
  'resolving a supplier wrote it onto the document -- attaching a supplier is an approved action, '
  'not a side effect of reading');

-- ===== 7. The normalisation corpus, pinned on both sides =====
--
-- `private.name_match_key` is the SQL twin of `nameKey` in src/lib/nameKey.ts, and src/lib/
-- nameKey.spec.ts pins this same corpus on the client. Two normalisers that disagree mean a name
-- the screen shows as matching and the server does not, or the reverse.

select pg_temp.p27_assert(
  private.name_match_key(
    (select name from public.suppliers where id = '4a270000-0000-4000-8000-000000000002'))
  = private.name_match_key(
    (select name from public.suppliers where id = '4a270000-0000-4000-8000-000000000001')),
  'quotes are stripped rather than replaced by a space, and runs of whitespace fold to one. The '
  'two fixture names above differ only by a gershayim and a doubled space; if they stop colliding '
  'then section 2 has stopped testing ambiguity and nameKey on the client has drifted from here');
select pg_temp.p27_assert(
  private.name_match_key(e'alpha  foods') = 'alpha foods',
  'a non-breaking space survived normalisation -- JS \\s folds it and Postgres \\s does not, which '
  'is the one divergence name_match_key exists to close');
select pg_temp.p27_assert(
  private.name_match_key('alpha' || chr(160) || 'foods') = 'alpha foods'
  and private.name_match_key('beta' || chr(8239) || 'foods') = 'beta foods',
  'the same two spaces stated as code points rather than as bytes in this file -- U+00A0 and '
  'U+202F, the pair `translate` folds; an editor that normalised the literal above would have made '
  'that assertion pass without testing anything');
select pg_temp.p27_assert(
  private.name_match_key('  ') is null and private.name_match_key(null) is null,
  'a blank name normalised to something matchable');
select pg_temp.p27_assert(
  private.vat_number_key('12-345678-9') = '123456789'
  and private.vat_number_key('7') is null
  and private.vat_number_key(null) is null,
  'the VAT key no longer strips to digits with an eight-digit floor');

-- ===== 8. The browser cannot reach any of it =====

select pg_temp.p27_assert(
  not has_schema_privilege('authenticated', 'private', 'usage')
  and not has_schema_privilege('anon', 'private', 'usage'),
  'a client role gained USAGE on private -- resolve_document_supplier takes org_id as an argument '
  'and would trust whatever a browser passed');

rollback;
