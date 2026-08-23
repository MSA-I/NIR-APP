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
select pg_temp.p68_assert(
  has_function_privilege('authenticated','public.get_price_list_calibration_preparation_queue(integer)','EXECUTE')
  and not has_function_privilege('service_role','public.get_price_list_calibration_preparation_queue(integer)','EXECUTE')
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(integer)'::regprocedure)
    like '%auth_role() not in (''owner'',''office'')%'
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(integer)'::regprocedure)
    like '%document.unit_id is null or document.unit_id=any(public.auth_scopes())%'
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(integer)'::regprocedure)
    like '%preparation.id%'
  and pg_get_functiondef('public.get_price_list_calibration_preparation_queue(integer)'::regprocedure)
    !~* '(provider|model|prompt_version|schema_version|payload|decision_confidence|evidence_block_ids)',
  'office queue grant/scope or safe projection contract is wrong');
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
  pg_get_functiondef('public.apply_price_list_interpretation(uuid,uuid,uuid)'::regprocedure)
    like '%v_ambiguous%'
  and pg_get_functiondef('public.apply_price_list_interpretation(uuid,uuid,uuid)'::regprocedure)
    like '%line_product_ambiguous%'
  and pg_get_functiondef('public.apply_price_list_interpretation(uuid,uuid,uuid)'::regprocedure)
    like '%apply_price_list_interpretation_qualified_impl%',
  'authoritative writer can still let the first duplicate identifier win');
select pg_temp.p68_assert(
  not exists(select 1 from private.document_automation_negative_guard_violations()),
  'raw text, PO snapshots, numeric drift or authoritative writer negative guard failed');
select pg_temp.p68_assert(
  (select count(*)>=14 from private.document_automation_authoritative_functions)
  and exists(select 1 from private.document_automation_authoritative_functions
    where function_signature='get_price_list_drift_metrics(integer)' and not activation_writer)
  and (select count(*)=2 from private.document_automation_authoritative_functions where activation_writer),
  'authoritative signature/call graph or complete activation-writer registry is missing');
select pg_temp.p68_assert(
  exists(select 1 from private.autonomy_policy_definitions
    where policy_key='document.packet_split' and not baseline_enabled)
  and pg_get_functiondef('private.autonomy_policy_for_org(uuid,text)'::regprocedure)
    like '%kill_switch%',
  'mixed-PDF pilot lacks off baseline or kill switch');

rollback;
