-- 0314 — the database learns the name of the correction the worker already makes.
--
-- WHAT BROKE, MEASURED IN PRODUCTION ON 03.09.2026. The `0291`-`0313` rollout raised
-- `GATEWAY_CONTRACT_VERSION` from "3" to "4" on both sides, exactly as the contract rule demands,
-- and deployed both sides. The number agreed. The CONTENT did not: contract "4" exists because
-- the worker gained a second Hebrew repair, `hebrew_line_order`, and `0256`'s validator accepts
-- exactly one normalization id --
--
--     or (entry.value ->> 'id') <> 'hebrew_visual_order'
--
-- -- so every completion carrying the new correction was refused by
-- `document_extractions_normalizations_check`. The failure did not look like a failure: the
-- gateway turned the constraint violation into HTTP 503, the worker logged `poll_failed` and
-- retried, and the screen said "waiting in queue". Thirty-five consecutive polls, zero completed
-- documents, and two workers reporting `Up` the whole time.
--
-- WHY THE GATES DID NOT CATCH IT. `self_check` runs against the worker alone and proves the
-- repair works; the SQL suites run against a database with no worker; and the contract guard
-- compares the two VERSION LITERALS, which agreed. Nothing in the tree compares the SHAPE the
-- worker emits against the shape the database accepts. That gap is real and is recorded rather
-- than papered over -- see the note at the end of this file.
--
-- WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT. The id list becomes the two ids the
-- worker can emit, and NOTHING else moves: the eight-entry ceiling, the exact key set, the
-- applied/original_text pairing, the sixteen-measurement ceiling, the per-measurement shape and
-- the distinct-id rule all stand exactly as `0256` wrote them. A correction that changed the text
-- must still carry what the text was; one that changed nothing must still not carry a copy.
--
-- The two ids are alternatives, not a sequence: `worker/ocr/src/contract.py:44` states that
-- `hebrew_line_order` SUPERSEDES `hebrew_visual_order` rather than running after it. The
-- distinct-id rule already prevents one payload from claiming both, so this file adds no new
-- rule to say so.

begin;

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
         -- THE ONE LINE THAT MOVED. `hebrew_line_order` is the repair contract "4" was raised
         -- for; `hebrew_visual_order` stays because rows written before it exist and must remain
         -- valid. Still a closed list: an id the worker cannot emit is still refused.
         or (entry.value ->> 'id') not in ('hebrew_visual_order', 'hebrew_line_order')
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

-- `0256` revoked this from everybody; CREATE OR REPLACE keeps an existing ACL, and the revoke is
-- repeated so the grant state is stated by this file rather than inherited silently.
revoke all on function public.smart_document_extraction_normalizations_valid(jsonb)
  from public, anon, authenticated, service_role;

-- THE ASSERTIONS. Each one is a shape the worker really produces or really must not.
do $assert_0314$
declare
  v_line jsonb := jsonb_build_object(
    'normalizations', jsonb_build_array(jsonb_build_object(
      'id', 'hebrew_line_order', 'applied', true, 'original_text', 'טסקט',
      'measurements', jsonb_build_array(jsonb_build_object('name', 'lines_repaired', 'value', 3)))));
  v_visual jsonb := jsonb_build_object(
    'normalizations', jsonb_build_array(jsonb_build_object(
      'id', 'hebrew_visual_order', 'applied', false, 'original_text', null,
      'measurements', '[]'::jsonb)));
  v_both jsonb := jsonb_build_object(
    'normalizations', jsonb_build_array(
      jsonb_build_object('id', 'hebrew_line_order', 'applied', false, 'original_text', null,
                         'measurements', '[]'::jsonb),
      jsonb_build_object('id', 'hebrew_visual_order', 'applied', false, 'original_text', null,
                         'measurements', '[]'::jsonb)));
  v_duplicate jsonb := jsonb_build_object(
    'normalizations', jsonb_build_array(
      jsonb_build_object('id', 'hebrew_line_order', 'applied', false, 'original_text', null,
                         'measurements', '[]'::jsonb),
      jsonb_build_object('id', 'hebrew_line_order', 'applied', false, 'original_text', null,
                         'measurements', '[]'::jsonb)));
  v_unknown jsonb := jsonb_build_object(
    'normalizations', jsonb_build_array(jsonb_build_object(
      'id', 'latin_word_order', 'applied', false, 'original_text', null,
      'measurements', '[]'::jsonb)));
  v_unpaired jsonb := jsonb_build_object(
    'normalizations', jsonb_build_array(jsonb_build_object(
      'id', 'hebrew_line_order', 'applied', true, 'original_text', null,
      'measurements', '[]'::jsonb)));
begin
  -- The payload that was being refused in production.
  if not public.smart_document_extraction_normalizations_valid(v_line) then
    raise exception '0314: the new hebrew_line_order payload is still refused';
  end if;
  -- Everything `0256` already accepted must still be accepted.
  if not public.smart_document_extraction_normalizations_valid(v_visual) then
    raise exception '0314: hebrew_visual_order stopped being valid';
  end if;
  if not public.smart_document_extraction_normalizations_valid(v_both) then
    raise exception '0314: two distinct ids in one payload were refused';
  end if;
  -- NEGATIVE CONTROLS. A check that only ever says yes is not a check.
  if public.smart_document_extraction_normalizations_valid(v_duplicate) then
    raise exception '0314: a repeated id was accepted';
  end if;
  if public.smart_document_extraction_normalizations_valid(v_unknown) then
    raise exception '0314: an id the worker cannot emit was accepted';
  end if;
  if public.smart_document_extraction_normalizations_valid(v_unpaired) then
    raise exception '0314: applied=true without original_text was accepted';
  end if;
end
$assert_0314$;

-- The constraint reads the function by name, so replacing the body is enough for NEW rows. The
-- existing rows were all written under the stricter list and are therefore still valid; the
-- constraint is left validated rather than re-validated, because nothing about them changed.

commit;
