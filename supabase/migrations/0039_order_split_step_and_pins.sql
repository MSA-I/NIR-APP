-- 0039 — A third editor step, and pins that survive a reload.
-- Forward-only after 0035. Two independent facts:
--   (a) editor_step gains a third value: the final summary is a step, not a modal.
--   (b) purchase_request_items records WHY a supplier was chosen — user pin vs auto-split.
-- chosen_supplier_id keeps its exact meaning ("what will actually be ordered"), so
-- finalize_purchase_request_draft (0023:2606) is untouched.

-- ===== 1. editor_step in (1, 2, 3) =====

alter table purchase_requests
  drop constraint purchase_requests_editor_step_check;
alter table purchase_requests
  add constraint purchase_requests_editor_step_check check (editor_step in (1, 2, 3));

-- ===== 2. pinned_supplier_id — a user fact, nullable on purpose =====

alter table purchase_request_items
  add column pinned_supplier_id uuid references suppliers(id);

-- Mirrors p0_pri_chosen_supplier_tenant_fk (0021:206): a pin may never cross a tenant.
alter table purchase_request_items
  add constraint p0_pri_pinned_supplier_tenant_fk
  foreign key (org_id, pinned_supplier_id) references suppliers(org_id, id) not valid;
alter table purchase_request_items
  validate constraint p0_pri_pinned_supplier_tenant_fk;

comment on column purchase_request_items.pinned_supplier_id is
  'Supplier the user pinned by hand. NULL = the line is auto-split to the cheapest usable offer. '
  'A pin that is currently unusable (qty below min_qty, offer withdrawn, supplier soft-deleted) is '
  'still stored, so a reload returns the user to the same "fix me" state instead of a silent '
  'fallback. chosen_supplier_id stays "what will actually be ordered".';
