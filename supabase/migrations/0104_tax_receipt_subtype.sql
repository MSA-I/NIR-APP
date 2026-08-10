-- 0104 -- A receipt gets a name of its own.
--
-- WHAT THIS COSTS TODAY, measured rather than imagined. DEBT-REGISTER §28: the owner reported
-- "חשבונית וקבלה" photographed and not processed on 09.08.2026. The invoices and delivery notes
-- were handled; the receipt was not, and still is not. It lands as `payment_confirmation`, where
-- `apply_document_interpretation` stops it at `not_an_invoice` (0077:976) and nothing else ever
-- looks at it. The register's own "next cheap step" was to ask the owner what a receipt should do
-- by itself. Asked and answered, 10.08.2026: **evidence only -- link it to an invoice or a
-- recorded payment that already exists, never create a payable from it.** (OPEN-DECISIONS #141.)
--
-- WHY A NEW VALUE RATHER THAN REUSING `payment_confirmation`. They are different documents and
-- the difference is the whole point. `payment_confirmation` is OUR side of a transfer -- the bank
-- confirmation the payer files against a payment they executed, which is why FileUpload defaults
-- entity_type='payment' to it (FileUpload.tsx:183). A tax receipt is the SUPPLIER's document,
-- arriving from outside, and evidence about an invoice or a payment rather than about a transfer
-- we made. Overloading one onto the other would make "which of these two things is this row"
-- unanswerable for every historical document, in both directions, forever. Overloading `invoice`
-- would be worse still: a receipt that reads as an invoice is a duplicate payable.
--
-- WHAT THIS MIGRATION DOES NOT DO. It adds a value to a domain. It does not give the value any
-- automatic behaviour: a `tax_receipt` still stops before every financial effect and waits for a
-- human, exactly as it does today. The linking rules land in their own migration, with their own
-- tests, because "the system can now say what this document is" and "the system now acts on it"
-- are two claims and they should not be able to pass on one set of evidence.
--
-- THE SHAPE OF THE CHANGE. The domain is spelled out in eleven places -- six CHECK constraints
-- and five function bodies. 0075:220-226 already counted five of them and called a sixth "the
-- convention, not new duplication". That was a defensible call for one column; it is also why a
-- single new value is an eleven-site edit. The count is recorded here so the next person adding a
-- value knows the price before they start, and so the SQL suite can assert it did not grow.

-- ===== 1. The six CHECK constraints =====
--
-- Two spellings of the same domain exist and both are load-bearing, so neither is "fixed" here:
--
--   * `documents.document_kind` says `credit`      (0019:13, re-declared 0045:33)
--   * the interpretation contract says `credit_note` (0046:47 and everything downstream)
--
-- 0084:14-17 is the bridge that translates one to the other on the way in. Unifying them is a
-- data migration over every historical `documents` row and it is not what this change is about;
-- widening a domain must not smuggle in a rename. `tax_receipt` is spelled identically in both,
-- so it needs no entry in that bridge -- see section 2.

do $$
declare
  v_target record;
  v_conname text;
begin
  for v_target in
    select *
    from (values
      -- table,                                  column,                     domain spelling
      ('documents',                    'document_kind',            'credit'),
      ('document_learning_rules',      'document_type',            'credit_note'),
      ('document_export_templates',    'document_type',            'credit_note'),
      ('document_type_review_decisions', 'suggested_document_type', 'credit_note'),
      ('document_type_review_decisions', 'approved_document_type',  'credit_note'),
      ('document_filings',             'category',                 'credit_note')
    ) as t(tbl, col, credit_spelling)
  loop
    -- Found by what it CONSTRAINS, not by a name guessed from a naming convention. Five of the
    -- six are inline column checks whose names Postgres generated, and `documents_kind_check` is
    -- explicitly named and does not follow the pattern the other five do.
    select c.conname into v_conname
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    join pg_attribute a on a.attrelid = rel.oid and a.attname = v_target.col
    where n.nspname = 'public'
      and rel.relname = v_target.tbl
      and c.contype = 'c'
      and a.attnum = any (c.conkey)
      and array_length(c.conkey, 1) = 1
      and pg_get_constraintdef(c.oid) like '%payment_confirmation%';

    if v_conname is null then
      -- Fail closed and say which one. A silently skipped constraint is a column that rejects
      -- `tax_receipt` in production while every other one accepts it, which is the worst of the
      -- available outcomes: it fails at the last step of a flow the user already completed.
      raise exception '0104: no document-type CHECK found on %.% -- re-read the live catalogue before editing.',
        v_target.tbl, v_target.col;
    end if;

    execute format('alter table public.%I drop constraint %I', v_target.tbl, v_conname);
    execute format(
      'alter table public.%I add constraint %I check (%I is null or %I in (%L, %L, %L, %L, %L, %L, %L, %L))',
      v_target.tbl, v_conname, v_target.col, v_target.col,
      'invoice', 'delivery_note', v_target.credit_spelling, 'price_list', 'quote',
      'payment_confirmation', 'tax_receipt', 'other');
  end loop;
end $$;

-- The `is null or` above is a widening on three of the six columns, so the NOT NULL that was
-- doing the real work has to be stated where it was implied by the old CHECK shape. These three
-- were `text not null check (col in (...))`: the NOT NULL is a separate constraint and survives
-- untouched. Asserted rather than assumed, because a nullable `category` would let a filing
-- exist with no category at all -- the exact free-text failure 0075:224-226 was written to stop.
do $$
declare
  v record;
begin
  for v in
    select *
    from (values
      -- Measured against the live catalogue, not inferred from the CREATE TABLE text: the first
      -- draft of this migration assumed `documents.document_kind` was nullable and the assertion
      -- below caught it before the rewrite could commit. That is the assertion earning its place.
      ('documents', 'document_kind', true),
      ('document_learning_rules', 'document_type', false),
      ('document_export_templates', 'document_type', false),
      ('document_type_review_decisions', 'suggested_document_type', true),
      ('document_type_review_decisions', 'approved_document_type', false),
      ('document_filings', 'category', true)
    ) as t(tbl, col, must_be_not_null)
  loop
    if v.must_be_not_null <> (
      select a.attnotnull
      from pg_attribute a
      join pg_class rel on rel.oid = a.attrelid
      join pg_namespace n on n.oid = rel.relnamespace
      where n.nspname = 'public' and rel.relname = v.tbl and a.attname = v.col
    ) then
      raise exception '0104: nullability of %.% is not what this migration assumed.', v.tbl, v.col;
    end if;
  end loop;
end $$;

-- ===== 2. The five function bodies =====
--
-- Anchored substitution into the LIVE definition, the idiom 0075:125-200 established: read
-- `pg_get_functiondef`, assert the anchor is still there, replace, re-execute. Nothing else about
-- these functions changes -- not the security, not the search_path, not the grants, which
-- `pg_get_functiondef` renders from the live catalogue and therefore replays as installed.
--
-- The anchor is the single token `'payment_confirmation'` rather than the whole seven-value list,
-- because the list is wrapped differently at every site and two of the five carry it twice. Every
-- occurrence of that token in these five bodies IS the document-type domain -- verified site by
-- site: 0046:47, 0046:655, 0047:82, 0052:81, 0052:96, 0084:21 -- so replacing all of them is
-- right, and a body that stops containing it is a body that has moved and must be re-read.

do $$
declare
  v_sig text;
  v_def text;
begin
  foreach v_sig in array array[
    'public.smart_document_interpretation_valid(jsonb, text)',
    'public.create_document_learning_rule(text, text, uuid, text, text, text, text, text)',
    'public.document_export_template_contract_valid(jsonb)',
    'public.review_document_type(uuid, text, text, text, text, text, integer, text)',
    'public.sync_document_kind_from_interpretation()'
  ]
  loop
    v_def := replace(pg_get_functiondef(v_sig::regprocedure), e'\r', '');

    if position('''tax_receipt''' in v_def) > 0 then
      continue;  -- already widened; re-running this migration must not stack the value
    end if;
    if position('''payment_confirmation''' in v_def) = 0 then
      raise exception '0104: % no longer carries the document-type domain -- re-read its live definition before editing.', v_sig;
    end if;

    execute replace(v_def, '''payment_confirmation''', '''payment_confirmation'', ''tax_receipt''');
  end loop;
end $$;

-- ===== 3. Proof, in the catalogue rather than in a comment =====
--
-- Eleven sites accept the value and none was missed. This runs inside the migration so a partial
-- application cannot commit: the alternative is discovering site nine on a phone, at a delivery.

do $$
declare
  v_constraints integer;
  v_functions integer;
begin
  select count(*) into v_constraints
  from pg_constraint c
  join pg_class rel on rel.oid = c.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
  where n.nspname = 'public'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%tax_receipt%';

  select count(*) into v_functions
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosrc like '%tax_receipt%';

  if v_constraints <> 6 then
    raise exception '0104: expected 6 widened CHECK constraints, found %.', v_constraints;
  end if;
  if v_functions <> 5 then
    raise exception '0104: expected 5 widened function bodies, found %.', v_functions;
  end if;
end $$;

-- Structure is not behaviour. The gate above counts sites; this one asks the contract validator --
-- the function every interpretation must pass through before it is stored -- whether it now
-- accepts a receipt, still accepts an invoice, and still refuses a value nobody defined. It is a
-- pure function, so this costs nothing and needs no fixture.
do $$
declare
  v_payload jsonb := jsonb_build_object(
    'schema_version', '1',
    'document_type', 'tax_receipt',
    'document_type_confidence', to_jsonb(0.9),
    'supplier', jsonb_build_object(
      'suggested_id', null, 'suggested_name', 'ספק', 'confidence', to_jsonb(0.9),
      'evidence_block_ids', '[]'::jsonb),
    'fields', '[]'::jsonb,
    'line_items', '[]'::jsonb,
    'suggested_annotations', '[]'::jsonb);
begin
  if not public.smart_document_interpretation_valid(v_payload, '1') then
    raise exception '0104: the interpretation contract still rejects tax_receipt.';
  end if;
  if not public.smart_document_interpretation_valid(jsonb_set(v_payload, '{document_type}', '"invoice"'), '1') then
    raise exception '0104: widening the domain broke invoice.';
  end if;
  if public.smart_document_interpretation_valid(jsonb_set(v_payload, '{document_type}', '"receipt"'), '1') then
    raise exception '0104: the domain is no longer closed -- an undefined type was accepted.';
  end if;
end $$;

-- ===== 4. A1/A3/A5 re-assertion =====
--
-- Required of every migration after 0057, and required here in particular: section 2 re-executed
-- five function definitions. `pg_get_functiondef` replays the live SECURITY DEFINER and
-- search_path settings, so nothing should have shifted -- but "should" is what DEBT-REGISTER §9
-- is about. Two of the five are definers touching scope-enforced tables, and a replay that
-- dropped a scope filter would be invisible until a tenant read another tenant's row.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0104 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

comment on constraint documents_kind_check on public.documents is
  'Document subtypes the gallery can hold. `tax_receipt` (0104) is the supplier''s receipt and is '
  'evidence only: it links to an existing invoice or recorded payment and never creates a payable '
  '(OPEN-DECISIONS #141). `payment_confirmation` remains our own transfer confirmation.';
