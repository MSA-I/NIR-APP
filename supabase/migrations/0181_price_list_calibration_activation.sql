-- 0181 -- #248 owner calibration batches, office preparation, platform-only activation recheck.

create table public.price_list_calibration_preparations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  shadow_run_id uuid not null,
  line_ids uuid[] not null check (cardinality(line_ids) between 1 and 5000),
  idempotency_key uuid not null,
  prepared_by uuid not null,
  prepared_role public.user_role not null check (prepared_role in ('owner','office')),
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  created_at timestamptz not null default now(),
  constraint price_list_calibration_preparations_org_id_id_key unique(org_id,id),
  constraint price_list_calibration_preparations_idempotency_key unique(org_id,idempotency_key),
  constraint price_list_calibration_preparations_run_fk foreign key(org_id,shadow_run_id)
    references public.price_list_shadow_runs(org_id,id) on delete restrict,
  constraint price_list_calibration_preparations_actor_fk foreign key(org_id,prepared_by)
    references public.profiles(org_id,id) on delete restrict
);
create trigger price_list_calibration_preparations_immutable before update or delete
  on public.price_list_calibration_preparations for each row
  execute function public.reject_price_list_measurement_mutation();
alter table public.price_list_calibration_preparations enable row level security;
alter table public.price_list_calibration_preparations force row level security;
revoke all on public.price_list_calibration_preparations from public,anon,authenticated,service_role;
grant select,insert on public.price_list_calibration_preparations to service_role;

create function public.get_price_list_calibration_preparation_queue(p_limit integer default 50)
returns table(
  shadow_run_id uuid, shadow_line_id uuid, document_id uuid, file_name text,
  supplier_id uuid, supplier_name text, line_index integer, source_row integer,
  preparation_id uuid, prepared_by uuid, prepared_role public.user_role,
  preparation_created_at timestamptz,
  predicted_action text, reason_code text, product_id uuid, matched_product_name text,
  sku text, barcode text, product_name text, unit text,
  proposed_unit_price numeric, current_unit_price numeric, already_reviewed boolean
) language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_org uuid:=auth_org();
begin
  if v_org is null or auth.uid() is null or auth_role() not in ('owner','office') then
    raise exception 'calibration_preparation_not_authorized' using errcode='42501';
  end if;
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'calibration_preparation_limit_invalid' using errcode='22023';
  end if;
  return query
  with latest_review as (
    select distinct on (review.shadow_line_id) review.shadow_line_id,review.id
    from public.price_list_calibration_reviews review where review.org_id=v_org
    order by review.shadow_line_id,review.revision desc
  )
  select run.id,line.id,run.document_id,document.file_name,run.supplier_id,supplier.name,
    line.line_index,line.source_row,preparation.id,preparation.prepared_by,preparation.prepared_role,
    preparation.created_at,line.predicted_action,line.reason_code,line.product_id,product.name,
    line.sku,line.barcode,line.product_name,line.unit,line.proposed_unit_price,line.current_unit_price,
    latest.id is not null
  from public.price_list_shadow_runs run
  join public.documents document on document.org_id=run.org_id and document.id=run.document_id
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id=any(public.auth_scopes()))
  join public.price_list_shadow_lines line on line.org_id=run.org_id and line.shadow_run_id=run.id
  left join public.suppliers supplier on supplier.org_id=run.org_id and supplier.id=run.supplier_id
  left join public.products product on product.org_id=line.org_id and product.id=line.product_id
  left join latest_review latest on latest.shadow_line_id=line.id
  left join lateral (
    select prepared.id,prepared.prepared_by,prepared.prepared_role,prepared.created_at
    from public.price_list_calibration_preparations prepared
    where prepared.org_id=run.org_id and prepared.shadow_run_id=run.id
    order by prepared.created_at desc,prepared.id desc limit 1
  ) preparation on true
  where run.org_id=v_org
  order by run.created_at,line.line_index,line.id limit p_limit;
end $$;
revoke all on function public.get_price_list_calibration_preparation_queue(integer)
  from public,anon,service_role;
grant execute on function public.get_price_list_calibration_preparation_queue(integer)
  to authenticated;

create function public.prepare_price_list_calibration_batch(
  p_shadow_run_id uuid, p_line_ids uuid[], p_idempotency_key uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_org uuid:=auth_org(); v_actor uuid:=auth.uid(); v_role public.user_role:=auth_role();
  v_reason text:=nullif(btrim(p_reason),''); v_ids uuid[]; v_existing public.price_list_calibration_preparations;
  v_id uuid:=gen_random_uuid();
begin
  if v_org is null or v_actor is null or v_role not in ('owner','office') then
    raise exception 'calibration_preparation_not_authorized' using errcode='42501';
  end if;
  if p_shadow_run_id is null or p_idempotency_key is null or v_reason is null
     or p_line_ids is null or cardinality(p_line_ids) not between 1 and 5000 then
    raise exception 'calibration_preparation_invalid' using errcode='22023';
  end if;
  select array_agg(distinct id order by id) into v_ids from unnest(p_line_ids) id;
  if cardinality(v_ids)<>cardinality(p_line_ids) or
     (select count(*) from public.price_list_shadow_lines line
      where line.org_id=v_org and line.shadow_run_id=p_shadow_run_id and line.id=any(v_ids))<>cardinality(v_ids) then
    raise exception 'calibration_preparation_lines_invalid' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('price-list-calibration-prep:'||v_org||':'||p_idempotency_key,0));
  select * into v_existing from public.price_list_calibration_preparations
  where org_id=v_org and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.shadow_run_id is distinct from p_shadow_run_id or v_existing.line_ids is distinct from v_ids
       or v_existing.reason is distinct from v_reason then
      raise exception 'calibration_preparation_idempotency_conflict' using errcode='55000';
    end if;
    return jsonb_build_object('preparation_id',v_existing.id,'line_count',cardinality(v_ids),'idempotent',true);
  end if;
  insert into public.price_list_calibration_preparations(
    id,org_id,shadow_run_id,line_ids,idempotency_key,prepared_by,prepared_role,reason
  ) values(v_id,v_org,p_shadow_run_id,v_ids,p_idempotency_key,v_actor,v_role,v_reason);
  insert into public.audit_logs(org_id,user_id,action,entity_type,entity_id,new_values,reason)
  values(v_org,v_actor,'price_list_calibration_batch_prepared','price_list_calibration_preparations',v_id,
    jsonb_build_object('shadow_run_id',p_shadow_run_id,'line_count',cardinality(v_ids),'prepared_role',v_role),v_reason);
  return jsonb_build_object('preparation_id',v_id,'line_count',cardinality(v_ids),'idempotent',false);
end $$;
revoke all on function public.prepare_price_list_calibration_batch(uuid,uuid[],uuid,text) from public,anon,service_role;
grant execute on function public.prepare_price_list_calibration_batch(uuid,uuid[],uuid,text) to authenticated;

create function public.record_price_list_calibration_batch(
  p_preparation_id uuid, p_idempotency_key uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_org uuid:=auth_org(); v_actor uuid:=auth.uid(); v_reason text:=nullif(btrim(p_reason),'');
  v_preparation public.price_list_calibration_preparations; v_line public.price_list_shadow_lines;
  v_child uuid; v_count integer:=0; v_result jsonb;
begin
  if v_org is null or v_actor is null or auth_role()<>'owner' then
    raise exception 'calibration_batch_review_not_authorized' using errcode='42501';
  end if;
  if p_preparation_id is null or p_idempotency_key is null or v_reason is null then
    raise exception 'calibration_batch_review_invalid' using errcode='22023';
  end if;
  select * into v_preparation from public.price_list_calibration_preparations preparation
  where preparation.org_id=v_org and preparation.id=p_preparation_id for share;
  if not found then raise exception 'calibration_preparation_unknown' using errcode='P0002'; end if;
  if exists(select 1 from public.price_list_calibration_preparations newer
    where newer.org_id=v_org and newer.shadow_run_id=v_preparation.shadow_run_id
      and (newer.created_at,newer.id)>(v_preparation.created_at,v_preparation.id)) then
    raise exception 'calibration_preparation_superseded' using errcode='55000';
  end if;
  for v_line in select * from public.price_list_shadow_lines line
    where line.org_id=v_org and line.shadow_run_id=v_preparation.shadow_run_id
      and line.id=any(v_preparation.line_ids) order by line.id
  loop
    v_child := (substr(md5(p_idempotency_key::text||':'||v_line.id::text),1,8)||'-'||
      substr(md5(p_idempotency_key::text||':'||v_line.id::text),9,4)||'-4'||
      substr(md5(p_idempotency_key::text||':'||v_line.id::text),14,3)||'-8'||
      substr(md5(p_idempotency_key::text||':'||v_line.id::text),18,3)||'-'||
      substr(md5(p_idempotency_key::text||':'||v_line.id::text),21,12))::uuid;
    v_result:=public.record_price_list_calibration_review(
      v_line.id,v_child,'correct','{}'::text[],v_line.predicted_action,
      v_line.product_id,v_line.proposed_unit_price,v_reason);
    v_count:=v_count+1;
  end loop;
  if v_count<>cardinality(v_preparation.line_ids) then
    raise exception 'calibration_preparation_lines_changed' using errcode='55000';
  end if;
  return jsonb_build_object('preparation_id',v_preparation.id,'reviewed_count',v_count,'idempotent',
    coalesce((v_result->>'idempotent')::boolean,false));
end $$;
revoke all on function public.record_price_list_calibration_batch(uuid,uuid,text) from public,anon,service_role;
grant execute on function public.record_price_list_calibration_batch(uuid,uuid,text) to authenticated;

-- Recheck Platform identity and fresh password after waiting on the scope fingerprint lock.
do $patch_platform_recheck$
declare v_definition text; v_anchor text; v_replacement text;
begin
  select pg_get_functiondef('public.platform_set_price_list_automation_scope(uuid,uuid,text,uuid,text)'::regprocedure)
    into v_definition;
  v_anchor := '  perform pg_advisory_xact_lock(hashtextextended('||e'\n'||
    '    ''price-list-scope:'' || p_org_id::text || '':'' || v_fingerprint, 0'||e'\n'||'  ));';
  v_replacement := v_anchor||e'\n'||
    '  if auth.uid() is distinct from v_actor or not public.is_platform_admin() then'||e'\n'||
    '    raise exception ''not_platform_admin'' using errcode = ''42501'';'||e'\n'||
    '  end if;'||e'\n'||'  perform public.assert_recent_password_authentication();';
  if position(v_anchor in v_definition)=0 then raise exception '0181: platform scope lock anchor moved'; end if;
  execute replace(v_definition,v_anchor,v_replacement);
end $patch_platform_recheck$;

insert into private.scope_registry(table_name,scope_class,enforced)
values('price_list_calibration_preparations','org_global',false);
insert into private.tenant_export_registry(table_name,disposition,excluded_columns,rationale)
values('price_list_calibration_preparations','exclude','{}','Ephemeral office/owner calibration preparation; owner reviews export separately.')
on conflict(table_name) do update set disposition=excluded.disposition,excluded_columns=excluded.excluded_columns,rationale=excluded.rationale;
update private.tenant_export_registry registry set exported_columns='{}',schema_hash=(select md5(string_agg(
  c.column_name||':'||c.data_type||':'||c.is_nullable,'|' order by c.ordinal_position)) from information_schema.columns c
  where c.table_schema='public' and c.table_name=registry.table_name)
where registry.table_name='price_list_calibration_preparations';

insert into private.scope_definer_enforcements(function_signature,body_hash,enforcement_kind,scope_proof)
select 'get_price_list_calibration_preparation_queue(integer)',md5(replace(proc.prosrc,e'\r','')),
  'filtered_read','0181 filters auth_org runs through non-deleted documents whose unit is null or in auth_scopes; returns only IDs and review-safe line fields.'
from pg_proc proc where proc.oid='public.get_price_list_calibration_preparation_queue(integer)'::regprocedure;

do $$ declare v text; begin
  if position('auth.uid() is distinct from v_actor' in pg_get_functiondef(
    'public.platform_set_price_list_automation_scope(uuid,uuid,text,uuid,text)'::regprocedure))=0 then
    raise exception '0181: platform identity is not rechecked under lock'; end if;
  if pg_get_functiondef('public.get_price_list_calibration_preparation_queue(integer)'::regprocedure)
       ~* '(provider|model|prompt_version|schema_version|payload|decision_confidence|evidence_block_ids)' then
    raise exception '0181: office preparation projection exposes technical/raw evidence';
  end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail) into v
  from private.scope_enforcement_violations(); if v is not null then raise exception e'0181 scope:\n%',v; end if;
  select string_agg(detail,e'\n' order by detail) into v from private.tenant_export_registry_violations();
  if v is not null then raise exception e'0181 export:\n%',v; end if;
end $$;
