-- 0108 -- Four sources, compared without merging what they mean.
--
-- What was ORDERED, what physically ARRIVED, what the DOCUMENT says, and what we CONTRACTED to
-- pay. Today the product compares at most three of them, and only after an invoice row exists.
--
-- WHY THIS IS NOT A WRAPPER AROUND get_invoice_three_way_match, though the campaign asked for one.
-- Measured, not assumed: `private.invoice_three_way_raw` (0099:1187) reads `public.invoices`,
-- `public.invoice_lines` and `public.invoice_line_evidence_batches`. All three rows come into
-- existence when an invoice is created -- which in the reviewed-document flow happens AFTER a
-- person approves. There is no invoice to assess at the moment this assessment has to be shown, so
-- there is nothing to wrap. The campaign's own risk note reached the same place from the other
-- side: `invoice_three_way_approval_guard` (0099:2051-2093) recomputes the raw assessment itself
-- and compares it against its own `assessment_hash`, so a wrapper's findings are invisible to the
-- guard, to the override and to the approval snapshot. A wrapper returning its own hash is
-- REJECTED as `invoice_three_way_assessment_stale`; one returning the original hash displays
-- findings the owner never actually overrode. Either way it is theatre.
--
-- So the division is by TIME, not by duplication:
--   * BEFORE approval -- this function, over the document's own interpretation payload. It blocks
--     approval of the DOCUMENT, which is where blocking already is the rule.
--   * AFTER approval -- 0099, unchanged, over the invoice that approval created. Its hash, its
--     override and its snapshot contract are untouched by this migration.
--
-- WHAT IS SHARED RATHER THAN RE-TYPED, because this is where duplication costs money:
--   * unit canonicalisation, unit factors and comparison quantity/price -- `private.invoice_unit_*`
--     (0099:410-465). Not re-derived here; g<->kg and ml<->liter remain the only conversions, and
--     packaging is still never inferred from today's package_size.
--   * the tolerances -- ₪0.05 per line, ₪1 per document, 1% on price, 2% on weight/volume
--     quantities, and zero tolerance on VAT. Section 5 anchor (c) reads them back out of
--     `invoice_three_way_raw`'s own text, so a threshold changed there fails this migration
--     rather than quietly leaving two products with two answers.
--   * product identity -- `private.match_price_list_line` (0081). Product NAMES are never a key.
--   * the contractual baseline -- `private.supplier_price_effective_on` (0105), as of the
--     document's date, never today's price without saying so.
--   * numeric and date reading -- `private.interpretation_number` / `interpretation_date` (0077).
--     A fourth parser is exactly how two screens come to disagree about what a document said.
--
-- TWO CAVEATS THE CAMPAIGN REQUIRES THE SERVER TO ENFORCE, not the screen:
--   1. An ordered item that this document does not mention is NOT a claim that the item is
--      physically missing -- a supplier bills in instalments. Every such finding is severity
--      `info` and carries `is_physical_absence_claim: false`. Nothing that reads this output can
--      turn it into a shortage without saying so itself.
--   2. An unapproved machine inference NEVER has financial impact. This function is STABLE and
--      SECURITY INVOKER, pinned as both by anchor (d); it writes nothing, and `approval_blocked`
--      is an answer, not an action.
--
-- A DOCUMENT WITH NO ORDER IS STILL ASSESSABLE. Three of the four sources -- the document, the
-- baseline, and arithmetic -- need no order at all. `sources.ordered` and `sources.received` say
-- plainly what was and was not available, so a screen shows a dash rather than a fabricated zero.

-- ===== 1. The document's own lines, read once =====
-- A line is worth assessing only if a product can be named. `match_price_list_line` answers that
-- with the same three keys and the same refusal to answer on a shared code that 0090 relies on.
-- Quantity is read through `interpretation_number` -- the product's one numeric reader -- and then
-- required to be positive: a quantity that cannot be read is NOT a zero, because zero is a claim
-- that nothing arrived.
create or replace function private.document_assessment_lines(
  p_org_id uuid,
  p_supplier_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $fn$
declare
  v_line jsonb;
  v_index integer;
  v_values jsonb;
  v_sku text;
  v_barcode text;
  v_match jsonb;
  v_product_id uuid;
  v_product_source text;
  v_quantity numeric;
  v_out jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_payload -> 'line_items') <> 'array' then
    return v_out;
  end if;

  for v_line, v_index in
    select item.value, (item.ordinality - 1)::integer
    from jsonb_array_elements(p_payload -> 'line_items')
      with ordinality as item(value, ordinality)
  loop
    v_values := coalesce(v_line -> 'values', '{}'::jsonb);
    v_sku := nullif(btrim(v_values ->> 'sku'), '');
    v_barcode := nullif(btrim(v_values ->> 'barcode'), '');
    v_product_id := null;
    v_product_source := null;

    if p_supplier_id is not null and (v_sku is not null or v_barcode is not null) then
      v_match := private.match_price_list_line(p_org_id, p_supplier_id, v_sku, v_barcode);
      if v_match ->> 'status' = 'matched' then
        v_product_id := (v_match ->> 'product_id')::uuid;
        v_product_source := v_match ->> 'matched_by';
      else
        v_product_source := v_match ->> 'status';
      end if;
    end if;

    v_quantity := private.interpretation_number(v_values -> 'quantity');
    if v_quantity is not null and v_quantity <= 0 then
      v_quantity := null;
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'line_index', v_index,
      'description', nullif(btrim(v_values ->> 'description'), ''),
      'sku', v_sku,
      'barcode', v_barcode,
      'product_id', v_product_id,
      'product_source', v_product_source,
      'quantity', v_quantity,
      'unit', nullif(btrim(v_values ->> 'unit'), ''),
      'unit_price', private.interpretation_number(v_values -> 'unit_price'),
      'discount_amount', coalesce(private.interpretation_number(v_values -> 'discount_amount'), 0),
      'vat_rate', private.interpretation_number(v_values -> 'vat_rate'),
      'line_total', private.interpretation_number(v_values -> 'line_total'),
      'package_size', private.interpretation_number(v_values -> 'package_size')
    ));
  end loop;

  return v_out;
end
$fn$;

revoke all on function private.document_assessment_lines(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

comment on function private.document_assessment_lines(uuid, uuid, jsonb) is
  'The document''s line items, with a product named where the printed codes name exactly one '
  '(0108). Reuses private.match_price_list_line (0081) so product identity has one implementation, '
  'and private.interpretation_number (0077) so numbers have one reader. A quantity that cannot be '
  'read stays null rather than becoming zero, because zero is a claim that nothing arrived.';

-- ===== 2. The assessment =====
-- SECURITY INVOKER, for the reason 0106 and 0107 record: it needs no privilege of its own, every
-- read is filtered on the org_id passed in, and `public.purchase_orders`, `goods_receipts` and
-- `documents` are scope-enforced -- a SECURITY DEFINER caller owns that narrowing, as 0090's
-- resolver owns it today through a scope_definer_exemptions row.
create or replace function private.document_reconciliation_assessment(
  p_org_id uuid,
  p_document_type text,
  p_supplier_id uuid,
  p_order_id uuid,
  p_payload jsonb,
  p_document_date date default null
) returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $fn$
declare
  v_date date;
  v_number text;
  v_number_key text;
  v_currency text;
  v_header_net numeric;
  v_header_vat numeric;
  v_header_total numeric;
  v_org_vat_rate numeric;
  v_order record;
  v_lines jsonb;
  v_line jsonb;
  v_line_findings jsonb;
  v_line_rows jsonb := '[]'::jsonb;
  v_order_rows jsonb := '[]'::jsonb;
  v_findings jsonb := '[]'::jsonb;
  v_index integer;
  v_product_id uuid;
  v_quantity numeric;
  v_unit text;
  v_unit_price numeric;
  v_line_total numeric;
  v_expected_total numeric;
  v_factor numeric;
  v_normalized_quantity numeric;
  v_normalized_unit_price numeric;
  v_baseline jsonb;
  v_baseline_price numeric;
  v_overcharge numeric;
  v_overcharge_total numeric := 0;
  v_item record;
  v_quantity_tolerance numeric;
  v_received_tolerance numeric;
  v_lines_net numeric := 0;
  v_seen_products uuid[] := array[]::uuid[];
  v_documented_items uuid[] := array[]::uuid[];
  v_blocked boolean := false;
  v_warning boolean := false;
  v_critical boolean := false;
  v_has_order boolean := false;
  v_has_receipt boolean := false;
  v_has_baseline boolean := false;
begin
  if p_org_id is null then
    raise exception 'document_assessment_requires_org' using errcode = '22023';
  end if;

  -- ---- Header facts, read with the same key lists 0077 applies with (0077:940-954).
  v_date := coalesce(p_document_date, private.interpretation_date(
    private.interpretation_field(p_payload, array[
      'invoice_date', 'document_date', 'date', 'תאריך חשבונית', 'תאריך המסמך', 'תאריך'])));
  v_number := private.document_text_sanitize(
    private.interpretation_field(p_payload, array[
      'invoice_number', 'document_number', 'מספר חשבונית', 'מספר מסמך']) #>> '{}');
  v_number_key := private.document_text_key(v_number);
  v_header_total := private.interpretation_number(
    private.interpretation_field(p_payload, array[
      'total', 'total_amount', 'grand_total', 'amount_due', 'סכום כולל', 'סה"כ לתשלום']));
  v_header_net := private.interpretation_number(
    private.interpretation_field(p_payload, array[
      'subtotal', 'amount_before_vat', 'net_amount', 'סכום לפני מעמ', 'סה"כ לפני מע"מ']));
  v_header_vat := private.interpretation_number(
    private.interpretation_field(p_payload, array[
      'vat_amount', 'vat', 'tax_amount', 'מעמ', 'מע"מ']));
  v_currency := upper(nullif(btrim(
    private.interpretation_field(p_payload, array['currency', 'מטבע']) #>> '{}'), ''));

  select organization.vat_rate into v_org_vat_rate
  from public.organizations organization where organization.id = p_org_id;

  -- 0001 fixes this product to shekels and there is no currency column anywhere. A document
  -- printing another currency must reach a person, because recording its numbers as shekels is
  -- silent and expensive.
  if v_currency is not null and v_currency not in ('ILS', 'NIS', '₪', 'ש"ח', 'שח') then
    v_blocked := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'currency_not_ils', 'severity', 'error', 'printed_currency', v_currency,
      'message', 'המסמך מודפס במטבע שאינו שקל — המערכת רושמת שקלים בלבד'));
  end if;

  -- ---- Duplicate: the same supplier's same document number already recorded.
  --
  -- NOT for a tax_receipt, and the exclusion is the whole semantics of the subtype rather than a
  -- convenience. A receipt PRINTS the number of the invoice it acknowledges; finding that invoice
  -- is the successful outcome, and calling it a duplicate would block every receipt that does its
  -- job while passing the ones that reference nothing (OPEN-DECISIONS #141: evidence, never a
  -- payable). A duplicate matters for a document that would CREATE a debt.
  if p_supplier_id is not null and v_number_key is not null
     and lower(btrim(coalesce(p_document_type, ''))) <> 'tax_receipt'
     and exists (
       select 1 from public.invoices existing
       where existing.org_id = p_org_id
         and existing.supplier_id = p_supplier_id
         and existing.deleted_at is null
         and private.document_text_key(existing.invoice_number) = v_number_key
     ) then
    v_critical := true;
    v_blocked := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'duplicate_document', 'severity', 'critical', 'document_number', v_number,
      'message', 'מסמך במספר הזה כבר קיים אצל ספק זה'));
  end if;

  -- ---- The order, if one was resolved (0107).
  if p_order_id is not null then
    select po.id, po.supplier_id, po.status, po.number
      into v_order
    from public.purchase_orders po
    where po.org_id = p_org_id and po.id = p_order_id;
    if found then
      v_has_order := true;
      if p_supplier_id is not null and v_order.supplier_id <> p_supplier_id then
        -- The document was attached to an order belonging to a different supplier. Every
        -- quantity and price comparison below would be against the wrong contract.
        v_blocked := true;
        v_has_order := false;
        v_findings := v_findings || jsonb_build_array(jsonb_build_object(
          'code', 'supplier_mismatch', 'severity', 'error',
          'order_supplier_id', v_order.supplier_id, 'document_supplier_id', p_supplier_id,
          'message', 'ההזמנה שייכת לספק אחר מזה שעל המסמך'));
      end if;
    end if;
  end if;

  v_has_receipt := v_has_order and exists (
    select 1 from public.goods_receipts receipt
    where receipt.org_id = p_org_id and receipt.order_id = p_order_id
      and receipt.status = 'completed');

  v_lines := private.document_assessment_lines(p_org_id, p_supplier_id, p_payload);

  -- ---- Line by line.
  for v_line, v_index in
    select item.value, (item.ordinality - 1)::integer
    from jsonb_array_elements(v_lines) with ordinality as item(value, ordinality)
  loop
    v_line_findings := '[]'::jsonb;
    v_product_id := nullif(v_line ->> 'product_id', '')::uuid;
    v_quantity := (v_line ->> 'quantity')::numeric;
    v_unit := v_line ->> 'unit';
    v_unit_price := (v_line ->> 'unit_price')::numeric;
    v_line_total := (v_line ->> 'line_total')::numeric;
    v_factor := null;
    v_normalized_quantity := null;
    v_normalized_unit_price := null;
    v_baseline := null;
    v_baseline_price := null;
    v_overcharge := null;

    -- Arithmetic on the page, before any comparison to our records. ₪0.05 is 0099's line
    -- tolerance, and anchor (c) keeps it that way.
    if v_quantity is not null and v_unit_price is not null and v_line_total is not null then
      v_expected_total := round(
        (v_quantity * v_unit_price) - coalesce((v_line ->> 'discount_amount')::numeric, 0), 2);
      if abs(v_line_total - v_expected_total) > 0.05 then
        v_blocked := true;
        v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
          'code', 'line_arithmetic_discrepancy', 'severity', 'error',
          'expected', v_expected_total, 'actual', v_line_total, 'tolerance', 0.05,
          'message', 'סכום השורה אינו שווה לכמות × מחיר פחות ההנחה'));
      end if;
      v_lines_net := v_lines_net + v_line_total;
    end if;

    if (v_line ->> 'vat_rate') is not null and v_org_vat_rate is not null
       and (v_line ->> 'vat_rate')::numeric <> v_org_vat_rate then
      -- 0099 gives VAT zero tolerance. A rate that differs is a different tax treatment, not a
      -- rounding difference.
      v_blocked := true;
      v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
        'code', 'vat_rate_mismatch', 'severity', 'error',
        'expected_vat_rate', v_org_vat_rate, 'actual_vat_rate', (v_line ->> 'vat_rate')::numeric,
        'tolerance', 0, 'message', 'שיעור המע"מ בשורה שונה מהשיעור של הארגון'));
    end if;

    if v_product_id is null then
      -- Unidentified is not "absent": the line is real, we simply cannot say what it is. A person
      -- maps it; nothing downstream may guess from the description, because "עגבניות שרי" and
      -- "עגבניות שרי 500 גרם" are one product to a person and two strings to Postgres.
      v_blocked := true;
      v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
        'code', 'product_unidentified', 'severity', 'error',
        'reason', v_line ->> 'product_source',
        'message', 'לא ניתן לזהות איזה מוצר זה — דורש מיפוי ידני'));
    elsif v_product_id = any(v_seen_products) then
      -- The same product on two lines has to be added up, and a misread unit on either line makes
      -- the sum wrong without either line looking wrong.
      v_warning := true;
      v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
        'code', 'product_repeated_on_document', 'severity', 'warning',
        'message', 'אותו מוצר מופיע ביותר משורה אחת — יש לוודא שהכמויות נספרות פעם אחת'));
    else
      v_seen_products := v_seen_products || v_product_id;
    end if;

    if v_quantity is null then
      v_blocked := true;
      v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
        'code', 'quantity_unreadable', 'severity', 'error',
        'message', 'לא ניתן לקרוא את הכמות — כמות שלא נקראה אינה אפס'));
    end if;

    -- ---- Against what was ordered, and what already arrived.
    if v_has_order and v_product_id is not null then
      select item.id, item.qty, item.unit_price, item.unit_snapshot,
             coalesce(sum(receipt_item.qty_received) filter (
               where receipt.status = 'completed'), 0) as received_quantity,
             coalesce(array_agg(distinct receipt_item.status::text) filter (
               where receipt.status = 'completed' and receipt_item.status <> 'full'),
               array[]::text[]) as exception_statuses
        into v_item
      from public.purchase_order_items item
      left join public.goods_receipt_items receipt_item
        on receipt_item.org_id = item.org_id and receipt_item.order_item_id = item.id
      left join public.goods_receipts receipt
        on receipt.org_id = receipt_item.org_id and receipt.id = receipt_item.receipt_id
      where item.org_id = p_org_id and item.order_id = p_order_id
        and item.product_id = v_product_id
      group by item.id, item.qty, item.unit_price, item.unit_snapshot;

      if not found then
        -- Charged, but never ordered. This may be a legitimate direct purchase; it may be a line
        -- that belongs on someone else's document. Either way a person decides, and F2 may not
        -- propose a credit until they have.
        v_blocked := true;
        v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
          'code', 'product_charged_not_ordered', 'severity', 'error',
          'message', 'המוצר מחויב במסמך אך אינו מופיע בהזמנה'));
      else
        v_documented_items := v_documented_items || v_item.id;
        v_factor := private.invoice_unit_factor(v_unit, v_item.unit_snapshot);
        if v_item.unit_snapshot is null then
          v_blocked := true;
          v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
            'code', 'legacy_order_unit_snapshot_missing', 'severity', 'error',
            'purchase_order_item_id', v_item.id,
            'message', 'לשורת ההזמנה ההיסטורית אין יחידת מידה שמורה — לא ניתן להשוות'));
        elsif v_factor is null then
          -- g<->kg and ml<->liter are the only conversions 0099 permits, and packaging is never
          -- inferred from today's package_size. Anything else is a person's call.
          v_blocked := true;
          v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
            'code', 'unit_or_packaging_mismatch', 'severity', 'error',
            'document_unit', v_unit, 'order_unit', v_item.unit_snapshot,
            'message', 'יחידת המידה במסמך אינה ניתנת להמרה ליחידה שבהזמנה'));
        elsif v_quantity is not null then
          v_normalized_quantity := v_quantity * v_factor;
          v_normalized_unit_price := v_unit_price / v_factor;
          v_quantity_tolerance := case
            when private.invoice_unit_canonical(v_item.unit_snapshot)
                 in ('g', 'kg', 'ml', 'liter') then v_item.qty * 0.02
            else 0
          end;

          if v_normalized_quantity > v_item.qty + v_quantity_tolerance then
            v_blocked := true;
            v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
              'code', 'quantity_above_ordered', 'severity', 'error',
              'ordered_quantity', v_item.qty,
              'document_quantity_normalized', round(v_normalized_quantity, 6),
              'tolerance', round(v_quantity_tolerance, 6),
              'message', 'הכמות במסמך גדולה מהכמות שהוזמנה'));
          elsif abs(v_normalized_quantity - v_item.qty) > v_quantity_tolerance then
            v_warning := true;
            v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
              'code', 'quantity_differs_from_ordered', 'severity', 'warning',
              'ordered_quantity', v_item.qty,
              'document_quantity_normalized', round(v_normalized_quantity, 6),
              'tolerance', round(v_quantity_tolerance, 6),
              'message', 'הכמות במסמך שונה מהכמות שהוזמנה'));
          end if;

          v_received_tolerance := case
            when private.invoice_unit_canonical(v_item.unit_snapshot)
                 in ('g', 'kg', 'ml', 'liter') then v_item.received_quantity * 0.02
            else 0
          end;
          if v_has_receipt
             and v_normalized_quantity > v_item.received_quantity + v_received_tolerance then
            v_blocked := true;
            v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
              'code', 'quantity_above_received', 'severity', 'error',
              'received_quantity', v_item.received_quantity,
              'document_quantity_normalized', round(v_normalized_quantity, 6),
              'message', 'הכמות במסמך גדולה מהכמות שהתקבלה בפועל'));
          end if;
        end if;

        if cardinality(v_item.exception_statuses) > 0 then
          -- Someone standing at the delivery recorded this as short, damaged or returned. That is
          -- a fact about the goods, and it is the strongest input the credit path has.
          v_warning := true;
          v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
            'code', 'receipt_recorded_exception', 'severity', 'warning',
            'receipt_statuses', to_jsonb(v_item.exception_statuses),
            'message', 'בקבלה נרשמו פריטים חסרים, פגומים או שהוחזרו'));
        end if;
      end if;
    end if;

    -- ---- Against the contractual baseline, as of the document's date (0105).
    if v_product_id is not null and p_supplier_id is not null then
      v_baseline := private.supplier_price_effective_on(
        p_org_id, p_supplier_id, v_product_id, v_date);
      if v_baseline ->> 'status' = 'resolved' then
        v_has_baseline := true;
        v_baseline_price := (v_baseline ->> 'baseline_price')::numeric;
      else
        v_warning := true;
        v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
          'code', 'price_baseline_unknown', 'severity', 'warning',
          'reason', v_baseline ->> 'reason',
          'message', 'אין מחיר מוסכם להשוואה עבור המוצר הזה'));
      end if;
    end if;

    if v_baseline_price is not null and v_unit_price is not null then
      -- Compared in the price list's own unit terms when the order gave us a factor, and in the
      -- document's terms otherwise. 1% is 0099's price tolerance, unchanged.
      v_normalized_unit_price := coalesce(v_normalized_unit_price, v_unit_price);
      if v_normalized_unit_price > v_baseline_price * 1.01 then
        v_blocked := true;
        v_overcharge := round(
          coalesce(v_normalized_quantity, v_quantity, 0)
            * (v_normalized_unit_price - v_baseline_price), 2);
        v_overcharge_total := v_overcharge_total + greatest(v_overcharge, 0);
        v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
          'code', 'price_above_baseline', 'severity', 'error',
          'baseline_price', v_baseline_price,
          'baseline_source', v_baseline ->> 'baseline_source',
          'baseline_effective_date', v_baseline ->> 'baseline_effective_date',
          'document_unit_price_normalized', round(v_normalized_unit_price, 6),
          'difference_amount', round(v_normalized_unit_price - v_baseline_price, 6),
          'overcharge_amount', v_overcharge, 'tolerance_percent', 1,
          'message', 'המחיר במסמך גבוה מהמחיר המוסכם שהיה בתוקף בתאריך המסמך'));
      elsif v_normalized_unit_price < v_baseline_price then
        -- A favourable deviation. Worth saying, worth zero credit: a negative credit request is
        -- an invoice to our own supplier.
        v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
          'code', 'price_below_baseline', 'severity', 'info',
          'baseline_price', v_baseline_price,
          'baseline_source', v_baseline ->> 'baseline_source',
          'document_unit_price_normalized', round(v_normalized_unit_price, 6),
          'difference_amount', round(v_normalized_unit_price - v_baseline_price, 6),
          'message', 'המחיר במסמך נמוך מהמחיר המוסכם — סטייה לטובה'));
      end if;
    end if;

    v_line_rows := v_line_rows || jsonb_build_array(
      v_line || jsonb_build_object(
        'normalized_quantity', round(v_normalized_quantity, 6),
        'normalized_unit_price', round(v_normalized_unit_price, 6),
        'baseline_price', v_baseline_price,
        'baseline_source', v_baseline ->> 'baseline_source',
        'baseline_effective_date', v_baseline ->> 'baseline_effective_date',
        'overcharge_amount', v_overcharge,
        'findings', v_line_findings));
    if jsonb_array_length(v_line_findings) > 0 then
      v_findings := v_findings || (
        select coalesce(jsonb_agg(finding || jsonb_build_object('line_index', v_index)
          order by ordinal), '[]'::jsonb)
        from jsonb_array_elements(v_line_findings) with ordinality as expanded(finding, ordinal));
    end if;
  end loop;

  -- ---- Ordered, and not on this document. INFO, and explicitly not a shortage claim: a supplier
  -- bills in instalments, and a partial document says nothing about what is still coming.
  if v_has_order then
    for v_item in
      -- `received_quantity` here is the SAME completed-receipt sum the lines above compare
      -- against, deliberately not `purchase_order_items.received_qty`. Two numbers under one word
      -- on one screen is how a reviewer comes to trust the wrong one; `recorded_received_qty`
      -- carries the running column beside it so a divergence between them is visible rather than
      -- hidden behind a shared label.
      select item.id, item.product_id, item.qty, item.received_qty, item.unit_snapshot,
             product.name as product_name,
             coalesce(sum(receipt_item.qty_received) filter (
               where receipt.status = 'completed'), 0) as received_quantity
      from public.purchase_order_items item
      join public.products product
        on product.org_id = item.org_id and product.id = item.product_id
      left join public.goods_receipt_items receipt_item
        on receipt_item.org_id = item.org_id and receipt_item.order_item_id = item.id
      left join public.goods_receipts receipt
        on receipt.org_id = receipt_item.org_id and receipt.id = receipt_item.receipt_id
      where item.org_id = p_org_id and item.order_id = p_order_id
      group by item.id, item.product_id, item.qty, item.received_qty, item.unit_snapshot,
        product.name
      order by product.name, item.id
    loop
      if not (v_item.id = any(v_documented_items)) then
        v_findings := v_findings || jsonb_build_array(jsonb_build_object(
          'code', 'ordered_not_on_document', 'severity', 'info',
          'purchase_order_item_id', v_item.id, 'product_id', v_item.product_id,
          'product_name', v_item.product_name, 'ordered_quantity', v_item.qty,
          'received_quantity', v_item.received_quantity,
          'is_physical_absence_claim', false,
          'message', 'המוצר הוזמן ואינו מופיע במסמך הזה — אין בכך טענה שהוא חסר פיזית'));
      end if;
      v_order_rows := v_order_rows || jsonb_build_array(jsonb_build_object(
        'purchase_order_item_id', v_item.id,
        'product_id', v_item.product_id,
        'product_name', v_item.product_name,
        'ordered_quantity', v_item.qty,
        'received_quantity', v_item.received_quantity,
        'recorded_received_qty', v_item.received_qty,
        'unit', v_item.unit_snapshot,
        'on_this_document', v_item.id = any(v_documented_items)));
    end loop;
  end if;

  -- ---- Header against the lines. ₪1 is 0099's document tolerance.
  if v_header_net is not null and jsonb_array_length(v_line_rows) > 0
     and abs(v_lines_net - v_header_net) > 1 then
    v_blocked := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'header_total_differs_from_lines', 'severity', 'error',
      'lines_total', round(v_lines_net, 2), 'header_total', v_header_net, 'tolerance', 1,
      'message', 'סה"כ שבכותרת אינו שווה לסכום השורות'));
  end if;
  if v_header_net is not null and v_header_vat is not null and v_header_total is not null
     and abs((v_header_net + v_header_vat) - v_header_total) > 1 then
    v_blocked := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'header_arithmetic_discrepancy', 'severity', 'error',
      'header_net', v_header_net, 'header_vat', v_header_vat, 'header_total', v_header_total,
      'tolerance', 1, 'message', 'סה"כ לפני מע"מ ועוד מע"מ אינם שווים לסה"כ לתשלום'));
  end if;

  -- ---- One credit statement for the whole document, from the positive overcharge only.
  if v_overcharge_total > 0 then
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'credit_required', 'severity', 'error',
      'overcharge_amount', round(v_overcharge_total, 2),
      'message', 'נדרש זיכוי על חיוב היתר שנמצא במסמך'));
  end if;

  return jsonb_build_object(
    'document_type', p_document_type,
    'document_number', v_number,
    'document_date', v_date,
    'supplier_id', p_supplier_id,
    'order_id', case when v_has_order then p_order_id else null end,
    'sources', jsonb_build_object(
      'document', jsonb_array_length(v_line_rows) > 0,
      'ordered', v_has_order,
      'received', v_has_receipt,
      'baseline', v_has_baseline),
    'totals', jsonb_build_object(
      'lines_net', case when jsonb_array_length(v_line_rows) > 0
                        then round(v_lines_net, 2) else null end,
      'header_net', v_header_net,
      'header_vat', v_header_vat,
      'header_total', v_header_total,
      'overcharge_total', round(v_overcharge_total, 2),
      'line_tolerance', 0.05,
      'document_tolerance', 1),
    'severity', case when v_critical then 'critical' when v_blocked then 'error'
                     when v_warning then 'warning' else 'info' end,
    'approval_blocked', v_blocked,
    'lines', v_line_rows,
    'order_items', v_order_rows,
    'findings', v_findings);
end
$fn$;

revoke all on function private.document_reconciliation_assessment(
  uuid, text, uuid, uuid, jsonb, date)
  from public, anon, authenticated, service_role;

comment on function private.document_reconciliation_assessment(
  uuid, text, uuid, uuid, jsonb, date) is
  'Four sources compared without merging their meanings (0108): what was ordered, what physically '
  'arrived on a COMPLETED receipt, what the document says, and what the price list said on the '
  'document''s date. Returns findings with severity, a Hebrew explanation and a line link, plus '
  'approval_blocked. It is not a wrapper around get_invoice_three_way_match: that function reads '
  'invoice rows which do not exist before approval, and 0099''s approval guard recomputes its own '
  'assessment anyway, so a wrapper would be advisory by construction. Unit arithmetic, tolerances, '
  'product identity, the price baseline and number parsing are all reused from their existing '
  'single implementations. An ordered item absent from the document is INFO and carries '
  'is_physical_absence_claim=false: a supplier bills in instalments. STABLE and SECURITY INVOKER '
  '-- an unapproved machine inference never has financial impact.';

-- ===== 3. A1/A3/A5 re-assertion =====
--
-- Required of every migration after 0057. This one adds no SECURITY DEFINER code -- both new
-- functions are invokers, pinned by anchor (d) -- so it adds no exemption row and the p9 pin does
-- not move.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0108 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 4. Anchors this assessment silently depends on =====
do $$
declare
  v_tolerance text;
  v_def text;
  v_name text;
  v_secdef boolean;
  v_volatile "char";
begin
  -- (a) Every column the four sources are read from, by name and type. A rename here would not
  -- fail the function -- plpgsql resolves at run time -- it would fail the first document.
  if (select count(*) from information_schema.columns
      where table_schema = 'public'
        and (table_name, column_name, data_type) in (
          ('purchase_order_items', 'qty', 'numeric'),
          ('purchase_order_items', 'unit_price', 'numeric'),
          ('purchase_order_items', 'unit_snapshot', 'text'),
          ('purchase_order_items', 'received_qty', 'numeric'),
          ('goods_receipt_items', 'order_item_id', 'uuid'),
          ('goods_receipt_items', 'qty_received', 'numeric'),
          ('goods_receipts', 'order_id', 'uuid'),
          ('supplier_products', 'package_size', 'numeric'),
          ('organizations', 'vat_rate', 'numeric'))) <> 9 then
    raise exception '0108: a column one of the four sources is read from has been renamed.';
  end if;

  -- (b) The receipt vocabulary. `completed` is what makes a receipt a fact rather than a
  -- proposal, and the three exception statuses are what a person standing at the delivery
  -- recorded. A renamed label would silently empty both filters.
  if (select count(*) from unnest(enum_range(null::receipt_status)) e(v)
      where e.v::text = 'completed') <> 1
     or (select count(*) from unnest(enum_range(null::receipt_line_status)) e(v)
         where e.v::text in ('full', 'missing', 'damaged', 'returned')) <> 4 then
    raise exception '0108: the receipt status vocabulary changed; a filter here now matches nothing.';
  end if;

  -- (c) THE TOLERANCES ARE 0099'S, still. This is the anchor that keeps one product from having
  -- two answers: each literal below is read back out of invoice_three_way_raw's own text, so a
  -- threshold changed there fails this migration instead of quietly diverging from it.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'invoice_three_way_raw';
  if v_def is null then
    raise exception '0108: private.invoice_three_way_raw is gone; the tolerance anchor cannot run.';
  end if;
  foreach v_tolerance in array array['0.05', '1.01', '0.02']
  loop
    if position(v_tolerance in v_def) = 0 then
      raise exception
        '0108: invoice_three_way_raw no longer contains the tolerance %; the pre-approval and '
        'post-approval assessments have drifted apart.', v_tolerance;
    end if;
  end loop;

  -- (d) The security and purity properties the comments claim. Pinned, not merely observed: a
  -- later promotion to SECURITY DEFINER fails here and has to go add the A5 exemption row and
  -- bump the p9 pin deliberately. VOLATILE would mean this could write, which is the one thing an
  -- unapproved inference must never do.
  for v_name in
    select unnest(array['document_assessment_lines', 'document_reconciliation_assessment'])
  loop
    select p.prosecdef, p.provolatile into v_secdef, v_volatile
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = v_name;
    if v_secdef then
      raise exception '0108: private.% became SECURITY DEFINER; it needs an A5 exemption row.',
        v_name;
    end if;
    if v_volatile <> 's' and v_volatile <> 'i' then
      raise exception
        '0108: private.% is VOLATILE -- an unapproved assessment could write.', v_name;
    end if;
  end loop;

  -- (e) The helpers this reuses instead of re-implementing. If any is dropped, the honest failure
  -- is here and now, not a second implementation appearing quietly in a later migration.
  foreach v_tolerance in array array[
    'private.invoice_unit_factor(text,text)',
    'private.invoice_unit_canonical(text)',
    'private.match_price_list_line(uuid,uuid,text,text)',
    'private.supplier_price_effective_on(uuid,uuid,uuid,date)',
    'private.interpretation_number(jsonb)',
    'private.interpretation_date(jsonb)',
    'private.document_text_key(text)']
  loop
    if to_regprocedure(v_tolerance) is null then
      raise exception '0108: % is gone; this assessment reuses it rather than re-implementing it.',
        v_tolerance;
    end if;
  end loop;

  -- (f) get_invoice_three_way_match is untouched and still the post-approval authority. This
  -- migration deliberately does not enter its hash/override/snapshot contract.
  if to_regprocedure('public.get_invoice_three_way_match(uuid)') is null
     or to_regprocedure('private.invoice_three_way_assessment_hash(jsonb)') is null then
    raise exception '0108: the post-approval three-way path is missing; 0108 assumes it survives.';
  end if;
end
$$;
