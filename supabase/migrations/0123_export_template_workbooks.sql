-- 0123 -- The accountant's own spreadsheet, as the template.
--
-- The owner's answer on 11.08.2026 was "build the full mechanism, and give it a dedicated upload
-- button". 0047 already holds the half that survives an upload: templates scoped and versioned,
-- immutable approved versions, one active version per scope, and a contract that resolves fields
-- against a document. What it cannot hold is the WORKBOOK -- there is no bytes column, no checksum,
-- no bucket and nothing that ever parsed a sheet. So this migration adds the missing half rather
-- than a second template system, which is the thing the plan warned against by name.
--
-- TWO CHANGES OF SHAPE, and both are additive.
--
-- 1. A SECOND SCOPE DIMENSION. 0047's scope is (owner_user_id, document_type, supplier_id) -- it
--    answers "which template renders THIS DOCUMENT". The reports an accountant actually receives
--    are not documents: the monthly report, the expense summary and the new product purchase
--    summary are whole-period exports with no document_type at all. `export_key` is that dimension,
--    a stable identifier the code names rather than a label somebody types, and the scope check and
--    the active-version index both widen to include it. A template with an export_key has no
--    document_type and no supplier, and vice versa: mixing them would let one workbook claim two
--    unrelated jobs.
--
-- 2. THE WORKBOOK ITSELF, on the VERSION rather than on the template. A version is already
--    immutable once approved (0047's guard), which is exactly the right lifetime for "the file the
--    accountant sent us in March". Uploading a new workbook is a new version and an approval, and
--    the old one stays readable beside the exports that were produced from it.
--
-- WHAT THE SERVER CANNOT CHECK, stated rather than pretended. Postgres cannot open an xlsx. Sheet
-- names, headers, named ranges and placeholders are parsed in the browser by SheetJS and arrive
-- here as a jsonb the person then APPROVES -- so the shape below is a record of what a human agreed
-- to, not an assertion about the bytes. What the server does enforce: the path is inside the
-- tenant's folder, the checksum is a sha-256, the file is one of the two spreadsheet mime types,
-- macro-enabled formats are refused by name, and a workbook can only be attached to a version
-- nobody has approved yet.
--
-- WHY MACROS ARE REFUSED IN THE DATABASE and not only in the upload form: a template is a file this
-- system hands to an accountant every month, signed by our name. `.xlsm` and `.xlsb` carry VBA, and
-- "the browser checks the extension" is a sentence that stops being true the first time somebody
-- calls the RPC directly.

-- ===== 1. The report scope =====
alter table public.document_export_templates
  add column if not exists export_key text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_export_templates_export_key_shape') then
    alter table public.document_export_templates
      add constraint document_export_templates_export_key_shape check (
        export_key is null
        or (
          -- Named by the code, not typed by a person: a stable key is what lets an export find its
          -- template three releases later.
          export_key in ('accountant_monthly_report', 'owner_expense_summary',
                         'product_purchase_summary')
          and document_type is null
          and supplier_id is null
        )
      );
  end if;
end
$$;

-- The active-scope uniqueness has to learn about the new dimension, or two report templates for
-- the same key would both be active and `resolve_document_export_template_version` would pick by
-- accident.
drop index if exists document_export_templates_active_scope_key;
create unique index document_export_templates_active_scope_key
  on public.document_export_templates (
    org_id, owner_user_id, document_type, supplier_id, export_key
  ) nulls not distinct
  where active;

comment on column public.document_export_templates.export_key is
  'For a REPORT template: which export it renders (0123). Mutually exclusive with document_type '
  'and supplier_id, because a document template and a period report answer different questions. '
  'Null for the document templates 0047 was written for.';

-- ===== 2. The workbook, on the version =====
alter table public.document_export_template_versions
  add column if not exists workbook_path text,
  add column if not exists workbook_name text,
  add column if not exists workbook_bytes integer,
  add column if not exists workbook_checksum text,
  add column if not exists workbook_mime text,
  -- What the browser read out of the file and a person then approved: sheet names in order, the
  -- header row of each, the named ranges, and the placeholders found in cells. This is the mapping
  -- surface, and it is a record of an agreement rather than a claim about the bytes.
  add column if not exists workbook_sheets jsonb,
  add column if not exists workbook_placeholders jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_export_template_versions_workbook_coherent') then
    alter table public.document_export_template_versions
      add constraint document_export_template_versions_workbook_coherent check (
        (workbook_path is null and workbook_bytes is null and workbook_checksum is null
          and workbook_mime is null and workbook_name is null)
        or (workbook_path is not null and workbook_bytes is not null
          and workbook_checksum is not null and workbook_mime is not null
          and workbook_name is not null)
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_export_template_versions_workbook_shape') then
    alter table public.document_export_template_versions
      add constraint document_export_template_versions_workbook_shape check (
        (workbook_path is null or char_length(workbook_path) between 1 and 400)
        -- 20 MB. A report template is a formatted shell, not a data set; anything larger is
        -- somebody uploading last year's actual report by mistake.
        and (workbook_bytes is null or workbook_bytes between 1 and 20971520)
        and (workbook_checksum is null or workbook_checksum ~ '^[0-9a-f]{64}$')
        and (workbook_name is null or char_length(workbook_name) between 1 and 260)
        and (
          workbook_mime is null
          -- xlsx and xls. NOT xlsm and NOT xlsb: see the header for why this lives here and not
          -- only in the upload form.
          or workbook_mime in (
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel')
        )
        and (workbook_sheets is null or jsonb_typeof(workbook_sheets) = 'array')
        and (workbook_placeholders is null or jsonb_typeof(workbook_placeholders) = 'array')
      );
  end if;
end
$$;

comment on column public.document_export_template_versions.workbook_path is
  'Path in the private `export-templates` bucket, always {org_id}/… (0123). The accountant''s own '
  'file, kept because it IS the template -- the formatting, the sheet names and the layout are the '
  'part a standard export cannot reproduce.';
comment on column public.document_export_template_versions.workbook_sheets is
  'Sheets, headers and named ranges as the browser parsed them and a person approved them (0123). '
  'Postgres cannot open an xlsx, so this is a record of an agreement, not an assertion about bytes.';

-- ===== 3. The private bucket =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'export-templates', 'export-templates', false, 20971520,
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel'
  ]::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists export_templates_storage_insert on storage.objects;
create policy export_templates_storage_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'export-templates'
  and array_length(storage.foldername(name), 1) = 1
  and (storage.foldername(name))[1] = auth_org()::text
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and auth_role() in ('owner', 'office')
);

drop policy if exists export_templates_storage_select on storage.objects;
create policy export_templates_storage_select
on storage.objects for select to authenticated
using (
  bucket_id = 'export-templates'
  and (storage.foldername(name))[1] = auth_org()::text
  -- Readable, unlike the feedback bucket, and deliberately so: this file is the tenant's OWN
  -- template and they have to be able to download the one that is live to check it. The two roles
  -- are the two that may manage templates at all.
  and auth_role() in ('owner', 'office')
);

-- ===== 4. Attaching a workbook to an unapproved version =====
create or replace function public.attach_export_template_workbook(
  p_version_id uuid,
  p_path text,
  p_name text,
  p_bytes integer,
  p_checksum text,
  p_mime text,
  p_sheets jsonb,
  p_placeholders jsonb,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_version public.document_export_template_versions;
begin
  if v_actor is null or v_org is null or v_role not in ('owner', 'office') then
    raise exception 'export_template_not_authorized' using errcode = '42501';
  end if;

  -- The path is checked against the tenant BEFORE anything is written, for the reason every bucket
  -- in this system states: the prefix is read and compared, never trusted.
  if p_path is null or p_path <> v_org::text || '/' || split_part(p_path, '/', 2)
     or split_part(p_path, '/', 2) = '' or position('/' in split_part(p_path, '/', 2)) > 0 then
    raise exception 'export_template_path_invalid' using errcode = '22023';
  end if;
  if p_checksum is null or p_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'export_template_checksum_invalid' using errcode = '22023';
  end if;
  if p_mime not in ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    'application/vnd.ms-excel') then
    -- The message names the reason rather than the rule: an accountant who sent an .xlsm needs to
    -- know it was the macros, not the spelling.
    raise exception 'export_template_format_refused' using errcode = '22023';
  end if;

  select * into v_version
  from public.document_export_template_versions v
  where v.org_id = v_org and v.id = p_version_id
  for update;
  if not found then
    raise exception 'export_template_version_not_found' using errcode = 'P0002';
  end if;
  -- An approved version is the record of what was agreed. Swapping the file underneath it would
  -- make every export produced from it unexplainable.
  if v_version.approved_at is not null then
    raise exception 'export_template_version_already_approved' using errcode = '55000';
  end if;

  update public.document_export_template_versions
  set workbook_path = p_path,
      workbook_name = p_name,
      workbook_bytes = p_bytes,
      workbook_checksum = p_checksum,
      workbook_mime = p_mime,
      workbook_sheets = p_sheets,
      workbook_placeholders = p_placeholders
  where org_id = v_org and id = p_version_id;

  insert into public.audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    v_org, v_actor, 'export_template_workbook_attached',
    'document_export_template_version', p_version_id,
    jsonb_build_object('path', p_path, 'name', p_name, 'bytes', p_bytes,
                       'checksum', p_checksum, 'mime', p_mime),
    coalesce(v_reason, 'צירוף חוברת לתבנית ייצוא — ללא הערה מהמשתמש')
  );

  return jsonb_build_object('version_id', p_version_id, 'attached', true);
end
$$;

revoke all on function public.attach_export_template_workbook(
  uuid, text, text, integer, text, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.attach_export_template_workbook(
  uuid, text, text, integer, text, text, jsonb, jsonb, text) to authenticated;

comment on function public.attach_export_template_workbook(
  uuid, text, text, integer, text, text, jsonb, jsonb, text) is
  'Records the uploaded workbook against a template version nobody has approved yet (0123). '
  'owner/office only, tenant-prefixed path verified rather than trusted, sha-256 checksum, and '
  'macro-enabled formats refused by name because a template is a file this system hands to an '
  'accountant under our name. An approved version cannot have its file swapped: that would make '
  'every export produced from it unexplainable.';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values (
  'attach_export_template_workbook(uuid,text,text,integer,text,text,jsonb,jsonb,text)',
  '0123 refuses any actor failing auth_org and the owner/office role gate, verifies the storage '
  'path against the caller''s own org id before any write, and filters both the read and the '
  'update on org_id. Export templates carry no unit meaning, so A5 has no unit predicate to want.'
)) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== 5. A6: two tables grew =====
update private.tenant_export_registry registry
set exported_columns = (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))),
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name)
where registry.table_name in ('document_export_templates', 'document_export_template_versions');

-- ===== 6. A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0123 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 7. Anchors =====
do $$
declare
  v_def text;
begin
  -- (a) The bucket is private and refuses macros. Both halves: a public bucket would put every
  -- tenant's report layout behind a guessable URL, and an .xlsm accepted here is a macro this
  -- system would hand to an accountant every month under its own name.
  if (select public from storage.buckets where id = 'export-templates') is distinct from false then
    raise exception '0123: THE EXPORT TEMPLATE BUCKET IS PUBLIC.';
  end if;
  if exists (
    select 1 from storage.buckets, unnest(allowed_mime_types) as m(mime)
    where id = 'export-templates'
      and (m.mime like '%macroEnabled%' or m.mime like '%sheet.binary%')
  ) then
    raise exception '0123: the export template bucket accepts a macro-enabled workbook.';
  end if;

  -- (b) The two scope dimensions stay mutually exclusive. A row with both would be a template
  -- claiming to render one supplier's invoices AND the monthly report.
  if exists (
    select 1 from public.document_export_templates
    where export_key is not null and (document_type is not null or supplier_id is not null)
  ) then
    raise exception '0123: a template claims a report key and a document scope at once.';
  end if;

  -- (c) The active-scope index knows about export_key. Without it two report templates for the
  -- same key are both active and the resolver picks one by accident.
  if (select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'document_export_templates_active_scope_key')
     not like '%export_key%' then
    raise exception '0123: the active-scope uniqueness does not include export_key.';
  end if;

  -- (d) The command still refuses an approved version. This is the immutability 0047 built and
  -- this migration is the first thing that could have undone it.
  select pg_get_functiondef(to_regprocedure(
    'public.attach_export_template_workbook(uuid,text,text,integer,text,text,jsonb,jsonb,text)'))
    into v_def;
  if v_def is null then
    raise exception '0123: attach_export_template_workbook is missing.';
  end if;
  if position('export_template_version_already_approved' in v_def) = 0 then
    raise exception
      '0123: AN APPROVED TEMPLATE VERSION CAN HAVE ITS WORKBOOK SWAPPED. Every export already '
      'produced from it becomes unexplainable.';
  end if;
  if position('auth_org()' in v_def) = 0 then
    raise exception '0123: the attach command no longer filters by tenant.';
  end if;
end
$$;
