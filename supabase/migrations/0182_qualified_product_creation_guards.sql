-- 0182 -- #250 qualified product dry-run plus #245/#251/#252 negative structural guards.
-- No policy is enabled and no product is created by this migration.
--
-- WHAT THE GUARDS MEASURE, stated here so the header is never read as more than the code does. A
-- guard that advertises coverage it does not have is worse than no guard, because it is quoted as
-- proof:
--   #245  pins the body of private.document_text_sanitize, denies it to every write path into
--         document_extractions/document_interpretations, and keeps document_text_key separate.
--   #251  body-scans the REGISTERED automation roots for direct purchase-order UPDATE/DELETE. A
--         hop through an unregistered helper is outside this scan and is said again at the arm.
--   #252  keys the drift read model and the activation writers by OID rather than by rendered
--         signature text, and reports the read model going unpinned instead of returning nothing.
-- P68 falsifies each arm against a deliberate violation, so "no rows" means the scan ran and found
-- nothing rather than that the predicate matched nothing.

alter function public.apply_price_list_interpretation(uuid,uuid,uuid)
  rename to apply_price_list_interpretation_qualified_impl;
revoke all on function public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;

-- The reviewed definer did not change body or authority; only its name moved behind an invoker
-- preflight wrapper. Move the existing A5 exemption row in the same migration, preserving the pin,
-- target wave and its audit explanation. Never leave a stale old-signature row plus an uncovered
-- renamed definer between migrations.
do $move_apply_exemption$
declare v_before integer; v_moved integer; v_after integer;
begin
  select count(*) into v_before from private.scope_definer_exemptions;
  update private.scope_definer_exemptions
  set function_signature='public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)'::regprocedure::text,
      reason=reason||' 0182: reviewed body renamed behind a SECURITY INVOKER whole-document '
        ||'duplicate-identifier preflight; authority and tenant-composite evidence chain unchanged.'
  where function_signature=any(array[
    'public.apply_price_list_interpretation(uuid,uuid,uuid)',
    'apply_price_list_interpretation(uuid,uuid,uuid)'
  ]);
  get diagnostics v_moved=row_count;
  select count(*) into v_after from private.scope_definer_exemptions;
  if v_moved<>1 or v_after<>v_before
     or exists(select 1 from private.scope_definer_exemptions
               where function_signature=any(array[
                 'public.apply_price_list_interpretation(uuid,uuid,uuid)',
                 'apply_price_list_interpretation(uuid,uuid,uuid)']))
     or not exists(select 1 from private.scope_definer_exemptions
               where function_signature='public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)'::regprocedure::text
                 and reason like '%0182:%') then
    raise exception '0182: A5 exemption rename did not preserve count/pin/reason';
  end if;
end $move_apply_exemption$;

-- Preflight the complete immutable interpretation before the first product INSERT. Duplicate
-- identifiers or two different identifiers resolving to one product send the whole document to
-- review; iteration order can never make the first line win.
create function public.apply_price_list_interpretation(
  p_job_id uuid,p_interpretation_id uuid,p_actor_id uuid default null
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_i public.document_interpretations; v_doc public.documents; v_line jsonb; v_values jsonb;
  v_sku text; v_barcode text; v_key text; v_match jsonb; v_product uuid;
  v_seen_keys text[]:='{}'; v_seen_products uuid[]:='{}'; v_ambiguous boolean:=false;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'not_authorized' using errcode='42501'; end if;
  select * into v_i from public.document_interpretations interpretation
  where interpretation.id=p_interpretation_id and interpretation.job_id=p_job_id;
  if not found then raise exception 'document_interpretation_unknown' using errcode='P0002'; end if;
  if exists(select 1 from public.price_list_interpretation_decisions decision
    where decision.org_id=v_i.org_id and decision.interpretation_id=v_i.id) then
    return public.apply_price_list_interpretation_qualified_impl(p_job_id,p_interpretation_id,p_actor_id);
  end if;
  select * into v_doc from public.documents document
  where document.org_id=v_i.org_id and document.id=v_i.document_id and document.deleted_at is null;
  if not found then raise exception 'document_unknown' using errcode='P0002'; end if;
  for v_line in select value from jsonb_array_elements(coalesce(v_i.payload->'line_items','[]'::jsonb)) loop
    v_values:=v_line->'values'; v_sku:=nullif(btrim(v_values->>'sku'),'');
    v_barcode:=nullif(btrim(v_values->>'barcode'),'');
    foreach v_key in array array_remove(array[
      case when v_sku is null then null else 'sku:'||lower(v_sku) end,
      case when v_barcode is null then null else 'barcode:'||regexp_replace(v_barcode,'[[:space:]-]+','','g') end
    ],null) loop
      if v_key=any(v_seen_keys) then v_ambiguous:=true; end if;
      v_seen_keys:=array_append(v_seen_keys,v_key);
    end loop;
    if v_doc.supplier_id is not null and (v_sku is not null or v_barcode is not null) then
      v_match:=private.match_price_list_line(v_i.org_id,v_doc.supplier_id,v_sku,v_barcode);
      if v_match->>'status'='ambiguous' then v_ambiguous:=true;
      elsif v_match->>'status'='matched' then
        v_product:=(v_match->>'product_id')::uuid;
        if v_product=any(v_seen_products) then v_ambiguous:=true; end if;
        v_seen_products:=array_append(v_seen_products,v_product);
      end if;
    end if;
  end loop;
  if v_ambiguous then
    update public.document_processing_jobs set status='review',last_error_code=null,last_error_message=null
    where org_id=v_i.org_id and id=p_job_id;
    return jsonb_build_object('outcome','queued_for_review','reason_code','line_product_ambiguous',
      'accepted_count',0,'waiting_count',jsonb_array_length(coalesce(v_i.payload->'line_items','[]'::jsonb)),
      'created_product_count',0,'idempotent',false);
  end if;
  return public.apply_price_list_interpretation_qualified_impl(p_job_id,p_interpretation_id,p_actor_id);
end $$;
revoke all on function public.apply_price_list_interpretation(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;

create function public.get_qualified_product_creation_dry_run(p_interpretation_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare
  v_org uuid:=auth_org(); v_interpretation public.document_interpretations;
  v_document public.documents; v_line jsonb; v_values jsonb; v_match jsonb;
  v_sku text; v_barcode text; v_name text; v_price_text text; v_price numeric;
  v_key text; v_barcode_key text; v_seen text[]:='{}'; v_rows jsonb:='[]'; v_outcome text;
  v_qualified integer:=0; v_existing integer:=0; v_ambiguous integer:=0;
  v_missing integer:=0; v_invalid integer:=0;
begin
  if v_org is null or auth.uid() is null or auth_role() not in ('owner','office') then
    raise exception 'qualified_product_dry_run_not_authorized' using errcode='42501';
  end if;
  select * into v_interpretation from public.document_interpretations interpretation
  where interpretation.org_id=v_org and interpretation.id=p_interpretation_id;
  if not found then raise exception 'document_interpretation_unknown' using errcode='P0002'; end if;
  select * into v_document from public.documents document
  where document.org_id=v_org and document.id=v_interpretation.document_id and document.deleted_at is null
    and (document.unit_id is null or document.unit_id=any(auth_scopes()));
  if not found or v_document.document_kind<>'price_list' or v_document.supplier_id is null then
    raise exception 'qualified_product_dry_run_context_invalid' using errcode='22023';
  end if;
  if jsonb_typeof(v_interpretation.payload->'line_items')<>'array' then
    raise exception 'document_interpretation_invalid' using errcode='22023';
  end if;

  for v_line in select value from jsonb_array_elements(v_interpretation.payload->'line_items') loop
    v_values:=v_line->'values'; v_sku:=nullif(btrim(v_values->>'sku'),'');
    v_barcode:=nullif(btrim(v_values->>'barcode'),''); v_name:=nullif(btrim(v_values->>'product_name'),'');
    v_price_text:=regexp_replace(btrim(coalesce(v_values->>'unit_price','')),'[[:space:]₪,]','','g');
    v_price:=null; v_outcome:=null;
    if length(v_price_text)<=16 and v_price_text~'^[0-9]+([.][0-9]{1,4})?$' then
      v_price:=round(v_price_text::numeric,2);
    end if;
    if v_price is null or v_price<=0 or v_price>1000000 then
      v_outcome:='invalid_price'; v_invalid:=v_invalid+1;
    elsif v_name is null or length(v_name)>200 or (v_sku is null and v_barcode is null) then
      v_outcome:='missing_qualification'; v_missing:=v_missing+1;
    else
      v_key:=case when v_sku is null then null else 'sku:'||lower(v_sku) end;
      v_barcode_key:=case when v_barcode is null then null else
        'barcode:'||regexp_replace(v_barcode,'[[:space:]-]+','','g') end;
      if (v_key is not null and v_key=any(v_seen))
         or (v_barcode_key is not null and v_barcode_key=any(v_seen)) then
        v_outcome:='ambiguous_input'; v_ambiguous:=v_ambiguous+1;
      else
        if v_key is not null then v_seen:=array_append(v_seen,v_key); end if;
        if v_barcode_key is not null then v_seen:=array_append(v_seen,v_barcode_key); end if;
        v_match:=private.match_price_list_line(v_org,v_document.supplier_id,v_sku,v_barcode);
        if v_match->>'status'='ambiguous' then v_outcome:='ambiguous_catalog'; v_ambiguous:=v_ambiguous+1;
        elsif v_match->>'status'='matched' then v_outcome:='existing_product'; v_existing:=v_existing+1;
        else v_outcome:='qualified_create'; v_qualified:=v_qualified+1;
        end if;
      end if;
    end if;
    v_rows:=v_rows||jsonb_build_array(jsonb_build_object(
      'source_row',v_line->'source_row','sku',v_sku,'barcode',v_barcode,'product_name',v_name,
      'unit_price',v_price,'outcome',v_outcome));
  end loop;
  return jsonb_build_object('interpretation_id',v_interpretation.id,'supplier_id',v_document.supplier_id,
    'qualified_create_count',v_qualified,'existing_product_count',v_existing,
    'ambiguous_count',v_ambiguous,'missing_qualification_count',v_missing,'invalid_price_count',v_invalid,
    'rows',v_rows,'mutated',false);
end $$;
revoke all on function public.get_qualified_product_creation_dry_run(uuid) from public,anon,service_role;
grant execute on function public.get_qualified_product_creation_dry_run(uuid) to authenticated;

create table private.document_automation_authoritative_functions(
  function_signature text primary key,
  responsibility text not null,
  raw_evidence_writer boolean not null default false,
  automation_root boolean not null default false,
  activation_writer boolean not null default false,
  expected_callees text[] not null default '{}',
  body_hash text not null check(body_hash~'^[0-9a-f]{32}$')
);
revoke all on private.document_automation_authoritative_functions from public,anon,authenticated,service_role;

insert into private.document_automation_authoritative_functions(
  function_signature,responsibility,raw_evidence_writer,automation_root,activation_writer,expected_callees,body_hash
)
select declared.signature::regprocedure::text,declared.responsibility,declared.raw_writer,
  declared.automation_root,declared.activation_writer,declared.callees,
  md5(replace(proc.prosrc,e'\r',''))
from (values
  ('public.complete_document_processing_job(uuid,text,text,text,text,text,text,jsonb,integer,jsonb)',
   'Retired legacy extraction writer kept without browser authority; still covered explicitly.',true,false,false,'{}'::text[]),
  ('public.complete_document_processing_job(uuid,uuid,text,uuid,uuid,text)',
   'Consumes committed OCR evidence and inserts immutable extraction.',true,false,false,'{}'::text[]),
  ('public.service_recover_document_extraction_from_egress(uuid,uuid,uuid,text)',
   'Recovers immutable extraction from committed egress evidence.',true,false,false,'{}'::text[]),
  ('public.save_document_interpretation(uuid,uuid,uuid,timestamptz,text,text,text,text,jsonb,jsonb,integer)',
   'Inserts immutable interpretation after exact job/extraction/actor checks.',true,false,false,'{}'::text[]),
  ('public.service_recover_document_interpretation_from_egress(uuid,uuid,uuid,uuid,text)',
   'Recovers immutable interpretation from committed egress evidence.',true,false,false,
    array['save_document_interpretation']::text[]),
  ('public.apply_document_interpretation(uuid,uuid,uuid)',
   'Document autonomy root; may create approved business records but never mutate PO snapshots.',false,true,false,'{}'::text[]),
  ('public.apply_delivery_note_interpretation(uuid,uuid,uuid)',
   'Delivery-note draft automation root; never completes receipt or mutates PO snapshots.',false,true,false,'{}'::text[]),
  ('public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)',
   'Human-reviewed document application root; invoice/draft/evidence only.',false,true,false,'{}'::text[]),
  ('public.apply_eligible_price_list_interpretation(uuid,uuid,uuid)',
   'Eligibility root; calls duplicate preflight only after scope decision.',false,true,false,
    array['apply_price_list_interpretation']::text[]),
  ('public.apply_price_list_interpretation(uuid,uuid,uuid)',
   'Whole-document duplicate identifier preflight.',false,true,false,
    array['apply_price_list_interpretation_qualified_impl']::text[]),
  ('public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)',
   'Atomic product plus supplier-price writer.',false,true,false,
    array['p1b_submit_supplier_price_list_internal']::text[]),
  ('public.platform_set_price_list_automation_scope(uuid,uuid,text,uuid,text)',
   'Only writer of price-list scope eligibility.',false,false,true,'{}'::text[]),
  ('public.platform_set_autonomy_policy(uuid,text,boolean,numeric,text)',
   'Only tenant autonomy policy setter.',false,false,true,'{}'::text[]),
  ('public.get_price_list_drift_metrics(integer)',
   'Numeric drift read model; never calls an activation writer.',false,false,false,'{}'::text[]),
  -- #245: the stored evidence text stays faithful to the extraction. This row exists to PIN the
  -- sanitizer's body, so the denylist that 0077 argued into place cannot quietly become something
  -- else; the two arms below say where it may and may not appear.
  ('private.document_text_sanitize(text)',
   'Denylist-only text sanitizer (#245); a comparison/dedup input, never a stored-evidence rewriter.',
   false,false,false,'{}'::text[])
) declared(signature,responsibility,raw_writer,automation_root,activation_writer,callees)
left join pg_proc proc on proc.oid=to_regprocedure(declared.signature);

create function private.document_automation_negative_guard_violations()
returns table(assertion text,detail text) language sql stable set search_path=public,pg_catalog as $$
  select 'authoritative_signature_missing',registry.function_signature
  from private.document_automation_authoritative_functions registry
  where to_regprocedure(registry.function_signature) is null
  union all
  select 'authoritative_body_drift',registry.function_signature
  from private.document_automation_authoritative_functions registry
  join pg_proc proc on proc.oid=to_regprocedure(registry.function_signature)
  where registry.body_hash<>md5(replace(proc.prosrc,e'\r',''))
  union all
  select 'call_graph_anchor_missing',registry.function_signature||' -> '||callee
  from private.document_automation_authoritative_functions registry
  join pg_proc proc on proc.oid=to_regprocedure(registry.function_signature)
  cross join lateral unnest(registry.expected_callees) callee
  where position(callee in proc.prosrc)=0
  union all
  -- Exact-table DML coverage: every raw INSERT/UPDATE writer must be listed explicitly. This is a
  -- coverage comparison, not a universal claim inferred from function names.
  select 'unregistered_raw_evidence_writer',proc.oid::regprocedure::text
  from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
  where ns.nspname in ('public','private')
    and proc.prosrc~* '(insert[[:space:]]+into|update)[[:space:]]+(public[.])?document_(extractions|interpretations)'
    and not exists(select 1 from private.document_automation_authoritative_functions registry
      where registry.function_signature=proc.oid::regprocedure::text and registry.raw_evidence_writer)
  union all
  select 'registered_raw_writer_no_longer_writes',registry.function_signature
  from private.document_automation_authoritative_functions registry
  join pg_proc proc on proc.oid=to_regprocedure(registry.function_signature)
  where registry.raw_evidence_writer and not proc.prosrc~*
    '(insert[[:space:]]+into|update)[[:space:]]+(public[.])?document_(extractions|interpretations)'
    and position('save_document_interpretation' in proc.prosrc)=0
  union all
  -- #245, the arm the header promised and did not carry. The raw_evidence_writer arms above ask
  -- WHO writes the evidence tables; this one asks WHAT reaches them. `document_text_sanitize` is a
  -- comparison and dedup input -- `document_text_key` inverts it into an allowlist for the KEY and
  -- for nothing else -- so a write path into document_extractions/document_interpretations that
  -- routes through it is precisely the silent rewrite of stored evidence #245 refused.
  select 'sanitized_raw_evidence_write',proc.oid::regprocedure::text
  from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
  where ns.nspname in ('public','private')
    and proc.prosrc~* '(insert[[:space:]]+into|update)[[:space:]]+(public[.])?document_(extractions|interpretations)'
    and position('document_text_sanitize' in proc.prosrc)>0
  union all
  -- ...and the key stays a SEPARATE function. If the allowlist inversion that only the comparison
  -- key may use ever migrates into the sanitizer itself, faithful storage is gone; the body_hash
  -- pin would report that only as unexplained drift rather than as the decision it breaks.
  select 'normalized_key_not_separated',
    coalesce(to_regprocedure('private.document_text_key(text)')::text,
      'private.document_text_key(text) is missing')
  where to_regprocedure('private.document_text_key(text)') is null
    or exists(select 1 from pg_proc proc
      where proc.oid=to_regprocedure('private.document_text_sanitize(text)')
        and position('[^0-9a-z' in proc.prosrc)>0)
  union all
  -- Every registered automation root and exact registered callee is denied DIRECT PO/PO-item
  -- UPDATE/DELETE. Creation of a new revision is a different named command outside this registry.
  -- SCOPE, STATED SO IT IS NOT READ AS MORE: this is a body scan of the registered signatures. A
  -- root that reaches purchase_order_items through an unregistered helper one hop away is NOT
  -- caught here; `expected_callees` is the place a known hop is pinned, and P68 falsifies the arm
  -- so that "no rows" means "the scan ran and found nothing", not "the scan matched nothing".
  select 'purchase_order_snapshot_mutation',registry.function_signature
  from private.document_automation_authoritative_functions registry
  join pg_proc proc on proc.oid=to_regprocedure(registry.function_signature)
  where registry.automation_root and proc.prosrc~*
    '(update|delete[[:space:]]+from)[[:space:]]+(public[.])?purchase_order(s|_items)'
  union all
  -- Compare all live writers/setters of either activation store against the exact registry.
  select 'unregistered_activation_writer',proc.oid::regprocedure::text
  from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
  where ns.nspname in ('public','private') and (
    proc.prosrc~* 'insert[[:space:]]+into[[:space:]]+(public[.])?price_list_automation_scope_decisions'
    or proc.prosrc~* '(insert[[:space:]]+into|update)[[:space:]]+(public[.])?org_autonomy_policies'
  ) and not exists(select 1 from private.document_automation_authoritative_functions registry
    where registry.function_signature=proc.oid::regprocedure::text and registry.activation_writer)
  union all
  -- #252. Keyed on to_regprocedure, never on the rendered signature text: `regprocedure::text`
  -- drops the schema only while the function is visible, so a literal
  -- 'get_price_list_drift_metrics(integer)' stops matching the moment the stored form gains a
  -- `public.` prefix -- and a predicate that matches nothing returns no rows, which reads as PASS.
  -- That is the same trap as the A5 textual guard. The callee name comes from pg_proc.proname for
  -- the same reason: split_part on a schema-qualified signature searches for the wrong token.
  select 'numeric_drift_activation_call',activation.function_signature
  from private.document_automation_authoritative_functions drift
  join pg_proc drift_proc on drift_proc.oid=to_regprocedure(drift.function_signature)
  join private.document_automation_authoritative_functions activation on activation.activation_writer
  join pg_proc activation_proc on activation_proc.oid=to_regprocedure(activation.function_signature)
  where drift_proc.oid=to_regprocedure('public.get_price_list_drift_metrics(integer)')
    and position(activation_proc.proname in drift_proc.prosrc)>0
  union all
  -- ...and the arm above cannot go quiet by losing its subject. If the drift read model is absent,
  -- or is no longer the row this registry pins, that absence is itself the violation rather than
  -- an empty result.
  select 'numeric_drift_read_model_unpinned','public.get_price_list_drift_metrics(integer)'
  where to_regprocedure('public.get_price_list_drift_metrics(integer)') is null
    or not exists(select 1 from private.document_automation_authoritative_functions registry
      where to_regprocedure(registry.function_signature)
        =to_regprocedure('public.get_price_list_drift_metrics(integer)'))
  union all
  select 'qualified_writer_missing','apply_price_list_interpretation_qualified_impl lost atomic locks/writers'
  where not (
    pg_get_functiondef('public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)'::regprocedure) like '%insert into public.products%'
    and pg_get_functiondef('public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)'::regprocedure) like '%p1b_submit_supplier_price_list_internal%'
    and pg_get_functiondef('public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)'::regprocedure) like '%pg_advisory_xact_lock%'
  )
$$;
revoke all on function private.document_automation_negative_guard_violations() from public,anon,authenticated,service_role;

insert into private.scope_definer_enforcements(function_signature,body_hash,enforcement_kind,scope_proof)
select 'get_qualified_product_creation_dry_run(uuid)',md5(replace(proc.prosrc,e'\r','')),'filtered_read',
  '0182 filters the exact auth_org interpretation through its non-deleted null-or-auth_scopes document before returning counts.'
from pg_proc proc where proc.oid='public.get_qualified_product_creation_dry_run(uuid)'::regprocedure;

do $$ declare v text; begin
  if exists(select 1 from private.scope_definer_exemptions
            where function_signature=any(array[
              'public.apply_price_list_interpretation(uuid,uuid,uuid)',
              'apply_price_list_interpretation(uuid,uuid,uuid)']))
     or not exists(select 1 from private.scope_definer_exemptions
            where function_signature='public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)'::regprocedure::text
              and reason like '%0182:%') then
    raise exception '0182 stale/uncovered apply-price-list exemption';
  end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail) into v
  from private.document_automation_negative_guard_violations();
  if v is not null then raise exception e'0182 negative guards failed:\n%',v; end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail) into v
  from private.scope_enforcement_violations(); if v is not null then raise exception e'0182 scope:\n%',v; end if;
end $$;
