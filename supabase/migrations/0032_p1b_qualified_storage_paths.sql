-- P1B Storage path qualification. Inside the suppliers subquery, an unqualified `name`
-- resolves to suppliers.name instead of the outer storage.objects.name. Recreate both policies
-- with an explicit outer reference while preserving every role, tenant and ledger boundary.

drop policy if exists price_submissions_storage_insert on storage.objects;
create policy price_submissions_storage_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'price-submissions'
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
        select 1
        from public.suppliers supplier
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

drop policy if exists price_submissions_storage_select on storage.objects;
create policy price_submissions_storage_select
on storage.objects for select to authenticated
using (
  bucket_id = 'price-submissions'
  and (
    exists (
      select 1
      from public.supplier_price_submissions submission
      where submission.org_id = auth_org()
        and submission.storage_path = storage.objects.name
        and (
          auth_role() in ('owner', 'office')
          or (auth_role() = 'supplier' and submission.supplier_id = auth_supplier())
        )
    )
    or (
      array_length(storage.foldername(name), 1) = 4
      and (storage.foldername(name))[1] = auth_org()::text
      and (storage.foldername(name))[2] = 'price-submissions'
      and (storage.foldername(name))[4]
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and (owner = auth.uid() or owner_id = auth.uid()::text)
      and (
        (
          auth_role() in ('owner', 'office')
          and exists (
            select 1
            from public.suppliers supplier
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
      and not exists (
        select 1
        from public.supplier_price_submissions submission
        where submission.org_id = auth_org()
          and submission.storage_path = storage.objects.name
      )
    )
  )
);

comment on policy price_submissions_storage_insert on storage.objects is
  'Tenant-scoped uploader insert with an explicitly qualified supplier path lookup.';
comment on policy price_submissions_storage_select on storage.objects is
  'Registered price files follow ledger roles; unregistered staging is visible only to its tenant-scoped uploader.';

-- Deliberately no UPDATE policy: neither registered files nor uploader staging can be replaced.
