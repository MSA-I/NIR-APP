-- Immutable, versioned monthly accountant snapshots, scoped to one legal entity.
--
-- Depends on 0073_payment_credit_override.sql for the canonical supplier-aware
-- private.credit_request_legal_entity resolver.
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
  report_version text not null default 'monthly-accountant-legal-entity-v2',
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
  constraint monthly_report_snapshots_org_unit_id_key
    unique (org_id, unit_id, id),
  constraint monthly_report_snapshots_org_unit_month_version_key
    unique (org_id, unit_id, report_month, version)
);

create index monthly_report_snapshots_org_unit_month_idx
  on public.monthly_report_snapshots (org_id, unit_id, report_month, version desc);

comment on table public.monthly_report_snapshots is
  'Immutable final accountant reports. Each version belongs to exactly one legal entity; stored JSONB ledgers and totals are the authoritative export source.';
comment on column public.monthly_report_snapshots.content_hash is
  'SHA-256 over the report schema, tenant/legal-entity identity, month, stored ledgers and totals.';
comment on column public.monthly_report_snapshots.report_version is
  'Workbook contract. v2 freezes enum-derived display labels inside each stored JSONB row; exporters must not consult live label maps.';

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

-- Delivery is a separate immutable fact. The legacy monthly_exports ledger remains untouched
-- for historical compatibility, but the tenant UI no longer marks a live org-wide invoice
-- query as sent. Each delivery now names the exact locked legal-entity version that was sent.
create table public.monthly_report_snapshot_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  unit_id uuid not null,
  snapshot_id uuid not null,
  report_month date not null,
  snapshot_version integer not null check (snapshot_version > 0),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  sent_by uuid not null,
  sent_by_name text not null,
  sent_at timestamptz not null default now(),
  reason text not null check (nullif(btrim(reason), '') is not null),
  constraint monthly_report_snapshot_deliveries_snapshot_key unique (snapshot_id),
  constraint monthly_report_snapshot_deliveries_snapshot_fk
    foreign key (org_id, unit_id, snapshot_id)
      references public.monthly_report_snapshots(org_id, unit_id, id) on delete restrict,
  constraint monthly_report_snapshot_deliveries_org_unit_fk
    foreign key (org_id, unit_id) references public.org_units(org_id, id) on delete restrict,
  constraint monthly_report_snapshot_deliveries_org_actor_fk
    foreign key (org_id, sent_by) references public.profiles(org_id, id) on delete restrict
);

create index monthly_report_snapshot_deliveries_org_unit_month_idx
  on public.monthly_report_snapshot_deliveries (org_id, unit_id, report_month, snapshot_version desc);

comment on table public.monthly_report_snapshot_deliveries is
  'Immutable evidence that one exact locked accountant snapshot version was sent. Legacy monthly_exports rows are preserved but are not a source for this command.';

alter table public.monthly_report_snapshot_deliveries enable row level security;
alter table public.monthly_report_snapshot_deliveries force row level security;

create policy monthly_report_snapshot_deliveries_select
  on public.monthly_report_snapshot_deliveries
  for select to authenticated
  using (org_id = auth_org() and auth_role() in ('owner', 'accountant'));

create policy scope_rider_monthly_report_snapshot_deliveries
  on public.monthly_report_snapshot_deliveries as restrictive for all to public
  using ((unit_id is null) or (unit_id = any (auth_scopes())));

revoke all on table public.monthly_report_snapshot_deliveries
  from public, anon, authenticated, service_role;
grant select on table public.monthly_report_snapshot_deliveries to authenticated;
grant select, insert, update, delete on table public.monthly_report_snapshot_deliveries to service_role;

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

create trigger monthly_report_snapshot_deliveries_immutable
  before update or delete on public.monthly_report_snapshot_deliveries
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
  -- A final accountant artifact is a sensitive financial export. The UI mirrors this with
  -- ReauthModal, but the trusted command remains the enforcement boundary.
  perform public.assert_recent_password_authentication();

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
  with
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
  ),
  payment_request_scope as materialized (
    select pr.id, pr.supplier_id,
           coalesce(array_agg(distinct i.unit_id)
             filter (where iu.unit_type = 'legal_entity'), '{}') as legal_entity_ids,
           count(pri.invoice_id)::integer as source_count,
           count(i.id) filter (where iu.unit_type = 'legal_entity')::integer
             as resolved_source_count
    from public.payment_requests pr
    left join public.payment_request_invoices pri
      on pri.org_id = pr.org_id and pri.payment_request_id = pr.id
    left join public.invoices i
      on i.org_id = pri.org_id
     and i.id = pri.invoice_id
     and i.supplier_id = pr.supplier_id
     and i.deleted_at is null
    left join public.org_units iu
      on iu.org_id = i.org_id and iu.id = i.unit_id
    where pr.org_id = v_org
    group by pr.id
  ),
  -- 0056 populated payments.unit_id from a dimension default, so it is never an
  -- authoritative accounting attribution. Resolve every payment from its allocations and/or
  -- linked payment request, verify supplier consistency and fail closed on a missing or mixed
  -- legal-entity result.
  payment_scope as materialized (
    select p.id,
           coalesce(array_agg(distinct candidate.legal_entity_id)
             filter (where candidate.legal_entity_id is not null), '{}') as legal_entity_ids,
           ((select count(*) from public.payment_allocations expected
             where expected.org_id = p.org_id and expected.payment_id = p.id)
             + (p.payment_request_id is not null)::integer)::integer as source_count,
           count(candidate.legal_entity_id)::integer as resolved_source_count
    from public.payments p
    left join lateral (
      select case when iu.unit_type = 'legal_entity' then i.unit_id end as legal_entity_id
      from public.payment_allocations pa
      left join public.invoices i
        on i.org_id = pa.org_id
       and i.id = pa.invoice_id
       and i.supplier_id = p.supplier_id
       and i.deleted_at is null
      left join public.org_units iu
        on iu.org_id = i.org_id and iu.id = i.unit_id
      where pa.org_id = p.org_id and pa.payment_id = p.id and pa.invoice_id is not null
      union all
      select case when c.id is not null
                  then private.credit_request_legal_entity(c.id, c.org_id) end
      from public.payment_allocations pa
      left join public.credit_requests c
        on c.org_id = pa.org_id
       and c.id = pa.credit_id
       and c.supplier_id = p.supplier_id
      where pa.org_id = p.org_id and pa.payment_id = p.id and pa.credit_id is not null
      union all
      select prs.legal_entity_ids[1]
      from payment_request_scope prs
      where prs.id = p.payment_request_id
        and prs.supplier_id = p.supplier_id
        and prs.source_count > 0
        and prs.resolved_source_count = prs.source_count
        and cardinality(prs.legal_entity_ids) = 1
    ) candidate on true
    where p.org_id = v_org
    group by p.id
  ),
  payment_source as materialized (
    select p.*, s.name as supplier_name,
           case when ps.source_count > 0
                  and ps.resolved_source_count = ps.source_count
                  and cardinality(ps.legal_entity_ids) = 1
                then ps.legal_entity_ids[1] end as legal_entity_id,
           ps.source_count, ps.resolved_source_count, ps.legal_entity_ids
    from public.payments p
    join public.suppliers s on s.org_id = p.org_id and s.id = p.supplier_id
    left join payment_scope ps on ps.id = p.id
    where p.org_id = v_org
      and p.paid_date >= p_month
      and p.paid_date < (p_month + interval '1 month')::date
  ),
  credit_source as materialized (
    select c.*, s.name as supplier_name,
           private.credit_request_legal_entity(c.id, c.org_id) as legal_entity_id
    from public.credit_requests c
    join public.suppliers s on s.org_id = c.org_id and s.id = c.supplier_id
    where c.org_id = v_org
      and (c.created_at at time zone 'Asia/Jerusalem')::date >= p_month
      and (c.created_at at time zone 'Asia/Jerusalem')::date
            < (p_month + interval '1 month')::date
  ),
  -- bank_transactions has no legal-entity pointer by design. Every transaction in the month
  -- must therefore have confirmed allocations whose invoice/payment anchors all resolve to one
  -- legal entity. Unmatched or merely suggested rows block finalization instead of becoming an
  -- impossible "unmatched within this entity" metric.
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
      select ps.legal_entity_ids[1]
      from payment_scope ps
      where ps.id = ba.payment_id
        and ps.source_count > 0
        and ps.resolved_source_count = ps.source_count
        and cardinality(ps.legal_entity_ids) = 1
    ) candidate on true
    group by b.id, b.org_id, b.import_id, b.tx_date, b.description, b.amount,
             b.is_debit, b.reference, b.raw, b.supplier_id, b.status, b.row_hash
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
      select ps.legal_entity_ids[1]
      from payment_scope ps
      where ps.id = e.payment_id
        and ps.source_count > 0
        and ps.resolved_source_count = ps.source_count
        and cardinality(ps.legal_entity_ids) = 1
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
      (select count(*) from credit_source where legal_entity_id is null),
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
        'review_status_label', case i.review_status::text
          when 'received' then 'התקבלה'
          when 'in_review' then 'בבדיקה'
          when 'pending_approval' then 'ממתינה לאישור'
          when 'approved' then 'מאושרת'
          when 'investigation' then 'דורשת בירור'
          else i.review_status::text end,
        'payment_status', i.payment_status,
        'payment_status_label', case i.payment_status::text
          when 'unpaid' then 'לא שולמה'
          when 'partial' then 'שולמה חלקית'
          when 'paid' then 'שולמה'
          else i.payment_status::text end
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
        'reason_label', case c.reason::text
          when 'missing' then 'חוסר בסחורה'
          when 'damaged' then 'סחורה פגומה'
          when 'returned' then 'החזרת סחורה'
          when 'wrong_price' then 'טעות מחיר'
          when 'duplicate_charge' then 'חיוב כפול'
          when 'other' then 'אחר'
          else c.reason::text end,
        'amount', c.amount,
        'status', c.status,
        'status_label', case c.status::text
          when 'open' then 'פתוח'
          when 'requested' then 'נדרש מהספק'
          when 'received' then 'התקבל'
          when 'offset' then 'קוזז בתשלום'
          when 'closed' then 'נסגר'
          else c.status::text end
      ) order by c.created_at, c.id), '[]'::jsonb) as rows,
      count(*)::integer as row_count,
      coalesce(sum(c.amount), 0)::numeric(12,2) as credit_total
    from credit_source c
    cross join validation v
    where v.valid and c.legal_entity_id = p_unit_id
  ),
  exception_data as materialized (
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id,
        'type', e.type,
        'type_label', case e.type::text
          when 'payment_without_invoice' then 'תשלום ללא חשבונית'
          when 'invoice_without_payment' then 'חשבונית ללא תשלום'
          when 'amount_mismatch' then 'אי-התאמת סכומים'
          when 'duplicate_payment' then 'חשד לתשלום כפול'
          when 'duplicate_invoice' then 'חשד לחשבונית כפולה'
          when 'unknown_supplier' then 'ספק לא מזוהה'
          when 'unmatched_bank' then 'תנועת בנק לא מותאמת'
          when 'credit_not_deducted' then 'זיכוי שלא קוזז'
          when 'receipt_mismatch' then 'פער קבלה מול חשבונית'
          else e.type::text end,
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
        'direction_label', case when b.is_debit then 'חיוב' else 'זיכוי' end,
        'reference', b.reference,
        'status', b.status,
        'status_label', case b.status::text
          when 'unmatched' then 'לא מותאמת'
          when 'suggested' then 'הצעת התאמה'
          when 'matched' then 'מותאמת'
          when 'ignored' then 'לא רלוונטית'
          else b.status::text end
      ) order by b.tx_date, b.id), '[]'::jsonb) as rows,
      count(*)::integer as row_count,
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
        'unpaid_invoice_count', invoices.unpaid_count
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
    'monthly-accountant-legal-entity-v2',
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
      'report_version', 'monthly-accountant-legal-entity-v2',
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

create function public.mark_monthly_report_snapshot_sent(p_snapshot_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(btrim(p_reason), '');
  v_snapshot public.monthly_report_snapshots;
  v_delivery public.monthly_report_snapshot_deliveries;
  v_actor_name text;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'accountant') then
    raise exception 'monthly_report_snapshot_delivery_not_authorized' using errcode = '42501';
  end if;
  if p_snapshot_id is null or v_reason is null then
    raise exception 'monthly_report_snapshot_delivery_invalid' using errcode = '22023';
  end if;

  -- The immutable snapshot row is also the serialization lock. Two replays cannot create two
  -- delivery/audit facts, and no live invoices are consulted by this command.
  select * into v_snapshot
  from public.monthly_report_snapshots snapshot
  where snapshot.org_id = v_org and snapshot.id = p_snapshot_id
  for update;

  if not found then
    raise exception 'monthly_report_snapshot_delivery_unknown' using errcode = 'P0002';
  end if;
  perform public.assert_unit_in_scope(v_snapshot.unit_id);
  perform public.assert_recent_password_authentication();

  select * into v_delivery
  from public.monthly_report_snapshot_deliveries delivery
  where delivery.org_id = v_org and delivery.snapshot_id = v_snapshot.id
  for update;

  if found then
    if v_delivery.reason <> v_reason then
      raise exception 'monthly_report_snapshot_delivery_replay_conflict' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'delivery_id', v_delivery.id,
      'snapshot_id', v_delivery.snapshot_id,
      'sent_at', v_delivery.sent_at,
      'idempotent', true
    );
  end if;

  select profile.full_name into v_actor_name
  from public.profiles profile
  where profile.org_id = v_org and profile.id = v_user and profile.active;

  if v_actor_name is null then
    raise exception 'monthly_report_snapshot_delivery_not_authorized' using errcode = '42501';
  end if;

  insert into public.monthly_report_snapshot_deliveries (
    org_id, unit_id, snapshot_id, report_month, snapshot_version, content_hash,
    sent_by, sent_by_name, reason
  ) values (
    v_org, v_snapshot.unit_id, v_snapshot.id, v_snapshot.report_month, v_snapshot.version,
    v_snapshot.content_hash, v_user, v_actor_name, v_reason
  ) returning * into v_delivery;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org,
    v_user,
    'monthly_report_snapshot_sent',
    'monthly_report_snapshot_deliveries',
    v_delivery.id,
    jsonb_build_object(
      'delivery_id', v_delivery.id,
      'snapshot_id', v_delivery.snapshot_id,
      'unit_id', v_delivery.unit_id,
      'report_month', v_delivery.report_month,
      'version', v_delivery.snapshot_version,
      'content_hash', v_delivery.content_hash,
      'sent_by', v_delivery.sent_by,
      'sent_at', v_delivery.sent_at
    ),
    v_reason
  );

  return jsonb_build_object(
    'delivery_id', v_delivery.id,
    'snapshot_id', v_delivery.snapshot_id,
    'sent_at', v_delivery.sent_at,
    'idempotent', false
  );
end
$$;

revoke all on function public.mark_monthly_report_snapshot_sent(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_monthly_report_snapshot_sent(uuid, text) to authenticated;

-- Audit fan-out is in the same transaction as the command. Payload stays allowlisted; the
-- stored ledgers never leave the immutable table through the integration event.
insert into private.domain_event_map
  (action, entity_type, event_type, schema_version, match_new, payload_keys)
values
  (
    'monthly_report_snapshot_created',
    'monthly_report_snapshots',
    'monthly_report.snapshot_created',
    1,
    null,
    array['snapshot_id', 'unit_id', 'report_month', 'version', 'report_version', 'content_hash']
  ),
  (
    'monthly_report_snapshot_sent',
    'monthly_report_snapshot_deliveries',
    'monthly_report.snapshot_sent',
    1,
    null,
    array['delivery_id', 'snapshot_id', 'unit_id', 'report_month', 'version', 'content_hash', 'sent_by']
  );

-- A1 + A3: legal-entity ownership is structural, tenant-composite and enforced now.
insert into private.scope_registry (table_name, scope_class, enforced)
values
  ('monthly_report_snapshots', 'legal_entity', true),
  ('monthly_report_snapshot_deliveries', 'legal_entity', true);

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
