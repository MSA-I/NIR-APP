-- 0120 -- The date tier 0107 deliberately did not build, now that the owner has given the number it
-- was missing.
--
-- 0107's header says why there was no date tier: it can only fire after the number tier and the item
-- tier have both stayed silent, it earns its keep exactly when several orders are open -- the case
-- where choosing is forbidden -- and it needs a day threshold nobody had calibrated. Two of those
-- three objections were about the SHAPE of the tier, and one was about a missing number. The owner
-- supplied the number on 11.08.2026: five days. This migration answers the other two by construction
-- rather than by assurance.
--
--   * It CANNOT choose among candidates. Like `single_open_order`, it fires on exactly one qualifying
--     order or not at all. Two orders inside the window is silence, and both of them travel to the
--     screen as advisory candidates for a person to pick between.
--   * It is not the weakest tier by accident. `single_open_order` reasons from the ABSENCE of
--     alternatives -- "there is nothing else it could be" -- while this one reasons from evidence the
--     document itself carries: the date printed on the page, against the delivery the order was
--     expecting. So it sits ABOVE single_open_order in the ladder, and a delivery note whose single
--     open order also falls inside the window is reported with the stronger reason.
--
-- WHY AN INVOICE GETS THIS TIER THOUGH IT IS REFUSED single_open_order. 0077:1134-1141 refuses that
-- heuristic for invoices because it "would attach an invoice to the wrong order whenever a supplier
-- has one open order and the document belongs to another". That failure needs no coincidence at all
-- -- it happens by default, every time. Date proximity requires the document's own date to fall
-- within five days of that order's expected delivery, which is a fact about the document rather than
-- about the poverty of the alternatives. And the whole reason `resolve_document_order` may hold
-- tiers 0077 may not is recorded in 0107's header: this resolver writes nothing and feeds a screen
-- where a person confirms, while 0077's path writes without a human.
--
-- WHAT DOES NOT CHANGE. `resolve_delivery_note_order` (0090) and the inline search in
-- `apply_document_interpretation` (0077) are untouched, for the three reasons 0107 lists. Neither
-- gains a date tier, so the two automatic paths keep exactly the calibration debt they had
-- (DEBT §16, §24, §27) and no more.
--
-- The advisory ordering 0107 built stays exactly as it was. Proximity now BOTH orders the fallback
-- list and, when it is decisive and unambiguous, names a match -- and the anchors below pin the
-- boundary between those two jobs.
--
-- OPEN-DECISIONS #148 records the five days as an owner decision with a date, so that the next reader
-- finds a decision rather than a magic number.

-- ===== 1. The window, in one place =====
-- A function rather than a literal in three query bodies, so that the number the owner gave has a
-- single home, a comment naming who decided it, and an anchor that can read it back.
create or replace function private.document_order_date_window()
returns integer
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select 5
$fn$;

revoke all on function private.document_order_date_window()
  from public, anon, authenticated, service_role;

comment on function private.document_order_date_window() is
  'How many days on either side of a purchase order''s expected delivery still count as "the same '
  'delivery" for the by_date_proximity tier (0120). Five, decided by the owner on 11.08.2026 and '
  'recorded as OPEN-DECISIONS #148. It lives in a function because 0107 refused to build the tier '
  'at all while the threshold was an invented business answer, and a number with one home and one '
  'comment is the difference between a decision and a magic constant.';

-- ===== 2. The tier policy gains a rung =====
-- Only the two subtypes that describe goods moving. A receipt prints amounts and a payment date; its
-- date says nothing about when a delivery was expected, so proximity would be reading a coincidence.
-- tax_receipt therefore keeps by_number alone, as OPEN-DECISIONS #141 requires.
create or replace function private.document_order_tiers(p_document_type text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select case lower(btrim(coalesce(p_document_type, '')))
    -- An invoice is a debt. 0077's refusal of single_open_order, kept verbatim in effect -- and see
    -- this migration's header for why date proximity is not the same heuristic wearing a hat.
    when 'invoice' then array['by_number', 'by_items', 'by_date_proximity']
    -- The owner's 09.08.2026 exception, and the only subtype that carries single_open_order.
    when 'delivery_note'
      then array['by_number', 'by_items', 'by_date_proximity', 'single_open_order']
    -- A receipt prints amounts, not goods, so item coverage has nothing to read and its date is a
    -- payment date rather than a delivery date; and it creates no payable at all
    -- (OPEN-DECISIONS #141), so an order link on it is context, never a commitment.
    when 'tax_receipt' then array['by_number']
    else array[]::text[]
  end
$fn$;

comment on function private.document_order_tiers(text) is
  'Which order-matching tiers a document of this subtype may be resolved by (0107, extended by '
  '0120). invoice gets by_number, by_items and by_date_proximity but never single_open_order, which '
  '0077:1134-1141 refuses by name for invoices; delivery_note additionally gets single_open_order, '
  'the owner exception of 09.08.2026 that 0090:257-262 records and that is safe only because its '
  'product is a draft a person confirms; tax_receipt gets by_number alone, because a receipt prints '
  'amounts rather than goods and its date is a payment date, and it never creates a payable. An '
  'unknown subtype gets no tiers, so it resolves nothing rather than resolving by the most '
  'permissive rule available.';

-- ===== 3. The resolver, with the new rung between the items and the last resort =====
-- Everything outside the new block is 0107 unchanged, deliberately re-stated in full rather than
-- patched: this is a `create or replace` of a function no other migration injects into, so the whole
-- body is the honest diff. (The anchored-replacement pattern of 0061 exists for bodies that ARE
-- injected into; applying it here would obscure a change rather than protect one.)
create or replace function private.resolve_document_order(
  p_org_id uuid,
  p_supplier_id uuid,
  p_document_type text,
  p_payload jsonb,
  p_document_date date default null,
  p_product_ids uuid[] default null
) returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $fn$
declare
  v_tiers text[];
  v_tier text;
  v_number integer;
  v_date date;
  v_window integer;
  v_candidates jsonb := '[]'::jsonb;
  v_count integer;
  v_order_id uuid;
begin
  v_tiers := private.document_order_tiers(p_document_type);

  if p_org_id is null or p_supplier_id is null or cardinality(v_tiers) = 0 then
    -- No tenant, no supplier, or a subtype with no tiers. Not an error and not an answer: the
    -- supplier ladder (0106) has to succeed before this question is even askable.
    return jsonb_build_object(
      'resolved', false, 'order_id', null, 'matched_by', null,
      'reason', case when cardinality(v_tiers) = 0 then 'subtype_has_no_tiers'
                     else 'missing_identifiers' end,
      'candidates', '[]'::jsonb);
  end if;

  v_date := coalesce(p_document_date, private.interpretation_date(
    private.interpretation_field(p_payload, array[
      'invoice_date', 'document_date', 'date', 'תאריך חשבונית', 'תאריך המסמך', 'תאריך'])));

  -- ----- tier 1: the number printed on the page -----
  -- Any status but cancelled. See 0107's header: the invoice for a received order is the common
  -- case, not the edge one.
  if 'by_number' = any (v_tiers) then
    v_number := private.document_order_number(p_payload);
    if v_number is not null then
      select coalesce(jsonb_agg(c order by c ->> 'order_id'), '[]'::jsonb) into v_candidates
      from (
        select jsonb_build_object(
          'order_id', po.id, 'number', po.number, 'status', po.status,
          'expected_date', po.expected_date, 'unit_id', po.unit_id,
          'matched_by', 'by_number', 'authoritative', true,
          'evidence', 'מספר ההזמנה מודפס על המסמך'
        ) as c
        from public.purchase_orders po
        where po.org_id = p_org_id
          and po.supplier_id = p_supplier_id
          and po.number = v_number
          and po.status <> 'cancelled'
      ) t;
      if jsonb_array_length(v_candidates) > 0 then
        v_tier := 'by_number';
      end if;
    end if;
  end if;

  -- ----- tier 2: the goods themselves -----
  -- FULL coverage only, as 0090:305-310 argues: an order containing every product this document
  -- lists is evidence off the page, while an order containing only some of them is what two
  -- concurrent orders to one supplier look like.
  if v_tier is null and 'by_items' = any (v_tiers)
     and p_product_ids is not null and cardinality(p_product_ids) > 0 then
    select coalesce(jsonb_agg(c order by c ->> 'order_id'), '[]'::jsonb) into v_candidates
    from (
      select jsonb_build_object(
        'order_id', po.id, 'number', po.number, 'status', po.status,
        'expected_date', po.expected_date, 'unit_id', po.unit_id,
        'matched_by', 'by_items', 'authoritative', true,
        'evidence', 'ההזמנה מכילה כל אחד מהמוצרים שבמסמך'
      ) as c
      from public.purchase_orders po
      where po.org_id = p_org_id
        and po.supplier_id = p_supplier_id
        and po.status in ('sent', 'confirmed', 'partial')
        and not exists (
          select 1 from unnest(p_product_ids) as wanted(product_id)
          where not exists (
            select 1 from public.purchase_order_items poi
            where poi.order_id = po.id and poi.product_id = wanted.product_id
          )
        )
    ) t;
    if jsonb_array_length(v_candidates) > 0 then
      v_tier := 'by_items';
    end if;
  end if;

  -- ----- tier 3: the date on the page against the delivery that was expected -----
  -- The owner's five days (0120, OPEN-DECISIONS #148). Three conditions, and the third is the one
  -- that makes the tier safe: an order with no expected date cannot participate at all, a document
  -- with no date cannot ask the question, and TWO qualifying orders is silence rather than a coin
  -- toss. When it stays silent the candidates are cleared, so the fall-through below offers the
  -- supplier's whole open list rather than a pre-narrowed one -- a person choosing needs to see the
  -- order just outside the window too.
  if v_tier is null and 'by_date_proximity' = any (v_tiers) and v_date is not null then
    v_window := private.document_order_date_window();
    select coalesce(jsonb_agg(c), '[]'::jsonb) into v_candidates
    from (
      select jsonb_build_object(
        'order_id', po.id, 'number', po.number, 'status', po.status,
        'expected_date', po.expected_date, 'unit_id', po.unit_id,
        'matched_by', 'by_date_proximity', 'authoritative', true,
        'evidence', 'תאריך המסמך בתוך ' || v_window
                    || ' ימים מהאספקה הצפויה, וזו ההזמנה היחידה בטווח — כדאי לוודא'
      ) as c
      from public.purchase_orders po
      where po.org_id = p_org_id
        and po.supplier_id = p_supplier_id
        and po.status in ('sent', 'confirmed', 'partial')
        and po.expected_date is not null
        and abs(po.expected_date - v_date) <= v_window
    ) t;
    if jsonb_array_length(v_candidates) = 1 then
      v_tier := 'by_date_proximity';
    else
      v_candidates := '[]'::jsonb;
    end if;
  end if;

  -- ----- tier 4: one open order and nothing else it could be -----
  -- Only for the subtypes document_order_tiers admits, and it is a tier that CANNOT be ambiguous by
  -- construction: it fires on exactly one open order or not at all. It sits below the date tier
  -- because it reasons from the absence of alternatives rather than from anything the document says.
  if v_tier is null and 'single_open_order' = any (v_tiers) then
    select coalesce(jsonb_agg(c), '[]'::jsonb) into v_candidates
    from (
      select jsonb_build_object(
        'order_id', po.id, 'number', po.number, 'status', po.status,
        'expected_date', po.expected_date, 'unit_id', po.unit_id,
        'matched_by', 'single_open_order', 'authoritative', true,
        'evidence', 'ההזמנה הפתוחה היחידה של ספק זה — כדאי לוודא'
      ) as c
      from public.purchase_orders po
      where po.org_id = p_org_id
        and po.supplier_id = p_supplier_id
        and po.status in ('sent', 'confirmed', 'partial')
    ) t;
    if jsonb_array_length(v_candidates) = 1 then
      v_tier := 'single_open_order';
    else
      v_candidates := '[]'::jsonb;
    end if;
  end if;

  -- ----- nothing fired: offer the open orders, ordered by date proximity -----
  -- Not a match and never presented as one: every candidate here carries authoritative=false, so a
  -- caller that only trusts authoritative candidates sees an empty answer, and the review screen
  -- still has something for a person to choose from. Proximity to the document date orders the
  -- list; it does not shorten it and it does not decide.
  if v_tier is null then
    select coalesce(jsonb_agg(c order by proximity nulls last, number desc), '[]'::jsonb)
      into v_candidates
    from (
      select jsonb_build_object(
               'order_id', po.id, 'number', po.number, 'status', po.status,
               'expected_date', po.expected_date, 'unit_id', po.unit_id,
               'matched_by', 'open_order', 'authoritative', false,
               'evidence', 'הזמנה פתוחה של ספק זה — לבחירת אדם'
             ) as c,
             case when v_date is null or po.expected_date is null then null
                  else abs(po.expected_date - v_date) end as proximity,
             po.number as number
      from public.purchase_orders po
      where po.org_id = p_org_id
        and po.supplier_id = p_supplier_id
        and po.status in ('sent', 'confirmed', 'partial')
    ) t;
    return jsonb_build_object(
      'resolved', false, 'order_id', null, 'matched_by', null,
      'reason', 'no_evidence', 'candidates', v_candidates);
  end if;

  v_count := jsonb_array_length(v_candidates);
  if v_count = 1 then
    v_order_id := (v_candidates -> 0 ->> 'order_id')::uuid;
  end if;

  return jsonb_build_object(
    'resolved', v_count = 1,
    'order_id', v_order_id,
    'matched_by', case when v_count = 1 then v_tier else null end,
    'reason', case when v_count = 1 then null else 'ambiguous' end,
    'candidates', v_candidates);
end
$fn$;

comment on function private.resolve_document_order(uuid, uuid, text, jsonb, date, uuid[]) is
  'Which purchase order this document is about, from deterministic evidence and only through the '
  'tiers its subtype is allowed (0107, extended by 0120): the printed order number, then full '
  'product coverage, then the single order whose expected delivery falls within the owner''s '
  'five-day window of the document date, then -- for delivery notes alone -- the single open order. '
  'Returns resolved=false with reason=ambiguous and every candidate when a tier names more than one, '
  'and reason=no_evidence with the supplier''s open orders as advisory candidates when no tier '
  'fires, so a person can choose. It never chooses among candidates and a document with no order is '
  'a legitimate outcome. SECURITY INVOKER for the reason resolve_document_supplier records in 0106. '
  'public.purchase_orders is scope-enforced and this function does not re-implement that policy: a '
  'SECURITY DEFINER caller owns it, exactly as 0090''s resolver owns it through a '
  'scope_definer_exemptions row.';

-- ===== 4. A1/A3/A5 re-assertion =====
-- Required of every migration after 0057. This one adds no SECURITY DEFINER code -- the new window
-- function is an IMMUTABLE invoker like the two it joins -- so it adds no exemption row and the p9
-- pin does not move. Anchor (c) below is what proves that, rather than a sentence claiming it.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0120 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 5. Anchors =====
do $$
declare
  v_name text;
  v_tier text;
  v_def text;
  v_secdef boolean;
  v_volatile "char";
  v_tiers text[];
  v_all_tiers text[];
  v_window integer;
begin
  -- (a) The number the owner gave, read back. A hand that "tunes" it to thirty days to make more
  -- documents match has changed a business rule, and this is where that shows up as a failure
  -- rather than as a quietly higher match rate.
  v_window := private.document_order_date_window();
  if v_window is distinct from 5 then
    raise exception
      '0120: the date-proximity window is % days, not the five the owner decided on 11.08.2026 '
      '(OPEN-DECISIONS #148).', v_window;
  end if;

  -- (b) The policy itself, asserted rather than described.
  v_tiers := private.document_order_tiers('invoice');
  if not ('by_date_proximity' = any (v_tiers)) then
    raise exception '0120: an invoice did not gain the date tier this migration exists to add.';
  end if;
  if 'single_open_order' = any (v_tiers) then
    raise exception
      '0120: an invoice may be matched by single_open_order, which 0077:1134-1141 refuses by name. '
      'The date tier is not a licence to reopen that.';
  end if;
  if not ('by_number' = any (v_tiers) and 'by_items' = any (v_tiers)) then
    raise exception '0120: an invoice lost a tier it already had.';
  end if;
  v_tiers := private.document_order_tiers('delivery_note');
  if not ('by_date_proximity' = any (v_tiers) and 'single_open_order' = any (v_tiers)) then
    raise exception '0120: a delivery note lost the date tier or the owner exception of 09.08.2026.';
  end if;
  if private.document_order_tiers('tax_receipt') <> array['by_number'] then
    raise exception
      '0120: tax_receipt no longer resolves by the printed number alone. Its date is a payment '
      'date, not a delivery date (OPEN-DECISIONS #141).';
  end if;
  if cardinality(private.document_order_tiers('price_list')) <> 0
     or cardinality(private.document_order_tiers(null)) <> 0 then
    raise exception '0120: an unknown subtype was given tiers; it must resolve nothing instead.';
  end if;

  -- (c) The security and purity properties. Pinned as INVOKER, not merely observed to be: a later
  -- hand promoting any of them to SECURITY DEFINER fails here and has to go add the
  -- scope_definer_exemptions row and bump the p9 pin deliberately.
  for v_name in
    select unnest(array['document_order_tiers', 'document_order_number',
                        'document_order_date_window', 'resolve_document_order'])
  loop
    select p.prosecdef, p.provolatile into v_secdef, v_volatile
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = v_name;
    if v_secdef is null then
      raise exception '0120: private.% is missing.', v_name;
    end if;
    if v_secdef then
      raise exception '0120: private.% became SECURITY DEFINER; it needs an A5 exemption row.',
        v_name;
    end if;
    if v_volatile <> 'i' and v_volatile <> 's' then
      raise exception '0120: private.% is neither IMMUTABLE nor STABLE; it may write.', v_name;
    end if;
  end loop;

  -- (d) Every tier the POLICY can emit is a tier the RESOLVER implements. This is the anchor the
  -- previous three do not cover: a rung added to document_order_tiers and forgotten in
  -- resolve_document_order does not raise, does not warn, and does not match -- it just quietly
  -- never fires, and the subtype looks like it has an ability it does not have.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'resolve_document_order'
  limit 1;
  select array_agg(distinct t) into v_all_tiers
  from unnest(private.document_order_tiers('invoice')
              || private.document_order_tiers('delivery_note')
              || private.document_order_tiers('tax_receipt')) as u(t);
  foreach v_tier in array v_all_tiers
  loop
    if position('''' || v_tier || '''' in v_def) = 0 then
      raise exception
        '0120: the policy grants the tier %, which resolve_document_order never reads. A tier that '
        'is granted and not implemented silently never fires.', v_tier;
    end if;
  end loop;
end
$$;
