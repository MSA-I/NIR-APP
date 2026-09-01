-- 0276 — the due date the model already read stops being thrown away.
--
-- `0264` (PR-22) gave `invoices` a `due_date` and gave a person a field to type it into. This is
-- the other half of owner ruling ש-9: the document says when it wants to be paid, and the product
-- reads it instead of asking someone to re-key what is printed on the page.
--
-- THE EXTRACTION ALREADY EXISTED. `due_date` has been in `REVIEW_FIELD_KEYS`
-- (`interpret-document/core.ts:596-601`) since the review keys were introduced: the model is
-- already asked for it, it is already stored on the interpretation, and the review screen already
-- shows it. Nothing consumed it, so it was displayed and dropped. That is why this file touches no
-- Edge function, no prompt and no `worker/ocr` -- and therefore carries no gateway contract bump
-- and no VPS redeploy. The plan had assumed the extraction was missing; it was the consumption.
--
-- WHY `due_date` STAYS A REVIEW KEY AND DOES NOT JOIN `CANONICAL_FIELD_KEYS`. The comment above
-- that list says a key becomes canonical when it is consumed "while writing a financial record",
-- which this migration now does -- but the bijection `core.test.ts` enforces is against the
-- `private.interpretation_field` call sites in `0077` ALONE, and a due date decides nothing there:
-- `0077` chooses whether to auto-apply, and no payment date has any bearing on that. Adding it to
-- the canonical list without a matching `0077` site fails the bijection; adding a site to `0077`
-- would claim the decision layer reads a field it does not.
--
-- `currency` is the precedent and it is exact: it sits in `REVIEW_FIELD_KEYS`, it is consumed by
-- this very command, and it is written onto the invoice row -- through a resolver rather than a
-- `0077` call site. This follows that shape deliberately rather than inventing a third one.
--
-- AND THE RULE THAT MATTERS MOST: A DATE NOBODY STATED IS UNKNOWN. `suppliers.payment_terms` is
-- free text that nothing parses, and `alerts.ts:145-148` already tells the user so. Deriving
-- "net 30" into a real date would manufacture a debt with a deadline the document never carried,
-- and the scheduled-payments card would then report it as money leaving on a day nobody agreed to.
-- Unparseable, absent, or out of range all land on NULL, which the card already knows how to say.

-- ===== 1. One reader, so the rule lives in one place =====
create or replace function private.interpretation_due_date(p_payload jsonb)
returns date
language plpgsql
immutable
as $$
declare
  v_raw  text;
  v_date date;
begin
  -- The alias list, in preference order, matching how `private.interpretation_field` is called
  -- everywhere else. The Hebrew spellings are what actually appears on invoices here; the English
  -- key is what the model is asked for by name.
  v_raw := private.interpretation_field(
    p_payload,
    array['due_date', 'תאריך לתשלום', 'לתשלום עד', 'מועד תשלום', 'תאריך פירעון']) #>> '{}';

  if nullif(btrim(coalesce(v_raw, '')), '') is null then
    return null;
  end if;

  -- STRICT, AND SILENT ON FAILURE. The model returns a string; `::date` on a value it did not
  -- format as a date raises, and an exception here would abort applying an otherwise good document
  -- over a field nobody is required to provide. A date we cannot read is a date we do not have.
  begin
    v_date := btrim(v_raw)::date;
  exception when others then
    return null;
  end;

  -- A BOUNDED WINDOW, because a misread year is the failure mode this field actually has. `2027`
  -- transcribed as `1027` or `2207` would otherwise be stored as a real due date and would move a
  -- payment horizon by centuries. The bound is deliberately wide -- it rejects impossible dates,
  -- not unusual ones -- and anything outside it is treated exactly like an unreadable date.
  if v_date < date '2000-01-01' or v_date > (current_date + interval '10 years')::date then
    return null;
  end if;

  return v_date;
end
$$;

revoke all on function private.interpretation_due_date(jsonb)
  from public, anon, authenticated, service_role;

comment on function private.interpretation_due_date(jsonb) is
  'The payment due date a document actually stated, or NULL (0276). Reads the same '
  '`due_date` review key the model has been emitting all along, parses it strictly, and refuses '
  'anything outside a wide sanity window because a misread year would move a payment horizon by '
  'centuries. It never looks at suppliers.payment_terms: deriving a date from free text would '
  'manufacture a deadline the document never carried.';

-- ===== 2. The anchored patch =====
-- Two short anchors rather than one long one: the block between them contains a Hebrew string
-- literal, and an anchor carrying it would be a byte-for-byte dependency on text that has nothing
-- to do with what is being changed.
do $due_date_patch$
declare
  v_sig       text := 'public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)';
  v_def       text;
  v_columns   text := '      currency' || chr(10) || '    ) values (';
  v_columns_p text := '      currency, due_date' || chr(10) || '    ) values (';
  v_values    text := '      v_document.unit_id, v_currency);';
  v_values_p  text := '      v_document.unit_id, v_currency,' || chr(10)
                      || '      private.interpretation_due_date(v_interpretation.payload));';
  v_count     int;
begin
  -- `chr(13)` rather than a carriage return typed into the literal: git's line-ending
  -- normalisation rewrites that byte, and a strip that has been rewritten returns the body
  -- unchanged while still looking like a strip. `0267` learned this the same way.
  v_def := replace(pg_get_functiondef(v_sig::regprocedure), chr(13), '');

  if position('interpretation_due_date' in v_def) > 0 then
    raise exception '0276: % already reads a due date -- refusing to patch it twice', v_sig;
  end if;

  -- Each anchor exactly once, checked before either replacement runs. A body that grew a second
  -- invoice insert is a body this migration does not understand, and patching the wrong one would
  -- put a due date on a row it was never meant for.
  v_count := (length(v_def) - length(replace(v_def, v_columns, ''))) / length(v_columns);
  if v_count <> 1 then
    raise exception '0276: the column anchor appears % times in %, not once', v_count, v_sig;
  end if;
  v_count := (length(v_def) - length(replace(v_def, v_values, ''))) / length(v_values);
  if v_count <> 1 then
    raise exception '0276: the values anchor appears % times in %, not once', v_count, v_sig;
  end if;

  execute replace(replace(v_def, v_columns, v_columns_p), v_values, v_values_p);
end
$due_date_patch$;

-- ===== 3. Re-pin the body hash the patch just invalidated =====
-- `private.scope_definer_enforcements` stores the md5 of the body it was reviewed against, so ANY
-- rewrite of a definer function -- including this one -- leaves the registration stale and the
-- scope assertions refuse the migration. That is the guard working: it is how a body that quietly
-- lost its tenant fence gets caught, and re-pinning is the deliberate act of saying the new body
-- was looked at.
--
-- `enforcement_kind` and the fences do NOT change here. This patch adds one column to an INSERT
-- and one call to a pure reader; it touches no predicate, no role check and no scope filter, and
-- the verify block below asserts the three fences the command argues hardest for are still in the
-- body it just rewrote.
update private.scope_definer_enforcements
   set body_hash = (
         select md5(replace(p.prosrc, chr(13), ''))
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'apply_reviewed_document'),
       scope_proof = scope_proof
         || ' 0276 adds the stated due date to the invoice row through a pure reader; it changes '
         || 'no tenant, role, document or unit fence.'
 where function_signature = 'apply_reviewed_document(uuid,uuid,jsonb,uuid,text)';

-- AND THE SECOND REGISTRY, WHICH IS NOT THE SAME ONE. This schema pins definer bodies in TWO
-- places and they answer different questions:
--
--   `scope_definer_enforcements`                     -- does this body still enforce tenancy?
--   `document_automation_authoritative_functions`    -- is this body still the machine-writing
--                                                       path §245/§251/§252 reviewed?
--
-- Re-pinning only the first leaves `document_automation_negative_guard_violations()` reporting
-- `authoritative_body_drift`, which is how `p14` and `p68` caught this. Both are deliberate acts
-- and both belong in the migration that rewrote the body.
--
-- `expected_callees` is NOT touched. The guard asserts each registered callee is still present, so
-- adding a call cannot satisfy it falsely; the sanitizer, the evidence writer and the comparison
-- key this command must keep calling are all still named there and still checked.
update private.document_automation_authoritative_functions
   set body_hash = (
         select md5(replace(p.prosrc, chr(13), ''))
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'apply_reviewed_document')
 where function_signature = 'apply_reviewed_document(uuid,uuid,jsonb,uuid,text)';

-- ===== Proof =====
do $verify_0276$
declare
  v_def        text;
  v_violations text;
  v_payload    jsonb;
begin
  v_def := replace(
    pg_get_functiondef(
      'public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)'::regprocedure), chr(13), '');

  if (length(v_def) - length(replace(v_def, 'interpretation_due_date', '')))
     / length('interpretation_due_date') <> 1 then
    raise exception '0276: the due-date read is not present exactly once';
  end if;

  -- THE REST OF THE COMMAND DID NOT MOVE. An anchored replacement rewrites a whole body, so the
  -- risk is not that the patch fails -- it is that it succeeds while something else silently
  -- reverts to an older shape. These three are the properties `0110` and `0172` argue hardest for.
  if position('document_review_order_invalid' in v_def) = 0
     or position('''received''::invoice_review_status' in v_def) = 0
     or position('p_idempotency_key' in v_def) = 0 then
    raise exception '0276: the patch lost a guarantee the command had before it';
  end if;

  -- A stated date is read.
  v_payload := jsonb_build_object('fields',
    jsonb_build_array(jsonb_build_object('key', 'due_date', 'value', '2027-03-15')));
  if private.interpretation_due_date(v_payload) is distinct from date '2027-03-15' then
    raise exception '0276: a stated due date was not read back';
  end if;

  -- A Hebrew alias is read.
  v_payload := jsonb_build_object('fields',
    jsonb_build_array(jsonb_build_object('key', 'לתשלום עד', 'value', '2027-04-01')));
  if private.interpretation_due_date(v_payload) is distinct from date '2027-04-01' then
    raise exception '0276: the Hebrew alias was not read';
  end if;

  -- Nonsense is NULL rather than an error, and rather than a guess.
  v_payload := jsonb_build_object('fields',
    jsonb_build_array(jsonb_build_object('key', 'due_date', 'value', 'שוטף + 30')));
  if private.interpretation_due_date(v_payload) is not null then
    raise exception '0276: free text was turned into a date';
  end if;

  -- A misread year is refused rather than stored.
  v_payload := jsonb_build_object('fields',
    jsonb_build_array(jsonb_build_object('key', 'due_date', 'value', '1027-03-15')));
  if private.interpretation_due_date(v_payload) is not null then
    raise exception '0276: a date outside the sanity window was accepted';
  end if;

  -- And no client role can reach the reader.
  if has_function_privilege('authenticated', 'private.interpretation_due_date(jsonb)', 'execute')
     or has_function_privilege('anon', 'private.interpretation_due_date(jsonb)', 'execute') then
    raise exception '0276: a client role can execute the due-date reader';
  end if;

  -- BOTH registries, asserted here rather than left to a suite. Re-pinning one and forgetting the
  -- other is exactly the mistake this file made on its first run, and CI found it in `p14` and
  -- `p68` -- two suites away from the migration that caused it.
  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.document_automation_negative_guard_violations();
  if v_violations is not null then
    raise exception '0276 document-automation guards failed:%', chr(10) || v_violations;
  end if;

  select string_agg(detail, chr(10) order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0276 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$verify_0276$;
