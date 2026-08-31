-- 0260 — the document assessment publishes the whole ladder, not five rungs of it.
--
-- WHY THIS IS A MIGRATION AND NOT A COMPONENT. `private.document_reconciliation_assessment`
-- already computes everything a reconciliation strip needs to draw: it sums the lines, reads the
-- header's three figures, and compares them against a per-currency tolerance. What it PUBLISHES is
-- five numbers and two tolerances — so a screen wanting to show the reader "lines → discounts →
-- VAT → computed → stated → the gap" would have to add `header_net + header_vat` and subtract in
-- React. That is a second source of truth for money, which the constitution forbids in as many
-- words, and it would be a source that rounds differently from the one that decided whether to
-- block the document.
--
-- THE GAP IS THE POINT, AND IT IS NOT A SUBTRACTION. The server already knows whether the numbers
-- reconcile; it raises `header_arithmetic_discrepancy` when they do not. What it never said is BY
-- HOW MUCH. A finding that says "the header does not add up" without the amount tells a reader
-- there is a problem and nothing about its size, and the size is the whole difference between a
-- rounding artefact and a missing discount line.
--
-- TWO LADDERS, AND THEY DO NOT MIX. `unexplained_gap` belongs to the document's OWN arithmetic —
-- net plus VAT against the stated total — and every rung of it exists on every document today.
-- What is withheld at source, and what actually landed in the bank, are a SECOND ladder whose
-- rungs are not extracted at all. Merging them would make `unexplained_gap` null on every document
-- in the country, because withholding is never known, and a figure that is always null is a figure
-- nobody can act on. The second ladder is not added here: absence is what the screen reports, and
-- adding empty columns for it would dress "we never looked" as "we looked and found nothing".
--
-- MISSING RUNGS ARE NAMED, NOT INFERRED. A reader has to be able to tell "the VAT is zero" from
-- "the VAT was not extracted", and a null in a number field cannot carry that on its own once it
-- has been through JSON. `missing_rungs` lists them by name, so a strip can print "not extracted"
-- beside the exact row rather than guessing which absence it is looking at.
--
-- NOTHING ABOUT THE DECISION CHANGES. Not one comparison, not one finding, not one severity, and
-- not `approval_blocked`. This migration adds keys to a read model and touches nothing that
-- decides anything — asserted below rather than claimed.
--
-- The function is SECURITY INVOKER (measured: `prosecdef = false`) and holds no scope exemption,
-- exactly as `0244` recorded when it patched the same body. Its definer callers are untouched, so
-- their pinned hashes do not move. The body is read with carriage returns stripped
-- (`check:anchored-replacements`).

do $patch_assessment_0260$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
  v_count int;
begin
  if to_regprocedure('private.document_reconciliation_assessment(uuid, text, uuid, uuid, jsonb, date)') is null then
    raise exception '0260: private.document_reconciliation_assessment is absent';
  end if;

  v_definition := replace(pg_get_functiondef(
    'private.document_reconciliation_assessment(uuid, text, uuid, uuid, jsonb, date)'::regprocedure),
    e'\r', '');

  -- ---- 1. One more accumulator: what the document says it took off. --------------------------
  v_anchor := e'  v_lines_net numeric := 0;\n';
  v_replacement := e'  v_lines_net numeric := 0;\n'
    || e'  -- 0260: the discounts the lines declare, summed. Already subtracted line by line when\n'
    || e'  -- the arithmetic is checked; never published, so the ladder had no rung for it.\n'
    || e'  v_lines_discount numeric := 0;\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0260: lines_net declaration anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- ---- 2. Accumulate it exactly where the line total is accumulated. --------------------------
  -- Inside the same guard, so a line the server could not read contributes to NEITHER figure and
  -- the two stay describable by one sentence: "the lines it could read".
  v_anchor := e'      v_lines_net := v_lines_net + v_line_total;\n';
  v_replacement := e'      v_lines_net := v_lines_net + v_line_total;\n'
    || e'      v_lines_discount := v_lines_discount\n'
    || e'        + coalesce((v_line ->> ''discount_amount'')::numeric, 0);\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0260: lines_net accumulation anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- ---- 3. Publish the rest of the ladder. -----------------------------------------------------
  v_anchor := e'      ''line_tolerance'', v_line_tolerance,\n'
    || e'      ''document_tolerance'', v_document_tolerance),\n';
  v_replacement := e'      ''line_tolerance'', v_line_tolerance,\n'
    || e'      ''document_tolerance'', v_document_tolerance,\n'
    -- The unit every figure above is in. A strip that has to ask a second question to know what
    -- it is printing is a strip that can print the right number with the wrong symbol.
    || e'      ''currency'', v_currency,\n'
    || e'      ''lines_discount'', case when jsonb_array_length(v_line_rows) > 0\n'
    || e'                              then round(v_lines_discount, v_minor_units) else null end,\n'
    -- What the header ITSELF implies, computed once, by the same code that judged it.
    || e'      ''computed_total'', case when v_header_net is not null and v_header_vat is not null\n'
    || e'                              then round(v_header_net + v_header_vat, v_minor_units)\n'
    || e'                              else null end,\n'
    -- And by how much it misses. Null where a rung is missing: an ungeneratable gap is not zero.
    || e'      ''unexplained_gap'', case when v_header_net is not null and v_header_vat is not null\n'
    || e'                                 and v_header_total is not null\n'
    || e'                              then round(v_header_total - (v_header_net + v_header_vat),\n'
    || e'                                         v_minor_units)\n'
    || e'                              else null end,\n'
    || e'      ''lines_vs_header_gap'', case when jsonb_array_length(v_line_rows) > 0\n'
    || e'                                     and v_header_net is not null\n'
    || e'                                  then round(v_lines_net - v_header_net, v_minor_units)\n'
    || e'                                  else null end,\n'
    -- Named absences. "The VAT is zero" and "the VAT was not extracted" are different sentences,
    -- and a null that has been through JSON cannot tell them apart on its own.
    || e'      ''missing_rungs'', (\n'
    || e'        select coalesce(jsonb_agg(rung), ''[]''::jsonb) from (\n'
    || e'          select ''lines_net'' as rung where jsonb_array_length(v_line_rows) = 0\n'
    || e'          union all select ''header_net'' where v_header_net is null\n'
    || e'          union all select ''header_vat'' where v_header_vat is null\n'
    || e'          union all select ''header_total'' where v_header_total is null\n'
    || e'        ) rungs)),\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0260: totals output anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end
$patch_assessment_0260$;

comment on function private.document_reconciliation_assessment(uuid, text, uuid, uuid, jsonb, date) is
  'The reconciliation the review screen reads. From 0260 the totals block publishes the whole '
  'ladder — discounts, the computed header, the unexplained gap, the lines-versus-header gap, the '
  'currency, and the rungs it could not extract — so a screen renders the arithmetic that decided '
  'the outcome instead of redoing it. No comparison, finding, severity or approval_blocked value '
  'changes: this adds keys and decides nothing.';

do $verify_assessment_0260$
declare
  v_body text;
  v_violations text;
begin
  v_body := replace(pg_get_functiondef(
    'private.document_reconciliation_assessment(uuid, text, uuid, uuid, jsonb, date)'::regprocedure),
    e'\r', '');

  if position('''unexplained_gap''' in v_body) = 0
     or position('''computed_total''' in v_body) = 0
     or position('''lines_discount''' in v_body) = 0
     or position('''lines_vs_header_gap''' in v_body) = 0
     or position('''missing_rungs''' in v_body) = 0
     or position('''currency'', v_currency,' in v_body) = 0 then
    raise exception '0260: the totals block does not publish the full ladder';
  end if;

  -- The gap is computed WITH the rounding the comparisons use. A strip adding these in React
  -- would round differently from the code that decided whether to block, which is the whole
  -- reason this is a migration.
  if position('round(v_header_total - (v_header_net + v_header_vat),' in v_body) = 0 then
    raise exception '0260: the gap is not rounded by the assessment''s own minor units';
  end if;

  -- NOTHING THAT DECIDES ANYTHING MOVED. The five comparison guards and the block flag are counted
  -- rather than eyeballed: an anchored replacement that slipped could change an outcome silently.
  if (length(v_body) - length(replace(v_body, 'v_blocked := true;', '')))
       / length('v_blocked := true;') <> 16 then
    raise exception '0260: the number of blocking paths changed';
  end if;
  if position('and abs(v_lines_net - v_header_net) > v_document_tolerance' in v_body) = 0
     or position('and abs((v_header_net + v_header_vat) - v_header_total) > v_document_tolerance' in v_body) = 0
     or position('and abs(v_line_total - v_expected_total) > v_line_tolerance' in v_body) = 0 then
    raise exception '0260: a money comparison was disturbed';
  end if;
  if position('amount_check_skipped_no_tolerance' in v_body) = 0 then
    raise exception '0260: the 0244 missing-tolerance finding was lost';
  end if;

  if (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'document_reconciliation_assessment') then
    raise exception '0260: document_reconciliation_assessment became SECURITY DEFINER';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0260 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0260 export registry assertions failed:\n%', v_violations;
  end if;
end
$verify_assessment_0260$;
