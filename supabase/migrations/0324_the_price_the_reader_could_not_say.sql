-- 0324 — the price the reader could not say, and the sum that was never measured.
--        QA-sweep-20260904, PR 17. Closes DOC-08 and DOC-03; DOC-02 gets its own sentence here.
--
-- THE NUMBER. This file was ASSIGNED 0318 by the campaign's number ledger. `0318` is TAKEN: the
-- other live campaign on this machine, `docs/ux-remediation-documents-assistant`, carries
-- `0318_failed_document_replacement.sql`, `npm run next-number` names it under "CLAIMED ON A
-- BRANCH ... Do not reuse them", and THIS campaign's own evidence already recorded it twice
-- (`PR13-PERM-02-RED.txt:40`, `-GREEN.txt:17`: "0316 / 0317 / 0318 belong to the other campaign").
-- The ledger line assigning 0318 to PR 17 predates that measurement. Git does not conflict on a
-- taken number -- it merges both sides silently and one wins -- so the assignment is followed in
-- spirit and not in the digit: this takes 0324, which the ledger lists as "next free; unassigned".
-- Reported to the coordinator rather than done quietly.
--
-- ---------------------------------------------------------------------------------------------
-- THE DEFECT, MEASURED ON PRODUCTION 05.09.2026 (project rkftlbctohswhbbiaqin, read-only).
--
-- Interpretation e7138033-2bc8-4131-a6c4-4237c9e2bfa9, `PHOTO-2026-08-16-14-02-58.jpg`, and
-- b7d7f7c9-55d5-4c92-bc68-ba8c811c2c0e, `א.ע עלים ירוקים — חשבונית 2026-08.jpeg`. Both carry 22
-- line items. Every one of the 22 has a printed unit price. The OCR adapter transcribes it the way
-- the supplier prints it:
--
--     {"sku": "10002", "unit": "יח'", "quantity": "8.00",
--      "line_total": "33.60", "unit_price": "4.20 ש\"ח", ...}
--
-- `private.interpretation_number` strips whitespace, commas, `₪` and the bidi marks, then demands
-- that what is left be a bare number. `4.20 ש"ח` becomes `4.20ש"ח`, fails that test, and comes
-- back NULL. Measured: unit_price parses on **0 of 22** lines; quantity on 22 of 22; line_total on
-- 22 of 22.
--
-- That single NULL is the whole finding, and it produces three separate lies on one screen:
--
--   1. `מחיר במסמך` reads `—` on every line (DOC-08), while three panels away the SAME screen
--      prints the raw value `4.20 ש"ח` verbatim -- `DocumentReviewProposals.tsx:718` renders every
--      key of `line_items[].values`. The payload and the page did not disagree; two readers of one
--      payload did.
--   2. The accumulator at the top of the line loop adds `line_total` only when quantity AND
--      unit_price AND line_total are all non-null. With unit_price NULL on all 22, `v_lines_net`
--      stays at its initial 0 -- and `lines_net` is emitted as null ONLY at zero rows, so 22
--      skipped lines print a MEASURED `0.00`. `missing_rungs` said `[]`: the ladder whose whole
--      job is to say which number is missing declared that none was. Measured on production:
--      `lines_net: 0`, `header_net: 20720.8`, `lines_vs_header_gap: -20720.8`, `missing_rungs: []`.
--      A metric with no data must show `—`, never `0` -- zero is also a claim about reality.
--   3. That fictional 0.00 is then compared to a real header total and blocks the document with
--      `header_total_differs_from_lines` (DOC-03). The person is told the header disagrees with
--      the lines. It does not. Nothing ever measured the lines.
--
-- AND THE ARITHMETIC WAS RIGHT ALL ALONG. Read with `private.parse_price`, all 22 prices parse
-- (0 refusals), and sum(quantity x unit_price) = 20720.7000 = sum(line_total) = 20720.70 against
-- a header net of 20720.80 -- a 0.10 gap, inside the ₪1 document tolerance. The document that
-- could not be approved was arithmetically consistent to ten agorot.
--
-- WHY THE PARSER ALREADY EXISTED. `0298` is titled "one parser for a price". It was written for
-- exactly this class of defect, its own header names it ("`$12.50` reaches `::numeric` as `$12.50`
-- and dies as an unreadable row"), and `private.parse_price` knows `ש"ח`, `ש״ח`, `שח`, `ש.ח`,
-- the symbols, the ISO codes, accounting negatives and the three-digit comma rule. `0298` rewired
-- the three PRICE-LIST writers. The DOCUMENT line reader was not in that wave and kept the old
-- refusal. This file finishes that job on the one caller it missed.
--
-- WHAT IS DELIBERATELY *NOT* WIDENED. Only `unit_price` moves to `parse_price`. `line_total`,
-- `discount_amount`, `vat_rate` and `package_size` stay on `interpretation_number`, because
-- `parse_price` also carries PRICE-LIST POLICY -- it refuses zero, negatives and anything over
-- 1,000,000 -- and a credit note's negative line total is not this file's decision to make. The
-- unit price is the field the finding names and the only field that moves.
--
-- WHAT A REFUSAL NOW COSTS. `parse_price` returns `{ok, value, reason}` and never raises (0298
-- kept per-row rejection deliberately). Where it refuses, `unit_price` is still NULL exactly as
-- today -- but it is no longer SILENT: the reason travels on the line as `unit_price_refusal`, the
-- line gets a finding that names the field, and the document sum reports itself unmeasured
-- instead of reporting zero. A price printed in another currency, or above the cap, was already
-- NULL before this file; the change is that it is now said out loud.
--
-- ---------------------------------------------------------------------------------------------
-- ANCESTRY -- READ FROM THE LIVE DATABASE, NOT FROM THE CREATING MIGRATION.
--
-- Printed with `pg_get_functiondef` against production on 05.09.2026:
--
--   private.document_assessment_lines(uuid,uuid,jsonb)
--     md5(prosrc) ce4ee29aaea1c17394a2c21baa0cef97 · SECURITY INVOKER · search_path public,pg_temp
--   private.document_reconciliation_assessment(uuid,text,uuid,uuid,jsonb,date)
--     md5(prosrc) 9a61fcd1f0857e71256e3e1023d79c89 · length 29591 · SECURITY INVOKER
--     ITS ANCESTOR IS NOT 0108. `0108` created it; `0227`, `0244`, `0260` and `0284` have each
--     patched the LIVE body since, and NONE of them re-declares it -- every one is an anchored
--     `replace()` of `pg_get_functiondef`. Re-declaring from 0108 would silently delete the
--     evidence currency, the tolerance ladder, the published rungs and the order remainder.
--   public.apply_document_interpretation(uuid,uuid,uuid)
--     md5(prosrc) 19576ead87002f8fea59010332c7dfa0 · **SECURITY DEFINER** · search_path public,pg_temp
--
-- Every anchor below was verified to occur EXACTLY ONCE in the live body it targets before this
-- file was written, and each patch re-asserts that count at apply time. Every definition is read
-- as `replace(pg_get_functiondef(...), e'\r', '')`: a body applied from Windows carries CRLF and
-- one applied on a CI runner does not, and `check:anchored-replacements` exists because the
-- 0171-0205 rollout aborted at 0181 over exactly that.

-- ===== 1. The document line reader learns the currency the supplier prints =====
do $patch_lines_0324$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
begin
  if to_regprocedure('private.document_assessment_lines(uuid, uuid, jsonb)') is null then
    raise exception '0324: private.document_assessment_lines is absent';
  end if;
  if to_regprocedure('private.parse_price(text, text)') is null then
    raise exception '0324: private.parse_price is absent -- 0298 has not been applied';
  end if;
  if to_regprocedure('private.resolve_document_currency(uuid, uuid, jsonb)') is null then
    raise exception '0324: private.resolve_document_currency is absent';
  end if;

  select replace(pg_get_functiondef(
      'private.document_assessment_lines(uuid,uuid,jsonb)'::regprocedure), e'\r', '')
    into v_definition;

  -- --- (a) two locals: the document's currency, and the parser's verdict for one line ---
  v_anchor := $a$  v_out jsonb := '[]'::jsonb;$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the line-reader declare anchor moved';
  end if;
  v_replacement := $a$  v_currency text;
  v_price jsonb;
$a$ || v_anchor;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- --- (b) resolve the currency ONCE, by the same reader the assessment uses (0227) ---
  -- `parse_price` refuses to read a number whose currency nobody named, and it is right to: a
  -- number without a unit is the failure the whole 0298 wave exists to end. Resolved outside the
  -- loop because it is a property of the document, not of a line.
  v_anchor := $a$  if jsonb_typeof(p_payload -> 'line_items') <> 'array' then
    return v_out;
  end if;$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the line-reader guard anchor moved';
  end if;
  v_replacement := v_anchor || $a$

  v_currency := private.resolve_document_currency(p_org_id, p_supplier_id, p_payload)
                  ->> 'currency';$a$;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- --- (c) read the printed price with the product's one price parser ---
  v_anchor := $a$    v_quantity := private.interpretation_number(v_values -> 'quantity');$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the quantity-read anchor moved';
  end if;
  v_replacement := $a$    -- ONE PARSER FOR A PRICE (0298). `interpretation_number` strips a space, a comma, a `₪`
    -- and the bidi marks and then demands a bare number, so `4.20 ש"ח` -- what the OCR adapter
    -- actually transcribes off a Hebrew invoice -- came back NULL on every line of both documents
    -- the sweep photographed. `parse_price` knows the printed currency word. It never raises: a
    -- refusal is a NULL price with a reason attached, and the reason travels on the line.
    v_price := private.parse_price(v_values ->> 'unit_price', v_currency);

$a$ || v_anchor;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- --- (d) the value only when the parser said `ok`, and the refusal beside it ---
  v_anchor := $a$      'unit_price', private.interpretation_number(v_values -> 'unit_price'),$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the unit-price anchor moved';
  end if;
  -- `price_not_positive`, `price_below_minor_unit` and `price_above_cap` carry a parsed `value`
  -- back with the refusal. It is NOT taken: a document line priced at zero, at minus five, or at
  -- eight figures is not a price this reader will assert on a financial record. It is named.
  -- `unit_price_printed` is what the document actually says, kept verbatim beside the refusal so
  -- a screen can show the person the cell it could not read rather than an empty apology.
  v_replacement := $a$      'unit_price', case when (v_price ->> 'ok')::boolean
                         then (v_price ->> 'value')::numeric end,
      'unit_price_refusal', v_price ->> 'reason',
      'unit_price_printed', nullif(btrim(v_values ->> 'unit_price'), ''),$a$;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end
$patch_lines_0324$;

-- ===== 2. The sum says when it could not be measured =====
do $patch_assessment_0324$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
begin
  if to_regprocedure(
       'private.document_reconciliation_assessment(uuid, text, uuid, uuid, jsonb, date)') is null then
    raise exception '0324: private.document_reconciliation_assessment is absent';
  end if;

  select replace(pg_get_functiondef(
      'private.document_reconciliation_assessment(uuid,text,uuid,uuid,jsonb,date)'::regprocedure),
      e'\r', '')
    into v_definition;

  -- --- (a) the counter, declared beside the accumulator it qualifies ---
  v_anchor := $a$  v_lines_net numeric := 0;$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the assessment declare anchor moved';
  end if;
  v_replacement := v_anchor || $a$
  v_lines_counted integer := 0;$a$;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- --- (b) count what the sum actually covered ---
  v_anchor := $a$      v_lines_net := v_lines_net + v_line_total;$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the accumulator anchor moved';
  end if;
  v_replacement := v_anchor || $a$
      v_lines_counted := v_lines_counted + 1;$a$;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- --- (c) and say, per line, which field kept it out of the sum ---
  -- A quantity that cannot be read already has `quantity_unreadable` two branches below, and it
  -- already blocks. The unit price had NOTHING: the line was skipped in silence and the only
  -- thing that spoke was a header comparison against a sum nobody measured. `line_total` had
  -- nothing either. Both are named here, and the price is named twice over -- absent is not the
  -- same fact as printed-and-unreadable, and 0298 paid for one code covering five failures.
  v_anchor := $a$      v_lines_discount := v_lines_discount
        + coalesce((v_line ->> 'discount_amount')::numeric, 0);
    end if;$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the discount accumulator anchor moved';
  end if;
  v_replacement := $a$      v_lines_discount := v_lines_discount
        + coalesce((v_line ->> 'discount_amount')::numeric, 0);
    else
      if v_unit_price is null then
        v_blocked := true;
        if coalesce(v_line ->> 'unit_price_refusal', 'price_missing') = 'price_missing' then
          v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
            'code', 'line_unit_price_missing', 'severity', 'error',
            'message', 'לא הודפס מחיר ליחידה בשורה הזו — בלעדיו אי אפשר לסכם את השורות'));
        else
          v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
            'code', 'line_unit_price_unreadable', 'severity', 'error',
            'reason', v_line ->> 'unit_price_refusal',
            'printed', v_line ->> 'unit_price_printed',
            'message', 'המחיר ליחידה מודפס בשורה אך לא ניתן לקרוא אותו כסכום במטבע המסמך'));
        end if;
      end if;
      if v_line_total is null then
        v_blocked := true;
        v_line_findings := v_line_findings || jsonb_build_array(jsonb_build_object(
          'code', 'line_total_missing', 'severity', 'error',
          'message', 'לא נקרא סכום לשורה הזו — בלעדיו אי אפשר לסכם את השורות'));
      end if;
    end if;$a$;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- --- (d) the header is compared ONLY against a sum that covered every line ---
  -- This is the whole of DOC-03. `abs(0 - 20720.80) > 1` is arithmetic on a number that was never
  -- measured, and it reached a person as "the header disagrees with the lines". A partial sum
  -- would be no better: comparing 21 lines to a 22-line header finds a mismatch every time and
  -- blames the supplier for our own reading. When coverage is incomplete the document says so
  -- and names the count, and the comparison does not run at all.
  v_anchor := $a$  if v_document_tolerance is not null and v_header_net is not null
     and jsonb_array_length(v_line_rows) > 0
     and abs(v_lines_net - v_header_net) > v_document_tolerance then$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the header-vs-lines anchor moved';
  end if;
  v_replacement := $a$  if jsonb_array_length(v_line_rows) > 0
     and v_lines_counted < jsonb_array_length(v_line_rows) then
    v_blocked := true;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'code', 'lines_total_not_measured', 'severity', 'error',
      'lines_total_count', jsonb_array_length(v_line_rows),
      'lines_counted', v_lines_counted,
      'lines_skipped', jsonb_array_length(v_line_rows) - v_lines_counted,
      'message', 'לא ניתן לחשב את סכום השורות — בחלק מהשורות חסר מחיר ליחידה, כמות או סכום שורה'));
  end if;

  if v_document_tolerance is not null and v_header_net is not null
     and jsonb_array_length(v_line_rows) > 0
     and v_lines_counted = jsonb_array_length(v_line_rows)
     and abs(v_lines_net - v_header_net) > v_document_tolerance then$a$;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- --- (e) `lines_net` is `—`, not `0`, when the sum did not cover the document ---
  v_anchor := $a$      'lines_net', case when jsonb_array_length(v_line_rows) > 0
                        then round(v_lines_net, v_minor_units) else null end,$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the lines_net total anchor moved';
  end if;
  v_replacement := $a$      'lines_net', case when jsonb_array_length(v_line_rows) > 0
                          and v_lines_counted = jsonb_array_length(v_line_rows)
                        then round(v_lines_net, v_minor_units) else null end,
      'lines_counted', v_lines_counted,$a$;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- --- (f) the discount is the same accumulator and inherits the same coverage ---
  v_anchor := $a$      'lines_discount', case when jsonb_array_length(v_line_rows) > 0
                              then round(v_lines_discount, v_minor_units) else null end,$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the lines_discount total anchor moved';
  end if;
  v_replacement := $a$      'lines_discount', case when jsonb_array_length(v_line_rows) > 0
                                   and v_lines_counted = jsonb_array_length(v_line_rows)
                              then round(v_lines_discount, v_minor_units) else null end,$a$;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- --- (g) and so does the gap, which is a subtraction involving that same sum ---
  v_anchor := $a$      'lines_vs_header_gap', case when jsonb_array_length(v_line_rows) > 0
                                     and v_header_net is not null
                                  then round(v_lines_net - v_header_net, v_minor_units)
                                  else null end,$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the lines-vs-header gap anchor moved';
  end if;
  v_replacement := $a$      'lines_vs_header_gap', case when jsonb_array_length(v_line_rows) > 0
                                     and v_lines_counted = jsonb_array_length(v_line_rows)
                                     and v_header_net is not null
                                  then round(v_lines_net - v_header_net, v_minor_units)
                                  else null end,$a$;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- --- (h) the ladder 0260 published finally names this rung when it is missing ---
  -- It reported `lines_net` missing only at ZERO rows. On production it said `missing_rungs: []`
  -- while `lines_net` was a fiction over 22 skipped lines: the one structure whose entire purpose
  -- is to say which number could not be read said that all of them could.
  v_anchor := $a$          select 'lines_net' as rung where jsonb_array_length(v_line_rows) = 0$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the missing-rungs anchor moved';
  end if;
  v_replacement := $a$          select 'lines_net' as rung
          where jsonb_array_length(v_line_rows) = 0
             or v_lines_counted < jsonb_array_length(v_line_rows)$a$;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end
$patch_assessment_0324$;

-- ===== 3. The refusal names the field that is actually missing (DOC-02) =====
--
-- MEASURED, not inferred. On `א.ע עלים ירוקים — חשבונית 2026-08.jpeg` the machine filing carries
-- `reason_code = 'invoice_identity_missing'`, whose one sentence is
-- „חסרים מספר חשבונית או תאריך" -- "the invoice number or the date is missing". On that document:
--
--     invoice_number  "SI266001312"  confidence 0.95  ->  v_number = 'SI266001312'   PRESENT
--     invoice_date    "31/07/26"     confidence 0.99  ->  v_date   = NULL            MISSING
--
-- The number is not missing. It is on the screen, extracted, marked confidently read -- and the
-- sentence beside it says it is absent. One code covering two obstacles means the screen can only
-- name both, so it names one that is not there, and the reader has no way to tell which half is
-- real. Three arms instead of one; the conjoined sentence survives for the case where BOTH are
-- genuinely absent, which is the only case it was ever true for.
--
-- WHAT THIS ARM DOES *NOT* DO, and it is a separate finding recorded rather than fixed here:
-- `private.interpretation_date` refuses `31/07/26` because the year has two digits. `DOC-05`
-- already committed this product to reading a two-digit year as `20yy` -- on the CLIENT, in
-- `normalizeInvoiceDate`. The server has not been told. Teaching it would let this document
-- AUTO-FILE, which is a change to what the machine may write without a person, and that is not
-- DOC-02's oracle and not this file's call to make. DOC-02 asks the sentence to name an obstacle
-- that is actually present. After this arm it does: the date genuinely cannot be read.
do $patch_filing_reason_0324$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
begin
  if to_regprocedure('public.apply_document_interpretation(uuid, uuid, uuid)') is null then
    raise exception '0324: public.apply_document_interpretation is absent';
  end if;

  select replace(pg_get_functiondef(
      'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure), e'\r', '')
    into v_definition;

  v_anchor := $a$  elsif v_number is null or v_date is null then
    v_outcome := 'queued_for_review'; v_reason_code := 'invoice_identity_missing';$a$;
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0324: the identity-missing ladder anchor moved';
  end if;
  v_replacement := $a$  elsif v_number is null and v_date is null then
    v_outcome := 'queued_for_review'; v_reason_code := 'invoice_identity_missing';
  elsif v_number is null then
    v_outcome := 'queued_for_review'; v_reason_code := 'invoice_number_missing';
  elsif v_date is null then
    v_outcome := 'queued_for_review'; v_reason_code := 'invoice_date_missing';$a$;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end
$patch_filing_reason_0324$;

-- ===== 4. The contracts landed, and the security properties did not move =====
do $assert_0324$
declare
  v_lines text;
  v_assessment text;
  v_apply text;
  v_violations text;
begin
  select replace(pg_get_functiondef(
      'private.document_assessment_lines(uuid,uuid,jsonb)'::regprocedure), e'\r', '')
    into v_lines;
  select replace(pg_get_functiondef(
      'private.document_reconciliation_assessment(uuid,text,uuid,uuid,jsonb,date)'::regprocedure),
      e'\r', '') into v_assessment;
  select replace(pg_get_functiondef(
      'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure), e'\r', '')
    into v_apply;

  -- The line reader reads the price through the one parser, and no longer through the old one.
  if position('private.parse_price(v_values ->> ''unit_price'', v_currency)' in v_lines) = 0 then
    raise exception '0324: the line reader does not call parse_price';
  end if;
  if position('''unit_price_printed'', nullif(btrim(v_values ->> ''unit_price''), '''')' in v_lines) = 0 then
    raise exception '0324: the printed price is not carried beside the refusal';
  end if;
  if position('''unit_price'', private.interpretation_number' in v_lines) <> 0 then
    raise exception '0324: the old unit-price reader is still in the line reader';
  end if;
  -- ...and the OTHER money fields deliberately still do. A guard on what did NOT change.
  if position('''line_total'', private.interpretation_number' in v_lines) = 0 then
    raise exception '0324: line_total must stay on interpretation_number';
  end if;

  -- The sum reports its own coverage in all four places that publish it.
  if position('v_lines_counted := v_lines_counted + 1;' in v_assessment) = 0
     or position('''lines_counted'', v_lines_counted,' in v_assessment) = 0
     or position('''lines_total_not_measured''' in v_assessment) = 0
     or position('''line_unit_price_missing''' in v_assessment) = 0
     or position('''line_unit_price_unreadable''' in v_assessment) = 0
     or position('''line_total_missing''' in v_assessment) = 0 then
    raise exception '0324: the assessment coverage patch did not land';
  end if;
  -- The header comparison may never again run over a partial sum.
  if position('and v_lines_counted = jsonb_array_length(v_line_rows)
     and abs(v_lines_net - v_header_net) > v_document_tolerance' in v_assessment) = 0 then
    raise exception '0324: the header comparison is not gated on coverage';
  end if;

  -- The three arms exist and the conjoined one still covers the case it was true for.
  if position('''invoice_number_missing''' in v_apply) = 0
     or position('''invoice_date_missing''' in v_apply) = 0
     or position('v_number is null and v_date is null' in v_apply) = 0 then
    raise exception '0324: the filing-reason ladder did not split';
  end if;

  -- NEITHER PRIVATE READER MAY BECOME A DEFINER. They read one tenant's payload under the
  -- caller's own context, and 0284 asserts the same thing about its own reader for the same
  -- reason: only the caller's context may decide whether that read is allowed.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.prosecdef
      and p.proname in ('document_assessment_lines', 'document_reconciliation_assessment')) then
    raise exception '0324: a private document reader became SECURITY DEFINER';
  end if;
  -- And the definer command must stay one. `create or replace` keeps prosecdef, but an assertion
  -- costs nothing and a silently-invoker apply command would run as whoever called it.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_document_interpretation' and p.prosecdef) then
    raise exception '0324: apply_document_interpretation stopped being SECURITY DEFINER';
  end if;
  -- EXECUTE on the private readers stays revoked from every client role.
  if has_function_privilege('authenticated',
       'private.document_assessment_lines(uuid, uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('anon',
       'private.document_assessment_lines(uuid, uuid, jsonb)', 'EXECUTE') then
    raise exception '0324: a client role can execute the document line reader';
  end if;

  -- 0058:207-218: a migration that touches a definer, or a definer's callee, proves the scope
  -- contract HERE rather than three hours later in the gate. This file replaces the body of a
  -- SECURITY DEFINER command and of two functions a second definer calls, so it re-runs the whole
  -- A1/A3/A5 assertion set rather than reasoning that nothing it changed could have moved them.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0324 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0324$;

comment on function private.document_assessment_lines(uuid, uuid, jsonb) is
  'Reads one interpretation payload''s line items into the shape the assessment and '
  '`apply_reviewed_document` both consume. The UNIT PRICE is read by `private.parse_price` (0298, '
  'rewired here by 0324) against the currency `resolve_document_currency` gives the document, so a '
  'price printed as `4.20 ש"ח` is a price; every other money field stays on '
  '`interpretation_number`, because `parse_price` also carries price-list policy (no zero, no '
  'negative, a 1,000,000 cap) that a credit note''s line total must not inherit. A refused price '
  'is NULL with its reason on `unit_price_refusal` -- never silently absent.';
