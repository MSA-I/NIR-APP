-- P28 -- which order is this document about, and which tiers is this KIND of document allowed to
-- answer with.
--
-- The subtype policy is the reason 0107 exists, so it is the reason this suite exists. Two live
-- commands already match orders and they disagree deliberately: 0077:1134-1141 refuses the "single
-- open order" heuristic for invoices by name, and 0090:257-262 records the owner accepting it for
-- delivery notes only because the artefact is a draft a person confirms. A resolver that served
-- both without a tier parameter would have to erase one of those positions, and the erasure would
-- be invisible -- an invoice quietly attached to the wrong order, corrupting order status and every
-- savings figure computed from it.
--
-- Each assertion below is one way that erasure could happen: a tier fired for a subtype that must
-- not have it, a cancelled order accepted, a closed order rejected, partial item coverage treated
-- as evidence, an advisory candidate promoted to a match, or another tenant's order returned.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p28_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P28 order resolution assertion failed: %', p_message;
  end if;
end
$$;

-- The payload shape the extraction contract produces: `fields` is a list of {key,value} objects.
-- The suite builds it the way the pipeline does, so that a key the resolver stops reading shows up
-- here as a failure rather than as a silently unmatched document.
create function pg_temp.p28_payload(p_order_number text default null, p_date text default null)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'fields', coalesce((
      select jsonb_agg(jsonb_build_object('key', f.k, 'value', f.v))
      from (values ('order_number', p_order_number), ('invoice_date', p_date)) as f(k, v)
      where f.v is not null), '[]'::jsonb),
    'line_items', '[]'::jsonb);
$$;

create function pg_temp.p28_resolve(
  p_type text,
  p_supplier uuid,
  p_payload jsonb default null,
  p_date date default null,
  p_products uuid[] default null,
  p_org uuid default '1a280000-0000-4000-8000-000000000001'
) returns jsonb language sql stable as $$
  select private.resolve_document_order(
    p_org, p_supplier, p_type, coalesce(p_payload, pg_temp.p28_payload()), p_date, p_products);
$$;

-- The suite cannot choose the numbers a document would print -- it has to read back the ones the
-- database assigned. Anything else would be testing a number the product can never produce. This
-- was true when the column was `generated always as identity`, and `0294` kept it true by a
-- different route: the per-tenant allocator RAISES `org_number_is_allocated_not_supplied` on an
-- explicit number rather than honouring it, so the refusal moved from storage to the trigger.
create function pg_temp.p28_num(p_order uuid)
returns text language sql stable as $$
  select number::text from public.purchase_orders where id = p_order;
$$;

insert into public.organizations (id, name, status) values
  ('1a280000-0000-4000-8000-000000000001', 'P28 mine', 'active'),
  ('1a280000-0000-4000-8000-000000000002', 'P28 other tenant', 'active');

insert into public.suppliers (id, org_id, name, status) values
  ('4a280000-0000-4000-8000-000000000001', '1a280000-0000-4000-8000-000000000001',
   'P28 ספק עם כמה הזמנות', 'active'),
  ('4a280000-0000-4000-8000-000000000002', '1a280000-0000-4000-8000-000000000001',
   'P28 ספק עם הזמנה פתוחה אחת', 'active'),
  ('4a280000-0000-4000-8000-000000000003', '1a280000-0000-4000-8000-000000000002',
   'P28 ספק של דייר אחר', 'active'),
  -- S4 exists to exercise the date tier in isolation. It has TWO open orders, so single_open_order
  -- can never fire for it, and their expected dates sit two days apart, so the same supplier can
  -- produce a decisive window, an ambiguous one and an empty one depending only on the document
  -- date.
  ('4a280000-0000-4000-8000-000000000004', '1a280000-0000-4000-8000-000000000001',
   'P28 ספק לבדיקת קרבת תאריכים', 'active');

insert into public.products (id, org_id, name, unit) values
  ('3a280000-0000-4000-8000-000000000001', '1a280000-0000-4000-8000-000000000001', 'P28 מוצר א', 'unit'),
  ('3a280000-0000-4000-8000-000000000002', '1a280000-0000-4000-8000-000000000001', 'P28 מוצר ב', 'unit'),
  ('3a280000-0000-4000-8000-000000000003', '1a280000-0000-4000-8000-000000000001', 'P28 מוצר ג', 'unit'),
  ('3a280000-0000-4000-8000-000000000004', '1a280000-0000-4000-8000-000000000001',
   'P28 מוצר שמעולם לא הוזמן', 'unit'),
  ('3a280000-0000-4000-8000-000000000005', '1a280000-0000-4000-8000-000000000002',
   'P28 מוצר של דייר אחר', 'unit'),
  ('3a280000-0000-4000-8000-000000000006', '1a280000-0000-4000-8000-000000000001',
   'P28 מוצר של ספק התאריכים', 'unit');

-- O1 is CLOSED. A supplier's invoice usually arrives after the goods were received, so an explicit
-- printed number has to reach it; if `by_number` inherited 0090's open-status set, every invoice for
-- a completed order would become unlinkable. O4 is cancelled and must be unreachable by any tier.
-- O2, O3 and O7 are S1's three open orders, which is what keeps `single_open_order` silent for S1.
insert into public.purchase_orders (id, org_id, supplier_id, status, expected_date) values
  ('5a280000-0000-4000-8000-000000000001', '1a280000-0000-4000-8000-000000000001',
   '4a280000-0000-4000-8000-000000000001', 'received',  '2026-01-10'),
  ('5a280000-0000-4000-8000-000000000002', '1a280000-0000-4000-8000-000000000001',
   '4a280000-0000-4000-8000-000000000001', 'sent',      '2026-03-01'),
  ('5a280000-0000-4000-8000-000000000003', '1a280000-0000-4000-8000-000000000001',
   '4a280000-0000-4000-8000-000000000001', 'sent',      '2026-03-20'),
  ('5a280000-0000-4000-8000-000000000004', '1a280000-0000-4000-8000-000000000001',
   '4a280000-0000-4000-8000-000000000001', 'cancelled', '2026-02-01'),
  ('5a280000-0000-4000-8000-000000000005', '1a280000-0000-4000-8000-000000000001',
   '4a280000-0000-4000-8000-000000000002', 'sent',      '2026-03-05'),
  ('5a280000-0000-4000-8000-000000000006', '1a280000-0000-4000-8000-000000000002',
   '4a280000-0000-4000-8000-000000000003', 'sent',      '2026-03-12'),
  ('5a280000-0000-4000-8000-000000000007', '1a280000-0000-4000-8000-000000000001',
   '4a280000-0000-4000-8000-000000000001', 'partial',   null),
  -- S4's two open orders, two days apart. See the supplier comment above.
  ('5a280000-0000-4000-8000-000000000008', '1a280000-0000-4000-8000-000000000001',
   '4a280000-0000-4000-8000-000000000004', 'sent',      '2026-05-10'),
  ('5a280000-0000-4000-8000-000000000009', '1a280000-0000-4000-8000-000000000001',
   '4a280000-0000-4000-8000-000000000004', 'confirmed', '2026-05-12');

insert into public.purchase_order_items (org_id, order_id, product_id, qty, unit_price) values
  ('1a280000-0000-4000-8000-000000000001', '5a280000-0000-4000-8000-000000000001',
   '3a280000-0000-4000-8000-000000000001', 5, 10),
  -- O2 alone lists product ג: full coverage of {ג} names exactly one order.
  ('1a280000-0000-4000-8000-000000000001', '5a280000-0000-4000-8000-000000000002',
   '3a280000-0000-4000-8000-000000000001', 5, 10),
  ('1a280000-0000-4000-8000-000000000001', '5a280000-0000-4000-8000-000000000002',
   '3a280000-0000-4000-8000-000000000002', 5, 10),
  ('1a280000-0000-4000-8000-000000000001', '5a280000-0000-4000-8000-000000000002',
   '3a280000-0000-4000-8000-000000000003', 5, 10),
  -- O3 lists {א,ב} too, so a document printing only those two is what two concurrent orders to one
  -- supplier look like -- ambiguous, never a match.
  ('1a280000-0000-4000-8000-000000000001', '5a280000-0000-4000-8000-000000000003',
   '3a280000-0000-4000-8000-000000000001', 5, 10),
  ('1a280000-0000-4000-8000-000000000001', '5a280000-0000-4000-8000-000000000003',
   '3a280000-0000-4000-8000-000000000002', 5, 10),
  ('1a280000-0000-4000-8000-000000000001', '5a280000-0000-4000-8000-000000000004',
   '3a280000-0000-4000-8000-000000000001', 5, 10),
  ('1a280000-0000-4000-8000-000000000001', '5a280000-0000-4000-8000-000000000005',
   '3a280000-0000-4000-8000-000000000001', 5, 10),
  ('1a280000-0000-4000-8000-000000000002', '5a280000-0000-4000-8000-000000000006',
   '3a280000-0000-4000-8000-000000000005', 5, 10),
  -- Only O8 lists this product, so a document naming it has full coverage of exactly one order --
  -- which is how section 4b proves the item tier still outranks the date tier.
  ('1a280000-0000-4000-8000-000000000001', '5a280000-0000-4000-8000-000000000008',
   '3a280000-0000-4000-8000-000000000006', 5, 10);

-- ===== 1. The subtype policy, which is the whole point =====

select pg_temp.p28_assert(
  private.document_order_tiers('invoice') = array['by_number', 'by_items', 'by_date_proximity']
  and private.document_order_tiers('delivery_note')
      = array['by_number', 'by_items', 'by_date_proximity', 'single_open_order']
  and private.document_order_tiers('tax_receipt') = array['by_number']
  and cardinality(private.document_order_tiers('price_list')) = 0
  and cardinality(private.document_order_tiers(null)) = 0,
  'the per-subtype tier policy changed. It is not a preference: an invoice without '
  'single_open_order is 0077:1134-1141, a delivery note with it is the owner exception of '
  '09.08.2026 that 0090:257-262 records, a receipt with by_number alone is OPEN-DECISIONS #141, '
  'and by_date_proximity on the two goods subtypes is OPEN-DECISIONS #148');

select pg_temp.p28_assert(
  private.document_order_tiers('  INVOICE  ')
    = array['by_number', 'by_items', 'by_date_proximity'],
  'the subtype is matched case- and whitespace-sensitively, so a document_type that arrived with a '
  'trailing space would silently lose every tier it is entitled to');

-- The window is a decision with a date on it, not a tuning knob. Widening it to thirty days would
-- make far more documents "match" and would be indistinguishable, from the outside, from the
-- resolver getting better at its job.
select pg_temp.p28_assert(
  private.document_order_date_window() = 5,
  'the date-proximity window is no longer the five days the owner decided on 11.08.2026 '
  '(OPEN-DECISIONS #148)');

select pg_temp.p28_assert(
  (select r ->> 'reason' = 'subtype_has_no_tiers'
          and jsonb_array_length(r -> 'candidates') = 0
   from pg_temp.p28_resolve('price_list', '4a280000-0000-4000-8000-000000000002') r),
  'a subtype with no tier policy still produced candidates -- an unknown subtype must resolve '
  'nothing, not fall through to the most permissive rule available');

-- ===== 2. by_number: the number printed on the page, at any status but cancelled =====

select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'true'
          and r ->> 'order_id' = '5a280000-0000-4000-8000-000000000001'
          and r ->> 'matched_by' = 'by_number'
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000001',
     pg_temp.p28_payload(pg_temp.p28_num('5a280000-0000-4000-8000-000000000001'))) r),
  'an invoice printing the number of an already-RECEIVED order did not link to it. This is the '
  'common case, not the edge one: the invoice arrives after the goods. Restricting by_number to '
  'open statuses would make every such invoice unlinkable');

select pg_temp.p28_assert(
  (select r ->> 'reason' = 'no_evidence'
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000001',
     pg_temp.p28_payload(pg_temp.p28_num('5a280000-0000-4000-8000-000000000004'))) r),
  'a cancelled order was matched by its printed number');

-- Rung order: the number is stronger than the items. Here the printed number names O3 while the
-- products name O2 exclusively -- the printed number has to win, or the ladder is decoration.
select pg_temp.p28_assert(
  (select r ->> 'order_id' = '5a280000-0000-4000-8000-000000000003'
          and r ->> 'matched_by' = 'by_number'
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000001',
     pg_temp.p28_payload(pg_temp.p28_num('5a280000-0000-4000-8000-000000000003')),
     null, array['3a280000-0000-4000-8000-000000000003']::uuid[]) r),
  'the item tier overrode the printed order number');

-- A supplier printing a date-shaped reference raised `22003: integer out of range` from the cast
-- itself in 0077 and aborted the whole command mid-write. It must be a silent non-match here.
select pg_temp.p28_assert(
  (select r ->> 'reason' = 'no_evidence'
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000001',
     pg_temp.p28_payload('20260403001')) r),
  'a date-shaped order reference either raised or matched something; it must do neither');

select pg_temp.p28_assert(
  private.document_order_number(pg_temp.p28_payload('4.5')) is null
  and private.document_order_number(pg_temp.p28_payload('0')) is null
  and private.document_order_number(pg_temp.p28_payload('לא מספר')) is null,
  'a fractional, zero or non-numeric order reference survived as an order number');

-- ===== 3. by_items: full coverage, or nothing =====

select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'true'
          and r ->> 'order_id' = '5a280000-0000-4000-8000-000000000002'
          and r ->> 'matched_by' = 'by_items'
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000001', null, null,
     array['3a280000-0000-4000-8000-000000000003']::uuid[]) r),
  'an order containing every product the document lists, and the only such order, did not match');

select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'false' and r ->> 'reason' = 'ambiguous'
          and jsonb_array_length(r -> 'candidates') = 2
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000001', null, null,
     array['3a280000-0000-4000-8000-000000000001',
           '3a280000-0000-4000-8000-000000000002']::uuid[]) r),
  'two open orders both cover the document''s products and one of them was chosen. Choosing among '
  'candidates is the one thing the resolver must never do');

select pg_temp.p28_assert(
  (select r ->> 'reason' = 'no_evidence'
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000001', null, null,
     array['3a280000-0000-4000-8000-000000000001',
           '3a280000-0000-4000-8000-000000000004']::uuid[]) r),
  'partial coverage was treated as evidence -- an order containing only SOME of the document''s '
  'products is exactly what a second concurrent order looks like');

select pg_temp.p28_assert(
  (select r ->> 'reason' = 'no_evidence'
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000001', null, null, array[]::uuid[]) r),
  'an empty product list matched every order, because "contains all of nothing" is true of all of '
  'them. A document whose lines could not be mapped knows nothing about which order it belongs to');

select pg_temp.p28_assert(
  (select r ->> 'reason' = 'no_evidence'
   from pg_temp.p28_resolve(
     'tax_receipt', '4a280000-0000-4000-8000-000000000001', null, null,
     array['3a280000-0000-4000-8000-000000000003']::uuid[]) r),
  'a receipt was matched by product coverage. A receipt prints amounts, not goods -- the item tier '
  'has nothing to read on one, and it is not in its tier set');

-- ===== 3b. by_date_proximity: the owner's five days, and the silence on either side of them =====
--
-- 0107 refused to build this tier while the threshold was an invented business answer. The owner
-- gave the number on 11.08.2026, and 0120 built it in the only shape that cannot choose among
-- candidates: exactly one qualifying order, or nothing. S4 has two open orders two days apart, so
-- moving only the document date walks the tier through all three of its outcomes.

-- Decisive: 16.05 is four days from O9 and six from O8. One order qualifies, so one is the answer.
select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'true'
          and r ->> 'order_id' = '5a280000-0000-4000-8000-000000000009'
          and r ->> 'matched_by' = 'by_date_proximity'
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000004', null, date '2026-05-16') r),
  'the only order whose expected delivery falls inside the owner''s five-day window was not '
  'matched. This is the tier OPEN-DECISIONS #148 asked for');

-- Six days is outside five. The boundary is asserted from both sides, because an off-by-one here
-- would be invisible in every other assertion in this file.
select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'true' and r ->> 'order_id' = '5a280000-0000-4000-8000-000000000009'
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000004', null, date '2026-05-17') r)
  and (select r ->> 'reason' = 'no_evidence'
       from pg_temp.p28_resolve(
         'invoice', '4a280000-0000-4000-8000-000000000004', null, date '2026-05-18') r),
  'the five-day window is not inclusive of exactly five days: 17.05 is five days from O9 and must '
  'match, 18.05 is six and must not');

-- Ambiguous: 11.05 sits one day from O9 and one from O8. Two qualifying orders is the case the
-- whole design of this tier exists to refuse.
select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'false' and r ->> 'order_id' is null
          and r ->> 'reason' = 'no_evidence'
          and jsonb_array_length(r -> 'candidates') = 2
          and (select bool_and((c ->> 'authoritative')::boolean = false)
               from jsonb_array_elements(r -> 'candidates') c)
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000004', null, date '2026-05-11') r),
  'TWO orders fell inside the window and one of them was chosen. The tier is safe only because it '
  'fires on exactly one qualifying order or not at all -- and when it stays silent both orders must '
  'still reach the screen, as advisory candidates, for a person to choose between');

-- Silent with no date at all. A document that printed no date knows nothing about which delivery it
-- describes, and proximity to an unknown date is not proximity.
select pg_temp.p28_assert(
  (select r ->> 'reason' = 'no_evidence'
   from pg_temp.p28_resolve('invoice', '4a280000-0000-4000-8000-000000000004') r),
  'a document with no date was matched by date proximity');

-- An order with no expected date cannot participate. O7 is S1's open order with a null expected
-- date; a null must not be read as "close enough to everything".
select pg_temp.p28_assert(
  (select r ->> 'reason' = 'no_evidence'
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000001', null, date '2026-08-01') r),
  'an order with no expected delivery date was matched by date proximity, which would make a null '
  'the closest date to everything');

-- Rung order: the goods still outrank the calendar. Here the date names O9 and the products cover
-- O8 exclusively -- the products have to win, or the ladder is decoration.
select pg_temp.p28_assert(
  (select r ->> 'order_id' = '5a280000-0000-4000-8000-000000000008'
          and r ->> 'matched_by' = 'by_items'
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000004', null, date '2026-05-16',
     array['3a280000-0000-4000-8000-000000000006']::uuid[]) r),
  'the date tier overrode full product coverage');

-- A receipt is not in the tier's subtype set. Its date is a payment date, not a delivery date, so
-- proximity to a delivery window would be reading a coincidence (OPEN-DECISIONS #141).
select pg_temp.p28_assert(
  (select r ->> 'reason' = 'no_evidence'
   from pg_temp.p28_resolve(
     'tax_receipt', '4a280000-0000-4000-8000-000000000004', null, date '2026-05-16') r),
  'a receipt was matched by date proximity');

-- ===== 4. single_open_order: the owner exception, and only where it was granted =====

select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'true'
          and r ->> 'order_id' = '5a280000-0000-4000-8000-000000000005'
          and r ->> 'matched_by' = 'single_open_order'
   from pg_temp.p28_resolve('delivery_note', '4a280000-0000-4000-8000-000000000002') r),
  'a delivery note from a supplier with exactly one open order did not reach it -- the tier the '
  'owner accepted on 09.08.2026 has stopped working');

select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'false' and r ->> 'reason' = 'no_evidence'
   from pg_temp.p28_resolve('invoice', '4a280000-0000-4000-8000-000000000002') r),
  'AN INVOICE WAS MATCHED BY THE SINGLE OPEN ORDER. This is the assertion the whole migration is '
  'for: 0077:1134-1141 refuses it by name, because it attaches an invoice to the wrong order '
  'whenever the supplier has one open order and the document belongs to another');

select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'false' and r ->> 'reason' = 'no_evidence'
   from pg_temp.p28_resolve('tax_receipt', '4a280000-0000-4000-8000-000000000002') r),
  'a receipt was matched by the single open order');

select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'false' and r ->> 'reason' = 'no_evidence'
   from pg_temp.p28_resolve('delivery_note', '4a280000-0000-4000-8000-000000000001') r),
  'the single-open-order tier fired for a supplier with THREE open orders. It is safe only because '
  'it cannot be ambiguous: exactly one open order or silence');

-- The receipt still reaches its order the one way it is allowed to.
select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'true' and r ->> 'matched_by' = 'by_number'
          and r ->> 'order_id' = '5a280000-0000-4000-8000-000000000002'
   from pg_temp.p28_resolve(
     'tax_receipt', '4a280000-0000-4000-8000-000000000001',
     pg_temp.p28_payload(pg_temp.p28_num('5a280000-0000-4000-8000-000000000002'))) r),
  'a receipt printing an order number did not link to that order');

-- ===== 5. Nothing fired: advisory candidates, ordered by date, never a match =====
--
-- A document with no order is legitimate. What the review screen needs is the open orders in a
-- helpful order, marked as suggestions -- proximity ORDERS the list, it does not decide.

select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'false' and r ->> 'order_id' is null
          and r ->> 'matched_by' is null and r ->> 'reason' = 'no_evidence'
          and jsonb_array_length(r -> 'candidates') = 3
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000001', null, date '2026-03-12') r),
  'the supplier''s three open orders were not offered when no tier fired');

select pg_temp.p28_assert(
  (select bool_and((c ->> 'authoritative')::boolean = false and c ->> 'matched_by' = 'open_order')
   from pg_temp.p28_resolve(
          'invoice', '4a280000-0000-4000-8000-000000000001', null, date '2026-03-12') r,
        jsonb_array_elements(r -> 'candidates') c),
  'an advisory candidate was marked authoritative. A caller that trusts only authoritative '
  'candidates would then treat a suggestion as a decided link');

select pg_temp.p28_assert(
  (select array_agg(c ->> 'order_id' order by ord)
   from pg_temp.p28_resolve(
          'invoice', '4a280000-0000-4000-8000-000000000001', null, date '2026-03-12') r,
        jsonb_array_elements(r -> 'candidates') with ordinality as t(c, ord))
  = array['5a280000-0000-4000-8000-000000000003',
          '5a280000-0000-4000-8000-000000000002',
          '5a280000-0000-4000-8000-000000000007'],
  'the advisory candidates are not ordered by how close the document date is to the expected '
  'delivery date, with unknown dates last. That ordering is the entire useful residue of the date '
  'idea; as a matching TIER it would have needed a day-window threshold nobody has calibrated');

-- The same ordering when the date comes off the page instead of from the caller.
select pg_temp.p28_assert(
  (select array_agg(c ->> 'order_id' order by ord)
   from pg_temp.p28_resolve(
          'invoice', '4a280000-0000-4000-8000-000000000001',
          pg_temp.p28_payload(null, '2026-03-12')) r,
        jsonb_array_elements(r -> 'candidates') with ordinality as t(c, ord))
  = array['5a280000-0000-4000-8000-000000000003',
          '5a280000-0000-4000-8000-000000000002',
          '5a280000-0000-4000-8000-000000000007'],
  'the document date printed on the page was ignored, so only a caller who already knew the date '
  'got a helpfully ordered list');

select pg_temp.p28_assert(
  (select bool_and((c ->> 'order_id')::uuid <> '5a280000-0000-4000-8000-000000000004')
   from pg_temp.p28_resolve('invoice', '4a280000-0000-4000-8000-000000000001') r,
        jsonb_array_elements(r -> 'candidates') c),
  'a cancelled order was offered as a candidate to choose from');

select pg_temp.p28_assert(
  (select r ->> 'reason' = 'missing_identifiers' and jsonb_array_length(r -> 'candidates') = 0
   from private.resolve_document_order(
     '1a280000-0000-4000-8000-000000000001', null, 'invoice', pg_temp.p28_payload()) r),
  'a null supplier produced an answer instead of missing_identifiers. The supplier ladder (0106) '
  'has to succeed before this question is askable at all');

select pg_temp.p28_assert(
  (select r ->> 'reason' = 'missing_identifiers'
   from private.resolve_document_order(
     null, '4a280000-0000-4000-8000-000000000001', 'invoice', pg_temp.p28_payload()) r),
  'a null org_id produced an answer instead of missing_identifiers');

-- ===== 6. Tenancy: the org_id argument is the boundary, on every tier =====

select pg_temp.p28_assert(
  (select r ->> 'reason' = 'no_evidence' and jsonb_array_length(r -> 'candidates') = 0
   from pg_temp.p28_resolve(
     'delivery_note', '4a280000-0000-4000-8000-000000000003', null, null, null,
     '1a280000-0000-4000-8000-000000000001') r),
  'another tenant''s supplier, read with OUR org id, produced candidates');

-- THE DIRECTION OF THIS CLAIM CHANGED WITH `0294`, and the old one had quietly stopped meaning
-- anything. Until per-tenant numbering, a number was unique across the whole database, so asking
-- for the other tenant's order number while reading as ours was a clean cross-tenant probe. Now
-- every tenant counts from 1: their ONLY order is number 1, and so is ours. Asking for it here
-- would prove nothing -- the resolver would find OUR number 1 and be right to.
--
-- So the probe runs the other way. Ours has eight orders and theirs has one, so any of our
-- numbers above 1 is a number that tenant demonstrably does not have. O2 is number 2.
select pg_temp.p28_assert(
  (select r ->> 'reason' = 'no_evidence'
   from pg_temp.p28_resolve(
     'invoice', '4a280000-0000-4000-8000-000000000003',
     pg_temp.p28_payload(pg_temp.p28_num('5a280000-0000-4000-8000-000000000002')),
     null, null, '1a280000-0000-4000-8000-000000000002') r),
  'a number belonging to another tenant''s order was matched');

select pg_temp.p28_assert(
  (select r ->> 'resolved' = 'true' and r ->> 'order_id' = '5a280000-0000-4000-8000-000000000006'
   from pg_temp.p28_resolve(
     'delivery_note', '4a280000-0000-4000-8000-000000000003', null, null, null,
     '1a280000-0000-4000-8000-000000000002') r),
  'read as the other tenant, that tenant''s own order was not returned -- which would mean the '
  'org_id argument is not what the resolver actually filters on');

-- ===== 7. Resolving is a read =====

create temp table p28_before as
  select id, status, supplier_id, expected_date from public.purchase_orders;

select pg_temp.p28_resolve('delivery_note', '4a280000-0000-4000-8000-000000000002');
select pg_temp.p28_resolve(
  'invoice', '4a280000-0000-4000-8000-000000000001',
  pg_temp.p28_payload(pg_temp.p28_num('5a280000-0000-4000-8000-000000000001')));

select pg_temp.p28_assert(
  not exists (
    select 1 from p28_before b join public.purchase_orders o on o.id = b.id
    where o.status is distinct from b.status
       or o.supplier_id is distinct from b.supplier_id
       or o.expected_date is distinct from b.expected_date)
  and (select count(*) from public.purchase_orders) = (select count(*) from p28_before),
  'resolving an order changed an order. Linking a document to an order is an approved action, not '
  'a side effect of reading');

-- ===== 8. The browser cannot reach any of it =====

select pg_temp.p28_assert(
  not has_schema_privilege('authenticated', 'private', 'usage')
  and not has_schema_privilege('anon', 'private', 'usage')
  and not has_function_privilege(
        'authenticated',
        'private.resolve_document_order(uuid, uuid, text, jsonb, date, uuid[])', 'execute'),
  'a client role can reach resolve_document_order, which takes org_id as an argument and would '
  'trust whatever a browser passed');

rollback;
