-- 0179 -- #246: immutable original, bounded server derivative, explicit decoder provenance.
--
-- The existing scan output remains the PNG derivative and already points to its source document.
-- This migration adds the missing proof: hash/size/dimensions of the original bytes, decoded-memory
-- bounds and the exact decoder/version. The v2 completion wrapper writes output + provenance in
-- one DB transaction while the old completion RPC remains available during forward rollout.

create table public.document_scan_derivative_provenance (
  scan_output_id uuid primary key,
  org_id uuid not null references public.organizations(id) on delete restrict,
  document_id uuid not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_bytes bigint not null check (source_bytes between 1 and 10485760),
  source_width integer not null check (source_width between 32 and 65535),
  source_height integer not null check (source_height between 32 and 65535),
  -- Keep this list identical to SCAN_SOURCE_FORMATS in
  -- supabase/functions/document-preprocessing/contract.ts. The worker normalises any
  -- label it does not recognise to 'UNKNOWN', so a legal capture can never fail
  -- validation on the container label alone; the real ceilings are bytes, pixels and
  -- decoded memory. MPO is what Pillow reports for multi-picture JPEG, which is what
  -- iPhone and Android HDR captures produce and which upload already accepts as
  -- image/jpeg.
  source_format text not null check (
    source_format in ('JPEG','JPEG2000','MPO','PNG','WEBP','HEIF','HEIC','AVIF','GIF','BMP','TIFF','PPM','UNKNOWN')
  ),
  decoder text not null check (decoder in ('pillow', 'pillow-heif')),
  decoder_version text not null check (decoder_version ~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,99}$'),
  decoded_bytes bigint not null check (decoded_bytes between 1 and 104857600),
  provenance_schema_version text not null default '1' check (provenance_schema_version = '1'),
  created_at timestamptz not null default now(),
  constraint document_scan_derivative_provenance_org_id_id_key unique (org_id, scan_output_id),
  constraint document_scan_derivative_provenance_output_fk foreign key (org_id, scan_output_id)
    references public.document_scan_outputs(org_id, id) on delete restrict,
  constraint document_scan_derivative_provenance_document_fk foreign key (org_id, document_id)
    references public.documents(org_id, id) on delete restrict,
  constraint document_scan_derivative_provenance_pixel_limit check (
    source_width::bigint * source_height::bigint <= 40000000
  ),
  constraint document_scan_derivative_provenance_decoded_shape check (
    decoded_bytes = source_width::bigint * source_height::bigint * 3
  ),
  constraint document_scan_derivative_provenance_decoder_shape check (
    (source_format in ('HEIF','HEIC','AVIF') and decoder = 'pillow-heif')
    or (source_format not in ('HEIF','HEIC','AVIF') and decoder = 'pillow')
  )
);

create trigger document_scan_derivative_provenance_immutable_trg
  before update or delete on public.document_scan_derivative_provenance
  for each row execute function public.reject_document_scan_evidence_mutation();

alter table public.document_scan_derivative_provenance enable row level security;
alter table public.document_scan_derivative_provenance force row level security;
revoke all on table public.document_scan_derivative_provenance from public, anon, authenticated;
-- Full CRUD, matching document_scan_outputs (0136:391-393) -- the row this table is 1:1 with, under
-- the same reject_document_scan_evidence_mutation trigger. Locking the child while the parent stays
-- writable would buy nothing and would leave the two halves of one scan record on different rules.
grant select, insert, update, delete on table public.document_scan_derivative_provenance to service_role;

create or replace function public.service_complete_document_scan_job_v2(
  p_job_id uuid,
  p_processing_attempt_id uuid,
  p_lease_owner text,
  p_egress_lease_id uuid,
  p_egress_lease_token uuid,
  p_input_checksum text,
  p_storage_path text,
  p_sha256 text,
  p_byte_size bigint,
  p_width integer,
  p_height integer,
  p_output_mode text,
  p_corners jsonb,
  p_corners_source text,
  p_rotation_degrees numeric,
  p_metrics jsonb,
  p_provenance jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_output public.document_scan_outputs;
  v_existing public.document_scan_derivative_provenance;
  v_keys text[];
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select array_agg(item.key order by item.key) into v_keys
  from jsonb_object_keys(p_provenance) as item(key);
  if jsonb_typeof(p_provenance) <> 'object'
     or v_keys is distinct from array[
       'decoded_bytes','decoder','decoder_version','schema_version','source_bytes',
       'source_format','source_height','source_sha256','source_width'
     ]::text[]
     or p_provenance ->> 'schema_version' <> '1'
     or coalesce(p_provenance ->> 'source_sha256', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_provenance ->> 'source_bytes', '') !~ '^[0-9]{1,8}$'
     or (p_provenance ->> 'source_bytes')::bigint not between 1 and 10485760
     or coalesce(p_provenance ->> 'source_width', '') !~ '^[0-9]{1,5}$'
     or coalesce(p_provenance ->> 'source_height', '') !~ '^[0-9]{1,5}$'
     or (p_provenance ->> 'source_width')::integer not between 32 and 65535
     or (p_provenance ->> 'source_height')::integer not between 32 and 65535
     or (p_provenance ->> 'source_width')::bigint
        * (p_provenance ->> 'source_height')::bigint > 40000000
     or coalesce(p_provenance ->> 'decoded_bytes', '') !~ '^[0-9]{1,9}$'
     or (p_provenance ->> 'decoded_bytes')::bigint
        <> (p_provenance ->> 'source_width')::bigint
         * (p_provenance ->> 'source_height')::bigint * 3
     or (p_provenance ->> 'decoded_bytes')::bigint > 104857600
     or p_provenance ->> 'source_format' not in
        ('JPEG','JPEG2000','MPO','PNG','WEBP','HEIF','HEIC','AVIF','GIF','BMP','TIFF','PPM','UNKNOWN')
     or p_provenance ->> 'decoder' not in ('pillow','pillow-heif')
     or (p_provenance ->> 'decoder_version') !~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,99}$'
     or ((p_provenance ->> 'source_format') in ('HEIF','HEIC','AVIF'))
        is distinct from ((p_provenance ->> 'decoder') = 'pillow-heif') then
    raise exception 'document_scan_provenance_invalid' using errcode = '22023';
  end if;

  v_result := public.service_complete_document_scan_job(
    p_job_id, p_processing_attempt_id, p_lease_owner,
    p_egress_lease_id, p_egress_lease_token, p_input_checksum,
    p_storage_path, p_sha256, p_byte_size, p_width, p_height,
    p_output_mode, p_corners, p_corners_source, p_rotation_degrees, p_metrics
  );
  select output.* into v_output from public.document_scan_outputs output
  where output.id = (v_result ->> 'output_id')::uuid and output.scan_job_id = p_job_id;
  if not found then raise exception 'document_scan_output_unknown' using errcode = 'P0002'; end if;

  insert into public.document_scan_derivative_provenance (
    scan_output_id, org_id, document_id, source_sha256, source_bytes,
    source_width, source_height, source_format, decoder, decoder_version, decoded_bytes
  ) values (
    v_output.id, v_output.org_id, v_output.document_id,
    lower(p_provenance ->> 'source_sha256'), (p_provenance ->> 'source_bytes')::bigint,
    (p_provenance ->> 'source_width')::integer, (p_provenance ->> 'source_height')::integer,
    p_provenance ->> 'source_format', p_provenance ->> 'decoder',
    p_provenance ->> 'decoder_version', (p_provenance ->> 'decoded_bytes')::bigint
  ) on conflict (scan_output_id) do nothing;

  select provenance.* into v_existing from public.document_scan_derivative_provenance provenance
  where provenance.scan_output_id = v_output.id;
  if v_existing.source_sha256 is distinct from lower(p_provenance ->> 'source_sha256')
     or v_existing.source_bytes is distinct from (p_provenance ->> 'source_bytes')::bigint
     or v_existing.source_width is distinct from (p_provenance ->> 'source_width')::integer
     or v_existing.source_height is distinct from (p_provenance ->> 'source_height')::integer
     or v_existing.source_format is distinct from p_provenance ->> 'source_format'
     or v_existing.decoder is distinct from p_provenance ->> 'decoder'
     or v_existing.decoder_version is distinct from p_provenance ->> 'decoder_version'
     or v_existing.decoded_bytes is distinct from (p_provenance ->> 'decoded_bytes')::bigint then
    raise exception 'document_scan_provenance_conflict' using errcode = '23505';
  end if;
  return v_result;
end
$$;

revoke all on function public.service_complete_document_scan_job_v2(
  uuid,uuid,text,uuid,uuid,text,text,text,bigint,integer,integer,text,jsonb,text,numeric,jsonb,jsonb
) from public, anon, authenticated;
grant execute on function public.service_complete_document_scan_job_v2(
  uuid,uuid,text,uuid,uuid,text,text,text,bigint,integer,integer,text,jsonb,text,numeric,jsonb,jsonb
) to service_role;

insert into private.scope_registry (table_name, scope_class, enforced)
values ('document_scan_derivative_provenance', 'derived', false);
insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale)
values ('document_scan_derivative_provenance', 'include', '{}',
  'Immutable original-to-scan derivative hashes, dimensions, safety bounds and decoder version.')
on conflict (table_name) do update set disposition = excluded.disposition,
  excluded_columns = excluded.excluded_columns, rationale = excluded.rationale;
update private.tenant_export_registry registry
set exported_columns = (select array_agg(c.column_name order by c.ordinal_position)
      from information_schema.columns c where c.table_schema = 'public'
        and c.table_name = registry.table_name and not (c.column_name = any(registry.excluded_columns))),
    schema_hash = (select md5(string_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable,
      '|' order by c.ordinal_position)) from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = registry.table_name)
where registry.table_name = 'document_scan_derivative_provenance';

do $$
declare v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0179 scope assertions failed:\n%', v_violations; end if;
  select string_agg(detail, e'\n' order by detail) into v_violations
    from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0179 export assertions failed:\n%', v_violations; end if;
end $$;
