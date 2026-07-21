-- 0014 — Documents inbox: capture now, file later.
--
-- Why: the paper arrives before the record does. A delivery note or invoice is photographed
-- the moment it lands on the counter, but the invoice/goods-receipt row it belongs to may
-- not exist yet — and until now `documents` demanded an entity up front (entity_id not
-- null), so the photo had to wait, and papers that wait get lost. This adds an inbox state:
-- a document may be captured with no entity (entity_type = 'inbox', entity_id null) and
-- re-filed onto the real invoice or goods receipt once it exists.
--
-- The storage object NEVER moves on re-filing. The bucket policies (0005) read only the
-- leading {org_id} path segment, so a file uploaded under {org_id}/inbox/... stays readable
-- and tenant-isolated no matter what the row later points at — only the row's
-- entity_type/entity_id change.

-- An entity becomes optional — but ONLY for inbox rows. Every other entity_type still
-- requires a target, so the 0001 invariant holds everywhere it used to.
alter table documents alter column entity_id drop not null;

alter table documents add constraint documents_inbox_entity
  check (entity_id is not null or entity_type = 'inbox');

-- 0010's column guard froze entity_type/entity_id outright, because soft delete was the only
-- legitimate update. Re-filing is now the second one: an inbox row may move onto a real
-- invoice or goods receipt. Everything identity-bearing stays frozen either way — org_id,
-- storage_path, file_name, mime_type, uploaded_by, created_at — so the update policy still
-- cannot repoint a stored file or move a row between organizations.
create or replace function documents_guard_columns()
returns trigger language plpgsql as $$
declare
  refiling boolean := old.entity_type = 'inbox'
                      and new.entity_type in ('invoice', 'goods_receipt')
                      and new.entity_id is not null;
begin
  if new.org_id is distinct from old.org_id
     or new.storage_path is distinct from old.storage_path
     or new.file_name is distinct from old.file_name
     or new.mime_type is distinct from old.mime_type
     or new.uploaded_by is distinct from old.uploaded_by
     or new.created_at is distinct from old.created_at
     or (not refiling
         and (new.entity_type is distinct from old.entity_type
              or new.entity_id is distinct from old.entity_id)) then
    raise exception 'documents: only deleted_at/deleted_by (or re-filing an inbox document) may be changed';
  end if;
  return new;
end $$;

-- 0010's trigger would keep firing the replaced function as-is; recreated defensively with
-- the exact same wiring so this migration stands on its own.
drop trigger if exists documents_guard_columns_trg on documents;
create trigger documents_guard_columns_trg
  before update on documents
  for each row execute function documents_guard_columns();

-- Who may re-file: the UPDATE policy remains 0010's documents_soft_delete (owner/office),
-- deliberately untouched — re-filing is the same clerical responsibility as removal.
-- kitchen/payer can still CAPTURE into the inbox (documents_insert, 0001); they just cannot
-- move or remove what was captured.
--
-- Reading/counting the inbox rides documents_live_idx (0010) — a partial index on
-- (entity_type, entity_id) where deleted_at is null, whose leading column is entity_type.
