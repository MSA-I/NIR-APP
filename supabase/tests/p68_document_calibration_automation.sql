-- P68 -- owner calibration/platform activation, qualified product dry-run and negative guards.
\set ON_ERROR_STOP on
begin;
create function pg_temp.p68_assert(p boolean,m text) returns void language plpgsql as $$begin
  if not coalesce(p,false) then raise exception 'P68: %',m; end if; end$$;

select pg_temp.p68_assert(
  not exists(select 1 from private.scope_definer_exemptions where function_signature=any(array[
    'public.apply_price_list_interpretation(uuid,uuid,uuid)',
    'apply_price_list_interpretation(uuid,uuid,uuid)']))
  and exists(select 1 from private.scope_definer_exemptions
    where function_signature='public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)'::regprocedure::text
      and reason like '%0182:%'),
  'A5 exemption was not moved atomically to renamed authoritative writer');

select pg_temp.p68_assert(
  to_regprocedure('public.prepare_price_list_calibration_batch(uuid,uuid[],uuid,text)') is not null
  and to_regprocedure('public.record_price_list_calibration_batch(uuid,uuid,text)') is not null,
  'office preparation or owner batch review command missing');
-- The queue is read PER DOCUMENT and paged: (p_document_id uuid, p_limit integer default 200,
-- p_offset integer default 0). The single-argument form must NOT also exist -- an overload would
-- make every grant and body assertion below ambiguous about which body it measured.
select pg_temp.p68_assert(
  to_regprocedure('public.get_price_list_calibration_preparation_queue(uuid,integer,integer)') is not null
  and to_regprocedure('public.get_price_list_calibration_preparation_queue(integer)') is null,
  'the calibration preparation queue is not the document-scoped, paged signature');
select pg_temp.p68_assert(
  has_function_privilege('authenticated','public.get_price_list_calibration_preparation_queue(uuid,integer,integer)','EXECUTE')
  and not has_function_privilege('service_role','public.get_price_list_calibration_preparation_queue(uuid,integer,integer)','EXECUTE')
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure)
    like '%auth_role() not in (''owner'',''office'')%'
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure)
    like '%document.unit_id is null or document.unit_id=any(public.auth_scopes())%'
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure)
    like '%preparation.id%'
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure)
    !~* '(provider|model|prompt_version|schema_version|decision_confidence|evidence_block_ids)'
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure)
    !~* 'returns table\([^)]*payload'
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure)
    !~* 'pending[.]payload',
  'office queue grant/scope or safe projection contract is wrong');
-- What the rewrite ADDED, asserted here and not only in 0181's apply-time do-block: that block runs
-- once, against the schema the migration itself just built. This suite runs against the schema as
-- it stands, so a later `create or replace` that drops the document filter, the paging total or the
-- preparation's own line count is caught here instead of shipping.
--
-- Each of the three is load-bearing for one sentence the screen says out loud. The document filter:
-- an org-wide window ordered by run.created_at served the organization's oldest rows, so a newer
-- document's review screen saw none of its own lines and stated that none were waiting.
-- `count(*) over ()`: counted over the whole filtered set BEFORE offset/limit, it is what separates
-- "the last page" from "truncated" on a 338-line live price list. `cardinality(prepared.line_ids)`:
-- the number the reviewing screen checks its rendered rows against before an owner approves.
select pg_temp.p68_assert(
  pg_get_functiondef('public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure)
    like '%run.document_id=p_document_id%'
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure)
    like '%count(*) over ()%'
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure)
    like '%cardinality(prepared.line_ids)%',
  'the calibration queue is not document-scoped, paged with a pre-page total, or counted per preparation');
select pg_temp.p68_assert(
  pg_get_functiondef('public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure)
    like '%pending_currency%'
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(uuid,integer,integer)'::regprocedure)
    like '%resolve_document_currency%',
  'the calibration queue returned prices without the document evidence currency');
-- And the batch itself is all-or-nothing over what is still outstanding. Without this refusal an
-- owner could approve a window while the same run keeps unreviewed lines nobody ever looked at,
-- and the preparation's line_count would be a statement about a subset instead of about the run --
-- which is the number platform activation later reads as completeness evidence.
select pg_temp.p68_assert(
  pg_get_functiondef('public.prepare_price_list_calibration_batch(uuid,uuid[],uuid,text)'::regprocedure)
    like '%calibration_preparation_incomplete%',
  'a preparation may cover a subset of the run''s outstanding lines');
select pg_temp.p68_assert(
  pg_get_functiondef('public.record_price_list_calibration_batch(uuid,uuid,text)'::regprocedure)
    like '%calibration_preparation_superseded%',
  'owner can approve a stale preparation after a newer office handoff');
select pg_temp.p68_assert(
  pg_get_functiondef('public.prepare_price_list_calibration_batch(uuid,uuid[],uuid,text)'::regprocedure)
    like '%v_role not in (''owner'',''office'')%'
  and pg_get_functiondef('public.record_price_list_calibration_batch(uuid,uuid,text)'::regprocedure)
    like '%auth_role()<>''owner''%',
  'office can qualify evidence or cannot prepare it');
select pg_temp.p68_assert(
  pg_get_functiondef('public.platform_set_price_list_automation_scope(uuid,uuid,text,uuid,text)'::regprocedure)
    like '%auth.uid() is distinct from v_actor%'
  and pg_get_functiondef('public.platform_set_price_list_automation_scope(uuid,uuid,text,uuid,text)'::regprocedure)
    like '%assert_recent_password_authentication%'
  and pg_get_functiondef('public.platform_set_price_list_automation_scope(uuid,uuid,text,uuid,text)'::regprocedure)
    like '%price_list_scope_review_incomplete%'
  and pg_get_functiondef('public.platform_set_price_list_automation_scope(uuid,uuid,text,uuid,text)'::regprocedure)
    like '%v_correct <> v_line_count%',
  'platform activation lacks under-lock identity/step-up/completeness/all-correct gates');

select pg_temp.p68_assert(
  to_regprocedure('public.get_qualified_product_creation_dry_run(uuid)') is not null
  and pg_get_functiondef('public.get_qualified_product_creation_dry_run(uuid)'::regprocedure)
    like '%''qualified_create''%'
  and pg_get_functiondef('public.get_qualified_product_creation_dry_run(uuid)'::regprocedure)
    like '%''ambiguous_catalog''%'
  and pg_get_functiondef('public.get_qualified_product_creation_dry_run(uuid)'::regprocedure)
    like '%''missing_qualification''%'
  and pg_get_functiondef('public.get_qualified_product_creation_dry_run(uuid)'::regprocedure)
    like '%''invalid_price''%'
  and pg_get_functiondef('public.get_qualified_product_creation_dry_run(uuid)'::regprocedure)
    not like '%insert into public.products%',
  'qualified creation dry-run writes or hides unsafe outcome counts');
select pg_temp.p68_assert(
  pg_get_functiondef('public.get_qualified_product_creation_dry_run(uuid)'::regprocedure)
    like '%''currency'',v_currency%'
  and pg_get_functiondef('public.get_qualified_product_creation_dry_run(uuid)'::regprocedure)
    like '%v_minor_units%',
  'qualified creation dry-run returned or rounded a price without its currency');
select pg_temp.p68_assert(
  pg_get_functiondef('public.apply_price_list_interpretation(uuid,uuid,uuid)'::regprocedure)
    like '%v_ambiguous%'
  and pg_get_functiondef('public.apply_price_list_interpretation(uuid,uuid,uuid)'::regprocedure)
    like '%line_product_ambiguous%'
  and pg_get_functiondef('public.apply_price_list_interpretation(uuid,uuid,uuid)'::regprocedure)
    like '%apply_price_list_interpretation_qualified_impl%',
  'authoritative writer can still let the first duplicate identifier win');
-- The baseline. A canned message here would hide which arm moved, so the violations are read out:
-- registered body/call-graph pins, raw-evidence writer coverage, the sanitizer kept off every
-- evidence write path, direct purchase-order snapshot mutation, activation-writer coverage, and
-- the drift read model reaching an activation writer.
do $$ declare v text; begin
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail) into v
  from private.document_automation_negative_guard_violations();
  if v is not null then raise exception e'P68: a #245/#251/#252 negative guard fired:\n%',v; end if;
end $$;

-- ===== Falsification =====
-- "Returns no rows" and "cannot return rows" are the same observation until one of them is ruled
-- out. Each arm below is handed the violation it exists to catch, inside a savepoint, and must
-- name it exactly. Without this, a predicate that silently stopped matching -- a signature that
-- gained a schema prefix, a regex that stopped anchoring -- would read as PASS forever.

savepoint p68_falsify_245;
create function private.p68_probe_sanitizing_writer() returns void language plpgsql as $probe$
begin
  -- Never executed. The guard reads bodies, so the violation is written in its exact shape:
  -- a write into the immutable evidence table whose value went through the sanitizer first.
  update public.document_extractions
  set payload = jsonb_set(payload, '{document,plain_text}',
    to_jsonb(private.document_text_sanitize(payload #>> '{document,plain_text}')))
  where false;
end $probe$;
select pg_temp.p68_assert((
  select count(*) = 2
     and count(*) filter (where v.assertion = 'sanitized_raw_evidence_write'
       and v.detail like '%p68_probe_sanitizing_writer()') = 1
     and count(*) filter (where v.assertion = 'unregistered_raw_evidence_writer'
       and v.detail like '%p68_probe_sanitizing_writer()') = 1
  from private.document_automation_negative_guard_violations() v),
  '#245 stayed silent while a write path into the evidence tables routed through document_text_sanitize');
rollback to savepoint p68_falsify_245;

savepoint p68_falsify_245_pin;
create or replace function private.document_text_sanitize(p_text text)
returns text language sql immutable set search_path = public, pg_temp as $probe$
  select nullif(btrim(coalesce(p_text, '')), '')
$probe$;
select pg_temp.p68_assert((
  select count(*) = 1
     and count(*) filter (where v.assertion = 'authoritative_body_drift'
       and v.detail like '%document_text_sanitize(text)') = 1
  from private.document_automation_negative_guard_violations() v),
  '#245 body pin did not notice the denylist sanitizer being replaced');
rollback to savepoint p68_falsify_245_pin;

savepoint p68_falsify_251;
create function private.p68_probe_order_mutator() returns void language plpgsql as $probe$
begin
  update public.purchase_order_items set unit_price = unit_price where false;
end $probe$;
insert into private.document_automation_authoritative_functions(
  function_signature, responsibility, raw_evidence_writer, automation_root, activation_writer,
  expected_callees, body_hash)
select proc.oid::regprocedure::text, 'P68 falsification probe: a root that touches a PO snapshot.',
  false, true, false, '{}'::text[], md5(replace(proc.prosrc, e'\r', ''))
from pg_proc proc where proc.oid = 'private.p68_probe_order_mutator()'::regprocedure;
select pg_temp.p68_assert((
  select count(*) = 1
     and count(*) filter (where v.assertion = 'purchase_order_snapshot_mutation'
       and v.detail like '%p68_probe_order_mutator()') = 1
  from private.document_automation_negative_guard_violations() v),
  '#251 stayed silent while a registered automation root updated a purchase-order snapshot');
rollback to savepoint p68_falsify_251;

savepoint p68_falsify_252;
-- Same signature, same return type, same volatility and search_path, so the grants and the
-- registry row still point at it; only the forbidden reference is added. The call sits under a
-- constant-false branch because the guard reads the body, not the behaviour.
create or replace function public.get_price_list_drift_metrics(p_window_days integer default 30)
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $probe$
begin
  if false then
    perform public.platform_set_autonomy_policy(
      '00000000-0000-4000-8000-000000000000'::uuid, 'document.packet_split', true, 0.9, 'P68 probe');
  end if;
  return '{}'::jsonb;
end $probe$;
select pg_temp.p68_assert((
  select count(*) = 2
     and count(*) filter (where v.assertion = 'numeric_drift_activation_call'
       and v.detail like '%platform_set_autonomy_policy(uuid,text,boolean,numeric,text)') = 1
     and count(*) filter (where v.assertion = 'authoritative_body_drift'
       and v.detail like '%get_price_list_drift_metrics(integer)') = 1
  from private.document_automation_negative_guard_violations() v),
  '#252 stayed silent while the numeric drift read model reached an activation writer');
rollback to savepoint p68_falsify_252;

savepoint p68_falsify_252_subject;
-- ...and the arm must not be able to go quiet by losing its subject: this is the trap a literal
-- signature sets, where the predicate matches nothing and the guard reports nothing.
delete from private.document_automation_authoritative_functions registry
where to_regprocedure(registry.function_signature)
  = to_regprocedure('public.get_price_list_drift_metrics(integer)');
select pg_temp.p68_assert((
  select count(*) = 1
     and count(*) filter (where v.assertion = 'numeric_drift_read_model_unpinned') = 1
  from private.document_automation_negative_guard_violations() v),
  '#252 read model can be unpinned without the guard saying so');
rollback to savepoint p68_falsify_252_subject;

do $$ declare v text; begin
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail) into v
  from private.document_automation_negative_guard_violations();
  if v is not null then raise exception e'P68: a falsification probe leaked past its savepoint:\n%',v; end if;
end $$;
-- Matched by OID, not by rendered signature text. `regprocedure::text` omits the schema only while
-- the function is visible, so an equality against a literal stops matching -- silently -- the day
-- the stored form gains a prefix.
select pg_temp.p68_assert(
  (select count(*)>=15 from private.document_automation_authoritative_functions)
  and exists(select 1 from private.document_automation_authoritative_functions registry
    where to_regprocedure(registry.function_signature)
      =to_regprocedure('public.get_price_list_drift_metrics(integer)')
      and not registry.activation_writer)
  and exists(select 1 from private.document_automation_authoritative_functions registry
    where to_regprocedure(registry.function_signature)
      =to_regprocedure('private.document_text_sanitize(text)')
      and not registry.raw_evidence_writer and not registry.automation_root
      and not registry.activation_writer)
  -- THREE activation writers since 0211, not two, and the third is named rather than counted.
  -- A bare count says "the set changed"; naming the member says which decision changed it, and
  -- fails just as loudly if a future function writes org_autonomy_policies and registers itself
  -- without anyone deciding it should. #275: the pre-launch birth grant is the only AUTOMATIC
  -- one -- the other two are operator commands behind step-up and a reason.
  and (select count(*)=3 from private.document_automation_authoritative_functions where activation_writer)
  and exists(select 1 from private.document_automation_authoritative_functions registry
    where to_regprocedure(registry.function_signature)
      =to_regprocedure('private.organizations_prelaunch_autonomy()')
      and registry.activation_writer
      and not registry.raw_evidence_writer and not registry.automation_root),
  'the registry lost the drift read model, the #245 sanitizer pin or the exact activation-writer set');
select pg_temp.p68_assert(
  exists(select 1 from private.autonomy_policy_definitions
    where policy_key='document.packet_split' and not baseline_enabled)
  and pg_get_functiondef('private.autonomy_policy_for_org(uuid,text)'::regprocedure)
    like '%kill_switch%',
  'mixed-PDF pilot lacks off baseline or kill switch');

rollback;
