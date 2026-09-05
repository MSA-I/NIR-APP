-- P111 -- A price the reader can say, and a sum that admits when it was never measured.
--
-- QA-sweep-20260904, PR 17: DOC-08, DOC-03, DOC-02 and the DOC-04 composite. States the
-- conditions that are FALSE before migration 0324 and TRUE after it.
--
-- WHAT WAS MEASURED ON PRODUCTION, 05.09.2026, and what these fixtures reproduce. Two
-- interpretations of one supplier invoice carry 22 line items each. Every line has a printed unit
-- price, and the OCR adapter transcribes it the way the supplier prints it -- `"4.20 ש\"ח"`.
-- `private.interpretation_number` strips a space, a comma, a `₪` and the bidi marks and then
-- demands a bare number, so it returned NULL on 0 of 22... on ALL 22. Quantity parsed on 22 of 22,
-- line_total on 22 of 22. The single NULL price produced three separate falsehoods on one screen:
-- `מחיר במסמך` read `—` on every row while the same page printed `4.20 ש"ח` verbatim three panels
-- away; the accumulator (which adds only when quantity AND unit price AND line total are all
-- non-null) left `lines_net` at its initial 0 and published that 0 as a measurement, with
-- `missing_rungs: []` -- the ladder whose only job is to name the number it could not read said
-- there was none; and that fictional 0.00 was then compared with `header_net: 20720.8` and blocked
-- the document with `header_total_differs_from_lines`. Read with `private.parse_price`, all 22
-- prices parse and sum(qty x price) = 20720.70 = sum(line_total) against a header of 20720.80 --
-- a 0.10 gap, inside the ₪1 tolerance. The document that could not be approved was arithmetically
-- consistent to ten agorot.
--
-- THE GUARDED PATH, AND IT IS TWO DIFFERENT PATHS. The assessment surfaces (sections 1-3) are read
-- through `public.get_document_review_assessment`, as role `authenticated` with a real JWT subject
-- -- that function checks `auth.uid()`, `auth_org()`, `auth_role()` and `auth_scopes()`, and a read
-- performed as postgres would exercise none of them. `private.document_reconciliation_assessment`
-- itself holds NO execute for any client role and is deliberately never called directly here.
-- The filing ladder (section 4) is reached through `public.apply_document_interpretation`, which
-- grants EXECUTE to `service_role` and NOT to `authenticated` -- so it is called with no JWT, in
-- the trusted shape the Edge Function actually uses (the precedent is `p14`'s `p14_trusted`).
-- Calling it as `authenticated` would measure the missing grant, never the ladder. Every EXECUTE
-- question below is answered from `has_function_privilege`: calling a function a role holds no
-- EXECUTE on takes this Postgres image down with a segfault.
--
-- THE HARNESS ACCUMULATES; IT DOES NOT ABORT ON THE FIRST FALSE CASE. Every case is recorded in
-- `pg_temp.p111_cases` as an expected/observed PAIR, the table is printed whole, and a single
-- verdict at the end raises with the mismatches. Under `ON_ERROR_STOP` a suite that raises inside
-- its first failing assertion CANNOT show a control passing beside the failure, and "everything
-- failed" is indistinguishable from a broken harness. This change swaps a money parser used by a
-- SECURITY DEFINER writer, so the run has to show WHICH cases moved and, in the same run, that the
-- deliberate controls did not.
--
-- THE CONTROLS, named so a reader need not infer them. Marked `control` in the printed table, and
-- green BEFORE 0324 and after it:
--   * control/plain-price-still-reads       -- a bare `10.00` with no currency word. The whole risk
--                                              of swapping the parser is here: if `parse_price`
--                                              were stricter than the old reader for an ordinary
--                                              price, every working document would regress.
--   * control/comma-line-total-still-reads  -- `"1,890.00"` still reads 1890.00. `line_total` was
--                                              deliberately NOT moved to `parse_price`, and this
--                                              is the assertion on what did not change.
--   * control/header-mismatch-still-blocks  -- a document whose lines are ALL readable and really
--                                              do disagree with its header still raises
--                                              `header_total_differs_from_lines`. 0324 gates that
--                                              comparison on coverage; it must not have deleted it.
--   * control/quantity-unreadable-still-fires -- the one input of the three that already had a
--                                              voice keeps it.
--   * control/product-unidentified-still-fires -- an unmapped line still blocks.
--   * control/cross-tenant-read-refused     -- the guarded read still refuses another tenant's
--                                              document. A red here means the harness lost its
--                                              tenant, and nothing else in the run is evidence.
--   * control/filing-both-missing-unchanged -- the conjoined sentence survives for the ONE case it
--                                              was always true for: neither number nor date read.
--
-- EVERY ASSERTION IS PER ROW AND PER NAMED FIELD. Findings are compared as sorted code lists or as
-- present/absent for a NAMED code, never counted: a count of 2 passes for the wrong two.
\set ON_ERROR_STOP on

begin;

create table pg_temp.p111_cases (
  seq      int generated always as identity,
  case_id  text not null,
  kind     text not null,
  expected text not null,
  observed text not null
);

create function pg_temp.p111_case(
  p_case text, p_expected text, p_observed text, p_control boolean default false)
returns void language sql as $$
  insert into pg_temp.p111_cases (case_id, kind, expected, observed)
  values (p_case, case when p_control then 'control' else 'case' end,
          p_expected, coalesce(p_observed, '(null)'));
$$;

-- ===== Identities =====
-- `authenticated` with a real subject, which is the ONLY shape in which auth_org()/auth_role()
-- answer anything at all.
create function pg_temp.p111_become(p_sub uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_sub::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end
$$;

-- The trusted server: no JWT at all, which is how the Edge Function calls the apply command.
create function pg_temp.p111_trusted()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'none', true);
end
$$;

-- The role switch is kept OUTSIDE the exception subtransaction on purpose: PostgreSQL 17 can
-- segfault when a caught permission error unwinds `set_config('role', ...)` in the same
-- subtransaction (the precedent is p14).
create function pg_temp.p111_capture(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end
$$;

create function pg_temp.p111_error_as(p_sub uuid, p_sql text)
returns text language plpgsql as $$
declare v_message text;
begin
  perform pg_temp.p111_become(p_sub);
  v_message := pg_temp.p111_capture(p_sql);
  perform set_config('role', 'none', true);
  return v_message;
end
$$;

-- ===== The payload shapes =====
-- Built to the live interpretation contract: `line_items[].values` is where the numbers live, and
-- `fields` is an ARRAY of {key, value, confidence} -- both measured off production rather than
-- assumed. `p_price` is passed as TEXT throughout so a fixture can print `4.20 ש"ח`, `$12.50`,
-- `1,890.00` or nothing at all, exactly as an OCR adapter does.
create function pg_temp.p111_line(
  p_row integer, p_product uuid, p_qty text, p_price text, p_total text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'source_row', p_row,
    'evidence_block_ids', jsonb_build_array('block-1'),
    'values',
      jsonb_build_object('description', 'פריט ' || p_row::text)
      || case when p_product is null then '{}'::jsonb
              else jsonb_build_object('product_id', p_product::text) end
      || case when p_qty is null then '{}'::jsonb
              else jsonb_build_object('quantity', p_qty) end
      || case when p_price is null then '{}'::jsonb
              else jsonb_build_object('unit_price', p_price) end
      || case when p_total is null then '{}'::jsonb
              else jsonb_build_object('line_total', p_total) end)
$$;

create function pg_temp.p111_payload(
  p_supplier uuid, p_lines jsonb,
  p_number text, p_date text, p_net text, p_vat text, p_total text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document_type', 'invoice',
    'document_type_confidence', to_jsonb(0.99::numeric),
    'supplier', jsonb_build_object(
      'suggested_id', case when p_supplier is null then 'null'::jsonb
                           else to_jsonb(p_supplier::text) end,
      'suggested_name', to_jsonb('ספק בדיקה P111'::text),
      'confidence', to_jsonb(0.99::numeric),
      'evidence_block_ids', jsonb_build_array('block-1')),
    'fields',
      (select coalesce(jsonb_agg(f), '[]'::jsonb) from (
        select jsonb_build_object('key', 'invoice_number', 'value', p_number,
          'confidence', 0.97, 'evidence_block_ids', jsonb_build_array('block-1')) f
          where p_number is not null
        union all
        select jsonb_build_object('key', 'invoice_date', 'value', p_date,
          'confidence', 0.99, 'evidence_block_ids', jsonb_build_array('block-1'))
          where p_date is not null
        union all
        select jsonb_build_object('key', 'subtotal', 'value', p_net,
          'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2'))
          where p_net is not null
        union all
        select jsonb_build_object('key', 'vat_amount', 'value', p_vat,
          'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2'))
          where p_vat is not null
        union all
        select jsonb_build_object('key', 'total', 'value', p_total,
          'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2'))
          where p_total is not null
      ) fields),
    'line_items', p_lines,
    'packet_segments', jsonb_build_array(),
    'suggested_annotations', jsonb_build_array())
$$;

-- One document + job + extraction + interpretation: the chain the Edge Function would have left
-- behind. Returns the DOCUMENT id, which is what the guarded read is called with.
create function pg_temp.p111_seed(
  p_n integer, p_org uuid, p_user uuid, p_supplier uuid, p_payload jsonb)
returns uuid language plpgsql as $$
declare
  v_doc uuid := ('a1110000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_job uuid := ('a1110001-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_ext uuid := ('a1110002-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_int uuid := ('a1110003-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_sum text := 'etag:' || lpad(to_hex(p_n), 32, 'b');
begin
  -- A SEED HAS NO END USER, and the clearing lives HERE rather than at each call site because
  -- forgetting it once is silent until it is not: a case that read as tenant A leaves that
  -- subject on the session, and the next seed for tenant B is then a JWT-authored write for
  -- another organisation, which `audit_row_change` refuses by design
  -- (`audit_source_org_mismatch: documents`). Measured, not anticipated.
  perform pg_temp.p111_trusted();

  insert into public.documents (id, org_id, entity_type, entity_id, storage_path, file_name,
                                mime_type, uploaded_by, document_kind)
  values (v_doc, p_org, 'inbox', null, p_org::text || '/p111/' || p_n || '.pdf',
          'p111-' || p_n || '.pdf', 'application/pdf', p_user, 'invoice');

  insert into public.document_processing_jobs (id, org_id, document_id, requested_by, status,
                                               input_checksum)
  values (v_job, p_org, v_doc, p_user, 'review', v_sum);

  insert into public.document_extractions (id, org_id, job_id, document_id, engine, model,
                                           model_version, input_checksum, contract_version, payload)
  values (v_ext, p_org, v_job, v_doc, 'fixture', 'fixture-ocr', '1.0.0', v_sum, '1',
          jsonb_build_object(
            'schema_version', '1',
            'document', jsonb_build_object('page_count', 1,
              'detected_languages', jsonb_build_array('he'),
              'plain_text', 'חשבונית בדיקה P111', 'partial', false),
            'blocks', jsonb_build_array(jsonb_build_object('id', 'block-1', 'page', 1,
              'type', 'text', 'bbox', jsonb_build_array(0, 0, 1, 1),
              'text', 'ספק בדיקה P111', 'confidence', 0.94)),
            'tables', jsonb_build_array(), 'marks', jsonb_build_array()));

  -- `suggested_supplier_id` is NOT written here: it is a GENERATED column derived from
  -- `payload -> 'supplier' ->> 'suggested_id'`, and the database refuses a non-default value for
  -- it. The suggestion therefore reaches the filing ladder the only way it ever does -- through
  -- the payload the interpreter wrote -- which is also what `p111_payload` puts there.
  insert into public.document_interpretations (id, org_id, job_id, extraction_id, document_id,
                                               interpreted_for_user_id, provider, model,
                                               prompt_version, schema_version, payload)
  values (v_int, p_org, v_job, v_ext, v_doc, p_user,
          'openai', 'gpt-p111-fixture', 'interpret-document-v1', '1', p_payload);

  return v_doc;
end
$$;

-- The guarded read, as the office clerk, reduced to the one branch under test.
create function pg_temp.p111_assessment(p_sub uuid, p_doc uuid)
returns jsonb language plpgsql as $$
declare v_out jsonb;
begin
  perform pg_temp.p111_become(p_sub);
  select public.get_document_review_assessment(p_doc) -> 'assessment' into v_out;
  perform set_config('role', 'none', true);
  return v_out;
end
$$;

create function pg_temp.p111_state(p_sub uuid, p_doc uuid)
returns text language plpgsql as $$
declare v_out text;
begin
  perform pg_temp.p111_become(p_sub);
  select public.get_document_review_assessment(p_doc) ->> 'state' into v_out;
  perform set_config('role', 'none', true);
  return v_out;
end
$$;

/* Present / absent for a NAMED finding code, at document level and at line level. */
create function pg_temp.p111_has_finding(p_assessment jsonb, p_code text)
returns text language sql immutable as $$
  select case when exists (
    select 1 from jsonb_array_elements(p_assessment -> 'findings') f
    where f ->> 'code' = p_code) then 'present' else 'absent' end
$$;

create function pg_temp.p111_line_findings(p_assessment jsonb, p_index integer)
returns text language sql immutable as $$
  select coalesce((
    select string_agg(f ->> 'code', ',' order by f ->> 'code')
    from jsonb_array_elements(p_assessment -> 'lines') l,
         jsonb_array_elements(l -> 'findings') f
    where (l ->> 'line_index')::integer = p_index), '(none)')
$$;

create function pg_temp.p111_line_field(p_assessment jsonb, p_index integer, p_field text)
returns text language sql immutable as $$
  select coalesce((
    select l ->> p_field
    from jsonb_array_elements(p_assessment -> 'lines') l
    where (l ->> 'line_index')::integer = p_index), '(null)')
$$;

-- ===== Fixtures =====
-- The JWT subject is cleared for the seed writes: a fixture has no end user, and the audit
-- triggers refuse a JWT-authored write for another organisation by design.
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

insert into public.organizations (id, name, status, base_currency, vat_rate, country_code) values
  ('11110000-0000-4000-8000-000000000001', 'P111 tenant A', 'active', 'ILS', 18, 'IL'),
  ('11110000-0000-4000-8000-000000000002', 'P111 tenant B', 'active', 'ILS', 18, 'IL');

insert into auth.users (id, email) values
  ('21110000-0000-4000-8000-000000000001', 'office-p111@example.test'),
  ('21110000-0000-4000-8000-000000000002', 'owner-b-p111@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('21110000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001',
   'P111 office', 'office'),
  ('21110000-0000-4000-8000-000000000002', '11110000-0000-4000-8000-000000000002',
   'P111 tenant B owner', 'owner');

insert into public.suppliers (id, org_id, name, default_currency, country_code) values
  ('31110000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001',
   'ספק בדיקה P111', 'ILS', 'IL'),
  ('31110000-0000-4000-8000-000000000002', '11110000-0000-4000-8000-000000000002',
   'ספק בדיקה P111 B', 'ILS', 'IL');

-- Products so that a mapped line clears `product_unidentified` and the document can actually
-- reach a business record. DOC-04 asks whether a well-read document gets there at all.
insert into public.products (id, org_id, name) values
  ('41110000-0000-4000-8000-000000000001', '11110000-0000-4000-8000-000000000001', 'אורנגו'),
  ('41110000-0000-4000-8000-000000000002', '11110000-0000-4000-8000-000000000001', 'אנדיב אדום'),
  ('41110000-0000-4000-8000-000000000003', '11110000-0000-4000-8000-000000000001', 'בזיליקום');

-- The autonomy policy the filing ladder consults. Enabled with a low bar, so the ladder reaches
-- the identity arm rather than stopping above it -- the arm under test is the last one before the
-- number key, and every earlier stop would mask it.
--
-- UPSERT, not INSERT, and the difference was MEASURED rather than guessed: every organisation is
-- born carrying a `document.interpretation` row, so a plain insert dies on
-- `org_autonomy_policies_org_key` before a single case is recorded. Written as an upsert so the
-- suite states the policy it needs instead of depending on what the default happens to be today.
insert into public.org_autonomy_policies (org_id, policy_key, autonomy_enabled, min_confidence)
values ('11110000-0000-4000-8000-000000000001', 'document.interpretation', true, 0.500)
on conflict (org_id, policy_key)
  do update set autonomy_enabled = excluded.autonomy_enabled,
                min_confidence   = excluded.min_confidence;

-- ===== 0. Structural: the surfaces exist and the private readers stay shut =====
select pg_temp.p111_case(
  'structure/guarded-read-exists',
  'present, authenticated=true',
  case when to_regprocedure('public.get_document_review_assessment(uuid)') is null
       then 'absent'
       else 'present, authenticated=' || has_function_privilege('authenticated',
              'public.get_document_review_assessment(uuid)', 'EXECUTE')::text end,
  true);

select pg_temp.p111_case(
  'structure/apply-command-is-service-role-only',
  'authenticated=false service_role=true',
  'authenticated=' || has_function_privilege('authenticated',
      'public.apply_document_interpretation(uuid,uuid,uuid)', 'EXECUTE')::text
    || ' service_role=' || has_function_privilege('service_role',
      'public.apply_document_interpretation(uuid,uuid,uuid)', 'EXECUTE')::text,
  true);

select pg_temp.p111_case(
  'structure/private-readers-shut-to-clients',
  'authenticated=false anon=false',
  'authenticated=' || has_function_privilege('authenticated',
      'private.document_assessment_lines(uuid,uuid,jsonb)', 'EXECUTE')::text
    || ' anon=' || has_function_privilege('anon',
      'private.document_assessment_lines(uuid,uuid,jsonb)', 'EXECUTE')::text,
  true);

-- ===== 1. DOC-08 / DOC-03: the price printed with its currency word =====
-- Three lines exactly as production prints them: `4.20 ש"ח` at 8, `50.00 ש"ח` at 12,
-- `12.90 ש"ח` at 26. 33.60 + 600.00 + 335.40 = 969.00, which is also the header subtotal.
do $p111_shekel$
declare
  v_doc uuid;
  v_a   jsonb;
begin
  v_doc := pg_temp.p111_seed(1,
    '11110000-0000-4000-8000-000000000001', '21110000-0000-4000-8000-000000000001',
    '31110000-0000-4000-8000-000000000001',
    pg_temp.p111_payload('31110000-0000-4000-8000-000000000001', jsonb_build_array(
      pg_temp.p111_line(1, '41110000-0000-4000-8000-000000000001', '8.00', '4.20 ש"ח', '33.60'),
      pg_temp.p111_line(2, '41110000-0000-4000-8000-000000000002', '12.00', '50.00 ש"ח', '600.00'),
      pg_temp.p111_line(3, '41110000-0000-4000-8000-000000000003', '26.00', '12.90 ש"ח', '335.40')),
      'P111-1001', '2026-07-31', '969.00', '174.42', '1143.42'));

  v_a := pg_temp.p111_assessment('21110000-0000-4000-8000-000000000001', v_doc);

  -- DOC-08: the grid's `מחיר במסמך` column IS `lines[].unit_price`.
  perform pg_temp.p111_case('shekel-word/unit-price-line-0', '4.20',
    pg_temp.p111_line_field(v_a, 0, 'unit_price'));
  perform pg_temp.p111_case('shekel-word/unit-price-line-1', '50.00',
    pg_temp.p111_line_field(v_a, 1, 'unit_price'));
  perform pg_temp.p111_case('shekel-word/unit-price-line-2', '12.90',
    pg_temp.p111_line_field(v_a, 2, 'unit_price'));
  -- And the cell the document actually printed travels with it.
  perform pg_temp.p111_case('shekel-word/printed-price-line-0', '4.20 ש"ח',
    pg_temp.p111_line_field(v_a, 0, 'unit_price_printed'));

  -- DOC-03: the sum is measured, and it covered every line.
  perform pg_temp.p111_case('shekel-word/lines-net', '969.00',
    v_a #>> '{totals,lines_net}');
  perform pg_temp.p111_case('shekel-word/lines-counted', '3',
    v_a #>> '{totals,lines_counted}');
  perform pg_temp.p111_case('shekel-word/missing-rungs', '[]',
    v_a #>> '{totals,missing_rungs}');
  perform pg_temp.p111_case('shekel-word/lines-vs-header-gap', '0.00',
    v_a #>> '{totals,lines_vs_header_gap}');

  -- The block that was never true: the header does NOT differ from the lines.
  perform pg_temp.p111_case('shekel-word/no-header-mismatch-finding', 'absent',
    pg_temp.p111_has_finding(v_a, 'header_total_differs_from_lines'));
  -- The WHOLE finding list for the line, not a filter: the only thing left on it is the
  -- pre-existing `price_baseline_unknown`, a WARNING (0105) that fires on every mapped line for
  -- which this tenant holds no contracted price. Measured in the red run and stated here rather
  -- than filtered out, so a new finding appearing on this line would fail the case.
  perform pg_temp.p111_case('shekel-word/line-0-carries-only-the-baseline-warning',
    'price_baseline_unknown', pg_temp.p111_line_findings(v_a, 0));

  -- DOC-04: with the price readable and the products mapped, this document is approvable.
  perform pg_temp.p111_case('shekel-word/approval-blocked', 'false',
    v_a ->> 'approval_blocked');
  perform pg_temp.p111_case('shekel-word/state', 'ready_for_approval',
    pg_temp.p111_state('21110000-0000-4000-8000-000000000001', v_doc));
end
$p111_shekel$;

-- ===== 2. DOC-03 proper: a price that is genuinely absent =====
-- This case SURVIVES the parser fix, and it is the general defect. Line 0 is complete; line 1
-- carries a total and a quantity but no printed price at all. The sum can cover one of two lines,
-- so it is not a sum of this document and must not be published as one.
do $p111_absent$
declare
  v_doc uuid;
  v_a   jsonb;
begin
  v_doc := pg_temp.p111_seed(2,
    '11110000-0000-4000-8000-000000000001', '21110000-0000-4000-8000-000000000001',
    '31110000-0000-4000-8000-000000000001',
    pg_temp.p111_payload('31110000-0000-4000-8000-000000000001', jsonb_build_array(
      pg_temp.p111_line(1, '41110000-0000-4000-8000-000000000001', '2.00', '10.00', '20.00'),
      pg_temp.p111_line(2, '41110000-0000-4000-8000-000000000002', '3.00', null, '30.00')),
      'P111-1002', '2026-07-31', '50.00', '9.00', '59.00'));

  v_a := pg_temp.p111_assessment('21110000-0000-4000-8000-000000000001', v_doc);

  -- A metric with no data shows `—`, never `0` -- and a PARTIAL sum is no better than a zero one.
  perform pg_temp.p111_case('price-absent/lines-net-is-null', '(null)',
    coalesce(v_a #>> '{totals,lines_net}', '(null)'));
  perform pg_temp.p111_case('price-absent/lines-counted', '1',
    v_a #>> '{totals,lines_counted}');
  perform pg_temp.p111_case('price-absent/lines-vs-header-gap-is-null', '(null)',
    coalesce(v_a #>> '{totals,lines_vs_header_gap}', '(null)'));
  perform pg_temp.p111_case('price-absent/missing-rungs-names-lines-net', 'yes',
    case when (v_a #> '{totals,missing_rungs}') ? 'lines_net' then 'yes' else 'no' end);

  -- The blocking finding names the field, at the line and for the document.
  -- Sorted by code, and the pre-existing baseline warning is named alongside rather than
  -- filtered away: this is the line's complete verdict, not a search for one string in it.
  perform pg_temp.p111_case('price-absent/line-1-names-the-missing-price',
    'line_unit_price_missing,price_baseline_unknown',
    pg_temp.p111_line_findings(v_a, 1));
  perform pg_temp.p111_case('price-absent/document-says-sum-not-measured', 'present',
    pg_temp.p111_has_finding(v_a, 'lines_total_not_measured'));

  -- ...and it does NOT name a header-versus-lines mismatch it cannot support.
  perform pg_temp.p111_case('price-absent/no-header-mismatch-finding', 'absent',
    pg_temp.p111_has_finding(v_a, 'header_total_differs_from_lines'));

  -- The COMPLETE line picks up none of the new codes: this is a per-line claim, not a
  -- document-wide one, and a fix that named every line would be no better than one that named
  -- none. Only the pre-existing baseline warning remains.
  perform pg_temp.p111_case('price-absent/line-0-still-clean', 'price_baseline_unknown',
    pg_temp.p111_line_findings(v_a, 0));
end
$p111_absent$;

-- ===== 3. A price printed in a currency this document is not in =====
-- `$12.50` on an ILS document. Before 0324 `interpretation_number` returned NULL for it -- the
-- same silence as a price that was never printed. `parse_price` refuses it BY NAME, and 0298's
-- own lesson was that one code covering five failures tells a reviewer nothing.
do $p111_currency$
declare
  v_doc uuid;
  v_a   jsonb;
begin
  v_doc := pg_temp.p111_seed(3,
    '11110000-0000-4000-8000-000000000001', '21110000-0000-4000-8000-000000000001',
    '31110000-0000-4000-8000-000000000001',
    pg_temp.p111_payload('31110000-0000-4000-8000-000000000001', jsonb_build_array(
      pg_temp.p111_line(1, '41110000-0000-4000-8000-000000000001', '2.00', '$12.50', '25.00')),
      'P111-1003', '2026-07-31', '25.00', '4.50', '29.50'));

  v_a := pg_temp.p111_assessment('21110000-0000-4000-8000-000000000001', v_doc);

  perform pg_temp.p111_case('other-currency/line-0-names-unreadable',
    'line_unit_price_unreadable,price_baseline_unknown',
    pg_temp.p111_line_findings(v_a, 0));
  perform pg_temp.p111_case('other-currency/refusal-reason-is-named',
    'price_currency_mismatch', pg_temp.p111_line_field(v_a, 0, 'unit_price_refusal'));
  perform pg_temp.p111_case('other-currency/printed-cell-is-quoted',
    '$12.50', pg_temp.p111_line_field(v_a, 0, 'unit_price_printed'));
  perform pg_temp.p111_case('other-currency/lines-net-is-null', '(null)',
    coalesce(v_a #>> '{totals,lines_net}', '(null)'));
end
$p111_currency$;

-- ===== 4. The controls: what must NOT have moved =====
do $p111_controls$
declare
  v_doc uuid;
  v_a   jsonb;
begin
  -- (a) An ordinary price with no currency word, and a line total printed with a thousands
  --     comma. The whole risk of swapping the price parser lives in these two rows.
  v_doc := pg_temp.p111_seed(4,
    '11110000-0000-4000-8000-000000000001', '21110000-0000-4000-8000-000000000001',
    '31110000-0000-4000-8000-000000000001',
    pg_temp.p111_payload('31110000-0000-4000-8000-000000000001', jsonb_build_array(
      pg_temp.p111_line(1, '41110000-0000-4000-8000-000000000001', '540.00', '3.50', '1,890.00')),
      'P111-1004', '2026-07-31', '1890.00', '340.20', '2230.20'));
  v_a := pg_temp.p111_assessment('21110000-0000-4000-8000-000000000001', v_doc);

  perform pg_temp.p111_case('control/plain-price-still-reads', '3.50',
    pg_temp.p111_line_field(v_a, 0, 'unit_price'), true);
  perform pg_temp.p111_case('control/comma-line-total-still-reads', '1890.00',
    pg_temp.p111_line_field(v_a, 0, 'line_total'), true);

  -- (b) A document whose lines are all readable and really DO disagree with its header. 0324
  --     gates that comparison on coverage; it must not have removed it.
  v_doc := pg_temp.p111_seed(5,
    '11110000-0000-4000-8000-000000000001', '21110000-0000-4000-8000-000000000001',
    '31110000-0000-4000-8000-000000000001',
    pg_temp.p111_payload('31110000-0000-4000-8000-000000000001', jsonb_build_array(
      pg_temp.p111_line(1, '41110000-0000-4000-8000-000000000001', '10.00', '10.00', '100.00'),
      pg_temp.p111_line(2, '41110000-0000-4000-8000-000000000002', '10.00', '10.00', '100.00')),
      'P111-1005', '2026-07-31', '500.00', '90.00', '590.00'));
  v_a := pg_temp.p111_assessment('21110000-0000-4000-8000-000000000001', v_doc);

  perform pg_temp.p111_case('control/header-mismatch-still-blocks', 'present',
    pg_temp.p111_has_finding(v_a, 'header_total_differs_from_lines'), true);

  -- (c) The one input of the three that already had a voice keeps it, and an unmapped line still
  --     blocks. Both are pre-existing behaviour that 0324 edits around.
  v_doc := pg_temp.p111_seed(6,
    '11110000-0000-4000-8000-000000000001', '21110000-0000-4000-8000-000000000001',
    '31110000-0000-4000-8000-000000000001',
    pg_temp.p111_payload('31110000-0000-4000-8000-000000000001', jsonb_build_array(
      pg_temp.p111_line(1, '41110000-0000-4000-8000-000000000001', null, '10.00', '20.00'),
      pg_temp.p111_line(2, null, '1.00', '10.00', '10.00')),
      'P111-1006', '2026-07-31', '30.00', '5.40', '35.40'));
  v_a := pg_temp.p111_assessment('21110000-0000-4000-8000-000000000001', v_doc);

  perform pg_temp.p111_case('control/quantity-unreadable-still-fires', 'yes',
    case when pg_temp.p111_line_findings(v_a, 0) like '%quantity_unreadable%'
         then 'yes' else 'no' end, true);
  perform pg_temp.p111_case('control/product-unidentified-still-fires', 'yes',
    case when pg_temp.p111_line_findings(v_a, 1) like '%product_unidentified%'
         then 'yes' else 'no' end, true);

  -- (d) The guarded read is still guarded. A red here means the harness lost its tenant, and
  --     nothing else in this run is evidence.
  v_doc := pg_temp.p111_seed(7,
    '11110000-0000-4000-8000-000000000002', '21110000-0000-4000-8000-000000000002',
    '31110000-0000-4000-8000-000000000002',
    pg_temp.p111_payload('31110000-0000-4000-8000-000000000002', jsonb_build_array(
      pg_temp.p111_line(1, null, '1.00', '10.00', '10.00')),
      'P111-1007', '2026-07-31', '10.00', '1.80', '11.80'));

  perform pg_temp.p111_case('control/cross-tenant-read-refused', 'document_not_found',
    coalesce(pg_temp.p111_error_as('21110000-0000-4000-8000-000000000001',
      format('select public.get_document_review_assessment(%L::uuid)', v_doc)),
      '(no error -- the other tenant''s document was READ)'), true);
end
$p111_controls$;

-- ===== 5. DOC-02: the refusal names the field that is actually missing =====
-- Reached through the apply command in its trusted shape. `invoice_identity_missing` covered two
-- obstacles with one sentence, so on the sweep's invoice it announced that the invoice number was
-- missing while the same screen displayed `SI266001312` at confidence 0.95 -- and the only thing
-- actually unreadable was the date, `31/07/26`, whose year has two digits.
do $p111_filing$
declare
  v_doc  uuid;
  v_int  uuid;
  v_job  uuid;
  v_code text;
begin
  if not has_function_privilege('service_role',
       'public.apply_document_interpretation(uuid,uuid,uuid)', 'EXECUTE') then
    -- Never call a function a role holds no EXECUTE on: that denial segfaults this image.
    perform pg_temp.p111_case('filing/precondition',
      'service_role may execute the apply command', 'it may not -- section 5 not run');
    return;
  end if;

  -- (a) The number is read; the date is not. `31/07/26` is the production string verbatim.
  v_doc := pg_temp.p111_seed(11,
    '11110000-0000-4000-8000-000000000001', '21110000-0000-4000-8000-000000000001',
    '31110000-0000-4000-8000-000000000001',
    pg_temp.p111_payload('31110000-0000-4000-8000-000000000001', jsonb_build_array(
      pg_temp.p111_line(1, '41110000-0000-4000-8000-000000000001', '1.00', '10.00', '10.00')),
      'P111-2001', '31/07/26', '10.00', '1.80', '11.80'));
  select id, job_id into v_int, v_job from public.document_interpretations where document_id = v_doc;
  perform pg_temp.p111_trusted();
  perform public.apply_document_interpretation(v_job, v_int, null);
  select reason_code into v_code from public.document_filings where interpretation_id = v_int;
  perform pg_temp.p111_case('filing/date-unreadable-names-the-date',
    'invoice_date_missing', v_code);

  -- (b) The date is read; the number is not.
  v_doc := pg_temp.p111_seed(12,
    '11110000-0000-4000-8000-000000000001', '21110000-0000-4000-8000-000000000001',
    '31110000-0000-4000-8000-000000000001',
    pg_temp.p111_payload('31110000-0000-4000-8000-000000000001', jsonb_build_array(
      pg_temp.p111_line(1, '41110000-0000-4000-8000-000000000001', '1.00', '10.00', '10.00')),
      null, '2026-07-31', '10.00', '1.80', '11.80'));
  select id, job_id into v_int, v_job from public.document_interpretations where document_id = v_doc;
  perform pg_temp.p111_trusted();
  perform public.apply_document_interpretation(v_job, v_int, null);
  select reason_code into v_code from public.document_filings where interpretation_id = v_int;
  perform pg_temp.p111_case('filing/number-unreadable-names-the-number',
    'invoice_number_missing', v_code);

  -- (c) CONTROL. Neither was read: the conjoined sentence is true, and it survives.
  v_doc := pg_temp.p111_seed(13,
    '11110000-0000-4000-8000-000000000001', '21110000-0000-4000-8000-000000000001',
    '31110000-0000-4000-8000-000000000001',
    pg_temp.p111_payload('31110000-0000-4000-8000-000000000001', jsonb_build_array(
      pg_temp.p111_line(1, '41110000-0000-4000-8000-000000000001', '1.00', '10.00', '10.00')),
      null, null, '10.00', '1.80', '11.80'));
  select id, job_id into v_int, v_job from public.document_interpretations where document_id = v_doc;
  perform pg_temp.p111_trusted();
  perform public.apply_document_interpretation(v_job, v_int, null);
  select reason_code into v_code from public.document_filings where interpretation_id = v_int;
  perform pg_temp.p111_case('control/filing-both-missing-unchanged',
    'invoice_identity_missing', v_code, true);
end
$p111_filing$;

-- ===== 6. The whole table, then one verdict =====
select set_config('role', 'none', true);

select seq, case_id, kind, expected, observed,
       case when observed is not distinct from expected then 'ok' else 'FAILED' end as result
from pg_temp.p111_cases order by seq;

select count(*) filter (where observed is not distinct from expected)     as passed,
       count(*) filter (where observed is distinct from expected)         as failed,
       count(*)                                                          as total,
       count(*) filter (where kind = 'control'
                          and observed is not distinct from expected)     as controls_green,
       count(*) filter (where kind = 'control')                           as controls_total
from pg_temp.p111_cases;

do $p111_verdict$
declare
  v_failed   int;
  v_controls int;
  v_detail   text;
begin
  select count(*) filter (where observed is distinct from expected),
         count(*) filter (where kind = 'control' and observed is distinct from expected)
    into v_failed, v_controls
  from pg_temp.p111_cases;

  if v_controls > 0 then
    -- Said BEFORE the finding's own cases, because it changes what the run means: a control that
    -- moved is a harness that lost its fixtures, and nothing below it is evidence of anything.
    raise warning 'P111: % CONTROL case(s) failed -- read this run as a broken harness, not as a finding.', v_controls;
  end if;

  if v_failed > 0 then
    select string_agg(
             e'\n  ' || case_id || '  [' || kind || ']'
               || e'\n      expected: ' || expected
               || e'\n      observed: ' || observed,
             '' order by seq)
      into v_detail
    from pg_temp.p111_cases
    where observed is distinct from expected;
    raise exception 'P111 document price and coverage: % case(s) failed:%', v_failed, v_detail;
  end if;
end
$p111_verdict$;

rollback;
