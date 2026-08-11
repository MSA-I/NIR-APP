-- 0106 -- Which supplier sent this document? Answered from evidence, or not answered at all.
--
-- WHAT EXISTS TODAY, MEASURED. `document_interpretations.suggested_supplier_id` is a generated
-- column: `nullif(payload #>> '{supplier,suggested_id}', '')::uuid` (0046:222-224). That is the
-- model's guess and nothing else. The only check on it is in the edge function, which validates the
-- returned id against the candidate list it sent (core.ts:829-831) -- and that list is built from
-- `select id, name, status` (index.ts:1134). The supplier's registered VAT number is not even sent
-- as context. So there is no evidence ladder in this product: there is one guess, bounded only by
-- "was this id in the shortlist".
--
-- This migration is therefore new construction, not a widening. It adds one read-only resolver that
-- ranks deterministic evidence and REFUSES to choose when the evidence does not single anybody out.
--
-- THE LADDER, STRONGEST FIRST.
--   1. tax_id          -- the VAT number the document prints equals a supplier's registered one.
--   2. document_supplier -- the document row already carries a supplier_id. 0019 populated that
--                         column from the linked invoice or purchase order (0019:21,29) and 0019:85
--                         validates every later write against the tenant, so it is a link to a
--                         business record, not an interpretation of pixels.
--   3. supplier_sku / barcode -- a printed identifier that resolves to exactly one supplier.
--   4. exact_name      -- the printed supplier name, normalised, equals exactly one supplier's.
--
-- WHAT IS DELIBERATELY NOT A TIER.
--   * Name SIMILARITY. pg_trgm is installed (in `extensions`, so it would need qualifying), and a
--     trigram score would be a second, worse suggester than the one already in the payload: the
--     model read the whole document, trigrams read two strings. The model's suggestion is returned
--     as an advisory candidate instead, marked `authoritative: false`, so the screen can say "the
--     reader thought this" without that becoming a decision.
--   * PHONE. The plan listed it, and it cannot be built honestly right now: no key in the
--     extraction contract carries a phone number, so there is nothing to compare against. Adding
--     one is a prompt change with a version bump and a digest (core.ts REVIEW_FIELD_KEYS, v10), not
--     a line of SQL. Recorded here as an omission on purpose rather than a tier that silently never
--     fires.
--
-- AMBIGUITY IS A RESULT, NOT A FAILURE. When the best tier that has any evidence names more than
-- one supplier, this returns `resolved: false`, `reason: 'ambiguous'` and EVERY candidate with the
-- evidence that put it there. It never picks one of several. A document may also legitimately
-- resolve to nobody: `reason: 'no_evidence'`. Both outcomes send the document to a person, which is
-- the whole point -- nothing in this campaign creates a financial effect before a human approves.
--
-- INACTIVE AND PROBLEMATIC SUPPLIERS STAY CANDIDATES. A late-arriving invoice from a supplier we
-- stopped using is an ordinary event. Filtering by status would turn a resolvable document into an
-- unresolvable one for a reason the reviewer could not see. Status is returned on every candidate
-- so the screen can show it. Soft-deleted suppliers ARE excluded: `deleted_at is not null` means
-- the record is gone from the product, and resolving onto it would resurrect it by reference.

-- ===== 1. The normalisation twin =====
--
-- This is the SQL twin of `nameKey` in src/lib/nameKey.ts -- the app's single answer to "are these
-- two hand-typed names the same name?". It cannot CALL that function, so parity is asserted instead:
-- p27 pins a corpus of inputs to exact outputs, and nameKey.spec.ts pins the same corpus on the
-- client. Editing one without the other breaks a test rather than quietly splitting the answer.
--
-- ONE KNOWN DIVERGENCE, FOLDED HERE ON PURPOSE. JavaScript's `\s` matches NBSP (U+00A0) and the
-- narrow NBSP (U+202F); PostgreSQL's `\s` does not. Both characters occur in real OCR output of
-- Hebrew documents, so they are translated to a plain space before the collapse. Whitespace more
-- exotic than that (zero-width joiners, U+FEFF) is folded by neither side identically and is not
-- claimed to be -- it has never been observed in a supplier name here.
create or replace function private.name_match_key(p_text text)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select nullif(
    lower(btrim(regexp_replace(
      regexp_replace(translate(p_text, e'  ', '  '), '["''״׳]', '', 'g'),
      '\s+', ' ', 'g'
    ))),
    ''
  )
$function$;

comment on function private.name_match_key(text) is
  'SQL twin of nameKey (src/lib/nameKey.ts): strips quote marks including the Hebrew gershayim and '
  'geresh, folds NBSP and narrow NBSP to a space, collapses whitespace, trims, lowercases, and '
  'returns null for an empty result. Parity with the client is pinned by p27 and nameKey.spec.ts.';

-- A VAT number is compared on its digits, because documents print it as 12-345678-9, 123456789 and
-- ח.פ 123456789 interchangeably. The eight-digit floor is doing real work: without it a document
-- that printed "1" as a stray token would match every supplier whose tax_id contains a 1.
create or replace function private.vat_number_key(p_text text)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select case
    when length(regexp_replace(coalesce(p_text, ''), '[^0-9]', '', 'g')) >= 8
      then regexp_replace(p_text, '[^0-9]', '', 'g')
    else null
  end
$function$;

comment on function private.vat_number_key(text) is
  'The digits of a printed VAT / business number, or null when fewer than eight of them -- too '
  'short to identify anybody, and a short key would match promiscuously (0106).';

-- ===== 2. The resolver =====
create or replace function private.resolve_document_supplier(
  p_org_id uuid,
  p_document_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_printed_vat text;
  v_printed_name text;
  v_document_supplier uuid;
  v_model_suggestion uuid;
  v_tier text;
  v_matches jsonb := '[]'::jsonb;
  v_advisory jsonb := '[]'::jsonb;
  v_count integer;
  v_supplier_id uuid;
begin
  if p_org_id is null or p_payload is null then
    return jsonb_build_object(
      'resolved', false, 'supplier_id', null, 'matched_by', null,
      'reason', 'missing_identifiers', 'candidates', '[]'::jsonb
    );
  end if;

  -- The document prints these. `supplier_vat_id` is a REVIEW key in the extraction contract
  -- (core.ts REVIEW_FIELD_KEYS, v10): named in the prompt, carried in the payload, consumed by no
  -- applying command. This resolver is advisory by construction -- its output requires a human
  -- approval before anything financial happens -- which is why reading it here does not make it a
  -- canonical key. core.test.ts states that boundary as "not consumed by 0077 or 0099".
  select private.vat_number_key(f.value ->> 'value')
    into v_printed_vat
  from jsonb_array_elements(p_payload -> 'fields') as f(value)
  where f.value ->> 'key' = 'supplier_vat_id'
    and private.vat_number_key(f.value ->> 'value') is not null
  limit 1;

  v_printed_name := private.name_match_key(p_payload #>> '{supplier,suggested_name}');
  v_model_suggestion := nullif(p_payload #>> '{supplier,suggested_id}', '')::uuid;

  if p_document_id is not null then
    select d.supplier_id into v_document_supplier
    from public.documents d
    where d.org_id = p_org_id and d.id = p_document_id and d.deleted_at is null;
  end if;

  -- ----- tier 1: the printed VAT number -----
  if v_printed_vat is not null then
    select coalesce(jsonb_agg(c order by c ->> 'name'), '[]'::jsonb) into v_matches
    from (
      select jsonb_build_object(
        'supplier_id', s.id, 'name', s.name, 'tax_id', s.tax_id, 'status', s.status,
        'matched_by', 'tax_id', 'authoritative', true,
        'evidence', 'ח.פ / עוסק מורשה שמודפס במסמך זהה לזה הרשום אצל הספק'
      ) as c
      from public.suppliers s
      where s.org_id = p_org_id
        and s.deleted_at is null
        and private.vat_number_key(s.tax_id) = v_printed_vat
    ) t;
    if jsonb_array_length(v_matches) > 0 then
      v_tier := 'tax_id';
    end if;
  end if;

  -- ----- tier 2: the supplier the document record already carries -----
  if v_tier is null and v_document_supplier is not null then
    select coalesce(jsonb_agg(c), '[]'::jsonb) into v_matches
    from (
      select jsonb_build_object(
        'supplier_id', s.id, 'name', s.name, 'tax_id', s.tax_id, 'status', s.status,
        'matched_by', 'document_supplier', 'authoritative', true,
        'evidence', 'המסמך כבר משויך לספק הזה ברשומה'
      ) as c
      from public.suppliers s
      where s.org_id = p_org_id and s.id = v_document_supplier and s.deleted_at is null
    ) t;
    if jsonb_array_length(v_matches) > 0 then
      v_tier := 'document_supplier';
    end if;
  end if;

  -- ----- tier 3: a printed identifier that resolves to exactly one supplier -----
  --
  -- An identifier is evidence only when it implies ONE supplier by itself. `supplier_sku` is scoped
  -- to a supplier by the table, so a SKU listed by two suppliers implies neither. A barcode
  -- identifies a PRODUCT, so it implies a supplier only when exactly one supplier lists that
  -- product -- otherwise it is evidence about the product and says nothing about who sent the paper.
  -- Identifiers that survive that filter must then agree with each other; two SKUs pointing at two
  -- different suppliers is a contradiction, and the tier reports both rather than preferring one.
  if v_tier is null then
    with printed as (
      select
        nullif(btrim(li.value #>> '{values,sku}'), '') as sku,
        nullif(btrim(li.value #>> '{values,barcode}'), '') as barcode
      from jsonb_array_elements(p_payload -> 'line_items') as li(value)
    ),
    by_sku as (
      select p.sku as token, 'supplier_sku' as kind, sp.supplier_id
      from printed p
      join public.supplier_products sp
        on sp.org_id = p_org_id and btrim(sp.supplier_sku) = p.sku
      where p.sku is not null
    ),
    by_barcode as (
      select p.barcode as token, 'barcode' as kind, sp.supplier_id
      from printed p
      join public.products pr
        on pr.org_id = p_org_id and btrim(pr.barcode) = p.barcode
      join public.supplier_products sp
        on sp.org_id = p_org_id and sp.product_id = pr.id
      where p.barcode is not null
    ),
    tokens as (select * from by_sku union all select * from by_barcode),
    decisive as (
      select kind, min(supplier_id::text)::uuid as supplier_id
      from tokens
      group by kind, token
      having count(distinct supplier_id) = 1
    )
    select coalesce(jsonb_agg(c order by c ->> 'name'), '[]'::jsonb) into v_matches
    from (
      select jsonb_build_object(
        'supplier_id', s.id, 'name', s.name, 'tax_id', s.tax_id, 'status', s.status,
        'matched_by', string_agg(distinct d.kind, ',' order by d.kind),
        'authoritative', true,
        'evidence', 'מק"ט ספק או ברקוד שמודפס במסמך משויך לספק הזה בלבד'
      ) as c
      from decisive d
      join public.suppliers s
        on s.org_id = p_org_id and s.id = d.supplier_id and s.deleted_at is null
      group by s.id, s.name, s.tax_id, s.status
    ) t;
    if jsonb_array_length(v_matches) > 0 then
      v_tier := 'printed_identifier';
    end if;
  end if;

  -- ----- tier 4: the printed name, normalised, exactly -----
  if v_tier is null and v_printed_name is not null then
    select coalesce(jsonb_agg(c order by c ->> 'name'), '[]'::jsonb) into v_matches
    from (
      select jsonb_build_object(
        'supplier_id', s.id, 'name', s.name, 'tax_id', s.tax_id, 'status', s.status,
        'matched_by', 'exact_name', 'authoritative', true,
        'evidence', 'שם הספק במסמך זהה בדיוק לשם הרשום, לאחר נרמול'
      ) as c
      from public.suppliers s
      where s.org_id = p_org_id
        and s.deleted_at is null
        and private.name_match_key(s.name) = v_printed_name
    ) t;
    if jsonb_array_length(v_matches) > 0 then
      v_tier := 'exact_name';
    end if;
  end if;

  -- ----- the advisory candidate: what the reader thought -----
  --
  -- Appended after the decision so that it can never influence it. It is here so the review screen
  -- can show the model's own answer next to the evidence, including when the evidence disagrees
  -- with it -- that disagreement is worth a human's attention and is invisible if we drop it.
  if v_model_suggestion is not null then
    select coalesce(jsonb_agg(c), '[]'::jsonb) into v_advisory
    from (
      select jsonb_build_object(
        'supplier_id', s.id, 'name', s.name, 'tax_id', s.tax_id, 'status', s.status,
        'matched_by', 'model_suggestion', 'authoritative', false,
        'evidence', 'הצעת המכונה מקריאת המסמך — אינה ראיה מכריעה'
      ) as c
      from public.suppliers s
      where s.org_id = p_org_id and s.id = v_model_suggestion and s.deleted_at is null
        and not exists (
          select 1 from jsonb_array_elements(v_matches) as m(value)
          where (m.value ->> 'supplier_id')::uuid = s.id
        )
    ) t;
  end if;

  v_count := jsonb_array_length(v_matches);
  if v_count = 1 then
    v_supplier_id := (v_matches -> 0 ->> 'supplier_id')::uuid;
  end if;

  return jsonb_build_object(
    'resolved', v_count = 1,
    'supplier_id', v_supplier_id,
    'matched_by', case when v_count = 1 then v_matches -> 0 ->> 'matched_by' else null end,
    'reason', case when v_count = 1 then null
                   when v_count > 1 then 'ambiguous'
                   else 'no_evidence' end,
    'candidates', v_matches || v_advisory
  );
end
$function$;

comment on function private.resolve_document_supplier(uuid, uuid, jsonb) is
  'Which supplier sent this document, from deterministic evidence: printed VAT number, the '
  'supplier already linked to the document row, a printed SKU or barcode that implies exactly one '
  'supplier, then the exactly-matching normalised name (0106). Returns resolved=false with '
  'reason=ambiguous and every candidate when the strongest available tier names more than one, and '
  'reason=no_evidence when no tier fires -- it never chooses among several. The model''s own '
  'suggestion is always returned as a candidate with authoritative=false and never resolves '
  'anything. Read-only, and its output requires human approval before any financial effect.'
  'SECURITY INVOKER on purpose, unlike private.resolve_delivery_note_order(...) which took a '
  'scope_definer_exemptions row in 0090. This one needs no exemption because it needs no privilege '
  'of its own: every caller is already a SECURITY DEFINER command (or service_role) whose rights '
  'the tenancy filters below narrow, not widen -- every read is filtered on the org_id the caller '
  'passed. Called instead by a plain authenticated role, RLS narrows what it can see, so the worst '
  'case is a tier that stays silent and a document that needs a person -- never a candidate from '
  'another tenant. Making it a definer would have widened the A5 registry by one row for no read it '
  'could not already do; the wave that drains that registry should not first have to drain this.';

-- ===== 3. Anchors these functions silently depend on =====
do $$
declare
  v_secdef boolean;
  v_volatile "char";
  v_settings text[];
  v_name text;
  v_payload jsonb;
begin
  -- (a) The columns the ladder reads, by name and type. A rename compiles at CREATE time and fails
  -- at call time, on the screen a person is using to approve money.
  if (select count(*) from information_schema.columns
      where table_schema = 'public'
        and (table_name, column_name, data_type) in (
          ('suppliers', 'tax_id', 'text'),
          ('suppliers', 'name', 'text'),
          ('supplier_products', 'supplier_sku', 'text'),
          ('products', 'barcode', 'text'),
          ('documents', 'supplier_id', 'uuid'))) <> 5 then
    raise exception
      '0106: one of the five columns the supplier ladder reads has been renamed or retyped.';
  end if;

  -- (b) Soft deletion is what excludes a supplier from resolution, so the column must exist.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'suppliers' and column_name = 'deleted_at'
  ) then
    raise exception '0106: suppliers.deleted_at is gone; the resolver would resolve onto deleted rows.';
  end if;

  -- (c) The payload shape the resolver reaches into is still the shape the contract enforces.
  -- Asserted behaviourally, against the live validator, rather than by trusting the 0046 text.
  v_payload := jsonb_build_object(
    'schema_version', '1',
    'document_type', 'invoice',
    'document_type_confidence', 0.9,
    'supplier', jsonb_build_object(
      'suggested_id', null, 'suggested_name', 'ספק בדיקה',
      'confidence', 0.5, 'evidence_block_ids', '[]'::jsonb),
    'fields', jsonb_build_array(jsonb_build_object(
      'key', 'supplier_vat_id', 'value', '123456789',
      'confidence', 0.9, 'evidence_block_ids', '[]'::jsonb)),
    'line_items', jsonb_build_array(jsonb_build_object(
      'source_row', 1,
      'values', jsonb_build_object('sku', 'A-1', 'barcode', '7290000000001'),
      'evidence_block_ids', '[]'::jsonb)),
    'suggested_annotations', '[]'::jsonb
  );
  if not public.smart_document_interpretation_valid(v_payload, '1') then
    raise exception
      '0106: the interpretation contract rejects the payload shape resolve_document_supplier reads.';
  end if;
  if public.smart_document_interpretation_valid(v_payload - 'fields', '1') then
    raise exception
      '0106: the contract no longer requires fields[]; the VAT tier would read a key that may be absent.';
  end if;

  -- (d) The normalisation twin behaves the way nameKey does. Three cases that have each been a real
  -- bug somewhere: a Hebrew gershayim inside a company name, a doubled space, and NBSP from OCR.
  select private.name_match_key('  מרכז   הבשר ״בן דוד״  ') into v_name;
  if v_name is distinct from 'מרכז הבשר בן דוד' then
    raise exception '0106: name_match_key no longer agrees with nameKey (got %).', v_name;
  end if;
  select private.name_match_key(e'Alpha Foods') into v_name;
  if v_name is distinct from 'alpha foods' then
    raise exception '0106: name_match_key stopped folding NBSP (got %).', v_name;
  end if;
  if private.name_match_key('   ') is not null then
    raise exception '0106: name_match_key must return null for a blank name, not an empty string.';
  end if;
  if private.vat_number_key('12-345678-9') is distinct from '123456789'
     or private.vat_number_key('7') is not null then
    raise exception '0106: vat_number_key no longer strips to digits with an eight-digit floor.';
  end if;

  -- (e) The security properties the comments above claim.
  for v_name in
    select unnest(array['name_match_key', 'vat_number_key', 'resolve_document_supplier'])
  loop
    select p.prosecdef, p.provolatile, p.proconfig
      into v_secdef, v_volatile, v_settings
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = v_name;
    if v_volatile <> 'i' and v_volatile <> 's' then
      raise exception '0106: private.% is neither IMMUTABLE nor STABLE; it may write.', v_name;
    end if;
    if not ('search_path=public, pg_temp' = any(v_settings)) then
      raise exception '0106: private.% has no pinned search_path (settings=%).', v_name, v_settings;
    end if;
  end loop;
  -- Pinned as INVOKER, not merely observed to be. A later hand promoting it to SECURITY DEFINER
  -- fails here and has to go add the scope_definer_exemptions row and bump the p9 pin deliberately,
  -- which is exactly the confrontation the A5 registry exists to force.
  select p.prosecdef into v_secdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'resolve_document_supplier';
  if v_secdef then
    raise exception '0106: resolve_document_supplier became SECURITY DEFINER; it needs an A5 exemption row.';
  end if;

  -- (f) `private` still carries no ACL, so the browser cannot call a function that takes org_id as
  -- an argument and would otherwise trust it.
  if (select nspacl from pg_namespace where nspname = 'private') is not null then
    raise exception '0106: the private schema has acquired an ACL.';
  end if;
end $$;

-- ===== 4. A1/A3/A5 re-assertion =====
--
-- Required of every migration after 0057. This one adds no SECURITY DEFINER code -- see the comment
-- on resolve_document_supplier for why it stayed an invoker -- so it adds no exemption row and the
-- p9 pin does not move. This block is what proves that, rather than a sentence claiming it.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0106 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
