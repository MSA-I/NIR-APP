-- 0256 -- normalize with evidence: the declared pairing between a stored text and its original.
--
-- THE DECISION THIS IMPLEMENTS (owner, 30.08.2026, DEBT §20). Text read from a document may be
-- normalized, PROVIDED the original survives, so it can always be proven what came from the
-- document and what came from a system correction.
--
-- WHAT §20 ACTUALLY SAID, AND WHY THIS MIGRATION DOES NOT PICK ITS SIDE.
-- §20 is narrow. It asks whether `private.document_text_sanitize` should stay a denylist, and its
-- "next step" reads: no change without a ruling that source fidelity matters less than normalizing
-- the stored text. The system has been deliberately two-tier since 0077 -- a DENYLIST for storage,
-- where faithfulness is the requirement, and an ALLOWLIST inverted out of it in
-- `private.document_text_key` for the comparison key, where collapsing look-alike characters is
-- the requirement. The ruling above is the third option §20 never considered: keep both tiers and
-- make the pairing between them provable. So NOTHING HERE TOUCHES THE SANITIZER. Its body stays
-- byte-identical (0182 pins it by hash), the allowlist stays in its own function (0182's
-- `normalized_key_not_separated` arm), and no function created below writes an evidence table
-- (0182's `sanitized_raw_evidence_write` arm). All three of those guards are re-run at the bottom
-- of this file, so "did not touch it" is measured here rather than promised.
--
-- WHAT WAS ACTUALLY MISSING. Three raw-versus-normalized pairs already exist:
--
--   `document_review_corrections`  (0049:19-21)  original_text / before_text / corrected_text --
--                                                the exact pattern, scoped to HUMAN corrections.
--   `invoice_lines.raw_evidence`   (0099:112,     the whole reviewed line, beside the trimmed
--                                   0110:463-479) `description` derived from it, plus a source_hash.
--   the immutable payloads          (0045:440-462) `document_extractions.payload` is append-only,
--                                                so a value derived from it is always re-derivable.
--
-- For every SANITIZER case the original is therefore already recoverable. What no row anywhere
-- recorded is the PAIRING itself: nothing said "this stored value is the normalized form of that
-- one". A reader had to know, from outside the database, which fields were derived from which.
-- `private.document_text_normalization_registry` below is that missing sentence, written down.
--
-- AND THE ONE REAL LOSS, WHICH IS NOT IN THIS DATABASE AT ALL.
-- `worker/ocr/src/parsers.py` corrects a PDF text layer stored in visual rather than logical order
-- -- an Israeli-generator quirk that returns every Hebrew word backwards. It used to do that with
-- an in-place overwrite: the pre-correction string existed nowhere afterwards and NOTHING RECORDED
-- THAT THE CORRECTION HAD RUN. That is the single place where the ruling's claim was unprovable,
-- and it is fixed in the same change as this file: the parser now emits `payload.normalizations`,
-- carrying the decision, the three numbers it was decided on, and -- when it fired -- the exact
-- string the detector judged. The gateway contract version moved 2 -> 3 on BOTH sides for it.
--
-- WHY THERE IS NO NEW AUDIT ROW. `audit_logs` records sensitive WRITES with a reason. This
-- migration adds no writer: a registry seeded once at migration time, two read-only reports and a
-- CHECK constraint. The evidence it makes readable was already written, immutably, by the paths
-- that 0182 registers and audits. A new mutable store for "what the original was" would be the
-- opposite of the decision -- one more thing that can disagree with the document.
--
-- WHY THE REGISTRY IS `private` AND EVERY FUNCTION IS SECURITY INVOKER.
-- A `public` base table would owe A1 a scope classification and A6 a tenant-export disposition,
-- and it is neither tenant data nor a scoped surface -- it is a statement about the schema. And an
-- invoker function is not merely simpler here: A5 scans the BODY of every SECURITY DEFINER
-- function for the name of a scope-enforced table, comments and string literals included. The
-- reports below must name `documents`-adjacent tables to do their job. As invokers they carry no
-- A5 obligation and no exemption row, and the RLS on `document_extractions` (owner/office, own
-- org) applies to the reader exactly as it does to a direct select.

-- ==========================================================================================
-- 1. The pairing, declared.
-- ==========================================================================================
create table if not exists private.document_text_normalization_registry (
  -- For a worker-side corrector this is the id that appears in `payload.normalizations[].id`, so
  -- the anti-join below is exact rather than a name someone remembered to keep in step. For a
  -- database-side one it is the function signature, resolvable through to_regprocedure.
  normalizer          text primary key,
  origin              text not null check (origin in ('worker', 'database', 'human')),
  -- carried_in_payload -- the original travels inside the same immutable payload as the value.
  -- paired_row         -- the original sits in a sibling column of the same row.
  -- never_stored       -- the normalized value is transient (a comparison or dedup input) and
  --                       never reaches storage at all; only the original is ever persisted.
  preservation        text not null
    check (preservation in ('carried_in_payload', 'paired_row', 'never_stored')),
  normalized_table    text,
  normalized_column   text,
  normalized_path     text[] not null default '{}',
  original_table      text not null,
  original_column     text not null,
  original_path       text[] not null default '{}',
  rationale           text not null check (length(btrim(rationale)) between 1 and 2000),
  declared_at         timestamptz not null default now(),
  constraint document_text_normalization_registry_never_stored check (
    (preservation = 'never_stored') = (normalized_table is null)
  ),
  constraint document_text_normalization_registry_normalized_pair check (
    (normalized_table is null) = (normalized_column is null)
  ),
  -- A row whose two sides are the same surface declares nothing. It would read as a pairing and
  -- prove the absence of one, which is worse than no row at all.
  constraint document_text_normalization_registry_declares_a_difference check (
    normalized_table is null
    or normalized_table is distinct from original_table
    or normalized_column is distinct from original_column
    or normalized_path is distinct from original_path
  )
);

revoke all on private.document_text_normalization_registry
  from public, anon, authenticated, service_role;

comment on table private.document_text_normalization_registry is
  'DEBT #20. Every place this system stores text it changed, paired with where the unchanged '
  'original can be read. Seeded by 0256; checked against the live schema and against stored rows '
  'by private.document_text_evidence_violations().';

insert into private.document_text_normalization_registry (
  normalizer, origin, preservation,
  normalized_table, normalized_column, normalized_path,
  original_table, original_column, original_path, rationale
) values
  (
    'hebrew_visual_order', 'worker', 'carried_in_payload',
    'document_extractions', 'payload', array['document', 'plain_text'],
    'document_extractions', 'payload', array['normalizations'],
    'An Israeli PDF generator can lay a Hebrew text layer out in visual order, so pypdf returns '
    'every word backwards with the digits still correct. The worker reverses the Hebrew runs and '
    'now carries the pre-reversal string in the same immutable payload, beside the three counts '
    'the decision was made on. Before this the correction was an in-place overwrite: the original '
    'existed nowhere and nothing said the correction had run, which is the one case where DEBT #20 '
    'could not be honoured by re-derivation.'
  ),
  (
    'private.document_text_sanitize(text)', 'database', 'never_stored',
    null, null, '{}',
    'document_extractions', 'payload', '{}',
    'A comparison and dedup input, never a stored-evidence rewriter. 0077 argued it into place as '
    'a DENYLIST precisely so storage stays faithful, and 0182 holds it there with three arms: a '
    'body-hash pin, a refusal of any evidence writer that routes through it, and a refusal to let '
    'the allowlist inversion migrate into it. Its input is the immutable payload, so anything it '
    'produces is re-derivable from evidence that was never rewritten.'
  ),
  (
    'document_review_correction', 'human', 'paired_row',
    'document_review_corrections', 'corrected_text', '{}',
    'document_review_corrections', 'original_text', '{}',
    'A person changing what the extraction read. 0049 keeps three texts per row -- what the '
    'document said, what stood before this edit, and what the person typed -- so a correction is '
    'an append-only overlay and never a rewrite of the extraction beneath it.'
  ),
  (
    'apply_reviewed_document.line_description', 'database', 'paired_row',
    'invoice_lines', 'description', '{}',
    'invoice_lines', 'raw_evidence', '{}',
    'The reviewed line is stored whole in raw_evidence with a source_hash over it, while '
    'description keeps the trimmed form (0110:463-479) and falls back to the product name or a '
    'positional label when the document gave none. The fallback is exactly why the pairing has to '
    'be declared: description can hold a string the document never contained.'
  )
on conflict (normalizer) do nothing;

-- ==========================================================================================
-- 2. The shape of a carried pairing, enforced where it is stored.
-- ==========================================================================================
-- Additive and permissive about ABSENCE, strict about CONTENT. Every extraction written before the
-- worker emitted this key has no `normalizations` at all, and those rows are honestly described as
-- "predates the record" -- not as "nothing was corrected". Requiring the key here would either
-- reject the past or force a backfill that invents decisions nobody made. The gateway is where the
-- key is REQUIRED (contract version 3), so no payload lacking it can be written from now on, and
-- the two facts stay distinguishable for ever.
--
-- 0045's `smart_document_extraction_valid` is deliberately left alone: it was redefined once
-- already (0103) behind an ancestry guard, and folding a new rule into it would mean reading and
-- re-executing a live body for a check that composes perfectly well as its own constraint.
create or replace function public.smart_document_extraction_normalizations_valid(p_payload jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select case
    when p_payload is null or jsonb_typeof(p_payload) is distinct from 'object' then false
    when not (p_payload ? 'normalizations') then true
    when jsonb_typeof(p_payload -> 'normalizations') <> 'array' then false
    when jsonb_array_length(p_payload -> 'normalizations') > 8 then false
    else not exists (
      select 1
      from jsonb_array_elements(p_payload -> 'normalizations') as entry(value)
      where jsonb_typeof(entry.value) is distinct from 'object'
         or not (entry.value ?& array['id', 'applied', 'original_text', 'measurements'])
         or (entry.value - array['id', 'applied', 'original_text', 'measurements'])
              <> '{}'::jsonb
         or jsonb_typeof(entry.value -> 'id') <> 'string'
         or (entry.value ->> 'id') <> 'hebrew_visual_order'
         or jsonb_typeof(entry.value -> 'applied') <> 'boolean'
         or jsonb_typeof(entry.value -> 'measurements') <> 'array'
         or jsonb_array_length(entry.value -> 'measurements') > 16
         -- THE PAIRING, AS A CONSTRAINT RATHER THAN A CONVENTION. A correction that changed the
         -- text must carry what the text was; one that changed nothing must not carry a second
         -- copy of what it left alone, because storing one would assert a correction nobody made.
         or (
           (entry.value ->> 'applied')::boolean
           and (jsonb_typeof(entry.value -> 'original_text') <> 'string'
                or length(entry.value ->> 'original_text') > 2000000)
         )
         or (
           not (entry.value ->> 'applied')::boolean
           and jsonb_typeof(entry.value -> 'original_text') <> 'null'
         )
         or exists (
           select 1
           from jsonb_array_elements(entry.value -> 'measurements') as measurement(value)
           where jsonb_typeof(measurement.value) is distinct from 'object'
              or not (measurement.value ?& array['name', 'value'])
              or (measurement.value - array['name', 'value']) <> '{}'::jsonb
              or jsonb_typeof(measurement.value -> 'name') <> 'string'
              or length(measurement.value ->> 'name') not between 1 and 100
              or jsonb_typeof(measurement.value -> 'value') <> 'number'
         )
    )
    and (
      select count(distinct entry.value ->> 'id') = count(*)
      from jsonb_array_elements(p_payload -> 'normalizations') as entry(value)
    )
  end
$fn$;

revoke all on function public.smart_document_extraction_normalizations_valid(jsonb)
  from public, anon, authenticated, service_role;

alter table public.document_extractions
  drop constraint if exists document_extractions_normalizations_check;
alter table public.document_extractions
  add constraint document_extractions_normalizations_check
  check (public.smart_document_extraction_normalizations_valid(payload)) not valid;
alter table public.document_extractions
  validate constraint document_extractions_normalizations_check;

-- ==========================================================================================
-- 3. Reading the pairing: what the document said, beside what this system stored.
-- ==========================================================================================
-- SECURITY INVOKER, so `document_extractions_select` (own org, owner/office) decides who sees it,
-- exactly as it decides who sees the payload this reads from. The function grants nothing; it only
-- names, per correction, the two halves that were previously one field.
create or replace function public.document_extraction_text_evidence(p_extraction_id uuid)
returns table (
  normalizer text,
  applied boolean,
  measurements jsonb,
  stored_plain_text text,
  original_text text
)
language sql
stable
set search_path = public, pg_temp
as $fn$
  select
    entry.value ->> 'id',
    (entry.value ->> 'applied')::boolean,
    entry.value -> 'measurements',
    -- The stored text as the rest of the system reads it. For a PDF this is the corrected text
    -- layer joined with whatever OCR produced for pages that had none.
    extraction.payload #>> array['document', 'plain_text'],
    -- The correction's own input, verbatim: the pages the detector judged, joined by a single
    -- newline, before a character moved. NULL when the corrector ran and changed nothing -- in
    -- that case the column to its left IS the original, which is the claim `applied = false`
    -- makes. No row at all means the extraction predates the record.
    entry.value ->> 'original_text'
  from public.document_extractions extraction
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(extraction.payload -> 'normalizations') = 'array'
        then extraction.payload -> 'normalizations'
      else '[]'::jsonb
    end
  ) as entry(value)
  where extraction.id = p_extraction_id
$fn$;

revoke all on function public.document_extraction_text_evidence(uuid) from public, anon;
grant execute on function public.document_extraction_text_evidence(uuid)
  to authenticated, service_role;

comment on function public.document_extraction_text_evidence(uuid) is
  'DEBT #20. Per text correction on one extraction: what the document said, what this system '
  'stored, and the numbers the correction was decided on. Read-only and RLS-bound.';

-- ==========================================================================================
-- 4. The report that keeps the declaration honest.
-- ==========================================================================================
-- Installed as a function, in the shape 0057 and 0182 established, so the SQL suite can prove by
-- mutation that the same logic the migration enforces really detects a broken pairing -- rather
-- than trusting an assertion block that ran once.
--
-- The two data arms scan `document_extractions` in full. That is deliberate: a guard that samples
-- is a guard that reports PASS for the row it did not look at, and the whole subject here is a
-- claim about every stored row.
create or replace function private.document_text_evidence_violations()
returns table (assertion text, detail text)
language sql
stable
set search_path = public, pg_catalog
as $fn$
  -- A declared original that no longer exists is a pairing that silently stopped resolving.
  select 'original_surface_missing'::text,
         registry.normalizer || ' -> ' || registry.original_table || '.' || registry.original_column
  from private.document_text_normalization_registry registry
  where not exists (
    select 1 from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = registry.original_table
      and column_info.column_name = registry.original_column
  )
  union all
  select 'normalized_surface_missing',
         registry.normalizer || ' -> ' || registry.normalized_table || '.' || registry.normalized_column
  from private.document_text_normalization_registry registry
  where registry.normalized_table is not null
    and not exists (
      select 1 from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.normalized_table
        and column_info.column_name = registry.normalized_column
    )
  union all
  -- A database-side normalizer is named by signature. Resolved rather than string-matched, for
  -- the reason 0182's #252 note gives: a rendered signature stops matching the moment schema
  -- qualification changes, and a predicate that matches nothing reads as PASS.
  select 'declared_normalizer_missing', registry.normalizer
  from private.document_text_normalization_registry registry
  where registry.origin = 'database'
    and position('(' in registry.normalizer) > 0
    and to_regprocedure(registry.normalizer) is null
  union all
  -- The subject of the arm below cannot go quiet by being deleted.
  select 'carried_pairing_undeclared',
         'no carried_in_payload row remains in the normalization registry'
  where not exists (
    select 1 from private.document_text_normalization_registry registry
    where registry.preservation = 'carried_in_payload'
  )
  union all
  -- THE DECISION, CHECKED AGAINST REALITY. A stored correction that says it changed the text and
  -- does not carry what the text was is exactly the state #20 describes, surviving in data.
  select 'stored_correction_without_original',
         extraction.id::text || ' / ' || coalesce(entry.value ->> 'id', 'unnamed')
  from public.document_extractions extraction
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(extraction.payload -> 'normalizations') = 'array'
        then extraction.payload -> 'normalizations'
      else '[]'::jsonb
    end
  ) as entry(value)
  where (entry.value ->> 'applied')::boolean
    and jsonb_typeof(entry.value -> 'original_text') is distinct from 'string'
  union all
  -- ...and a corrector nobody declared cannot start rewriting stored text unnoticed.
  select distinct 'payload_normalizer_undeclared', entry.value ->> 'id'
  from public.document_extractions extraction
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(extraction.payload -> 'normalizations') = 'array'
        then extraction.payload -> 'normalizations'
      else '[]'::jsonb
    end
  ) as entry(value)
  where not exists (
    select 1 from private.document_text_normalization_registry registry
    where registry.origin = 'worker'
      and registry.normalizer = entry.value ->> 'id'
  )
$fn$;

revoke all on function private.document_text_evidence_violations()
  from public, anon, authenticated, service_role;

-- ==========================================================================================
-- 5. The assertions -- fail the migration, not the runtime.
-- ==========================================================================================
do $assert_0256$
declare
  v_violations text;
  v_extraction uuid;
  v_payload jsonb;
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'private'
       and table_name = 'document_text_normalization_registry'
  ) then
    raise exception '0256: the normalization registry was not created';
  end if;

  if (select count(*) from private.document_text_normalization_registry) < 4 then
    raise exception '0256: the registry lost rows between the insert and this assertion';
  end if;

  -- The three pairs that already existed are declared, and so is the one the worker now carries.
  -- Named individually rather than counted: a count passes while three rows say the same thing.
  if not exists (
    select 1 from private.document_text_normalization_registry
     where normalizer = 'hebrew_visual_order' and preservation = 'carried_in_payload'
  ) or not exists (
    select 1 from private.document_text_normalization_registry
     where origin = 'human' and preservation = 'paired_row'
  ) or not exists (
    select 1 from private.document_text_normalization_registry
     where preservation = 'never_stored'
  ) then
    raise exception '0256: the registry does not declare all three preservation shapes';
  end if;

  -- The constraint really refuses each half of a broken pairing, probed rather than trusted. The
  -- probe rolls itself back the p14/0253 way: raise a sentinel, catch it, keep the assertion.
  v_payload := jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object('page_count', 1, 'detected_languages', jsonb_build_array('he'),
                                   'plain_text', 'x', 'partial', false),
    'blocks', jsonb_build_array(), 'tables', jsonb_build_array(), 'marks', jsonb_build_array());

  if public.smart_document_extraction_normalizations_valid(
       v_payload || jsonb_build_object('normalizations', jsonb_build_array(jsonb_build_object(
         'id', 'hebrew_visual_order', 'applied', true, 'original_text', null,
         'measurements', jsonb_build_array())))) then
    raise exception '0256: a correction that kept no original was accepted -- the pairing is not '
      'enforced, which is the entire subject of this migration';
  end if;

  if public.smart_document_extraction_normalizations_valid(
       v_payload || jsonb_build_object('normalizations', jsonb_build_array(jsonb_build_object(
         'id', 'hebrew_visual_order', 'applied', false, 'original_text', 'x',
         'measurements', jsonb_build_array())))) then
    raise exception '0256: an unapplied correction carrying a second copy of the text was '
      'accepted -- that reads as a correction nobody made';
  end if;

  if public.smart_document_extraction_normalizations_valid(
       v_payload || jsonb_build_object('normalizations', jsonb_build_array(jsonb_build_object(
         'id', 'transliterate', 'applied', false, 'original_text', null,
         'measurements', jsonb_build_array())))) then
    raise exception '0256: an undeclared corrector id was accepted into stored evidence';
  end if;

  if not public.smart_document_extraction_normalizations_valid(
       v_payload || jsonb_build_object('normalizations', jsonb_build_array(jsonb_build_object(
         'id', 'hebrew_visual_order', 'applied', true, 'original_text', 'ןמסמ',
         'measurements', jsonb_build_array(
           jsonb_build_object('name', 'hebrew_words', 'value', 3),
           jsonb_build_object('name', 'final_letter_first', 'value', 2),
           jsonb_build_object('name', 'final_letter_last', 'value', 0)))))) then
    raise exception '0256: a well-formed correction record was refused';
  end if;

  -- ...and absence still passes, which is what keeps every extraction written before the record
  -- existed valid instead of retroactively broken.
  if not public.smart_document_extraction_normalizations_valid(v_payload) then
    raise exception '0256: an extraction predating the record was refused';
  end if;

  -- The reader resolves for a real row rather than only compiling. Any extraction will do; a
  -- database with none is a fresh one, and the SQL suite covers the populated case.
  select id into v_extraction from public.document_extractions limit 1;
  if v_extraction is not null then
    perform * from public.document_extraction_text_evidence(v_extraction);
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.document_text_evidence_violations();
  if v_violations is not null then
    raise exception e'0256 text-evidence assertions failed:\n%', v_violations;
  end if;

  -- 0182's guards, re-run here rather than three hours later in the gate. This migration's whole
  -- claim is that it added a pairing WITHOUT touching the sanitizer or the evidence-write path;
  -- `sanitized_raw_evidence_write`, `normalized_key_not_separated` and the body-hash pin on
  -- private.document_text_sanitize(text) are what turn that claim into a measurement.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.document_automation_negative_guard_violations();
  if v_violations is not null then
    raise exception e'0256 document automation guards failed:\n%', v_violations;
  end if;

  -- 0058:207-218: a migration that adds a table, a constraint or a function proves the scope
  -- contract still holds here rather than in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0256 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0256 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0256$;
