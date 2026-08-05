-- Scope backfill (wave 3, PLAN-03 §2.3).
--
-- Everything the 0054 seeding triggers do for NEW rows, done once for rows that predate
-- them: the live database, and the two-tenant 0019 fixture that check-p0-upgrade.ps1
-- replays 0020->HEAD over. On a fresh `db reset` every table here is empty ([db.seed] runs
-- after migrations), so this whole file is a no-op there -- the triggers own that path.
--
-- Idempotent by construction: every step first checks what already exists, so replaying it
-- after the triggers have run (or running it twice) changes nothing. It must also work for
-- an organization with ZERO profiles -- the upgrade fixture has exactly that.

-- ===== 1. Default unit chain for every existing organization =====
-- Mirrors p0_seed_org_units (0054) including the documented hierarchy and Hebrew names,
-- but repairs partial states too: each level is created only if the org has no unit of
-- that type, and hangs off the default unit of the level above.
do $$
declare
  r record;
  v_root uuid;
  v_le uuid;
  v_branch uuid;
begin
  for r in select o.id, o.name from organizations o loop
    select u.id into v_root
    from org_units u where u.org_id = r.id and u.unit_type = 'root'
    order by u.created_at, u.id limit 1;
    if v_root is null then
      insert into org_units (org_id, parent_id, unit_type, name)
      values (r.id, null, 'root', r.name)
      returning id into v_root;
    end if;

    select u.id into v_le
    from org_units u where u.org_id = r.id and u.unit_type = 'legal_entity'
    order by u.created_at, u.id limit 1;
    if v_le is null then
      insert into org_units (org_id, parent_id, unit_type, name)
      values (r.id, v_root, 'legal_entity', 'ישות משפטית ראשית')
      returning id into v_le;
    end if;

    select u.id into v_branch
    from org_units u where u.org_id = r.id and u.unit_type = 'branch'
    order by u.created_at, u.id limit 1;
    if v_branch is null then
      insert into org_units (org_id, parent_id, unit_type, name)
      values (r.id, v_le, 'branch', 'סניף ראשי')
      returning id into v_branch;
    end if;

    if not exists (select 1 from org_units u where u.org_id = r.id and u.unit_type = 'warehouse') then
      insert into org_units (org_id, parent_id, unit_type, name)
      values (r.id, v_branch, 'warehouse', 'מחסן ראשי');
    end if;
  end loop;
end
$$;

-- ===== 2. Root grant for every existing user =====
-- Anchoring everyone to the root is what makes 0057's rider behaviourally invisible: the
-- closure of the root is the whole tree, so every predicate evaluates exactly as today.
insert into user_scope_grants (org_id, user_id, unit_id)
select p.org_id, p.id, u.id
from profiles p
join org_units u on u.org_id = p.org_id and u.unit_type = 'root'
on conflict (org_id, user_id, unit_id) do nothing;

-- ===== 3. Closure fill =====
-- The grant inserts above already resynced through p0_scope_grants_sync_closure; this
-- explicit pass also covers grants whose insert was skipped by ON CONFLICT (their closure
-- may predate a tree repair in step 1) and keeps the step meaningful on replays.
do $$
declare r record;
begin
  for r in select distinct g.org_id, g.user_id from user_scope_grants g loop
    perform p0_recompute_scope_closure(r.org_id, r.user_id);
  end loop;
end
$$;

-- ===== 4. Unit backfill per dimension =====
-- The p1 guards and identity guards on these tables all early-out when auth.uid() IS NULL
-- (0033:19, the documented backfill contract), so migration-context UPDATEs pass. Audit
-- triggers fire and record the backfill -- that is correct, not noise.
update invoices        set unit_id = p0_default_unit(org_id, 'legal_entity') where unit_id is null;
update payments        set unit_id = p0_default_unit(org_id, 'legal_entity') where unit_id is null;
update purchase_orders set unit_id = p0_default_unit(org_id, 'branch')       where unit_id is null;
update goods_receipts  set unit_id = p0_default_unit(org_id, 'warehouse')    where unit_id is null;

-- inventory_movements is an immutable ledger: its BEFORE UPDATE trigger rejects every
-- mutation unconditionally (0026:67-77), including this one. Assigning the warehouse
-- pointer is schema evolution, not a ledger edit -- no financial content changes -- so the
-- guard is suspended for exactly this statement, inside this transaction, and re-enabled
-- immediately. In every gate environment the table is empty at this point (it only fills
-- post-seed); this exists for the live database.
alter table inventory_movements disable trigger inventory_movements_immutable;
update inventory_movements set unit_id = p0_default_unit(org_id, 'warehouse') where unit_id is null;
alter table inventory_movements enable trigger inventory_movements_immutable;

-- documents deliberately stay NULL: cross-scope, org-visible until filed (PLAN-03 §2.3).

-- ===== 5. Structural self-check (same idiom as 0005/0009) =====
-- Fail the migration run loudly rather than leave a silent gap for 0057 to deny on.
do $$
declare
  v_count bigint;
  v_table text;
begin
  select count(*) into v_count
  from organizations o
  where (select count(*) from org_units u where u.org_id = o.id and u.unit_type = 'root') <> 1;
  if v_count <> 0 then
    raise exception '0056: % organization(s) do not have exactly one root unit', v_count;
  end if;

  select count(*) into v_count
  from organizations o
  where not exists (select 1 from org_units u where u.org_id = o.id and u.unit_type = 'legal_entity')
     or not exists (select 1 from org_units u where u.org_id = o.id and u.unit_type = 'branch')
     or not exists (select 1 from org_units u where u.org_id = o.id and u.unit_type = 'warehouse');
  if v_count <> 0 then
    raise exception '0056: % organization(s) are missing a default legal_entity/branch/warehouse unit', v_count;
  end if;

  select count(*) into v_count
  from profiles p
  where not exists (
    select 1 from user_scope_grants g where g.org_id = p.org_id and g.user_id = p.id);
  if v_count <> 0 then
    raise exception '0056: % profile(s) are left without any scope grant', v_count;
  end if;

  select count(*) into v_count
  from profiles p
  where not exists (
    select 1 from user_scope_closure c where c.org_id = p.org_id and c.user_id = p.id);
  if v_count <> 0 then
    raise exception '0056: % profile(s) are left without a closure row', v_count;
  end if;

  foreach v_table in array array[
    'invoices', 'payments', 'purchase_orders', 'goods_receipts', 'inventory_movements'
  ] loop
    execute format('select count(*) from %I where unit_id is null', v_table) into v_count;
    if v_count <> 0 then
      raise exception '0056: % row(s) of % were left without a unit', v_count, v_table;
    end if;
  end loop;
end
$$;
