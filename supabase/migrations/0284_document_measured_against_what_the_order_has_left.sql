-- 0284 -- A document is measured against what the order has LEFT, not against what it once held.
--
-- DEBT §35. `private.document_reconciliation_assessment` compares every documented line against
-- `purchase_order_items.qty` -- the quantity ORDERED -- and against the completed-receipt sum. It
-- never asks how much of that same order item earlier, already-approved invoices consumed. Order
-- 100 units, approve an invoice for 100, and a second document for another 100 passes the document
-- gate untouched: 100 is not above 100. The overrun is caught later, at `record_invoice_line_evidence`
-- (0099), which refuses the approval with `invoiced_quantity_above_ordered`.
--
-- SO THE MONEY IS NEVER WRONG -- BUT THE PERSON IS TOLD TOO LATE. The document gate is where a
-- human reviews the paper, names the exception and decides. Letting a document through that gate
-- clean, and refusing it three screens later at final approval, teaches the reviewer that the
-- assessment does not mean what it says. §12: the screen exists so a manager can decide in
-- seconds, and a gate that stays silent about a known overrun is not deciding anything.
--
-- NO SECOND ACCUMULATOR, WHICH IS WHAT §35 ACTUALLY FORBIDS. There is exactly one definition of
-- "consumed": the immutable approval snapshots of 0099, latest revision per invoice, gated on
-- `reversed_at is null` since 0174 (§29). This migration does not add a running total to any
-- table, does not cache a remainder, and does not recompute consumption from live invoice lines --
-- all three would be a second accumulator that could disagree with the first. It extracts the
-- SAME snapshot read into `private.order_item_prior_invoiced` and calls it. `p29` asserts that the
-- document gate and `private.invoice_three_way_raw` report the same number for the same order
-- item, so the two readers cannot drift in silence.
--
-- WHY THE THREE-WAY BODY IS NOT REWRITTEN HERE. `private.invoice_three_way_raw` and
-- `private.invoice_line_candidates` carry that read inline, in two deliberately different shapes
-- (0174 explains why: one selects candidates for ALL items, one assesses ONE). Folding them into
-- this function would rewrite the hottest money path for tidiness, and the bulk reader would turn
-- one pass into a call per item while §86 is open on exactly that class of cost. The suite
-- assertion is the guard instead of the rewrite.
--
-- AN UNRESOLVED PRIOR UNIT IS NOT A ZERO. If an earlier approval could not resolve its unit, its
-- quantity is not comparable to this document's, and the remainder is unknown. The constitution is
-- explicit that a metric without data shows `—` and never `0`: this refuses by name rather than
-- subtracting a number it cannot stand behind.
--
-- The patched body is SECURITY INVOKER and gains no exemption; the definer caller
-- (`public.get_document_review_assessment`) is untouched, so its pinned hash does not move. Bodies
-- are read with carriage returns stripped (`check:anchored-replacements`).

-- ===== 1. The one reader of prior-approval consumption for a single order item =====
create function private.order_item_prior_invoiced(
  p_org_id uuid,
  p_supplier_id uuid,
  p_order_item_id uuid,
  p_exclude_invoice_id uuid default null
) returns table (prior_invoiced_quantity numeric, has_unresolved_unit boolean)
language sql
stable
security invoker
set search_path = public, private, pg_temp
as $fn$
  -- Only immutable approval snapshots consume prior PO/receipt quantity, and only the latest
  -- revision of each. Reading live invoice lines instead would let a draft, or a later catalog
  -- edit, rewrite what a prior approval claimed. `reversed_at is null` is 0174's release (§29):
  -- an owner-reversed approval stops consuming, which is the whole point of the reversal.
  with latest_approval as (
    select distinct on (snapshot.invoice_id)
      snapshot.invoice_id, snapshot.assessment, snapshot.reversed_at
    from public.invoice_three_way_approval_snapshots snapshot
    join public.invoices prior_invoice
      on prior_invoice.org_id = snapshot.org_id
     and prior_invoice.id = snapshot.invoice_id
     and prior_invoice.deleted_at is null
    where snapshot.org_id = p_org_id
      and (p_exclude_invoice_id is null or snapshot.invoice_id <> p_exclude_invoice_id)
      and prior_invoice.supplier_id = p_supplier_id
    order by snapshot.invoice_id, snapshot.revision desc
  )
  select
    coalesce(sum((approved_item ->> 'current_invoice_quantity')::numeric), 0)
      as prior_invoiced_quantity,
    coalesce(bool_or(not coalesce(
      (approved_item ->> 'unit_resolved')::boolean, false)), false)
      as has_unresolved_unit
  from latest_approval approval
  cross join lateral jsonb_array_elements(
    coalesce(approval.assessment -> 'order_items', '[]'::jsonb)) approved_item
  where approval.reversed_at is null
    and approved_item ->> 'purchase_order_item_id' = p_order_item_id::text;
$fn$;

revoke all on function private.order_item_prior_invoiced(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function private.order_item_prior_invoiced(uuid, uuid, uuid, uuid) is
  'The one reader of how much of a purchase-order item earlier approvals already consumed (0284, '
  'DEBT §35). Reads the immutable three-way approval snapshots of 0099 -- latest revision per '
  'invoice, same supplier, non-deleted invoice, and never a snapshot an owner reversed under 0174. '
  'Writes nothing and stores nothing: there is no second accumulator. `has_unresolved_unit` says '
  'the prior quantity is not comparable, so a caller refuses by name instead of subtracting.';

-- ===== 2. The document gate subtracts what earlier approvals already took =====
do $patch_assessment_0284$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
begin
  if to_regprocedure(
       'private.document_reconciliation_assessment(uuid, text, uuid, uuid, jsonb, date)') is null then
    raise exception '0284: private.document_reconciliation_assessment is absent';
  end if;

  select replace(pg_get_functiondef(
      'private.document_reconciliation_assessment(uuid,text,uuid,uuid,jsonb,date)'::regprocedure),
      e'\r', '')
    into v_definition;

  -- --- (a) the two locals, declared beside the tolerance they are weighed against ---
  v_anchor := '  v_received_tolerance numeric;';
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0284: the assessment declare anchor moved';
  end if;
  v_replacement := v_anchor || e'\n'
    || '  v_prior_invoiced numeric;' || e'\n'
    || '  v_prior_unit_unresolved boolean;';
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- --- (b) read consumption once, immediately before the quantity ladder ---
  v_anchor := '          if v_normalized_quantity > v_item.qty + v_quantity_tolerance then';
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0284: the ordered-quantity comparison anchor moved';
  end if;
  v_replacement :=
       '          select prior.prior_invoiced_quantity, prior.has_unresolved_unit' || e'\n'
    || '            into v_prior_invoiced, v_prior_unit_unresolved' || e'\n'
    || '          from private.order_item_prior_invoiced(' || e'\n'
    || '            p_org_id, v_order.supplier_id, v_item.id, null) prior;' || e'\n'
    || '          v_prior_invoiced := coalesce(v_prior_invoiced, 0);' || e'\n'
    || '          v_prior_unit_unresolved := coalesce(v_prior_unit_unresolved, false);' || e'\n'
    || e'\n'
    || v_anchor;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- --- (c) the remainder rungs, ABOVE the "differs from ordered" warning ---
  -- Order is the decision. Being above the whole order stays the first and strongest claim; an
  -- unknown remainder refuses next; only then does exceeding the remainder speak. All three are
  -- errors, and they rank ahead of the warning so a document that overruns the remainder is never
  -- reported as merely "different from what was ordered".
  v_anchor := '          elsif abs(v_normalized_quantity - v_item.qty) > v_quantity_tolerance then';
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0284: the quantity-differs anchor moved';
  end if;
  v_replacement :=
       '          elsif v_prior_unit_unresolved then' || e'\n'
    || '            v_blocked := true;' || e'\n'
    || '            v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(' || e'\n'
    || '              ''code'', ''prior_invoiced_unit_unresolved'', ''severity'', ''error'',' || e'\n'
    || '              ''purchase_order_item_id'', v_item.id,' || e'\n'
    || '              ''ordered_quantity'', v_item.qty,' || e'\n'
    || '              ''message'', ''חשבונית קודמת שאושרה על הפריט נותרה בלי יחידת מידה — לא ניתן לחשב את יתרת ההזמנה''));' || e'\n'
    || '          elsif v_prior_invoiced > 0' || e'\n'
    || '            and v_normalized_quantity' || e'\n'
    || '                > (v_item.qty - v_prior_invoiced) + v_quantity_tolerance then' || e'\n'
    || '            v_blocked := true;' || e'\n'
    || '            v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(' || e'\n'
    || '              ''code'', ''quantity_above_remaining_ordered'', ''severity'', ''error'',' || e'\n'
    || '              ''ordered_quantity'', v_item.qty,' || e'\n'
    || '              ''prior_approved_invoiced_quantity'', round(v_prior_invoiced, 6),' || e'\n'
    || '              ''remaining_ordered_quantity'', round(v_item.qty - v_prior_invoiced, 6),' || e'\n'
    || '              ''document_quantity_normalized'', round(v_normalized_quantity, 6),' || e'\n'
    || '              ''tolerance'', round(v_quantity_tolerance, 6),' || e'\n'
    || '              ''message'', ''הכמות במסמך גדולה מיתרת ההזמנה — חשבוניות שכבר אושרו צרכו חלק מהפריט''));' || e'\n'
    || v_anchor;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end
$patch_assessment_0284$;

-- ===== 3. The contract landed, and nothing else moved =====
do $assert_0284$
declare
  v_body text;
  v_violations text;
begin
  if to_regprocedure('private.order_item_prior_invoiced(uuid, uuid, uuid, uuid)') is null then
    raise exception '0284: the consumption reader is absent';
  end if;

  -- The reader must never become a definer: it reads snapshots across every invoice of one
  -- supplier, and only the caller's own context may decide whether that is allowed.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'order_item_prior_invoiced' and p.prosecdef) then
    raise exception '0284: the consumption reader must stay SECURITY INVOKER';
  end if;
  if has_function_privilege('authenticated',
       'private.order_item_prior_invoiced(uuid, uuid, uuid, uuid)', 'EXECUTE')
     or has_function_privilege('anon',
       'private.order_item_prior_invoiced(uuid, uuid, uuid, uuid)', 'EXECUTE') then
    raise exception '0284: the consumption reader is reachable from the browser';
  end if;

  -- 0174 released consumption on reversal. A reader that ignored the column would resurrect it.
  if position('approval.reversed_at is null' in replace(pg_get_functiondef(
       'private.order_item_prior_invoiced(uuid,uuid,uuid,uuid)'::regprocedure), e'\r', '')) = 0 then
    raise exception '0284: the consumption reader ignores an owner reversal';
  end if;

  select replace(pg_get_functiondef(
      'private.document_reconciliation_assessment(uuid,text,uuid,uuid,jsonb,date)'::regprocedure),
      e'\r', '')
    into v_body;
  if position('private.order_item_prior_invoiced(' in v_body) = 0
     or position('quantity_above_remaining_ordered' in v_body) = 0
     or position('prior_invoiced_unit_unresolved' in v_body) = 0 then
    raise exception '0284: the document gate still ignores prior consumption';
  end if;
  -- The two comparisons that existed before must still exist: this migration adds a rung to the
  -- ladder, it does not replace one.
  if position('quantity_above_ordered' in v_body) = 0
     or position('quantity_above_received' in v_body) = 0
     or position('quantity_differs_from_ordered' in v_body) = 0 then
    raise exception '0284: an existing quantity comparison was lost';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'document_reconciliation_assessment'
      and p.prosecdef) then
    raise exception '0284: the document assessment changed security posture';
  end if;

  -- 0058:207-218: a migration that touches a definer's callee proves the scope contract here
  -- rather than three hours later in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0284 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0284$;
