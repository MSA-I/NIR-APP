-- Immutable, versioned accountant-report snapshots.
-- The live /reports view remains unchanged; this table is the database source of truth
-- only for explicitly finalized monthly reports. Final report invoice rows are canonical:
-- approved invoices only, regardless of whether owner or accountant creates the version.

create table public.monthly_report_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  report_month date not null,
  version integer not null check (version > 0),
  report_version text not null default 'monthly-accountant-v1',
  organization_name text not null,
  created_by uuid not null,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  invoice_rows jsonb not null check (jsonb_typeof(invoice_rows) = 'array'),
  payment_rows jsonb not null check (jsonb_typeof(payment_rows) = 'array'),
  credit_rows jsonb not null check (jsonb_typeof(credit_rows) = 'array'),
  exception_rows jsonb not null check (jsonb_typeof(exception_rows) = 'array'),
  bank_rows jsonb not null check (jsonb_typeof(bank_rows) = 'array'),
  totals jsonb not null check (jsonb_typeof(totals) = 'object'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_report_snapshots_first_day check (
    report_month = date_trunc('month', report_month)::date
  ),
  constraint monthly_report_snapshots_org_creator_fk
    foreign key (org_id, created_by) references public.profiles(org_id, id) on delete restrict,
  constraint monthly_report_snapshots_org_month_version_key
    unique (org_id, report_month, version)
);

create index monthly_report_snapshots_org_month_idx
  on public.monthly_report_snapshots (org_id, report_month, version desc);

alter table public.monthly_report_snapshots enable row level security;
alter table public.monthly_report_snapshots force row level security;

create policy monthly_report_snapshots_select
  on public.monthly_report_snapshots
  for select
  to authenticated
  using (
    org_id = auth_org()
    and auth_role() in ('owner', 'accountant')
  );

revoke all on table public.monthly_report_snapshots from public, anon, authenticated, service_role;
grant select on table public.monthly_report_snapshots to authenticated, service_role;

create or replace function public.reject_monthly_report_snapshot_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'monthly_report_snapshot_immutable' using errcode = '42501';
end
$$;

revoke all on function public.reject_monthly_report_snapshot_mutation()
  from public, anon, authenticated, service_role;

create trigger monthly_report_snapshots_immutable
  before update or delete on public.monthly_report_snapshots
  for each row execute function public.reject_monthly_report_snapshot_mutation();

create or replace function public.create_monthly_report_snapshot(p_month date)
returns public.monthly_report_snapshots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_created_at timestamptz;
  v_snapshot public.monthly_report_snapshots;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'accountant') then
    raise exception 'monthly_report_snapshot_not_authorized' using errcode = '42501';
  end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    raise exception 'monthly_report_snapshot_month_invalid' using errcode = '22023';
  end if;

  -- Serialize versions per tenant/month. The following INSERT is one SQL statement, so every
  -- source CTE observes one PostgreSQL statement snapshot and either it plus its audit commit,
  -- or neither does.
  perform pg_advisory_xact_lock(
    hashtextextended('monthly-report-snapshot:' || v_org::text || ':' || p_month::text, 0)
  );
  v_role := auth_role();
  if auth.uid() is distinct from v_user
     or auth_org() is distinct from v_org
     or v_role not in ('owner', 'accountant') then
    raise exception 'monthly_report_snapshot_not_authorized' using errcode = '42501';
  end if;
  v_created_at := clock_timestamp();

  with invoice_data as (
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id,
        'supplier', jsonb_build_object('name', s.name),
        'invoice_number', i.invoice_number,
        'invoice_date', i.invoice_date,
        'amount_before_vat', i.amount_before_vat,
        'vat_amount', i.vat_amount,
        'total_amount', i.total_amount,
        'review_status', i.review_status,
        'payment_status', i.payment_status
      ) order by i.invoice_date, i.id), '[]'::jsonb) as rows,
      count(*)::integer as row_count,
      coalesce(sum(i.amount_before_vat), 0)::numeric(12,2) as before_vat_total,
      coalesce(sum(i.vat_amount), 0)::numeric(12,2) as vat_total,
      coalesce(sum(i.total_amount), 0)::numeric(12,2) as invoice_total,
      count(*) filter (where i.payment_status <> 'paid')::integer as unpaid_count
    from public.invoices i
    join public.suppliers s on s.org_id = i.org_id and s.id = i.supplier_id
    where i.org_id = v_org
      and i.invoice_date >= p_month
      and i.invoice_date < (p_month + interval '1 month')::date
      and i.deleted_at is null
      and i.review_status = 'approved'
  ), payment_data as (
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id,
        'number', p.number,
        'supplier', jsonb_build_object('name', s.name),
        'paid_date', p.paid_date,
        'amount', p.amount,
        'method', p.method,
        'reference', p.reference
      ) order by p.paid_date, p.id), '[]'::jsonb) as rows,
      count(*)::integer as row_count,
      coalesce(sum(p.amount), 0)::numeric(12,2) as payment_total
    from public.payments p
    join public.suppliers s on s.org_id = p.org_id and s.id = p.supplier_id
    where p.org_id = v_org
      and p.paid_date >= p_month
      and p.paid_date < (p_month + interval '1 month')::date
  ), credit_data as (
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id,
        'number', c.number,
        'supplier', jsonb_build_object('name', s.name),
        'reason', c.reason,
        'amount', c.amount,
        'status', c.status
      ) order by c.created_at, c.id), '[]'::jsonb) as rows,
      count(*)::integer as row_count,
      coalesce(sum(c.amount), 0)::numeric(12,2) as credit_total
    from public.credit_requests c
    join public.suppliers s on s.org_id = c.org_id and s.id = c.supplier_id
    where c.org_id = v_org
      and (c.created_at at time zone 'Asia/Jerusalem')::date >= p_month
      and (c.created_at at time zone 'Asia/Jerusalem')::date
            < (p_month + interval '1 month')::date
  ), exception_data as (
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id,
        'type', e.type,
        'title', e.title,
        'supplier', case when s.id is null then null
                         else jsonb_build_object('name', s.name) end
      ) order by e.created_at, e.id), '[]'::jsonb) as rows,
      count(*)::integer as row_count
    from public.exceptions e
    left join public.suppliers s on s.org_id = e.org_id and s.id = e.supplier_id
    where e.org_id = v_org and e.status in ('open', 'in_progress')
  ), bank_data as (
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id,
        'tx_date', b.tx_date,
        'status', b.status
      ) order by b.tx_date, b.id), '[]'::jsonb) as rows,
      count(*) filter (where b.status in ('unmatched', 'suggested'))::integer
        as unmatched_count
    from public.bank_transactions b
    where b.org_id = v_org
      and b.tx_date >= p_month
      and b.tx_date < (p_month + interval '1 month')::date
  ), assembled as (
    select
      o.name as organization_name,
      creator.full_name as created_by_name,
      invoices.rows as invoice_rows,
      payments.rows as payment_rows,
      credits.rows as credit_rows,
      exceptions.rows as exception_rows,
      bank.rows as bank_rows,
      jsonb_build_object(
        'invoice_count', invoices.row_count,
        'invoice_total', invoices.invoice_total,
        'before_vat_total', invoices.before_vat_total,
        'vat_total', invoices.vat_total,
        'payment_count', payments.row_count,
        'payment_total', payments.payment_total,
        'credit_count', credits.row_count,
        'credit_total', credits.credit_total,
        'exception_count', exceptions.row_count,
        'unpaid_invoice_count', invoices.unpaid_count,
        'unmatched_bank_count', bank.unmatched_count
      ) as totals
    from public.organizations o
    join public.profiles creator on creator.org_id = o.id and creator.id = v_user
    cross join invoice_data invoices
    cross join payment_data payments
    cross join credit_data credits
    cross join exception_data exceptions
    cross join bank_data bank
    where o.id = v_org
  )
  insert into public.monthly_report_snapshots (
    org_id, report_month, version, report_version,
    organization_name, created_by, created_by_name, created_at,
    invoice_rows, payment_rows, credit_rows, exception_rows, bank_rows,
    totals, content_hash
  )
  select
    v_org,
    p_month,
    coalesce((
      select max(existing.version)
      from public.monthly_report_snapshots existing
      where existing.org_id = v_org and existing.report_month = p_month
    ), 0) + 1,
    'monthly-accountant-v1',
    assembled.organization_name,
    v_user,
    assembled.created_by_name,
    v_created_at,
    assembled.invoice_rows,
    assembled.payment_rows,
    assembled.credit_rows,
    assembled.exception_rows,
    assembled.bank_rows,
    assembled.totals,
    encode(sha256(convert_to(jsonb_build_object(
      'report_version', 'monthly-accountant-v1',
      'organization_id', v_org,
      'organization_name', assembled.organization_name,
      'report_month', p_month,
      'invoice_rows', assembled.invoice_rows,
      'payment_rows', assembled.payment_rows,
      'credit_rows', assembled.credit_rows,
      'exception_rows', assembled.exception_rows,
      'bank_rows', assembled.bank_rows,
      'totals', assembled.totals
    )::text, 'UTF8')), 'hex')
  from assembled
  returning * into v_snapshot;

  if v_snapshot.id is null then
    raise exception 'monthly_report_snapshot_source_unavailable' using errcode = 'P0001';
  end if;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org,
    v_user,
    'monthly_report_snapshot_created',
    'monthly_report_snapshots',
    v_snapshot.id,
    jsonb_build_object(
      'snapshot_id', v_snapshot.id,
      'report_month', v_snapshot.report_month,
      'version', v_snapshot.version,
      'report_version', v_snapshot.report_version,
      'created_by', v_snapshot.created_by,
      'created_at', v_snapshot.created_at,
      'content_hash', v_snapshot.content_hash
    ),
    'יצירת דוח סופי נעול לרו״ח'
  );

  return v_snapshot;
end
$$;

revoke all on function public.create_monthly_report_snapshot(date)
  from public, anon, authenticated, service_role;
grant execute on function public.create_monthly_report_snapshot(date) to authenticated;

comment on table public.monthly_report_snapshots is
  'Immutable, versioned monthly accountant reports over approved invoices. JSONB ledgers and totals are the authoritative export source.';
comment on column public.monthly_report_snapshots.content_hash is
  'SHA-256 of the canonical report version, tenant/month identity, stored ledgers and totals.';
