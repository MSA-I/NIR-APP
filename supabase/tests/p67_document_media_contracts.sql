-- P67 -- HEIC derivative provenance and explicit full-frame scan source.
-- Static/catalog suite: worker bytes and Edge request validation are covered by Python/Deno.
\set ON_ERROR_STOP on
begin;

create function pg_temp.p67_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P67 document media assertion failed: %', p_message;
  end if;
end $$;

select pg_temp.p67_assert(
  to_regclass('public.document_scan_derivative_provenance') is not null,
  'derivative provenance table is missing');
select pg_temp.p67_assert(
  (select count(*) = 9 from information_schema.columns
   where table_schema = 'public' and table_name = 'document_scan_derivative_provenance'
     and column_name in (
       'source_sha256','source_bytes','source_width','source_height','source_format',
       'decoder','decoder_version','decoded_bytes','provenance_schema_version'
     )),
  'source hash, dimensions, decoder or version provenance is incomplete');
select pg_temp.p67_assert(
  exists (select 1 from pg_constraint
    where conrelid = 'public.document_scan_derivative_provenance'::regclass
      and conname = 'document_scan_derivative_provenance_decoded_shape'
      and pg_get_constraintdef(oid) like '%source_width%source_height%3%')
  and exists (select 1 from pg_constraint
    where conrelid = 'public.document_scan_derivative_provenance'::regclass
      and conname = 'document_scan_derivative_provenance_pixel_limit'
      and pg_get_constraintdef(oid) like '%40000000%'),
  'decoded byte or pixel limit is not structural');
select pg_temp.p67_assert(
  exists (select 1 from pg_trigger trigger
    where trigger.tgrelid = 'public.document_scan_derivative_provenance'::regclass
      and trigger.tgname = 'document_scan_derivative_provenance_immutable_trg'
      and not trigger.tgisinternal),
  'original-to-derivative provenance can be rewritten');
select pg_temp.p67_assert(
  not has_table_privilege('authenticated', 'public.document_scan_derivative_provenance', 'SELECT')
  and not has_table_privilege('authenticated', 'public.document_scan_derivative_provenance', 'INSERT')
  and has_table_privilege('service_role', 'public.document_scan_derivative_provenance', 'INSERT'),
  'browser can forge decoder provenance or service cannot record it');

select pg_temp.p67_assert(
  to_regprocedure('public.service_complete_document_scan_job_v2(uuid,uuid,text,uuid,uuid,text,text,text,bigint,integer,integer,text,jsonb,text,numeric,jsonb,jsonb)') is not null,
  'provenance-aware scan completion RPC is missing');
select pg_temp.p67_assert(
  not has_function_privilege('authenticated',
    'public.service_complete_document_scan_job_v2(uuid,uuid,text,uuid,uuid,text,text,text,bigint,integer,integer,text,jsonb,text,numeric,jsonb,jsonb)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.service_complete_document_scan_job_v2(uuid,uuid,text,uuid,uuid,text,text,text,bigint,integer,integer,text,jsonb,text,numeric,jsonb,jsonb)', 'EXECUTE'),
  'provenance-aware completion RPC grants are wrong');
select pg_temp.p67_assert(
  (select p.prosrc like '%service_complete_document_scan_job(%'
          and p.prosrc like '%document_scan_provenance_invalid%'
          and p.prosrc like '%decoded_bytes%'
   from pg_proc p
   where p.oid = 'public.service_complete_document_scan_job_v2(uuid,uuid,text,uuid,uuid,text,text,text,bigint,integer,integer,text,jsonb,text,numeric,jsonb,jsonb)'::regprocedure),
  'v2 completion does not atomically delegate output creation and validate provenance');

select pg_temp.p67_assert(
  exists (select 1 from pg_constraint
    where conrelid = 'public.document_scan_outputs'::regclass
      and conname = 'document_scan_outputs_corners_source_check'
      and pg_get_constraintdef(oid) like '%full_frame_fallback%')
  and exists (select 1 from pg_constraint
    where conrelid = 'public.document_scan_outputs'::regclass
      and conname = 'document_scan_outputs_full_frame_source_shape'
      and pg_get_constraintdef(oid) like '%[[0, 0], [1, 0], [1, 1], [0, 1]]%'),
  'full-frame fallback value or exact-corner shape is not structural');
select pg_temp.p67_assert(
  (select p.prosrc like '%full_frame_fallback%'
   from pg_proc p
   where p.oid = 'public.service_complete_document_scan_job(uuid,uuid,text,uuid,uuid,text,text,text,bigint,integer,integer,text,jsonb,text,numeric,jsonb)'::regprocedure),
  'service completion still rejects the third scan source');

-- Pre-0180 output rows lack a reliable discriminator. Exact full-frame coordinates alone are not
-- enough: a manual crop or a detected polygon can also touch every edge. They remain unchanged.
select pg_temp.p67_assert(
  not exists (
    select 1 from public.document_scan_outputs output
    where output.corners_source = 'automatic'
      and output.corners = '[[0,0],[1,0],[1,1],[0,1]]'::jsonb
      and coalesce(output.metrics ->> 'full_frame_fallback', '0')::numeric = 1
  ),
  'a deterministically marked historical fallback was left classified automatic');

select pg_temp.p67_assert(
  exists (select 1 from private.scope_registry
    where table_name = 'document_scan_derivative_provenance'
      and scope_class = 'derived' and not enforced)
  and exists (select 1 from private.tenant_export_registry
    where table_name = 'document_scan_derivative_provenance' and disposition = 'include'),
  'provenance table is missing scope/export classification');

rollback;
