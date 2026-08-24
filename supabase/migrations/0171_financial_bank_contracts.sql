-- 0171 -- Structured supplier bank accounts and canonical XLSX bank imports.
--
-- Bank destinations are not free text. Existing text moves to a private, human-review queue;
-- nothing parses or promotes it automatically. Active payment readers use structured rows only.
-- The existing step-up/reason/audit boundary remains the sole browser write path.

-- ===== 1. Structured current account + private legacy review queue =====

create table public.supplier_bank_accounts (
  supplier_id uuid primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  account_holder text not null,
  country_code text not null,
  bank_code text,
  branch_code text,
  account_number text,
  iban text,
  bic text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint supplier_bank_accounts_supplier_fk
    foreign key (org_id, supplier_id)
    references public.suppliers(org_id, id) on delete restrict,
  constraint supplier_bank_accounts_holder_shape check (
    account_holder = btrim(account_holder)
    and char_length(account_holder) between 1 and 200
  ),
  constraint supplier_bank_accounts_country_shape check (
    country_code ~ '^[A-Z]{2}$'
  ),
  constraint supplier_bank_accounts_shape check (
    (
      country_code = 'IL'
      and bank_code ~ '^[0-9]{1,3}$'
      and branch_code ~ '^[0-9]{1,3}$'
      and account_number ~ '^[0-9-]{1,20}$'
      and iban is null
      and bic is null
    )
    or
    (
      country_code <> 'IL'
      and bank_code is null
      and branch_code is null
      and account_number is null
      and iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'
      and left(iban, 2) = country_code
      and (bic is null or bic ~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$')
    )
  )
);

create index supplier_bank_accounts_org_supplier_idx
  on public.supplier_bank_accounts(org_id, supplier_id);

alter table public.supplier_bank_accounts enable row level security;
alter table public.supplier_bank_accounts force row level security;
revoke all on table public.supplier_bank_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.supplier_bank_accounts to service_role;

create trigger p1_financial_command_guard
before insert or update or delete on public.supplier_bank_accounts
for each row execute function public.p1_financial_command_guard();

create trigger zz_organization_write_guard
before insert or update or delete on public.supplier_bank_accounts
for each row execute function private.organization_row_write_guard();

create table private.supplier_bank_detail_migration_queue (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  supplier_id uuid not null,
  legacy_bank_details text not null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  constraint supplier_bank_detail_migration_queue_supplier_fk
    foreign key (org_id, supplier_id)
    references public.suppliers(org_id, id) on delete cascade,
  constraint supplier_bank_detail_migration_queue_legacy_shape check (
    legacy_bank_details = btrim(legacy_bank_details)
    and char_length(legacy_bank_details) between 1 and 4000
  ),
  constraint supplier_bank_detail_migration_queue_review_shape check (
    (status = 'pending' and reviewed_at is null and reviewed_by is null)
    or (status <> 'pending' and reviewed_at is not null and reviewed_by is not null)
  ),
  unique (org_id, supplier_id)
);

create index supplier_bank_detail_migration_queue_status_idx
  on private.supplier_bank_detail_migration_queue(org_id, status, supplier_id);
revoke all on table private.supplier_bank_detail_migration_queue
  from public, anon, authenticated, service_role;

-- Literal move only. No parser, heuristic or structured backfill is permitted here.
--
-- Two triggers on public.suppliers stand down for exactly this conversion, inside this
-- transaction, and come straight back. The precedent is 0056:96 and 0134:6.
--
--   suppliers_audit (0001:447) writes to_jsonb(old) into audit_logs.old_values. Clearing the
--   column row by row would therefore copy every legacy bank string, in the clear, into a table
--   the browser reads (audit_select, then audit_log_read_model, then the supplier log screen) --
--   republishing the exact text this migration exists to take out of browser reach, with a null
--   actor and no reason. The same rows would additionally fan out one supplier.updated domain
--   event each (0063:157). One summary row per organization is written below instead: counts,
--   never text. Existing audit history is not touched.
--
--   zz_organization_write_guard (0092:177) raises organization_read_only whenever
--   private.organization_access_mode is not active/trial/grace. Its lifecycle escape hatch
--   requires auth.uid(), which is null during a migration, so one suspended or offboarding
--   tenant still holding legacy bank text would fail the whole migration -- and would equally
--   block the summary row, because audit_logs carries the same guard. Retiring a column is
--   schema evolution, not a tenant write, so the latch is suspended for the conversion only.
alter table public.suppliers disable trigger suppliers_audit;
alter table public.suppliers disable trigger zz_organization_write_guard;
alter table public.audit_logs disable trigger zz_organization_write_guard;

do $legacy_move$
declare
  v_source_count integer;
  v_queued_count integer;
  v_cleared_count integer;
begin
  select count(*) into v_source_count
  from public.suppliers
  where nullif(btrim(bank_details), '') is not null;

  insert into private.supplier_bank_detail_migration_queue (
    org_id, supplier_id, legacy_bank_details, status
  )
  select org_id, id, btrim(bank_details), 'pending'
  from public.suppliers
  where nullif(btrim(bank_details), '') is not null
  order by org_id, id;
  get diagnostics v_queued_count = row_count;

  if v_queued_count <> v_source_count then
    raise exception '0171: legacy bank queue count mismatch: source %, queued %',
      v_source_count, v_queued_count;
  end if;

  update public.suppliers
  set bank_details = null
  where bank_details is not null;
  get diagnostics v_cleared_count = row_count;

  if v_cleared_count < v_source_count then
    raise exception '0171: legacy bank clearing lost rows: source %, cleared %',
      v_source_count, v_cleared_count;
  end if;

  -- One row per organization, derived from the queue: how many suppliers moved, never what any
  -- of them said. The action is deliberately not supplier_bank_details_changed -- that name is a
  -- mapped domain event (0063:160) reserved for a human decision, and this is a conversion.
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  )
  select queue.org_id,
         null::uuid,
         'supplier_bank_details_migrated',
         'suppliers',
         null::uuid,
         null::jsonb,
         jsonb_build_object('migration', '0171', 'supplier_count', count(*)),
         'Legacy free-text bank details moved to the private review queue by migration 0171. '
           || 'No bank text was copied into the audit ledger.'
  from private.supplier_bank_detail_migration_queue queue
  group by queue.org_id;
end
$legacy_move$;

alter table public.audit_logs enable trigger zz_organization_write_guard;
alter table public.suppliers enable trigger zz_organization_write_guard;
alter table public.suppliers enable trigger suppliers_audit;

alter table public.suppliers
  add constraint suppliers_legacy_bank_details_retired
  check (bank_details is null);

-- ===== 2. Structured projections; legacy text never participates =====

create or replace view public.financial_supplier_directory
with (security_barrier = true)
as
select supplier.id,
       supplier.name,
       supplier.tax_id,
       supplier.payment_terms,
       supplier.status,
       case
         when account.supplier_id is null then null
         else 'חשבון בנק מוגדר · ' || account.country_code
           || ' · מסתיים ב־' || right(coalesce(account.account_number, account.iban), 4)
       end as bank_details
from public.suppliers supplier
left join public.supplier_bank_accounts account
  on account.org_id = supplier.org_id
 and account.supplier_id = supplier.id
where supplier.org_id = public.auth_org()
  and auth.uid() is not null
  and public.auth_role() in ('owner', 'office', 'accountant');

revoke all on public.financial_supplier_directory from public, anon, authenticated;
grant select on public.financial_supplier_directory to authenticated;

comment on view public.financial_supplier_directory is
  'Tenant-scoped financial supplier identity. bank_details is a masked configured/country/last4 '
  'summary derived from 0171 structured rows. Full account/IBAN/BIC values require the dedicated '
  'financial_supplier_bank_accounts projection; suppliers.bank_details legacy text is never read.';

create view public.financial_supplier_bank_accounts
with (security_barrier = true)
as
select account.supplier_id,
       account.account_holder,
       account.country_code,
       account.bank_code,
       account.branch_code,
       account.account_number,
       account.iban,
       account.bic,
       exists (
         select 1
         from private.supplier_bank_detail_migration_queue migration
         where migration.org_id = account.org_id
           and migration.supplier_id = account.supplier_id
           and migration.status = 'pending'
       ) as migration_pending
from public.supplier_bank_accounts account
where account.org_id = public.auth_org()
  and auth.uid() is not null
  and public.auth_role() in ('owner', 'office', 'accountant');

revoke all on public.financial_supplier_bank_accounts from public, anon, authenticated;
grant select on public.financial_supplier_bank_accounts to authenticated;

comment on view public.financial_supplier_bank_accounts is
  'Structured supplier bank account projection for active financial roles. No legacy free text.';

create function public.read_supplier_bank_migration_item(p_supplier_id uuid)
returns table (
  supplier_id uuid,
  legacy_bank_details text,
  status text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select migration.supplier_id,
         migration.legacy_bank_details,
         migration.status
  from private.supplier_bank_detail_migration_queue migration
  join public.suppliers supplier
    on supplier.org_id = migration.org_id
   and supplier.id = migration.supplier_id
  where p_supplier_id is not null
    and migration.supplier_id = p_supplier_id
    and migration.org_id = public.auth_org()
    and migration.status = 'pending'
    and supplier.deleted_at is null
    and auth.uid() is not null
    and public.auth_role() in ('owner', 'office')
$$;

revoke all on function public.read_supplier_bank_migration_item(uuid)
  from public, anon;
grant execute on function public.read_supplier_bank_migration_item(uuid)
  to authenticated;

-- ===== 3. Step-up command over structured rows =====

-- The 0061 free-text signature is dropped, not left behind as a throwing stub. Both signatures
-- would have the same arity and the same parameter names, and PostgREST resolves an RPC by
-- parameter names alone: every browser call would come back PGRST203 rather than reaching either
-- body -- including the removal call, where a JSON null carries no type to disambiguate with.
-- Every other overload pair in this schema differs in arity. Replacing a signature by dropping
-- it is the idiom here (0030:16, 0032:398, 0052:27, 0129:19, 0136:1375, 0141:95).
drop function public.update_supplier_bank_details(uuid, text, text);

create function public.update_supplier_bank_details(
  p_supplier_id uuid,
  p_bank_details jsonb,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(btrim(p_reason), '');
  v_supplier public.suppliers;
  v_old public.supplier_bank_accounts;
  v_holder text;
  v_country text;
  v_bank text;
  v_branch text;
  v_account text;
  v_iban text;
  v_bic text;
  v_old_summary jsonb;
  v_new_summary jsonb;
begin
  if v_org is null or v_actor is null or public.auth_role() not in ('owner', 'office') then
    raise exception 'supplier_bank_details_not_authorized' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();
  if v_reason is null then
    raise exception 'supplier_bank_details_reason_required' using errcode = '22023';
  end if;

  select * into v_supplier
  from public.suppliers supplier
  where supplier.id = p_supplier_id
    and supplier.org_id = v_org
    and supplier.deleted_at is null
  for update;
  if not found then
    raise exception 'supplier_unknown' using errcode = 'P0002';
  end if;

  if p_bank_details is not null then
    if jsonb_typeof(p_bank_details) <> 'object'
       or exists (
         select 1 from jsonb_object_keys(p_bank_details) key
         where key not in (
           'account_holder', 'country_code', 'bank_code', 'branch_code',
           'account_number', 'iban', 'bic'
         )
       ) then
      raise exception 'supplier_bank_details_invalid' using errcode = '22023';
    end if;

    v_holder := nullif(btrim(p_bank_details ->> 'account_holder'), '');
    v_country := upper(nullif(btrim(p_bank_details ->> 'country_code'), ''));
    v_bank := nullif(regexp_replace(coalesce(p_bank_details ->> 'bank_code', ''), '\s+', '', 'g'), '');
    v_branch := nullif(regexp_replace(coalesce(p_bank_details ->> 'branch_code', ''), '\s+', '', 'g'), '');
    v_account := nullif(regexp_replace(coalesce(p_bank_details ->> 'account_number', ''), '\s+', '', 'g'), '');
    v_iban := nullif(upper(regexp_replace(coalesce(p_bank_details ->> 'iban', ''), '\s+', '', 'g')), '');
    v_bic := nullif(upper(regexp_replace(coalesce(p_bank_details ->> 'bic', ''), '\s+', '', 'g')), '');

    if v_holder is null or char_length(v_holder) > 200
       or v_country is null or v_country !~ '^[A-Z]{2}$'
       or (
         v_country = 'IL'
         and (
           v_bank is null or v_bank !~ '^[0-9]{1,3}$'
           or v_branch is null or v_branch !~ '^[0-9]{1,3}$'
           or v_account is null or v_account !~ '^[0-9-]{1,20}$'
           or v_iban is not null or v_bic is not null
         )
       )
       or (
         v_country <> 'IL'
         and (
           v_bank is not null or v_branch is not null or v_account is not null
           or v_iban is null or v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'
           or left(v_iban, 2) <> v_country
           or (v_bic is not null and v_bic !~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$')
         )
       ) then
      raise exception 'supplier_bank_details_invalid' using errcode = '22023';
    end if;
  end if;

  select * into v_old
  from public.supplier_bank_accounts account
  where account.supplier_id = v_supplier.id
    and account.org_id = v_org
  for update;

  if v_old.supplier_id is not null then
    v_old_summary := jsonb_build_object(
      'shape', case when v_old.country_code = 'IL' then 'israel' else 'international' end,
      'country_code', v_old.country_code,
      'last_four', right(coalesce(v_old.account_number, v_old.iban), 4),
      'fingerprint', md5(concat_ws('|', v_old.account_holder, v_old.country_code,
        v_old.bank_code, v_old.branch_code, v_old.account_number, v_old.iban, v_old.bic))
    );
  end if;

  perform set_config('app.p1_financial_writer', v_actor::text, true);

  if p_bank_details is null then
    delete from public.supplier_bank_accounts
    where supplier_id = v_supplier.id and org_id = v_org;
    v_new_summary := null;
  else
    insert into public.supplier_bank_accounts (
      supplier_id, org_id, account_holder, country_code,
      bank_code, branch_code, account_number, iban, bic, updated_by
    ) values (
      v_supplier.id, v_org, v_holder, v_country,
      v_bank, v_branch, v_account, v_iban, v_bic, v_actor
    )
    on conflict (supplier_id) do update set
      account_holder = excluded.account_holder,
      country_code = excluded.country_code,
      bank_code = excluded.bank_code,
      branch_code = excluded.branch_code,
      account_number = excluded.account_number,
      iban = excluded.iban,
      bic = excluded.bic,
      updated_at = now(),
      updated_by = excluded.updated_by
    where supplier_bank_accounts.org_id = excluded.org_id;

    v_new_summary := jsonb_build_object(
      'shape', case when v_country = 'IL' then 'israel' else 'international' end,
      'country_code', v_country,
      'last_four', right(coalesce(v_account, v_iban), 4),
      'fingerprint', md5(concat_ws('|', v_holder, v_country,
        v_bank, v_branch, v_account, v_iban, v_bic))
    );
  end if;

  update private.supplier_bank_detail_migration_queue migration
  set status = 'confirmed', reviewed_at = now(), reviewed_by = v_actor
  where migration.org_id = v_org
    and migration.supplier_id = v_supplier.id
    and migration.status = 'pending';

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id,
    old_values, new_values, reason
  ) values (
    v_org, v_actor, 'supplier_bank_details_changed', 'suppliers', v_supplier.id,
    v_old_summary, v_new_summary, v_reason
  );
end
$$;

revoke all on function public.update_supplier_bank_details(uuid, jsonb, text)
  from public, anon;
grant execute on function public.update_supplier_bank_details(uuid, jsonb, text)
  to authenticated;

-- ===== 4. Canonical XLSX metadata at the existing atomic import command =====

create or replace function public.import_bank_transactions(
  p_filename text,
  p_file_hash text,
  p_column_mapping jsonb,
  p_rows jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.auth_org();
  v_user uuid := auth.uid();
  v_role public.user_role := public.auth_role();
  v_import public.bank_imports;
  v_filename text := nullif(btrim(p_filename), '');
  v_file_hash text := lower(nullif(btrim(p_file_hash), ''));
  v_reason text := nullif(btrim(p_reason), '');
  v_contract constant jsonb := '{
    "template_version":"1",
    "sheet":"Bank Transactions",
    "headers":["transaction_date","description","direction","amount","reference"]
  }'::jsonb;
  v_count integer;
  v_distinct integer;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'accountant') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_filename is null or v_filename !~* '\.xlsx$'
     or p_column_mapping is distinct from v_contract then
    raise exception 'bank_import_contract_invalid' using errcode = '22023';
  end if;
  if v_file_hash is null or v_file_hash !~ '^[0-9a-f]{64}$'
     or v_reason is null
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'bank_import_invalid' using errcode = '22023';
  end if;

  perform 1 from public.organizations where id = v_org for update;

  select * into v_import
  from public.bank_imports
  where org_id = v_org and file_hash = v_file_hash
  for update;

  if found then
    return jsonb_build_object(
      'import_id', v_import.id,
      'row_count', v_import.row_count,
      'idempotent', true
    );
  end if;

  select count(*), count(distinct row_hash)
    into v_count, v_distinct
  from jsonb_to_recordset(p_rows) as row_value(
    tx_date date,
    description text,
    amount numeric,
    is_debit boolean,
    reference text,
    raw jsonb,
    supplier_id uuid,
    row_hash text
  );

  if v_count = 0 or v_count <> v_distinct or exists (
    select 1
    from jsonb_to_recordset(p_rows) as row_value(
      tx_date date,
      description text,
      amount numeric,
      is_debit boolean,
      reference text,
      raw jsonb,
      supplier_id uuid,
      row_hash text
    )
    where tx_date is null or nullif(btrim(description), '') is null
       or amount is null or amount <= 0 or is_debit is null or raw is null
       or raw ->> 'direction' not in ('debit','credit')
       or is_debit is distinct from ((raw ->> 'direction') = 'debit')
       or nullif(btrim(row_hash), '') is null or lower(btrim(row_hash)) !~ '^[0-9a-f]{64}$'
       or (supplier_id is not null and not exists (
         select 1 from public.suppliers supplier
         where supplier.id = row_value.supplier_id
           and supplier.org_id = v_org
           and supplier.deleted_at is null
       ))
  ) then
    raise exception 'bank_import_invalid_rows' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as row_value(
      tx_date date,
      description text,
      amount numeric,
      is_debit boolean,
      reference text,
      raw jsonb,
      supplier_id uuid,
      row_hash text
    )
    join public.bank_transactions transaction
      on transaction.org_id = v_org
     and transaction.row_hash = lower(btrim(row_value.row_hash))
  ) then
    raise exception 'bank_row_replayed' using errcode = '23505';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  insert into public.bank_imports (
    org_id, filename, file_hash, column_mapping, row_count, imported_by
  ) values (
    v_org, v_filename, v_file_hash, v_contract, v_count, v_user
  ) returning * into v_import;

  insert into public.bank_transactions (
    org_id, import_id, tx_date, description, amount, is_debit,
    reference, raw, supplier_id, status, row_hash
  )
  select
    v_org,
    v_import.id,
    tx_date,
    btrim(description),
    round(amount, 2),
    is_debit,
    nullif(btrim(reference), ''),
    raw,
    supplier_id,
    'unmatched',
    lower(btrim(row_hash))
  from jsonb_to_recordset(p_rows) as row_value(
    tx_date date,
    description text,
    amount numeric,
    is_debit boolean,
    reference text,
    raw jsonb,
    supplier_id uuid,
    row_hash text
  )
  order by tx_date, row_hash;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'bank_import_created', 'bank_imports', v_import.id,
    jsonb_build_object(
      'file_hash', v_file_hash,
      'row_count', v_count,
      'template_version', '1'
    ),
    v_reason
  );

  return jsonb_build_object(
    'import_id', v_import.id,
    'row_count', v_count,
    'idempotent', false
  );
end
$$;

revoke all on function public.import_bank_transactions(text, text, jsonb, jsonb, text)
  from public;
grant execute on function public.import_bank_transactions(text, text, jsonb, jsonb, text)
  to authenticated;

-- ===== 5. Registries and fail-closed self-check =====

insert into private.scope_registry (table_name, scope_class, enforced)
values ('supplier_bank_accounts', 'org_global', false);

insert into private.tenant_export_registry (
  table_name, disposition, excluded_columns, rationale
) values (
  'supplier_bank_accounts', 'include', '{}',
  'Tenant-owned structured supplier payment destinations; legacy review text stays private.'
)
on conflict (table_name) do update set
  disposition = excluded.disposition,
  excluded_columns = excluded.excluded_columns,
  rationale = excluded.rationale;

update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position
      ))
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
    )
where registry.table_name = 'supplier_bank_accounts';

do $self_check$
declare
  v_violations text;
  v_directory_columns text[];
  v_import text;
begin
  if exists (
    select 1 from public.suppliers
    where nullif(btrim(bank_details), '') is not null
  ) then
    raise exception '0171: active suppliers still contain legacy bank text';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.suppliers'::regclass
      and conname = 'suppliers_legacy_bank_details_retired'
      and pg_get_constraintdef(oid) = 'CHECK ((bank_details IS NULL))'
  ) then
    raise exception '0171: legacy bank column is not fail-closed';
  end if;

  if has_table_privilege('authenticated', 'public.supplier_bank_accounts', 'SELECT')
     or has_table_privilege('authenticated', 'public.supplier_bank_accounts', 'INSERT')
     or has_table_privilege('authenticated', 'public.supplier_bank_accounts', 'UPDATE')
     or has_table_privilege('authenticated', 'public.supplier_bank_accounts', 'DELETE') then
    raise exception '0171: browser has direct structured-bank table access';
  end if;

  -- to_regprocedure, not has_function_privilege: the free-text signature is gone, and asking
  -- about a privilege on a function that does not exist raises rather than returning false.
  if not has_function_privilege(
       'authenticated', 'public.update_supplier_bank_details(uuid,jsonb,text)', 'EXECUTE')
     or to_regprocedure('public.update_supplier_bank_details(uuid,text,text)') is not null then
    raise exception '0171: structured command is not the sole browser bank write path';
  end if;

  -- The projection contract is asserted against the rewrite rule's recorded column dependencies
  -- rather than against pg_get_viewdef text. A deparser is not a stable needle: RIGHT is a
  -- function-name keyword, so the masking call comes back printed as "right"(...) and a literal
  -- pin for right(coalesce(...)) can never match -- the check would fail on every run no matter
  -- what the view reads. pg_depend records exactly which columns the view consumes, which is the
  -- question actually being asked. That the projected value is a last-four mask and not the full
  -- number is a value claim, and it is proved against real rows in p62.
  if exists (
    select 1
    from pg_depend dependency
    join pg_rewrite rule on rule.oid = dependency.objid
    join pg_attribute attribute
      on attribute.attrelid = dependency.refobjid
     and attribute.attnum = dependency.refobjsubid
    where dependency.classid = 'pg_rewrite'::regclass
      and dependency.refclassid = 'pg_class'::regclass
      and rule.ev_class = 'public.financial_supplier_directory'::regclass
      and dependency.refobjid = 'public.suppliers'::regclass
      and attribute.attname = 'bank_details'
  ) then
    raise exception '0171: financial supplier projection still reads the legacy bank column';
  end if;

  select coalesce(array_agg(attribute.attname order by attribute.attname), '{}'::text[])
    into v_directory_columns
  from pg_depend dependency
  join pg_rewrite rule on rule.oid = dependency.objid
  join pg_attribute attribute
    on attribute.attrelid = dependency.refobjid
   and attribute.attnum = dependency.refobjsubid
  where dependency.classid = 'pg_rewrite'::regclass
    and dependency.refclassid = 'pg_class'::regclass
    and rule.ev_class = 'public.financial_supplier_directory'::regclass
    and dependency.refobjid = 'public.supplier_bank_accounts'::regclass;

  if not (v_directory_columns @> array['account_number', 'country_code', 'iban']::text[])
     or (v_directory_columns
         && array['account_holder', 'bic', 'bank_code', 'branch_code']::text[]) then
    raise exception
      '0171: the shared supplier directory reads the wrong bank columns: %',
      v_directory_columns;
  end if;

  select pg_get_functiondef(
    'public.import_bank_transactions(text,text,jsonb,jsonb,text)'::regprocedure
  ) into v_import;
  if position('bank_import_contract_invalid' in v_import) = 0
     or position('Bank Transactions' in v_import) = 0
     or position('transaction_date' in v_import) = 0
     or position('direction' in v_import) = 0 then
    raise exception '0171: canonical bank import contract is not pinned in the command';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0171 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0171 tenant-export assertions failed:\n%', v_violations;
  end if;
end
$self_check$;
