-- Reconcile the production supplier-price ledger created by 0025 with the canonical
-- P1B contract installed by 0032. Production already records 0025-0029 under the
-- roadmap lineage, so this migration deliberately runs before the renumbered
-- remediation lineage. Every data-bearing step is introspection-driven and rerunnable.

do $$
begin
  if to_regclass('public.supplier_price_submissions') is null then
    raise exception '0030 refused: public.supplier_price_submissions does not exist.';
  end if;
end
$$;

-- The roadmap supplier RPC is a second browser write path and its body references the
-- legacy column names. The trusted intake introduced by 0035 is the sole supplier path.
drop function if exists public.import_supplier_prices(jsonb, date, text, uuid);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'supplier_price_submissions'
      and column_name = 'effective_month'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'supplier_price_submissions'
      and column_name = 'target_month'
  ) then
    raise exception '0030 refused: both effective_month and target_month exist.';
  elsif exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'supplier_price_submissions'
      and column_name = 'effective_month'
  ) then
    alter table public.supplier_price_submissions
      rename column effective_month to target_month;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'supplier_price_submissions'
      and column_name = 'correction_number'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'supplier_price_submissions'
      and column_name = 'revision'
  ) then
    raise exception '0030 refused: both correction_number and revision exist.';
  elsif exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'supplier_price_submissions'
      and column_name = 'correction_number'
  ) then
    alter table public.supplier_price_submissions
      rename column correction_number to revision;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'supplier_price_submissions'
      and column_name = 'payload_hash'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'supplier_price_submissions'
      and column_name = 'file_checksum'
  ) then
    raise exception '0030 refused: both payload_hash and file_checksum exist.';
  elsif exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'supplier_price_submissions'
      and column_name = 'payload_hash'
  ) then
    alter table public.supplier_price_submissions
      rename column payload_hash to file_checksum;
  end if;
end
$$;

alter table public.supplier_price_submissions
  add column if not exists revision integer,
  add column if not exists file_name text,
  add column if not exists storage_path text,
  add column if not exists file_checksum text,
  add column if not exists status text,
  add column if not exists accepted_count integer,
  add column if not exists rejected_count integer,
  add column if not exists unchanged_count integer,
  add column if not exists rejections jsonb default '[]'::jsonb,
  add column if not exists submitted_by uuid,
  add column if not exists submitted_at timestamptz default now(),
  add column if not exists processed_at timestamptz,
  add column if not exists row_count integer,
  add column if not exists created_count integer,
  add column if not exists updated_count integer;

do $$
declare
  v_guarded boolean;
begin
  select exists (
    select 1 from pg_trigger
    where tgrelid = 'public.supplier_price_submissions'::regclass
      and tgname = 'supplier_price_submissions_immutable'
      and not tgisinternal
  ) into v_guarded;

  if v_guarded then
    alter table public.supplier_price_submissions
      disable trigger supplier_price_submissions_immutable;
  end if;

  update public.supplier_price_submissions
  set accepted_count = coalesce(
        accepted_count,
        coalesce(created_count, 0) + coalesce(updated_count, 0)
      ),
      rejected_count = coalesce(rejected_count, 0),
      unchanged_count = coalesce(unchanged_count, 0),
      rejections = coalesce(rejections, '[]'::jsonb),
      row_count = coalesce(
        row_count,
        coalesce(created_count, 0) + coalesce(updated_count, 0)
          + coalesce(unchanged_count, 0) + coalesce(rejected_count, 0)
      ),
      processed_at = coalesce(processed_at, submitted_at)
  where accepted_count is null
     or rejected_count is null
     or unchanged_count is null
     or rejections is null
     or row_count is null
     or processed_at is null;

  update public.supplier_price_submissions
  set status = case
    when coalesce(row_count, 0) <= coalesce(rejected_count, 0) then 'rejected'
    when coalesce(rejected_count, 0) > 0 then 'accepted_with_rejections'
    else 'accepted'
  end
  where status is null;

  with numbered as (
    select id, row_number() over (
      partition by org_id, supplier_id, target_month
      order by submitted_at, id
    ) as rev
    from public.supplier_price_submissions
    where revision is null
  )
  update public.supplier_price_submissions submission
  set revision = numbered.rev
  from numbered
  where numbered.id = submission.id;

  if v_guarded then
    alter table public.supplier_price_submissions
      enable trigger supplier_price_submissions_immutable;
  end if;
end
$$;

-- Normalize legacy constraint names without adding duplicate indexes.
do $$
declare
  v_existing text;
  v_definition text;
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_actor_fk'
  ) and not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_submitter_fk'
  ) then
    alter table public.supplier_price_submissions
      rename constraint supplier_price_submissions_actor_fk
      to supplier_price_submissions_submitter_fk;
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_month_check'
  ) and not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_month_start_check'
  ) then
    alter table public.supplier_price_submissions
      rename constraint supplier_price_submissions_month_check
      to supplier_price_submissions_month_start_check;
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_correction_check'
  ) and not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_revision_check'
  ) then
    alter table public.supplier_price_submissions
      rename constraint supplier_price_submissions_correction_check
      to supplier_price_submissions_revision_check;
  end if;

  select conname into v_existing
  from pg_constraint
  where conrelid = 'public.supplier_price_submissions'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) = 'UNIQUE (org_id, supplier_id, target_month, revision)'
  order by (conname = 'supplier_price_submissions_month_revision_key') desc
  limit 1;
  if v_existing is not null
     and v_existing <> 'supplier_price_submissions_month_revision_key'
     and not exists (
       select 1 from pg_constraint
       where conrelid = 'public.supplier_price_submissions'::regclass
         and conname = 'supplier_price_submissions_month_revision_key'
     ) then
    execute format(
      'alter table public.supplier_price_submissions rename constraint %I to supplier_price_submissions_month_revision_key',
      v_existing
    );
  end if;

  select pg_get_constraintdef(oid) into v_definition
  from pg_constraint
  where conrelid = 'public.supplier_price_submissions'::regclass
    and conname = 'supplier_price_submissions_counts_check';
  if v_definition like '%row_count%' then
    alter table public.supplier_price_submissions
      rename constraint supplier_price_submissions_counts_check
      to supplier_price_submissions_legacy_counts_check;
  end if;
end
$$;

alter table public.supplier_price_submissions
  drop constraint if exists supplier_price_submissions_hash_check,
  drop constraint if exists supplier_price_submissions_legacy_counts_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_supplier_fk'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_supplier_fk
      foreign key (org_id, supplier_id)
      references public.suppliers(org_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_submitter_fk'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_submitter_fk
      foreign key (org_id, submitted_by)
      references public.profiles(org_id, id) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_month_start_check'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_month_start_check
      check (target_month = date_trunc('month', target_month)::date);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_revision_check'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_revision_check
      check (revision > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_file_name_check'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_file_name_check
      check (length(trim(file_name)) between 1 and 255 and file_name !~ '[\\/]');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_checksum_check'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_checksum_check
      check (file_checksum is null or file_checksum ~ '^[0-9a-f]{64}$') not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_status_check'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_status_check
      check (status in ('accepted', 'accepted_with_rejections', 'rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_counts_check'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_counts_check check (
        accepted_count >= 0 and rejected_count >= 0 and unchanged_count >= 0
        and accepted_count = created_count + updated_count
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_row_counts_check'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_row_counts_check check (
        row_count > 0 and created_count >= 0 and updated_count >= 0
        and row_count = created_count + updated_count + unchanged_count + rejected_count
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_rejections_check'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_rejections_check
      check (jsonb_typeof(rejections) = 'array');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_path_check'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_path_check check (
        array_length(string_to_array(storage_path, '/'), 1) = 5
        and split_part(storage_path, '/', 1) = org_id::text
        and split_part(storage_path, '/', 2) = 'price-submissions'
        and split_part(storage_path, '/', 3) = supplier_id::text
        and split_part(storage_path, '/', 4) = id::text
        and split_part(storage_path, '/', 5) <> ''
        and split_part(storage_path, '/', 6) = ''
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_month_revision_key'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_month_revision_key
      unique (org_id, supplier_id, target_month, revision);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_month_checksum_key'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_month_checksum_key
      unique (org_id, supplier_id, target_month, file_checksum);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname = 'supplier_price_submissions_storage_path_key'
  ) then
    alter table public.supplier_price_submissions
      add constraint supplier_price_submissions_storage_path_key
      unique (org_id, storage_path);
  end if;
end
$$;

do $$
declare
  v_invalid bigint;
begin
  select count(*) into v_invalid
  from public.supplier_price_submissions
  where target_month is null
     or revision is null
     or status is null
     or accepted_count is null
     or rejected_count is null
     or unchanged_count is null
     or rejections is null
     or processed_at is null
     or row_count is null
     or created_count is null
     or updated_count is null;
  if v_invalid <> 0 then
    raise exception '0030 refused: % submission rows cannot satisfy the canonical counters.', v_invalid;
  end if;
end
$$;

alter table public.supplier_price_submissions
  alter column revision set not null,
  alter column status set not null,
  alter column accepted_count set default 0,
  alter column accepted_count set not null,
  alter column rejected_count set default 0,
  alter column rejected_count set not null,
  alter column unchanged_count set default 0,
  alter column unchanged_count set not null,
  alter column rejections set default '[]'::jsonb,
  alter column rejections set not null,
  alter column processed_at set default now(),
  alter column processed_at set not null,
  alter column row_count set not null,
  alter column created_count set not null,
  alter column updated_count set not null,
  alter column file_name drop not null,
  alter column storage_path drop not null,
  alter column file_checksum drop not null,
  alter column submitted_by drop not null;

comment on table public.supplier_price_submissions is
  'Immutable supplier price submission ledger. Rows predating trusted file intake may have null file metadata.';

-- Fail closed: the canonical and rich-count contracts must coexist, the legacy names and
-- browser RPC must be gone, and the immutable trigger must be active.
do $$
declare
  v_missing text;
begin
  select string_agg(column_name, ', ' order by column_name) into v_missing
  from (values
    ('id'), ('org_id'), ('supplier_id'), ('target_month'), ('revision'),
    ('file_name'), ('storage_path'), ('file_checksum'), ('status'),
    ('accepted_count'), ('rejected_count'), ('unchanged_count'), ('rejections'),
    ('submitted_by'), ('submitted_at'), ('processed_at'),
    ('row_count'), ('created_count'), ('updated_count')
  ) expected(column_name)
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'supplier_price_submissions'
      and c.column_name = expected.column_name
  );
  if v_missing is not null then
    raise exception '0030 refused: supplier_price_submissions is missing %.', v_missing;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'supplier_price_submissions'
      and column_name in ('effective_month', 'correction_number', 'payload_hash')
  ) then
    raise exception '0030 refused: legacy supplier submission columns remain.';
  end if;

  if to_regprocedure('public.import_supplier_prices(jsonb,date,text,uuid)') is not null then
    raise exception '0030 refused: the legacy supplier submission RPC remains executable.';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.supplier_price_submissions'::regclass
      and tgname = 'supplier_price_submissions_immutable'
      and not tgisinternal
      and tgenabled = 'O'
  ) then
    raise exception '0030 refused: supplier_price_submissions_immutable is not enabled.';
  end if;

  if 2 <> (
    select count(*) from pg_constraint
    where conrelid = 'public.supplier_price_submissions'::regclass
      and conname in (
        'supplier_price_submissions_path_check',
        'supplier_price_submissions_checksum_check'
      )
      and not convalidated
  ) then
    raise exception '0030 refused: path/checksum legacy constraints must remain NOT VALID.';
  end if;
end
$$;
