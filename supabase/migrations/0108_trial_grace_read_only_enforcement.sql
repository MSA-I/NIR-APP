-- 0108 -- Trial lifecycle: 30 days, 7 days grace, then tenant-wide read-only.
-- Read access remains tenant-scoped through auth_org(); writes fail at the row boundary even
-- through SECURITY DEFINER/service_role paths. Platform lifecycle recovery remains reasoned.

do $$
declare
  v_body text;
begin
  select p.prosrc into v_body from pg_catalog.pg_proc p
  where p.oid = 'public.auth_org()'::regprocedure;
  if md5(v_body) <> '006e580399a7e4aa486e8e2e02918de6' then
    raise exception '0108 ancestry guard failed: auth_org changed';
  end if;

  select p.prosrc into v_body from pg_catalog.pg_proc p
  where p.oid = 'public.set_organization_lifecycle(uuid,public.org_status,timestamptz,text)'::regprocedure;
  if md5(v_body) <> '58811364a1681913beeddfb1f99b6af3' then
    raise exception '0108 ancestry guard failed: set_organization_lifecycle changed';
  end if;
end
$$;

-- Historical active tenants remain active. A trial that pre-dates enforcement receives the
-- same 30-day contract from its creation time; no null trial can mean "unlimited" afterwards.
update public.organizations
set trial_ends_at = created_at + interval '30 days'
where status = 'trial' and trial_ends_at is null;

alter table public.organizations
  add constraint organizations_trial_end_required
  check (status <> 'trial' or trial_ends_at is not null) not valid;
alter table public.organizations validate constraint organizations_trial_end_required;

create function private.organization_access_mode(p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when o.id is null or o.status = 'suspended' then 'suspended'
    when o.status = 'active' then 'active'
    when o.trial_ends_at is null then 'read_only'
    when statement_timestamp() <= o.trial_ends_at then 'trial'
    when statement_timestamp() <= o.trial_ends_at + interval '7 days' then 'grace'
    else 'read_only'
  end
  from (select p_org_id as requested_id) requested
  left join public.organizations o on o.id = requested.requested_id
$$;

revoke all on function private.organization_access_mode(uuid)
  from public, anon, authenticated;

create function public.organization_write_allowed()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select private.organization_access_mode(public.auth_org()) in ('active', 'trial', 'grace')
$$;

revoke all on function public.organization_write_allowed() from public, anon;
grant execute on function public.organization_write_allowed() to authenticated;

create function public.organization_access_state()
returns table (
  access_mode text,
  trial_ends_at timestamptz,
  grace_ends_at timestamptz,
  grace_days_remaining integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select private.organization_access_mode(o.id),
         o.trial_ends_at,
         case when o.status = 'trial' then o.trial_ends_at + interval '7 days' end,
         case
           when private.organization_access_mode(o.id) <> 'grace' then null
           else greatest(0, ceil(extract(epoch from
             (o.trial_ends_at + interval '7 days' - statement_timestamp())) / 86400.0)::integer)
         end
  from public.organizations o
  where o.id = public.auth_org()
$$;

revoke all on function public.organization_access_state() from public, anon;
grant execute on function public.organization_access_state() to authenticated;

create function private.organizations_default_trial_period()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'trial' and new.trial_ends_at is null then
    new.trial_ends_at := statement_timestamp() + interval '30 days';
  end if;
  return new;
end
$$;

revoke all on function private.organizations_default_trial_period()
  from public, anon, authenticated;
create trigger organizations_default_trial_period
  before insert on public.organizations
  for each row execute function private.organizations_default_trial_period();

create function private.organization_row_write_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new_org uuid;
  v_old_org uuid;
  v_actor uuid := auth.uid();
  v_lifecycle_write boolean := coalesce(
    v_actor is not null
    and public.is_platform_admin()
    and current_setting('app.organization_lifecycle_writer', true) = v_actor::text,
    false
  );
begin
  if tg_op <> 'INSERT' then
    v_old_org := nullif(to_jsonb(old) ->> 'org_id', '')::uuid;
    if v_old_org is null then
      raise exception 'organization_write_guard_missing_org: %', tg_table_name;
    end if;
    if private.organization_access_mode(v_old_org) not in ('active', 'trial', 'grace')
       and not v_lifecycle_write then
      raise exception 'organization_read_only' using errcode = '42501';
    end if;
  end if;

  if tg_op <> 'DELETE' then
    v_new_org := nullif(to_jsonb(new) ->> 'org_id', '')::uuid;
    if v_new_org is null then
      raise exception 'organization_write_guard_missing_org: %', tg_table_name;
    end if;
    if private.organization_access_mode(v_new_org) not in ('active', 'trial', 'grace')
       and not v_lifecycle_write then
      raise exception 'organization_read_only' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

revoke all on function private.organization_row_write_guard()
  from public, anon, authenticated;

-- A5 exemption is intentionally narrow: this trigger can only inspect the NEW/OLD row selected
-- by the caller's statement. It never queries or returns a sibling unit row; SECURITY DEFINER is
-- required so service-role/definer writes cannot bypass the tenant lifecycle latch.
insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'private.organization_row_write_guard()'::regprocedure::text,
  'trigger-new-old-rows -- cannot be invoker: the latch must also govern service_role and SECURITY DEFINER writers that have no browser table privileges. It reads only the firing NEW/OLD org_id and cannot widen the caller-selected row set.',
  'multi-unit enablement wave'
);

-- One row guard covers direct DML, RPCs, definers and service-role Edge Functions. The security
-- event ledger is excluded so a platform operator whose own tenant expired can still step up and
-- recover a target tenant; business rows and audit rows remain guarded.
do $$
declare
  v_table record;
begin
  for v_table in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'org_id'
      and t.table_type = 'BASE TABLE'
      and c.table_name <> 'security_events'
    order by c.table_name
  loop
    execute format(
      'create trigger zz_organization_write_guard before insert or update or delete on public.%I '
      || 'for each row execute function private.organization_row_write_guard()',
      v_table.table_name
    );
  end loop;
end
$$;

create function private.organizations_trial_write_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_lifecycle_write boolean := coalesce(
    v_actor is not null
    and public.is_platform_admin()
    and current_setting('app.organization_lifecycle_writer', true) = v_actor::text,
    false
  );
begin
  if private.organization_access_mode(old.id) not in ('active', 'trial', 'grace')
     and not v_lifecycle_write then
    raise exception 'organization_read_only' using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function private.organizations_trial_write_guard()
  from public, anon, authenticated;
create trigger organizations_trial_write_guard
  before update on public.organizations
  for each row execute function private.organizations_trial_write_guard();

-- The existing cross-tenant command remains the only lifecycle writer. Every transition that
-- enables writes requires fresh authentication; trial starts/extensions also require a future end.
create or replace function public.set_organization_lifecycle(
  p_org_id uuid,
  p_status public.org_status,
  p_trial_ends_at timestamptz,
  p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_org organizations;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_actor is null or not is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if p_org_id is null or p_status is null or v_reason is null then
    raise exception 'lifecycle_invalid' using errcode = '22023';
  end if;
  -- Every cross-tenant lifecycle mutation is sensitive: write-enabling transitions, trial
  -- extensions and suspension all require a freshly reauthenticated platform operator.
  perform public.assert_recent_password_authentication();
  if p_status = 'trial' then
    if p_trial_ends_at is null or p_trial_ends_at <= statement_timestamp() then
      raise exception 'trial_end_must_be_future' using errcode = '22023';
    end if;
  end if;

  select * into v_org from organizations where id = p_org_id for update;
  if not found then raise exception 'organization_unknown' using errcode = 'P0002'; end if;

  perform set_config('app.organization_lifecycle_writer', v_actor::text, true);
  update organizations
  set status = p_status, trial_ends_at = p_trial_ends_at
  where id = v_org.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org.id, v_actor, 'organization_lifecycle_changed', 'organizations', v_org.id,
    jsonb_build_object('status', v_org.status, 'trial_ends_at', v_org.trial_ends_at),
    jsonb_build_object('status', p_status, 'trial_ends_at', p_trial_ends_at),
    v_reason
  );
end
$$;

revoke all on function public.set_organization_lifecycle(uuid, public.org_status, timestamptz, text)
  from public;
grant execute on function public.set_organization_lifecycle(uuid, public.org_status, timestamptz, text)
  to authenticated;

-- Storage SELECT policies stay untouched. Every browser write policy is re-declared with the
-- same contract plus the canonical tenant write latch.
drop policy if exists docs_storage_insert on storage.objects;
create policy docs_storage_insert on storage.objects for insert to authenticated with check (
  public.organization_write_allowed()
  and bucket_id = 'documents'
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

drop policy if exists docs_storage_delete on storage.objects;
create policy docs_storage_delete on storage.objects for delete to authenticated using (
  public.organization_write_allowed()
  and bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth_org()::text
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and auth_role() in ('owner', 'office', 'kitchen', 'payer', 'accountant')
  and not public.p0_document_path_registered(name)
);

drop policy if exists supplier_price_documents_storage_insert on storage.objects;
create policy supplier_price_documents_storage_insert
on storage.objects for insert to authenticated
with check (
  public.organization_write_allowed()
  and bucket_id = 'documents'
  and auth_role() = 'supplier'
  and auth_supplier() is not null
  and array_length(storage.foldername(name), 1) = 4
  and (storage.foldername(name))[1] = auth_org()::text
  and (storage.foldername(name))[2] = 'supplier'
  and (storage.foldername(name))[3] = auth_supplier()::text
  and (storage.foldername(name))[4]
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and public.smart_document_mime_allowed(metadata ->> 'mimetype')
  and public.supplier_price_upload_reservation_active(
    name, metadata ->> 'mimetype', auth.uid()
  )
);

drop policy if exists supplier_price_documents_storage_delete on storage.objects;
create policy supplier_price_documents_storage_delete
on storage.objects for delete to authenticated
using (
  public.organization_write_allowed()
  and bucket_id = 'documents'
  and auth_role() = 'supplier'
  and auth_supplier() is not null
  and array_length(storage.foldername(name), 1) = 4
  and (storage.foldername(name))[1] = auth_org()::text
  and (storage.foldername(name))[2] = 'supplier'
  and (storage.foldername(name))[3] = auth_supplier()::text
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and not public.p0_document_path_registered(name)
  and public.supplier_price_upload_authorized(
    auth_org(), auth_supplier(), auth.uid()
  )
);

drop policy if exists price_submissions_storage_insert on storage.objects;
create policy price_submissions_storage_insert
on storage.objects for insert to authenticated
with check (
  public.organization_write_allowed()
  and bucket_id = 'price-submissions'
  and array_length(storage.foldername(name), 1) = 4
  and (storage.foldername(name))[1] = auth_org()::text
  and (storage.foldername(name))[2] = 'price-submissions'
  and (storage.foldername(name))[4]
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and lower(coalesce(metadata ->> 'mimetype', '')) in (
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  and (
    (
      auth_role() in ('owner', 'office')
      and exists (
        select 1 from public.suppliers supplier
        where supplier.org_id = auth_org()
          and supplier.id::text = (storage.foldername(storage.objects.name))[3]
          and supplier.deleted_at is null
      )
    )
    or (
      auth_role() = 'supplier'
      and auth_supplier() is not null
      and (storage.foldername(name))[3] = auth_supplier()::text
    )
  )
);

drop policy if exists price_submissions_storage_delete on storage.objects;
create policy price_submissions_storage_delete
on storage.objects for delete to authenticated
using (
  public.organization_write_allowed()
  and bucket_id = 'price-submissions'
  and array_length(storage.foldername(name), 1) = 4
  and (storage.foldername(name))[1] = auth_org()::text
  and (storage.foldername(name))[2] = 'price-submissions'
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and (
    auth_role() in ('owner', 'office')
    or (
      auth_role() = 'supplier'
      and auth_supplier() is not null
      and (storage.foldername(name))[3] = auth_supplier()::text
    )
  )
  and not public.p1b_price_intake_is_active(name)
  and not exists (
    select 1 from public.supplier_price_submissions submission
    where submission.org_id = auth_org()
      and submission.storage_path = storage.objects.name
  )
);

comment on function public.organization_access_state() is
  'Canonical tenant access state: 30-day trial, 7-day full grace, then read-only.';
comment on function public.organization_write_allowed() is
  'RLS/storage latch; true only for active, in-trial or grace-period tenants.';

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0108 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
