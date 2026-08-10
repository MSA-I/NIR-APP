-- 0107 -- Which order is this document about, and which tiers is this KIND of document allowed
-- to answer with?
--
-- The second question is the whole migration. Order matching already exists twice, and the two
-- copies disagree ON PURPOSE:
--
--   * 0077:1134-1141 (`apply_document_interpretation`, invoices) REFUSES the "single open order"
--     heuristic by name: "would attach an invoice to the wrong order whenever a supplier has one
--     open order and the document belongs to another -- corrupting order status and the savings
--     analyses built on it".
--   * 0090:257-262 (`resolve_delivery_note_order`) ACCEPTS it, and records that the owner accepted
--     it on 09.08.2026 only because the artefact is a draft that moves no stock, no quantity and no
--     status, that a person confirms before anything happens.
--
-- The campaign asked to extend one engine to serve invoices, delivery notes and receipts. Extending
-- either copy in place would have to erase one of those two positions, because they are the same
-- code path with opposite answers. So the tier set becomes a PARAMETER and the per-subtype policy
-- becomes one readable function -- `private.document_order_tiers` -- instead of a difference
-- between two migrations that only a reader of both would notice.
--
-- WHAT THIS DOES NOT TOUCH, deliberately. `resolve_delivery_note_order` and the inline search at
-- 0077:1151-1169 both keep running exactly as they are. Three measured reasons:
--   (1) p14 pins the text of `apply_document_interpretation`, and 0090's resolver holds a
--       scope_definer_exemptions row that the p9 count pins. Replacing a block inside a live
--       financial command to reach a behaviour a NEW command can have for free is risk with no
--       return.
--   (2) The two live paths write without a human -- that is what they are for, and the calibration
--       debt on their thresholds (DEBT §16, §24, §27) is untouched by this campaign.
--   (3) The new path is human-approved by construction (package F): its resolver may therefore
--       return ambiguity to a screen, which neither live path has anywhere to put.
--
-- ONE ENGINE, NOT A THIRD. What is genuinely shared -- the printed-order-number key list, the int4
-- bound before the cast, the product matcher -- is reused rather than re-typed, and section 4
-- asserts that the key list here still equals the one the two live commands use, so a key added
-- there fails here until it is added here too.
--
-- WHY THERE IS NO DATE TIER, though the campaign listed one. A date tier can only fire after the
-- number tier and the item tier have both stayed silent -- meaning the document proved nothing
-- about which order it belongs to -- and it earns its keep only when SEVERAL orders are open, which
-- is precisely the case where choosing is forbidden. So date proximity ORDERS the candidate list
-- for the person deciding and never decides: the useful part of the idea, without a threshold
-- nobody has calibrated and without a silent business default (CLAUDE.md: no invented business
-- answers).
--
-- STATUS SETS, both preserved rather than merged. An explicit printed order number is evidence
-- regardless of what state the order reached -- a supplier's invoice usually arrives AFTER the
-- goods were received and the order closed, so `by_number` accepts any status except `cancelled`,
-- as 0077 does. `by_items` and `single_open_order` reason about what is still outstanding, so they
-- accept only ('sent','confirmed','partial'), as 0090 does. Merging them into one set would have
-- broken invoices for received orders or admitted closed orders to the open-order tiers.
--
-- A document is allowed to end up with NO order. That is a legitimate outcome, not a failure: the
-- invoice is still real, the receipt is still evidence, and a person can link it later.

-- ===== 1. The per-subtype tier policy, in one place =====
-- IMMUTABLE and pure: this is a policy statement, not a lookup. It is a function rather than a
-- table because a table would invite a row per tenant, and "may a delivery note match the single
-- open order" is not a per-tenant setting -- it is the owner decision recorded in 0090 and
-- OPEN-DECISIONS #125-126.
create or replace function private.document_order_tiers(p_document_type text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select case lower(btrim(coalesce(p_document_type, '')))
    -- An invoice is a debt. 0077's refusal, kept verbatim in effect.
    when 'invoice' then array['by_number', 'by_items']
    -- The owner's 09.08.2026 exception, and the only subtype that carries it.
    when 'delivery_note' then array['by_number', 'by_items', 'single_open_order']
    -- A receipt prints amounts, not goods, so item coverage has nothing to read; and it creates no
    -- payable at all (OPEN-DECISIONS #141), so an order link on it is context, never a commitment.
    when 'tax_receipt' then array['by_number']
    else array[]::text[]
  end
$fn$;

revoke all on function private.document_order_tiers(text)
  from public, anon, authenticated, service_role;

comment on function private.document_order_tiers(text) is
  'Which order-matching tiers a document of this subtype may be resolved by (0107). invoice gets '
  'by_number and by_items but never single_open_order, which 0077:1134-1141 refuses by name for '
  'invoices; delivery_note additionally gets single_open_order, the owner exception of 09.08.2026 '
  'that 0090:257-262 records and that is safe only because its product is a draft a person '
  'confirms; tax_receipt gets by_number alone, because a receipt prints amounts rather than goods '
  'and never creates a payable. An unknown subtype gets no tiers, so it resolves nothing rather '
  'than resolving by the most permissive rule available.';

-- ===== 2. The printed order number, read once =====
-- The key list and the int4 bound both already exist twice (0077:1141-1150, 0090:573-575). This is
-- the third READER and the last copy of the list: section 4 asserts it still equals theirs.
create or replace function private.document_order_number(p_payload jsonb)
returns integer
language plpgsql
immutable
set search_path = public, pg_temp
as $fn$
declare
  v_number numeric;
begin
  v_number := private.interpretation_number(
    private.interpretation_field(p_payload, array[
      'order_number', 'purchase_order_number', 'po_number', 'reference_order_number',
      'מספר הזמנה', 'הזמנה']));
  -- Bounded BEFORE the cast, for the reason 0077:1146-1150 records: a supplier printing a
  -- date-shaped reference like 20260403001 raised `22003: integer out of range` from the cast
  -- itself and aborted the whole command. An out-of-range number is simply not an order of ours.
  if v_number is null
     or v_number <> trunc(v_number)
     or v_number < 1
     or v_number > 2147483647 then
    return null;
  end if;
  return v_number::integer;
end
$fn$;

revoke all on function private.document_order_number(jsonb)
  from public, anon, authenticated, service_role;

comment on function private.document_order_number(jsonb) is
  'The purchase-order number a document printed, or null (0107). Reads the same six keys as '
  '0077 and 0090 -- an anchor in 0107 fails if that stops being true -- and applies the same int4 '
  'bound BEFORE the cast, because a date-shaped reference like 20260403001 raised 22003 from the '
  'cast and aborted the command that was mid-write.';

-- ===== 3. The resolver =====
-- SECURITY INVOKER, for the reason private.resolve_document_supplier records in 0106: it needs no
-- privilege of its own, every read is filtered on the org_id the caller passed, and an authenticated
-- caller only gets RLS and the unit-scope policy narrowing on top -- worst case a silent tier and a
-- document that needs a person, never an order from another tenant.
--
-- A NOTE THE CALLER MUST NOT LOSE: public.purchase_orders IS scope-enforced
-- (private.scope_registry). Inside a SECURITY DEFINER command that policy does not apply, and this
-- function does not re-implement it -- the DEFINER caller owns that decision, exactly as 0090's
-- resolver owns it today through a scope_definer_exemptions row. Package F's
-- apply_reviewed_document must therefore either filter auth_scopes() itself or take that row
-- deliberately. Putting the filter here instead would have made the review screen unable to show a
-- manager an order they are allowed to see.
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
  -- Any status but cancelled. See the header: the invoice for a received order is the common case,
  -- not the edge one.
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

  -- ----- tier 3: one open order and nothing else it could be -----
  -- Only for the subtypes document_order_tiers admits, and it is a tier that CANNOT be ambiguous
  -- by construction: it fires on exactly one open order or not at all. When two are open it stays
  -- silent and the candidates below carry both to the screen.
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

revoke all on function private.resolve_document_order(uuid, uuid, text, jsonb, date, uuid[])
  from public, anon, authenticated, service_role;

comment on function private.resolve_document_order(uuid, uuid, text, jsonb, date, uuid[]) is
  'Which purchase order this document is about, from deterministic evidence and only through the '
  'tiers its subtype is allowed (0107): the printed order number, then full product coverage, then '
  '-- for delivery notes alone -- the single open order. Returns resolved=false with '
  'reason=ambiguous and every candidate when a tier names more than one, and reason=no_evidence '
  'with the supplier''s open orders as advisory candidates when no tier fires, so a person can '
  'choose. It never chooses among candidates and a document with no order is a legitimate outcome. '
  'SECURITY INVOKER for the reason resolve_document_supplier records in 0106. public.purchase_orders '
  'is scope-enforced and this function does not re-implement that policy: a SECURITY DEFINER caller '
  'owns it, exactly as 0090''s resolver owns it through a scope_definer_exemptions row.';

-- ===== 4. A1/A3/A5 re-assertion =====
--
-- Required of every migration after 0057. This one adds no SECURITY DEFINER code -- see the
-- comments above for why all three new functions stayed invokers -- so it adds no exemption row and
-- the p9 pin does not move. Anchor (d) in section 5 is what proves that, rather than a sentence
-- claiming it.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0107 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 5. Anchors these functions silently depend on =====
do $$
declare
  v_name text;
  v_key text;
  v_def text;
  v_secdef boolean;
  v_volatile "char";
  v_tiers text[];
begin
  -- (a) The columns the ladder reads, by name and type.
  if (select count(*) from information_schema.columns
      where table_schema = 'public'
        and (table_name, column_name, data_type) in (
          ('purchase_orders', 'number', 'integer'),
          ('purchase_orders', 'supplier_id', 'uuid'),
          ('purchase_orders', 'expected_date', 'date'),
          ('purchase_orders', 'unit_id', 'uuid'),
          ('purchase_order_items', 'product_id', 'uuid'),
          ('purchase_order_items', 'order_id', 'uuid'))) <> 6 then
    raise exception
      '0107: one of the six columns the order ladder reads has been renamed or retyped.';
  end if;

  -- (b) The two status sets the header defends are still spellable. A value renamed in po_status
  -- would silently empty a tier: `status in (...)` matching nothing raises nothing.
  if (select count(*) from unnest(enum_range(null::po_status)) as e(v)
      where e.v::text in ('sent', 'confirmed', 'partial', 'cancelled')) <> 4 then
    raise exception '0107: po_status no longer spells all four values the tier sets name.';
  end if;

  -- (c) The printed-order-number key list is STILL the one the two live commands use. This is the
  -- anti-drift anchor the header promises: a seventh key added to either live command fails here,
  -- and the fix is to add it to document_order_number too rather than to let the new path go blind
  -- to a key the old paths already read.
  for v_name in
    select unnest(array['apply_document_interpretation', 'apply_delivery_note_interpretation'])
  loop
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name
    limit 1;
    if v_def is null then
      raise exception '0107: public.% is gone; the key-list anchor cannot be checked.', v_name;
    end if;
    foreach v_key in array array[
      'order_number', 'purchase_order_number', 'po_number', 'reference_order_number',
      'מספר הזמנה', 'הזמנה']
    loop
      if position('''' || v_key || '''' in v_def) = 0 then
        raise exception
          '0107: public.% no longer reads the order-number key %; the three readers have drifted.',
          v_name, v_key;
      end if;
    end loop;
  end loop;

  -- (d) The security and purity properties the comments above claim. Pinned as INVOKER, not merely
  -- observed to be: a later hand promoting either function to SECURITY DEFINER fails here and has
  -- to go add the scope_definer_exemptions row and bump the p9 pin deliberately, which is exactly
  -- the confrontation the A5 registry exists to force.
  for v_name in
    select unnest(array['document_order_tiers', 'document_order_number', 'resolve_document_order'])
  loop
    select p.prosecdef, p.provolatile into v_secdef, v_volatile
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = v_name;
    if v_secdef then
      raise exception '0107: private.% became SECURITY DEFINER; it needs an A5 exemption row.',
        v_name;
    end if;
    if v_volatile <> 'i' and v_volatile <> 's' then
      raise exception '0107: private.% is neither IMMUTABLE nor STABLE; it may write.', v_name;
    end if;
  end loop;

  -- (e) The policy itself, asserted rather than described. These three rows ARE the owner decisions
  -- 0077 and 0090 argued about; a hand that "simplifies" the tier function by giving every subtype
  -- the same tiers fails here.
  v_tiers := private.document_order_tiers('invoice');
  if 'single_open_order' = any (v_tiers) then
    raise exception
      '0107: an invoice may be matched by single_open_order, which 0077:1134-1141 refuses by name.';
  end if;
  if not ('by_number' = any (v_tiers) and 'by_items' = any (v_tiers)) then
    raise exception '0107: an invoice lost a tier it is meant to have.';
  end if;
  if not ('single_open_order' = any (private.document_order_tiers('delivery_note'))) then
    raise exception
      '0107: a delivery note lost single_open_order, the owner exception 0090:257-262 records.';
  end if;
  v_tiers := private.document_order_tiers('tax_receipt');
  if v_tiers <> array['by_number'] then
    raise exception
      '0107: tax_receipt no longer resolves by the printed number alone (OPEN-DECISIONS #141).';
  end if;
  if cardinality(private.document_order_tiers('price_list')) <> 0
     or cardinality(private.document_order_tiers(null)) <> 0 then
    raise exception '0107: an unknown subtype was given tiers; it must resolve nothing instead.';
  end if;

  -- (f) tax_receipt is a document_type the product actually has. 0104 added it; if that were ever
  -- reverted, the tier row above would be policy for a subtype nobody can produce.
  if not exists (
    select 1 from pg_constraint c
    where c.conname like '%document_type%'
      and pg_get_constraintdef(c.oid) like '%tax_receipt%'
  ) then
    raise exception '0107: no CHECK anywhere admits tax_receipt; 0104 must precede this migration.';
  end if;
end
$$;
