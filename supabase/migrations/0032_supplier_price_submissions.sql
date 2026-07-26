-- P1B: immutable monthly supplier price submissions. A file is uploaded to a private,
-- tenant-scoped staging path first; this RPC then validates the complete payload and commits
-- price rows, history, the receipt ledger and audit in one database transaction.

-- ===== Submission receipt ledger =====

-- 0025 created the production ledger under the roadmap contract. Migration 0030
-- aligns it in place before this migration installs the trusted P1B behavior.
do $$
begin
  if to_regclass('public.supplier_price_submissions') is null
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'supplier_price_submissions'
         and column_name = 'target_month'
     )
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'supplier_price_submissions'
         and column_name = 'file_checksum'
     ) then
    raise exception '0032 refused: 0030 supplier submission alignment is missing.';
  end if;
end
$$;

create index supplier_price_submissions_supplier_month_idx
  on public.supplier_price_submissions (org_id, supplier_id, target_month desc, revision desc);

create or replace function public.p1b_price_submission_immutable()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'supplier_price_submission_immutable' using errcode = '42501';
end
$$;

drop trigger if exists supplier_price_submissions_immutable
  on public.supplier_price_submissions;
create trigger supplier_price_submissions_immutable
  before update or delete on public.supplier_price_submissions
  for each row execute function public.p1b_price_submission_immutable();

drop function if exists public.reject_supplier_price_submission_mutation();

alter table public.supplier_price_submissions enable row level security;

drop policy if exists supplier_price_submissions_select
  on public.supplier_price_submissions;
create policy supplier_price_submissions_select
on public.supplier_price_submissions
for select to authenticated
using (
  org_id = auth_org()
  and (
    auth_role() in ('owner', 'office')
    or (auth_role() = 'supplier' and supplier_id = auth_supplier())
  )
);

revoke all on table public.supplier_price_submissions from public, anon, authenticated;
grant select on table public.supplier_price_submissions to authenticated;

-- Collapse the older supplier-specific policies into one explicit read contract. Direct table
-- writes were already revoked and guarded by 0023; removing the stale write policies keeps the
-- catalog command boundary visible in both grants and RLS.
drop policy if exists sp_supplier_select on public.supplier_products;
drop policy if exists sp_supplier_insert on public.supplier_products;
drop policy if exists sp_supplier_update on public.supplier_products;
drop policy if exists supplier_products_select on public.supplier_products;
create policy supplier_products_select on public.supplier_products for select to authenticated using (
  org_id = auth_org()
  and (
    auth_role() in ('owner', 'office', 'kitchen')
    or (auth_role() = 'supplier' and supplier_id = auth_supplier())
  )
);

drop policy if exists ph_supplier_select on public.price_history;
drop policy if exists ph_supplier_insert on public.price_history;
drop policy if exists price_history_select on public.price_history;
create policy price_history_select on public.price_history for select to authenticated using (
  org_id = auth_org()
  and (
    auth_role() in ('owner', 'office', 'kitchen')
    or (
      auth_role() = 'supplier'
      and exists (
        select 1
        from public.supplier_products sp
        where sp.org_id = price_history.org_id
          and sp.id = price_history.supplier_product_id
          and sp.supplier_id = auth_supplier()
      )
    )
  )
);

-- ===== Dedicated private Storage bucket =====

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'price-submissions',
  'price-submissions',
  false,
  10485760,
  array[
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists price_submissions_storage_insert on storage.objects;
create policy price_submissions_storage_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'price-submissions'
  and array_length(storage.foldername(name), 1) = 4
  and (storage.foldername(name))[1] = auth_org()::text
  and (storage.foldername(name))[2] = 'price-submissions'
  and (storage.foldername(name))[4] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
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
        select 1 from public.suppliers s
        where s.org_id = auth_org()
          and s.id::text = (storage.foldername(name))[3]
          and s.deleted_at is null
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
  and exists (
    select 1
    from public.supplier_price_submissions submission
    where submission.org_id = auth_org()
      and submission.storage_path = storage.objects.name
      and (
        auth_role() in ('owner', 'office')
        or (auth_role() = 'supplier' and submission.supplier_id = auth_supplier())
      )
  )
);

drop policy if exists price_submissions_storage_delete on storage.objects;
create policy price_submissions_storage_delete
on storage.objects for delete to authenticated
using (
  bucket_id = 'price-submissions'
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
  and not exists (
    select 1
    from public.supplier_price_submissions submission
    where submission.org_id = auth_org()
      and submission.storage_path = storage.objects.name
  )
);

-- There is deliberately no UPDATE policy: a stored submission cannot be overwritten.

-- ===== Close the legacy supplier bypass while preserving manager imports =====

-- Production migration 0025 replaced the tested 0023 importer with a manager-only
-- implementation. Restore the original atomic importer as a private helper, then remove
-- the legacy public entry point so every supplier write flows through a submission.
create or replace function public.p1_import_supplier_prices_internal(
  p_rows jsonb,
  p_effective_date date,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_supplier uuid := auth_supplier();
  v_reason text := nullif(trim(p_reason), '');
  v_count int;
  v_distinct_count int;
  v_row record;
  v_existing supplier_products;
  v_created int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
begin
  if v_org is null or v_user is null
     or v_role not in ('owner', 'office', 'supplier') then
    raise exception 'price_import_not_authorized' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or p_effective_date is null or v_reason is null then
    raise exception 'price_import_invalid' using errcode = '22023';
  end if;

  select count(*), count(distinct (supplier_id, product_id))
    into v_count, v_distinct_count
  from jsonb_to_recordset(p_rows) as row(
    supplier_id uuid,
    product_id uuid,
    price numeric,
    available boolean
  );

  if v_count = 0 or v_count > 5000 or v_count <> v_distinct_count
     or exists (
       select 1
       from jsonb_to_recordset(p_rows) as row(
         supplier_id uuid,
         product_id uuid,
         price numeric,
         available boolean
       )
       where supplier_id is null or product_id is null or price is null
          or round(price, 2) <= 0 or round(price, 2) > 1000000
     ) then
    raise exception 'price_import_invalid' using errcode = '22023';
  end if;

  -- Supplier rows serialize creation of a new supplier/product pair. Products and existing
  -- price rows are then locked in UUID order to keep batch and finalize lock order stable.
  perform 1
  from suppliers s
  join (
    select distinct supplier_id
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
  ) input on input.supplier_id = s.id
  where s.org_id = v_org and s.deleted_at is null
  order by s.id
  for update of s;

  perform 1
  from products p
  join (
    select distinct product_id
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
  ) input on input.product_id = p.id
  where p.org_id = v_org and p.active
  order by p.id
  for update of p;

  perform 1
  from supplier_products sp
  join (
    select supplier_id, product_id
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
  ) input on input.supplier_id = sp.supplier_id and input.product_id = sp.product_id
  where sp.org_id = v_org
  order by sp.id
  for update of sp;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
    left join suppliers s
      on s.id = row.supplier_id and s.org_id = v_org and s.deleted_at is null
    left join products p
      on p.id = row.product_id and p.org_id = v_org and p.active
    where s.id is null or p.id is null
       or (v_role = 'supplier' and (v_supplier is null or row.supplier_id <> v_supplier))
  ) then
    raise exception 'price_import_target_invalid' using errcode = '22023';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  for v_row in
    select supplier_id, product_id, round(price, 2) as price, coalesce(available, true) as available
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
    order by supplier_id, product_id
  loop
    v_existing := null;
    select * into v_existing
    from supplier_products sp
    where sp.org_id = v_org
      and sp.supplier_id = v_row.supplier_id
      and sp.product_id = v_row.product_id
    for update;

    if not found then
      insert into supplier_products (
        org_id, supplier_id, product_id, current_price,
        price_effective_date, available
      ) values (
        v_org, v_row.supplier_id, v_row.product_id, v_row.price,
        p_effective_date, v_row.available
      ) returning * into v_existing;

      insert into price_history (
        org_id, supplier_product_id, price, effective_date, created_by
      ) values (
        v_org, v_existing.id, v_row.price, p_effective_date, v_user
      );
      v_created := v_created + 1;
    elsif round(v_existing.current_price, 2) <> v_row.price
       or v_existing.price_effective_date <> p_effective_date
       or v_existing.available <> v_row.available then
      update supplier_products
      set current_price = v_row.price,
          previous_price = case
            when round(v_existing.current_price, 2) <> v_row.price then v_existing.current_price
            else v_existing.previous_price
          end,
          price_effective_date = p_effective_date,
          available = v_row.available
      where id = v_existing.id;

      if round(v_existing.current_price, 2) <> v_row.price
         or v_existing.price_effective_date <> p_effective_date then
        insert into price_history (
          org_id, supplier_product_id, price, effective_date, created_by
        ) values (
          v_org, v_existing.id, v_row.price, p_effective_date, v_user
        );
      end if;
      v_updated := v_updated + 1;
    else
      v_unchanged := v_unchanged + 1;
    end if;
  end loop;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'supplier_prices_imported', 'supplier_products', null, null,
    jsonb_build_object(
      'row_count', v_count,
      'created', v_created,
      'updated', v_updated,
      'unchanged', v_unchanged,
      'effective_date', p_effective_date
    ),
    v_reason
  );

  return jsonb_build_object(
    'row_count', v_count,
    'created', v_created,
    'updated', v_updated,
    'unchanged', v_unchanged
  );
end
$$;

drop function public.import_supplier_prices(jsonb, date, text);

revoke all on function public.p1_import_supplier_prices_internal(jsonb, date, text)
  from public, anon, authenticated;

create function public.import_supplier_prices(
  p_rows jsonb,
  p_effective_date date,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth_org() is null or auth.uid() is null or auth_role() not in ('owner', 'office') then
    raise exception 'price_import_not_authorized' using errcode = '42501';
  end if;

  return public.p1_import_supplier_prices_internal(p_rows, p_effective_date, p_reason);
end
$$;

revoke all on function public.import_supplier_prices(jsonb, date, text) from public, anon;
grant execute on function public.import_supplier_prices(jsonb, date, text) to authenticated;

-- ===== Monthly supplier submission command =====

create function public.submit_supplier_price_list(
  p_submission_id uuid,
  p_supplier_id uuid,
  p_target_month date,
  p_file_name text,
  p_storage_path text,
  p_file_checksum text,
  p_rows jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_auth_supplier uuid := auth_supplier();
  v_reason text := nullif(trim(p_reason), '');
  v_checksum text := lower(trim(coalesce(p_file_checksum, '')));
  v_submission public.supplier_price_submissions%rowtype;
  v_item jsonb;
  v_ordinal bigint;
  v_source_row integer;
  v_product_id uuid;
  v_product_name text;
  v_price_text text;
  v_price numeric;
  v_available boolean;
  v_seen_products uuid[] := array[]::uuid[];
  v_valid_rows jsonb := '[]'::jsonb;
  v_rejections jsonb := '[]'::jsonb;
  v_import_result jsonb := '{}'::jsonb;
  v_created integer := 0;
  v_updated integer := 0;
  v_accepted integer := 0;
  v_unchanged integer := 0;
  v_rejected integer := 0;
  v_revision integer;
  v_status text;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'supplier') then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;
  if v_role = 'supplier' and (v_auth_supplier is null or v_auth_supplier <> p_supplier_id) then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;
  if p_submission_id is null or p_supplier_id is null or p_target_month is null
     or p_target_month <> date_trunc('month', p_target_month)::date
     or v_reason is null
     or p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 5000
     or length(trim(coalesce(p_file_name, ''))) not between 1 and 255
     or p_file_name ~ '[\\/]'
     or v_checksum !~ '^[0-9a-f]{64}$'
     or p_storage_path is null
     or array_length(string_to_array(p_storage_path, '/'), 1) <> 5
     or split_part(p_storage_path, '/', 1) <> v_org::text
     or split_part(p_storage_path, '/', 2) <> 'price-submissions'
     or split_part(p_storage_path, '/', 3) <> p_supplier_id::text
     or split_part(p_storage_path, '/', 4) <> p_submission_id::text
     or split_part(p_storage_path, '/', 5) = ''
     or split_part(p_storage_path, '/', 6) <> '' then
    raise exception 'price_submission_invalid' using errcode = '22023';
  end if;

  -- One supplier row serializes revisions and checksum retries for every month.
  perform 1
  from public.suppliers s
  where s.org_id = v_org and s.id = p_supplier_id and s.deleted_at is null
  for update;
  if not found then
    raise exception 'price_submission_supplier_invalid' using errcode = 'P0002';
  end if;

  -- A retry with the same caller-generated id is safe only when its immutable identity agrees.
  select * into v_submission
  from public.supplier_price_submissions submission
  where submission.id = p_submission_id;
  if found then
    if v_submission.org_id <> v_org
       or v_submission.supplier_id <> p_supplier_id
       or v_submission.target_month <> p_target_month
       or v_submission.file_checksum <> v_checksum then
      raise exception 'price_submission_idempotency_conflict' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'submission_id', v_submission.id,
      'revision', v_submission.revision,
      'status', v_submission.status,
      'accepted_count', v_submission.accepted_count,
      'rejected_count', v_submission.rejected_count,
      'unchanged_count', v_submission.unchanged_count,
      'rejections', v_submission.rejections,
      'storage_path', v_submission.storage_path,
      'idempotent', true
    );
  end if;

  -- Same month + same file bytes returns the original receipt instead of a new revision.
  select * into v_submission
  from public.supplier_price_submissions submission
  where submission.org_id = v_org
    and submission.supplier_id = p_supplier_id
    and submission.target_month = p_target_month
    and submission.file_checksum = v_checksum;
  if found then
    return jsonb_build_object(
      'submission_id', v_submission.id,
      'revision', v_submission.revision,
      'status', v_submission.status,
      'accepted_count', v_submission.accepted_count,
      'rejected_count', v_submission.rejected_count,
      'unchanged_count', v_submission.unchanged_count,
      'rejections', v_submission.rejections,
      'storage_path', v_submission.storage_path,
      'idempotent', true
    );
  end if;

  -- The database will not register a caller-provided path that is missing, owned by someone
  -- else, or has a type outside the dedicated bucket contract.
  perform 1
  from storage.objects o
  where o.bucket_id = 'price-submissions'
    and o.name = p_storage_path
    and (o.owner = v_user or o.owner_id = v_user::text)
    and lower(coalesce(o.metadata ->> 'mimetype', '')) in (
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  if not found then
    raise exception 'price_submission_file_missing' using errcode = 'P0002';
  end if;

  -- Every source row receives an independent verdict. Product ids are resolved against the
  -- active tenant catalog; names alone never create a catalog product.
  for v_item, v_ordinal in
    select input.value, input.ordinality
    from jsonb_array_elements(p_rows) with ordinality as input(value, ordinality)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_ordinal + 1,
        'reason', 'invalid_row',
        'message', 'השורה אינה במבנה נתונים תקין'
      ));
      continue;
    end if;

    if coalesce(v_item ->> 'source_row', '') ~ '^[0-9]{1,6}$'
       and (v_item ->> 'source_row')::integer >= 2 then
      v_source_row := (v_item ->> 'source_row')::integer;
    else
      v_source_row := (v_ordinal + 1)::integer;
    end if;
    v_product_name := left(trim(coalesce(v_item ->> 'product_name', '')), 200);

    v_product_id := null;
    select p.id into v_product_id
    from public.products p
    where p.org_id = v_org
      and p.active
      and p.id::text = trim(coalesce(v_item ->> 'product_id', ''));
    if v_product_id is null then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_source_row,
        'product', nullif(v_product_name, ''),
        'reason', 'unknown_product',
        'message', 'המוצר אינו קיים בקטלוג הפעיל; לא נוצר מוצר חדש'
      ));
      continue;
    end if;

    v_price_text := regexp_replace(
      trim(coalesce(v_item ->> 'price_text', '')),
      '[[:space:]₪,]', '', 'g'
    );
    if length(v_price_text) > 16 or v_price_text !~ '^[0-9]+([.][0-9]{1,4})?$' then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_source_row,
        'product', nullif(v_product_name, ''),
        'reason', 'invalid_price',
        'message', 'נדרש מחיר חיובי ותקין'
      ));
      continue;
    end if;
    v_price := round(v_price_text::numeric, 2);
    if v_price <= 0 or v_price > 1000000 then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_source_row,
        'product', nullif(v_product_name, ''),
        'reason', 'invalid_price',
        'message', 'המחיר חייב להיות גדול מאפס ועד 1,000,000'
      ));
      continue;
    end if;

    if v_product_id = any(v_seen_products) then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_source_row,
        'product', nullif(v_product_name, ''),
        'reason', 'duplicate_product',
        'message', 'המוצר מופיע יותר מפעם אחת בקובץ; רק השורה הראשונה נקלטה'
      ));
      continue;
    end if;

    v_available := case
      when jsonb_typeof(v_item -> 'available') = 'boolean'
        then (v_item ->> 'available')::boolean
      else true
    end;
    v_seen_products := array_append(v_seen_products, v_product_id);
    v_valid_rows := v_valid_rows || jsonb_build_array(jsonb_build_object(
      'supplier_id', p_supplier_id,
      'product_id', v_product_id,
      'price', v_price,
      'available', v_available
    ));
  end loop;

  v_rejected := jsonb_array_length(v_rejections);
  if jsonb_array_length(v_valid_rows) > 0 then
    v_import_result := public.p1_import_supplier_prices_internal(
      v_valid_rows, p_target_month, v_reason
    );
    v_created := coalesce((v_import_result ->> 'created')::integer, 0);
    v_updated := coalesce((v_import_result ->> 'updated')::integer, 0);
    v_unchanged := coalesce((v_import_result ->> 'unchanged')::integer, 0);
    v_accepted := v_created + v_updated;
  end if;

  v_status := case
    when jsonb_array_length(v_valid_rows) = 0 then 'rejected'
    when v_rejected > 0 then 'accepted_with_rejections'
    else 'accepted'
  end;

  select coalesce(max(submission.revision), 0) + 1 into v_revision
  from public.supplier_price_submissions submission
  where submission.org_id = v_org
    and submission.supplier_id = p_supplier_id
    and submission.target_month = p_target_month;

  insert into public.supplier_price_submissions (
    id, org_id, supplier_id, target_month, revision,
    file_name, storage_path, file_checksum, status,
    accepted_count, rejected_count, unchanged_count,
    row_count, created_count, updated_count, rejections,
    submitted_by
  ) values (
    p_submission_id, v_org, p_supplier_id, p_target_month, v_revision,
    trim(p_file_name), p_storage_path, v_checksum, v_status,
    v_accepted, v_rejected, v_unchanged,
    v_created + v_updated + v_unchanged + v_rejected,
    v_created, v_updated, v_rejections,
    v_user
  ) returning * into v_submission;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id,
    old_values, new_values, reason
  ) values (
    v_org, v_user, 'supplier_price_submission_processed',
    'supplier_price_submissions', p_submission_id,
    null,
    jsonb_build_object(
      'supplier_id', p_supplier_id,
      'target_month', p_target_month,
      'revision', v_revision,
      'file_checksum', v_checksum,
      'status', v_status,
      'accepted_count', v_accepted,
      'rejected_count', v_rejected,
      'unchanged_count', v_unchanged
    ),
    v_reason
  );

  return jsonb_build_object(
    'submission_id', v_submission.id,
    'revision', v_submission.revision,
    'status', v_submission.status,
    'accepted_count', v_submission.accepted_count,
    'rejected_count', v_submission.rejected_count,
    'unchanged_count', v_submission.unchanged_count,
    'rejections', v_submission.rejections,
    'storage_path', v_submission.storage_path,
    'idempotent', false
  );
end
$$;

revoke all on function public.submit_supplier_price_list(
  uuid, uuid, date, text, text, text, jsonb, text
) from public, anon;
grant execute on function public.submit_supplier_price_list(
  uuid, uuid, date, text, text, text, jsonb, text
) to authenticated;
