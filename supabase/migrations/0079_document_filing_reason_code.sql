-- The reason a document is waiting becomes a column, so the screen can say it out loud.
--
-- WHAT THIS COSTS TODAY, measured rather than imagined. The owner turned autonomy on, uploaded a
-- document, and the screen said "ממתין להכרעה" and nothing else. Finding out why took a query
-- against production and a read of 0077's decision ladder: the document was a `payment_confirmation`
-- and the ladder had stopped at `not_an_invoice`. That answer existed the whole time -- as a
-- plpgsql local, as a key in the JSONB the command returns, and as a line in the Edge Function's
-- console.log -- and in none of those places can a person or a screen reach it.
--
-- DEBT-REGISTER §19 wrote this down as a hazard the morning of the same day, and named the fix:
-- "עמודת `reason_code` על `document_filings`, או שורת audit גם ל-queued". This is the first of
-- those. The second was not chosen because `queued_for_review` is the ordinary outcome, and an
-- audit row per ordinary outcome turns the reasoned-action log into a firehose.
--
-- CONSEQUENCE WORTH NAMING: `auto_applied` stores NULL here, and that is not "unknown" -- it is
-- "nothing stopped it". A NULL on a queued row means the row predates this column; there are two
-- such rows in production and they are NOT backfilled, because the reason was never recorded and
-- inventing one would be exactly the fabrication the constitution forbids.

-- ===== 1. The column =====
alter table public.document_filings
  add column if not exists reason_code text;

comment on column public.document_filings.reason_code is
  'Which arm of apply_document_interpretation''s ladder decided this filing (0077). NULL on an '
  'auto_applied row means nothing stopped it; NULL on a queued row means the row predates this '
  'column. Written only by apply_document_interpretation -- no client, no trigger.';

-- No CHECK against a fixed list on purpose: the ladder in 0077 is the single writer, adding an arm
-- there is already a migration, and a second enumeration here would be a second place to forget.

-- ===== 2. Inject into the LIVE body =====
-- INJECTION, NOT RE-DECLARATION. apply_document_interpretation is ~350 lines and its correctness
-- lives in the ladder; re-typing it to add one column is how a wave silently reverts an arm. The
-- same mistake was made one migration ago, in 0078's first draft, against a much smaller function
-- and caught only by a suite -- so this one is written the way the repo's own precedent demands:
-- take pg_get_functiondef of what is actually running, change two named anchors, refuse loudly if
-- either anchor is missing, and execute the result.
do $$
declare
  v_def  text;
  v_next text;
  v_cols_from constant text :=
    'org_id, document_id, category, supplier_id, interpretation_id, confidence, decided_by';
  v_cols_to constant text :=
    'org_id, document_id, category, supplier_id, interpretation_id, confidence, decided_by, reason_code';
  v_vals_from constant text :=
    'v_org, v_doc.id, v_type, v_supplier_id, v_i.id, v_decision_conf, ''system''';
  v_vals_to constant text :=
    'v_org, v_doc.id, v_type, v_supplier_id, v_i.id, v_decision_conf, ''system'', v_reason_code';
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'apply_document_interpretation';

  if v_def is null then
    raise exception '0079: apply_document_interpretation is not installed';
  end if;

  -- Each anchor must appear EXACTLY once. "At least once" would let a future body with two
  -- filing inserts get one of them rewritten and the other left behind.
  if (length(v_def) - length(replace(v_def, v_cols_from, ''))) / length(v_cols_from) <> 1 then
    raise exception '0079: the filing column list is not present exactly once -- 0077''s body changed, re-derive the anchor';
  end if;
  if (length(v_def) - length(replace(v_def, v_vals_from, ''))) / length(v_vals_from) <> 1 then
    raise exception '0079: the filing values list is not present exactly once -- 0077''s body changed, re-derive the anchor';
  end if;

  v_next := replace(replace(v_def, v_cols_from, v_cols_to), v_vals_from, v_vals_to);
  if v_next = v_def then
    raise exception '0079: injection produced an identical body';
  end if;
  execute v_next;
end
$$;

-- ===== 3. Prove the injection took, and that it did not disturb the ladder =====
do $$
declare
  v_src text;
begin
  select prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'apply_document_interpretation';

  if v_src not like '%''system'', v_reason_code%' then
    raise exception '0079: the filing insert does not carry reason_code after injection';
  end if;
  -- The arms that matter most, re-asserted by name: an injection that ate one of these would
  -- change which documents a machine may write, and would do it silently.
  if v_src not like '%not_an_invoice%'
     or v_src not like '%autonomy_disabled%'
     or v_src not like '%supplier_unidentified%'
     or v_src not like '%below_confidence_threshold%'
     or v_src not like '%duplicate_invoice_number%'
     or v_src not like '%document_type_other%' then
    raise exception '0079: a decision arm went missing during injection';
  end if;
  -- Off still means zero: the disabled arm must still queue rather than archive.
  if v_src not like '%v_outcome := ''queued_for_review''; v_reason_code := ''autonomy_disabled''%' then
    raise exception '0079: the autonomy_disabled arm no longer queues';
  end if;
end
$$;

-- ===== 4. Re-assert (the 0058:207-218 idiom, literal 0079) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0079 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
