-- 0244 — a check that could not run says so, instead of looking like a check that passed.
--
-- `0227` made the intake arithmetic tolerances per-currency, and honoured the half of `#288` that
-- forbids inventing a number: with no tolerance for the document's currency the comparison is
-- simply not made. What it did not do is SAY so. The clause reads
--
--     if v_line_tolerance is not null and abs(v_line_total - v_expected_total) > v_line_tolerance
--
-- so a dollar invoice whose line arithmetic is wrong produces no finding at all, and the review
-- screen shows a document that passed every check it was given. It was not given this one.
--
-- The asymmetry with the bank is deliberate and stays (`#293`, owner 30.08.2026): receiving and
-- reading a document is not dangerous, so intake continues and warns; moving money is, so `0232`
-- still refuses outright. What changes here is only that the intake half stops being silent. The
-- constitution's rule about showing `—` rather than `0` is the same rule — an absence of a
-- measurement must not be dressed as a measurement that came out clean.
--
-- SEVERITY IS `warning` AND `approval_blocked` STAYS FALSE. Blocking would mean a business cannot
-- see its own invoice until somebody visits a settings screen, which is the failure mode #293
-- rejected. The finding is loud enough to act on and never a gate.
--
-- No definer hash moves. `private.document_reconciliation_assessment` is SECURITY INVOKER and is
-- absent from `private.scope_definer_enforcements`; its two definer callers
-- (`apply_reviewed_document`, `get_document_review_assessment`) are untouched, so their pinned
-- bodies still hash to what `0227`/`0230` recorded. The proof block below asserts exactly that
-- rather than trusting the reasoning.

do $patch_assessment_0244$
declare
  v_definition text := replace(pg_get_functiondef(
    'private.document_reconciliation_assessment(uuid,text,uuid,uuid,jsonb,date)'::regprocedure), e'\r', '');
  v_anchor text;
  v_replacement text;
  v_count integer;
begin
  -- Anchored on the end of the tolerance resolution, which is the first point at which both
  -- answers are known. Restating the function's 500 lines would risk dropping one of the
  -- comparisons it performs; the anchor must occur exactly once.
  v_anchor := $anchor$  v_document_tolerance := coalesce(
    private.money_tolerance(p_org_id, v_currency, 'invoice_document_amount_tolerance'),
    case when v_currency = 'ILS' then 1 end);$anchor$;
  v_replacement := $replacement$  v_document_tolerance := coalesce(
    private.money_tolerance(p_org_id, v_currency, 'invoice_document_amount_tolerance'),
    case when v_currency = 'ILS' then 1 end);

  -- A tolerance nobody stated means the arithmetic cannot be compared. Saying nothing would let a
  -- document that was never checked look exactly like one that passed (0244, #288, #293).
  if v_line_tolerance is null or v_document_tolerance is null then
    v_warning := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'amount_check_skipped_no_tolerance', 'severity', 'warning',
      'currency', v_currency,
      'line_tolerance_missing', v_line_tolerance is null,
      'document_tolerance_missing', v_document_tolerance is null,
      'message', 'לא נקבעה סטיית סכום מותרת למטבע הזה, ולכן בדיקת הסכומים לא בוצעה — אפשר לקבוע אותה בהגדרות'));
  end if;$replacement$;
  v_count := (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor);
  if v_count <> 1 then raise exception '0244: assessment tolerance anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_assessment_0244$;

-- ===== Proof =====
do $assert_0244$
declare
  v_violations text;
  v_body       text;
begin
  select prosrc into v_body
  from pg_proc
  where oid = 'private.document_reconciliation_assessment(uuid,text,uuid,uuid,jsonb,date)'::regprocedure;

  if position('amount_check_skipped_no_tolerance' in v_body) = 0 then
    raise exception '0244: the skipped-check finding is not in the live assessment body';
  end if;

  -- The finding must not have become a gate. #293 says the document enters.
  if v_body !~ 'amount_check_skipped_no_tolerance''[^$]{0,200}?''severity'', ''warning''' then
    raise exception '0244: the skipped-check finding is not a warning';
  end if;

  -- 0227's refusal of an unreadable currency is a DIFFERENT rule from the one this migration adds,
  -- and it must survive the patch intact — code and severity together. A downgrade to `warning`
  -- would be the more dangerous regression of the two: the finding would still be listed while
  -- quietly ceasing to block approval, so an unreadable currency would be recorded anyway.
  -- Asserting the pair verbatim is also what `check:currency`'s intake guard reads out of this
  -- file, so the migration and the guard are checking one fact rather than two similar ones.
  if position($refusal$'code', 'currency_unrecognised', 'severity', 'error'$refusal$ in v_body) = 0 then
    raise exception '0244: the unrecognised-currency refusal was lost or downgraded';
  end if;

  -- The function this migration edits is an invoker and must stay one, or A5 and the definer
  -- coverage rules start applying to a body that was not written for them.
  if (select prosecdef from pg_proc
      where oid = 'private.document_reconciliation_assessment(uuid,text,uuid,uuid,jsonb,date)'::regprocedure) then
    raise exception '0244: the assessment became SECURITY DEFINER';
  end if;

  -- The document-automation guard `0182` installed and `0230`/`0241` re-pinned after each change
  -- to this path. P68 is what failed twice during the previous campaign; asserting it inside the
  -- migration means a drift is a failed migration rather than a failed CI run an hour later.
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.document_automation_negative_guard_violations();
  if v_violations is not null then
    raise exception e'0244 document automation guard failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_definer_marker_violations();
  if v_violations is not null then
    raise exception e'0244 definer marker assertions failed:\n%', v_violations;
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0244 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0244 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0244$;
