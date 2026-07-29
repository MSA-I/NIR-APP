-- 0047 — Tenant-safe reusable document export templates and immutable export history.
-- Templates are declarative data only. No template value is ever evaluated as code, SQL,
-- a formula or an expression.

-- ===== TemplateContract v1 validation =====

create or replace function public.document_export_source_path_allowed(p_path text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_path is not null
    and length(p_path) between 1 and 128
    and (
      p_path in (
        'schema_version',
        'document_type',
        'document_type_confidence',
        'supplier.suggested_id',
        'supplier.suggested_name',
        'supplier.confidence',
        'line_items.source_row'
      )
      or (
        p_path ~ '^fields\.[A-Za-z_][A-Za-z0-9_]{0,99}$'
        and substring(p_path from length('fields.') + 1)
          not in ('__proto__', 'prototype', 'constructor')
      )
      or (
        p_path ~ '^line_items\.values\.[A-Za-z_][A-Za-z0-9_]{0,99}$'
        and substring(p_path from length('line_items.values.') + 1)
          not in ('__proto__', 'prototype', 'constructor')
      )
    )
$$;

create or replace function public.document_export_template_contract_valid(p_contract jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_scope jsonb;
  v_column jsonb;
  v_column_key text;
  v_keys text[] := '{}';
  v_document_type text;
  v_supplier_id uuid;
  v_user_id uuid;
begin
  if p_contract is null
     or jsonb_typeof(p_contract) is distinct from 'object'
     or not (p_contract ?& array['schema_version', 'name', 'format', 'scope', 'columns'])
     or (p_contract - array['schema_version', 'name', 'format', 'scope', 'columns']) <> '{}'::jsonb
     or jsonb_typeof(p_contract -> 'schema_version') <> 'string'
     or p_contract ->> 'schema_version' <> '1'
     or jsonb_typeof(p_contract -> 'name') <> 'string'
     or length(trim(p_contract ->> 'name')) not between 1 and 120
     or jsonb_typeof(p_contract -> 'format') <> 'string'
     or p_contract ->> 'format' not in ('xlsx', 'csv', 'json', 'table', 'text')
     or jsonb_typeof(p_contract -> 'scope') <> 'object'
     or jsonb_typeof(p_contract -> 'columns') <> 'array'
     or jsonb_array_length(p_contract -> 'columns') not between 1 and 100 then
    return false;
  end if;

  v_scope := p_contract -> 'scope';
  if not (v_scope ?& array['document_type', 'supplier_id', 'user_id'])
     or (v_scope - array['document_type', 'supplier_id', 'user_id']) <> '{}'::jsonb
     or jsonb_typeof(v_scope -> 'document_type') not in ('string', 'null')
     or jsonb_typeof(v_scope -> 'supplier_id') not in ('string', 'null')
     or jsonb_typeof(v_scope -> 'user_id') not in ('string', 'null') then
    return false;
  end if;

  if jsonb_typeof(v_scope -> 'document_type') = 'string' then
    v_document_type := v_scope ->> 'document_type';
    if v_document_type not in (
      'invoice', 'delivery_note', 'credit_note', 'price_list', 'quote',
      'payment_confirmation', 'other'
    ) then
      return false;
    end if;
  end if;
  if jsonb_typeof(v_scope -> 'supplier_id') = 'string' then
    if (v_scope ->> 'supplier_id') !~* (
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      return false;
    end if;
    v_supplier_id := (v_scope ->> 'supplier_id')::uuid;
  end if;
  if jsonb_typeof(v_scope -> 'user_id') = 'string' then
    if (v_scope ->> 'user_id') !~* (
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      return false;
    end if;
    v_user_id := (v_scope ->> 'user_id')::uuid;
  end if;

  if not (
    (v_user_id is not null and v_supplier_id is not null and v_document_type is null)
    or (v_user_id is null and v_supplier_id is not null and v_document_type is null)
    or (v_user_id is not null and v_supplier_id is null and v_document_type is not null)
    or (v_user_id is null and v_supplier_id is null and v_document_type is not null)
    or (v_user_id is null and v_supplier_id is null and v_document_type is null)
  ) then
    return false;
  end if;

  for v_column in select value from jsonb_array_elements(p_contract -> 'columns')
  loop
    if jsonb_typeof(v_column) <> 'object'
       or not (v_column ?& array['key', 'label', 'source_path', 'type', 'required'])
       or (v_column - array['key', 'label', 'source_path', 'type', 'required']) <> '{}'::jsonb
       or jsonb_typeof(v_column -> 'key') <> 'string'
       or jsonb_typeof(v_column -> 'label') <> 'string'
       or jsonb_typeof(v_column -> 'source_path') <> 'string'
       or jsonb_typeof(v_column -> 'type') <> 'string'
       or jsonb_typeof(v_column -> 'required') <> 'boolean' then
      return false;
    end if;

    v_column_key := v_column ->> 'key';
    if v_column_key !~ '^[A-Za-z_][A-Za-z0-9_]{0,99}$'
       or v_column_key in ('__proto__', 'prototype', 'constructor')
       or v_column_key = any(v_keys)
       or length(trim(v_column ->> 'label')) not between 1 and 200
       or not public.document_export_source_path_allowed(v_column ->> 'source_path')
       or v_column ->> 'type' not in ('text', 'number', 'date', 'boolean') then
      return false;
    end if;
    v_keys := array_append(v_keys, v_column_key);
  end loop;

  return true;
exception when others then
  return false;
end
$$;

create or replace function public.document_export_value_matches_type(
  p_value jsonb,
  p_type text
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text;
  v_date date;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return false;
  end if;
  if p_type = 'text' then
    return jsonb_typeof(p_value) in ('string', 'number', 'boolean');
  elsif p_type = 'number' then
    return jsonb_typeof(p_value) = 'number';
  elsif p_type = 'boolean' then
    return jsonb_typeof(p_value) = 'boolean';
  elsif p_type = 'date' then
    if jsonb_typeof(p_value) <> 'string' then
      return false;
    end if;
    v_text := p_value #>> '{}';
    if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      return false;
    end if;
    v_date := v_text::date;
    return to_char(v_date, 'YYYY-MM-DD') = v_text;
  end if;
  return false;
exception when others then
  return false;
end
$$;

create or replace function public.document_export_contract_matches_interpretation(
  p_contract jsonb,
  p_payload jsonb
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_column jsonb;
  v_item jsonb;
  v_path text;
  v_key text;
  v_type text;
  v_required boolean;
  v_value jsonb;
  v_present boolean;
begin
  if not public.document_export_template_contract_valid(p_contract)
     or p_payload is null
     or jsonb_typeof(p_payload) is distinct from 'object' then
    return false;
  end if;

  for v_column in select value from jsonb_array_elements(p_contract -> 'columns')
  loop
    v_path := v_column ->> 'source_path';
    v_type := v_column ->> 'type';
    v_required := (v_column ->> 'required')::boolean;

    if v_path like 'fields.%' then
      v_key := substring(v_path from length('fields.') + 1);
      select field -> 'value'
        into v_value
      from jsonb_array_elements(p_payload -> 'fields') with ordinality as fields(field, position)
      where field ->> 'key' = v_key
      order by position
      limit 1;
      v_present := found and v_value is not null and jsonb_typeof(v_value) <> 'null';
      if (v_required and not v_present)
         or (v_present and not public.document_export_value_matches_type(v_value, v_type)) then
        return false;
      end if;
    elsif v_path = 'line_items.source_row' or v_path like 'line_items.values.%' then
      if jsonb_array_length(p_payload -> 'line_items') = 0 then
        if v_required then return false; end if;
        continue;
      end if;
      if v_path like 'line_items.values.%' then
        v_key := substring(v_path from length('line_items.values.') + 1);
      end if;
      for v_item in select value from jsonb_array_elements(p_payload -> 'line_items')
      loop
        if v_path = 'line_items.source_row' then
          v_value := v_item -> 'source_row';
        else
          v_value := v_item -> 'values' -> v_key;
        end if;
        v_present := v_value is not null and jsonb_typeof(v_value) <> 'null';
        if (v_required and not v_present)
           or (v_present and not public.document_export_value_matches_type(v_value, v_type)) then
          return false;
        end if;
      end loop;
    else
      v_value := p_payload #> string_to_array(v_path, '.');
      v_present := v_value is not null and jsonb_typeof(v_value) <> 'null';
      if (v_required and not v_present)
         or (v_present and not public.document_export_value_matches_type(v_value, v_type)) then
        return false;
      end if;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end
$$;

revoke all on function public.document_export_source_path_allowed(text)
  from public, anon, authenticated, service_role;
revoke all on function public.document_export_template_contract_valid(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.document_export_value_matches_type(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.document_export_contract_matches_interpretation(jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- ===== Three tenant-scoped tables =====

create table public.document_export_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  owner_user_id uuid,
  document_type text check (
    document_type is null or document_type in (
      'invoice', 'delivery_note', 'credit_note', 'price_list', 'quote',
      'payment_confirmation', 'other'
    )
  ),
  supplier_id uuid,
  active_version_id uuid,
  active boolean not null default true,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_by uuid,
  disable_reason text,
  constraint document_export_templates_org_id_id_key unique (org_id, id),
  constraint document_export_templates_owner_tenant_fk
    foreign key (org_id, owner_user_id)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_export_templates_supplier_tenant_fk
    foreign key (org_id, supplier_id)
    references public.suppliers(org_id, id) on delete restrict,
  constraint document_export_templates_creator_tenant_fk
    foreign key (org_id, created_by)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_export_templates_disabler_tenant_fk
    foreign key (org_id, disabled_by)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_export_templates_scope_check check (
    (owner_user_id is not null and supplier_id is not null and document_type is null)
    or (owner_user_id is null and supplier_id is not null and document_type is null)
    or (owner_user_id is not null and supplier_id is null and document_type is not null)
    or (owner_user_id is null and supplier_id is null and document_type is not null)
    or (owner_user_id is null and supplier_id is null and document_type is null)
  ),
  constraint document_export_templates_active_shape check (
    (active and disabled_at is null and disabled_by is null and disable_reason is null)
    or (
      not active and disabled_at is not null and disabled_by is not null
      and nullif(trim(disable_reason), '') is not null
    )
  )
);

create unique index document_export_templates_active_scope_key
  on public.document_export_templates (
    org_id, owner_user_id, document_type, supplier_id
  ) nulls not distinct
  where active;

create table public.document_export_template_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  template_id uuid not null,
  version integer not null check (version > 0),
  schema_version text not null default '1' check (schema_version = '1'),
  format text not null check (format in ('xlsx', 'csv', 'json', 'table', 'text')),
  contract jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz,
  constraint document_export_template_versions_org_id_id_key unique (org_id, id),
  constraint document_export_template_versions_context_key
    unique (org_id, id, template_id),
  constraint document_export_template_versions_format_key
    unique (org_id, id, template_id, format),
  constraint document_export_template_versions_number_key
    unique (org_id, template_id, version),
  constraint document_export_template_versions_template_tenant_fk
    foreign key (org_id, template_id)
    references public.document_export_templates(org_id, id) on delete restrict,
  constraint document_export_template_versions_creator_tenant_fk
    foreign key (org_id, created_by)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_export_template_versions_approver_tenant_fk
    foreign key (org_id, approved_by)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_export_template_versions_contract_check check (
    public.document_export_template_contract_valid(contract)
    and contract ->> 'schema_version' = schema_version
    and contract ->> 'format' = format
  ),
  constraint document_export_template_versions_approval_shape check (
    (approved_by is null and approved_at is null)
    or (approved_by is not null and approved_at is not null)
  )
);

alter table public.document_export_templates
  add constraint document_export_templates_active_version_fk
  foreign key (org_id, active_version_id, id)
  references public.document_export_template_versions(org_id, id, template_id)
  on delete restrict;

create table public.document_exports (
  id uuid primary key,
  org_id uuid not null references public.organizations(id) on delete restrict,
  document_id uuid not null,
  extraction_id uuid not null,
  interpretation_id uuid not null,
  template_id uuid not null,
  template_version_id uuid not null,
  format text not null check (format in ('xlsx', 'csv', 'json', 'table', 'text')),
  content_checksum text not null check (content_checksum ~ '^sha256:[0-9a-f]{64}$'),
  storage_path text,
  result_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result_metadata) = 'object'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint document_exports_org_id_id_key unique (org_id, id),
  constraint document_exports_interpretation_context_fk
    foreign key (org_id, interpretation_id, extraction_id, document_id)
    references public.document_interpretations(org_id, id, extraction_id, document_id)
    on delete restrict,
  constraint document_exports_template_version_tenant_fk
    foreign key (org_id, template_version_id, template_id, format)
    references public.document_export_template_versions(org_id, id, template_id, format)
    on delete restrict,
  constraint document_exports_creator_tenant_fk
    foreign key (org_id, created_by)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_exports_delivery_check check (
    (storage_path is not null or result_metadata <> '{}'::jsonb)
    and (format <> 'table' or storage_path is null)
  ),
  constraint document_exports_storage_path_check check (
    storage_path is null
    or (
      storage_path like org_id::text || '/exports/' || id::text || '/%'
      and storage_path not like '%//%'
      and storage_path !~ '(^|/)\.\.?(/|$)'
    )
  )
);

create index document_export_template_versions_template_idx
  on public.document_export_template_versions (org_id, template_id, version desc);
create index document_exports_document_idx
  on public.document_exports (org_id, document_id, created_at desc);
create index document_exports_interpretation_idx
  on public.document_exports (org_id, interpretation_id, created_at desc);

-- ===== Immutability guards =====

create or replace function public.guard_document_export_template()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'document_export_template_immutable' using errcode = '42501';
  end if;

  if new.org_id is distinct from old.org_id
     or new.owner_user_id is distinct from old.owner_user_id
     or new.document_type is distinct from old.document_type
     or new.supplier_id is distinct from old.supplier_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'document_export_template_immutable' using errcode = '42501';
  end if;

  if new.active_version_id is distinct from old.active_version_id then
    if not old.active or not new.active
       or new.disabled_at is distinct from old.disabled_at
       or new.disabled_by is distinct from old.disabled_by
       or new.disable_reason is distinct from old.disable_reason
       or new.active_version_id is null
       or not exists (
         select 1
         from public.document_export_template_versions v
         where v.org_id = new.org_id
           and v.id = new.active_version_id
           and v.template_id = new.id
           and v.approved_by is not null
           and v.approved_at is not null
       ) then
      raise exception 'document_export_template_active_version_invalid' using errcode = '23514';
    end if;
    return new;
  end if;

  if old.active and not new.active
     and new.disabled_at is not null
     and new.disabled_by is not null
     and nullif(trim(new.disable_reason), '') is not null then
    return new;
  end if;

  raise exception 'document_export_template_immutable' using errcode = '42501';
end
$$;

create or replace function public.guard_document_export_template_version()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'document_export_template_version_immutable' using errcode = '42501';
  end if;
  if old.approved_by is null
     and old.approved_at is null
     and new.approved_by is not null
     and new.approved_at is not null
     and (to_jsonb(new) - array['approved_by', 'approved_at'])
          is not distinct from
         (to_jsonb(old) - array['approved_by', 'approved_at']) then
    return new;
  end if;
  raise exception 'document_export_template_version_immutable' using errcode = '42501';
end
$$;

create or replace function public.reject_document_export_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'document_export_immutable' using errcode = '42501';
end
$$;

create trigger document_export_templates_guard_trg
  before update or delete on public.document_export_templates
  for each row execute function public.guard_document_export_template();
create trigger document_export_template_versions_guard_trg
  before update or delete on public.document_export_template_versions
  for each row execute function public.guard_document_export_template_version();
create trigger document_exports_immutable_trg
  before update or delete on public.document_exports
  for each row execute function public.reject_document_export_mutation();

revoke all on function public.guard_document_export_template()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_document_export_template_version()
  from public, anon, authenticated, service_role;
revoke all on function public.reject_document_export_mutation()
  from public, anon, authenticated, service_role;

-- ===== RLS and least-privilege grants =====

alter table public.document_export_templates enable row level security;
alter table public.document_export_templates force row level security;
alter table public.document_export_template_versions enable row level security;
alter table public.document_export_template_versions force row level security;
alter table public.document_exports enable row level security;
alter table public.document_exports force row level security;

create policy document_export_templates_select on public.document_export_templates
  for select to authenticated using (
    org_id = auth_org()
    and auth_role() in ('owner', 'office', 'kitchen')
    and (owner_user_id is null or owner_user_id = auth.uid())
  );
create policy document_export_template_versions_select
  on public.document_export_template_versions
  for select to authenticated using (
    org_id = auth_org()
    and auth_role() in ('owner', 'office', 'kitchen')
    and exists (
      select 1
      from public.document_export_templates t
      where t.org_id = document_export_template_versions.org_id
        and t.id = document_export_template_versions.template_id
        and (t.owner_user_id is null or t.owner_user_id = auth.uid())
    )
  );
create policy document_exports_select on public.document_exports
  for select to authenticated using (
    org_id = auth_org()
    and auth_role() in ('owner', 'office', 'kitchen')
    and exists (
      select 1
      from public.document_export_templates t
      where t.org_id = document_exports.org_id
        and t.id = document_exports.template_id
        and (t.owner_user_id is null or t.owner_user_id = auth.uid())
    )
  );

revoke all on table public.document_export_templates
  from public, anon, authenticated, service_role;
revoke all on table public.document_export_template_versions
  from public, anon, authenticated, service_role;
revoke all on table public.document_exports
  from public, anon, authenticated, service_role;

grant select on table
  public.document_export_templates,
  public.document_export_template_versions,
  public.document_exports
to authenticated;

grant select, insert, update, delete on table
  public.document_export_templates,
  public.document_export_template_versions,
  public.document_exports
to service_role;

-- ===== Exact template precedence =====

create or replace function public.resolve_document_export_template_version(
  p_org_id uuid,
  p_actor_id uuid,
  p_document_type text,
  p_supplier_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.active_version_id
  from public.document_export_templates t
  join public.document_export_template_versions v
    on v.org_id = t.org_id
   and v.template_id = t.id
   and v.id = t.active_version_id
   and v.approved_by is not null
   and v.approved_at is not null
  where t.org_id = p_org_id
    and t.active
    and (t.owner_user_id is null or t.owner_user_id = p_actor_id)
    and (
      (t.owner_user_id = p_actor_id and t.supplier_id = p_supplier_id
        and t.document_type is null)
      or (t.owner_user_id is null and t.supplier_id = p_supplier_id
        and t.document_type is null)
      or (t.owner_user_id = p_actor_id and t.supplier_id is null
        and t.document_type = p_document_type)
      or (t.owner_user_id is null and t.supplier_id is null
        and t.document_type = p_document_type)
      or (t.owner_user_id is null and t.supplier_id is null
        and t.document_type is null)
    )
  order by case
    when t.owner_user_id = p_actor_id and t.supplier_id = p_supplier_id then 1
    when t.owner_user_id is null and t.supplier_id = p_supplier_id then 2
    when t.owner_user_id = p_actor_id and t.document_type = p_document_type then 3
    when t.owner_user_id is null and t.document_type = p_document_type then 4
    else 5
  end
  limit 1
$$;

revoke all on function public.resolve_document_export_template_version(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;

-- ===== Reasoned authenticated commands =====

create or replace function public.propose_document_export_template(
  p_template_id uuid,
  p_contract jsonb,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role public.user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_owner_user_id uuid;
  v_document_type text;
  v_supplier_id uuid;
  v_template public.document_export_templates;
  v_latest public.document_export_template_versions;
  v_version_id uuid;
  v_version integer;
begin
  if v_org is null or v_actor is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if not public.document_export_template_contract_valid(p_contract) then
    raise exception 'document_export_template_invalid' using errcode = '22023';
  end if;

  v_owner_user_id := nullif(p_contract #>> '{scope,user_id}', '')::uuid;
  v_document_type := nullif(p_contract #>> '{scope,document_type}', '');
  v_supplier_id := nullif(p_contract #>> '{scope,supplier_id}', '')::uuid;

  if v_owner_user_id is not null and v_owner_user_id <> v_actor then
    raise exception 'document_export_personal_template_not_owned' using errcode = '42501';
  end if;
  if v_supplier_id is not null and not exists (
    select 1
    from public.suppliers s
    where s.org_id = v_org and s.id = v_supplier_id and s.deleted_at is null
  ) then
    raise exception 'document_export_supplier_unknown' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    v_org, v_owner_user_id, v_document_type, v_supplier_id
  )::text, 0));

  if p_template_id is not null then
    select * into v_template
    from public.document_export_templates t
    where t.org_id = v_org and t.id = p_template_id
    for update;
    if not found then
      raise exception 'document_export_template_unknown' using errcode = 'P0002';
    end if;
    if not v_template.active then
      raise exception 'document_export_template_disabled' using errcode = '55000';
    end if;
    if v_template.owner_user_id is distinct from v_owner_user_id
       or v_template.document_type is distinct from v_document_type
       or v_template.supplier_id is distinct from v_supplier_id then
      raise exception 'document_export_template_scope_immutable' using errcode = '22023';
    end if;
  else
    select * into v_template
    from public.document_export_templates t
    where t.org_id = v_org
      and t.active
      and t.owner_user_id is not distinct from v_owner_user_id
      and t.document_type is not distinct from v_document_type
      and t.supplier_id is not distinct from v_supplier_id
    for update;

    if not found then
      insert into public.document_export_templates (
        org_id, owner_user_id, document_type, supplier_id, created_by
      ) values (
        v_org, v_owner_user_id, v_document_type, v_supplier_id, v_actor
      ) returning * into v_template;
    end if;
  end if;

  select * into v_latest
  from public.document_export_template_versions v
  where v.org_id = v_org and v.template_id = v_template.id
  order by v.version desc
  limit 1;

  if found and v_latest.contract = p_contract then
    return v_latest.id;
  end if;

  v_version := coalesce(v_latest.version, 0) + 1;
  insert into public.document_export_template_versions (
    org_id, template_id, version, schema_version, format, contract, created_by
  ) values (
    v_org, v_template.id, v_version, p_contract ->> 'schema_version',
    p_contract ->> 'format', p_contract, v_actor
  ) returning id into v_version_id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'document_export_template_proposed',
    'document_export_template_versions', v_version_id,
    case when v_latest.id is null then null else jsonb_build_object(
      'version_id', v_latest.id, 'version', v_latest.version
    ) end,
    jsonb_build_object(
      'template_id', v_template.id,
      'version', v_version,
      'name', p_contract ->> 'name',
      'format', p_contract ->> 'format',
      'scope', p_contract -> 'scope'
    ),
    v_reason
  );
  return v_version_id;
end
$$;

create or replace function public.approve_document_export_template_version(
  p_version_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role public.user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_version public.document_export_template_versions;
  v_template public.document_export_templates;
begin
  if v_org is null or v_actor is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_version
  from public.document_export_template_versions v
  where v.org_id = v_org and v.id = p_version_id
  for update;
  if not found then
    raise exception 'document_export_template_version_unknown' using errcode = 'P0002';
  end if;

  select * into v_template
  from public.document_export_templates t
  where t.org_id = v_org and t.id = v_version.template_id
  for update;

  if v_template.owner_user_id is null and v_role not in ('owner', 'office') then
    raise exception 'document_export_org_template_not_authorized' using errcode = '42501';
  elsif v_template.owner_user_id is not null and v_template.owner_user_id <> v_actor then
    raise exception 'document_export_personal_template_not_owned' using errcode = '42501';
  end if;
  if v_version.approved_at is not null then
    return v_version.id;
  end if;
  if not v_template.active then
    raise exception 'document_export_template_disabled' using errcode = '55000';
  end if;

  update public.document_export_template_versions
  set approved_by = v_actor, approved_at = now()
  where id = v_version.id;

  update public.document_export_templates
  set active_version_id = v_version.id
  where id = v_template.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'document_export_template_approved',
    'document_export_template_versions', v_version.id,
    jsonb_build_object('approved', false, 'active_version_id', v_template.active_version_id),
    jsonb_build_object(
      'approved', true, 'template_id', v_template.id,
      'version', v_version.version, 'active_version_id', v_version.id
    ),
    v_reason
  );
  return v_version.id;
end
$$;

create or replace function public.disable_document_export_template(
  p_template_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role public.user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_template public.document_export_templates;
begin
  if v_org is null or v_actor is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_template
  from public.document_export_templates t
  where t.org_id = v_org and t.id = p_template_id
  for update;
  if not found then
    raise exception 'document_export_template_unknown' using errcode = 'P0002';
  end if;
  if v_template.owner_user_id is null and v_role not in ('owner', 'office') then
    raise exception 'document_export_org_template_not_authorized' using errcode = '42501';
  elsif v_template.owner_user_id is not null and v_template.owner_user_id <> v_actor then
    raise exception 'document_export_personal_template_not_owned' using errcode = '42501';
  end if;
  if not v_template.active then
    return v_template.id;
  end if;

  update public.document_export_templates
  set active = false,
      disabled_at = now(),
      disabled_by = v_actor,
      disable_reason = v_reason
  where id = v_template.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'document_export_template_disabled', 'document_export_templates',
    v_template.id,
    jsonb_build_object('active', true, 'active_version_id', v_template.active_version_id),
    jsonb_build_object('active', false, 'active_version_id', v_template.active_version_id),
    v_reason
  );
  return v_template.id;
end
$$;

create or replace function public.record_document_export(
  p_export_id uuid,
  p_document_id uuid,
  p_extraction_id uuid,
  p_interpretation_id uuid,
  p_template_version_id uuid,
  p_content_checksum text,
  p_storage_path text,
  p_result_metadata jsonb,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role public.user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_checksum text := trim(coalesce(p_content_checksum, ''));
  v_storage_path text := nullif(trim(p_storage_path), '');
  v_metadata jsonb := coalesce(p_result_metadata, '{}'::jsonb);
  v_existing public.document_exports;
  v_interpretation public.document_interpretations;
  v_version public.document_export_template_versions;
  v_template public.document_export_templates;
  v_expected_version_id uuid;
  v_expected_mime text;
begin
  if v_org is null or v_actor is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_export_id is null
     or v_checksum !~ '^sha256:[0-9a-f]{64}$'
     or jsonb_typeof(v_metadata) <> 'object' then
    raise exception 'document_export_invalid' using errcode = '22023';
  end if;

  select * into v_existing
  from public.document_exports e
  where e.org_id = v_org and e.id = p_export_id
  for update;
  if found then
    if v_existing.document_id = p_document_id
       and v_existing.extraction_id = p_extraction_id
       and v_existing.interpretation_id = p_interpretation_id
       and v_existing.template_version_id = p_template_version_id
       and v_existing.content_checksum = v_checksum
       and v_existing.storage_path is not distinct from v_storage_path
       and v_existing.result_metadata = v_metadata
       and v_existing.created_by = v_actor then
      return v_existing.id;
    end if;
    raise exception 'document_export_conflict' using errcode = '23505';
  end if;

  select * into v_interpretation
  from public.document_interpretations i
  where i.org_id = v_org
    and i.id = p_interpretation_id
    and i.extraction_id = p_extraction_id
    and i.document_id = p_document_id;
  if not found then
    raise exception 'document_export_interpretation_unknown' using errcode = 'P0002';
  end if;

  select * into v_version
  from public.document_export_template_versions v
  where v.org_id = v_org and v.id = p_template_version_id
  for share;
  if not found then
    raise exception 'document_export_template_version_unknown' using errcode = 'P0002';
  end if;
  select * into v_template
  from public.document_export_templates t
  where t.org_id = v_org and t.id = v_version.template_id
  for share;

  if not v_template.active
     or v_template.active_version_id is distinct from v_version.id
     or v_version.approved_by is null
     or v_version.approved_at is null then
    raise exception 'document_export_template_not_approved' using errcode = '55000';
  end if;

  v_expected_version_id := public.resolve_document_export_template_version(
    v_org,
    v_actor,
    v_interpretation.payload ->> 'document_type',
    v_interpretation.suggested_supplier_id
  );
  if v_expected_version_id is null then
    raise exception 'document_export_template_unavailable' using errcode = 'P0002';
  elsif v_expected_version_id <> v_version.id then
    raise exception 'document_export_template_not_selected' using errcode = '55000';
  end if;

  if not public.document_export_contract_matches_interpretation(
    v_version.contract, v_interpretation.payload
  ) then
    raise exception 'document_export_input_invalid' using errcode = '22023';
  end if;

  if v_storage_path is null and v_metadata = '{}'::jsonb then
    raise exception 'document_export_delivery_required' using errcode = '22023';
  elsif v_version.format = 'table' and v_storage_path is not null then
    raise exception 'document_export_table_must_be_inline' using errcode = '22023';
  elsif v_storage_path is not null then
    if v_storage_path !~ (
      '^' || v_org::text || '/exports/' || p_export_id::text || '/[^/]+$'
    ) then
      raise exception 'document_export_storage_path_invalid' using errcode = '22023';
    end if;

    v_expected_mime := case v_version.format
      when 'xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      when 'csv' then 'text/csv'
      when 'json' then 'application/json'
      when 'text' then 'text/plain'
      else null
    end;
    if v_expected_mime is null or not exists (
      select 1
      from storage.objects o
      where o.bucket_id = 'documents'
        and o.name = v_storage_path
        and (o.owner = v_actor or o.owner_id = v_actor::text)
        and lower(coalesce(o.metadata ->> 'mimetype', '')) = v_expected_mime
    ) then
      raise exception 'document_export_storage_object_invalid' using errcode = '22023';
    end if;
  end if;

  begin
    insert into public.document_exports (
      id, org_id, document_id, extraction_id, interpretation_id,
      template_id, template_version_id, format, content_checksum,
      storage_path, result_metadata, created_by
    ) values (
      p_export_id, v_org, p_document_id, p_extraction_id, p_interpretation_id,
      v_template.id, v_version.id, v_version.format, v_checksum,
      v_storage_path, v_metadata, v_actor
    );
  exception when unique_violation then
    select * into v_existing
    from public.document_exports e
    where e.org_id = v_org and e.id = p_export_id;
    if found
       and v_existing.document_id = p_document_id
       and v_existing.extraction_id = p_extraction_id
       and v_existing.interpretation_id = p_interpretation_id
       and v_existing.template_version_id = p_template_version_id
       and v_existing.content_checksum = v_checksum
       and v_existing.storage_path is not distinct from v_storage_path
       and v_existing.result_metadata = v_metadata
       and v_existing.created_by = v_actor then
      return v_existing.id;
    end if;
    raise exception 'document_export_conflict' using errcode = '23505';
  end;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_actor, 'document_export_recorded', 'document_exports', p_export_id,
    jsonb_build_object(
      'document_id', p_document_id,
      'interpretation_id', p_interpretation_id,
      'template_version_id', v_version.id,
      'format', v_version.format,
      'content_checksum', v_checksum,
      'storage_backed', v_storage_path is not null
    ),
    v_reason
  );
  return p_export_id;
end
$$;

revoke all on function public.propose_document_export_template(uuid, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.propose_document_export_template(uuid, jsonb, text)
  to authenticated;
revoke all on function public.approve_document_export_template_version(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.approve_document_export_template_version(uuid, text)
  to authenticated;
revoke all on function public.disable_document_export_template(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.disable_document_export_template(uuid, text)
  to authenticated;
revoke all on function public.record_document_export(
  uuid, uuid, uuid, uuid, uuid, text, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_document_export(
  uuid, uuid, uuid, uuid, uuid, text, text, jsonb, text
) to authenticated;

-- ===== Private Storage integration =====

create or replace function public.p0_document_path_registered(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.documents d where d.storage_path = p_path
  ) or exists (
    select 1 from public.document_exports e where e.storage_path = p_path
  )
$$;

revoke all on function public.p0_document_path_registered(text) from public, anon;
grant execute on function public.p0_document_path_registered(text) to authenticated;

update storage.buckets
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array[
      'application/pdf',
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/avif',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/json',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/rtf', 'text/rtf',
      'text/plain', 'text/html',
      'application/vnd.oasis.opendocument.text'
    ]::text[]
where id = 'documents';

drop policy if exists docs_storage_read on storage.objects;
create policy docs_storage_read on storage.objects for select to authenticated using (
  bucket_id = 'documents'
  and (
    exists (
      select 1
      from public.documents d
      where d.storage_path = storage.objects.name and d.org_id = auth_org()
        and (
          auth_role() in ('owner', 'office', 'kitchen')
          or (auth_role() = 'accountant' and (
            (d.entity_type = 'invoice' and exists (
              select 1 from public.invoices i
              where i.org_id = d.org_id and i.id = d.entity_id and i.review_status = 'approved'
            ))
            or (d.entity_type = 'goods_receipt' and exists (
              select 1
              from public.invoice_receipt_links irl
              join public.invoices i on i.org_id = irl.org_id and i.id = irl.invoice_id
              where irl.org_id = d.org_id and irl.receipt_id = d.entity_id
                and i.review_status = 'approved'
            ))
            or (d.entity_type = 'payment' and exists (
              select 1 from public.payments p
              where p.org_id = d.org_id and p.id = d.entity_id
            ))
          ))
          or (auth_role() = 'payer' and d.uploaded_by = auth.uid())
        )
    )
    or exists (
      select 1
      from public.document_exports e
      where e.storage_path = storage.objects.name
        and e.org_id = auth_org()
        and auth_role() in ('owner', 'office', 'kitchen')
        and exists (
          select 1
          from public.document_export_templates t
          where t.org_id = e.org_id
            and t.id = e.template_id
            and (t.owner_user_id is null or t.owner_user_id = auth.uid())
        )
    )
  )
);

drop policy if exists docs_storage_insert on storage.objects;
create policy docs_storage_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth_org()::text
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and (
    (
      public.smart_document_mime_allowed(metadata ->> 'mimetype')
      and auth_role() in ('owner', 'office', 'kitchen', 'payer', 'accountant')
    )
    or (
      lower(coalesce(metadata ->> 'mimetype', '')) = 'application/json'
      and auth_role() in ('owner', 'office', 'kitchen')
      and name ~ (
        '^' || auth_org()::text
        || '/exports/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-'
        || '[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/[^/]+$'
      )
    )
  )
);

comment on table public.document_export_templates is
  'Tenant-scoped logical export scopes. Personal scopes remain visible only to their owner.';
comment on table public.document_export_template_versions is
  'Immutable declarative TemplateContract versions; only one-time approval metadata may be added.';
comment on table public.document_exports is
  'Immutable deterministic export ledger pinned to source interpretation and exact template version.';
