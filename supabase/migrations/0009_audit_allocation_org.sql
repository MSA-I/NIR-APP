-- Allocation rows had no tenant, so their audit trail had no tenant either.
--
-- ===== The defect =====
-- `audit_row_change()` (0001_init.sql:422) writes an audit row for every financial table.
-- It takes org_id from the row that fired it, falling back to auth_org():
--
--     coalesce((to_jsonb(new)->>'org_id')::uuid, auth_org())
--
-- `payment_allocations` and `bank_allocations` are the only two audited tables with no
-- org_id column, so that first term is always NULL for them. The fallback covers an
-- ordinary in-app write, but any write without a user JWT -- seeds, migrations, service_role
-- jobs, an Edge Function acting on a tenant's behalf -- leaves auth_org() NULL too, and the
-- audit row is written with no tenant at all.
--
-- Such a row is: invisible to `audit_select` (`org_id = auth_org()`), so it never appears on
-- /audit; unattributable, so no one can say which customer it belongs to; and not removed
-- when that customer is deleted. In a system where the audit trail is a compliance feature
-- and financial records are soft-deleted for seven years, that is a defect, not untidiness.
-- Measured on a demo load: 32 orphan rows per load/reset cycle.
--
-- Confirmed by catalog query that these two tables are the complete set -- every other table
-- carrying the audit trigger already has org_id. The self-check at the bottom keeps it that way.
--
-- ===== Why a column rather than a smarter trigger =====
-- The alternative was to leave the tables alone and have audit_row_change() follow the
-- foreign key to the parent when the row has no org_id of its own. It was tested, and it is
-- wrong for the case that matters most:
--
--   ON DELETE CASCADE is executed as an after-trigger on the parent. By the time the child's
--   audit trigger runs, the parent row is already gone from the snapshot, so the lookup
--   returns NULL. Deleting an allocation directly resolves fine; deleting the payment it
--   hangs off -- the real-world path -- still produces a NULL-tenant audit row. Verified:
--   direct delete resolved the org, cascade delete resolved <<NULL>>.
--
-- Making the tenant a column on the row removes the lookup entirely: org_id is present in
-- `old` for DELETE regardless of what happened to the parent, which is exactly the property
-- an audit trail needs. It also makes these two tables consistent with the other 19 that
-- carry org_id -- they were the anomaly -- and lets a tenant be deleted with a single
-- predicate instead of a subquery per junction.
--
-- The cost of denormalizing is that the column could disagree with its parent, which would
-- produce precisely the split-tenant row that isolation audits hunt for. The BEFORE trigger
-- below removes that risk: org_id is always derived from the parent, and a caller supplying a
-- conflicting value gets an error rather than a corrupt row.
--
-- No application change is required: the trigger fills the column, so existing inserts in
-- src/ keep working untouched. RLS policies are deliberately left alone -- they already scope
-- these tables through their parent, and rewriting working policies is not this migration's job.

-- ===== 1. The column =====
alter table payment_allocations add column org_id uuid references organizations(id);
alter table bank_allocations    add column org_id uuid references organizations(id);

-- ===== 2. Backfill from the parent =====
-- Both parents are NOT NULL foreign keys, so every existing row is attributable.
update payment_allocations pa
set org_id = p.org_id
from payments p
where p.id = pa.payment_id and pa.org_id is null;

update bank_allocations ba
set org_id = bt.org_id
from bank_transactions bt
where bt.id = ba.bank_transaction_id and ba.org_id is null;

do $$
declare v_orphans int;
begin
  select (select count(*) from payment_allocations where org_id is null)
       + (select count(*) from bank_allocations    where org_id is null)
    into v_orphans;
  if v_orphans > 0 then
    raise exception '% allocation row(s) have no reachable parent; refusing to set NOT NULL', v_orphans;
  end if;
end $$;

alter table payment_allocations alter column org_id set not null;
alter table bank_allocations    alter column org_id set not null;

-- ===== 3. Keep it derived, and keep it honest =====
create or replace function allocation_derive_org() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_parent_org uuid;
begin
  -- security definer: the parent must be readable here even when the caller's own RLS would
  -- hide it (a payer inserting an allocation is the live example), otherwise a legitimate
  -- write would fail with a misleading "parent not found".
  if TG_TABLE_NAME = 'payment_allocations' then
    select p.org_id into v_parent_org from payments p where p.id = new.payment_id;
  elsif TG_TABLE_NAME = 'bank_allocations' then
    select bt.org_id into v_parent_org from bank_transactions bt where bt.id = new.bank_transaction_id;
  else
    raise exception 'allocation_derive_org() is attached to an unexpected table: %', TG_TABLE_NAME;
  end if;

  if v_parent_org is null then
    raise exception '%: parent row not found, cannot determine the organization', TG_TABLE_NAME;
  end if;

  if new.org_id is not null and new.org_id <> v_parent_org then
    raise exception '%: org_id % does not match the parent organization % — refusing to write a row that spans two tenants',
      TG_TABLE_NAME, new.org_id, v_parent_org;
  end if;

  new.org_id := v_parent_org;
  return new;
end $$;

create trigger payment_allocations_org before insert or update on payment_allocations
  for each row execute function allocation_derive_org();
create trigger bank_allocations_org before insert or update on bank_allocations
  for each row execute function allocation_derive_org();

-- ===== 4. Indexes =====
-- 0005 holds the invariant that every org_id column has an index leading on org_id; these
-- two keep it true, and they are what a tenant-wide delete will use.
create index if not exists payment_allocations_org_idx on payment_allocations (org_id);
create index if not exists bank_allocations_org_idx    on bank_allocations (org_id);

-- ===== 5. Repair the audit rows already written without a tenant =====
-- Four passes, most reliable source first. An audit row carries the full old/new row as
-- JSONB, so a deleted allocation can still be attributed through the parent id it recorded.

-- (a) the allocation still exists — take the org_id just backfilled onto it
update audit_logs a set org_id = pa.org_id
from payment_allocations pa
where a.org_id is null and a.entity_type = 'payment_allocations' and a.entity_id = pa.id;

update audit_logs a set org_id = ba.org_id
from bank_allocations ba
where a.org_id is null and a.entity_type = 'bank_allocations' and a.entity_id = ba.id;

-- (b) allocation is gone — recover the tenant from the parent recorded in the payload
update audit_logs a set org_id = p.org_id
from payments p
where a.org_id is null and a.entity_type = 'payment_allocations'
  and p.id = nullif(coalesce(a.new_values, a.old_values) ->> 'payment_id', '')::uuid;

update audit_logs a set org_id = bt.org_id
from bank_transactions bt
where a.org_id is null and a.entity_type = 'bank_allocations'
  and bt.id = nullif(coalesce(a.new_values, a.old_values) ->> 'bank_transaction_id', '')::uuid;

-- (c) parent gone too — fall back to the invoice side. Invoices are soft-deleted, so this
--     recovers the cascade case where both the allocation and its payment were removed.
update audit_logs a set org_id = i.org_id
from invoices i
where a.org_id is null and a.entity_type in ('payment_allocations', 'bank_allocations')
  and i.id = nullif(coalesce(a.new_values, a.old_values) ->> 'invoice_id', '')::uuid;

-- (d) whatever is left is genuinely unattributable: the allocation, its parent and its
--     invoice are all gone, so nothing in the row identifies a tenant. These are NOT deleted
--     — removing audit history to make a count look clean is the opposite of the point. They
--     stay as they are: still invisible under RLS, still orphaned, but now a bounded and
--     reported historical set rather than a leak that keeps growing.
do $$
declare v_left int;
begin
  select count(*) into v_left
  from audit_logs
  where org_id is null and entity_type in ('payment_allocations', 'bank_allocations');

  if v_left = 0 then
    raise notice 'audit_logs: every allocation row was attributed to a tenant.';
  else
    raise notice 'audit_logs: % allocation row(s) remain unattributable (allocation, parent and invoice all deleted). Left in place deliberately.', v_left;
  end if;
end $$;

-- ===== 6. Stop this from recurring silently =====
-- The next junction table added to the audit trigger list without an org_id column would
-- reintroduce exactly this defect, and it would be just as invisible as it was this time.
-- Same idiom as the 0005 index self-check: a structural assertion that fails the migration
-- run rather than a runtime error that would fail-close a financial write in production.
do $$
declare missing text;
begin
  select string_agg(distinct c.relname, ', ')
    into missing
  from pg_trigger tg
  join pg_class c     on c.oid = tg.tgrelid
  join pg_proc p      on p.oid = tg.tgfoid
  join pg_namespace n on n.oid = c.relnamespace
  where p.proname = 'audit_row_change'
    and n.nspname = 'public'
    and not tg.tgisinternal
    and not exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attname = 'org_id'
        and a.attnum > 0 and not a.attisdropped);

  if missing is not null then
    raise exception 'audit_row_change() is attached to table(s) with no org_id column: %. Their audit rows would be written with org_id = NULL — invisible under RLS, unattributable to a tenant, and not removed with it. Give the table an org_id (see this migration) before attaching the audit trigger.', missing;
  end if;
end $$;
