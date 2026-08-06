-- Immutable, versioned monthly accountant snapshots, scoped to one legal entity.
--
-- The live /reports screen remains a best-effort operational view. A final report is a
-- separate command whose database row is the authoritative source for every later export.
-- OPEN-DECISIONS #106 fixes the boundary at (organization, legal entity, month, version).
-- Derived sources that cannot be attributed to exactly one legal entity fail closed; this
-- migration never substitutes an organization-wide aggregate for missing scope data.

create table public.monthly_report_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  unit_id uuid not null,
  report_month date not null,
  version integer not null check (version > 0),
  report_version text not null default 'monthly-accountant-legal-entity-v1',
  organization_name text not null,
  legal_entity_name text not null,
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
  constraint monthly_report_snapshots_org_unit_fk
    foreign key (org_id, unit_id) references public.org_units(org_id, id) on delete restrict,
  constraint monthly_report_snapshots_org_creator_fk
    foreign key (org_id, created_by) references public.profiles(org_id, id) on delete restrict,
  constraint monthly_report_snapshots_org_unit_month_version_key
    unique (org_id, unit_id, report_month, version)
);

create index monthly_report_snapshots_org_unit_month_idx
  on public.monthly_report_snapshots (org_id, unit_id, report_month, version desc);

comment on table public.monthly_report_snapshots is
  'Immutable final accountant reports. Each version belongs to exactly one legal entity; stored JSONB ledgers and totals are the authoritative export source.';
comment on column public.monthly_report_snapshots.content_hash is
  'SHA-256 over the report schema, tenant/legal-entity identity, month, stored ledgers and totals.';

alter table public.monthly_report_snapshots enable row level security;
alter table public.monthly_report_snapshots force row level security;

create policy monthly_report_snapshots_select
  on public.monthly_report_snapshots
  for select to authenticated
  using (org_id = auth_org() and auth_role() in ('owner', 'accountant'));

-- A3: this exact restrictive predicate is the scope-enforcement contract from 0057.
create policy scope_rider_monthly_report_snapshots
  on public.monthly_report_snapshots as restrictive for all to public
  using ((unit_id is null) or (unit_id = any (auth_scopes())));

revoke all on table public.monthly_report_snapshots
  from public, anon, authenticated, service_role;
grant select on table public.monthly_report_snapshots to authenticated;
grant select, insert, update, delete on table public.monthly_report_snapshots to service_role;

-- Immutability applies even to ordinary trusted CRUD. Schema owners can still perform an
-- explicit migration if a future report schema requires forward-only remediation.
create function public.reject_monthly_report_snapshot_mutation()
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

-- This assertion is deliberately not SECURITY DEFINER. It is called by the trusted command
-- and turns a data-quality ambiguity into a transaction failure before any snapshot is kept.
create function private.assert_monthly_report_sources(
  p_invalid_invoices bigint,
  p_invalid_payments bigint,
  p_invalid_credits bigint,
  p_invalid_bank_transactions bigint,
  p_invalid_exceptions bigint
) returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_invalid_invoices > 0 then
    raise exception 'monthly_report_snapshot_unattributed_invoices' using errcode = 'P0001';
  end if;
  if p_invalid_payments > 0 then
    raise exception 'monthly_report_snapshot_unattributed_payments' using errcode = 'P0001';
  end if;
  if p_invalid_credits > 0 then
    raise exception 'monthly_report_snapshot_unattributed_credits' using errcode = 'P0001';
  end if;
  if p_invalid_bank_transactions > 0 then
    raise exception 'monthly_report_snapshot_unattributed_bank_transactions' using errcode = 'P0001';
  end if;
  if p_invalid_exceptions > 0 then
    raise exception 'monthly_report_snapshot_unattributed_exceptions' using errcode = 'P0001';
  end if;
  return true;
end
$$;

revoke all on function private.assert_monthly_report_sources(bigint, bigint, bigint, bigint, bigint)
  from public, anon, authenticated;

-- The browser never reads org_units directly to discover choices. This narrow reader returns
-- only legal entities already present in the caller's materialized scope closure.
create function public.read_monthly_report_legal_entities()
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.name
  from public.org_units u
  where u.org_id = auth_org()
    and auth_role() in ('owner', 'accountant')
    and u.unit_type = 'legal_entity'
    and u.id = any(auth_scopes())
  order by u.name, u.id
$$;

revoke all on function public.read_monthly_report_legal_entities()
  from public, anon, authenticated, service_role;
grant execute on function public.read_monthly_report_legal_entities() to authenticated;

create function public.create_monthly_report_snapshot(p_month date, p_unit_id uuid)
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
  if p_unit_id is null or not exists (
    select 1 from public.org_units u
    where u.org_id = v_org and u.id = p_unit_id and u.unit_type = 'legal_entity'
  ) then
    raise exception 'monthly_report_snapshot_legal_entity_invalid' using errcode = '22023';
  end if;

  -- A5: the server command has an explicit scope assertion in addition to the table rider.
  perform public.assert_unit_in_scope(p_unit_id);

  -- Versions are serialized independently for each organization/legal-entity/month tuple.
  perform pg_advisory_xact_lock(hashtextextended(
    'monthly-report-snapshot:' || v_org::text || ':' || p_unit_id::text || ':' || p_month::text,
    0
  ));

  -- Re-check the caller context after waiting for the lock. A revoked profile or scope grant
  -- cannot ride a request that began before the revocation committed.
  if auth.uid() is distinct from v_user
     or auth_org() is distinct from v_org
     or auth_role() not in ('owner', 'accountant') then
    raise exception 'monthly_report_snapshot_not_authorized' using errcode = '42501';
  end if;
  perform public.assert_unit_in_scope(p_unit_id);
  v_created_at := clock_timestamp();

  -- Every source and every validation below belongs to ONE INSERT statement and therefore one
  -- PostgreSQL statement snapshot. The function transaction also makes the snapshot, audit row
  -- and emitted domain event atomic.
  with recursive
  unit_ancestry as materialized (
    select u.id as source_unit_id, u.id as ancestor_id, u.parent_id, u.unit_type, 0 as depth
    from public.org_units u
    where u.org_id = v_org
    union all
    select a.source_unit_id, parent.id, parent.parent_id, parent.unit_type, a.depth + 1
    from unit_ancestry a
    join public.org_units parent
      on parent.org_id = v_org and parent.id = a.parent_id
    where a.depth < 32
  ),
  unit_legal_entity as materialized (
    select
      source_unit_id,
      (array_agg(ancestor_id order by depth)
        filter (where unit_type = 'legal_entity'))[1] as legal_entity_id,
      count(*) filter (where unit_type = 'legal_entity') as legal_entity_count
    from unit_ancestry
    group by source_unit_id
  ),
  invoice_source as materialized (
    select i.*, s.name as supplier_name,
           case when u.unit_type = 'legal_entity' then i.unit_id end as legal_entity_id
    from public.invoices i
    join public.suppliers s on s.org_id = i.org_id and s.id = i.supplier_id
    left join public.org_units u
      on u.org_id = i.org_id and u.id = i.unit_id
    where i.org_id = v_org
      and i.invoice_date >= p_month
      and i.invoice_date < (p_month + interval '1 month')::date
      and i.deleted_at is null
      and i.review_status = 'approved'
  ),
  payment_source as materialized (
    select p.*, s.name as supplier_name,
           case when u.unit_type = 'legal_entity' then p.unit_id end as legal_entity_id
    from public.payments p
    join public.suppliers s on s.org_id = p.org_id and s.id = p.supplier_id
    left join public.org_units u
      on u.org_id = p.org_id and u.id = p.unit_id
    where p.org_id = v_org
      and p.paid_date >= p_month
      and p.paid_date < (p_month + interval '1 month')::date
  ),
  credit_source as materialized (
    select c.*, s.name as supplier_name,
           coalesce(array_agg(distinct candidate.legal_entity_id)
             filter (where candidate.legal_entity_id is not null), '{}') as legal_entity_ids,
           ((c.invoice_id is not null)::integer
             + (c.receipt_item_id is not null)::integer) as source_count,
           count(candidate.legal_entity_id)::integer as resolved_source_count
    from public.credit_requests c
    join public.suppliers s on s.org_id = c.org_id and s.id = c.supplier_id
    left join lateral (
      select case when iu.unit_type = 'legal_entity' then i.unit_id end as legal_entity_id
      from public.invoices i
      left join public.org_units iu on iu.org_id = i.org_id and iu.id = i.unit_id
      where i.org_id = c.org_id and i.id = c.invoice_id
      union all
      select case when ule.legal_entity_count = 1 then ule.legal_entity_id end
      from public.goods_receipt_items gri
      join public.goods_receipts gr
        on gr.org_id = gri.org_id and gr.id = gri.receipt_id
      left join unit_legal_entity ule on ule.source_unit_id = gr.unit_id
      where gri.org_id = c.org_id and gri.id = c.receipt_item_id
    ) candidate on true
    where c.org_id = v_org
      and (c.created_at at time zone 'Asia/Jerusalem')::date >= p_month
      and (c.created_at at time zone 'Asia/Jerusalem')::date
            < (p_month + interval '1 month')::date
    group by c.id, s.name
  ),
  relevant_bank_transactions as materialized (
    select b.*
    from public.bank_transactions b
    where b.org_id = v_org
      and b.tx_date >= p_month
      and b.tx_date < (p_month + interval '1 month')::date
    union
    select b.*
    from public.bank_transactions b
    join public.exceptions e
      on e.org_id = b.org_id and e.bank_transaction_id = b.id
    where b.org_id = v_org and e.status in ('open', 'in_progress')
  ),
  bank_source as materialized (
    select b.*,
           coalesce(array_agg(distinct candidate.legal_entity_id)
             filter (where candidate.legal_entity_id is not null), '{}') as legal_entity_ids,
           coalesce((
             select sum((allocation.invoice_id is not null)::integer
                        + (allocation.payment_id is not null)::integer)
             from public.bank_allocations allocation
             where allocation.org_id = b.org_id
               and allocation.bank_transaction_id = b.id
               and allocation.confirmed
           ), 0)::integer as source_count,
           count(candidate.legal_entity_id)::integer as resolved_source_count
    from relevant_bank_transactions b
    left join public.bank_allocations ba
      on ba.org_id = b.org_id and ba.bank_transaction_id = b.id and ba.confirmed
    left join lateral (
      select case when iu.unit_type = 'legal_entity' then i.unit_id end as legal_entity_id
      from public.invoices i
      left join public.org_units iu on iu.org_id = i.org_id and iu.id = i.unit_id
      where i.org_id = ba.org_id and i.id = ba.invoice_id
      union all
      select case when pu.unit_type = 'legal_entity' then p.unit_id end
      from public.payments p
      left join public.org_units pu on pu.org_id = p.org_id and pu.id = p.unit_id
      where p.org_id = ba.org_id and p.id = ba.payment_id
    ) candidate on true
    group by b.id, b.org_id, b.import_id, b.tx_date, b.description, b.amount,
             b.is_debit, b.reference, b.raw, b.supplier_id, b.status, b.row_hash
  ),
  payment_request_scope as materialized (
    select pr.id,
           coalesce(array_agg(distinct case when iu.unit_type = 'legal_entity' then i.unit_id end)
             filter (where iu.unit_type = 'legal_entity'), '{}') as legal_entity_ids,
           count(pri.invoice_id)::integer as source_count,
           count(i.unit_id) filter (where iu.unit_type = 'legal_entity')::integer
             as resolved_source_count
    from public.payment_requests pr
    left join public.payment_request_invoices pri
      on pri.org_id = pr.org_id and pri.payment_request_id = pr.id
    left join public.invoices i
      on i.org_id = pri.org_id and i.id = pri.invoice_id
    left join public.org_units iu
      on iu.org_id = i.org_id and iu.id = i.unit_id
    where pr.org_id = v_org
    group by pr.id
  ),
  exception_source as materialized (
    select e.*, s.name as supplier_name,
           coalesce(array_agg(distinct candidate.legal_entity_id)
             filter (where candidate.legal_entity_id is not null), '{}') as legal_entity_ids,
           ((e.invoice_id is not null)::integer
             + (e.payment_id is not null)::integer
             + (e.payment_request_id is not null)::integer
             + (e.bank_transaction_id is not null)::integer) as source_count,
           count(candidate.legal_entity_id)::integer as resolved_source_count
    from public.exceptions e
    left join public.suppliers s on s.org_id = e.org_id and s.id = e.supplier_id
    left join lateral (
      select case when iu.unit_type = 'legal_entity' then i.unit_id end as legal_entity_id
      from public.invoices i
      left join public.org_units iu on iu.org_id = i.org_id and iu.id = i.unit_id
      where i.org_id = e.org_id and i.id = e.invoice_id
      union all
      select case when pu.unit_type = 'legal_entity' then p.unit_id end
      from public.payments p
      left join public.org_units pu on pu.org_id = p.org_id and pu.id = p.unit_id
      where p.org_id = e.org_id and p.id = e.payment_id
      union all
      select prs.legal_entity_ids[1]
      from payment_request_scope prs
      where prs.id = e.payment_request_id
        and prs.source_count > 0
        and prs.resolved_source_count = prs.source_count
        and cardinality(prs.legal_entity_ids) = 1
      union all
      select bs.legal_entity_ids[1]
      from bank_source bs
      where bs.id = e.bank_transaction_id
        and bs.source_count > 0
        and bs.resolved_source_count = bs.source_count
        and cardinality(bs.legal_entity_ids) = 1
    ) candidate on true
    where e.org_id = v_org and e.status in ('open', 'in_progress')
    group by e.id, s.name
  ),
  validation as materialized (
    select private.assert_monthly_report_sources(
      (select count(*) from invoice_source where legal_entity_id is null),
      (select count(*) from payment_source where legal_entity_id is null),
      (select count(*) from credit_source
       where source_count = 0 or resolved_source_count <> source_count
          or cardinality(legal_entity_ids) <> 1),
      (select count(*) from bank_source
       where source_count = 0 or resolved_source_count <> source_count
          or cardinality(legal_entity_ids) <> 1),
      (select count(*) from exception_source
       where source_count = 0 or resolved_source_count <> source_count
          or cardinality(legal_entity_ids) <> 1)
    ) as valid
  ),
  invoice_data as materialized (
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id,
        'supplier', jsonb_build_object('name', i.supplier_name),
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
    from invoice_source i
    cross join validation v
    where v.valid and i.legal_entity_id = p_unit_id
  ),
  payment_data as materialized (
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id,
        'number', p.number,
        'supplier', jsonb_build_object('name', p.supplier_name),
        'paid_date', p.paid_date,
        'amount', p.amount,
        'method', p.method,
        'reference', p.reference
      ) order by p.paid_date, p.id), '[]'::jsonb) as rows,
      count(*)::integer as row_count,
      coalesce(sum(p.amount), 0)::numeric(12,2) as payment_total
    from payment_source p
    cross join validation v
    where v.valid and p.legal_entity_id = p_unit_id
  ),
  credit_data as materialized (
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id,
        'number', c.number,
        'supplier', jsonb_build_object('name', c.supplier_name),
        'reason', c.reason,
        'amount', c.amount,
        'status', c.status
      ) order by c.created_at, c.id), '[]'::jsonb) as rows,
      count(*)::integer as row_count,
      coalesce(sum(c.amount), 0)::numeric(12,2) as credit_total
    from credit_source c
    cross join validation v
    where v.valid and c.legal_entity_ids[1] = p_unit_id
  ),
  exception_data as materialized (
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id,
        'type', e.type,
        'title', e.title,
        'supplier', case when e.supplier_name is null then null
                         else jsonb_build_object('name', e.supplier_name) end
      ) order by e.created_at, e.id), '[]'::jsonb) as rows,
      count(*)::integer as row_count
    from exception_source e
    cross join validation v
    where v.valid and e.legal_entity_ids[1] = p_unit_id
  ),
  bank_data as materialized (
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id,
        'tx_date', b.tx_date,
        'description', b.description,
        'amount', b.amount,
        'is_debit', b.is_debit,
        'reference', b.reference,
        'status', b.status
      ) order by b.tx_date, b.id), '[]'::jsonb) as rows,
      count(*)::integer as row_count,
      count(*) filter (where b.status in ('unmatched', 'suggested'))::integer as unmatched_count,
      coalesce(sum(b.amount), 0)::numeric(12,2) as bank_total
    from bank_source b
    cross join validation v
    where v.valid
      and b.tx_date >= p_month
      and b.tx_date < (p_month + interval '1 month')::date
      and b.legal_entity_ids[1] = p_unit_id
  ),
  assembled as materialized (
    select
      o.name as organization_name,
      u.name as legal_entity_name,
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
        'bank_transaction_count', bank.row_count,
        'bank_total', bank.bank_total,
        'unpaid_invoice_count', invoices.unpaid_count,
        'unmatched_bank_count', bank.unmatched_count
      ) as totals
    from public.organizations o
    join public.org_units u
      on u.org_id = o.id and u.id = p_unit_id and u.unit_type = 'legal_entity'
    join public.profiles creator
      on creator.org_id = o.id and creator.id = v_user and creator.active
    cross join invoice_data invoices
    cross join payment_data payments
    cross join credit_data credits
    cross join exception_data exceptions
    cross join bank_data bank
    where o.id = v_org
  )
  insert into public.monthly_report_snapshots (
    org_id, unit_id, report_month, version, report_version,
    organization_name, legal_entity_name, created_by, created_by_name, created_at,
    invoice_rows, payment_rows, credit_rows, exception_rows, bank_rows,
    totals, content_hash
  )
  select
    v_org,
    p_unit_id,
    p_month,
    coalesce((
      select max(existing.version)
      from public.monthly_report_snapshots existing
      where existing.org_id = v_org
        and existing.unit_id = p_unit_id
        and existing.report_month = p_month
    ), 0) + 1,
    'monthly-accountant-legal-entity-v1',
    assembled.organization_name,
    assembled.legal_entity_name,
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
      'report_version', 'monthly-accountant-legal-entity-v1',
      'organization_id', v_org,
      'organization_name', assembled.organization_name,
      'legal_entity_id', p_unit_id,
      'legal_entity_name', assembled.legal_entity_name,
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
      'unit_id', v_snapshot.unit_id,
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

revoke all on function public.create_monthly_report_snapshot(date, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_monthly_report_snapshot(date, uuid) to authenticated;

-- Audit fan-out is in the same transaction as the command. Payload stays allowlisted; the
-- stored ledgers never leave the immutable table through the integration event.
insert into private.domain_event_map
  (action, entity_type, event_type, schema_version, match_new, payload_keys)
values (
  'monthly_report_snapshot_created',
  'monthly_report_snapshots',
  'monthly_report.snapshot_created',
  1,
  null,
  array['snapshot_id', 'unit_id', 'report_month', 'version', 'report_version', 'content_hash']
);

-- A1 + A3: legal-entity ownership is structural, tenant-composite and enforced now.
insert into private.scope_registry (table_name, scope_class, enforced)
values ('monthly_report_snapshots', 'legal_entity', true);

-- Re-run the reusable enterprise assertions. This is a static migration gate; runtime RLS,
-- concurrency and export acceptance remain separate tests.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0074 scope enforcement assertions failed:\n%', v_violations;
  end if;
end
$$;
