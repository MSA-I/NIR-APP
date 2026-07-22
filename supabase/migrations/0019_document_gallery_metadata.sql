-- 0019 — Queryable document-gallery metadata.
-- Historical rows stay honest: linked supplier/date are backfilled where unambiguous, while
-- the file's kind stays explicitly "other" because its parent entity does not prove its kind.

alter table documents
  add column document_kind text not null default 'other',
  add column supplier_id uuid references suppliers(id) on delete restrict,
  add column document_date date,
  add constraint documents_kind_check check (
    document_kind in (
      'invoice',
      'delivery_note',
      'credit',
      'quote',
      'payment_confirmation',
      'other'
    )
  );

update documents d
set supplier_id = i.supplier_id,
    document_date = i.invoice_date
from invoices i
where d.entity_type = 'invoice'
  and d.entity_id = i.id
  and d.org_id = i.org_id;

update documents d
set supplier_id = po.supplier_id,
    document_date = gr.received_at::date
from goods_receipts gr
join purchase_orders po on po.id = gr.order_id and po.org_id = gr.org_id
where d.entity_type = 'goods_receipt'
  and d.entity_id = gr.id
  and d.org_id = gr.org_id;

create index documents_kind_date_idx
  on documents (org_id, document_kind, document_date desc)
  where deleted_at is null;

create index documents_supplier_date_idx
  on documents (org_id, supplier_id, document_date desc)
  where deleted_at is null and supplier_id is not null;

-- The row UPDATE policy remains deliberately narrow (owner/office). This trigger is the
-- column boundary: metadata may change, inbox filing may change the entity link, and file/
-- tenant identity remains immutable. It also closes the old cross-tenant supplier/link gap.
create or replace function documents_guard_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  refiling boolean;
  validate_entity boolean := true;
  validate_supplier boolean := true;
begin
  if tg_op = 'UPDATE' then
    refiling := old.entity_type = 'inbox'
                and new.entity_type in ('invoice', 'goods_receipt')
                and new.entity_id is not null;
    validate_entity := new.entity_type is distinct from old.entity_type
                       or new.entity_id is distinct from old.entity_id;
    validate_supplier := new.supplier_id is distinct from old.supplier_id;

    if new.org_id is distinct from old.org_id
       or new.storage_path is distinct from old.storage_path
       or new.file_name is distinct from old.file_name
       or new.mime_type is distinct from old.mime_type
       or new.uploaded_by is distinct from old.uploaded_by
       or new.created_at is distinct from old.created_at
       or (not refiling and validate_entity) then
      raise exception 'documents: only metadata, soft-delete fields, or inbox filing may be changed'
        using errcode = '42501';
    end if;

    if refiling
       and auth.uid() is not null
       and current_setting('app.document_filing_writer', true) is distinct from auth.uid()::text then
      raise exception 'document_filing_rpc_required' using errcode = '42501';
    end if;
  end if;

  if validate_supplier and new.supplier_id is not null and not exists (
    select 1 from suppliers s where s.id = new.supplier_id and s.org_id = new.org_id
  ) then
    raise exception 'documents: supplier must belong to the document organization'
      using errcode = '23514';
  end if;

  if validate_entity and new.entity_type = 'invoice' and not exists (
    select 1 from invoices i where i.id = new.entity_id and i.org_id = new.org_id
  ) then
    raise exception 'documents: invoice must belong to the document organization'
      using errcode = '23514';
  end if;

  if validate_entity and new.entity_type = 'goods_receipt' and not exists (
    select 1 from goods_receipts gr where gr.id = new.entity_id and gr.org_id = new.org_id
  ) then
    raise exception 'documents: goods receipt must belong to the document organization'
      using errcode = '23514';
  end if;

  -- Payment attachments are also written directly by FileUpload. Validate on both INSERT and
  -- every UPDATE, not only when the link changes, so an invalid legacy/crafted link cannot be
  -- carried through a metadata or soft-delete write.
  if new.entity_type = 'payment' and not exists (
    select 1 from payments p where p.id = new.entity_id and p.org_id = new.org_id
  ) then
    raise exception 'documents: payment must belong to the document organization'
      using errcode = '23514';
  end if;

  return new;
end
$$;

drop trigger if exists documents_guard_columns_trg on documents;
create trigger documents_guard_columns_trg
  before insert or update on documents
  for each row execute function documents_guard_columns();

-- Filing is one business action: derive target metadata, change the link and write its reasoned
-- audit row in the same transaction. Direct inbox re-filing is rejected by the guard above.
create or replace function file_document(
  p_document_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_document documents;
  v_supplier_id uuid;
  v_document_date date;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_entity_type is null
     or p_entity_type not in ('invoice', 'goods_receipt')
     or p_entity_id is null then
    raise exception 'document_target_invalid' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_document
  from documents
  where id = p_document_id and org_id = v_org and deleted_at is null
  for update;

  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;
  if v_document.entity_type <> 'inbox' or v_document.entity_id is not null then
    raise exception 'document_already_filed' using errcode = 'P0001';
  end if;

  if p_entity_type = 'invoice' then
    select i.supplier_id, i.invoice_date
      into v_supplier_id, v_document_date
    from invoices i
    where i.id = p_entity_id and i.org_id = v_org and i.deleted_at is null;
  else
    select po.supplier_id, gr.received_at::date
      into v_supplier_id, v_document_date
    from goods_receipts gr
    join purchase_orders po on po.id = gr.order_id and po.org_id = gr.org_id
    where gr.id = p_entity_id and gr.org_id = v_org;
  end if;

  if not found then
    raise exception 'document_target_unknown' using errcode = 'P0002';
  end if;

  perform set_config('app.document_filing_writer', v_user::text, true);

  update documents
  set entity_type = p_entity_type,
      entity_id = p_entity_id,
      supplier_id = v_supplier_id,
      document_date = v_document_date
  where id = v_document.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    'document_refiled',
    'documents',
    v_document.id,
    jsonb_build_object(
      'entity_type', v_document.entity_type,
      'entity_id', v_document.entity_id,
      'supplier_id', v_document.supplier_id,
      'document_date', v_document.document_date
    ),
    jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', p_entity_id,
      'supplier_id', v_supplier_id,
      'document_date', v_document_date
    ),
    v_reason
  );

  return jsonb_build_object(
    'document_id', v_document.id,
    'entity_type', p_entity_type,
    'entity_id', p_entity_id,
    'supplier_id', v_supplier_id,
    'document_date', v_document_date
  );
end
$$;

revoke all on function public.file_document(uuid, text, uuid, text) from public;
grant execute on function public.file_document(uuid, text, uuid, text) to authenticated;
