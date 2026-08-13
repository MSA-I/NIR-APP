-- 0136 -- One supplier, one legal entity, one calendar month, one payable anchor.
--
-- A consolidated supplier invoice is a business role, not an OCR document kind. Source bytes
-- therefore remain ordinary `documents.document_kind = 'invoice'`, while this migration adds a
-- database-authoritative intake/case/revision ledger and makes `invoices.financial_role` the
-- accounting boundary. Only `payable` invoices may affect balances, payments, reports or expense
-- metrics. Interim invoices become `supporting_evidence` only when no irreversible financial
-- footprint exists; the conversion is otherwise refused rather than silently rewriting history.

-- ===== 1. Financial role and the no-double-payable boundary =====

alter table public.invoices
  add column financial_role text not null default 'payable',
  add constraint invoices_financial_role_check
    check (financial_role in ('payable', 'supporting_evidence'));

-- The explicit update documents the backfill contract even though ADD COLUMN DEFAULT already
-- materialises `payable` for existing rows on supported PostgreSQL versions.
update public.invoices set financial_role = 'payable' where financial_role is null;

create index invoices_org_payable_supplier_date_idx
  on public.invoices (org_id, supplier_id, unit_id, invoice_date, id)
  where deleted_at is null and financial_role = 'payable';

create index invoices_org_supporting_supplier_date_idx
  on public.invoices (org_id, supplier_id, unit_id, invoice_date, id)
  where deleted_at is null and financial_role = 'supporting_evidence';

create or replace function private.assert_invoice_supporting_conversion(p_invoice_id uuid)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_invoice public.invoices;
begin
  select * into v_invoice
  from public.invoices i
  where i.id = p_invoice_id and i.deleted_at is null;
  if not found then
    raise exception 'consolidated_source_invoice_unknown' using errcode = 'P0002';
  end if;

  if v_invoice.payment_status <> 'unpaid'
     or v_invoice.review_status = 'approved'
     or v_invoice.export_status = 'sent'
     or exists (select 1 from public.payment_allocations a where a.invoice_id = v_invoice.id)
     or exists (select 1 from public.payment_request_invoices a where a.invoice_id = v_invoice.id)
     or exists (select 1 from public.bank_allocations a where a.invoice_id = v_invoice.id)
     or exists (select 1 from public.credit_requests c where c.invoice_id = v_invoice.id)
     or exists (
       select 1 from public.invoice_three_way_approval_snapshots s
       where s.org_id = v_invoice.org_id and s.invoice_id = v_invoice.id
     )
     or exists (
       select 1 from public.monthly_report_snapshots s
       where s.org_id = v_invoice.org_id
         and s.invoice_rows @> jsonb_build_array(jsonb_build_object('id', v_invoice.id))
     ) then
    raise exception 'consolidated_payable_conflict' using errcode = '55000';
  end if;
end
$$;

revoke all on function private.assert_invoice_supporting_conversion(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.guard_invoice_financial_role()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_case_anchor uuid;
begin
  if tg_op = 'UPDATE' and new.financial_role is distinct from old.financial_role then
    if current_setting('app.consolidated_financial_role_writer', true)
         is distinct from old.id::text then
      raise exception 'invoice_financial_role_rpc_required' using errcode = '42501';
    end if;
    if old.financial_role = 'payable' and new.financial_role = 'supporting_evidence' then
      perform private.assert_invoice_supporting_conversion(old.id);
    end if;
  end if;

  -- Once a case has an anchor, a newly received ordinary invoice for the same tuple is evidence,
  -- not a second debt. INSERT is still reversible at this point and has no payment/snapshot
  -- footprint. The late-arrival trigger below records the decision and opens a new revision.
  if tg_op = 'INSERT' and new.financial_role = 'payable' and new.unit_id is not null then
    select c.anchor_invoice_id into v_case_anchor
    from public.consolidated_invoice_cases c
    where c.org_id = new.org_id
      and c.legal_entity_id = new.unit_id
      and c.supplier_id = new.supplier_id
      and c.target_month = date_trunc('month', new.invoice_date)::date
      and c.anchor_invoice_id is not null;
    if found and new.id is distinct from v_case_anchor then
      new.financial_role := 'supporting_evidence';
    end if;
  end if;

  if new.financial_role = 'payable' and new.unit_id is not null then
    select c.anchor_invoice_id into v_case_anchor
    from public.consolidated_invoice_cases c
    where c.org_id = new.org_id
      and c.legal_entity_id = new.unit_id
      and c.supplier_id = new.supplier_id
      and c.target_month = date_trunc('month', new.invoice_date)::date
      and c.anchor_invoice_id is not null;
    if found and new.id is distinct from v_case_anchor then
      raise exception 'consolidated_payable_conflict' using errcode = '55000';
    end if;
  end if;
  return new;
end
$$;

revoke all on function public.guard_invoice_financial_role()
  from public, anon, authenticated, service_role;

-- Installed after the case table is created below.

-- A supporting invoice can never become a downstream money target, even through a future command
-- that forgets to repeat the role predicate. Existing references are checked before conversion.
create or replace function public.guard_payable_invoice_reference()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice_id uuid := case tg_table_name
    when 'payment_request_invoices' then new.invoice_id
    when 'payment_allocations' then new.invoice_id
    when 'bank_allocations' then new.invoice_id
    when 'credit_requests' then new.invoice_id
  end;
begin
  if v_invoice_id is not null and not exists (
    select 1 from public.invoices i
    where i.id = v_invoice_id and i.deleted_at is null and i.financial_role = 'payable'
  ) then
    raise exception 'invoice_not_payable' using errcode = '55000';
  end if;
  return new;
end
$$;

revoke all on function public.guard_payable_invoice_reference()
  from public, anon, authenticated, service_role;

create trigger payment_request_invoices_payable_guard
  before insert or update of invoice_id on public.payment_request_invoices
  for each row execute function public.guard_payable_invoice_reference();
create trigger payment_allocations_payable_guard
  before insert or update of invoice_id on public.payment_allocations
  for each row execute function public.guard_payable_invoice_reference();
create trigger bank_allocations_payable_guard
  before insert or update of invoice_id on public.bank_allocations
  for each row execute function public.guard_payable_invoice_reference();
create trigger credit_requests_payable_guard
  before insert or update of invoice_id on public.credit_requests
  for each row execute function public.guard_payable_invoice_reference();

-- ===== 2. Case, intake, source and immutable revision ledgers =====

create table public.consolidated_invoice_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  legal_entity_id uuid not null,
  supplier_id uuid not null,
  target_month date not null,
  status text not null default 'awaiting_anchor' check (
    status in ('awaiting_anchor','reconciling','matched','warnings','blocked')
  ),
  anchor_invoice_id uuid,
  current_revision integer not null default 0 check (current_revision >= 0),
  warning_count integer not null default 0 check (warning_count >= 0),
  created_by uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint consolidated_invoice_cases_month_check
    check (target_month = date_trunc('month', target_month)::date),
  constraint consolidated_invoice_cases_org_id_id_key unique (org_id, id),
  constraint consolidated_invoice_cases_business_key
    unique (org_id, legal_entity_id, supplier_id, target_month),
  constraint consolidated_invoice_cases_legal_entity_fk
    foreign key (org_id, legal_entity_id)
      references public.org_units(org_id, id) on delete restrict,
  constraint consolidated_invoice_cases_supplier_fk
    foreign key (org_id, supplier_id)
      references public.suppliers(org_id, id) on delete restrict,
  constraint consolidated_invoice_cases_anchor_fk
    foreign key (org_id, anchor_invoice_id)
      references public.invoices(org_id, id) on delete restrict,
  constraint consolidated_invoice_cases_actor_fk
    foreign key (org_id, created_by)
      references public.profiles(org_id, id) on delete restrict
);

create index consolidated_invoice_cases_org_month_idx
  on public.consolidated_invoice_cases (org_id, target_month desc, updated_at desc, id);

-- The trigger can now resolve the case table without relying on migration statement ordering.
create trigger invoices_financial_role_guard
  before insert or update of financial_role, org_id, unit_id, supplier_id, invoice_date
  on public.invoices
  for each row execute function public.guard_invoice_financial_role();

create table public.consolidated_invoice_intakes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  idempotency_key uuid not null,
  completion_idempotency_key uuid,
  processing_mode text not null default 'consolidated_supplier_invoice'
    check (processing_mode = 'consolidated_supplier_invoice'),
  source_page_count integer not null check (source_page_count between 1 and 50),
  primary_document_id uuid,
  interpretation_id uuid,
  invoice_id uuid,
  status text not null default 'uploading'
    check (status in ('uploading','ready','received','blocked')),
  outcome text,
  reason_code text,
  result jsonb,
  created_by uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  received_at timestamptz,
  constraint consolidated_invoice_intakes_org_id_id_key unique (org_id, id),
  constraint consolidated_invoice_intakes_idempotency_key unique (org_id, idempotency_key),
  constraint consolidated_invoice_intakes_case_fk
    foreign key (org_id, case_id)
      references public.consolidated_invoice_cases(org_id, id) on delete restrict,
  constraint consolidated_invoice_intakes_document_fk
    foreign key (org_id, primary_document_id)
      references public.documents(org_id, id) on delete restrict,
  constraint consolidated_invoice_intakes_interpretation_fk
    foreign key (org_id, interpretation_id)
      references public.document_interpretations(org_id, id) on delete restrict,
  constraint consolidated_invoice_intakes_invoice_fk
    foreign key (org_id, invoice_id)
      references public.invoices(org_id, id) on delete restrict,
  constraint consolidated_invoice_intakes_actor_fk
    foreign key (org_id, created_by)
      references public.profiles(org_id, id) on delete restrict,
  constraint consolidated_invoice_intakes_completion_shape check (
    (status = 'uploading' and completed_at is null)
    or (status in ('ready','received','blocked') and completed_at is not null)
  )
);

create unique index consolidated_invoice_one_open_intake_idx
  on public.consolidated_invoice_intakes (org_id, case_id)
  where status in ('uploading','ready');

create table public.consolidated_invoice_intake_pages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  intake_id uuid not null,
  page_number integer not null check (page_number between 1 and 50),
  client_upload_key text not null check (
    client_upload_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,199}$'
  ),
  document_id uuid not null,
  storage_path text not null,
  source_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_metadata) = 'object'),
  created_at timestamptz not null default statement_timestamp(),
  constraint consolidated_invoice_intake_pages_org_id_id_key unique (org_id, id),
  constraint consolidated_invoice_intake_pages_number_key unique (org_id, intake_id, page_number),
  constraint consolidated_invoice_intake_pages_upload_key unique (org_id, client_upload_key),
  constraint consolidated_invoice_intake_pages_document_key unique (org_id, document_id),
  constraint consolidated_invoice_intake_pages_intake_fk
    foreign key (org_id, intake_id)
      references public.consolidated_invoice_intakes(org_id, id) on delete restrict,
  constraint consolidated_invoice_intake_pages_document_fk
    foreign key (org_id, document_id)
      references public.documents(org_id, id) on delete restrict
);

create table public.consolidated_invoice_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  source_type text not null check (
    source_type in ('interim_invoice','goods_receipt','supporting_document')
  ),
  invoice_id uuid,
  receipt_id uuid,
  document_id uuid,
  source_date date not null,
  late_arrival boolean not null default false,
  created_at timestamptz not null default statement_timestamp(),
  constraint consolidated_invoice_sources_org_id_id_key unique (org_id, id),
  constraint consolidated_invoice_sources_shape check (
    (source_type = 'interim_invoice' and invoice_id is not null and receipt_id is null)
    or (source_type = 'goods_receipt' and invoice_id is null and receipt_id is not null)
    or (source_type = 'supporting_document' and invoice_id is null
      and receipt_id is null and document_id is not null)
  ),
  constraint consolidated_invoice_sources_case_fk
    foreign key (org_id, case_id)
      references public.consolidated_invoice_cases(org_id, id) on delete restrict,
  constraint consolidated_invoice_sources_invoice_fk
    foreign key (org_id, invoice_id)
      references public.invoices(org_id, id) on delete restrict,
  constraint consolidated_invoice_sources_receipt_fk
    foreign key (org_id, receipt_id)
      references public.goods_receipts(org_id, id) on delete restrict,
  constraint consolidated_invoice_sources_document_fk
    foreign key (org_id, document_id)
      references public.documents(org_id, id) on delete restrict
);

create unique index consolidated_invoice_sources_invoice_key
  on public.consolidated_invoice_sources (org_id, case_id, invoice_id)
  where invoice_id is not null;
create unique index consolidated_invoice_sources_receipt_key
  on public.consolidated_invoice_sources (org_id, case_id, receipt_id)
  where receipt_id is not null;
create unique index consolidated_invoice_sources_document_key
  on public.consolidated_invoice_sources (org_id, document_id)
  where document_id is not null;

create table public.consolidated_invoice_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  revision integer not null check (revision > 0),
  idempotency_key text not null check (length(idempotency_key) between 8 and 300),
  trigger_kind text not null check (trigger_kind in ('anchor_received','late_arrival','manual_refresh')),
  source_type text,
  source_id uuid,
  created_by uuid,
  created_at timestamptz not null default statement_timestamp(),
  constraint consolidated_invoice_revisions_org_id_id_key unique (org_id, id),
  constraint consolidated_invoice_revisions_number_key unique (org_id, case_id, revision),
  constraint consolidated_invoice_revisions_idempotency_key unique (org_id, case_id, idempotency_key),
  constraint consolidated_invoice_revisions_case_fk
    foreign key (org_id, case_id)
      references public.consolidated_invoice_cases(org_id, id) on delete restrict,
  constraint consolidated_invoice_revisions_actor_fk
    foreign key (org_id, created_by)
      references public.profiles(org_id, id) on delete restrict
);

create table public.consolidated_invoice_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  revision_id uuid not null,
  revision integer not null check (revision > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  warning_count integer not null check (warning_count >= 0),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default statement_timestamp(),
  constraint consolidated_invoice_snapshots_org_id_id_key unique (org_id, id),
  constraint consolidated_invoice_snapshots_revision_key unique (org_id, revision_id),
  constraint consolidated_invoice_snapshots_case_revision_key unique (org_id, case_id, revision),
  constraint consolidated_invoice_snapshots_case_fk
    foreign key (org_id, case_id)
      references public.consolidated_invoice_cases(org_id, id) on delete restrict,
  constraint consolidated_invoice_snapshots_revision_fk
    foreign key (org_id, revision_id)
      references public.consolidated_invoice_revisions(org_id, id) on delete restrict
);

-- ===== 3. RLS, FORCE RLS, RPC-only DML and immutable evidence =====

alter table public.consolidated_invoice_cases enable row level security;
alter table public.consolidated_invoice_cases force row level security;
alter table public.consolidated_invoice_intakes enable row level security;
alter table public.consolidated_invoice_intakes force row level security;
alter table public.consolidated_invoice_intake_pages enable row level security;
alter table public.consolidated_invoice_intake_pages force row level security;
alter table public.consolidated_invoice_sources enable row level security;
alter table public.consolidated_invoice_sources force row level security;
alter table public.consolidated_invoice_revisions enable row level security;
alter table public.consolidated_invoice_revisions force row level security;
alter table public.consolidated_invoice_snapshots enable row level security;
alter table public.consolidated_invoice_snapshots force row level security;

-- These ledgers are RPC-only for authenticated clients. FORCE RLS plus no permissive table policy
-- keeps an accidental future column grant fail-closed; the read models below re-check tenant,
-- active role and legal-entity scope inside SECURITY DEFINER commands.

-- Accountants can open only source bytes that belong to a received/blocked consolidated intake
-- or to a case whose anchor was received. Existing owner/office document policies remain intact.
-- Keep the joins behind a definer helper: authenticated deliberately has no direct table grant on
-- the consolidated ledgers, and PostgreSQL can permission-check every OR policy branch even when
-- the caller is owner/office and the accountant role predicate is false.
create or replace function private.can_read_consolidated_invoice_document(
  p_org_id uuid,
  p_document_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select p_org_id=public.auth_org() and public.auth_role()='accountant' and (
    exists (
      select 1
      from public.consolidated_invoice_intake_pages page
      join public.consolidated_invoice_intakes intake
        on intake.org_id=page.org_id and intake.id=page.intake_id
      join public.consolidated_invoice_cases c
        on c.org_id=intake.org_id and c.id=intake.case_id
      where page.org_id=p_org_id and page.document_id=p_document_id
        and intake.status in ('received','blocked')
        and c.legal_entity_id=any(public.auth_scopes())
    )
    or exists (
      select 1
      from public.consolidated_invoice_sources source
      join public.consolidated_invoice_cases c
        on c.org_id=source.org_id and c.id=source.case_id
      where source.org_id=p_org_id and source.document_id=p_document_id
        and c.anchor_invoice_id is not null
        and c.legal_entity_id=any(public.auth_scopes())
    )
  )
$$;

revoke all on function private.can_read_consolidated_invoice_document(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.can_read_consolidated_invoice_document(uuid,uuid)
  to authenticated;

create policy consolidated_invoice_documents_select on public.documents
  for select to authenticated using (
    private.can_read_consolidated_invoice_document(documents.org_id,documents.id)
  );

create policy consolidated_invoice_storage_read on storage.objects
  for select to authenticated using (
    bucket_id='documents' and auth_role()='accountant' and exists (
      select 1 from public.documents document
      where document.org_id=auth_org() and document.storage_path=storage.objects.name
        and private.can_read_consolidated_invoice_document(document.org_id,document.id)
    )
  );

revoke all on table public.consolidated_invoice_cases,
  public.consolidated_invoice_intakes,
  public.consolidated_invoice_intake_pages,
  public.consolidated_invoice_sources,
  public.consolidated_invoice_revisions,
  public.consolidated_invoice_snapshots
  from public, anon, authenticated, service_role;

-- Preserve the P0 trusted-server CRUD contract. Direct writes still fail closed below unless a
-- purpose-built command sets the transaction-local latch; authenticated keeps no table grant.
grant select, insert, update, delete on table public.consolidated_invoice_cases,
  public.consolidated_invoice_intakes,
  public.consolidated_invoice_intake_pages,
  public.consolidated_invoice_sources,
  public.consolidated_invoice_revisions,
  public.consolidated_invoice_snapshots
  to service_role;

-- Purpose-built commands set a transaction-local latch; revision/snapshot history is append-only
-- even for a trusted role that retains the repository-wide service_role CRUD grant.
create or replace function public.consolidated_invoice_ledger_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_setting('app.consolidated_invoice_writer', true) is distinct from '0136' then
    raise exception 'consolidated_invoice_rpc_required' using errcode = '42501';
  end if;
  if tg_table_name in ('consolidated_invoice_revisions','consolidated_invoice_snapshots')
     and tg_op <> 'INSERT' then
    raise exception 'consolidated_invoice_evidence_immutable' using errcode = '42501';
  end if;
  if tg_table_name in ('consolidated_invoice_intake_pages','consolidated_invoice_sources')
     and tg_op in ('UPDATE','DELETE') then
    raise exception 'consolidated_invoice_evidence_immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

revoke all on function public.consolidated_invoice_ledger_guard()
  from public, anon, authenticated, service_role;

create trigger consolidated_invoice_cases_command_guard
  before insert or update or delete on public.consolidated_invoice_cases
  for each row execute function public.consolidated_invoice_ledger_guard();
create trigger consolidated_invoice_intakes_command_guard
  before insert or update or delete on public.consolidated_invoice_intakes
  for each row execute function public.consolidated_invoice_ledger_guard();
create trigger consolidated_invoice_intake_pages_command_guard
  before insert or update or delete on public.consolidated_invoice_intake_pages
  for each row execute function public.consolidated_invoice_ledger_guard();
create trigger consolidated_invoice_sources_command_guard
  before insert or update or delete on public.consolidated_invoice_sources
  for each row execute function public.consolidated_invoice_ledger_guard();
create trigger consolidated_invoice_revisions_command_guard
  before insert or update or delete on public.consolidated_invoice_revisions
  for each row execute function public.consolidated_invoice_ledger_guard();
create trigger consolidated_invoice_snapshots_command_guard
  before insert or update or delete on public.consolidated_invoice_snapshots
  for each row execute function public.consolidated_invoice_ledger_guard();

create trigger zz_organization_write_guard before insert or update or delete
  on public.consolidated_invoice_cases for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.consolidated_invoice_intakes for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.consolidated_invoice_intake_pages for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.consolidated_invoice_sources for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.consolidated_invoice_revisions for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.consolidated_invoice_snapshots for each row
  execute function private.organization_row_write_guard();

-- ===== 4. Server-authoritative source discovery and the three separate comparisons =====

create or replace function private.consolidated_unit_descends_from(
  p_org_id uuid, p_candidate uuid, p_legal_entity uuid
) returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  with recursive ancestors as (
    select u.id, u.parent_id
    from public.org_units u
    where u.org_id = p_org_id and u.id = p_candidate
    union all
    select parent.id, parent.parent_id
    from public.org_units parent
    join ancestors child on child.parent_id = parent.id
    where parent.org_id = p_org_id
  )
  select exists (select 1 from ancestors where id = p_legal_entity)
$$;

revoke all on function private.consolidated_unit_descends_from(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function private.consolidated_sync_sources(
  p_case_id uuid, p_late_arrival boolean default false
) returns integer
language plpgsql
set search_path = public, private, pg_temp
as $$
declare
  v_case public.consolidated_invoice_cases;
  v_invoice public.invoices;
  v_receipt record;
  v_document_id uuid;
  v_document record;
  v_inserted integer := 0;
begin
  select * into v_case
  from public.consolidated_invoice_cases c
  where c.id = p_case_id
  for update;
  if not found then
    raise exception 'consolidated_case_unknown' using errcode = 'P0002';
  end if;

  for v_invoice in
    select i.*
    from public.invoices i
    where i.org_id = v_case.org_id
      and i.unit_id = v_case.legal_entity_id
      and i.supplier_id = v_case.supplier_id
      and i.invoice_date >= v_case.target_month
      and i.invoice_date < (v_case.target_month + interval '1 month')::date
      and i.deleted_at is null
      and i.id is distinct from v_case.anchor_invoice_id
    order by i.id
    for update
  loop
    if v_invoice.financial_role = 'payable' then
      perform private.assert_invoice_supporting_conversion(v_invoice.id);
      perform set_config('app.consolidated_financial_role_writer', v_invoice.id::text, true);
      update public.invoices
      set financial_role = 'supporting_evidence'
      where id = v_invoice.id;
      perform set_config('app.consolidated_financial_role_writer', '', true);

      insert into public.audit_logs (
        org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
      ) values (
        v_case.org_id, auth.uid(), 'invoice_financial_role_changed', 'invoices', v_invoice.id,
        jsonb_build_object('financial_role','payable'),
        jsonb_build_object('financial_role','supporting_evidence','case_id',v_case.id),
        'חשבונית ביניים הוגדרה כראיה תומכת תחת חשבונית מרכזת'
      );
    end if;

    select d.id into v_document_id
    from public.documents d
    where d.org_id = v_case.org_id and d.deleted_at is null
      and d.entity_type = 'invoice' and d.entity_id = v_invoice.id
    order by d.created_at, d.id limit 1;

    insert into public.consolidated_invoice_sources (
      org_id, case_id, source_type, invoice_id, document_id, source_date, late_arrival
    )
    select v_case.org_id, v_case.id, 'interim_invoice', v_invoice.id,
      case when not exists (
        select 1 from public.consolidated_invoice_sources represented
        where represented.org_id=v_case.org_id and represented.document_id=v_document_id
      ) then v_document_id end,
      v_invoice.invoice_date, p_late_arrival
    where not exists (
      select 1 from public.consolidated_invoice_sources source
      where source.org_id = v_case.org_id and source.case_id = v_case.id
        and source.invoice_id = v_invoice.id
    );
    if found then v_inserted := v_inserted + 1; end if;
  end loop;

  for v_receipt in
    select gr.id, timezone('Asia/Jerusalem', gr.received_at)::date as source_date
    from public.goods_receipts gr
    join public.purchase_orders po
      on po.org_id = gr.org_id and po.id = gr.order_id
    where gr.org_id = v_case.org_id
      and po.supplier_id = v_case.supplier_id
      and timezone('Asia/Jerusalem', gr.received_at)::date >= v_case.target_month
      and timezone('Asia/Jerusalem', gr.received_at)::date
        < (v_case.target_month + interval '1 month')::date
      and private.consolidated_unit_descends_from(
        v_case.org_id, coalesce(gr.unit_id, po.unit_id), v_case.legal_entity_id)
    order by gr.id
  loop
    select d.id into v_document_id
    from public.documents d
    where d.org_id = v_case.org_id and d.deleted_at is null
      and d.entity_type = 'goods_receipt' and d.entity_id = v_receipt.id
    order by d.created_at, d.id limit 1;

    insert into public.consolidated_invoice_sources (
      org_id, case_id, source_type, receipt_id, document_id, source_date, late_arrival
    )
    select v_case.org_id, v_case.id, 'goods_receipt', v_receipt.id,
      case when not exists (
        select 1 from public.consolidated_invoice_sources represented
        where represented.org_id=v_case.org_id and represented.document_id=v_document_id
      ) then v_document_id end,
      v_receipt.source_date, p_late_arrival
    where not exists (
      select 1 from public.consolidated_invoice_sources source
      where source.org_id = v_case.org_id and source.case_id = v_case.id
        and source.receipt_id = v_receipt.id
    );
    if found then v_inserted := v_inserted + 1; end if;
  end loop;

  -- Files already uploaded for this supplier/month remain visible even before a reviewer has
  -- turned them into an invoice or receipt. They are evidence candidates, never financial lines.
  for v_document in
    select d.id, d.document_date as source_date
    from public.documents d
    where d.org_id=v_case.org_id and d.deleted_at is null
      and d.supplier_id=v_case.supplier_id
      and d.document_kind in ('invoice','delivery_note')
      and d.document_date>=v_case.target_month
      and d.document_date<(v_case.target_month+interval '1 month')::date
      and not exists (
        select 1 from public.consolidated_invoice_intake_pages page
        where page.org_id=d.org_id and page.document_id=d.id)
      and not exists (
        select 1 from public.consolidated_invoice_sources represented
        where represented.org_id=d.org_id and represented.document_id=d.id)
    order by d.id
  loop
    insert into public.consolidated_invoice_sources(
      org_id,case_id,source_type,document_id,source_date,late_arrival
    ) values (
      v_case.org_id,v_case.id,'supporting_document',v_document.id,
      v_document.source_date,p_late_arrival
    ) on conflict do nothing;
    if found then v_inserted:=v_inserted+1; end if;
  end loop;

  return v_inserted;
end
$$;

revoke all on function private.consolidated_sync_sources(uuid,boolean)
  from public, anon, authenticated, service_role;

create or replace function private.consolidated_case_lines(p_case_id uuid, p_family text)
returns table (
  identity_key text,
  product_id uuid,
  product_name text,
  supplier_sku text,
  barcode text,
  quantity numeric,
  unit_price numeric,
  amount numeric,
  source_ids uuid[],
  ambiguous boolean
)
language sql
stable
set search_path = public, private, pg_temp
as $$
  with case_row as (
    select * from public.consolidated_invoice_cases where id = p_case_id
  ), invoice_ids as (
    select c.anchor_invoice_id as invoice_id
    from case_row c where p_family = 'anchor' and c.anchor_invoice_id is not null
    union all
    select source.invoice_id
    from public.consolidated_invoice_sources source
    join case_row c on c.org_id = source.org_id and c.id = source.case_id
    where p_family = 'interim' and source.source_type = 'interim_invoice'
  ), latest_batches as (
    select distinct on (batch.invoice_id) batch.invoice_id, batch.id
    from public.invoice_line_evidence_batches batch
    join invoice_ids selected on selected.invoice_id = batch.invoice_id
    order by batch.invoice_id, batch.revision desc
  ), invoice_source as (
    select
      line.invoice_id as source_id,
      line.id as line_id,
      coalesce(line.product_id, sku_match.product_id, barcode_match.product_id) as resolved_product_id,
      line.description,
      nullif(trim(line.supplier_sku),'') as supplier_sku,
      nullif(trim(line.barcode),'') as barcode,
      line.quantity,
      line.unit_price,
      line.line_total as amount,
      line.product_id is null and sku_match.product_id is null and barcode_match.product_id is null
        and nullif(trim(line.supplier_sku),'') is null
        and nullif(trim(line.barcode),'') is null as ambiguous
    from latest_batches batch
    join public.invoice_lines line
      on line.evidence_batch_id = batch.id and line.invoice_id = batch.invoice_id
    join case_row c on c.org_id = line.org_id
    left join lateral (
      select (array_agg(distinct sp.product_id order by sp.product_id))[1] as product_id
      from public.supplier_products sp
      where sp.org_id = c.org_id and sp.supplier_id = c.supplier_id
        and line.supplier_sku is not null and sp.supplier_sku is not null
        and lower(trim(sp.supplier_sku)) = lower(trim(line.supplier_sku))
      having count(distinct sp.product_id) = 1
    ) sku_match on true
    left join lateral (
      select (array_agg(distinct product.id order by product.id))[1] as product_id
      from public.products product
      where product.org_id = c.org_id
        and line.barcode is not null and product.barcode is not null
        and regexp_replace(product.barcode, '[[:space:]-]+', '', 'g')
          = regexp_replace(line.barcode, '[[:space:]-]+', '', 'g')
      having count(distinct product.id) = 1
    ) barcode_match on true
    where p_family in ('anchor','interim')
  ), receipt_source as (
    select
      receipt.id as source_id,
      item.id as line_id,
      item.product_id as resolved_product_id,
      product.name as description,
      supplier_product.supplier_sku,
      product.barcode,
      item.qty_received as quantity,
      order_item.unit_price,
      item.qty_received * order_item.unit_price as amount,
      false as ambiguous
    from public.consolidated_invoice_sources source
    join case_row c on c.org_id = source.org_id and c.id = source.case_id
    join public.goods_receipts receipt
      on receipt.org_id = source.org_id and receipt.id = source.receipt_id
      and receipt.status = 'completed'
    join public.goods_receipt_items item
      on item.org_id = receipt.org_id and item.receipt_id = receipt.id
      and item.status in ('full','partial')
    join public.purchase_order_items order_item
      on order_item.org_id = item.org_id and order_item.id = item.order_item_id
    join public.products product
      on product.org_id = item.org_id and product.id = item.product_id
    left join public.supplier_products supplier_product
      on supplier_product.org_id = c.org_id
      and supplier_product.supplier_id = c.supplier_id
      and supplier_product.product_id = item.product_id
    where p_family = 'receipt' and source.source_type = 'goods_receipt'
  ), selected as (
    select * from invoice_source
    union all
    select * from receipt_source
  ), keyed as (
    select source.*,
      case
        when source.resolved_product_id is not null then 'product:' || source.resolved_product_id::text
        when source.supplier_sku is not null then 'sku:' || lower(trim(source.supplier_sku))
        when source.barcode is not null then 'barcode:' || regexp_replace(source.barcode, '[[:space:]-]+', '', 'g')
        else 'line:' || source.line_id::text
      end as identity_key
    from selected source
  )
  select keyed.identity_key,
    (array_agg(distinct keyed.resolved_product_id order by keyed.resolved_product_id)
      filter (where keyed.resolved_product_id is not null))[1] as product_id,
    coalesce(min(product.name), min(keyed.description)) as product_name,
    min(keyed.supplier_sku) as supplier_sku,
    min(keyed.barcode) as barcode,
    sum(keyed.quantity) as quantity,
    case when sum(keyed.quantity) > 0 then sum(keyed.amount) / sum(keyed.quantity) end as unit_price,
    sum(keyed.amount) as amount,
    array_agg(distinct keyed.source_id order by keyed.source_id) as source_ids,
    bool_or(keyed.ambiguous) as ambiguous
  from keyed
  left join public.products product on product.id = keyed.resolved_product_id
  group by keyed.identity_key
$$;

revoke all on function private.consolidated_case_lines(uuid,text)
  from public, anon, authenticated, service_role;

create or replace function private.consolidated_comparison(
  p_case_id uuid, p_left text, p_right text, p_comparison text
) returns jsonb
language sql
stable
set search_path = public, private, pg_temp
as $$
  with left_rows as (
    select * from private.consolidated_case_lines(p_case_id, p_left)
  ), right_rows as (
    select * from private.consolidated_case_lines(p_case_id, p_right)
  ), compared as (
    select coalesce(l.identity_key, r.identity_key) as identity_key,
      coalesce(l.product_id, r.product_id) as product_id,
      coalesce(l.product_name, r.product_name) as product_name,
      coalesce(l.supplier_sku, r.supplier_sku) as supplier_sku,
      coalesce(l.barcode, r.barcode) as barcode,
      l.quantity as left_quantity, r.quantity as right_quantity,
      l.unit_price as left_unit_price, r.unit_price as right_unit_price,
      l.amount as left_amount, r.amount as right_amount,
      coalesce(l.source_ids,'{}'::uuid[]) || coalesce(r.source_ids,'{}'::uuid[]) as source_ids,
      case
        when l.identity_key is null then 'source_not_on_anchor'
        when r.identity_key is null then 'missing_source'
        when l.ambiguous or r.ambiguous then 'ambiguous'
        when abs(l.quantity - r.quantity) > 0.000001 then 'quantity_mismatch'
        when abs(l.unit_price - r.unit_price) > 0.01 then 'price_mismatch'
        else 'matched'
      end as result
    from left_rows l full join right_rows r using (identity_key)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'comparison', p_comparison,
    'result', result,
    'product_id', product_id,
    'product_name', product_name,
    'supplier_sku', supplier_sku,
    'barcode', barcode,
    'anchor_quantity', case
      when p_left = 'anchor' then left_quantity when p_right = 'anchor' then right_quantity end,
    'interim_quantity', case
      when p_left = 'interim' then left_quantity when p_right = 'interim' then right_quantity end,
    'received_quantity', case
      when p_left = 'receipt' then left_quantity when p_right = 'receipt' then right_quantity end,
    'anchor_unit_price', case
      when p_left = 'anchor' then left_unit_price when p_right = 'anchor' then right_unit_price end,
    'interim_unit_price', case
      when p_left = 'interim' then left_unit_price when p_right = 'interim' then right_unit_price end,
    'anchor_amount', case
      when p_left = 'anchor' then left_amount when p_right = 'anchor' then right_amount end,
    'interim_amount', case
      when p_left = 'interim' then left_amount when p_right = 'interim' then right_amount end,
    'difference_quantity', round(coalesce(left_quantity,0) - coalesce(right_quantity,0), 6),
    'difference_amount', round(coalesce(left_amount,0) - coalesce(right_amount,0), 2),
    'source_ids', to_jsonb(source_ids),
    'message_key', 'consolidated_invoice.' || result,
    'severity', case when result = 'matched' then 'info' else 'warning' end
  ) order by result, product_name, identity_key), '[]'::jsonb)
  from compared
$$;

revoke all on function private.consolidated_comparison(uuid,text,text,text)
  from public, anon, authenticated, service_role;

create or replace function private.consolidated_reconciliation_payload(p_case_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public, private, pg_temp
as $$
declare
  v_anchor_interim jsonb;
  v_anchor_receipts jsonb;
  v_interim_receipts jsonb;
  v_warnings jsonb;
  v_bad_receipts jsonb;
  v_structural_warnings jsonb;
  v_case public.consolidated_invoice_cases;
begin
  select * into v_case from public.consolidated_invoice_cases where id = p_case_id;
  if not found then raise exception 'consolidated_case_unknown' using errcode = 'P0002'; end if;

  v_anchor_interim := private.consolidated_comparison(
    p_case_id,'anchor','interim','anchor_vs_interim');
  v_anchor_receipts := private.consolidated_comparison(
    p_case_id,'anchor','receipt','anchor_vs_receipts');
  v_interim_receipts := private.consolidated_comparison(
    p_case_id,'interim','receipt','interim_vs_receipts');

  select coalesce(jsonb_agg(jsonb_build_object(
    'code', 'receipt_line_' || item.status::text,
    'severity', 'warning',
    'message_key', 'consolidated_invoice.receipt_line_' || item.status::text,
    'source_type', 'goods_receipt',
    'source_id', source.receipt_id,
    'product_id', item.product_id
  ) order by source.receipt_id, item.id), '[]'::jsonb)
  into v_bad_receipts
  from public.consolidated_invoice_sources source
  join public.goods_receipt_items item
    on item.org_id = source.org_id and item.receipt_id = source.receipt_id
  where source.org_id = v_case.org_id and source.case_id = v_case.id
    and source.source_type = 'goods_receipt'
    and item.status in ('missing','damaged','returned');

  select coalesce(jsonb_agg(finding order by sort_key),'[]'::jsonb)
    into v_structural_warnings
  from (
    select 1 as sort_key,jsonb_build_object(
      'code','anchor_line_evidence_missing','severity','warning',
      'message_key','consolidated_invoice.anchor_line_evidence_missing',
      'source_type','consolidated_invoice','source_id',v_case.anchor_invoice_id,
      'product_id',null
    ) as finding
    where v_case.anchor_invoice_id is not null and not exists (
      select 1 from public.invoice_lines line
      where line.org_id=v_case.org_id and line.invoice_id=v_case.anchor_invoice_id)
    union all
    select 2,jsonb_build_object(
      'code','interim_source_line_evidence_missing','severity','warning',
      'message_key','consolidated_invoice.interim_source_line_evidence_missing',
      'source_type','interim_invoice','source_id',source.invoice_id,'product_id',null)
    from public.consolidated_invoice_sources source
    where source.org_id=v_case.org_id and source.case_id=v_case.id
      and source.source_type='interim_invoice'
      and not exists (
        select 1 from public.invoice_lines line
        where line.org_id=source.org_id and line.invoice_id=source.invoice_id)
    union all
    select 3,jsonb_build_object(
      'code','interim_sources_missing','severity','warning',
      'message_key','consolidated_invoice.interim_sources_missing',
      'source_type','interim_invoice','source_id',null,'product_id',null)
    where not exists (
      select 1 from public.consolidated_invoice_sources source
      where source.org_id=v_case.org_id and source.case_id=v_case.id
        and source.source_type='interim_invoice')
    union all
    select 4,jsonb_build_object(
      'code','receipt_sources_missing','severity','warning',
      'message_key','consolidated_invoice.receipt_sources_missing',
      'source_type','goods_receipt','source_id',null,'product_id',null)
    where not exists (
      select 1 from public.consolidated_invoice_sources source
      where source.org_id=v_case.org_id and source.case_id=v_case.id
        and source.source_type='goods_receipt')
    union all
    select 5,jsonb_build_object(
      'code','receipt_not_completed','severity','warning',
      'message_key','consolidated_invoice.receipt_not_completed',
      'source_type','goods_receipt','source_id',source.receipt_id,'product_id',null)
    from public.consolidated_invoice_sources source
    join public.goods_receipts receipt
      on receipt.org_id=source.org_id and receipt.id=source.receipt_id
    where source.org_id=v_case.org_id and source.case_id=v_case.id
      and source.source_type='goods_receipt' and receipt.status<>'completed'
    union all
    select 6,jsonb_build_object(
      'code','supporting_document_pending','severity','warning',
      'message_key','consolidated_invoice.supporting_document_pending',
      'source_type','supporting_document','source_id',source.document_id,'product_id',null)
    from public.consolidated_invoice_sources source
    join public.documents document
      on document.org_id=source.org_id and document.id=source.document_id
    where source.org_id=v_case.org_id and source.case_id=v_case.id
      and source.source_type='supporting_document'
      and not (
        (document.entity_type='invoice' and exists (
          select 1 from public.consolidated_invoice_sources resolved
          where resolved.org_id=source.org_id and resolved.case_id=source.case_id
            and resolved.source_type='interim_invoice'
            and resolved.invoice_id=document.entity_id
        ))
        or (document.entity_type='goods_receipt' and exists (
          select 1 from public.consolidated_invoice_sources resolved
          where resolved.org_id=source.org_id and resolved.case_id=source.case_id
            and resolved.source_type='goods_receipt'
            and resolved.receipt_id=document.entity_id
        ))
      )
  ) structural;

  select coalesce(jsonb_agg(jsonb_build_object(
    'code', row ->> 'result',
    'severity', 'warning',
    'message_key', row ->> 'message_key',
    'source_type', row ->> 'comparison',
    'source_id', null,
    'product_id', row -> 'product_id'
  )), '[]'::jsonb) || v_bad_receipts || v_structural_warnings
  into v_warnings
  from jsonb_array_elements(v_anchor_interim || v_anchor_receipts || v_interim_receipts) row
  where row ->> 'result' <> 'matched';

  return jsonb_build_object(
    'reconciliation', jsonb_build_object(
      'anchor_vs_interim', v_anchor_interim,
      'anchor_vs_receipts', v_anchor_receipts,
      'interim_vs_receipts', v_interim_receipts
    ),
    'warnings', v_warnings,
    'warning_count', jsonb_array_length(v_warnings)
  );
end
$$;

revoke all on function private.consolidated_reconciliation_payload(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.append_consolidated_invoice_revision(
  p_case_id uuid,
  p_idempotency_key text,
  p_trigger_kind text,
  p_source_type text default null,
  p_source_id uuid default null,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
set search_path = public, private, extensions, pg_temp
as $$
declare
  v_case public.consolidated_invoice_cases;
  v_revision public.consolidated_invoice_revisions;
  v_snapshot public.consolidated_invoice_snapshots;
  v_payload jsonb;
  v_warning_count integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 300
     or p_trigger_kind not in ('anchor_received','late_arrival','manual_refresh') then
    raise exception 'consolidated_revision_invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('consolidated-case:' || p_case_id::text, 0));
  select * into v_case
  from public.consolidated_invoice_cases c
  where c.id = p_case_id
  for update;
  if not found then raise exception 'consolidated_case_unknown' using errcode = 'P0002'; end if;

  select * into v_revision
  from public.consolidated_invoice_revisions r
  where r.org_id = v_case.org_id and r.case_id = v_case.id
    and r.idempotency_key = p_idempotency_key;
  if found then
    select * into v_snapshot
    from public.consolidated_invoice_snapshots s
    where s.org_id = v_case.org_id and s.revision_id = v_revision.id;
    return jsonb_build_object(
      'case_id', v_case.id, 'revision_id', v_revision.id,
      'revision', v_revision.revision, 'trigger', v_revision.trigger_kind,
      'snapshot_id', v_snapshot.id, 'warning_count', v_snapshot.warning_count,
      'idempotent', true
    );
  end if;

  perform set_config('app.consolidated_invoice_writer', '0136', true);
  perform private.consolidated_sync_sources(v_case.id, p_trigger_kind = 'late_arrival');
  v_payload := private.consolidated_reconciliation_payload(v_case.id);
  v_warning_count := (v_payload ->> 'warning_count')::integer;

  insert into public.consolidated_invoice_revisions (
    org_id, case_id, revision, idempotency_key, trigger_kind,
    source_type, source_id, created_by
  ) values (
    v_case.org_id, v_case.id, v_case.current_revision + 1, p_idempotency_key,
    p_trigger_kind, p_source_type, p_source_id, p_actor_id
  ) returning * into v_revision;

  insert into public.consolidated_invoice_snapshots (
    org_id, case_id, revision_id, revision, payload, warning_count, content_hash
  ) values (
    v_case.org_id, v_case.id, v_revision.id, v_revision.revision, v_payload,
    v_warning_count,
    encode(digest(convert_to(v_payload::text, 'utf8'), 'sha256'), 'hex')
  ) returning * into v_snapshot;

  update public.consolidated_invoice_cases
  set current_revision = v_revision.revision,
      warning_count = v_warning_count,
      status = case
        when anchor_invoice_id is null then 'awaiting_anchor'
        when v_warning_count > 0 then 'warnings'
        else 'matched'
      end,
      updated_at = statement_timestamp()
  where id = v_case.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_case.org_id, p_actor_id, 'consolidated_invoice_revision_created',
    'consolidated_invoice_revisions', v_revision.id,
    jsonb_build_object(
      'case_id',v_case.id,'revision',v_revision.revision,'trigger',p_trigger_kind,
      'source_type',p_source_type,'source_id',p_source_id,'warning_count',v_warning_count,
      'content_hash',v_snapshot.content_hash
    ),
    case when p_trigger_kind = 'late_arrival'
      then 'מסמך מאוחר פתח רוויזיית התאמה חדשה'
      else 'חישוב התאמת חשבונית מרכזת נשמר כצילום מצב בלתי משתנה' end
  );

  return jsonb_build_object(
    'case_id', v_case.id, 'revision_id', v_revision.id,
    'revision', v_revision.revision, 'trigger', v_revision.trigger_kind,
    'snapshot_id', v_snapshot.id, 'warning_count', v_warning_count,
    'idempotent', false
  );
end
$$;

revoke all on function private.append_consolidated_invoice_revision(
  uuid,text,text,text,uuid,uuid
) from public, anon, authenticated, service_role;

-- ===== 5. Browser intake commands =====

create or replace function public.list_consolidated_invoice_legal_entities()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
begin
  if auth.uid() is null or v_org is null or auth_role() not in ('owner','office') then
    raise exception 'consolidated_intake_not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id',u.id,'name',u.name) order by u.name,u.id)
    from public.org_units u
    where u.org_id = v_org and u.unit_type = 'legal_entity'
      and u.id = any(public.auth_scopes())
  ), '[]'::jsonb);
end
$$;

revoke all on function public.list_consolidated_invoice_legal_entities()
  from public, anon, authenticated, service_role;
grant execute on function public.list_consolidated_invoice_legal_entities() to authenticated;

create or replace function public.open_consolidated_invoice_intake(
  p_idempotency_key uuid,
  p_supplier_id uuid,
  p_target_month date,
  p_legal_entity_id uuid,
  p_source_page_count integer
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_case public.consolidated_invoice_cases;
  v_intake public.consolidated_invoice_intakes;
  v_previous_month date := date_trunc(
    'month', timezone('Asia/Jerusalem', statement_timestamp()) - interval '1 month')::date;
  v_inserted boolean := false;
begin
  if v_org is null or v_actor is null or auth_role() not in ('owner','office')
     or not public.organization_write_allowed() then
    raise exception 'consolidated_intake_not_authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_source_page_count not between 1 and 50 then
    raise exception 'consolidated_intake_invalid' using errcode = '22023';
  end if;
  if p_target_month is null or p_target_month <> v_previous_month then
    raise exception 'consolidated_target_month_invalid' using errcode = '22023';
  end if;
  if p_supplier_id is null or not exists (
    select 1 from public.suppliers s
    where s.org_id = v_org and s.id = p_supplier_id and s.deleted_at is null
  ) then
    raise exception 'consolidated_supplier_unresolved' using errcode = '22023';
  end if;
  if p_legal_entity_id is null or not exists (
    select 1 from public.org_units u
    where u.org_id = v_org and u.id = p_legal_entity_id and u.unit_type = 'legal_entity'
  ) then
    raise exception 'consolidated_legal_entity_invalid' using errcode = '22023';
  end if;
  perform public.assert_unit_in_scope(p_legal_entity_id);

  perform pg_advisory_xact_lock(hashtextextended(
    'consolidated-business:' || v_org::text || ':' || p_legal_entity_id::text || ':'
      || p_supplier_id::text || ':' || p_target_month::text, 0));
  perform set_config('app.consolidated_invoice_writer', '0136', true);

  select intake.* into v_intake
  from public.consolidated_invoice_intakes intake
  where intake.org_id = v_org and intake.idempotency_key = p_idempotency_key;
  if found then
    select * into v_case from public.consolidated_invoice_cases where id = v_intake.case_id;
    if v_case.supplier_id is distinct from p_supplier_id
       or v_case.target_month is distinct from p_target_month
       or v_case.legal_entity_id is distinct from p_legal_entity_id
       or v_intake.source_page_count is distinct from p_source_page_count then
      raise exception 'consolidated_intake_idempotency_conflict' using errcode = '55000';
    end if;
  else
    insert into public.consolidated_invoice_cases (
      org_id, legal_entity_id, supplier_id, target_month, created_by
    ) values (
      v_org, p_legal_entity_id, p_supplier_id, p_target_month, v_actor
    ) on conflict (org_id, legal_entity_id, supplier_id, target_month)
      do update set updated_at = public.consolidated_invoice_cases.updated_at
    returning * into v_case;

    if v_case.anchor_invoice_id is not null then
      raise exception 'consolidated_duplicate_anchor' using errcode = '23505';
    end if;
    if exists (
      select 1 from public.consolidated_invoice_intakes existing
      where existing.org_id = v_org and existing.case_id = v_case.id
        and existing.status in ('uploading','ready')
    ) then
      raise exception 'consolidated_intake_already_open' using errcode = '55000';
    end if;

    insert into public.consolidated_invoice_intakes (
      org_id, case_id, idempotency_key, source_page_count, created_by
    ) values (
      v_org, v_case.id, p_idempotency_key, p_source_page_count, v_actor
    ) returning * into v_intake;
    v_inserted := true;

    insert into public.audit_logs (
      org_id,user_id,action,entity_type,entity_id,new_values,reason
    ) values (
      v_org,v_actor,'consolidated_invoice_intake_opened','consolidated_invoice_intakes',v_intake.id,
      jsonb_build_object('case_id',v_case.id,'supplier_id',p_supplier_id,
        'target_month',p_target_month,'legal_entity_id',p_legal_entity_id,
        'source_page_count',p_source_page_count,'processing_mode',v_intake.processing_mode),
      'נפתחה קליטת חשבונית מרכזת לספק ולחודש שנבחרו'
    );
  end if;

  return jsonb_build_object(
    'intake_id',v_intake.id,'case_id',v_case.id,
    'processing_mode',v_intake.processing_mode,'supplier_id',v_case.supplier_id,
    'target_month',v_case.target_month,'legal_entity_id',v_case.legal_entity_id,
    'status',v_intake.status,'source_page_count',v_intake.source_page_count,
    'idempotent',not v_inserted
  );
end
$$;

revoke all on function public.open_consolidated_invoice_intake(uuid,uuid,date,uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.open_consolidated_invoice_intake(uuid,uuid,date,uuid,integer)
  to authenticated;

create or replace function public.register_consolidated_invoice_page(
  p_intake_id uuid,
  p_page_number integer,
  p_client_upload_key text,
  p_storage_path text,
  p_file_name text,
  p_mime_type text
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_intake public.consolidated_invoice_intakes;
  v_case public.consolidated_invoice_cases;
  v_page public.consolidated_invoice_intake_pages;
  v_registered jsonb;
  v_document_id uuid;
  v_inserted boolean := false;
  v_prefix text;
begin
  if v_org is null or v_actor is null or auth_role() not in ('owner','office') then
    raise exception 'consolidated_intake_not_authorized' using errcode = '42501';
  end if;
  select * into v_intake from public.consolidated_invoice_intakes
  where org_id = v_org and id = p_intake_id for update;
  if not found then raise exception 'consolidated_intake_unknown' using errcode = 'P0002'; end if;
  select * into v_case from public.consolidated_invoice_cases where id = v_intake.case_id;
  perform public.assert_unit_in_scope(v_case.legal_entity_id);
  if v_intake.status <> 'uploading' then
    raise exception 'consolidated_intake_not_uploading' using errcode = '55000';
  end if;
  if p_page_number is null or p_page_number < 1
     or p_page_number > v_intake.source_page_count then
    raise exception 'consolidated_page_number_invalid' using errcode = '22023';
  end if;
  v_prefix := v_org::text || '/consolidated-invoices/' || v_intake.id::text
    || '/page-' || p_page_number::text || '/';
  if p_storage_path is null or p_storage_path not like v_prefix || '%' then
    raise exception 'consolidated_storage_path_invalid' using errcode = '22023';
  end if;

  select * into v_page
  from public.consolidated_invoice_intake_pages page
  where page.org_id = v_org
    and (page.client_upload_key = p_client_upload_key
      or (page.intake_id = v_intake.id and page.page_number = p_page_number));
  if found then
    if v_page.intake_id is distinct from v_intake.id
       or v_page.page_number is distinct from p_page_number
       or v_page.client_upload_key is distinct from p_client_upload_key
       or v_page.storage_path is distinct from p_storage_path then
      raise exception 'consolidated_page_idempotency_conflict' using errcode = '55000';
    end if;
  else
    v_registered := public.register_uploaded_document(
      p_client_upload_key, 'inbox', null, p_storage_path, p_file_name, p_mime_type,
      'invoice', v_case.supplier_id, null
    );
    v_document_id := (v_registered ->> 'document_id')::uuid;
    perform set_config('app.consolidated_invoice_writer', '0136', true);
    insert into public.consolidated_invoice_intake_pages (
      org_id,intake_id,page_number,client_upload_key,document_id,storage_path,source_metadata
    ) values (
      v_org,v_intake.id,p_page_number,p_client_upload_key,v_document_id,p_storage_path,
      jsonb_build_object('page_number',p_page_number,
        'source_page_count',v_intake.source_page_count,'file_name',p_file_name,
        'mime_type',lower(p_mime_type))
    ) returning * into v_page;
    v_inserted := true;
  end if;

  return jsonb_build_object(
    'intake_id',v_intake.id,'page_id',v_page.id,'page_number',v_page.page_number,
    'document_id',v_page.document_id,'storage_path',v_page.storage_path,
    'idempotent',not v_inserted
  );
end
$$;

revoke all on function public.register_consolidated_invoice_page(uuid,integer,text,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.register_consolidated_invoice_page(uuid,integer,text,text,text,text)
  to authenticated;

create or replace function public.complete_consolidated_invoice_intake(
  p_intake_id uuid, p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_intake public.consolidated_invoice_intakes;
  v_case public.consolidated_invoice_cases;
  v_document_ids jsonb;
  v_count integer;
  v_replay boolean;
begin
  if v_org is null or v_actor is null or auth_role() not in ('owner','office')
     or p_idempotency_key is null then
    raise exception 'consolidated_intake_not_authorized' using errcode = '42501';
  end if;
  select * into v_intake from public.consolidated_invoice_intakes
  where org_id = v_org and id = p_intake_id for update;
  if not found then raise exception 'consolidated_intake_unknown' using errcode = 'P0002'; end if;
  v_replay := v_intake.completion_idempotency_key is not null;
  select * into v_case from public.consolidated_invoice_cases where id = v_intake.case_id;
  perform public.assert_unit_in_scope(v_case.legal_entity_id);

  if v_intake.completion_idempotency_key is not null then
    if v_intake.completion_idempotency_key is distinct from p_idempotency_key then
      raise exception 'consolidated_intake_completion_conflict' using errcode = '55000';
    end if;
  elsif v_intake.status <> 'uploading' then
    raise exception 'consolidated_intake_not_uploading' using errcode = '55000';
  end if;

  select count(*)::integer,
    coalesce(jsonb_agg(page.document_id order by page.page_number),'[]'::jsonb)
    into v_count, v_document_ids
  from public.consolidated_invoice_intake_pages page
  where page.org_id = v_org and page.intake_id = v_intake.id;
  if v_count <> v_intake.source_page_count
     or exists (
       select 1 from generate_series(1,v_intake.source_page_count) n
       where not exists (
         select 1 from public.consolidated_invoice_intake_pages page
         where page.org_id = v_org and page.intake_id = v_intake.id and page.page_number = n)
     ) then
    raise exception 'consolidated_intake_not_ready' using errcode = '55000';
  end if;

  if v_intake.completion_idempotency_key is null then
    perform set_config('app.consolidated_invoice_writer', '0136', true);
    update public.consolidated_invoice_intakes
    set completion_idempotency_key = p_idempotency_key,
        primary_document_id = (
          select page.document_id from public.consolidated_invoice_intake_pages page
          where page.org_id = v_org and page.intake_id = v_intake.id and page.page_number = 1),
        status = 'ready', completed_at = statement_timestamp()
    where id = v_intake.id
    returning * into v_intake;

    insert into public.audit_logs (
      org_id,user_id,action,entity_type,entity_id,new_values,reason
    ) values (
      v_org,v_actor,'consolidated_invoice_intake_completed','consolidated_invoice_intakes',v_intake.id,
      jsonb_build_object('case_id',v_case.id,'primary_document_id',v_intake.primary_document_id,
        'document_ids',v_document_ids,'source_page_count',v_count),
      'כל עמודי המקור של החשבונית המרכזת נשמרו והקליטה מוכנה לפענוח'
    );
  end if;

  return jsonb_build_object(
    'intake_id',v_intake.id,'case_id',v_case.id,'status',v_intake.status,
    'primary_document_id',v_intake.primary_document_id,'document_ids',v_document_ids,
    'source_page_count',v_intake.source_page_count,
    'idempotent',v_replay
  );
end
$$;

revoke all on function public.complete_consolidated_invoice_intake(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_consolidated_invoice_intake(uuid,uuid) to authenticated;

-- ===== 6. Trusted interpretation routing and atomic anchor registration =====

create or replace function public.get_consolidated_invoice_processing_claim(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_current_job_id uuid;
  v_intake public.consolidated_invoice_intakes;
  v_case public.consolidated_invoice_cases;
begin
  if auth.role() <> 'service_role'
     and not (auth.uid() is null and session_user = 'postgres') then
    raise exception 'consolidated_processing_not_authorized' using errcode = '42501';
  end if;
  select * into v_job from public.document_processing_jobs where id = p_job_id;
  if not found then
    raise exception 'consolidated_processing_job_unknown' using errcode = 'P0002';
  end if;
  select intake.* into v_intake
  from public.consolidated_invoice_intakes intake
  join public.consolidated_invoice_intake_pages page
    on page.org_id=intake.org_id and page.intake_id=intake.id
  where intake.org_id = v_job.org_id and page.document_id = v_job.document_id;
  if not found then
    return null;
  end if;
  select current_job.id into v_current_job_id
  from public.document_processing_jobs current_job
  where current_job.org_id=v_job.org_id and current_job.document_id=v_job.document_id
    and current_job.status<>'failed'
  order by current_job.created_at desc,current_job.id desc
  limit 1;
  if v_current_job_id is distinct from v_job.id then
    raise exception 'consolidated_processing_job_superseded' using errcode = '55000';
  end if;
  if not (
    (v_intake.status = 'ready' and v_intake.result is null)
    or (v_intake.status in ('received','blocked')
      and v_intake.result is not null
      and v_intake.outcome=v_intake.status
      and v_intake.result->>'outcome'=v_intake.status)
  ) then
    raise exception 'consolidated_intake_not_ready' using errcode = '55000';
  end if;
  select * into v_case from public.consolidated_invoice_cases where id = v_intake.case_id;
  return jsonb_build_object(
    'processing_mode',v_intake.processing_mode,'intake_id',v_intake.id,'case_id',v_case.id,
    'supplier_id',v_case.supplier_id,'target_month',v_case.target_month,
    'legal_entity_id',v_case.legal_entity_id,'source_page_count',v_intake.source_page_count,
    'upload_id',v_intake.id,
    'replay',v_intake.result is not null,
    'result',v_intake.result,
    'page_number',(select page.page_number
      from public.consolidated_invoice_intake_pages page
      where page.org_id=v_intake.org_id and page.intake_id=v_intake.id
        and page.document_id=v_job.document_id),
    'pages',coalesce((
      select jsonb_agg(jsonb_build_object(
        'page_number',page.page_number,'document_id',page.document_id,
        'storage_path',page.storage_path,'mime_type',document.mime_type,
        'source_metadata',page.source_metadata
      ) order by page.page_number)
      from public.consolidated_invoice_intake_pages page
      join public.documents document
        on document.org_id = page.org_id and document.id = page.document_id
      where page.org_id = v_intake.org_id and page.intake_id = v_intake.id
    ),'[]'::jsonb)
  );
end
$$;

revoke all on function public.get_consolidated_invoice_processing_claim(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_consolidated_invoice_processing_claim(uuid) to service_role;

create or replace function private.consolidated_interpretation_lines(p_payload jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, private, pg_temp
as $$
declare
  v_item jsonb;
  v_values jsonb;
  v_description text;
  v_quantity numeric;
  v_unit text;
  v_unit_price numeric;
  v_discount numeric;
  v_vat_rate numeric;
  v_line_total numeric;
  v_line integer := 0;
  v_out jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_payload -> 'line_items') <> 'array'
     or jsonb_array_length(p_payload -> 'line_items') = 0 then
    return v_out;
  end if;
  for v_item in select value from jsonb_array_elements(p_payload -> 'line_items') loop
    v_line := v_line + 1;
    v_values := coalesce(v_item -> 'values','{}'::jsonb);
    v_description := coalesce(
      nullif(trim(v_values ->> 'description'),''),
      nullif(trim(v_values ->> 'product_name'),''));
    v_quantity := private.interpretation_number(v_values -> 'quantity');
    v_unit := nullif(trim(v_values ->> 'unit'),'');
    v_unit_price := private.interpretation_number(v_values -> 'unit_price');
    v_discount := coalesce(private.interpretation_number(v_values -> 'discount_amount'),0);
    v_vat_rate := private.interpretation_number(v_values -> 'vat_rate');
    v_line_total := private.interpretation_number(v_values -> 'line_total');
    if v_description is null or length(v_description) > 1000
       or v_quantity is null or v_quantity <= 0
       or v_unit is null or length(v_unit) > 100
       or v_unit_price is null or v_unit_price < 0
       or v_discount < 0 or v_discount > v_quantity * v_unit_price
       or v_vat_rate is null or v_vat_rate not between 0 and 100
       or v_line_total is null or v_line_total < 0 then
      -- Partial line evidence is worse than no line evidence: a later comparison would treat the
      -- omitted product as absent. Preserve the interpretation, but return no financial lines.
      return '[]'::jsonb;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'line_number',v_line,'description',v_description,
      'supplier_sku',nullif(trim(v_values ->> 'sku'),''),
      'barcode',nullif(trim(v_values ->> 'barcode'),''),
      'product_id',null,'quantity',v_quantity,'unit',v_unit,
      'unit_price',v_unit_price,'discount_amount',v_discount,
      'vat_rate',v_vat_rate,'line_total',v_line_total,
      'evidence_block_ids','[]'::jsonb,'raw_evidence',v_item
    ));
  end loop;
  return v_out;
end
$$;

revoke all on function private.consolidated_interpretation_lines(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.apply_consolidated_invoice_interpretation(
  p_job_id uuid,
  p_interpretation_id uuid,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_interpretation public.document_interpretations;
  v_intake public.consolidated_invoice_intakes;
  v_case public.consolidated_invoice_cases;
  v_payload jsonb;
  v_supplier_id uuid;
  v_number text;
  v_number_key text;
  v_date date;
  v_before numeric;
  v_vat numeric;
  v_total numeric;
  v_block_code text;
  v_invoice_id uuid;
  v_lines jsonb;
  v_revision jsonb;
  v_snapshot_payload jsonb;
  v_result jsonb;
  v_actor uuid;
  v_evidence_actor uuid;
  v_current_job_id uuid;
  v_ready_pages integer;
  v_page_payload record;
  v_page_lines jsonb;
begin
  if auth.role() <> 'service_role'
     and not (auth.uid() is null and session_user = 'postgres') then
    raise exception 'consolidated_processing_not_authorized' using errcode = '42501';
  end if;
  if p_job_id is null or p_interpretation_id is null then
    raise exception 'consolidated_interpretation_arguments_required' using errcode = '22023';
  end if;

  select * into v_job from public.document_processing_jobs where id = p_job_id;
  if not found then raise exception 'consolidated_processing_job_unknown' using errcode = 'P0002'; end if;
  select * into v_interpretation
  from public.document_interpretations interpretation
  where interpretation.org_id = v_job.org_id and interpretation.id = p_interpretation_id
    and interpretation.job_id = v_job.id and interpretation.document_id = v_job.document_id;
  if not found then raise exception 'consolidated_interpretation_unknown' using errcode = 'P0002'; end if;
  select intake.* into v_intake
  from public.consolidated_invoice_intakes intake
  join public.consolidated_invoice_intake_pages page
    on page.org_id=intake.org_id and page.intake_id=intake.id
  where intake.org_id = v_job.org_id and page.document_id = v_job.document_id
  for update of intake;
  if not found then raise exception 'consolidated_intake_unknown' using errcode = 'P0002'; end if;
  select current_job.id into v_current_job_id
  from public.document_processing_jobs current_job
  where current_job.org_id=v_job.org_id and current_job.document_id=v_job.document_id
    and current_job.status<>'failed'
  order by current_job.created_at desc,current_job.id desc
  limit 1;
  if v_current_job_id is distinct from v_job.id then
    raise exception 'consolidated_processing_job_superseded' using errcode = '55000';
  end if;
  select * into v_case
  from public.consolidated_invoice_cases c where c.id = v_intake.case_id for update;

  select profile.id into v_actor
  from public.profiles profile
  where profile.org_id=v_case.org_id and profile.id=p_actor_id
    and profile.active and profile.role in ('owner','office');
  if not found then
    raise exception 'consolidated_actor_not_authorized' using errcode = '42501';
  end if;

  if v_intake.result is not null then
    if v_intake.status in ('received','blocked')
       and v_intake.outcome=v_intake.status
       and v_intake.result->>'outcome'=v_intake.status then
      return v_intake.result || jsonb_build_object('idempotent',true);
    end if;
    raise exception 'consolidated_intake_state_invalid' using errcode = '55000';
  end if;
  if v_intake.status <> 'ready' then
    raise exception 'consolidated_intake_not_ready' using errcode = '55000';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('consolidated-case:' || v_case.id::text,0));
  select * into v_case from public.consolidated_invoice_cases where id = v_case.id for update;

  select count(*)::integer into v_ready_pages
  from public.consolidated_invoice_intake_pages page
  join lateral (
    select job.* from public.document_processing_jobs job
    where job.org_id=page.org_id and job.document_id=page.document_id
      and job.status<>'failed'
    order by job.created_at desc,job.id desc limit 1
  ) current_job on true
  where page.org_id=v_intake.org_id and page.intake_id=v_intake.id
    and exists (
      select 1 from public.document_interpretations ready
      join public.profiles evidence_actor
        on evidence_actor.org_id=ready.org_id
        and evidence_actor.id=ready.interpreted_for_user_id
      where ready.org_id=page.org_id and ready.document_id=page.document_id
        and ready.job_id=current_job.id
        and current_job.interpretation_actor_id=ready.interpreted_for_user_id);
  if v_ready_pages<>v_intake.source_page_count then
    return jsonb_build_object(
      'outcome','awaiting_pages','reason_code',null,'case_id',v_case.id,
      'intake_id',v_intake.id,'invoice_id',null,'revision_id',null,
      'pages_ready',v_ready_pages,'source_page_count',v_intake.source_page_count,
      'warnings','[]'::jsonb,'idempotent',false
    );
  end if;

  select primary_interpretation.* into v_interpretation
  from public.consolidated_invoice_intake_pages page
  join lateral (
    select job.* from public.document_processing_jobs job
    where job.org_id=page.org_id and job.document_id=page.document_id
      and job.status<>'failed'
    order by job.created_at desc,job.id desc limit 1
  ) current_job on true
  join public.document_interpretations primary_interpretation
    on primary_interpretation.org_id=current_job.org_id
    and primary_interpretation.job_id=current_job.id
    and primary_interpretation.document_id=page.document_id
  join public.profiles evidence_actor
    on evidence_actor.org_id=primary_interpretation.org_id
    and evidence_actor.id=primary_interpretation.interpreted_for_user_id
  where page.org_id=v_intake.org_id and page.intake_id=v_intake.id
    and page.document_id=v_intake.primary_document_id
    and current_job.interpretation_actor_id=primary_interpretation.interpreted_for_user_id;
  if not found then
    raise exception 'consolidated_primary_interpretation_invalid' using errcode = '55000';
  end if;
  v_evidence_actor:=v_interpretation.interpreted_for_user_id;
  v_payload := v_interpretation.payload;
  v_supplier_id := v_interpretation.suggested_supplier_id;
  v_number := private.document_text_sanitize(
    private.interpretation_field(v_payload,array[
      'invoice_number','document_number','מספר חשבונית','מספר מסמך']) #>> '{}');
  v_number_key := private.document_text_key(v_number);
  v_date := private.interpretation_date(private.interpretation_field(v_payload,array[
    'invoice_date','document_date','date','תאריך חשבונית','תאריך המסמך','תאריך']));
  v_before := private.interpretation_number(private.interpretation_field(v_payload,array[
    'subtotal','amount_before_vat','net_amount','סכום לפני מעמ','סה"כ לפני מע"מ']));
  v_vat := private.interpretation_number(private.interpretation_field(v_payload,array[
    'vat_amount','vat','tax_amount','מעמ','מע"מ']));
  v_total := private.interpretation_number(private.interpretation_field(v_payload,array[
    'total','total_amount','grand_total','amount_due','סכום כולל','סה"כ לתשלום']));
  if v_payload ->> 'document_type' <> 'invoice'
     or v_supplier_id is null or v_supplier_id <> v_case.supplier_id then
    v_block_code := 'consolidated_supplier_unresolved';
  elsif v_number is null or v_number_key is null or length(v_number) > 100
     or v_date is null or v_before is null or v_vat is null or v_total is null
     or v_before < 0 or v_vat < 0 or v_total < 0
     or round(v_before,2) + round(v_vat,2) <> round(v_total,2) then
    v_block_code := 'consolidated_core_fields_missing';
  elsif date_trunc('month',v_date)::date <> v_case.target_month then
    v_block_code := 'consolidated_target_month_invalid';
  elsif v_case.anchor_invoice_id is not null then
    v_block_code := 'consolidated_duplicate_anchor';
  elsif exists (
    select 1 from public.invoices duplicate
    where duplicate.org_id = v_case.org_id and duplicate.supplier_id = v_case.supplier_id
      and duplicate.deleted_at is null
      and private.document_text_key(duplicate.invoice_number) = v_number_key
  ) then
    v_block_code := 'consolidated_payable_conflict';
  end if;

  if v_block_code is null then
    begin
      perform set_config('app.consolidated_invoice_writer','0136',true);
      perform private.consolidated_sync_sources(v_case.id,false);
    exception when sqlstate '55000' then
      if sqlerrm = 'consolidated_payable_conflict' then
        v_block_code := 'consolidated_payable_conflict';
      else
        raise;
      end if;
    end;
  end if;

  -- Every page is one processing job, but the terminal accounting decision belongs to the
  -- intake. Once every current page interpretation is ready, settle all page jobs in the same
  -- transaction for both terminal outcomes. A later failure rolls this update back atomically.
  update public.document_processing_jobs job
  set status='completed',last_error_code=null,last_error_message=null
  where job.org_id=v_case.org_id and job.status='review'
    and exists (
      select 1
      from public.consolidated_invoice_intake_pages page
      where page.org_id=job.org_id and page.intake_id=v_intake.id
        and page.document_id=job.document_id
    );

  if v_block_code is not null then
    v_result := jsonb_build_object(
      'outcome','blocked','reason_code',v_block_code,'case_id',v_case.id,
      'intake_id',v_intake.id,'invoice_id',null,'revision_id',null,
      'warnings','[]'::jsonb,'idempotent',false
    );
    perform set_config('app.consolidated_invoice_writer','0136',true);
    update public.consolidated_invoice_intakes
    set status='blocked',interpretation_id=v_interpretation.id,
        outcome='blocked',reason_code=v_block_code,result=v_result
    where id=v_intake.id;
    update public.consolidated_invoice_cases
    set status='blocked',updated_at=statement_timestamp() where id=v_case.id;
    insert into public.audit_logs(
      org_id,user_id,action,entity_type,entity_id,new_values,reason
    ) values (
      v_case.org_id,v_actor,'consolidated_invoice_blocked','consolidated_invoice_intakes',v_intake.id,
      jsonb_build_object('case_id',v_case.id,'reason_code',v_block_code,
        'interpretation_id',v_interpretation.id),
      'קליטת חשבונית מרכזת נחסמה לפני יצירת חוב'
    );
    return v_result;
  end if;

  v_invoice_id := gen_random_uuid();
  perform set_config('app.p1_financial_writer',coalesce(v_actor::text,'0136'),true);
  perform set_config('app.consolidated_invoice_writer','0136',true);
  insert into public.invoices (
    id,org_id,unit_id,supplier_id,invoice_number,invoice_date,received_date,
    received_by,amount_before_vat,vat_amount,total_amount,review_status,financial_role,notes
  ) values (
    v_invoice_id,v_case.org_id,v_case.legal_entity_id,v_case.supplier_id,v_number,v_date,current_date,
    null,round(v_before,2),round(v_vat,2),round(v_total,2),'received','payable',
    'חשבונית מרכזת; intake ' || v_intake.id::text
  );
  update public.consolidated_invoice_cases
  set anchor_invoice_id=v_invoice_id,status='reconciling',updated_at=statement_timestamp()
  where id=v_case.id;

  perform set_config('app.document_filing_writer',coalesce(v_actor::text,'0136'),true);
  update public.documents document
  set entity_type='invoice',entity_id=v_invoice_id,supplier_id=v_case.supplier_id,document_date=v_date
  from public.consolidated_invoice_intake_pages page
  where page.org_id=v_case.org_id and page.intake_id=v_intake.id
    and document.org_id=page.org_id and document.id=page.document_id;

  v_lines := '[]'::jsonb;
  for v_page_payload in
    select distinct on (page.page_number)
      page.page_number,page.document_id,
      interpretation.id as interpretation_id,interpretation.payload
    from public.consolidated_invoice_intake_pages page
    join lateral (
      select job.* from public.document_processing_jobs job
      where job.org_id=page.org_id and job.document_id=page.document_id
        and job.status<>'failed'
      order by job.created_at desc,job.id desc limit 1
    ) current_job on true
    join public.document_interpretations interpretation
      on interpretation.org_id=current_job.org_id and interpretation.job_id=current_job.id
      and interpretation.document_id=page.document_id
    join public.profiles evidence_actor
      on evidence_actor.org_id=interpretation.org_id
      and evidence_actor.id=interpretation.interpreted_for_user_id
    where page.org_id=v_intake.org_id and page.intake_id=v_intake.id
      and current_job.interpretation_actor_id=interpretation.interpreted_for_user_id
    order by page.page_number
  loop
    v_page_lines:=private.consolidated_interpretation_lines(v_page_payload.payload);
    select coalesce(jsonb_agg(
      (line.value - 'raw_evidence') || jsonb_build_object(
        'raw_evidence',coalesce(line.value->'raw_evidence','{}'::jsonb)
          || jsonb_build_object(
            'source_page_number',v_page_payload.page_number,
            'source_document_id',v_page_payload.document_id,
            'source_interpretation_id',v_page_payload.interpretation_id
          )
      ) order by line.ordinality
    ),'[]'::jsonb) into v_page_lines
    from jsonb_array_elements(v_page_lines) with ordinality as line(value,ordinality);
    v_lines:=v_lines||v_page_lines;
  end loop;
  -- Each page parser starts its local numbering at one. The evidence batch is invoice-wide, so
  -- replace those local numbers after the page-ordered concatenation with one strict sequence.
  select coalesce(jsonb_agg(
    (line.value - 'line_number') || jsonb_build_object('line_number',line.ordinality)
    order by line.ordinality
  ),'[]'::jsonb) into v_lines
  from jsonb_array_elements(v_lines) with ordinality as line(value,ordinality);
  if jsonb_array_length(v_lines) > 0 then
    perform public.record_invoice_line_evidence(
      gen_random_uuid(),v_invoice_id,v_interpretation.id,'document_interpretation',
      v_intake.primary_document_id,v_interpretation.id,v_evidence_actor,v_lines,
      'שורות מקור של חשבונית מרכזת מתוך פירוש המסמך'
    );
  end if;

  v_revision := private.append_consolidated_invoice_revision(
    v_case.id,'anchor:'||v_interpretation.id::text,'anchor_received',
    'consolidated_invoice',v_invoice_id,v_actor);
  select snapshot.payload into v_snapshot_payload
  from public.consolidated_invoice_snapshots snapshot
  where snapshot.id=(v_revision->>'snapshot_id')::uuid;
  v_result := jsonb_build_object(
    'outcome','received','reason_code',null,'case_id',v_case.id,'intake_id',v_intake.id,
    'invoice_id',v_invoice_id,'revision_id',(v_revision->>'revision_id')::uuid,
    'warnings',coalesce(v_snapshot_payload->'warnings','[]'::jsonb),'idempotent',false
  );
  update public.consolidated_invoice_intakes
  set status='received',interpretation_id=v_interpretation.id,invoice_id=v_invoice_id,
      outcome='received',reason_code=null,result=v_result,received_at=statement_timestamp()
  where id=v_intake.id;

  insert into public.audit_logs(
    org_id,user_id,action,entity_type,entity_id,new_values,reason
  ) values (
    v_case.org_id,null,'consolidated_invoice_received','invoices',v_invoice_id,
    jsonb_build_object('case_id',v_case.id,'intake_id',v_intake.id,
      'interpretation_id',v_interpretation.id,'supplier_id',v_case.supplier_id,
      'target_month',v_case.target_month,'legal_entity_id',v_case.legal_entity_id,
      'financial_role','payable','triggered_by',v_actor),
    'חשבונית מרכזת נרשמה אוטומטית לאחר אימות ספק, חודש ושדות ליבה'
  );
  return v_result;
end
$$;

revoke all on function public.apply_consolidated_invoice_interpretation(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_consolidated_invoice_interpretation(uuid,uuid,uuid)
  to service_role;

-- ===== 7. Stable client read models and manual refresh =====

create or replace function public.list_consolidated_invoice_cases(p_target_month date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
begin
  if auth.uid() is null or v_org is null
     or auth_role() not in ('owner','office','accountant') then
    raise exception 'consolidated_case_read_not_authorized' using errcode = '42501';
  end if;
  if p_target_month is not null
     and p_target_month <> date_trunc('month',p_target_month)::date then
    raise exception 'consolidated_target_month_invalid' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'case_id',c.id,'supplier_id',c.supplier_id,'supplier_name',supplier.name,
      'target_month',c.target_month,'legal_entity_id',c.legal_entity_id,
      'status',c.status,'anchor_invoice_id',c.anchor_invoice_id,
      'current_revision',c.current_revision,'warning_count',c.warning_count,
      'updated_at',c.updated_at
    ) order by c.target_month desc,c.updated_at desc,c.id)
    from public.consolidated_invoice_cases c
    join public.suppliers supplier
      on supplier.org_id=c.org_id and supplier.id=c.supplier_id
    where c.org_id=v_org and c.legal_entity_id=any(public.auth_scopes())
      and (p_target_month is null or c.target_month=p_target_month)
      and (
        auth_role() in ('owner','office')
        or exists (
          select 1 from public.consolidated_invoice_intakes intake
          where intake.org_id=c.org_id and intake.case_id=c.id
            and intake.status in ('received','blocked')
        )
      )
  ),'[]'::jsonb);
end
$$;

revoke all on function public.list_consolidated_invoice_cases(date)
  from public, anon, authenticated, service_role;
grant execute on function public.list_consolidated_invoice_cases(date) to authenticated;

create or replace function public.get_consolidated_invoice_workspace(p_case_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_case public.consolidated_invoice_cases;
  v_supplier_name text;
  v_legal_entity_name text;
  v_anchor jsonb;
  v_sources jsonb;
  v_revision jsonb;
  v_payload jsonb;
begin
  if auth.uid() is null or v_org is null
     or auth_role() not in ('owner','office','accountant') then
    raise exception 'consolidated_case_read_not_authorized' using errcode = '42501';
  end if;
  select c.* into v_case
  from public.consolidated_invoice_cases c
  where c.org_id=v_org and c.id=p_case_id
    and c.legal_entity_id=any(public.auth_scopes())
    and (
      auth_role() in ('owner','office')
      or exists (
        select 1 from public.consolidated_invoice_intakes intake
        where intake.org_id=c.org_id and intake.case_id=c.id
          and intake.status in ('received','blocked')
      )
    );
  if not found then raise exception 'consolidated_case_unknown' using errcode='P0002'; end if;
  select supplier.name,unit.name into v_supplier_name,v_legal_entity_name
  from public.suppliers supplier
  join public.org_units unit
    on unit.org_id=supplier.org_id and unit.id=v_case.legal_entity_id
  where supplier.org_id=v_case.org_id and supplier.id=v_case.supplier_id;

  if v_case.anchor_invoice_id is not null then
    select jsonb_build_object(
      'invoice_id',invoice.id,
      'document_ids',coalesce((
        select jsonb_agg(document.id order by document.created_at,document.id)
        from public.documents document
        where document.org_id=invoice.org_id and document.entity_type='invoice'
          and document.entity_id=invoice.id and document.deleted_at is null
      ),'[]'::jsonb),
      'invoice_number',invoice.invoice_number,'invoice_date',invoice.invoice_date,
      'amount_before_vat',invoice.amount_before_vat,'vat_amount',invoice.vat_amount,
      'total_amount',invoice.total_amount,'financial_role',invoice.financial_role,
      'review_status',invoice.review_status,'payment_status',invoice.payment_status
    ) into v_anchor
    from public.invoices invoice
    where invoice.org_id=v_case.org_id and invoice.id=v_case.anchor_invoice_id
      and invoice.deleted_at is null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'source_type',source.source_type,
    'source_id',coalesce(source.invoice_id,source.receipt_id,source.document_id),
    'document_id',source.document_id,
    'document_number',case when source.source_type='interim_invoice'
      then invoice.invoice_number when source.source_type='goods_receipt'
      then receipt.number::text else document.file_name end,
    'document_date',source.source_date,
    'total_amount',case when source.source_type='interim_invoice'
      then invoice.total_amount else receipt_total.total_amount end,
    'financial_role',case when source.source_type='interim_invoice'
      then invoice.financial_role else null end,
    'status',case when source.source_type='interim_invoice'
      then invoice.review_status::text when source.source_type='goods_receipt'
      then receipt.status::text
      when document.entity_type='invoice' then 'filed_as_invoice'
      when document.entity_type='goods_receipt' then 'filed_as_goods_receipt'
      else 'pending_evidence' end,
    'late_arrival',source.late_arrival
  ) order by source.source_date,source.created_at,source.id),'[]'::jsonb)
  into v_sources
  from public.consolidated_invoice_sources source
  left join public.invoices invoice
    on invoice.org_id=source.org_id and invoice.id=source.invoice_id
  left join public.goods_receipts receipt
    on receipt.org_id=source.org_id and receipt.id=source.receipt_id
  left join public.documents document
    on document.org_id=source.org_id and document.id=source.document_id
  left join lateral (
    select sum(item.qty_received*order_item.unit_price) as total_amount
    from public.goods_receipt_items item
    join public.purchase_order_items order_item
      on order_item.org_id=item.org_id and order_item.id=item.order_item_id
    where item.org_id=source.org_id and item.receipt_id=source.receipt_id
      and item.status in ('full','partial')
  ) receipt_total on true
  where source.org_id=v_case.org_id and source.case_id=v_case.id;

  select jsonb_build_object(
    'id',revision.id,'revision',revision.revision,'trigger',revision.trigger_kind,
    'created_at',revision.created_at,'created_by',revision.created_by
  ),snapshot.payload into v_revision,v_payload
  from public.consolidated_invoice_revisions revision
  join public.consolidated_invoice_snapshots snapshot
    on snapshot.org_id=revision.org_id and snapshot.revision_id=revision.id
  where revision.org_id=v_case.org_id and revision.case_id=v_case.id
  order by revision.revision desc limit 1;

  return jsonb_build_object(
    'case',jsonb_build_object(
      'id',v_case.id,'supplier_id',v_case.supplier_id,'supplier_name',v_supplier_name,
      'target_month',v_case.target_month,'legal_entity_id',v_case.legal_entity_id,
      'legal_entity_name',v_legal_entity_name,'status',v_case.status,
      'anchor_invoice_id',v_case.anchor_invoice_id,'current_revision',v_case.current_revision,
      'warning_count',v_case.warning_count,'created_at',v_case.created_at,'updated_at',v_case.updated_at
    ),
    'anchor',v_anchor,
    'sources',coalesce(v_sources,'[]'::jsonb),
    'reconciliation',coalesce(v_payload->'reconciliation',jsonb_build_object(
      'anchor_vs_interim','[]'::jsonb,'anchor_vs_receipts','[]'::jsonb,
      'interim_vs_receipts','[]'::jsonb)),
    'current_revision',v_revision,
    'warnings',coalesce(v_payload->'warnings','[]'::jsonb)
  );
end
$$;

revoke all on function public.get_consolidated_invoice_workspace(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_consolidated_invoice_workspace(uuid) to authenticated;

create or replace function public.refresh_consolidated_invoice_reconciliation(
  p_case_id uuid,p_idempotency_key uuid,p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid:=auth_org();
  v_actor uuid:=auth.uid();
  v_case public.consolidated_invoice_cases;
  v_reason text:=nullif(trim(p_reason),'');
begin
  if v_org is null or v_actor is null or auth_role() not in ('owner','office') then
    raise exception 'consolidated_refresh_not_authorized' using errcode='42501';
  end if;
  if p_idempotency_key is null or v_reason is null or length(v_reason)>1000 then
    raise exception 'consolidated_refresh_invalid' using errcode='22023';
  end if;
  select * into v_case from public.consolidated_invoice_cases
  where org_id=v_org and id=p_case_id;
  if not found then raise exception 'consolidated_case_unknown' using errcode='P0002'; end if;
  perform public.assert_unit_in_scope(v_case.legal_entity_id);
  if v_case.anchor_invoice_id is null then
    raise exception 'consolidated_anchor_missing' using errcode='55000';
  end if;
  return private.append_consolidated_invoice_revision(
    v_case.id,'manual:'||p_idempotency_key::text,'manual_refresh',null,null,v_actor)
    || jsonb_build_object('reason',v_reason);
end
$$;

revoke all on function public.refresh_consolidated_invoice_reconciliation(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.refresh_consolidated_invoice_reconciliation(uuid,uuid,text)
  to authenticated;

-- ===== 8. Late arrivals append; they never rewrite an earlier snapshot =====

create or replace function private.capture_consolidated_invoice_late_arrival()
returns trigger
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  v_case public.consolidated_invoice_cases;
  v_order public.purchase_orders;
  v_invoice public.invoices;
begin
  if tg_table_name='invoices' then
    select * into v_case
    from public.consolidated_invoice_cases c
    where c.org_id=new.org_id and c.legal_entity_id=new.unit_id
      and c.supplier_id=new.supplier_id
      and c.target_month=date_trunc('month',new.invoice_date)::date
      and c.anchor_invoice_id is not null and c.anchor_invoice_id<>new.id;
    if not found then return new; end if;
    perform set_config('app.consolidated_invoice_writer','0136',true);
    perform private.consolidated_sync_sources(v_case.id,true);
    perform private.append_consolidated_invoice_revision(
      v_case.id,'late:invoice:'||new.id::text,'late_arrival','interim_invoice',new.id,auth.uid());
    insert into public.audit_logs(org_id,user_id,action,entity_type,entity_id,new_values,reason)
    values(new.org_id,auth.uid(),'consolidated_invoice_late_source','invoices',new.id,
      jsonb_build_object('case_id',v_case.id,'financial_role',new.financial_role),
      'חשבונית מאוחרת צורפה כראיה תומכת ונפתחה רוויזיה חדשה');
  elsif tg_table_name='invoice_line_evidence_batches' then
    select * into v_invoice from public.invoices where id=new.invoice_id;
    select * into v_case
    from public.consolidated_invoice_cases c
    where c.org_id=v_invoice.org_id and c.legal_entity_id=v_invoice.unit_id
      and c.supplier_id=v_invoice.supplier_id
      and c.target_month=date_trunc('month',v_invoice.invoice_date)::date
      and c.anchor_invoice_id is not null and c.anchor_invoice_id<>v_invoice.id;
    if not found then return new; end if;
    perform set_config('app.consolidated_invoice_writer','0136',true);
    perform private.append_consolidated_invoice_revision(
      v_case.id,'late:evidence:'||new.id::text,'late_arrival','invoice_evidence',new.id,new.actor_id);
  elsif tg_table_name='goods_receipts' then
    if tg_op='UPDATE' and old.status=new.status then return new; end if;
    select * into v_order from public.purchase_orders
    where org_id=new.org_id and id=new.order_id;
    for v_case in
      select c.* from public.consolidated_invoice_cases c
      where c.org_id=new.org_id and c.supplier_id=v_order.supplier_id
        and c.target_month=date_trunc(
          'month',timezone('Asia/Jerusalem',new.received_at))::date
        and c.anchor_invoice_id is not null
        and private.consolidated_unit_descends_from(
          c.org_id,coalesce(new.unit_id,v_order.unit_id),c.legal_entity_id)
    loop
      perform set_config('app.consolidated_invoice_writer','0136',true);
      perform private.consolidated_sync_sources(v_case.id,true);
      perform private.append_consolidated_invoice_revision(
        v_case.id,'late:receipt:'||new.id::text||':'||new.status::text,
        'late_arrival','goods_receipt',new.id,auth.uid());
    end loop;
  elsif tg_table_name='documents' then
    if new.deleted_at is not null or new.supplier_id is null or new.document_date is null
       or new.document_kind not in ('invoice','delivery_note')
       or exists (
         select 1 from public.consolidated_invoice_intake_pages page
         where page.org_id=new.org_id and page.document_id=new.id) then
      return new;
    end if;
    for v_case in
      select c.* from public.consolidated_invoice_cases c
      where c.org_id=new.org_id and c.supplier_id=new.supplier_id
        and c.target_month=date_trunc('month',new.document_date)::date
        and c.anchor_invoice_id is not null
    loop
      perform set_config('app.consolidated_invoice_writer','0136',true);
      perform private.consolidated_sync_sources(v_case.id,true);
      perform private.append_consolidated_invoice_revision(
        v_case.id,'late:document:'||new.id::text,'late_arrival',
        'supporting_document',new.id,auth.uid());
    end loop;
  end if;
  return new;
end
$$;

revoke all on function private.capture_consolidated_invoice_late_arrival()
  from public, anon, authenticated, service_role;

create trigger consolidated_invoice_late_invoice
  after insert on public.invoices
  for each row execute function private.capture_consolidated_invoice_late_arrival();
create trigger consolidated_invoice_late_evidence
  after insert on public.invoice_line_evidence_batches
  for each row execute function private.capture_consolidated_invoice_late_arrival();
create trigger consolidated_invoice_late_receipt
  after insert or update of status on public.goods_receipts
  for each row execute function private.capture_consolidated_invoice_late_arrival();
create trigger consolidated_invoice_late_document
  after insert or update of supplier_id,document_date,document_kind,deleted_at,entity_type,entity_id
  on public.documents
  for each row execute function private.capture_consolidated_invoice_late_arrival();

-- ===== 9. Every money reader counts `payable` and only `payable` =====

-- `supporting_evidence` is not an ordinary invoice anywhere in the product. Keep it out of the
-- search/list attention readers as well as the monetary readers below; otherwise an interim
-- document could reappear as a payable invoice, an orphan or a duplicate after reconciliation.
do $payable_global_search$
declare
  v_def text;
  v_anchor text;
  v_replacement text;
begin
  v_def := replace(pg_get_functiondef(
    'public.global_search(text,integer)'::regprocedure),e'\r','');
  v_anchor := $a$     where 'invoice' = any(v_types)
       and i.org_id = auth_org() and i.deleted_at is null$a$;
  v_replacement := $b$     where 'invoice' = any(v_types)
       and i.org_id = auth_org() and i.deleted_at is null
       and i.financial_role = 'payable'$b$;
  if position(v_anchor in v_def)=0 then
    raise exception '0136: global_search invoice-reader anchor moved';
  end if;
  execute replace(v_def,v_anchor,v_replacement);
end
$payable_global_search$;

create or replace function public.invoice_has_duplicate(public.invoices)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select $1.deleted_at is null
    and $1.financial_role = 'payable'
    and exists (
      select 1
      from public.invoices twin
      where twin.org_id = $1.org_id
        and twin.supplier_id = $1.supplier_id
        and twin.id <> $1.id
        and twin.deleted_at is null
        and twin.financial_role = 'payable'
        and lower(trim(twin.invoice_number)) = lower(trim($1.invoice_number))
    )
$$;

create or replace function public.p2_duplicate_invoice_group_count()
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(*)
  from (
    select i.supplier_id, lower(trim(i.invoice_number))
    from public.invoices i
    where i.org_id = auth_org()
      and i.deleted_at is null
      and i.financial_role = 'payable'
    group by i.supplier_id, lower(trim(i.invoice_number))
    having count(*) > 1
  ) duplicate_groups
$$;

create or replace function public.p2_invoice_without_order_count()
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(*)
  from public.invoices i
  where i.org_id = auth_org()
    and i.deleted_at is null
    and i.financial_role = 'payable'
    and not exists (
      select 1
      from public.invoice_order_links link
      where link.org_id = i.org_id and link.invoice_id = i.id
    )
$$;

revoke all on function public.invoice_has_duplicate(public.invoices) from public, anon;
revoke all on function public.p2_duplicate_invoice_group_count() from public, anon;
revoke all on function public.p2_invoice_without_order_count() from public, anon;
grant execute on function public.invoice_has_duplicate(public.invoices) to authenticated;
grant execute on function public.p2_duplicate_invoice_group_count() to authenticated;
grant execute on function public.p2_invoice_without_order_count() to authenticated;

-- The push lifecycle uses the same payable-only duplicate key. A supporting invoice emits no new
-- event; converting a payable invoice to evidence recomputes the payable group it left and closes
-- or preserves that group's standing event according to the remaining payable rows.
create or replace function private.notify_duplicate_invoice_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cfg private.push_config%rowtype;
  duplicate_count int;
  normalized_key text;
  old_duplicate_count int;
  old_normalized_key text;
begin
  select * into cfg from private.push_config where id;
  if not found then return new; end if;

  if new.financial_role = 'payable' then
    normalized_key := new.supplier_id::text || ':' || lower(trim(new.invoice_number));
    select count(*)::int into duplicate_count
    from public.invoices
    where org_id = new.org_id
      and supplier_id = new.supplier_id
      and lower(trim(invoice_number)) = lower(trim(new.invoice_number))
      and deleted_at is null
      and financial_role = 'payable';

    perform net.http_post(
      url := cfg.edge_url,
      body := jsonb_build_object(
        'event', 'duplicate_invoice_check',
        'org_id', new.org_id,
        'payload', jsonb_build_object(
          'entity_key', normalized_key,
          'active', new.deleted_at is null and duplicate_count > 1,
          'count', duplicate_count)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', cfg.secret)
    );
  end if;

  if tg_op = 'UPDATE' and old.financial_role = 'payable' and (
    old.org_id is distinct from new.org_id
    or old.supplier_id is distinct from new.supplier_id
    or lower(trim(old.invoice_number)) is distinct from lower(trim(new.invoice_number))
    or old.financial_role is distinct from new.financial_role
  ) then
    old_normalized_key := old.supplier_id::text || ':' || lower(trim(old.invoice_number));
    select count(*)::int into old_duplicate_count
    from public.invoices
    where org_id = old.org_id
      and supplier_id = old.supplier_id
      and lower(trim(invoice_number)) = lower(trim(old.invoice_number))
      and deleted_at is null
      and financial_role = 'payable';

    perform net.http_post(
      url := cfg.edge_url,
      body := jsonb_build_object(
        'event', 'duplicate_invoice_check',
        'org_id', old.org_id,
        'payload', jsonb_build_object(
          'entity_key', old_normalized_key,
          'active', old_duplicate_count > 1,
          'count', old_duplicate_count)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', cfg.secret)
    );
  end if;
  return new;
end $$;

drop trigger invoices_push_duplicate_update on public.invoices;
create trigger invoices_push_duplicate_update
  after update of supplier_id, invoice_number, deleted_at, financial_role on public.invoices
  for each row execute function private.notify_duplicate_invoice_check();

create or replace function public.p0_invoice_balance_rows()
returns table (
  invoice_id uuid,
  total_amount numeric(12,2),
  paid_amount numeric(12,2),
  credited_amount numeric(12,2),
  balance numeric(12,2)
)
language sql stable security definer set search_path = public as $$
  with paid as (
    select pa.org_id, pa.invoice_id, sum(pa.amount) as amount
    from public.payment_allocations pa
    where pa.org_id = auth_org() and pa.invoice_id is not null
    group by pa.org_id, pa.invoice_id
  ), credited as (
    select cr.org_id, cr.invoice_id, sum(cr.amount) as amount
    from public.credit_requests cr
    where cr.org_id = auth_org() and cr.invoice_id is not null
      and cr.status in ('offset','closed')
    group by cr.org_id, cr.invoice_id
  )
  select i.id,
         i.total_amount,
         coalesce(p.amount, 0)::numeric(12,2),
         coalesce(c.amount, 0)::numeric(12,2),
         (i.total_amount - coalesce(p.amount, 0) - coalesce(c.amount, 0))::numeric(12,2)
  from public.invoices i
  left join paid p on p.org_id = i.org_id and p.invoice_id = i.id
  left join credited c on c.org_id = i.org_id and c.invoice_id = i.id
  where i.org_id = auth_org() and i.deleted_at is null
    and i.financial_role = 'payable'
    and (i.unit_id is null or i.unit_id = any(public.auth_scopes()))
    and (
      auth_role() = 'owner'
      or (auth_role() = 'accountant' and i.review_status = 'approved')
    )
$$;

create or replace function public.p0_supplier_balance_rows()
returns table (supplier_id uuid, open_balance numeric(12,2), open_invoices bigint)
language sql stable security definer set search_path = public as $$
  with balances as (
    select * from public.p0_invoice_balance_rows()
  )
  select s.id,
         coalesce(sum(b.balance), 0)::numeric(12,2),
         count(b.invoice_id) filter (where b.balance > 0)
  from public.suppliers s
  left join public.invoices i
    on i.org_id = s.org_id and i.supplier_id = s.id and i.deleted_at is null
   and i.financial_role = 'payable'
   and (i.unit_id is null or i.unit_id = any(public.auth_scopes()))
  left join balances b on b.invoice_id = i.id
  where s.org_id = auth_org() and auth_role() in ('owner', 'accountant')
  group by s.id
$$;

-- Patch the current live definitions, with asserted anchors, instead of copying large report and
-- dashboard bodies from older migrations. A moved anchor fails this forward-only migration.
do $money_readers$
declare
  v_def text;
  v_anchor text;
  v_replacement text;
begin
  v_def := replace(pg_get_functiondef(
    'private.canonical_purchase_metrics(uuid,date,date)'::regprocedure),e'\r','');
  v_anchor := $a$      and i.review_status = 'approved'
      and i.invoice_date between p_from and p_to$a$;
  v_replacement := $b$      and i.review_status = 'approved'
      and i.financial_role = 'payable'
      and i.invoice_date between p_from and p_to$b$;
  if position(v_anchor in v_def)=0 then
    raise exception '0136: canonical_purchase_metrics money-reader anchor moved';
  end if;
  execute replace(v_def,v_anchor,v_replacement);

  v_def := replace(pg_get_functiondef(
    'private.product_purchase_summary(uuid,date,date,uuid)'::regprocedure),e'\r','');
  v_anchor := $a$      and i.deleted_at is null and i.review_status = 'approved'$a$;
  v_replacement := $b$      and i.deleted_at is null and i.review_status = 'approved'
      and i.financial_role = 'payable'$b$;
  if position(v_anchor in v_def)=0 then
    raise exception '0136: product_purchase_summary money-reader anchor moved';
  end if;
  execute replace(v_def,v_anchor,v_replacement);

  v_def := replace(pg_get_functiondef(
    'public.management_dashboard_snapshot(date)'::regprocedure),e'\r','');
  v_anchor := $a$    where i.deleted_at is null
  ),
  open_orders as ($a$;
  v_replacement := $b$    where i.deleted_at is null and i.financial_role = 'payable'
  ),
  open_orders as ($b$;
  if position(v_anchor in v_def)=0 then
    raise exception '0136: management_dashboard_snapshot money-reader anchor moved';
  end if;
  execute replace(v_def,v_anchor,v_replacement);

  v_def := replace(pg_get_functiondef(
    'public.create_monthly_report_snapshot(date,uuid)'::regprocedure),e'\r','');
  v_anchor := $a$      and i.deleted_at is null
  ),
  payment_request_scope as materialized ($a$;
  v_replacement := $b$      and i.deleted_at is null
      and i.financial_role = 'payable'
  ),
  payment_request_scope as materialized ($b$;
  if position(v_anchor in v_def)=0 then
    raise exception '0136: create_monthly_report_snapshot money-reader anchor moved';
  end if;
  execute replace(v_def,v_anchor,v_replacement);
end
$money_readers$;

-- Pin every changed SECURITY DEFINER body to the A5 enforcement ledger.
insert into private.scope_definer_enforcements(
  function_signature,body_hash,enforcement_kind,scope_proof
)
select reviewed.signature,md5(replace(proc.prosrc,e'\r','')),reviewed.kind,reviewed.proof
from (values
  ('p0_invoice_balance_rows()','filtered_read',
    '0136 filters balances to payable invoices and to null-or-auth_scopes legal-entity scope.'),
  ('p0_supplier_balance_rows()','filtered_read',
    '0136 derives supplier balances only from payable invoices in null-or-auth_scopes scope.'),
  ('create_monthly_report_snapshot(date,uuid)','assert_unit',
    '0136 preserves the legal-entity assertion and filters the final invoice ledger to payable.')
) reviewed(signature,kind,proof)
join pg_catalog.pg_proc proc on proc.oid=pg_catalog.to_regprocedure(reviewed.signature)
on conflict(function_signature) do update
set body_hash=excluded.body_hash,enforcement_kind=excluded.enforcement_kind,
    scope_proof=excluded.scope_proof;

-- ===== 10. Enterprise registries, export review and final structural assertions =====

insert into private.scope_registry(table_name,scope_class,enforced) values
  ('consolidated_invoice_cases','legal_entity',false),
  ('consolidated_invoice_intakes','derived',false),
  ('consolidated_invoice_intake_pages','derived',false),
  ('consolidated_invoice_sources','derived',false),
  ('consolidated_invoice_revisions','derived',false),
  ('consolidated_invoice_snapshots','derived',false);

-- The two service commands deliberately resolve scope from the DB-authoritative case rather than
-- from a worker payload. Trigger functions are row/case local and cannot widen the firing row.
insert into private.scope_definer_exemptions(function_signature,reason,target_wave)
values
  ('public.get_consolidated_invoice_processing_claim(uuid)'::regprocedure::text,
    'service-role-trusted-path','0137 consolidated invoice boundary'),
  ('public.apply_consolidated_invoice_interpretation(uuid,uuid,uuid)'::regprocedure::text,
    'service-role-trusted-path','0137 consolidated invoice boundary'),
  ('public.guard_invoice_financial_role()'::regprocedure::text,
    'trigger-new-old-rows','0137 consolidated invoice boundary'),
  ('public.guard_payable_invoice_reference()'::regprocedure::text,
    'trigger-new-old-rows','0137 consolidated invoice boundary'),
  ('private.capture_consolidated_invoice_late_arrival()'::regprocedure::text,
    'trigger-new-old-rows','0137 consolidated invoice boundary');

insert into private.scope_definer_enforcements(
  function_signature,body_hash,enforcement_kind,scope_proof
)
select reviewed.signature,md5(replace(proc.prosrc,e'\r','')),
  reviewed.kind,reviewed.proof
from (values
  ('list_consolidated_invoice_legal_entities()','filtered_read',
    '0136 filters legal-entity choices to auth_org and the caller materialized auth_scopes.'),
  ('open_consolidated_invoice_intake(uuid,uuid,date,uuid,integer)','assert_unit',
    '0136 verifies the tenant legal entity and asserts it is in scope before opening an intake.'),
  ('register_consolidated_invoice_page(uuid,integer,text,text,text,text)','assert_unit',
    '0136 locks the tenant intake and asserts its persisted legal entity before registering a document.'),
  ('complete_consolidated_invoice_intake(uuid,uuid)','assert_unit',
    '0136 locks the tenant intake and asserts its persisted legal entity before completing all pages.'),
  ('list_consolidated_invoice_cases(date)','filtered_read',
    '0136 filters every returned supplier-month case to auth_org and legal_entity_id in auth_scopes.'),
  ('get_consolidated_invoice_workspace(uuid)','filtered_read',
    '0136 resolves the case inside auth_org and auth_scopes, then reads only its exact anchor and sources.'),
  ('refresh_consolidated_invoice_reconciliation(uuid,uuid,text)','assert_unit',
    '0136 resolves the tenant case and asserts its persisted legal entity before appending a revision.')
) reviewed(signature,kind,proof)
join pg_catalog.pg_proc proc on proc.oid=pg_catalog.to_regprocedure(reviewed.signature)
on conflict(function_signature) do update
set body_hash=excluded.body_hash,enforcement_kind=excluded.enforcement_kind,
    scope_proof=excluded.scope_proof;

insert into private.tenant_export_registry(
  table_name,disposition,excluded_columns,rationale
) values
  ('consolidated_invoice_cases','include','{}','Supplier-month consolidated invoice case identity and current reconciliation state.'),
  ('consolidated_invoice_intakes','include','{}','Auditable consolidated invoice intake and atomic application result.'),
  ('consolidated_invoice_intake_pages','include',array['client_upload_key'],'Source-page ledger without the retry transport key.'),
  ('consolidated_invoice_sources','include','{}','Invoices and completed receipts used as consolidated invoice evidence.'),
  ('consolidated_invoice_revisions','include','{}','Immutable reconciliation revision history, including late arrivals.'),
  ('consolidated_invoice_snapshots','include','{}','Immutable reconciliation facts and their content hashes.')
on conflict(table_name) do update
set disposition=excluded.disposition,excluded_columns=excluded.excluded_columns,
    rationale=excluded.rationale;

-- `financial_role` changes the reviewed invoices projection; refresh it and all six new reviewed
-- projections in the same forward-only migration. Every later drift still fails A6.
update private.tenant_export_registry registry
set exported_columns=case when registry.disposition='exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema='public' and column_info.table_name=registry.table_name
        and not (column_info.column_name=any(registry.excluded_columns))
    ) end,
    schema_hash=(
      select md5(string_agg(
        column_info.column_name||':'||column_info.data_type||':'||column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema='public' and column_info.table_name=registry.table_name
    )
where registry.table_name in (
  'invoices','consolidated_invoice_cases','consolidated_invoice_intakes',
  'consolidated_invoice_intake_pages','consolidated_invoice_sources',
  'consolidated_invoice_revisions','consolidated_invoice_snapshots'
);

do $$
declare
  v_violations text;
begin
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0136 scope assertions failed:\n%',v_violations;
  end if;
  select string_agg(detail,e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0136 tenant export assertions failed:\n%',v_violations;
  end if;
end
$$;
