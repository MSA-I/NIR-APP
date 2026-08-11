-- Make browser Storage INSERT policies match the row Storage actually inserts.
--
-- Storage creates storage.objects with owner/owner_id and metadata.mimetype still NULL, then fills
-- those service-owned fields later. Policies that require either value during INSERT are therefore
-- impossible for a real browser upload even though service_role fixtures pass. Tenant paths,
-- product roles, lifecycle latches, bucket limits and intake/ledger guards remain authoritative.

-- ===== documents =====

drop policy if exists docs_storage_insert on storage.objects;
create policy docs_storage_insert
on storage.objects for insert to authenticated
with check (
  public.organization_write_allowed()
  and bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth_org()::text
  and auth_role() in ('owner', 'office', 'accountant')
);

drop policy if exists docs_storage_delete on storage.objects;
create policy docs_storage_delete
on storage.objects for delete to authenticated
using (
  public.organization_write_allowed()
  and bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth_org()::text
  and auth_role() in ('owner', 'office', 'accountant')
  and not public.p0_document_path_registered(name)
);

-- Supplier agents are no longer product accounts. Removing all three additive policies closes the
-- upload, read and orphan-delete surface while leaving historical document rows intact.
drop policy if exists supplier_price_documents_storage_insert on storage.objects;
drop policy if exists supplier_price_documents_storage_select on storage.objects;
drop policy if exists supplier_price_documents_storage_delete on storage.objects;

-- ===== price-submissions =====

drop policy if exists price_submissions_storage_insert on storage.objects;
create policy price_submissions_storage_insert
on storage.objects for insert to authenticated
with check (
  public.organization_write_allowed()
  and bucket_id = 'price-submissions'
  and auth_role() in ('owner', 'office')
  and array_length(storage.foldername(name), 1) = 4
  and (storage.foldername(name))[1] = auth_org()::text
  and (storage.foldername(name))[2] = 'price-submissions'
  and (storage.foldername(name))[4]
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (
    select 1
    from public.suppliers supplier
    where supplier.org_id = auth_org()
      and supplier.id::text = (storage.foldername(storage.objects.name))[3]
      and supplier.deleted_at is null
  )
);

drop policy if exists price_submissions_storage_select on storage.objects;
create policy price_submissions_storage_select
on storage.objects for select to authenticated
using (
  bucket_id = 'price-submissions'
  and auth_role() in ('owner', 'office')
  and (
    exists (
      select 1
      from public.supplier_price_submissions submission
      where submission.org_id = auth_org()
        and submission.storage_path = storage.objects.name
    )
    or (
      array_length(storage.foldername(name), 1) = 4
      and (storage.foldername(name))[1] = auth_org()::text
      and (storage.foldername(name))[2] = 'price-submissions'
      and (storage.foldername(name))[4]
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and exists (
        select 1
        from public.suppliers supplier
        where supplier.org_id = auth_org()
          and supplier.id::text = (storage.foldername(storage.objects.name))[3]
          and supplier.deleted_at is null
      )
      and not exists (
        select 1
        from public.supplier_price_submissions submission
        where submission.org_id = auth_org()
          and submission.storage_path = storage.objects.name
      )
    )
  )
);

drop policy if exists price_submissions_storage_delete on storage.objects;
create policy price_submissions_storage_delete
on storage.objects for delete to authenticated
using (
  public.organization_write_allowed()
  and bucket_id = 'price-submissions'
  and auth_role() in ('owner', 'office')
  and array_length(storage.foldername(name), 1) = 4
  and (storage.foldername(name))[1] = auth_org()::text
  and (storage.foldername(name))[2] = 'price-submissions'
  and exists (
    select 1
    from public.suppliers supplier
    where supplier.org_id = auth_org()
      and supplier.id::text = (storage.foldername(storage.objects.name))[3]
      and supplier.deleted_at is null
  )
  and not public.p1b_price_intake_is_active(name)
  and not exists (
    select 1
    from public.supplier_price_submissions submission
    where submission.org_id = auth_org()
      and submission.storage_path = storage.objects.name
  )
);

-- ===== export-templates =====

drop policy if exists export_templates_storage_insert on storage.objects;
create policy export_templates_storage_insert
on storage.objects for insert to authenticated
with check (
  public.organization_write_allowed()
  and bucket_id = 'export-templates'
  and array_length(storage.foldername(name), 1) = 1
  and (storage.foldername(name))[1] = auth_org()::text
  and auth_role() in ('owner', 'office')
);

drop policy if exists export_templates_storage_select on storage.objects;
create policy export_templates_storage_select
on storage.objects for select to authenticated
using (
  bucket_id = 'export-templates'
  and (storage.foldername(name))[1] = auth_org()::text
  and auth_role() in ('owner', 'office', 'accountant')
);

-- ===== A1/A3/A5 re-assertion =====

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0128 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== Policy-text anchors =====

do $$
declare
  v_docs text;
  v_price_insert text;
  v_export_insert text;
begin
  select coalesce(with_check, '') into v_docs
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'docs_storage_insert';

  select coalesce(with_check, '') into v_price_insert
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'price_submissions_storage_insert';

  select coalesce(with_check, '') into v_export_insert
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'export_templates_storage_insert';

  if v_docs = '' or v_docs ~* '\m(owner_id|metadata)\M|\mowner\M\s*=' then
    raise exception '0128: documents browser insert still depends on service-populated fields';
  end if;
  if v_price_insert = '' or v_price_insert ~* '\m(owner_id|metadata)\M|\mowner\M\s*=' then
    raise exception '0128: price-submissions insert still depends on service-populated fields';
  end if;
  if v_export_insert = '' or v_export_insert ~* '\m(owner_id|metadata)\M|\mowner\M\s*=' then
    raise exception '0128: export-template insert still depends on service-populated fields';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in (
        'supplier_price_documents_storage_insert',
        'supplier_price_documents_storage_select',
        'supplier_price_documents_storage_delete'
      )
  ) then
    raise exception '0128: supplier document Storage policy remains';
  end if;
end
$$;
