-- P48 -- the canonical product name has exactly one door, and that door always costs a reason.
--
-- The column added by 0149 is what twenty-five screens will eventually render. Renaming a
-- catalogue entry is therefore a sensitive act, and this suite pins the four things that make it
-- one: only owner/office may do it, a reason is not optional, the empty string cannot be stored,
-- and every call leaves an audit row. It also pins the fact the whole design rests on -- that a
-- browser session has no direct write path to the column at all, so the command is not merely the
-- preferred route but the only one.
--
-- Sections 8 and 9 pin the other half, added with 0150: the read models that SHOW a product name
-- render the approved one when it exists and the raw one until then. Section 8 is the one that
-- matters most, because it is the state of the entire live catalogue -- nothing was backfilled, so
-- the switch is a strict no-op until a person acts.
\set ON_ERROR_STOP on

begin;

insert into public.organizations (id, name, status)
values ('48000000-0000-4000-8000-000000000001', 'P48 tenant', 'active');
insert into public.organizations (id, name, status)
values ('48000000-0000-4000-8000-000000000002', 'P48 other tenant', 'active');

insert into auth.users (id, email)
values
  ('58000000-0000-4000-8000-000000000001', 'owner-p48@example.test'),
  ('58000000-0000-4000-8000-000000000002', 'accountant-p48@example.test');
insert into public.profiles (id, org_id, full_name, role)
values
  (
    '58000000-0000-4000-8000-000000000001',
    '48000000-0000-4000-8000-000000000001', 'P48 owner', 'owner'
  ),
  (
    '58000000-0000-4000-8000-000000000002',
    '48000000-0000-4000-8000-000000000001', 'P48 accountant', 'accountant'
  );

insert into public.products (id, org_id, name, unit)
values (
  '68000000-0000-4000-8000-000000000001',
  '48000000-0000-4000-8000-000000000001', 'שמן קנולה 100 מ״ל חברת דגן', 'יח׳'
);
-- A product in another tenant, to prove the command cannot reach across organizations.
insert into public.products (id, org_id, name, unit)
values (
  '68000000-0000-4000-8000-000000000002',
  '48000000-0000-4000-8000-000000000002', 'P48 foreign product', 'יח׳'
);

-- The minimum that makes the read models switched by 0150 return this product at all: one counted
-- movement, so both inventory projections have a row, and one purchase-order line, so the product
-- reaches the purchase summary's rollup. None of it is about naming; sections 8 and 9 are.
insert into public.suppliers (id, org_id, name, status)
values (
  '78000000-0000-4000-8000-000000000001',
  '48000000-0000-4000-8000-000000000001', 'P48 ספק', 'active'
);
insert into public.inventory_movements (
  id, org_id, product_id, movement_type, quantity_delta, counted_quantity,
  negative_override, reason, created_by
) values (
  '88000000-0000-4000-8000-000000000001', '48000000-0000-4000-8000-000000000001',
  '68000000-0000-4000-8000-000000000001', 'stocktake', 6, 6,
  false, 'P48 initial count', '58000000-0000-4000-8000-000000000001'
);
insert into public.purchase_orders (id, org_id, supplier_id, status, created_at)
values (
  '98000000-0000-4000-8000-000000000001', '48000000-0000-4000-8000-000000000001',
  '78000000-0000-4000-8000-000000000001', 'sent', timestamptz '2026-08-03 09:00+03'
);
insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price)
values (
  'a8000000-0000-4000-8000-000000000001', '48000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000001', '68000000-0000-4000-8000-000000000001', 4, 12
);

-- ===== 1. The column itself refuses a blank canonical name =====
-- Asserted against a direct write by the table owner, not through the command: the constraint has
-- to hold for every writer, including a future migration or an Edge Function, not only for callers
-- who happen to go through the guarded door.
do $$
begin
  update public.products set display_name = '   '
  where id = '68000000-0000-4000-8000-000000000001';
  raise exception 'expected the blank display_name check to reject';
exception when sqlstate '23514' then
  null;
end
$$;

do $$
begin
  update public.products set display_name = repeat('א', 121)
  where id = '68000000-0000-4000-8000-000000000001';
  raise exception 'expected the 120-character display_name ceiling to reject';
exception when sqlstate '23514' then
  null;
end
$$;

-- ===== 2. A browser session has no direct write path to the column =====
-- 0036 put products behind column-level privileges. If a later edit ever adds display_name to that
-- grant, the reason requirement below becomes advice rather than a rule -- so it is pinned here as
-- a fact about privileges, not only as a fact about the function.
do $$
begin
  if has_column_privilege('authenticated', 'public.products', 'display_name', 'UPDATE')
     or has_column_privilege('authenticated', 'public.products', 'display_name', 'INSERT') then
    raise exception 'display_name is directly writable by authenticated';
  end if;
  if not has_column_privilege('authenticated', 'public.products', 'display_name', 'SELECT') then
    raise exception 'display_name must remain readable for the screens that will render it';
  end if;
end
$$;

-- ===== 3. Owner: a reason is mandatory, and a present-but-blank name is not a clear =====
select set_config('request.jwt.claim.sub', '58000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

do $$
begin
  perform public.set_product_display_name(
    '68000000-0000-4000-8000-000000000001', 'שמן קנולה — 100 מ״ל', null
  );
  raise exception 'expected a missing reason to be refused';
exception when sqlstate '22023' then
  if sqlerrm <> 'reason_required' then raise; end if;
end
$$;

do $$
begin
  perform public.set_product_display_name(
    '68000000-0000-4000-8000-000000000001', 'שמן קנולה — 100 מ״ל', '   '
  );
  raise exception 'expected a whitespace-only reason to be refused';
exception when sqlstate '22023' then
  if sqlerrm <> 'reason_required' then raise; end if;
end
$$;

do $$
begin
  perform public.set_product_display_name(
    '68000000-0000-4000-8000-000000000001', '   ', 'P48 blank name'
  );
  raise exception 'expected a blank canonical name to be refused rather than treated as a clear';
exception when sqlstate '22023' then
  if sqlerrm <> 'product_display_name_blank' then raise; end if;
end
$$;

do $$
begin
  perform public.set_product_display_name(
    '68000000-0000-4000-8000-000000000001', repeat('א', 121), 'P48 too long'
  );
  raise exception 'expected an over-length canonical name to be refused';
exception when sqlstate '22023' then
  if sqlerrm <> 'product_display_name_too_long' then raise; end if;
end
$$;

-- ===== 4. Another tenant's product is not found, not merely not updated =====
do $$
begin
  perform public.set_product_display_name(
    '68000000-0000-4000-8000-000000000002', 'P48 cross-tenant rename', 'P48 cross tenant'
  );
  raise exception 'expected a foreign product to be unreachable';
exception when sqlstate 'P0002' then
  if sqlerrm <> 'product_not_found' then raise; end if;
end
$$;

-- ===== 5. The owner's approved name lands, and is audited with the reason =====
do $$
declare
  v_result jsonb;
begin
  v_result := public.set_product_display_name(
    '68000000-0000-4000-8000-000000000001', 'שמן קנולה — 100 מ״ל', 'P48 owner approved the proposal'
  );
  if (v_result->>'idempotent')::boolean then
    raise exception 'the first approval must not report itself idempotent';
  end if;

  -- A repeat of the same value is a no-op that still answers, rather than a second audit row.
  v_result := public.set_product_display_name(
    '68000000-0000-4000-8000-000000000001', 'שמן קנולה — 100 מ״ל', 'P48 repeat'
  );
  if not (v_result->>'idempotent')::boolean then
    raise exception 'a repeated approval of the same name must be idempotent';
  end if;
end
$$;

-- ===== 6. Accountant may read the catalogue but may not rename it =====
-- Identity is swapped from outside the role, the p16 idiom: setting a request claim while already
-- inside `authenticated` works today but depends on GUC permissions rather than on the contract
-- under test, and a suite should not rest on that.
reset role;
select set_config('request.jwt.claim.sub', '58000000-0000-4000-8000-000000000002', true);
set local role authenticated;
do $$
begin
  perform public.set_product_display_name(
    '68000000-0000-4000-8000-000000000001', 'P48 accountant rename', 'P48 accountant attempt'
  );
  raise exception 'expected a non-owner/office caller to be refused';
exception when sqlstate '42501' then
  if sqlerrm <> 'product_display_name_not_authorized' then raise; end if;
end
$$;

reset role;

do $$
begin
  if not exists (
    select 1 from public.products
    where id = '68000000-0000-4000-8000-000000000001'
      and display_name = 'שמן קנולה — 100 מ״ל'
      -- The raw name is untouched: it is what matching and the supplier-facing surfaces read.
      and name = 'שמן קנולה 100 מ״ל חברת דגן'
  ) then
    raise exception 'the approved canonical name did not land, or the raw name was altered';
  end if;

  if (
    select count(*) from public.audit_logs
    where entity_type = 'products'
      and entity_id = '68000000-0000-4000-8000-000000000001'
      and action = 'product_display_name_set'
      and reason = 'P48 owner approved the proposal'
      and new_values->>'display_name' = 'שמן קנולה — 100 מ״ל'
      and old_values->>'display_name' is null
      and new_values->>'name' = 'שמן קנולה 100 מ״ל חברת דגן'
  ) <> 1 then
    raise exception 'the rename was not audited exactly once with its reason and the raw name';
  end if;
end
$$;

-- ===== 7. Clearing returns the product to its raw name, and is audited too =====
select set_config('request.jwt.claim.sub', '58000000-0000-4000-8000-000000000001', true);
set local role authenticated;
do $$
declare
  v_result jsonb;
begin
  v_result := public.set_product_display_name(
    '68000000-0000-4000-8000-000000000001', null, 'P48 the proposal was wrong'
  );
  if v_result->>'display_name' is not null then
    raise exception 'clearing must report no canonical name';
  end if;
end
$$;
reset role;

do $$
begin
  if exists (
    select 1 from public.products
    where id = '68000000-0000-4000-8000-000000000001' and display_name is not null
  ) then
    raise exception 'the canonical name was not cleared';
  end if;

  if (
    select count(*) from public.audit_logs
    where entity_type = 'products'
      and entity_id = '68000000-0000-4000-8000-000000000001'
      and action = 'product_display_name_cleared'
      and reason = 'P48 the proposal was wrong'
      and old_values->>'display_name' = 'שמן קנולה — 100 מ״ל'
      and new_values->>'display_name' is null
  ) <> 1 then
    raise exception 'the clear was not audited with the name it removed';
  end if;
end
$$;

-- ===== 8. The read models switched by 0150 fall back to the raw name =====
-- Section 7 left display_name NULL, which is the state of the ENTIRE live catalogue: 0149
-- backfilled nothing and never will. So this section is the assertion that 0150 changed nothing
-- anybody can see, and it is the case that matters most -- a switch that is a no-op until a person
-- acts is a switch that can ship before anybody has acted.
select set_config('request.jwt.claim.sub', '58000000-0000-4000-8000-000000000001', true);
set local role authenticated;
do $$
begin
  if (
    select product_name from public.inventory_balances
    where product_id = '68000000-0000-4000-8000-000000000001'
  ) is distinct from 'שמן קנולה 100 מ״ל חברת דגן' then
    raise exception 'inventory_balances must render the raw name while none has been approved';
  end if;

  if (
    select product_name from public.inventory_movement_feed
    where product_id = '68000000-0000-4000-8000-000000000001'
  ) is distinct from 'שמן קנולה 100 מ״ל חברת דגן' then
    raise exception 'inventory_movement_feed must render the raw name while none has been approved';
  end if;
end
$$;
reset role;

-- Called directly, the way p34 calls it: `private` is revoked from every browser role, and the
-- public door adds only the role gate and the window validation this suite is not about.
do $$
begin
  if (
    select p ->> 'product_name'
    from jsonb_array_elements(
      private.product_purchase_summary(
        '48000000-0000-4000-8000-000000000001', '2026-08-01', '2026-08-31', null) -> 'products') p
    where p ->> 'product_id' = '68000000-0000-4000-8000-000000000001'
  ) is distinct from 'שמן קנולה 100 מ״ל חברת דגן' then
    raise exception 'product_purchase_summary must render the raw name while none has been approved';
  end if;
end
$$;

-- ===== 9. Once a person approves a name, every switched projection shows it =====
select set_config('request.jwt.claim.sub', '58000000-0000-4000-8000-000000000001', true);
set local role authenticated;
select public.set_product_display_name(
  '68000000-0000-4000-8000-000000000001', 'שמן קנולה — 100 מ״ל', 'P48 approved for the read models');
do $$
begin
  if (
    select product_name from public.inventory_balances
    where product_id = '68000000-0000-4000-8000-000000000001'
  ) is distinct from 'שמן קנולה — 100 מ״ל' then
    raise exception 'inventory_balances did not follow the approved canonical name';
  end if;

  if (
    select product_name from public.inventory_movement_feed
    where product_id = '68000000-0000-4000-8000-000000000001'
  ) is distinct from 'שמן קנולה — 100 מ״ל' then
    raise exception 'inventory_movement_feed did not follow the approved canonical name';
  end if;
end
$$;
reset role;

do $$
begin
  if (
    select p ->> 'product_name'
    from jsonb_array_elements(
      private.product_purchase_summary(
        '48000000-0000-4000-8000-000000000001', '2026-08-01', '2026-08-31', null) -> 'products') p
    where p ->> 'product_id' = '68000000-0000-4000-8000-000000000001'
  ) is distinct from 'שמן קנולה — 100 מ״ל' then
    raise exception 'product_purchase_summary did not follow the approved canonical name';
  end if;

  -- The raw name is what matching reads and what the supplier-facing order message sends. A
  -- display switch that quietly rewrote it would break both, and neither would fail loudly.
  if not exists (
    select 1 from public.products
    where id = '68000000-0000-4000-8000-000000000001'
      and name = 'שמן קנולה 100 מ״ל חברת דגן'
  ) then
    raise exception 'switching the display sites must not touch the raw name';
  end if;
end
$$;

rollback;
