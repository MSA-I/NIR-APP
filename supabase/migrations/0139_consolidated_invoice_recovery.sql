-- 0139: first-client consolidated invoice recovery and lossless review boundary.
-- Recoverable OCR gaps remain auditable but no longer become terminal business blocks.

alter table public.consolidated_invoice_cases
  drop constraint consolidated_invoice_cases_status_check;
alter table public.consolidated_invoice_cases
  add constraint consolidated_invoice_cases_status_check
  check (status in ('awaiting_anchor','needs_review','reconciling','matched','warnings','blocked'));

alter table public.consolidated_invoice_intakes
  drop constraint consolidated_invoice_intakes_status_check;
alter table public.consolidated_invoice_intakes
  add constraint consolidated_invoice_intakes_status_check
  check (status in ('uploading','ready','needs_review','received','blocked'));

alter table public.consolidated_invoice_intakes
  drop constraint consolidated_invoice_intakes_completion_shape;
alter table public.consolidated_invoice_intakes
  add constraint consolidated_invoice_intakes_completion_shape check (
    (status='uploading' and completed_at is null)
    or (status in ('ready','needs_review','received','blocked') and completed_at is not null)
  );

alter table public.consolidated_invoice_sources
  drop constraint consolidated_invoice_sources_source_type_check;
alter table public.consolidated_invoice_sources
  add constraint consolidated_invoice_sources_source_type_check check (
    source_type in ('interim_invoice','goods_receipt','supporting_document')
  );
alter table public.consolidated_invoice_sources
  drop constraint consolidated_invoice_sources_shape;
alter table public.consolidated_invoice_sources
  add constraint consolidated_invoice_sources_shape check (
    (source_type='interim_invoice' and invoice_id is not null and receipt_id is null)
    or (source_type='goods_receipt' and invoice_id is null and receipt_id is not null)
    or (source_type='supporting_document' and invoice_id is null
      and receipt_id is null and document_id is not null)
  );

-- Reconcile local ledgers created from the pre-final 0137 body. The helper and
-- policies are idempotent on canonical ledgers and restore scoped accountant review.
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
        and intake.status in ('needs_review','received','blocked')
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

drop policy if exists consolidated_invoice_documents_select on public.documents;
create policy consolidated_invoice_documents_select on public.documents
  for select to authenticated using (
    private.can_read_consolidated_invoice_document(documents.org_id,documents.id)
  );

drop policy if exists consolidated_invoice_storage_read on storage.objects;
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
grant select, insert, update, delete on table public.consolidated_invoice_cases,
  public.consolidated_invoice_intakes,
  public.consolidated_invoice_intake_pages,
  public.consolidated_invoice_sources,
  public.consolidated_invoice_revisions,
  public.consolidated_invoice_snapshots
  to service_role;

create unique index if not exists consolidated_invoice_sources_document_key
  on public.consolidated_invoice_sources(org_id,document_id)
  where document_id is not null;

-- Older local ledgers used the pre-final 0135 latch while the canonical 0137
-- migration uses 0137. Both identify the same purpose-built consolidated command
-- family; accepting both keeps forward-only upgrades viable without rewriting history.
create or replace function public.consolidated_invoice_ledger_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_setting('app.consolidated_invoice_writer', true)
       not in ('0135','0137') then
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

create or replace function private.consolidated_interpretation_date(
  p_value jsonb,
  p_target_month date
) returns date
language plpgsql
immutable
set search_path = public, private, pg_temp
as $$
declare
  v_date date;
  v_text text;
  v_parts text[];
  v_year integer;
begin
  if p_target_month is null
     or p_target_month<>date_trunc('month',p_target_month)::date then
    return null;
  end if;
  v_date:=private.interpretation_date(p_value);
  if v_date is not null then return v_date; end if;
  if p_value is null or jsonb_typeof(p_value)<>'string' then return null; end if;
  v_text:=btrim(p_value #>> '{}');
  v_parts:=regexp_match(v_text,'^(\d{1,2})[./-](\d{1,2})[./-](\d{2})$');
  if v_parts is null then return null; end if;
  v_year:=extract(year from p_target_month)::integer;
  if v_parts[3]::integer<>(v_year % 100)
     or v_parts[2]::integer<>extract(month from p_target_month)::integer then
    return null;
  end if;
  begin
    return make_date(v_year,v_parts[2]::integer,v_parts[1]::integer);
  exception when others then
    return null;
  end;
end
$$;

revoke all on function private.consolidated_interpretation_date(jsonb,date)
  from public, anon, authenticated, service_role;

do $backfill$
begin
  perform set_config('app.consolidated_invoice_writer','0137',true);
  update public.consolidated_invoice_intakes
  set status='needs_review',outcome='needs_review',
      result=(result-'outcome')||jsonb_build_object('outcome','needs_review')
  where status='blocked'
    and reason_code in ('consolidated_supplier_unresolved','consolidated_core_fields_missing')
    and result is not null;

  update public.consolidated_invoice_cases c
  set status='needs_review',updated_at=statement_timestamp()
  where c.status='blocked' and c.anchor_invoice_id is null
    and exists (
      select 1 from public.consolidated_invoice_intakes intake
      where intake.org_id=c.org_id and intake.case_id=c.id
        and intake.status='needs_review'
    )
    and not exists (
      select 1 from public.consolidated_invoice_intakes hard_block
      where hard_block.org_id=c.org_id and hard_block.case_id=c.id
        and hard_block.status='blocked'
    );
end
$backfill$;


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
    or (v_intake.status = 'needs_review'
      and v_intake.result is not null
      and v_intake.outcome='needs_review'
      and v_intake.result->>'outcome'='needs_review')
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
    'replay',v_intake.result is not null and v_intake.status <> 'needs_review',
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

create or replace function private.consolidated_sync_sources(
  p_case_id uuid,p_late_arrival boolean default false
)
returns integer
language plpgsql
set search_path = public, private, pg_temp
as $$
declare
  v_case public.consolidated_invoice_cases;
  v_invoice public.invoices;
  v_receipt record;
  v_document_id uuid;
  v_document record;
  v_inserted integer:=0;
begin
  select * into v_case
  from public.consolidated_invoice_cases c
  where c.id=p_case_id
  for update;
  if not found then
    raise exception 'consolidated_case_unknown' using errcode='P0002';
  end if;

  for v_invoice in
    select i.*
    from public.invoices i
    where i.org_id=v_case.org_id
      and i.unit_id=v_case.legal_entity_id
      and i.supplier_id=v_case.supplier_id
      and i.invoice_date>=v_case.target_month
      and i.invoice_date<(v_case.target_month+interval '1 month')::date
      and i.deleted_at is null
      and i.id is distinct from v_case.anchor_invoice_id
    order by i.id
    for update
  loop
    if v_invoice.financial_role='payable' then
      perform private.assert_invoice_supporting_conversion(v_invoice.id);
      perform set_config(
        'app.consolidated_financial_role_writer',v_invoice.id::text,true);
      update public.invoices
      set financial_role='supporting_evidence'
      where id=v_invoice.id;
      perform set_config('app.consolidated_financial_role_writer','',true);
      insert into public.audit_logs(
        org_id,user_id,action,entity_type,entity_id,old_values,new_values,reason
      ) values (
        v_case.org_id,auth.uid(),'invoice_financial_role_changed','invoices',v_invoice.id,
        jsonb_build_object('financial_role','payable'),
        jsonb_build_object(
          'financial_role','supporting_evidence','case_id',v_case.id),
        'חשבונית ביניים הוגדרה כראיה תומכת תחת חשבונית מרכזת'
      );
    end if;

    select d.id into v_document_id
    from public.documents d
    where d.org_id=v_case.org_id and d.deleted_at is null
      and d.entity_type='invoice' and d.entity_id=v_invoice.id
    order by d.created_at,d.id limit 1;

    insert into public.consolidated_invoice_sources(
      org_id,case_id,source_type,invoice_id,document_id,source_date,late_arrival
    )
    select v_case.org_id,v_case.id,'interim_invoice',v_invoice.id,
      case when not exists (
        select 1 from public.consolidated_invoice_sources represented
        where represented.org_id=v_case.org_id
          and represented.document_id=v_document_id
      ) then v_document_id end,
      v_invoice.invoice_date,p_late_arrival
    where not exists (
      select 1 from public.consolidated_invoice_sources source
      where source.org_id=v_case.org_id and source.case_id=v_case.id
        and source.invoice_id=v_invoice.id
    );
    if found then v_inserted:=v_inserted+1; end if;
  end loop;

  for v_receipt in
    select gr.id,timezone('Asia/Jerusalem',gr.received_at)::date as source_date
    from public.goods_receipts gr
    join public.purchase_orders po
      on po.org_id=gr.org_id and po.id=gr.order_id
    where gr.org_id=v_case.org_id
      and po.supplier_id=v_case.supplier_id
      and timezone('Asia/Jerusalem',gr.received_at)::date>=v_case.target_month
      and timezone('Asia/Jerusalem',gr.received_at)::date
        <(v_case.target_month+interval '1 month')::date
      and private.consolidated_unit_descends_from(
        v_case.org_id,coalesce(gr.unit_id,po.unit_id),v_case.legal_entity_id)
    order by gr.id
  loop
    select d.id into v_document_id
    from public.documents d
    where d.org_id=v_case.org_id and d.deleted_at is null
      and d.entity_type='goods_receipt' and d.entity_id=v_receipt.id
    order by d.created_at,d.id limit 1;

    insert into public.consolidated_invoice_sources(
      org_id,case_id,source_type,receipt_id,document_id,source_date,late_arrival
    )
    select v_case.org_id,v_case.id,'goods_receipt',v_receipt.id,
      case when not exists (
        select 1 from public.consolidated_invoice_sources represented
        where represented.org_id=v_case.org_id
          and represented.document_id=v_document_id
      ) then v_document_id end,
      v_receipt.source_date,p_late_arrival
    where not exists (
      select 1 from public.consolidated_invoice_sources source
      where source.org_id=v_case.org_id and source.case_id=v_case.id
        and source.receipt_id=v_receipt.id
    );
    if found then v_inserted:=v_inserted+1; end if;
  end loop;

  for v_document in
    select d.id,d.document_date as source_date
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
  select * into v_case from public.consolidated_invoice_cases where id=p_case_id;
  if not found then
    raise exception 'consolidated_case_unknown' using errcode='P0002';
  end if;
  v_anchor_interim:=private.consolidated_comparison(
    p_case_id,'anchor','interim','anchor_vs_interim');
  v_anchor_receipts:=private.consolidated_comparison(
    p_case_id,'anchor','receipt','anchor_vs_receipts');
  v_interim_receipts:=private.consolidated_comparison(
    p_case_id,'interim','receipt','interim_vs_receipts');

  select coalesce(jsonb_agg(jsonb_build_object(
    'code','receipt_line_'||item.status::text,
    'severity','warning',
    'message_key','consolidated_invoice.receipt_line_'||item.status::text,
    'source_type','goods_receipt','source_id',source.receipt_id,
    'product_id',item.product_id
  ) order by source.receipt_id,item.id),'[]'::jsonb)
  into v_bad_receipts
  from public.consolidated_invoice_sources source
  join public.goods_receipt_items item
    on item.org_id=source.org_id and item.receipt_id=source.receipt_id
  where source.org_id=v_case.org_id and source.case_id=v_case.id
    and source.source_type='goods_receipt'
    and item.status in ('missing','damaged','returned');

  select coalesce(jsonb_agg(finding order by sort_key),'[]'::jsonb)
  into v_structural_warnings
  from (
    select 1 as sort_key,jsonb_build_object(
      'code','anchor_line_evidence_missing','severity','warning',
      'message_key','consolidated_invoice.anchor_line_evidence_missing',
      'source_type','consolidated_invoice','source_id',v_case.anchor_invoice_id,
      'product_id',null) as finding
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
            and resolved.invoice_id=document.entity_id))
        or (document.entity_type='goods_receipt' and exists (
          select 1 from public.consolidated_invoice_sources resolved
          where resolved.org_id=source.org_id and resolved.case_id=source.case_id
            and resolved.source_type='goods_receipt'
            and resolved.receipt_id=document.entity_id))
      )
  ) structural;

  select coalesce(jsonb_agg(jsonb_build_object(
    'code',row->>'result','severity','warning',
    'message_key',row->>'message_key','source_type',row->>'comparison',
    'source_id',null,'product_id',row->'product_id'
  )),'[]'::jsonb)||v_bad_receipts||v_structural_warnings
  into v_warnings
  from jsonb_array_elements(
    v_anchor_interim||v_anchor_receipts||v_interim_receipts) row
  where row->>'result'<>'matched';

  return jsonb_build_object(
    'reconciliation',jsonb_build_object(
      'anchor_vs_interim',v_anchor_interim,
      'anchor_vs_receipts',v_anchor_receipts,
      'interim_vs_receipts',v_interim_receipts),
    'warnings',v_warnings,
    'warning_count',jsonb_array_length(v_warnings)
  );
end
$$;

revoke all on function private.consolidated_reconciliation_payload(uuid)
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
  v_reviewable boolean := false;
  v_outcome text;
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

  if v_intake.result is not null and v_intake.status <> 'needs_review' then
    if v_intake.status in ('received','blocked')
       and v_intake.outcome=v_intake.status
       and v_intake.result->>'outcome'=v_intake.status then
      return v_intake.result || jsonb_build_object('idempotent',true);
    end if;
    raise exception 'consolidated_intake_state_invalid' using errcode = '55000';
  end if;
  if v_intake.status not in ('ready','needs_review') then
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
  v_date := private.consolidated_interpretation_date(
    private.interpretation_field(v_payload,array[
      'invoice_date','document_date','date','תאריך חשבונית','תאריך המסמך','תאריך']),
    v_case.target_month
  );
  v_before := private.interpretation_number(private.interpretation_field(v_payload,array[
    'subtotal','amount_before_vat','net_amount','סכום לפני מעמ','סה"כ לפני מע"מ']));
  v_vat := private.interpretation_number(private.interpretation_field(v_payload,array[
    'vat_amount','vat','tax_amount','מעמ','מע"מ']));
  v_total := private.interpretation_number(private.interpretation_field(v_payload,array[
    'total','total_amount','grand_total','amount_due','סכום כולל','סה"כ לתשלום']));
  if v_payload ->> 'document_type' <> 'invoice' or v_supplier_id is null then
    v_block_code := 'consolidated_supplier_unresolved';
    v_reviewable := true;
  elsif v_supplier_id <> v_case.supplier_id then
    v_block_code := 'consolidated_supplier_mismatch';
  elsif v_number is null or v_number_key is null or length(v_number) > 100
     or v_date is null or v_before is null or v_vat is null or v_total is null
     or v_before < 0 or v_vat < 0 or v_total < 0
     or round(v_before,2) + round(v_vat,2) <> round(v_total,2) then
    v_block_code := 'consolidated_core_fields_missing';
    v_reviewable := true;
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
      perform set_config('app.consolidated_invoice_writer','0137',true);
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
    v_outcome := case when v_reviewable then 'needs_review' else 'blocked' end;
    v_result := jsonb_build_object(
      'outcome',v_outcome,'reason_code',v_block_code,'case_id',v_case.id,
      'intake_id',v_intake.id,'invoice_id',null,'revision_id',null,
      'warnings','[]'::jsonb,'idempotent',false
    );
    perform set_config('app.consolidated_invoice_writer','0137',true);
    update public.consolidated_invoice_intakes
    set status=v_outcome,interpretation_id=v_interpretation.id,
        outcome=v_outcome,reason_code=v_block_code,result=v_result
    where id=v_intake.id;
    update public.consolidated_invoice_cases
    set status=v_outcome,updated_at=statement_timestamp() where id=v_case.id;
    insert into public.audit_logs(
      org_id,user_id,action,entity_type,entity_id,new_values,reason
    ) values (
      v_case.org_id,v_actor,
      case when v_reviewable then 'consolidated_invoice_review_required'
           else 'consolidated_invoice_blocked' end,
      'consolidated_invoice_intakes',v_intake.id,
      jsonb_build_object('case_id',v_case.id,'reason_code',v_block_code,
        'interpretation_id',v_interpretation.id,'outcome',v_outcome),
      case when v_reviewable
        then 'קליטת חשבונית מרכזת ממתינה לתיקון אנושי לפני יצירת חוב'
        else 'קליטת חשבונית מרכזת נחסמה לפני יצירת חוב' end
    );
    return v_result;
  end if;

  v_invoice_id := gen_random_uuid();
  perform set_config('app.p1_financial_writer',coalesce(v_actor::text,'0139'),true);
  perform set_config('app.consolidated_invoice_writer','0137',true);
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

  perform set_config('app.document_filing_writer',coalesce(v_actor::text,'0139'),true);
  update public.documents document
  set entity_type='invoice',entity_id=v_invoice_id,supplier_id=v_case.supplier_id,document_date=v_date
  from public.consolidated_invoice_intake_pages page
  where page.org_id=v_case.org_id and page.intake_id=v_intake.id
    and document.org_id=page.org_id and document.id=page.document_id
    and exists (
      select 1
      from public.document_processing_jobs page_job
      join public.document_interpretations page_interpretation
        on page_interpretation.org_id=page_job.org_id
        and page_interpretation.job_id=page_job.id
        and page_interpretation.document_id=page.document_id
      where page_job.org_id=page.org_id and page_job.document_id=page.document_id
        and page_job.status<>'failed'
        and page_job.id=(
          select latest_job.id
          from public.document_processing_jobs latest_job
          where latest_job.org_id=page.org_id
            and latest_job.document_id=page.document_id
            and latest_job.status<>'failed'
          order by latest_job.created_at desc,latest_job.id desc
          limit 1
        )
        and page_interpretation.payload->>'document_type'='invoice'
      order by page_job.created_at desc,page_job.id desc
      limit 1
    );

  insert into public.consolidated_invoice_sources(
    org_id,case_id,source_type,document_id,source_date
  )
  select page.org_id,v_case.id,'supporting_document',page.document_id,
    coalesce(
      private.consolidated_interpretation_date(
        private.interpretation_field(page_interpretation.payload,array[
          'invoice_date','document_date','date','תאריך חשבונית','תאריך המסמך','תאריך']),
        v_case.target_month
      ),
      v_date
    )
  from public.consolidated_invoice_intake_pages page
  join lateral (
    select page_job.*
    from public.document_processing_jobs page_job
    where page_job.org_id=page.org_id and page_job.document_id=page.document_id
      and page_job.status<>'failed'
    order by page_job.created_at desc,page_job.id desc
    limit 1
  ) current_job on true
  join public.document_interpretations page_interpretation
    on page_interpretation.org_id=current_job.org_id
    and page_interpretation.job_id=current_job.id
    and page_interpretation.document_id=page.document_id
  where page.org_id=v_intake.org_id and page.intake_id=v_intake.id
    and page_interpretation.payload->>'document_type'<>'invoice'
  on conflict (org_id,document_id) where document_id is not null do nothing;

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
      and interpretation.payload->>'document_type'='invoice'
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



create or replace function public.list_consolidated_invoice_cases(
  p_target_month date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_org uuid:=auth_org();
begin
  if auth.uid() is null or v_org is null
     or auth_role() not in ('owner','office','accountant') then
    raise exception 'consolidated_case_read_not_authorized' using errcode='42501';
  end if;
  if p_target_month is not null
     and p_target_month<>date_trunc('month',p_target_month)::date then
    raise exception 'consolidated_target_month_invalid' using errcode='22023';
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
            and intake.status in ('needs_review','received','blocked')
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
  v_intake_payload jsonb;
  v_pages_payload jsonb;
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
          and intake.status in ('received','needs_review','blocked')
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
    'intake_id',intake.id,'status',intake.status,'outcome',intake.outcome,
    'reason_code',intake.reason_code,'interpretation_id',intake.interpretation_id,
    'completed_at',intake.completed_at,'received_at',intake.received_at
  ) into v_intake_payload
  from public.consolidated_invoice_intakes intake
  where intake.org_id=v_case.org_id and intake.case_id=v_case.id
  order by intake.created_at desc,intake.id desc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'page_number',page.page_number,'document_id',page.document_id,
    'file_name',document.file_name,'is_primary',page.document_id=intake.primary_document_id,
    'job_id',current_job.id,'job_status',current_job.status,
    'interpretation_id',interpretation.id,
    'document_type',interpretation.payload->>'document_type'
  ) order by page.page_number),'[]'::jsonb) into v_pages_payload
  from public.consolidated_invoice_intakes intake
  join public.consolidated_invoice_intake_pages page
    on page.org_id=intake.org_id and page.intake_id=intake.id
  join public.documents document
    on document.org_id=page.org_id and document.id=page.document_id
  left join lateral (
    select job.*
    from public.document_processing_jobs job
    where job.org_id=page.org_id and job.document_id=page.document_id
      and job.status<>'failed'
    order by job.created_at desc,job.id desc
    limit 1
  ) current_job on true
  left join lateral (
    select candidate.*
    from public.document_interpretations candidate
    where candidate.org_id=current_job.org_id
      and candidate.job_id=current_job.id
      and candidate.document_id=page.document_id
    order by candidate.created_at desc,candidate.id desc
    limit 1
  ) interpretation on true
  where intake.org_id=v_case.org_id and intake.case_id=v_case.id
    and intake.id=(select latest.id
      from public.consolidated_invoice_intakes latest
      where latest.org_id=v_case.org_id and latest.case_id=v_case.id
      order by latest.created_at desc,latest.id desc limit 1);

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
    'intake',v_intake_payload,
    'pages',coalesce(v_pages_payload,'[]'::jsonb),
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

do $payable_global_search$
declare v_def text;
begin
  v_def:=replace(pg_get_functiondef(
    'public.global_search(text,integer)'::regprocedure),e'\r','');
  if position('financial_role = ''payable''' in v_def)=0 then
    if position('and i.deleted_at is null' in v_def)=0 then
      raise exception '0139: global_search invoice reader could not be fenced';
    end if;
    execute replace(
      v_def,
      'and i.deleted_at is null',
      'and i.deleted_at is null'||e'\n       and i.financial_role = ''payable'''
    );
  end if;
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
      select 1 from public.invoices twin
      where twin.org_id=$1.org_id
        and twin.supplier_id=$1.supplier_id
        and twin.id<>$1.id
        and twin.deleted_at is null
        and twin.financial_role = 'payable'
        and lower(trim(twin.invoice_number))=lower(trim($1.invoice_number))
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
    select i.supplier_id,lower(trim(i.invoice_number))
    from public.invoices i
    where i.org_id=auth_org()
      and i.deleted_at is null
      and i.financial_role = 'payable'
    group by i.supplier_id,lower(trim(i.invoice_number))
    having count(*)>1
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
  where i.org_id=auth_org()
    and i.deleted_at is null
    and i.financial_role = 'payable'
    and not exists (
      select 1 from public.invoice_order_links link
      where link.org_id=i.org_id and link.invoice_id=i.id
    )
$$;

revoke all on function public.invoice_has_duplicate(public.invoices) from public, anon;
revoke all on function public.p2_duplicate_invoice_group_count() from public, anon;
revoke all on function public.p2_invoice_without_order_count() from public, anon;
grant execute on function public.invoice_has_duplicate(public.invoices) to authenticated;
grant execute on function public.p2_duplicate_invoice_group_count() to authenticated;
grant execute on function public.p2_invoice_without_order_count() to authenticated;

create or replace function private.notify_duplicate_invoice_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
    normalized_key:=new.supplier_id::text||':'||lower(trim(new.invoice_number));
    select count(*)::int into duplicate_count
    from public.invoices
    where org_id=new.org_id
      and supplier_id=new.supplier_id
      and lower(trim(invoice_number))=lower(trim(new.invoice_number))
      and deleted_at is null
      and financial_role = 'payable';
    perform net.http_post(
      url:=cfg.edge_url,
      body:=jsonb_build_object(
        'event','duplicate_invoice_check','org_id',new.org_id,
        'payload',jsonb_build_object(
          'entity_key',normalized_key,
          'active',new.deleted_at is null and duplicate_count>1,
          'count',duplicate_count)),
      headers:=jsonb_build_object(
        'Content-Type','application/json','x-push-secret',cfg.secret)
    );
  end if;

  if tg_op='UPDATE' and old.financial_role = 'payable' and (
    old.org_id is distinct from new.org_id
    or old.supplier_id is distinct from new.supplier_id
    or lower(trim(old.invoice_number)) is distinct from lower(trim(new.invoice_number))
    or old.financial_role is distinct from new.financial_role
  ) then
    old_normalized_key:=old.supplier_id::text||':'||lower(trim(old.invoice_number));
    select count(*)::int into old_duplicate_count
    from public.invoices
    where org_id=old.org_id
      and supplier_id=old.supplier_id
      and lower(trim(invoice_number))=lower(trim(old.invoice_number))
      and deleted_at is null
      and financial_role = 'payable';
    perform net.http_post(
      url:=cfg.edge_url,
      body:=jsonb_build_object(
        'event','duplicate_invoice_check','org_id',old.org_id,
        'payload',jsonb_build_object(
          'entity_key',old_normalized_key,
          'active',old_duplicate_count>1,
          'count',old_duplicate_count)),
      headers:=jsonb_build_object(
        'Content-Type','application/json','x-push-secret',cfg.secret)
    );
  end if;
  return new;
end
$$;

drop trigger if exists invoices_push_duplicate_update on public.invoices;
create trigger invoices_push_duplicate_update
  after update of supplier_id,invoice_number,deleted_at,financial_role
  on public.invoices
  for each row execute function private.notify_duplicate_invoice_check();

drop trigger if exists consolidated_invoice_late_invoice on public.invoices;
create trigger consolidated_invoice_late_invoice
  after insert on public.invoices
  for each row execute function private.capture_consolidated_invoice_late_arrival();
drop trigger if exists consolidated_invoice_late_evidence
  on public.invoice_line_evidence_batches;
create trigger consolidated_invoice_late_evidence
  after insert on public.invoice_line_evidence_batches
  for each row execute function private.capture_consolidated_invoice_late_arrival();
drop trigger if exists consolidated_invoice_late_receipt on public.goods_receipts;
create trigger consolidated_invoice_late_receipt
  after insert or update of status on public.goods_receipts
  for each row execute function private.capture_consolidated_invoice_late_arrival();
drop trigger if exists consolidated_invoice_late_document on public.documents;
create trigger consolidated_invoice_late_document
  after insert or update of supplier_id,document_date,document_kind,deleted_at,entity_type,entity_id
  on public.documents
  for each row execute function private.capture_consolidated_invoice_late_arrival();

insert into private.scope_definer_enforcements(
  function_signature,body_hash,enforcement_kind,scope_proof
)
select 'list_consolidated_invoice_cases(date)',
  md5(replace(proc.prosrc,e'\r','')),'filtered_read',
  '0139 filters every visible supplier-month case to auth_org and auth_scopes; accountants see finalized or reviewable intakes only.'
from pg_catalog.pg_proc proc
where proc.oid='public.list_consolidated_invoice_cases(date)'::regprocedure
on conflict(function_signature) do update
set body_hash=excluded.body_hash,enforcement_kind=excluded.enforcement_kind,
    scope_proof=excluded.scope_proof;

insert into private.scope_definer_enforcements(
  function_signature,body_hash,enforcement_kind,scope_proof
)
select 'get_consolidated_invoice_workspace(uuid)',
  md5(replace(proc.prosrc,e'\r','')),'filtered_read',
  '0139 filters the case, recoverable intake and exact page diagnostics to auth_org and auth_scopes.'
from pg_catalog.pg_proc proc
where proc.oid='public.get_consolidated_invoice_workspace(uuid)'::regprocedure
on conflict(function_signature) do update
set body_hash=excluded.body_hash,enforcement_kind=excluded.enforcement_kind,
    scope_proof=excluded.scope_proof;

do $assert$
declare v_violations text;
begin
  if private.consolidated_interpretation_date('"31.07.26"'::jsonb,date '2026-07-01')
       is distinct from date '2026-07-31'
     or private.consolidated_interpretation_date('"31.07.25"'::jsonb,date '2026-07-01')
       is not null
     or private.consolidated_interpretation_date('"30.06.26"'::jsonb,date '2026-07-01')
       is not null then
    raise exception '0139 target-month date assertions failed';
  end if;
  select string_agg(assertion || ' -- ' || detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0139 scope assertions failed:\n%',v_violations;
  end if;
  select string_agg(detail,e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0139 tenant export assertions failed:\n%',v_violations;
  end if;
end
$assert$;
