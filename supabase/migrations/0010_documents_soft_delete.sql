-- 0010 — Soft delete for documents.
--
-- Why: an attached document is the scan of the original invoice or delivery note. The
-- constitution mandates soft delete for financial records, and until now `documents` was the
-- one place in the app where a single click hard-deleted both the row and the stored file,
-- with no way back.
--
-- The important half is the storage object: the application must STOP removing the file when
-- a document is deleted. A soft delete that still destroys the bytes keeps a row and loses
-- the document, which is the opposite of the point.

alter table documents
  add column deleted_at timestamptz,
  add column deleted_by uuid references profiles(id);

-- Deleted rows stay readable so the audit trail can explain what was removed and by whom;
-- the application filters them out with `.is('deleted_at', null)`, the same convention
-- invoices already use (0001_init.sql:211).
create index documents_live_idx on documents (entity_type, entity_id) where deleted_at is null;

-- Hard delete is withdrawn. Leaving the old policy in place would keep the destructive path
-- open to anyone calling the API directly, which is exactly what this migration closes.
drop policy documents_delete on documents;

create policy documents_soft_delete on documents for update
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (org_id = auth_org() and auth_role() in ('owner','office'));

-- USING/WITH CHECK constrain which ROW may be updated, never which COLUMN — the same gap
-- that made `profiles_self_update` a privilege-escalation hole before 0006. Without this
-- trigger the new update policy would let office staff repoint `storage_path` or move a row
-- between organizations.
create or replace function documents_guard_columns()
returns trigger language plpgsql as $$
begin
  if new.org_id is distinct from old.org_id
     or new.entity_type is distinct from old.entity_type
     or new.entity_id is distinct from old.entity_id
     or new.storage_path is distinct from old.storage_path
     or new.file_name is distinct from old.file_name
     or new.mime_type is distinct from old.mime_type
     or new.uploaded_by is distinct from old.uploaded_by
     or new.created_at is distinct from old.created_at then
    raise exception 'documents: only deleted_at and deleted_by may be changed';
  end if;
  return new;
end $$;

create trigger documents_guard_columns_trg
  before update on documents
  for each row execute function documents_guard_columns();
