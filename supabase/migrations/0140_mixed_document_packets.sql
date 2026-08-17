-- 0140 — Mixed PDF packets: one immutable source, reviewed page manifest, isolated children.
-- The parent remains evidence only. Business effects start only after each derived child passes
-- the existing document pipeline, so a packet can never create one blended financial record.

insert into private.autonomy_policy_definitions (
  policy_key, description, baseline_enabled, baseline_min_confidence, kill_switch
) values (
  'document.packet_split',
  'May a complete multi-document PDF page manifest be materialized into isolated child PDFs without human approval. Existing organizations remain off; every segment must meet the configured confidence floor.',
  false, 0.900, false
);

-- 0076 deliberately left trusted-server SELECT in place while revoking every direct write, but
-- the later hardened default privileges mean tables created after 0039 no longer inherit it.
-- Packet policy resolution makes the documented read contract live again; keep the sole writer
-- as the reasoned SECURITY DEFINER command and restore only the read grant P13 has always pinned.
grant select on table public.org_autonomy_policies to service_role;

create or replace function private.document_packet_manifest_valid(
  p_manifest jsonb,
  p_page_count integer
) returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_segment jsonb;
  v_expected_ordinal integer := 1;
  v_expected_page integer := 1;
  v_confidence numeric;
begin
  if p_page_count not between 1 and 100
     or jsonb_typeof(p_manifest) is distinct from 'array'
     or jsonb_array_length(p_manifest) not between 1 and p_page_count then
    return false;
  end if;

  for v_segment in
    select value from jsonb_array_elements(p_manifest)
    order by (value ->> 'ordinal')::integer
  loop
    if jsonb_typeof(v_segment) is distinct from 'object'
       or not (v_segment ?& array[
         'ordinal','start_page','end_page','document_type','confidence'
       ])
       or jsonb_typeof(v_segment -> 'ordinal') is distinct from 'number'
       or jsonb_typeof(v_segment -> 'start_page') is distinct from 'number'
       or jsonb_typeof(v_segment -> 'end_page') is distinct from 'number'
       or jsonb_typeof(v_segment -> 'document_type') is distinct from 'string'
       or jsonb_typeof(v_segment -> 'confidence') not in ('number','null')
       or (v_segment ->> 'ordinal')::integer <> v_expected_ordinal
       or (v_segment ->> 'start_page')::integer <> v_expected_page
       or (v_segment ->> 'end_page')::integer < v_expected_page
       or (v_segment ->> 'end_page')::integer > p_page_count
       or v_segment ->> 'document_type' not in (
         'invoice','delivery_note','credit_note','price_list','quote',
         'payment_confirmation','tax_receipt','other'
       ) then
      return false;
    end if;
    if jsonb_typeof(v_segment -> 'confidence') = 'number' then
      v_confidence := (v_segment ->> 'confidence')::numeric;
      if v_confidence < 0 or v_confidence > 1 then return false; end if;
    end if;
    v_expected_page := (v_segment ->> 'end_page')::integer + 1;
    v_expected_ordinal := v_expected_ordinal + 1;
  end loop;
  return v_expected_page = p_page_count + 1;
exception when others then
  return false;
end
$$;

create or replace function private.document_packet_manifest_hash(p_manifest jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(extensions.digest(convert_to(coalesce(jsonb_agg(value order by (value ->> 'ordinal')::integer), '[]'::jsonb)::text, 'utf8'), 'sha256'), 'hex')
  from jsonb_array_elements(p_manifest)
$$;

revoke all on function private.document_packet_manifest_valid(jsonb,integer)
  from public, anon, authenticated, service_role;
revoke all on function private.document_packet_manifest_hash(jsonb)
  from public, anon, authenticated, service_role;

create table public.document_packets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  unit_id uuid,
  parent_document_id uuid not null,
  source_job_id uuid not null,
  source_interpretation_id uuid not null,
  page_count integer not null check (page_count between 2 and 100),
  source_partial boolean not null,
  confidence_threshold numeric(4,3) not null check (confidence_threshold > 0 and confidence_threshold <= 1),
  automatic_eligible boolean not null default false,
  status text not null check (status in ('needs_review','approved','materialized','failed')),
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  manifest_version integer not null default 1 check (manifest_version > 0),
  created_by uuid not null,
  approved_by uuid,
  approved_at timestamptz,
  approval_reason text,
  failure_code text,
  failure_message text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint document_packets_org_id_id_key unique (org_id,id),
  constraint document_packets_parent_key unique (org_id,parent_document_id),
  constraint document_packets_job_key unique (org_id,source_job_id),
  constraint document_packets_interpretation_key unique (org_id,source_interpretation_id),
  constraint document_packets_unit_fk foreign key (org_id,unit_id)
    references public.org_units(org_id,id) on delete restrict,
  constraint document_packets_document_fk foreign key (org_id,parent_document_id)
    references public.documents(org_id,id) on delete restrict,
  constraint document_packets_job_fk foreign key (org_id,source_job_id)
    references public.document_processing_jobs(org_id,id) on delete restrict,
  constraint document_packets_interpretation_fk foreign key (org_id,source_interpretation_id)
    references public.document_interpretations(org_id,id) on delete restrict,
  constraint document_packets_creator_fk foreign key (org_id,created_by)
    references public.profiles(org_id,id) on delete restrict,
  constraint document_packets_approver_fk foreign key (org_id,approved_by)
    references public.profiles(org_id,id) on delete restrict,
  constraint document_packets_approval_shape check (
    (status = 'needs_review' and approved_by is null and approved_at is null and approval_reason is null)
    or (status in ('approved','materialized') and approved_by is not null and approved_at is not null)
    or status = 'failed'
  ),
  constraint document_packets_failure_shape check (
    (status = 'failed' and failure_code is not null)
    or (status <> 'failed' and failure_code is null and failure_message is null)
  )
);

create table public.document_packet_segments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  unit_id uuid,
  packet_id uuid not null,
  ordinal integer not null check (ordinal > 0),
  start_page integer not null check (start_page > 0),
  end_page integer not null check (end_page >= start_page),
  document_type text not null check (document_type in (
    'invoice','delivery_note','credit_note','price_list','quote',
    'payment_confirmation','tax_receipt','other'
  )),
  confidence numeric(6,5) check (confidence is null or confidence between 0 and 1),
  child_document_id uuid,
  storage_path text,
  created_at timestamptz not null default statement_timestamp(),
  materialized_at timestamptz,
  constraint document_packet_segments_org_id_id_key unique (org_id,id),
  constraint document_packet_segments_ordinal_key unique (org_id,packet_id,ordinal),
  constraint document_packet_segments_child_key unique (org_id,child_document_id),
  constraint document_packet_segments_storage_key unique (org_id,storage_path),
  constraint document_packet_segments_unit_fk foreign key (org_id,unit_id)
    references public.org_units(org_id,id) on delete restrict,
  constraint document_packet_segments_packet_fk foreign key (org_id,packet_id)
    references public.document_packets(org_id,id) on delete cascade,
  constraint document_packet_segments_document_fk foreign key (org_id,child_document_id)
    references public.documents(org_id,id) on delete restrict,
  constraint document_packet_segments_materialized_shape check (
    (child_document_id is null and storage_path is null and materialized_at is null)
    or (child_document_id is not null and storage_path is not null and materialized_at is not null)
  )
);

create index document_packets_org_status_idx
  on public.document_packets(org_id,status,updated_at desc,id);
create index document_packet_segments_packet_idx
  on public.document_packet_segments(org_id,packet_id,ordinal);

create or replace function public.document_packet_manifest_rows_valid(p_packet_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  with packet as (
    select id,org_id,page_count from public.document_packets where id=p_packet_id
  ), ordered as (
    select segment.*,
      lag(segment.end_page) over(order by segment.ordinal) previous_end,
      row_number() over(order by segment.ordinal) expected_ordinal
    from public.document_packet_segments segment
    join packet on packet.org_id=segment.org_id and packet.id=segment.packet_id
  )
  select exists(select 1 from packet)
    and coalesce((select min(start_page)=1 and max(end_page)=(select page_count from packet)
      and count(*)=max(ordinal)
      and bool_and(ordinal=expected_ordinal)
      and bool_and(previous_end is null or start_page=previous_end+1)
      from ordered),false)
$$;

create or replace function public.enforce_document_packet_manifest_rows()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_packet_id uuid := coalesce(new.packet_id,old.packet_id);
begin
  if exists(select 1 from public.document_packets where id=v_packet_id)
     and not public.document_packet_manifest_rows_valid(v_packet_id) then
    raise exception 'document_packet_manifest_invalid' using errcode='23514';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end
$$;

create constraint trigger document_packet_segments_manifest_guard
after insert or update or delete on public.document_packet_segments
deferrable initially deferred for each row
execute function public.enforce_document_packet_manifest_rows();

revoke all on function public.document_packet_manifest_rows_valid(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_document_packet_manifest_rows()
  from public, anon, authenticated, service_role;

alter table public.document_packets enable row level security;
alter table public.document_packets force row level security;
alter table public.document_packet_segments enable row level security;
alter table public.document_packet_segments force row level security;

create policy document_packets_select on public.document_packets
  for select to authenticated using (
    org_id=auth_org() and (unit_id is null or unit_id=any(auth_scopes()))
  );
create policy document_packet_segments_select on public.document_packet_segments
  for select to authenticated using (
    org_id=auth_org() and (unit_id is null or unit_id=any(auth_scopes()))
  );
create policy scope_rider_document_packets on public.document_packets
  as restrictive for all to public
  using ((unit_id is null) or (unit_id = any (auth_scopes())));
create policy scope_rider_document_packet_segments on public.document_packet_segments
  as restrictive for all to public
  using ((unit_id is null) or (unit_id = any (auth_scopes())));

revoke all on table public.document_packets, public.document_packet_segments
  from public, anon, authenticated, service_role;
grant select on table public.document_packets, public.document_packet_segments to authenticated;
grant all on table public.document_packets, public.document_packet_segments to service_role;

create trigger document_packets_touch before update on public.document_packets
for each row execute function public.set_updated_at();
create trigger document_packets_audit after insert or update or delete on public.document_packets
for each row execute function public.audit_row_change();
create trigger document_packet_segments_audit after insert or update or delete on public.document_packet_segments
for each row execute function public.audit_row_change();

create or replace function public.service_record_document_packet(
  p_job_id uuid,
  p_interpretation_id uuid,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_document public.documents;
  v_interpretation public.document_interpretations;
  v_extraction public.document_extractions;
  v_manifest jsonb;
  v_hash text;
  v_policy record;
  v_threshold numeric;
  v_automatic boolean;
  v_packet public.document_packets;
  v_segment jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  select * into v_job from public.document_processing_jobs where id=p_job_id for update;
  if not found then raise exception 'document_processing_job_unknown' using errcode='P0002'; end if;
  select * into v_document from public.documents
    where org_id=v_job.org_id and id=v_job.document_id and deleted_at is null;
  select * into v_interpretation from public.document_interpretations
    where org_id=v_job.org_id and id=p_interpretation_id and job_id=v_job.id;
  select * into v_extraction from public.document_extractions
    where org_id=v_job.org_id and id=v_interpretation.extraction_id and job_id=v_job.id;
  if v_document.id is null or v_interpretation.id is null or v_extraction.id is null
     or v_document.mime_type <> 'application/pdf'
     or v_interpretation.interpreted_for_user_id is distinct from p_actor_id then
    raise exception 'document_packet_context_invalid' using errcode='23514';
  end if;
  v_manifest := v_interpretation.payload -> 'packet_segments';
  if jsonb_typeof(v_manifest) is distinct from 'array'
     or jsonb_array_length(v_manifest) < 2
     or not private.document_packet_manifest_valid(
       v_manifest,(v_extraction.payload #>> '{document,page_count}')::integer
     ) then
    raise exception 'document_packet_manifest_invalid' using errcode='22023';
  end if;
  v_hash := private.document_packet_manifest_hash(v_manifest);

  select * into v_packet from public.document_packets
    where org_id=v_job.org_id and source_interpretation_id=v_interpretation.id;
  if found then
    if v_packet.manifest_hash is distinct from v_hash then
      raise exception 'document_packet_manifest_conflict' using errcode='23505';
    end if;
    return jsonb_build_object(
      'packet_id',v_packet.id,'status',v_packet.status,'manifest_hash',v_packet.manifest_hash,
      'automatic_eligible',v_packet.automatic_eligible,'idempotent',true
    );
  end if;

  select * into v_policy from private.autonomy_policy_for_org(v_job.org_id,'document.packet_split');
  if not found then raise exception 'autonomy_policy_unresolved' using errcode='P0002'; end if;
  select baseline_min_confidence into v_threshold
    from private.autonomy_policy_definitions where policy_key='document.packet_split';
  v_threshold := coalesce(v_policy.min_confidence,v_threshold);
  v_automatic := coalesce(v_policy.autonomy_enabled,false)
    and not (v_extraction.payload #>> '{document,partial}')::boolean
    and (v_extraction.payload #>> '{document,page_count}')::integer <= 20
    and not exists (
      select 1 from jsonb_array_elements(v_manifest) item
      where jsonb_typeof(item -> 'confidence') <> 'number'
         or (item ->> 'confidence')::numeric < v_threshold
    );

  insert into public.document_packets(
    org_id,unit_id,parent_document_id,source_job_id,source_interpretation_id,page_count,
    source_partial,confidence_threshold,automatic_eligible,status,manifest_hash,
    created_by,approved_by,approved_at,approval_reason
  ) values (
    v_job.org_id,v_document.unit_id,v_document.id,v_job.id,v_interpretation.id,
    (v_extraction.payload #>> '{document,page_count}')::integer,
    (v_extraction.payload #>> '{document,partial}')::boolean,v_threshold,v_automatic,
    case when v_automatic then 'approved' else 'needs_review' end,v_hash,p_actor_id,
    case when v_automatic then p_actor_id end,
    case when v_automatic then statement_timestamp() end,
    case when v_automatic then 'פיצול אוטומטי לפי מדיניות הארגון' end
  ) returning * into v_packet;

  for v_segment in select value from jsonb_array_elements(v_manifest)
  loop
    insert into public.document_packet_segments(
      org_id,unit_id,packet_id,ordinal,start_page,end_page,document_type,confidence
    ) values (
      v_packet.org_id,v_packet.unit_id,v_packet.id,
      (v_segment ->> 'ordinal')::integer,(v_segment ->> 'start_page')::integer,
      (v_segment ->> 'end_page')::integer,v_segment ->> 'document_type',
      (v_segment ->> 'confidence')::numeric
    );
  end loop;
  set constraints document_packet_segments_manifest_guard immediate;

  return jsonb_build_object(
    'packet_id',v_packet.id,'status',v_packet.status,'manifest_hash',v_packet.manifest_hash,
    'automatic_eligible',v_packet.automatic_eligible,'idempotent',false
  );
end
$$;

create or replace function public.approve_document_packet(
  p_packet_id uuid,
  p_expected_manifest_hash text,
  p_segments jsonb,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason),'');
  v_packet public.document_packets;
  v_hash text;
  v_segment jsonb;
begin
  if v_org is null or v_actor is null or auth_role() not in ('owner','office')
     or not public.organization_write_allowed() then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  if v_reason is null then raise exception 'reason_required' using errcode='22023'; end if;
  select * into v_packet from public.document_packets
    where org_id=v_org and id=p_packet_id
      and (unit_id is null or unit_id=any(auth_scopes())) for update;
  if not found then raise exception 'document_packet_unknown' using errcode='P0002'; end if;
  if v_packet.status not in ('needs_review','approved') then
    raise exception 'document_packet_status_invalid' using errcode='55000';
  end if;
  if v_packet.manifest_hash is distinct from lower(p_expected_manifest_hash) then
    raise exception 'document_packet_stale_context' using errcode='40001';
  end if;
  if not private.document_packet_manifest_valid(p_segments,v_packet.page_count) then
    raise exception 'document_packet_manifest_invalid' using errcode='22023';
  end if;
  v_hash := private.document_packet_manifest_hash(p_segments);

  delete from public.document_packet_segments
    where org_id=v_packet.org_id and packet_id=v_packet.id;
  for v_segment in select value from jsonb_array_elements(p_segments)
  loop
    insert into public.document_packet_segments(
      org_id,unit_id,packet_id,ordinal,start_page,end_page,document_type,confidence
    ) values (
      v_packet.org_id,v_packet.unit_id,v_packet.id,
      (v_segment ->> 'ordinal')::integer,(v_segment ->> 'start_page')::integer,
      (v_segment ->> 'end_page')::integer,v_segment ->> 'document_type',
      case when jsonb_typeof(v_segment -> 'confidence')='number'
        then (v_segment ->> 'confidence')::numeric end
    );
  end loop;
  set constraints document_packet_segments_manifest_guard immediate;
  update public.document_packets set
    manifest_hash=v_hash,manifest_version=manifest_version+1,status='approved',
    automatic_eligible=false,approved_by=v_actor,approved_at=statement_timestamp(),
    approval_reason=v_reason
  where id=v_packet.id returning * into v_packet;
  return jsonb_build_object(
    'packet_id',v_packet.id,'status',v_packet.status,'manifest_hash',v_packet.manifest_hash,
    'manifest_version',v_packet.manifest_version
  );
end
$$;

create or replace function public.service_materialize_document_packet(
  p_packet_id uuid,
  p_expected_manifest_hash text,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_packet public.document_packets;
  v_parent public.documents;
  v_segment public.document_packet_segments;
  v_document public.documents;
  v_storage_path text;
  v_file_name text;
  v_kind text;
  v_etag text;
  v_job_id uuid;
  v_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  select * into v_packet from public.document_packets where id=p_packet_id for update;
  if not found then raise exception 'document_packet_unknown' using errcode='P0002'; end if;
  if v_packet.manifest_hash is distinct from lower(p_expected_manifest_hash) then
    raise exception 'document_packet_stale_context' using errcode='40001';
  end if;
  if v_packet.status='materialized' then
    return jsonb_build_object('packet_id',v_packet.id,'status','materialized','idempotent',true);
  end if;
  if v_packet.status <> 'approved' or v_packet.approved_by is null
     or p_actor_id is distinct from v_packet.approved_by
     or not public.document_packet_manifest_rows_valid(v_packet.id) then
    raise exception 'document_packet_status_invalid' using errcode='55000';
  end if;
  select * into v_parent from public.documents
    where org_id=v_packet.org_id and id=v_packet.parent_document_id and deleted_at is null;

  for v_segment in select * from public.document_packet_segments
    where org_id=v_packet.org_id and packet_id=v_packet.id order by ordinal for update
  loop
    v_storage_path := v_packet.org_id::text || '/document-segments/' ||
      v_packet.parent_document_id::text || '/' || v_segment.id::text || '.pdf';
    v_file_name := regexp_replace(v_parent.file_name,'\.pdf$','','i') ||
      ' — חלק ' || v_segment.ordinal::text || '.pdf';
    select lower(btrim(object.metadata ->> 'eTag','"')) into v_etag
    from storage.objects object where object.bucket_id='documents'
      and object.name=v_storage_path
      and lower(split_part(coalesce(object.metadata ->> 'mimetype',''),';',1))='application/pdf';
    if v_etag is null or v_etag !~ '^[0-9a-f]{16,128}(-[0-9]+)?$' then
      raise exception 'document_packet_segment_object_invalid' using errcode='22023';
    end if;
    v_kind := case when v_segment.document_type='credit_note' then 'credit'
      else v_segment.document_type end;
    select * into v_document from public.documents document
      where document.org_id=v_packet.org_id and document.storage_path=v_storage_path;
    if not found then
      insert into public.documents(
        org_id,entity_type,entity_id,storage_path,file_name,mime_type,uploaded_by,
        document_kind,supplier_id,document_date,unit_id
      ) values (
        v_packet.org_id,'inbox',null,v_storage_path,v_file_name,'application/pdf',
        v_parent.uploaded_by,v_kind,v_parent.supplier_id,v_parent.document_date,v_parent.unit_id
      ) returning * into v_document;
    elsif v_document.deleted_at is not null or v_document.document_kind<>v_kind then
      raise exception 'document_packet_segment_document_conflict' using errcode='23505';
    end if;
    select job.id into v_job_id from public.document_processing_jobs job
      where job.org_id=v_packet.org_id and job.document_id=v_document.id
        and job.input_checksum='etag:'||v_etag and job.status<>'failed'
      order by job.created_at desc limit 1;
    if v_job_id is null then
      insert into public.document_processing_jobs(
        org_id,document_id,requested_by,input_checksum,contract_version
      ) values (
        v_packet.org_id,v_document.id,v_parent.uploaded_by,'etag:'||v_etag,'1'
      ) returning id into v_job_id;
    end if;
    update public.document_packet_segments set
      child_document_id=v_document.id,storage_path=v_storage_path,
      materialized_at=coalesce(materialized_at,statement_timestamp())
    where id=v_segment.id;
    v_count := v_count+1;
  end loop;
  update public.document_packets set status='materialized' where id=v_packet.id;
  update public.document_processing_jobs set status='completed'
    where id=v_packet.source_job_id and status='review';
  insert into public.audit_logs(org_id,user_id,action,entity_type,entity_id,new_values,reason)
  values(v_packet.org_id,p_actor_id,'document_packet_materialized','document_packets',v_packet.id,
    jsonb_build_object('segment_count',v_count,'manifest_hash',v_packet.manifest_hash),
    coalesce(v_packet.approval_reason,'פיצול חבילת מסמכים'));
  return jsonb_build_object(
    'packet_id',v_packet.id,'status','materialized','segment_count',v_count,'idempotent',false
  );
end
$$;

revoke all on function public.service_record_document_packet(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_document_packet(uuid,uuid,uuid) to service_role;
revoke all on function public.approve_document_packet(uuid,text,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.approve_document_packet(uuid,text,jsonb,text) to authenticated;
revoke all on function public.service_materialize_document_packet(uuid,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.service_materialize_document_packet(uuid,text,uuid) to service_role;

-- Derived child objects are created by service_role and therefore have no browser owner. Their
-- immutable packet segment is the ownership proof used by checksum verification.
create or replace function private.document_processing_current_checksum(
  p_job public.document_processing_jobs
) returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_document public.documents;
  v_output public.document_scan_outputs;
  v_etag text;
begin
  if p_job.id is null or p_job.org_id is null or p_job.document_id is null then
    raise exception 'document_processing_source_invalid' using errcode='22023';
  end if;
  if p_job.scan_output_id is not null then
    select output.* into v_output from public.document_scan_outputs output
    join public.document_scan_decisions decision on decision.org_id=output.org_id
      and decision.scan_output_id=output.id and decision.decision='accepted'
    where output.org_id=p_job.org_id and output.id=p_job.scan_output_id
      and output.document_id=p_job.document_id;
    if not found then raise exception 'document_processing_scan_evidence_invalid' using errcode='42501'; end if;
    return 'etag:'||v_output.sha256;
  end if;
  select * into v_document from public.documents document
    where document.org_id=p_job.org_id and document.id=p_job.document_id and document.deleted_at is null;
  if not found then raise exception 'document_unknown' using errcode='P0002'; end if;
  if exists(select 1 from public.document_packet_segments segment
      where segment.org_id=v_document.org_id and segment.child_document_id=v_document.id
        and segment.storage_path=v_document.storage_path) then
    select lower(btrim(object.metadata ->> 'eTag','"')) into v_etag
    from storage.objects object where object.bucket_id='documents' and object.name=v_document.storage_path
      and lower(split_part(coalesce(object.metadata ->> 'mimetype',''),';',1))=lower(v_document.mime_type);
    if v_etag is null or v_etag !~ '^[0-9a-f]{16,128}(-[0-9]+)?$' then
      raise exception 'document_source_checksum_unavailable' using errcode='22023';
    end if;
    return 'etag:'||v_etag;
  end if;
  return public.smart_document_source_checksum(
    v_document.org_id,v_document.storage_path,v_document.mime_type,v_document.uploaded_by
  );
end
$$;

revoke all on function private.document_processing_current_checksum(public.document_processing_jobs)
  from public, anon, authenticated, service_role;

insert into private.scope_registry(table_name,scope_class,enforced) values
  ('document_packets','cross_scope',true),
  ('document_packet_segments','cross_scope',true);

insert into private.scope_definer_exemptions(function_signature,reason,target_wave) values
  ('public.service_record_document_packet(uuid,uuid,uuid)'::regprocedure::text,
    'service-role-trusted-path','0140 mixed document packets'),
  ('public.service_materialize_document_packet(uuid,text,uuid)'::regprocedure::text,
    'service-role-trusted-path','0140 mixed document packets'),
  ('public.enforce_document_packet_manifest_rows()'::regprocedure::text,
    'internal deferred constraint trigger; revoked from every API role and returns no tenant data',
    '0140 mixed document packets');

insert into private.scope_definer_enforcements(
  function_signature,body_hash,enforcement_kind,scope_proof
)
select reviewed.signature,md5(replace(proc.prosrc,e'\r','')),reviewed.kind,reviewed.proof
from (values
  ('approve_document_packet(uuid,text,jsonb,text)','assert_unit',
    '0140 resolves the tenant packet and asserts its persisted unit is null or in auth_scopes before replacement or approval.')
) reviewed(signature,kind,proof)
join pg_catalog.pg_proc proc on proc.oid=pg_catalog.to_regprocedure(reviewed.signature)
on conflict(function_signature) do update set body_hash=excluded.body_hash,
  enforcement_kind=excluded.enforcement_kind,scope_proof=excluded.scope_proof;

insert into private.tenant_export_registry(table_name,disposition,excluded_columns,rationale) values
  ('document_packets','include','{}','Mixed-PDF packet source, review state and immutable manifest identity.'),
  ('document_packet_segments','include','{}','Page ranges, detected types and links to isolated derived documents.')
on conflict(table_name) do update set disposition=excluded.disposition,
  excluded_columns=excluded.excluded_columns,rationale=excluded.rationale;

update private.tenant_export_registry registry
set exported_columns=(select array_agg(column_info.column_name order by column_info.ordinal_position)
    from information_schema.columns column_info where column_info.table_schema='public'
      and column_info.table_name=registry.table_name
      and not (column_info.column_name=any(registry.excluded_columns))),
    schema_hash=(select md5(string_agg(
      column_info.column_name||':'||column_info.data_type||':'||column_info.is_nullable,
      '|' order by column_info.ordinal_position))
    from information_schema.columns column_info where column_info.table_schema='public'
      and column_info.table_name=registry.table_name)
where registry.table_name in ('document_packets','document_packet_segments');

do $$
declare v_violations text;
begin
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0140 scope assertions failed:\n%',v_violations; end if;
  select string_agg(detail,e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0140 export assertions failed:\n%',v_violations; end if;
end
$$;
