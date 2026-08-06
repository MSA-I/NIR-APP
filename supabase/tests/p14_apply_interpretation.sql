-- p14 -- the decision layer: what a model may write without a human (migration 0077).
--
-- Run against a freshly reset disposable local database after 0077. Everything is rolled back;
-- the suite never leaves business data behind.
--
-- THIS IS THE SUITE FOR THE FUNCTION THAT LETS A LANGUAGE MODEL AUTHOR A FINANCIAL RECORD.
-- Every assertion below is therefore written as "prove the write did NOT happen" wherever that
-- is the safe answer, and as "prove exactly one write happened, and that its audit row names the
-- interpretation" where the write is the point. A suite that only checked the happy path would
-- pass against a function that writes an invoice for every document it is ever handed.
--
-- What it proves, one area per paragraph:
--
--   (a) OFF MEANS ZERO. With the tenant unconfigured -- which is every tenant, by 0076's design
--       -- a 0.99-confidence perfectly-formed invoice interpretation produces no invoice, no
--       exception, and no auto-action row. This is asserted by SNAPSHOT DIFF over the financial
--       tables rather than by checking one count, because "zero writes" is the claim.
--
--   (b) THE NUMBER COMPARED IS min(document_type_confidence, supplier.confidence). C1's review
--       named this and nothing enforced it. SQL's `least()` IGNORES NULLS -- least(0.99, null)
--       is 0.99, not null -- so a null supplier confidence would have sailed over the bar on the
--       strength of the type confidence alone. Two assertions pin it: a high type confidence
--       must not carry a low supplier confidence over, and a null on either side must not carry
--       anything at all.
--
--   (c) THRESHOLD NULL IS A REFUSAL, NOT A DEFAULT. 0076 makes enabled-with-no-threshold
--       unrepresentable, so the only route to it is a mutated resolver -- which is exactly what
--       (g) builds. The refusal must be by name and must write nothing.
--
--   (d) IDEMPOTENCY. One retry of the Edge Function must not buy the supplier twice. Both
--       shapes are proven: the same interpretation replayed, and a SECOND interpretation of the
--       same document. The second is the one a naive `on conflict (interpretation_id)` key
--       misses entirely.
--
--   (e) THE COLLISION B1 FOUND, HANDLED RATHER THAN CRASHED INTO. file_document can archive a
--       document WITHOUT writing a document_filings row, so "archived" and "has a filing" are
--       independent facts. A document a human already archived must not produce an unhandled
--       document_filings_active_one violation -- and must not produce an invoice either.
--
--   (f) TENANT ISOLATION, asserted as a whole-tenant snapshot diff on tenant B rather than as a
--       row count on one table.
--
--   (g) MUTATION PROOFS. Two, and the header used to describe them wrongly -- it claimed the
--       autonomy proof strips the check out of the LIVE function body when the suite actually
--       installs a minimal stand-in that writes without consulting the switch. Both are
--       legitimate and they prove different things, so both are now named for what they are:
--       (g1) replaces the resolver with one that answers enabled-with-no-threshold, so the
--       command's INDEPENDENT refusal is the only thing left standing; (g2) replaces the command
--       with a stand-in that writes unconditionally, landing an invoice for an unconfigured
--       tenant. Both restore by savepoint rollback (the p11/p13 idiom). Stripping the arm out of
--       the live body by anchored substitution is a separate manual check, run against this
--       suite and reported, not carried here.
--
--   (h) EVERY STOP CONDITION HAS A SCENARIO. A first version of this file had 68 assertions and
--       still let four mutations survive: stops 2, 3 and 4 disabled, `not_an_invoice` disabled,
--       and a switched-off tenant archiving documents anyway while the file claimed "OFF MEANS
--       ZERO -- including zero archiving". A count of assertions is not a net. The reason codes
--       are enumerated against the function body below so a thirteenth cannot be added without
--       a test.
--
-- ANCESTRY ANCHORS ride along, because this file's whole subject is a function that consumes
-- other people's contracts:
--   * private.autonomy_policy_for_org must still be the trusted-server door (C1 finding: the
--     public evaluate_autonomy_policy always answers "off" for service_role, because auth_org()
--     is NULL there -- a silent failure that reads as "autonomy is disabled").
--   * apply_document_interpretation must be SECURITY DEFINER owned by postgres, because
--     service_role has no USAGE on schema `private` and an invoker function would fail at the
--     schema rather than at the grant.
--   * purchase_order_items must be untouched. CLAUDE.md makes unit_price a price snapshot at
--     order time; a retroactive line rewrites history the manager has already been shown.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p14_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P14 apply-interpretation assertion failed: %', p_message;
  end if;
end
$$;

-- JWT-claims stamp, the p11/p13 idiom. Role is switched with set_config rather than
-- SET LOCAL ROLE so the same helper works inside PL/pgSQL.
create function pg_temp.p14_become(p_sub uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub::text)::text, true);
  perform set_config('role', 'authenticated', true);
end
$$;

-- The trusted server: no JWT at all. This is the actual calling shape of the Edge Function, and
-- it is the shape under which auth_org() is NULL -- the whole reason C2 must read the private
-- door instead of evaluate_autonomy_policy.
create function pg_temp.p14_trusted()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'none', true);
end
$$;

create function pg_temp.p14_error(p_sub uuid, p_sql text)
returns text
language plpgsql
as $$
declare
  v_message text;
begin
  begin
    perform pg_temp.p14_become(p_sub);
    execute p_sql;
    perform set_config('role', 'none', true);
    return null;
  exception when others then
    v_message := sqlerrm;
    perform set_config('role', 'none', true);
    return v_message;
  end;
end
$$;

-- The same, but as the TRUSTED SERVER rather than as a browser role. p14_error switches to
-- `authenticated`, which holds no EXECUTE on the command at all -- so using it to probe the
-- command's own refusals would have measured the grant every time and never the guard.
create function pg_temp.p14_trusted_error(p_sql text)
returns text
language plpgsql
as $$
declare
  v_message text;
begin
  begin
    perform pg_temp.p14_trusted();
    execute p_sql;
    return null;
  exception when others then
    return sqlerrm;
  end;
end
$$;

-- The financial footprint of ONE tenant, as a single comparable string. "Zero writes" is a claim
-- about a whole surface, not about one table, so it is measured as one.
create function pg_temp.p14_footprint(p_org uuid)
returns text
language sql
stable
as $$
  select concat_ws('|',
    'inv:'   || (select count(*) from public.invoices where org_id = p_org),
    'liveinv:'|| (select count(*) from public.invoices
                   where org_id = p_org and deleted_at is null),
    'iol:'   || (select count(*) from public.invoice_order_links iol
                  join public.invoices i on i.id = iol.invoice_id where i.org_id = p_org),
    'exc:'   || (select count(*) from public.exceptions where org_id = p_org),
    'pay:'   || (select count(*) from public.payments where org_id = p_org),
    'palloc:'|| (select count(*) from public.payment_allocations where org_id = p_org),
    'fil:'   || (select count(*) from public.document_filings where org_id = p_org),
    'act:'   || (select count(*) from public.document_auto_actions where org_id = p_org),
    'poi:'   || (select count(*) from public.purchase_order_items poi
                  join public.purchase_orders po on po.id = poi.order_id
                 where po.org_id = p_org),
    'arch:'  || (select count(*) from public.documents
                  where org_id = p_org and entity_type = 'archive'),
    'filedinv:' || (select count(*) from public.documents
                     where org_id = p_org and entity_type = 'invoice')
  )
$$;

-- An interpretation payload built to the live contract (0046's
-- smart_document_interpretation_valid). Every scenario in this file differs only in the four
-- arguments that the decision actually turns on.
create function pg_temp.p14_payload(
  p_type          text,
  p_type_conf     numeric,
  p_supplier      uuid,
  p_supplier_conf numeric,
  p_fields        jsonb default null,
  p_lines         jsonb default null
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document_type', p_type,
    'document_type_confidence', to_jsonb(p_type_conf),
    'supplier', jsonb_build_object(
      'suggested_id', case when p_supplier is null then 'null'::jsonb
                          else to_jsonb(p_supplier::text) end,
      'suggested_name', to_jsonb('ספק בדיקה P14'::text),
      'confidence', to_jsonb(p_supplier_conf),
      'evidence_block_ids', jsonb_build_array('block-1')
    ),
    -- The breakdown is transcribed and RECONCILES (1000 + 180 = 1180). The command refuses to
    -- auto-apply an invoice whose parts do not add up, and refuses just as hard to derive the
    -- VAT split from organizations.vat_rate when only a total was transcribed -- that would put
    -- a tax figure the document never stated onto a record a tax authority may read.
    'fields', coalesce(p_fields, jsonb_build_array(
      jsonb_build_object('key', 'invoice_number', 'value', 'P14-1001',
        'confidence', 0.97, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'invoice_date', 'value', '03/04/2026',
        'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'subtotal', 'value', 1000,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')),
      jsonb_build_object('key', 'vat_amount', 'value', 180,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')),
      jsonb_build_object('key', 'total', 'value', 1180,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2'))
    )),
    'line_items', coalesce(p_lines, jsonb_build_array(
      jsonb_build_object('source_row', 1,
        'values', jsonb_build_object('description', 'פריט', 'quantity', 1,
                                     'unit_price', 1000, 'line_total', 1000),
        'evidence_block_ids', jsonb_build_array('block-2'))
    )),
    'suggested_annotations', jsonb_build_array()
  )
$$;

create function pg_temp.p14_extraction_payload()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 1,
      'detected_languages', jsonb_build_array('he'),
      'plain_text', 'חשבונית בדיקה P14',
      'partial', false),
    'blocks', jsonb_build_array(
      jsonb_build_object('id', 'block-1', 'page', 1, 'type', 'text',
        'bbox', jsonb_build_array(0, 0, 0.5, 0.5),
        'text', 'ספק בדיקה P14', 'confidence', 0.94),
      jsonb_build_object('id', 'block-2', 'page', 1, 'type', 'text',
        'bbox', jsonb_build_array(0.5, 0.5, 1, 1),
        'text', 'סהכ 1170', 'confidence', 0.92)),
    'tables', jsonb_build_array(),
    'marks', jsonb_build_array()
  )
$$;

-- One document + job + extraction + interpretation, the whole chain the Edge Function would
-- have produced. Returns the interpretation id, which is what C2 is called with.
create function pg_temp.p14_seed(
  p_n       integer,
  p_org     uuid,
  p_user    uuid,
  p_payload jsonb
)
returns uuid
language plpgsql
as $$
declare
  v_doc uuid := ('44000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_job uuid := ('54000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_ext uuid := ('64000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_int uuid := ('74000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_sum text := 'etag:' || lpad(to_hex(p_n), 32, 'a');
begin
  insert into public.documents (id, org_id, entity_type, entity_id, storage_path, file_name,
                                mime_type, uploaded_by)
  values (v_doc, p_org, 'inbox', null, p_org::text || '/p14/' || p_n || '.pdf',
          'p14-' || p_n || '.pdf', 'application/pdf', p_user);

  insert into public.document_processing_jobs (id, org_id, document_id, requested_by, status,
                                               input_checksum)
  values (v_job, p_org, v_doc, p_user, 'review', v_sum);

  insert into public.document_extractions (id, org_id, job_id, document_id, engine, model,
                                           model_version, input_checksum, contract_version,
                                           payload)
  values (v_ext, p_org, v_job, v_doc, 'fixture', 'fixture-ocr', '1.0.0', v_sum, '1',
          pg_temp.p14_extraction_payload());

  insert into public.document_interpretations (id, org_id, job_id, extraction_id, document_id,
                                               interpreted_for_user_id, provider, model,
                                               prompt_version, schema_version, payload)
  values (v_int, p_org, v_job, v_ext, v_doc, p_user,
          'openai', 'gpt-p14-fixture', 'interpret-document-v1', '1', p_payload);

  return v_int;
end
$$;

-- Calls the command exactly as the Edge Function does: as the trusted server, with no JWT.
create function pg_temp.p14_apply(p_interpretation uuid, p_actor uuid default null)
returns jsonb
language plpgsql
as $$
declare
  v_out jsonb;
  v_job uuid;
begin
  select job_id into v_job from public.document_interpretations where id = p_interpretation;
  perform pg_temp.p14_trusted();
  select public.apply_document_interpretation(v_job, p_interpretation, p_actor) into v_out;
  return v_out;
end
$$;

-- ===== 0. Structural proofs, before a single row exists =====

select pg_temp.p14_assert(
  to_regprocedure('public.apply_document_interpretation(uuid,uuid,uuid)') is not null,
  'apply_document_interpretation(uuid,uuid,uuid) must exist');

select pg_temp.p14_assert(
  to_regclass('public.document_auto_actions') is not null,
  'document_auto_actions -- the idempotency and reversal key -- must exist');

-- C1 finding 5, pinned. service_role has no USAGE on schema `private`, so an INVOKER function
-- granted to service_role would fail at the schema, not at the grant -- and the failure would
-- read as "autonomy is off" rather than as a bug.
select pg_temp.p14_assert(
  (select prosecdef from pg_proc
   where oid = 'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure)
  and (select rolname = 'postgres' from pg_roles r
       join pg_proc p on p.proowner = r.oid
       where p.oid = 'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure),
  'the command must be SECURITY DEFINER owned by postgres -- service_role has no USAGE on '
  || 'schema private, so an invoker function would fail at the schema, not at the grant');

select pg_temp.p14_assert(
  has_function_privilege(
    'service_role', 'public.apply_document_interpretation(uuid,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege(
    'authenticated', 'public.apply_document_interpretation(uuid,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege(
    'anon', 'public.apply_document_interpretation(uuid,uuid,uuid)', 'EXECUTE')
  and not exists (
    select 1 from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where p.oid = 'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure
      and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
  'only the trusted server may invoke the machine writer -- never a browser role, never PUBLIC');

-- C1 finding 6, pinned as an ancestry anchor. evaluate_autonomy_policy resolves through
-- auth_org(), which is NULL for the trusted server: it ALWAYS answers "off" there. A C2 that
-- read it would look correct in review and never fire in production.
-- Line comments are stripped before matching, deliberately: this must assert what the function
-- DOES, not what it says about itself. The first draft matched the raw prosrc and failed on the
-- body's own explanatory comment about the trap -- an assertion that forbids naming a mistake
-- is an assertion that punishes documenting it.
select pg_temp.p14_assert(
  (select regexp_replace(prosrc, '--[^\n]*', '', 'g') ~ 'private\.autonomy_policy_for_org'
     and regexp_replace(prosrc, '--[^\n]*', '', 'g') !~ 'evaluate_autonomy_policy'
   from pg_proc
   where oid = 'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure),
  'the command must CALL private.autonomy_policy_for_org and must never call '
  || 'evaluate_autonomy_policy -- the public door always answers "off" to the trusted server '
  || 'because auth_org() is NULL there, which is a silent failure that reads as "disabled"');

-- The new table is a tenant table and must be registered, or A1 would have failed the
-- migration. Asserted here too so a later "cleanup" of the registry is caught by this suite.
select pg_temp.p14_assert(
  (select scope_class = 'derived' and not enforced
   from private.scope_registry where table_name = 'document_auto_actions'),
  'document_auto_actions must be registered derived/unenforced, like every document_* sibling');

select pg_temp.p14_assert(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'public.document_auto_actions'::regclass),
  'document_auto_actions must have RLS enabled AND forced');

select pg_temp.p14_assert(
  exists (
    select 1 from pg_policy
    where polrelid = 'public.document_auto_actions'::regclass
      and pg_get_expr(polqual, polrelid) like '%auth_org()%'),
  'document_auto_actions RLS must filter on auth_org()');

select pg_temp.p14_assert(
  not exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_auto_actions'::regclass and contype = 'f'
      and confrelid <> 'public.organizations'::regclass
      and pg_get_constraintdef(oid) not like 'FOREIGN KEY (org_id,%'),
  'every auto-action FK to a tenant-scoped parent must lead with org_id');

select pg_temp.p14_assert(
  has_table_privilege('authenticated', 'public.document_auto_actions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.document_auto_actions', 'INSERT')
  and not has_table_privilege('authenticated', 'public.document_auto_actions', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.document_auto_actions', 'DELETE'),
  'the reversal ledger must be browser-read-only');

-- THE IDEMPOTENCY KEY IS A CONSTRAINT, NOT A CODE PATH. A key that lives only inside the
-- function body is defeated by any concurrent second call; the index is what makes "one retry
-- must not buy the supplier twice" true under real concurrency.
select pg_temp.p14_assert(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'document_auto_actions'
      and indexdef like 'CREATE UNIQUE INDEX%'
      and indexdef like '%interpretation_id%'),
  'one interpretation may produce at most one automatic action -- and that must be an index');

select pg_temp.p14_assert(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'document_auto_actions'
      and indexdef like 'CREATE UNIQUE INDEX%'
      and indexdef like '%document_id%'
      and indexdef like '%reverted_at IS NULL%'),
  'one LIVE automatic action per document -- a second interpretation of the same document must '
  || 'not be able to buy the same goods twice, and an index is what makes that structural');

-- A5 of 0057: a SECURITY DEFINER function naming enforced tables (documents, invoices,
-- purchase_orders) must be scope-aware or hold an exemption row.
select pg_temp.p14_assert(
  exists (
    select 1 from private.scope_definer_exemptions
    where function_signature like 'apply_document_interpretation(%'),
  'the command must carry its A5 exemption row with a stated reason');

-- ===== Fixtures =====
-- Tenant B exists to be the ISOLATION WITNESS and is deliberately never applied to until the
-- mutation proof at the very end -- so any change to its footprint is, by construction, leakage
-- from tenant A. Tenant D is the second unconfigured tenant, for the scenarios that must apply
-- somewhere switched-off without disturbing that witness. (An earlier version used tenant B for
-- both and the isolation assertion went red for an entirely legitimate reason, which is the
-- assertion doing its job.)
insert into organizations (id, name, status) values
  ('14000000-0000-4000-8000-000000000001', 'P14 tenant A', 'active'),
  ('14000000-0000-4000-8000-000000000002', 'P14 tenant B', 'active'),
  ('14000000-0000-4000-8000-000000000003', 'P14 suspended tenant', 'suspended'),
  ('14000000-0000-4000-8000-000000000004', 'P14 tenant D', 'active');

insert into auth.users (id, email) values
  ('24000000-0000-4000-8000-000000000001', 'p14-owner-a@example.test'),
  ('24000000-0000-4000-8000-000000000002', 'p14-owner-b@example.test'),
  ('24000000-0000-4000-8000-000000000003', 'p14-owner-c@example.test'),
  ('24000000-0000-4000-8000-000000000004', 'p14-owner-d@example.test'),
  ('24000000-0000-4000-8000-000000000010', 'p14-platform-op@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('24000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001',
   'P14 Owner A', 'owner'),
  ('24000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-000000000002',
   'P14 Owner B', 'owner'),
  ('24000000-0000-4000-8000-000000000003', '14000000-0000-4000-8000-000000000003',
   'P14 Owner C', 'owner'),
  ('24000000-0000-4000-8000-000000000004', '14000000-0000-4000-8000-000000000004',
   'P14 Owner D', 'owner');

insert into platform_admins (user_id, note) values
  ('24000000-0000-4000-8000-000000000010', 'P14 platform operator fixture');

insert into suppliers (id, org_id, name) values
  ('34000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001',
   'ספק בדיקה P14 א'),
  ('34000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-000000000002',
   'ספק בדיקה P14 ב'),
  ('34000000-0000-4000-8000-000000000003', '14000000-0000-4000-8000-000000000003',
   'ספק בדיקה P14 ג'),
  ('34000000-0000-4000-8000-000000000004', '14000000-0000-4000-8000-000000000004',
   'ספק בדיקה P14 ד');

-- The grant table above says a browser role cannot invoke the machine writer. A grant table is
-- not a demonstration (the p13:260-262 lesson), so here is the call itself. A non-existent
-- interpretation id is deliberate: privilege is checked ahead of row visibility, so this probes
-- the EXECUTE grant rather than the function's own guards.
select pg_temp.p14_assert(
  pg_temp.p14_error(
    '24000000-0000-4000-8000-000000000001',
    $$select public.apply_document_interpretation(
        '00000000-0000-4000-8000-000000000000',
        '00000000-0000-4000-8000-000000000000', null)$$
  ) like '%permission denied for function apply_document_interpretation%',
  'a tenant owner must be refused at the EXECUTE grant, by name -- the owner of a business does '
  || 'not get to invoke the machine writer directly');

-- ===== (a) OFF MEANS ZERO =====
-- Tenant A is UNCONFIGURED at this point, which is the state of every tenant in the world by
-- 0076's design. A flawless 0.99 invoice interpretation must therefore move nothing at all.
select pg_temp.p14_seed(
  1, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.99));

create temporary table p14_footprint_before as
select pg_temp.p14_footprint('14000000-0000-4000-8000-000000000001') as a,
       pg_temp.p14_footprint('14000000-0000-4000-8000-000000000002') as b;

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000001') ->> 'outcome'
    = 'queued_for_review',
  'with autonomy unconfigured, a 0.99 interpretation must be queued for a human');

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000001') ->> 'reason_code'
    = 'autonomy_disabled',
  'the queue reason must NAME the autonomy switch, not merely be "not applied"');

select pg_temp.p14_assert(
  (select pg_temp.p14_footprint('14000000-0000-4000-8000-000000000001') = a
     from p14_footprint_before)
  or (select pg_temp.p14_footprint('14000000-0000-4000-8000-000000000001')
        = replace(a, 'fil:0', 'fil:1') from p14_footprint_before),
  'with the switch off the ONLY thing that may change is the filing row that records the '
  || 'system''s decision -- zero invoices, zero exceptions, zero auto-actions');

select pg_temp.p14_assert(
  (select count(*) = 0 from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000001')
  and (select count(*) = 0 from public.document_auto_actions
        where org_id = '14000000-0000-4000-8000-000000000001'),
  'the switch being off must mean ZERO invoices and ZERO auto-actions, stated plainly');

-- The queued filing is the system saying "I looked and did not decide", which is what
-- decided_by='system' means. It is not a financial write.
select pg_temp.p14_assert(
  exists (
    select 1 from public.document_filings
    where org_id = '14000000-0000-4000-8000-000000000001'
      and document_id = '44000000-0000-4000-8000-000000000001'
      and decided_by = 'system' and reverted_at is null
      and interpretation_id = '74000000-0000-4000-8000-000000000001'),
  'a queued document must still carry the system''s filing record, decided_by=system');

-- ===== Switch tenant A on, through the ONE reasoned write path =====
select set_config('request.jwt.claim.sub', '24000000-0000-4000-8000-000000000010', true);
select set_config('request.jwt.claims',
  jsonb_build_object('sub', '24000000-0000-4000-8000-000000000010')::text, true);
select public.platform_set_autonomy_policy(
  '14000000-0000-4000-8000-000000000001', 'document.interpretation',
  true, 0.900, 'P14: tenant A enabled at the documented floor');
select public.platform_set_autonomy_policy(
  '14000000-0000-4000-8000-000000000003', 'document.interpretation',
  true, 0.900, 'P14: suspended tenant enabled, to prove status still stops it');
select pg_temp.p14_trusted();

-- ===== (b) THE NUMBER COMPARED IS min(type, supplier) =====
-- SQL's least() IGNORES NULLS: least(0.99, null) is 0.99. A function that used it would let a
-- confident TYPE guess carry an unknown SUPPLIER over the bar -- and the supplier is the half
-- that decides whose money moves.
select pg_temp.p14_seed(
  2, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.42));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000002') ->> 'outcome'
    = 'queued_for_review',
  'a 0.99 document-type confidence must NOT carry a 0.42 supplier confidence over the bar');

select pg_temp.p14_assert(
  (pg_temp.p14_apply('74000000-0000-4000-8000-000000000002') ->> 'decision_confidence')::numeric
    = 0.42,
  'the number the decision reports must be the MINIMUM of the two, not either one alone');

select pg_temp.p14_assert(
  (select count(*) = 0 from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000001'),
  'below the bar, no invoice exists');

-- The null half. This is the exact shape least() would have swallowed.
select pg_temp.p14_seed(
  3, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', null));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000003') ->> 'outcome'
    = 'queued_for_review'
  and (pg_temp.p14_apply('74000000-0000-4000-8000-000000000003')
         -> 'decision_confidence') = 'null'::jsonb,
  'an UNKNOWN supplier confidence must resolve to an unknown decision confidence and queue -- '
  || 'least(0.99, null) is 0.99 in SQL, and that is the bug this assertion exists to catch');

-- ===== (h) supplier.suggested_id null: the system does not guess whose money this is =====
select pg_temp.p14_seed(
  4, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, null, 0.99));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000004') ->> 'outcome'
    = 'queued_for_review'
  and pg_temp.p14_apply('74000000-0000-4000-8000-000000000004') ->> 'reason_code'
    = 'supplier_unidentified',
  'an unidentified supplier must queue BY NAME even at 0.99 -- there is nothing to attach the '
  || 'money to, and picking the likeliest supplier is exactly the guess this forbids');

-- ===== (i) document_type = other: archived, with ZERO financial writes =====
select pg_temp.p14_seed(
  5, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('other', 0.99, '34000000-0000-4000-8000-000000000001', 0.99));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000005') ->> 'outcome' = 'archived',
  'a document the model calls "other" must be archived, not queued and not invoiced');

select pg_temp.p14_assert(
  (select entity_type = 'archive' and entity_id is null from public.documents
    where id = '44000000-0000-4000-8000-000000000005'),
  'the archived document must actually be in the archive, carrying no entity');

select pg_temp.p14_assert(
  (select count(*) = 0 from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000001')
  and (select count(*) = 0 from public.document_auto_actions
        where org_id = '14000000-0000-4000-8000-000000000001'),
  'archiving is not a financial act: zero invoices, zero auto-actions');

select pg_temp.p14_assert(
  exists (
    select 1 from public.document_filings
    where document_id = '44000000-0000-4000-8000-000000000005'
      and category = 'other' and decided_by = 'system' and reverted_at is null),
  'the archive decision must be recorded as a filing, with the category the model chose');

-- The archive write must be auditable and must NOT be attributed to a person. A machine that
-- files under a human's user_id is a machine that cannot be told apart from that human later.
select pg_temp.p14_assert(
  exists (
    select 1 from audit_logs
    where entity_type = 'documents'
      and entity_id = '44000000-0000-4000-8000-000000000005'
      and user_id is null
      and reason like '%74000000-0000-4000-8000-000000000005%'),
  'the archive must write an audit row that names the interpretation and claims NO human actor');

-- ===== (c) THE HAPPY PATH: exactly one invoice, and an audit that names the interpretation ===
select pg_temp.p14_seed(
  6, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.97, '34000000-0000-4000-8000-000000000001', 0.95));

-- Applied WITH an actor id, the shape C4 will call it in: the uploader's profile travels in as
-- provenance. Every other scenario in this file passes null, so both paths are exercised.
select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000006',
                    '24000000-0000-4000-8000-000000000001') ->> 'outcome' = 'auto_applied',
  'above the bar with every condition met, the system writes the invoice');

select pg_temp.p14_assert(
  (select count(*) = 1 from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000001' and deleted_at is null),
  'EXACTLY one invoice -- not two, and not zero');

select pg_temp.p14_assert(
  (select supplier_id = '34000000-0000-4000-8000-000000000001'
      and invoice_number = 'P14-1001'
      and invoice_date = date '2026-04-03'
      and amount_before_vat = 1000 and vat_amount = 180 and total_amount = 1180
    from public.invoices where org_id = '14000000-0000-4000-8000-000000000001'),
  'the invoice must carry the supplier, number, day-first date and the RECONCILING breakdown '
  || 'the model transcribed -- 03/04/2026 is 3 April, the Israeli day-first convention');

-- The machine creates the record; it does not approve it. Approval is a separate reasoned
-- command with its own role check, and auto-approving would carry the machine's authority
-- straight into the payment path.
select pg_temp.p14_assert(
  (select review_status = 'received' and payment_status = 'unpaid'
     from public.invoices where org_id = '14000000-0000-4000-8000-000000000001'),
  'an automatically created invoice must land in "received", never approved');

-- THE AUDIT REASON IS A CONTRACT, NOT DECORATION. A human reading audit_logs a year from now
-- must be able to reconstruct why a machine created this record: which model, which prompt,
-- which interpretation, and the confidence that justified it.
select pg_temp.p14_assert(
  exists (
    select 1 from audit_logs
    where org_id = '14000000-0000-4000-8000-000000000001'
      and entity_type = 'invoices'
      and action = 'invoice_created_by_interpretation'
      and reason like '%74000000-0000-4000-8000-000000000006%'
      and reason like '%gpt-p14-fixture%'
      and reason like '%interpret-document-v1%'
      and reason like '%0.95%'),
  'the audit reason must carry model, prompt version, interpretation id and the confidence that '
  || 'justified the write -- all four, or the row cannot be reconstructed');

select pg_temp.p14_assert(
  (select user_id is null from audit_logs
    where entity_type = 'invoices' and action = 'invoice_created_by_interpretation'),
  'the machine must not sign a human''s name to the invoice it created');

-- WHO SET THE PIPELINE RUNNING IS NOT WHO DECIDED, and the two must live in different places.
-- p_actor_id -- the person whose upload started this -- belongs in the decision record. It must
-- never reach audit_logs.user_id, because "Moshe uploaded a document" and "Moshe decided to
-- create this invoice" are different claims and only the first is true.
select pg_temp.p14_assert(
  (select new_values ->> 'triggered_by' = '24000000-0000-4000-8000-000000000001'
     from audit_logs
    where entity_type = 'invoices' and action = 'invoice_created_by_interpretation'),
  'the decision record must name who set the pipeline running');

select pg_temp.p14_assert(
  (select decision ->> 'triggered_by' = '24000000-0000-4000-8000-000000000001'
     from public.document_auto_actions
    where document_id = '44000000-0000-4000-8000-000000000006'),
  'and the reversal record must carry it too, so a reviewer knows whose upload caused this');

-- An actor from ANOTHER tenant, or one that does not exist, must not be stamped onto the record.
-- The parameter arrives from an Edge Function; an unvalidated uuid here would be a free-text
-- provenance field that says whatever the caller wants.
select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000002',
                    '24000000-0000-4000-8000-000000000002') -> 'triggered_by' = 'null'::jsonb,
  'an actor who is not a profile of THIS tenant must resolve to null, never be echoed back');

select pg_temp.p14_assert(
  (select count(*) = 1 from public.document_auto_actions
    where org_id = '14000000-0000-4000-8000-000000000001'
      and document_id = '44000000-0000-4000-8000-000000000006'
      and outcome = 'auto_applied' and reverted_at is null),
  'the auto-action row -- the idempotency and reversal key -- must exist exactly once');

select pg_temp.p14_assert(
  (select entity_type = 'invoice' and entity_id is not null
     from public.documents where id = '44000000-0000-4000-8000-000000000006'),
  'the document must be filed to the invoice the system just created for it, or the gallery '
  || 'keeps showing it as unfiled while its invoice already exists');

-- ===== (d) IDEMPOTENCY, both shapes =====
-- Shape one: the Edge Function retried. Same interpretation, second call.
select pg_temp.p14_assert(
  (pg_temp.p14_apply('74000000-0000-4000-8000-000000000006') ->> 'idempotent')::boolean,
  'a replay of the same interpretation must report itself idempotent');

select pg_temp.p14_assert(
  (select count(*) = 1 from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000001' and deleted_at is null)
  and (select count(*) = 1 from public.document_auto_actions
        where org_id = '14000000-0000-4000-8000-000000000001'),
  'ONE retry must not buy the supplier twice -- still exactly one invoice, one auto-action');

-- Shape two: a SECOND interpretation of the SAME document. This is the shape an idempotency key
-- of (interpretation_id) alone misses completely, and it is the realistic one: a person
-- re-runs interpretation on a document that already produced an invoice.
insert into public.document_processing_jobs (id, org_id, document_id, requested_by, status,
                                             input_checksum)
values ('54000000-0000-4000-8000-000000000106', '14000000-0000-4000-8000-000000000001',
        '44000000-0000-4000-8000-000000000006', '24000000-0000-4000-8000-000000000001',
        'review', 'etag:' || lpad(to_hex(106), 32, 'b'));
insert into public.document_extractions (id, org_id, job_id, document_id, engine, model,
                                         model_version, input_checksum, contract_version, payload)
values ('64000000-0000-4000-8000-000000000106', '14000000-0000-4000-8000-000000000001',
        '54000000-0000-4000-8000-000000000106', '44000000-0000-4000-8000-000000000006',
        'fixture', 'fixture-ocr', '1.0.0', 'etag:' || lpad(to_hex(106), 32, 'b'), '1',
        pg_temp.p14_extraction_payload());
insert into public.document_interpretations (id, org_id, job_id, extraction_id, document_id,
                                             interpreted_for_user_id, provider, model,
                                             prompt_version, schema_version, payload)
values ('74000000-0000-4000-8000-000000000106', '14000000-0000-4000-8000-000000000001',
        '54000000-0000-4000-8000-000000000106', '64000000-0000-4000-8000-000000000106',
        '44000000-0000-4000-8000-000000000006', '24000000-0000-4000-8000-000000000001',
        'openai', 'gpt-p14-fixture', 'interpret-document-v1', '1',
        pg_temp.p14_payload('invoice', 0.98, '34000000-0000-4000-8000-000000000001', 0.98));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000106') ->> 'outcome' = 'already_decided',
  'a SECOND interpretation of a document that already has a live decision must be refused, '
  || 'not applied -- this is the shape a (interpretation_id) key alone misses');

select pg_temp.p14_assert(
  (select count(*) = 1 from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000001' and deleted_at is null),
  're-interpreting a document must not create a second invoice for the same goods');

-- ===== (e) THE COLLISION B1 FOUND =====
-- file_document can archive a document WITHOUT writing a document_filings row, so "archived"
-- and "has a filing" are independent facts, and a human archive leaves an active filing behind
-- only sometimes. Either way the command must HANDLE the collision: not crash into
-- document_filings_active_one, and not write an invoice for a document a person already judged.
--
-- Case 1: a human archived through file_document, leaving NO filing row.
select pg_temp.p14_seed(
  7, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.99));

select pg_temp.p14_become('24000000-0000-4000-8000-000000000001');
select public.file_document('44000000-0000-4000-8000-000000000007', 'archive', null,
  'P14: a person decided this belongs in the archive');
select pg_temp.p14_trusted();

select pg_temp.p14_assert(
  (select count(*) = 0 from public.document_filings
    where document_id = '44000000-0000-4000-8000-000000000007'),
  'B1 finding 1, pinned: file_document archives WITHOUT writing a filing row');

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000007') ->> 'outcome' = 'already_decided',
  'a document a human already archived must be left alone -- the model does not overrule a '
  || 'person who already decided');

select pg_temp.p14_assert(
  (select count(*) = 1 from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000001' and deleted_at is null)
  and (select entity_type = 'archive' from public.documents
        where id = '44000000-0000-4000-8000-000000000007'),
  'no invoice was created for the human-archived document, and it stayed archived');

-- Case 2: an ACTIVE filing already exists on an inbox document. This is the direct
-- document_filings_active_one collision. B1's live footgun was an ON CONFLICT DO UPDATE here,
-- which took the conflict branch and REVERTED the existing active filing, leaving the document
-- with a reverted filing and no active one -- with every guard held and nothing detecting it.
select pg_temp.p14_seed(
  8, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.99));

insert into public.document_filings (org_id, document_id, category, decided_by, confidence)
values ('14000000-0000-4000-8000-000000000001', '44000000-0000-4000-8000-000000000008',
        'delivery_note', 'user', null);

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000008') ->> 'outcome' = 'already_decided',
  'an existing ACTIVE filing must be handled, not crashed into');

select pg_temp.p14_assert(
  (select decided_by = 'user' and reverted_at is null and category = 'delivery_note'
     from public.document_filings
    where document_id = '44000000-0000-4000-8000-000000000008'),
  'B1 live footgun, pinned: the person''s filing must still be ACTIVE and unmodified -- an '
  || 'ON CONFLICT DO UPDATE here reverts it and leaves the document with no active filing at '
  || 'all, and every guard holds while it happens');

select pg_temp.p14_assert(
  (select count(*) = 1 from public.document_filings
    where document_id = '44000000-0000-4000-8000-000000000008'),
  'and no second filing row was written beside it');

-- ===== (j) the org must be trial/active (interpret-document/index.ts:356-361) =====
select pg_temp.p14_seed(
  9, '14000000-0000-4000-8000-000000000003', '24000000-0000-4000-8000-000000000003',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000003', 0.99));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000009') ->> 'reason_code'
    = 'organization_inactive',
  'a suspended organization must be refused BY NAME even with autonomy switched on at 0.99');

select pg_temp.p14_assert(
  (select count(*) = 0 from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000003'),
  'a suspended organization gets no automatic invoice');

-- ===== (k) THE BREAKDOWN MUST COME FROM THE DOCUMENT AND MUST ADD UP =====
-- create_invoice enforces exactly this for the human path (invoice_amounts_invalid). The two
-- alternatives were both rejected: deriving the split from organizations.vat_rate writes a VAT
-- figure the document never stated onto a record a tax authority may read, and storing 0/0/total
-- is the same false claim in a different column.
select pg_temp.p14_seed(
  12, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.99,
    jsonb_build_array(
      jsonb_build_object('key', 'invoice_number', 'value', 'P14-ONLY-TOTAL',
        'confidence', 0.97, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'invoice_date', 'value', '2026-04-05',
        'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'total', 'value', 1180,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')))));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000012') ->> 'reason_code'
    = 'amounts_unreconciled',
  'a total with no transcribed VAT breakdown must queue BY NAME -- the split is not derived '
  || 'from the organization VAT rate, because the document did not state it');

-- ===== (l) THE ORDER LINK, AND THE UNORDERED ITEM AS AN EXCEPTION =====
-- The interpretation contract carries NO order reference (interpret-document/core.ts:123-174),
-- so the only honest link is a number the model transcribed off the page that resolves to
-- exactly one order of THAT supplier. And the unordered item goes onto the exception, never
-- onto purchase_order_items -- unit_price is a price snapshot at order time and price_history
-- derives from it, so a retroactive line rewrites analyses already shown to the manager.
-- org_id is spelled out on every row: purchase_order_items.org_id DEFAULTS to auth_org(), which
-- is NULL for this trusted session, so relying on the default fails with a not-null violation.
insert into public.products (id, org_id, name, unit, sku, barcode) values
  ('84000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001',
   'עגבניות שרי', 'ק"ג', 'SKU-ORDERED', '7290000000001');

insert into public.purchase_orders (id, org_id, supplier_id, status)
values ('94000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001',
        '34000000-0000-4000-8000-000000000001', 'sent');

insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price)
values ('a4000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001',
        '94000000-0000-4000-8000-000000000001',
        '84000000-0000-4000-8000-000000000001', 10, 12.50);

select pg_temp.p14_seed(
  13, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.99,
    jsonb_build_array(
      jsonb_build_object('key', 'invoice_number', 'value', 'P14-WITH-ORDER',
        'confidence', 0.97, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'invoice_date', 'value', '06/04/2026',
        'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'order_number',
        'value', (select number from public.purchase_orders
                   where id = '94000000-0000-4000-8000-000000000001'),
        'confidence', 0.93, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'subtotal', 'value', 200,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')),
      jsonb_build_object('key', 'vat_amount', 'value', 36,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')),
      jsonb_build_object('key', 'total', 'value', 236,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2'))),
    jsonb_build_array(
      -- One line that WAS ordered, matched on SKU.
      jsonb_build_object('source_row', 1,
        'values', jsonb_build_object('sku', 'sku-ordered', 'description', 'עגבניות שרי',
                                     'quantity', 10, 'line_total', 125),
        'evidence_block_ids', jsonb_build_array('block-2')),
      -- One line that was NOT. This is Moshe's "פריט חסר".
      jsonb_build_object('source_row', 2,
        'values', jsonb_build_object('sku', 'SKU-SURPRISE', 'description', 'מלפפונים',
                                     'quantity', 5, 'line_total', 75),
        'evidence_block_ids', jsonb_build_array('block-2')),
      -- One line with NO identifier at all. It must be SKIPPED, not guessed at: a false
      -- "you did not order this" trains the manager to dismiss the exception.
      jsonb_build_object('source_row', 3,
        'values', jsonb_build_object('description', 'משלוח', 'line_total', 0),
        'evidence_block_ids', jsonb_build_array('block-2')))));

create temporary table p14_order_items_before as
select count(*) as n from public.purchase_order_items poi
  join public.purchase_orders po on po.id = poi.order_id
 where po.org_id = '14000000-0000-4000-8000-000000000001';

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000013') ->> 'outcome' = 'auto_applied',
  'a document naming its order must still auto-apply');

select pg_temp.p14_assert(
  exists (
    select 1 from public.invoice_order_links iol
    join public.invoices i on i.id = iol.invoice_id
    where i.invoice_number = 'P14-WITH-ORDER'
      and iol.order_id = '94000000-0000-4000-8000-000000000001'),
  'the invoice must be linked to the order the document named');

-- THE THREE FACTS OF TASK C4, ASSERTED TOGETHER because the whole point is that they hold at
-- once: the invoice exists, the exception is open, and the order is untouched.
select pg_temp.p14_assert(
  (select count(*) = 1 from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000001'
      and invoice_number = 'P14-WITH-ORDER' and deleted_at is null),
  'the invoice for the document with an unordered item is still created');

select pg_temp.p14_assert(
  exists (
    select 1 from public.exceptions
    where org_id = '14000000-0000-4000-8000-000000000001'
      and type = 'receipt_mismatch' and status = 'open'
      and details ->> 'code' = 'item_not_ordered'
      and details -> 'items' @> jsonb_build_array(jsonb_build_object('sku', 'SKU-SURPRISE'))),
  'an exception must be OPEN against the order, naming the item that was not ordered');

select pg_temp.p14_assert(
  (select jsonb_array_length(details -> 'items') = 1 from public.exceptions
    where org_id = '14000000-0000-4000-8000-000000000001'
      and details ->> 'code' = 'item_not_ordered'),
  'the ordered line must NOT be reported (SKU matching is case-insensitive), and the line with '
  || 'no identifier must be SKIPPED rather than guessed at');

select pg_temp.p14_assert(
  (select n from p14_order_items_before)
    = (select count(*) from public.purchase_order_items poi
         join public.purchase_orders po on po.id = poi.order_id
        where po.org_id = '14000000-0000-4000-8000-000000000001'),
  'purchase_order_items count before = count after. unit_price is a price snapshot at order '
  || 'time and price_history derives from it; a retroactive line rewrites history the manager '
  || 'has already been shown');

-- ===== (h) THE STOPS THAT HAD NO SCENARIO =====
-- A mutation sweep against the first version of this suite showed stops 2, 3 and 4 could each be
-- deleted outright with every assertion still green. What follows is the net.

-- --- Stop 2: no total. An invoice without an amount is not an invoice. ---
select pg_temp.p14_seed(
  20, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.99,
    jsonb_build_array(
      jsonb_build_object('key', 'invoice_number', 'value', 'P14-NO-TOTAL',
        'confidence', 0.97, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'invoice_date', 'value', '07/04/2026',
        'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1')))));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000020') ->> 'reason_code' = 'total_missing',
  'stop 2: a document with no total must queue BY NAME');

-- A total the model transcribed as unparseable text is the same absence, not a zero.
select pg_temp.p14_seed(
  21, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.99,
    jsonb_build_array(
      jsonb_build_object('key', 'invoice_number', 'value', 'P14-BAD-TOTAL',
        'confidence', 0.97, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'invoice_date', 'value', '07/04/2026',
        'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'total', 'value', 'לא ברור',
        'confidence', 0.4, 'evidence_block_ids', jsonb_build_array('block-2')))));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000021') ->> 'reason_code' = 'total_missing',
  'stop 2: a non-numeric total is MISSING, never 0');

-- --- m-1: the machine path must not be weaker than the human one on amounts ---
-- create_invoice refuses negative parts (0023:1722-1725). before=-1000, vat=2180, total=1180
-- reconciles perfectly and was measured auto-applying before this assertion existed.
select pg_temp.p14_seed(
  22, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.99,
    jsonb_build_array(
      jsonb_build_object('key', 'invoice_number', 'value', 'P14-NEGATIVE-PART',
        'confidence', 0.97, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'invoice_date', 'value', '07/04/2026',
        'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'subtotal', 'value', -1000,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')),
      jsonb_build_object('key', 'vat_amount', 'value', 2180,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')),
      jsonb_build_object('key', 'total', 'value', 1180,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')))));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000022') ->> 'reason_code'
    = 'amounts_unreconciled',
  'a negative component that happens to sum correctly must still be refused -- the machine path '
  || 'must never be weaker than create_invoice on the check its own comment cites');

-- --- Stop 3: the duplicate, and the invisible characters that used to walk through it ---
-- THE CRITICAL DEFECT THIS SUITE MISSED. btrim(text) strips SPACES ONLY. Measured against a
-- live invoice under the same number: a trailing RLM, a trailing TAB and a leading NBSP each
-- produced auto_applied -- four live invoices under one human-readable number for one supplier,
-- with no human in the loop, and invoices_org_live_duplicate_key_idx is a PLAIN index, so there
-- is no database backstop. Every variant is exercised; none may be dropped as redundant,
-- because each one is a different reason the old predicate failed.
insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date, amount_before_vat, vat_amount,
  total_amount)
values ('b4000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001',
        '34000000-0000-4000-8000-000000000001', 'PZ-DUP-1', date '2026-04-01', 1000, 180, 1180);

create function pg_temp.p14_dup_variant(p_n integer, p_number text)
returns text
language plpgsql
as $$
declare
  v_int uuid;
begin
  v_int := pg_temp.p14_seed(
    p_n, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
    pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.99,
      jsonb_build_array(
        jsonb_build_object('key', 'invoice_number', 'value', p_number,
          'confidence', 0.97, 'evidence_block_ids', jsonb_build_array('block-1')),
        jsonb_build_object('key', 'invoice_date', 'value', '08/04/2026',
          'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1')),
        jsonb_build_object('key', 'subtotal', 'value', 1000,
          'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')),
        jsonb_build_object('key', 'vat_amount', 'value', 180,
          'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')),
        jsonb_build_object('key', 'total', 'value', 1180,
          'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')))));
  return coalesce(pg_temp.p14_apply(v_int) ->> 'reason_code', 'NONE');
end
$$;

select pg_temp.p14_assert(
  pg_temp.p14_dup_variant(30, '  PZ-DUP-1 ') = 'duplicate_invoice_number',
  'stop 3: plain surrounding spaces must be caught (this one always was)');

select pg_temp.p14_assert(
  pg_temp.p14_dup_variant(31, 'PZ-DUP-1' || chr(8207)) = 'duplicate_invoice_number',
  'stop 3: a trailing U+200F RIGHT-TO-LEFT MARK must be caught -- measured auto_applied before '
  || 'the fix, in an RTL product where that character arrives constantly');

select pg_temp.p14_assert(
  pg_temp.p14_dup_variant(32, 'PZ-DUP-1' || chr(9)) = 'duplicate_invoice_number',
  'stop 3: a trailing TAB must be caught -- btrim strips spaces only');

select pg_temp.p14_assert(
  pg_temp.p14_dup_variant(33, chr(160) || 'PZ-DUP-1') = 'duplicate_invoice_number',
  'stop 3: a leading U+00A0 NO-BREAK SPACE must be caught');

select pg_temp.p14_assert(
  pg_temp.p14_dup_variant(34, 'pz' || chr(8203) || '-dup-1') = 'duplicate_invoice_number',
  'stop 3: a ZERO WIDTH SPACE in the MIDDLE, plus a case change, must be caught');

select pg_temp.p14_assert(
  (select count(*) = 1 from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000001'
      and supplier_id = '34000000-0000-4000-8000-000000000001'
      and private.document_text_key(invoice_number) = 'pz-dup-1'
      and deleted_at is null),
  'after five disguised retries there must still be exactly ONE live invoice under that number');

-- THE INVISIBLE CHARACTER ON THE *STORED* SIDE, which is the half the five variants above do
-- NOT reach. Once v_number is sanitized on the way in, every one of them collapses to a clean
-- key before the comparison happens -- so they still pass against the OLD `lower(btrim(...))`
-- predicate, and a mutation sweep proved exactly that: reverting the comparison alone left this
-- suite green. The comparison fix earns its place here instead, on the case sanitizing the input
-- can never help with: an invoice ALREADY IN THE LEDGER whose number carries an RLM -- which is
-- what a human paste through create_invoice produces today, since the human path still compares
-- with a bare trim (0023:1800-1804). A clean transcription of that same number must still be
-- recognised as the duplicate it is.
insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date, amount_before_vat, vat_amount,
  total_amount)
values ('b4000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-000000000001',
        '34000000-0000-4000-8000-000000000001', 'PZ-HUMAN-7' || chr(8207),
        date '2026-04-02', 1000, 180, 1180);

select pg_temp.p14_assert(
  pg_temp.p14_dup_variant(37, 'PZ-HUMAN-7') = 'duplicate_invoice_number',
  'stop 3: a CLEAN transcription must match a STORED number that carries an invisible '
  || 'character -- sanitizing the input cannot reach this, only normalising both sides can, '
  || 'and this is the shape a human paste through create_invoice produces today');

-- The stored number must also be clean, or the duplicate is invisible to search as well as to
-- the comparison. Applied above the bar with a bidi-marked number that is NOT a duplicate.
select pg_temp.p14_assert(
  pg_temp.p14_dup_variant(35, 'PZ-CLEAN-9' || chr(8207)) = 'NONE',
  'a non-duplicate with an invisible character must still auto-apply');

select pg_temp.p14_assert(
  (select invoice_number = 'PZ-CLEAN-9' from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000001'
      and private.document_text_key(invoice_number) = 'pz-clean-9'),
  'the STORED number must have the invisible character removed and its case preserved -- '
  || 'otherwise the row exists but no human search will ever find it');

-- --- Stop 4: money has already been allocated against this number ---
insert into public.payments (id, org_id, supplier_id, amount, paid_date)
values ('c4000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001',
        '34000000-0000-4000-8000-000000000001', 500, current_date);
insert into public.payment_allocations (org_id, payment_id, invoice_id, amount)
values ('14000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001',
        'b4000000-0000-4000-8000-000000000001', 500);

select pg_temp.p14_assert(
  pg_temp.p14_dup_variant(36, 'PZ-DUP-1') = 'payment_allocation_conflict',
  'stop 4: once money is allocated against that number the refusal must name the ALLOCATION, '
  || 'not merely the duplicate -- somebody has already acted on a balance this would move');

-- --- not_an_invoice: a confident identification of something that is not a supplier charge ---
select pg_temp.p14_seed(
  40, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('delivery_note', 0.99, '34000000-0000-4000-8000-000000000001', 0.99));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000040') ->> 'reason_code' = 'not_an_invoice',
  'a delivery note above the bar must queue BY NAME -- inventing an invoice from a delivery '
  || 'note is how a business pays for the same goods twice');

select pg_temp.p14_assert(
  (select count(*) = 0 from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000001'
      and invoice_number like '%P14-1001%' and invoice_date = date '2026-04-03'
      and id <> (select id from public.invoices
                  where org_id = '14000000-0000-4000-8000-000000000001'
                    and invoice_number = 'P14-1001' limit 1)),
  'and no second invoice appeared from it');

-- --- OFF MEANS ZERO INCLUDING ARCHIVING: the claim the file makes at 0077:552-554 ---
-- Tenant D is unconfigured. A document it calls "other" must NOT be archived: archiving is a
-- write to documents that takes the row out of the manager's inbox, and a tenant that never
-- granted the authority does not get it for the outcomes that happen to be cheap.
select pg_temp.p14_seed(
  41, '14000000-0000-4000-8000-000000000004', '24000000-0000-4000-8000-000000000004',
  pg_temp.p14_payload('other', 0.99, '34000000-0000-4000-8000-000000000004', 0.99));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000041') ->> 'reason_code'
    = 'autonomy_disabled',
  'a switched-off tenant must not archive either -- the switch dominates the "other" arm');

select pg_temp.p14_assert(
  (select entity_type = 'inbox' from public.documents
    where id = '44000000-0000-4000-8000-000000000041'),
  'and the document must still be sitting in the inbox where the manager can see it');

-- --- I-3: an order number too large for int4 must not abort the command ---
select pg_temp.p14_seed(
  42, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.99,
    jsonb_build_array(
      jsonb_build_object('key', 'invoice_number', 'value', 'P14-BIG-ORDER',
        'confidence', 0.97, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'invoice_date', 'value', '09/04/2026',
        'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'order_number', 'value', 20260403001,
        'confidence', 0.93, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'subtotal', 'value', 1000,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')),
      jsonb_build_object('key', 'vat_amount', 'value', 180,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')),
      jsonb_build_object('key', 'total', 'value', 1180,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')))));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000042') ->> 'outcome' = 'auto_applied',
  'a date-shaped order reference beyond int4 must NOT abort the command -- the cast raised '
  || '22003 and created no invoice at all, contradicting the contract that an unresolvable '
  || 'order number still leaves the invoice written');

select pg_temp.p14_assert(
  (pg_temp.p14_apply('74000000-0000-4000-8000-000000000042') -> 'order_id') = 'null'::jsonb,
  'and it must simply not resolve to an order');

-- --- m-3: an absurd invoice number is refused, never truncated ---
select pg_temp.p14_seed(
  43, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.99,
    jsonb_build_array(
      jsonb_build_object('key', 'invoice_number', 'value', repeat('9', 5000),
        'confidence', 0.97, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'invoice_date', 'value', '09/04/2026',
        'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'subtotal', 'value', 1000,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')),
      jsonb_build_object('key', 'vat_amount', 'value', 180,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')),
      jsonb_build_object('key', 'total', 'value', 1180,
        'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-2')))));

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000043') ->> 'reason_code'
    = 'invoice_number_unreasonable',
  'a 5000-character invoice number must be REFUSED, not truncated -- truncating would store a '
  || 'different number than the document shows and then compare that invented number');

select pg_temp.p14_assert(
  not exists (select 1 from public.invoices where length(invoice_number) > 100),
  'and nothing that long may have reached the ledger');

-- --- I-5: the reversal fields cannot be born set, and cannot precede creation ---
select pg_temp.p14_trusted();
do $$
begin
  insert into public.document_auto_actions (
    org_id, document_id, interpretation_id, outcome, invoice_id, decision,
    reverted_at, reverted_reason, reverted_by)
  values ('14000000-0000-4000-8000-000000000001', '44000000-0000-4000-8000-000000000006',
          '74000000-0000-4000-8000-000000000106', 'auto_applied',
          'b4000000-0000-4000-8000-000000000001', '{}'::jsonb,
          now(), 'born reverted', '24000000-0000-4000-8000-000000000001');
  raise exception 'P14 apply-interpretation assertion failed: a born-reverted auto-action was '
    'stored -- it occupies no partial-unique slot, so the idempotency key silently stops keying';
exception when sqlstate '22023' then
  if sqlerrm not like '%document_auto_action_born_reverted%' then raise; end if;
end
$$;

select pg_temp.p14_assert(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_auto_actions'::regclass
      and conname = 'document_auto_actions_reversal_order'),
  'B1 finding 3: a reversal must not be able to precede the row it reverses');

select pg_temp.p14_assert(
  (select tgtype::int & 4 = 4 from pg_trigger
    where tgrelid = 'public.document_auto_actions'::regclass
      and tgname = 'document_auto_actions_guard_columns_trg'),
  'the column guard must fire on INSERT too -- BEFORE UPDATE OR DELETE alone never sees a row '
  || 'that is born wrong');

-- --- I-2: the replay escape must not reopen "a person already decided" ---
-- The exact sequence, and every step of it is reachable today. Document 1 was QUEUED while
-- tenant A was still unconfigured, which left an active filing carrying interpretation 001.
-- Tenant A is switched on now. A person archives the document through file_document -- which
-- writes NO filing row (B1 finding 1), so the filing from interpretation 001 is still the
-- active one. Replaying interpretation 001 then has v_replay = true, and with `and not v_replay`
-- on the guard below it skipped BOTH refusals and inserted the invoice. Nothing persisted only
-- because documents_guard_columns happens to forbid archive -> invoice, so the command died on
-- a raw unnamed 42501 and the caller retried forever. Widen that trigger -- and
-- rescue_document_from_archive already exists -- and a replay silently overrules a person.
select pg_temp.p14_become('24000000-0000-4000-8000-000000000001');
select public.file_document('44000000-0000-4000-8000-000000000001', 'archive', null,
  'P14: a person archived a document the system had queued');
select pg_temp.p14_trusted();

select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000001') ->> 'outcome' = 'already_decided',
  'a replay must NOT overrule a person who archived the document after the system queued it');

select pg_temp.p14_assert(
  (select entity_type = 'archive' from public.documents
    where id = '44000000-0000-4000-8000-000000000001')
  and not exists (
    select 1 from public.document_auto_actions
    where document_id = '44000000-0000-4000-8000-000000000001'),
  'and the document stays archived with no automatic write against it');

-- --- EVERY reason code the function can emit must appear in this suite ---
-- The net, made explicit. A thirteenth code added without a scenario fails here rather than
-- passing silently, which is exactly how stops 2, 3 and 4 shipped with zero coverage.
select pg_temp.p14_assert(
  (select count(*) = 0 from (
     select unnest(array[
       'organization_inactive', 'autonomy_disabled', 'document_type_other',
       'confidence_unknown', 'below_confidence_threshold', 'not_an_invoice',
       'supplier_unidentified', 'invoice_identity_missing', 'invoice_number_unreasonable',
       'total_missing', 'amounts_unreconciled', 'payment_allocation_conflict',
       'duplicate_invoice_number']) as code
   ) expected
   where not exists (
     select 1 from pg_proc
     where oid = 'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure
       and prosrc like '%''' || expected.code || '''%')),
  'every reason code this suite claims to cover must still exist in the function');

select pg_temp.p14_assert(
  (select count(*) = 13 from (
     select distinct (regexp_matches(
       regexp_replace(prosrc, '--[^\n]*', '', 'g'),
       'v_reason_code := ''([a-z_]+)''', 'g'))[1] as code
     from pg_proc
     where oid = 'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure
   ) emitted),
  'the function must emit exactly the 13 reason codes this suite exercises -- a fourteenth '
  || 'added without a scenario fails HERE, which is how stops 2, 3 and 4 shipped uncovered');

-- ===== (f) TENANT ISOLATION =====
-- Tenant B was never configured and was never touched. Its whole financial footprint must be
-- byte-identical to what it was before tenant A's six applications ran.
select pg_temp.p14_assert(
  (select pg_temp.p14_footprint('14000000-0000-4000-8000-000000000002') = b
     from p14_footprint_before),
  'applying in tenant A must not have moved a single row in tenant B');

-- And tenant A's own switch must not resolve for tenant B, through the door C2 actually reads.
select pg_temp.p14_assert(
  (select not autonomy_enabled and min_confidence is null
     from private.autonomy_policy_for_org(
       '14000000-0000-4000-8000-000000000002', 'document.interpretation')),
  'tenant A''s autonomy must never resolve for tenant B on the trusted-server door');

-- ===== purchase_order_items is NEVER written =====
-- The one documented exception to the owner's full-automation ruling. unit_price is a price
-- snapshot at order time and price_history derives from it, so a retroactive line rewrites
-- analyses the manager has already been shown. Asserted as a whole-table count, so a write
-- anywhere in the command is caught, not only in the branch a test happened to exercise.
select pg_temp.p14_assert(
  (select count(*) = 1 from public.purchase_order_items poi
     join public.purchase_orders po on po.id = poi.order_id
    where po.org_id = '14000000-0000-4000-8000-000000000001'),
  'exactly the ONE line this suite inserted as a fixture -- thirteen applications, including '
  || 'one that found an item nobody ordered, added none');

select pg_temp.p14_assert(
  (select prosrc !~ '\minsert\s+into\s+purchase_order_items\M'
      and prosrc !~ '\mupdate\s+purchase_order_items\M'
     from pg_proc
    where oid = 'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure),
  'the command must contain no write to purchase_order_items at all -- unit_price is a price '
  || 'snapshot at order time and price_history derives from it (CLAUDE.md)');

-- ===== (c) THRESHOLD NULL IS A REFUSAL =====
-- 0076 makes enabled-with-no-threshold unrepresentable, so the only route here is a mutated
-- resolver. C1 finding 7 says C2 must refuse independently rather than trust that fence, and
-- this is where that independence is proven: with the resolver's guard gone, the command must
-- STILL refuse, by name, and write nothing.
-- The footprint is captured HERE rather than asserted as an absolute count. An earlier version
-- hard-coded "still the one invoice from the happy path"; every scenario added afterwards moved
-- that number and the assertion began failing for a reason unrelated to what it tests. The
-- claim is "the refusal wrote nothing", so measure exactly that.
create temporary table p14_before_threshold_mutation as
select pg_temp.p14_footprint('14000000-0000-4000-8000-000000000001') as a;

savepoint p14_threshold_mutation;

create or replace function private.autonomy_policy_for_org(
  p_org_id     uuid,
  p_policy_key text
) returns table (
  policy_key       text,
  configured       boolean,
  autonomy_enabled boolean,
  min_confidence   numeric,
  kill_switch      boolean
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  -- A stand-in, not a copy: enabled with no threshold, which is the state the live resolver's
  -- null guard exists to make unreachable.
  return query select p_policy_key, true, true, null::numeric, false;
end
$$;

select pg_temp.p14_seed(
  10, '14000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000001', 0.99));

select pg_temp.p14_assert(
  pg_temp.p14_trusted_error(
    $$select public.apply_document_interpretation(
        '54000000-0000-4000-8000-000000000010',
        '74000000-0000-4000-8000-000000000010', null)$$
  ) like '%autonomy_threshold_missing%',
  'C1 finding 7: a NULL threshold must be a hard refusal BY NAME -- never 0, never a default, '
  || 'and never trusted to the resolver alone');

select pg_temp.p14_assert(
  (select pg_temp.p14_footprint('14000000-0000-4000-8000-000000000001') = a
     from p14_before_threshold_mutation)
  and not exists (
    select 1 from public.document_filings
    where document_id = '44000000-0000-4000-8000-000000000010'),
  'the refusal must have written NOTHING -- not an invoice, not an exception, not an '
  || 'auto-action, and not even the filing row a queued outcome would have left');

rollback to savepoint p14_threshold_mutation;

-- ===== (g) MUTATION PROOF: the autonomy check is load-bearing =====
-- Not a copy of the live function with a line deleted -- a deliberately minimal stand-in whose
-- only job is to perform the write WITHOUT consulting the switch. If an invoice then lands for
-- the UNCONFIGURED tenant B, the check is proven to be the only thing standing there.
savepoint p14_flag_mutation;

create or replace function public.apply_document_interpretation(
  p_job_id            uuid,
  p_interpretation_id uuid,
  p_actor_id          uuid default null   -- kept: create or replace cannot drop a default
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_i public.document_interpretations;
  v_id uuid := gen_random_uuid();
begin
  select * into v_i from public.document_interpretations where id = p_interpretation_id;
  insert into invoices (id, org_id, supplier_id, invoice_number, invoice_date, total_amount)
  values (v_id, v_i.org_id, v_i.suggested_supplier_id, 'P14-MUTANT', current_date, 1);
  return jsonb_build_object('outcome', 'auto_applied', 'invoice_id', v_id);
end
$$;

select pg_temp.p14_seed(
  11, '14000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000002',
  pg_temp.p14_payload('invoice', 0.99, '34000000-0000-4000-8000-000000000002', 0.99));

-- Two statements, not one expression with an `and`. A subquery beside a function call is
-- evaluated as an InitPlan BEFORE the call, so `p14_apply(...) and (select count(*) ...)` reads
-- the invoice count from before the apply and fails against a working mutant. The first draft
-- did exactly that and reported a false negative.
select pg_temp.p14_assert(
  pg_temp.p14_apply('74000000-0000-4000-8000-000000000011') ->> 'outcome' = 'auto_applied',
  'P14 mutation proof: the stand-in must report that it applied');

select pg_temp.p14_assert(
  (select count(*) = 1 from public.invoices
     where org_id = '14000000-0000-4000-8000-000000000002'),
  'P14 mutation proof: with the autonomy check removed, an UNCONFIGURED tenant gets an '
  || 'automatic invoice -- the check is the only thing standing there, and no constraint '
  || 'would have caught it');

rollback to savepoint p14_flag_mutation;

select pg_temp.p14_assert(
  (select count(*) = 0 from public.invoices
    where org_id = '14000000-0000-4000-8000-000000000002'),
  'P14 mutation proof: rolling the mutation back must restore the refusal');

rollback;

\echo 'p14_apply_interpretation_passed'
