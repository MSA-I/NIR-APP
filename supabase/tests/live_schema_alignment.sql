-- Contract check for the roadmap/remediation migration bridge.
\set ON_ERROR_STOP on

begin;

create function pg_temp.alignment_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'Schema alignment assertion failed: %', p_message;
  end if;
end
$$;

select pg_temp.alignment_assert(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'supplier_price_submissions'
      and column_name in ('effective_month', 'correction_number', 'payload_hash')
  ),
  'legacy submission columns remain'
);

select pg_temp.alignment_assert(
  19 = (
    select count(*)
    from (values
      ('id'), ('org_id'), ('supplier_id'), ('target_month'), ('revision'),
      ('file_name'), ('storage_path'), ('file_checksum'), ('status'),
      ('accepted_count'), ('rejected_count'), ('unchanged_count'), ('rejections'),
      ('submitted_by'), ('submitted_at'), ('processed_at'),
      ('row_count'), ('created_count'), ('updated_count')
    ) expected(column_name)
    where exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'supplier_price_submissions'
        and c.column_name = expected.column_name
    )
  ),
  'canonical or rich-count columns are missing'
);

select pg_temp.alignment_assert(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.supplier_price_submissions'::regclass
      and tgname = 'supplier_price_submissions_immutable'
      and not tgisinternal
      and tgenabled = 'O'
  ),
  'immutable trigger is not enabled'
);

select pg_temp.alignment_assert(
  2 = (
    select count(*) from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname in (
        'supplier_price_submissions_path_check',
        'supplier_price_submissions_checksum_check'
      )
      and not convalidated
  ),
  'legacy path/checksum constraints were validated'
);

select pg_temp.alignment_assert(
  to_regprocedure('public.import_supplier_prices(jsonb,date,text,uuid)') is null
  and to_regprocedure('public.submit_supplier_price_list(uuid)') is not null
  and to_regprocedure(
    'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)'
  ) is not null,
  'supplier submission command boundary is wrong'
);

insert into public.organizations (id, name, status)
values ('98000000-0000-0000-0000-000000000001', 'Alignment tenant', 'active');

insert into public.suppliers (id, org_id, name)
values (
  '98000000-0000-0000-0000-000000000002',
  '98000000-0000-0000-0000-000000000001',
  'Alignment supplier'
);

insert into public.supplier_price_submissions (
  id, org_id, supplier_id, target_month, revision,
  file_name, storage_path, file_checksum, status,
  accepted_count, rejected_count, unchanged_count, rejections,
  row_count, created_count, updated_count
) values (
  '98000000-0000-0000-0000-000000000003',
  '98000000-0000-0000-0000-000000000001',
  '98000000-0000-0000-0000-000000000002',
  date_trunc('month', current_date)::date,
  1,
  'alignment.csv',
  '98000000-0000-0000-0000-000000000001/price-submissions/98000000-0000-0000-0000-000000000002/98000000-0000-0000-0000-000000000003/alignment.csv',
  repeat('a', 64),
  'accepted',
  1, 0, 0, '[]'::jsonb,
  1, 1, 0
);

do $$
begin
  update public.supplier_price_submissions
  set accepted_count = 0
  where id = '98000000-0000-0000-0000-000000000003';
  raise exception 'expected immutable ledger rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%supplier_price_submission_immutable%' then
    raise;
  end if;
end
$$;

do $$
begin
  insert into public.supplier_price_submissions (
    id, org_id, supplier_id, target_month, revision,
    file_name, storage_path, file_checksum, status,
    accepted_count, rejected_count, unchanged_count, rejections,
    row_count, created_count, updated_count
  ) values (
    '98000000-0000-0000-0000-000000000004',
    '98000000-0000-0000-0000-000000000001',
    '98000000-0000-0000-0000-000000000002',
    date_trunc('month', current_date)::date,
    2,
    'bad-checksum.csv',
    '98000000-0000-0000-0000-000000000001/price-submissions/98000000-0000-0000-0000-000000000002/98000000-0000-0000-0000-000000000004/bad-checksum.csv',
    'not-a-checksum',
    'accepted',
    1, 0, 0, '[]'::jsonb,
    1, 1, 0
  );
  raise exception 'expected checksum constraint rejection';
exception when check_violation then
  null;
end
$$;

select 'live_schema_alignment: all assertions passed' as result;
rollback;
