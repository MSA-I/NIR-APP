-- 0261 — the invoice's three-way match publishes the same ladder the document's does.
--
-- WHY. `0260` gave the document review screen the whole ladder: discounts, the computed header,
-- the unexplained gap, and the names of the rungs nobody extracted. The invoice screen shows the
-- SAME arithmetic to the same person about the same money, and its read model stops at six
-- figures and two tolerances. Rendering the strip there today would mean adding
-- `invoice_net + invoice_vat` and subtracting in React — a second source of truth for money, and
-- one that rounds by React's rules rather than by the rules that decided whether to block.
--
-- AN INVOICE IS NOT A PHOTOGRAPH, AND THE LADDER SAYS SO. `invoices.amount_before_vat`,
-- `vat_amount` and `total_amount` are `NOT NULL` columns in our own database (measured, not
-- assumed). So on this side of the product the header rungs are never missing, the computed total
-- is always derivable, and `unexplained_gap` is always a number. The one rung that CAN be absent
-- is the lines: an invoice with no lines is a real state with a reason code of its own
-- (`invoice_lines_missing`), and `missing_rungs` names it so the strip prints "not extracted"
-- rather than a zero that would claim the lines were read and summed to nothing.
--
-- THIS ADDS KEYS AND DECIDES NOTHING. Not one comparison, not one reason, not one severity, and
-- not `approval_blocked`. Asserted below by counting the blocking paths and re-finding the three
-- money comparisons `0259` converted, rather than by claiming it.
--
-- THE SIGN IS THE DOCUMENT'S, AND IT IS THE OPPOSITE OF THE ONE BESIDE IT. `unexplained_gap` is
-- `total - (net + vat)` here, exactly as `0260` defines it for a document, because one component
-- draws both ladders and a strip whose gap flips sign depending on which screen it is on is worse
-- than no strip. The `invoice_header_arithmetic_discrepancy` reason has published the SAME
-- discrepancy as `difference_amount` since `0099`, in the other direction — `(net + vat) - total`.
-- That is left exactly as it is: two Edge tools and a reason renderer read it. The two numbers are
-- deliberately opposite, the suite asserts it, and anyone who "fixes" one of them will be told.
--
-- AND IT DOES NOT RE-ROUND WHAT IS ALREADY PUBLISHED. `line_net`, `line_vat` and `line_grand` are
-- rounded to two places by code older than the multi-currency campaign, which for a currency with
-- no minor units publishes `1234.00`. That is worth fixing and is NOT fixed here: two Edge
-- Function tools (`explainInvoiceBlock`, `compareOrderReceiptInvoice`) read those exact fields,
-- so changing their scale is a behavioural change to the assistant and belongs to a migration
-- that carries its own suite. The keys added here use the currency's own minor units, and the
-- rendered figure is identical either way because `fmtMoneyExact` scales by the currency.
--
-- The function is SECURITY INVOKER (measured: `prosecdef = false`) and holds no scope exemption.
-- The body is read with carriage returns stripped (`check:anchored-replacements`).

do $patch_three_way_0261$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
  v_count int;
begin
  if to_regprocedure('private.invoice_three_way_raw(uuid, uuid)') is null then
    raise exception '0261: private.invoice_three_way_raw is absent';
  end if;

  v_definition := replace(pg_get_functiondef(
    'private.invoice_three_way_raw(uuid, uuid)'::regprocedure), e'\r', '');

  -- ---- 1. Two more declarations, beside the totals they belong to. ---------------------------
  v_anchor := e'  v_net_total numeric := 0;\n  v_vat_total numeric := 0;\n';
  v_replacement := e'  v_net_total numeric := 0;\n  v_vat_total numeric := 0;\n'
    || e'  -- 0261: what the lines say was taken off, and the scale of the currency they are in.\n'
    || e'  -- The discount is already subtracted inside `line_total`; it was never published, so\n'
    || e'  -- the ladder had no rung for it and the reader could not see where the money went.\n'
    || e'  v_lines_discount numeric := 0;\n'
    || e'  v_minor_units smallint;\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0261: totals declaration anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- ---- 2. The currency's scale, read where its tolerances are read. ---------------------------
  -- Same row, same currency, same absence of any rate: `minor_units` is a property of the money,
  -- not a conversion between two of them. Two places is the default for a currency this database
  -- does not carry, which is the same fallback `0227` chose on the document side.
  v_anchor := e'  v_document_tolerance := private.money_tolerance(\n'
    || e'    p_org_id, v_invoice.currency, ''invoice_document_amount_tolerance'');\n';
  v_replacement := v_anchor
    || e'  select currency.minor_units into v_minor_units\n'
    || e'  from public.currencies currency where currency.code = v_invoice.currency;\n'
    || e'  v_minor_units := coalesce(v_minor_units, 2);\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0261: tolerance assignment anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- ---- 3. Accumulate the discount exactly where the net is accumulated. -----------------------
  -- Inside the same loop iteration, so both figures describe the same set of lines and no line
  -- can contribute to one and not the other.
  v_anchor := e'      v_net_total := v_net_total + v_line.line_total;\n';
  v_replacement := e'      v_net_total := v_net_total + v_line.line_total;\n'
    || e'      v_lines_discount := v_lines_discount + v_line.discount_amount;\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0261: net accumulation anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- ---- 4. Publish the rest of the ladder. -----------------------------------------------------
  v_anchor := e'      ''line_tolerance'', v_line_tolerance,\n'
    || e'      ''invoice_tolerance'', v_document_tolerance,\n'
    || e'      ''currency'', v_invoice.currency\n    ),\n';
  v_replacement := e'      ''line_tolerance'', v_line_tolerance,\n'
    || e'      ''invoice_tolerance'', v_document_tolerance,\n'
    || e'      ''currency'', v_invoice.currency,\n'
    -- Null when there are no lines, never zero: an invoice nobody itemised did not discount
    -- nothing, it said nothing. `missing_rungs` below names that same absence.
    || e'      ''lines_discount'', case when jsonb_array_length(v_lines) > 0\n'
    || e'                             then round(v_lines_discount, v_minor_units) else null end,\n'
    -- What the invoice header itself implies, added once, on the server that judged it.
    || e'      ''computed_total'', round(\n'
    || e'        v_invoice.amount_before_vat + v_invoice.vat_amount, v_minor_units),\n'
    -- And by how much the stated total misses it. Always a number here: all three header
    -- columns are NOT NULL on an invoice, which is exactly what makes this side different
    -- from a document somebody photographed.
    || e'      ''unexplained_gap'', round(\n'
    || e'        v_invoice.total_amount\n'
    || e'          - (v_invoice.amount_before_vat + v_invoice.vat_amount), v_minor_units),\n'
    || e'      ''lines_vs_header_gap'', case when jsonb_array_length(v_lines) > 0\n'
    || e'                                   then round(v_net_total - v_invoice.amount_before_vat,\n'
    || e'                                              v_minor_units)\n'
    || e'                                   else null end,\n'
    -- The only rung an invoice can be missing. Named rather than left as a null, because a null
    -- that has been through JSON cannot say which absence it is.
    || e'      ''missing_rungs'', case when jsonb_array_length(v_lines) > 0\n'
    || e'                            then ''[]''::jsonb else ''["lines_net"]''::jsonb end\n'
    || e'    ),\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0261: totals output anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end
$patch_three_way_0261$;

comment on function private.invoice_three_way_raw(uuid, uuid) is
  'The three-way match the invoice screen reads. From 0261 the totals block publishes the same '
  'ladder the document assessment does — the discount the lines declare, the total the header '
  'implies, the gap against the stated total, the lines-versus-header gap, and the one rung an '
  'invoice can be missing. No comparison, reason, severity or approval_blocked value changes: '
  'this adds keys and decides nothing, and it does not re-round what 0099 already published.';

do $verify_three_way_0261$
declare
  v_body text;
  v_violations text;
begin
  v_body := replace(pg_get_functiondef(
    'private.invoice_three_way_raw(uuid, uuid)'::regprocedure), e'\r', '');

  if position('''lines_discount''' in v_body) = 0
     or position('''computed_total''' in v_body) = 0
     or position('''unexplained_gap''' in v_body) = 0
     or position('''lines_vs_header_gap''' in v_body) = 0
     or position('''missing_rungs''' in v_body) = 0 then
    raise exception '0261: the totals block does not publish the full ladder';
  end if;

  -- The new figures are scaled by the CURRENCY, which is the whole point of deriving the scale
  -- rather than typing 2. A literal here would have reintroduced the shekel assumption `0259`
  -- removed from the comparisons three lines above it.
  if position('v_minor_units := coalesce(v_minor_units, 2);' in v_body) = 0
     or position('v_invoice.amount_before_vat + v_invoice.vat_amount, v_minor_units)' in v_body) = 0 then
    raise exception '0261: the ladder is not scaled by the currency''s minor units';
  end if;

  -- WHAT WAS ALREADY PUBLISHED DID NOT MOVE. Two Edge Function tools read these three fields.
  if position('''line_net'', round(v_net_total, 2),' in v_body) = 0
     or position('''line_vat'', round(v_vat_total, 2),' in v_body) = 0
     or position('''line_grand'', round(v_net_total + v_vat_total, 2),' in v_body) = 0 then
    raise exception '0261: an existing published total was re-rounded';
  end if;

  -- NOTHING THAT DECIDES ANYTHING MOVED. Counted rather than eyeballed: an anchored replacement
  -- that slipped could change an outcome in silence, and silence is the failure mode this whole
  -- pattern exists to prevent.
  if (length(v_body) - length(replace(v_body, 'v_blocked := true;', '')))
       / length('v_blocked := true;') <> 20 then
    raise exception '0261: the number of blocking paths changed';
  end if;
  if (length(v_body) - length(replace(v_body, 'v_warning := true;', '')))
       / length('v_warning := true;') <> 4 then
    raise exception '0261: the number of warning paths changed';
  end if;

  -- The three money comparisons `0259` converted are still per-currency and still there.
  if position('if v_document_tolerance is not null and abs(v_net_total - v_invoice.amount_before_vat) > v_document_tolerance then' in v_body) = 0
     or position('if v_document_tolerance is not null and abs(v_vat_total - v_invoice.vat_amount) > v_document_tolerance then' in v_body) = 0
     or position('if v_document_tolerance is not null and abs((v_net_total + v_vat_total) - v_invoice.total_amount) > v_document_tolerance then' in v_body) = 0 then
    raise exception '0261: a money comparison was disturbed';
  end if;
  if position('amount_check_skipped_no_tolerance' in v_body) = 0 then
    raise exception '0261: the 0259 missing-tolerance finding was lost';
  end if;

  if (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'invoice_three_way_raw') then
    raise exception '0261: invoice_three_way_raw became SECURITY DEFINER';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0261 scope assertions failed:\n%', v_violations;
  end if;
end
$verify_three_way_0261$;
