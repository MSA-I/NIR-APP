-- 0259 — the invoice's five money comparisons stop being shekel comparisons.
--
-- WHAT WAS MEASURED, AND WHY THE UI COULD NOT SHIP WITHOUT THIS. `private.invoice_three_way_raw`
-- compares money against LITERALS: `> 1` for the header identity, the net total, the VAT total and
-- the grand total, and `> 0.05` for a line's own arithmetic. It also PUBLISHES those literals, as
-- `line_tolerance: 0.05` and `invoice_tolerance: 1`. The document path was converted to a
-- per-currency tolerance in `0227` and the invoice path was not, so from `0227` onward the two
-- halves of the same product disagreed about what "close enough" means — and a screen that printed
-- "the tolerance for this currency" beside an invoice would have been stating something the server
-- does not enforce. That is why the plan makes this a blocking dependency of the strip rather than
-- a tidy-up.
--
-- ¥1 IS NOT ₪1, AND THAT IS THE WHOLE BUG. `1` was never a currency-neutral number. In JPY, whose
-- minor unit is the yen itself, a tolerance of 1 is one hundred times stricter than the shekel rule
-- it was copied from; in KWD, with three decimals, it is ten times looser. `#294` settled this for
-- every currency at once: the threshold is 100 minor units (5 for a line), derived from
-- `currencies.minor_units`, with NO conversion and no rate anywhere. `private.money_tolerance`
-- (`0219`, `0245`) already answers exactly that question, and already prefers whatever the
-- organisation stated for that currency.
--
-- A MISSING TOLERANCE IS SAID OUT LOUD, NOT SKIPPED. `money_tolerance` returns null for a currency
-- this database does not recognise or has deactivated. Comparing against null would silently pass
-- every check, so an invoice nobody could check would look exactly like one that checked out —
-- the same failure `0244` repaired on the document side, and the same rule the constitution states
-- about printing `0` where nothing was measured. The finding is `warning` and does NOT block:
-- `#293` rejected making a business unable to see its own invoice until somebody visits a settings
-- screen. `v_warning` already exists in this function and already feeds `matched_with_warnings`.
--
-- NO SECURITY PROPERTY MOVES. `private.invoice_three_way_raw` is SECURITY INVOKER (measured:
-- `prosecdef = false`), it holds no scope-definer exemption, and this migration replaces only its
-- body. Its definer callers are not touched, so any pinned body hash of theirs is unchanged — the
-- same reasoning `0244` recorded for the document side, asserted below rather than assumed.
--
-- The body is read with the carriage returns stripped (`check:anchored-replacements`): a body
-- applied from Windows carries CRLF and one applied on a CI runner carries LF, and an anchor built
-- with `e'\n'` would match in one and fail in the other. That is how the `0181` rollout aborted.

do $patch_three_way_0259$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
  v_count int;
begin
  if to_regprocedure('private.invoice_three_way_raw(uuid, uuid)') is null then
    raise exception '0259: private.invoice_three_way_raw(uuid, uuid) is absent';
  end if;

  v_definition := replace(
    pg_get_functiondef('private.invoice_three_way_raw(uuid, uuid)'::regprocedure), e'\r', '');

  -- ---- 1. Two variables for the two tolerances, declared beside the totals they bound. --------
  v_anchor := e'  v_net_total numeric := 0;\n  v_vat_total numeric := 0;\n';
  v_replacement := e'  v_net_total numeric := 0;\n  v_vat_total numeric := 0;\n'
    || e'  -- 0259: the tolerances this invoice is judged against, in ITS currency. Null where the\n'
    || e'  -- database does not recognise the currency, which is a finding rather than a pass.\n'
    || e'  v_line_tolerance numeric;\n  v_document_tolerance numeric;\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0259: totals declaration anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- ---- 2. Resolve them once, as soon as the invoice (and therefore its currency) is known. ----
  v_anchor := e'  select organization.vat_rate into v_expected_vat_rate\n'
    || e'  from public.organizations organization\n'
    || e'  where organization.id = p_org_id;\n';
  v_replacement := v_anchor
    || e'\n'
    || e'  -- 0259: per-currency, never converted (#294). `money_tolerance` prefers what the\n'
    || e'  -- organisation stated for THIS currency and otherwise derives the threshold from\n'
    || e'  -- currencies.minor_units, so ¥1 and ₪1 stop being the same number.\n'
    || e'  v_line_tolerance := private.money_tolerance(\n'
    || e'    p_org_id, v_invoice.currency, ''invoice_line_amount_tolerance'');\n'
    || e'  v_document_tolerance := private.money_tolerance(\n'
    || e'    p_org_id, v_invoice.currency, ''invoice_document_amount_tolerance'');\n'
    || e'  if v_line_tolerance is null or v_document_tolerance is null then\n'
    || e'    -- Saying nothing would let an invoice that was never checked look like one that\n'
    || e'    -- passed (0244, #288, #293). A warning, never a block.\n'
    || e'    v_warning := true;\n'
    || e'    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(\n'
    || e'      ''code'', ''amount_check_skipped_no_tolerance'', ''severity'', ''warning'',\n'
    || e'      ''currency'', v_invoice.currency,\n'
    || e'      ''line_tolerance_missing'', v_line_tolerance is null,\n'
    || e'      ''invoice_tolerance_missing'', v_document_tolerance is null,\n'
    || e'      ''message_key'', ''invoice_three_way.amount_check_skipped_no_tolerance''));\n'
    || e'  end if;\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0259: vat rate anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- ---- 3. The header identity: net + VAT against the invoice's own total. --------------------
  -- Each comparison gains `v_*_tolerance is not null and` rather than defaulting to a number:
  -- an unknown tolerance must not be silently replaced by one that happens to be handy.
  v_anchor := e'  if abs(\n'
    || e'    (v_invoice.amount_before_vat + v_invoice.vat_amount) - v_invoice.total_amount\n'
    || e'  ) > 1 then\n';
  v_replacement := e'  if v_document_tolerance is not null and abs(\n'
    || e'    (v_invoice.amount_before_vat + v_invoice.vat_amount) - v_invoice.total_amount\n'
    || e'  ) > v_document_tolerance then\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0259: header identity anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- ---- 4. A line's own arithmetic. -----------------------------------------------------------
  v_anchor := e'      if abs(v_line.line_total - v_line_expected) > 0.05 then\n';
  v_replacement := e'      if v_line_tolerance is not null'
    || e' and abs(v_line.line_total - v_line_expected) > v_line_tolerance then\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0259: line arithmetic anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- ---- 5-7. The three line-sum-versus-header comparisons. -------------------------------------
  v_anchor := e'    if abs(v_net_total - v_invoice.amount_before_vat) > 1 then\n';
  v_replacement := e'    if v_document_tolerance is not null'
    || e' and abs(v_net_total - v_invoice.amount_before_vat) > v_document_tolerance then\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0259: net total anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'    if abs(v_vat_total - v_invoice.vat_amount) > 1 then\n';
  v_replacement := e'    if v_document_tolerance is not null'
    || e' and abs(v_vat_total - v_invoice.vat_amount) > v_document_tolerance then\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0259: vat total anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'    if abs((v_net_total + v_vat_total) - v_invoice.total_amount) > 1 then\n';
  v_replacement := e'    if v_document_tolerance is not null'
    || e' and abs((v_net_total + v_vat_total) - v_invoice.total_amount) > v_document_tolerance then\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0259: grand total anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- ---- 8. What the reasons PUBLISH, so a caller reads the tolerance that was enforced. --------
  --
  -- Five payloads carry a `tolerance`. FOUR are money and move; the fifth is `'tolerance', 0` on
  -- `vat_rate_mismatch`, which bounds a RATE and not an amount, and the plan says in as many words
  -- not to touch the quantity and percent tolerances. Each is anchored on the message key beside
  -- it rather than on the literal alone: indentation differs between them, and an anchor that
  -- matched three of four would have left one shekel behind and still counted itself correct.

  -- 8a. The header identity — six spaces, message key on the next line.
  v_anchor := e'      ''tolerance'', 1,\n'
    || e'      ''message_key'', ''invoice_three_way.invoice_header_arithmetic_discrepancy''';
  v_replacement := e'      ''tolerance'', v_document_tolerance,\n'
    || e'      ''message_key'', ''invoice_three_way.invoice_header_arithmetic_discrepancy''';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0259: header tolerance output anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- 8b. The line's own arithmetic — the only one that publishes the LINE tolerance.
  v_anchor := e'          ''tolerance'', 0.05,'
    || e' ''message_key'', ''invoice_three_way.line_arithmetic_discrepancy''';
  v_replacement := e'          ''tolerance'', v_line_tolerance,'
    || e' ''message_key'', ''invoice_three_way.line_arithmetic_discrepancy''';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0259: line tolerance output anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- 8c. The three line-sum-versus-header reasons — eight spaces, message key on the same line.
  v_anchor := e'        ''tolerance'', 1, ''message_key''';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 3 then raise exception '0259: total tolerance output count % (expected 3)', v_count; end if;
  v_definition := replace(
    v_definition, v_anchor, e'        ''tolerance'', v_document_tolerance, ''message_key''');

  -- ---- 9. And the two published on the totals block itself. -----------------------------------
  v_anchor := e'      ''line_tolerance'', 0.05,\n      ''invoice_tolerance'', 1\n';
  v_replacement := e'      ''line_tolerance'', v_line_tolerance,\n'
    || e'      ''invoice_tolerance'', v_document_tolerance,\n'
    || e'      ''currency'', v_invoice.currency\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0259: totals tolerance output anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end
$patch_three_way_0259$;

comment on function private.invoice_three_way_raw(uuid, uuid) is
  'The three-way comparison for one invoice. From 0259 every money comparison and every published '
  'tolerance is per-currency via private.money_tolerance (0219, 0245, #294) instead of the shekel '
  'literals 1 and 0.05 it carried since 0099 — the same conversion 0227 made on the document side. '
  'A currency with no tolerance produces amount_check_skipped_no_tolerance at severity warning and '
  'does NOT block, because an invoice nobody can check must not look like one that checked out.';

-- ---- The proof, not the reasoning. -----------------------------------------------------------
do $verify_three_way_0259$
declare
  v_body text;
  v_violations text;
begin
  v_body := replace(
    pg_get_functiondef('private.invoice_three_way_raw(uuid, uuid)'::regprocedure), e'\r', '');

  -- Not one shekel literal survives in a MONEY comparison or an output.
  --
  -- Named by their exact shapes rather than by `> 1 then`: this function also compares a COUNT
  -- that way (`v_candidate_count > 1`, twice), and a broad check failed a correct patch on it.
  -- Measuring the wrong thing is how a green assertion stops meaning anything.
  if position(') > 1 then' in v_body) > 0
     or position('- v_invoice.amount_before_vat) > 1' in v_body) > 0
     or position('- v_invoice.vat_amount) > 1' in v_body) > 0
     or position('- v_invoice.total_amount) > 1' in v_body) > 0 then
    raise exception '0259: a shekel-literal money comparison survived in invoice_three_way_raw';
  end if;
  if position('> 0.05 then' in v_body) > 0 then
    raise exception '0259: a `> 0.05` line comparison survived in invoice_three_way_raw';
  end if;
  if position('''line_tolerance'', 0.05' in v_body) > 0
     or position('''invoice_tolerance'', 1' in v_body) > 0
     or position('''tolerance'', 1,' in v_body) > 0
     or position('''tolerance'', 0.05,' in v_body) > 0 then
    raise exception '0259: a hard-coded money tolerance is still published by invoice_three_way_raw';
  end if;

  -- The rate tolerance is NOT money and must survive untouched. Asserting what stayed is as much
  -- the point as asserting what moved: a replacement that swept it up would have changed the
  -- meaning of `vat_rate_mismatch` while every other check here still passed.
  if position('''tolerance'', 0,' in v_body) = 0 then
    raise exception '0259: the vat_rate_mismatch rate tolerance was changed and must not be';
  end if;
  -- FOUR reason payloads publish the document tolerance, and the totals block publishes it once
  -- more under its own name. Counted separately because they are different claims: the first says
  -- every money reason reports what bounded it, the second says the read model does.
  if (length(v_body) - length(replace(v_body, '''tolerance'', v_document_tolerance', '')))
       / length('''tolerance'', v_document_tolerance') <> 4 then
    raise exception '0259: expected four money reasons to publish the document tolerance';
  end if;
  if position('''invoice_tolerance'', v_document_tolerance' in v_body) = 0
     or position('''line_tolerance'', v_line_tolerance' in v_body) = 0 then
    raise exception '0259: the totals block does not publish the tolerances it was judged by';
  end if;
  if position('''tolerance'', v_line_tolerance' in v_body) = 0 then
    raise exception '0259: the line reason does not publish the line tolerance';
  end if;
  -- The currency the tolerances belong to travels with them, so a reader never has to assume it.
  if position('''currency'', v_invoice.currency' in v_body) = 0 then
    raise exception '0259: the totals block does not name the currency it was measured in';
  end if;

  -- All five comparisons went through the per-currency reader, and none of them can run on null.
  if (length(v_body) - length(replace(v_body, 'v_document_tolerance is not null', '')))
       / length('v_document_tolerance is not null') <> 4 then
    raise exception '0259: expected four document-tolerance guards';
  end if;
  if position('v_line_tolerance is not null and abs(v_line.line_total' in v_body) = 0 then
    raise exception '0259: the line comparison is not guarded against a null tolerance';
  end if;
  if position('amount_check_skipped_no_tolerance' in v_body) = 0 then
    raise exception '0259: a missing tolerance is skipped silently instead of reported';
  end if;

  -- SECURITY INVOKER is not a detail here: it is why no definer exemption or scope marker moves.
  if (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'invoice_three_way_raw') then
    raise exception '0259: invoice_three_way_raw became SECURITY DEFINER';
  end if;

  -- The scope contract is unchanged, and this asserts it rather than assuming it (0058:207-218).
  -- Written in the exact idiom `check:exemptions` recognises: an assertion the guard cannot see is
  -- an assertion a later migration can drop without anything noticing.
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0259 scope assertions failed:\n%', v_violations;
  end if;

  -- No table and no column changed here, so A6 has nothing new to classify — asserted rather than
  -- reasoned about, because that is the difference between the two.
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0259 export registry assertions failed:\n%', v_violations;
  end if;
end
$verify_three_way_0259$;
